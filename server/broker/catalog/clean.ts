// Cleaning of upstream tool definitions before they are pinned and shown to agents. The pin hash covers the cleaned definition: exactly what agents see.

import { stripInvisible, truncateText } from "../../mail/content.ts";
import type { ToolAnnotations, ToolDef } from "../types.ts";

/** Caps on what agents see. */
export const CLEAN_LIMITS = {
  /** A tool's description ("about 1 KB per tool"). */
  description: 1024,
  /** A tool's title and annotations.title. */
  title: 256,
  /** Each `description`/`title` inside inputSchema/outputSchema ("256 characters per parameter"). */
  param: 256,
  /** Server instructions. */
  instructions: 4096,
  /** Input clipped before any regex runs (a hostile server can send megabytes). */
  rawInput: 64 * 1024,
  /** inputSchema + outputSchema of one tool, cleaned, as JSON (UTF-8 bytes); a bigger tool is refused. */
  schemaBytes: 32 * 1024,
  /** Nesting depth of a schema; a deeper tool is refused. */
  schemaDepth: 32,
} as const;

// CSI (ESC [ … final), OSC (ESC ] … BEL | ST), DCS/SOS/PM/APC strings (ESC P|X|^|_ … ST), 8-bit CSI, and any other
// two-byte ESC sequence.
const ANSI = new RegExp(
  [
    "\\u001B\\[[0-?]*[ -/]*[@-~]",
    "\\u009B[0-?]*[ -/]*[@-~]",
    "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)?",
    "\\u001B[PX^_][^\\u001B]*(?:\\u001B\\\\)?",
    "\\u001B[@-Z\\\\-_]",
  ].join("|"),
  "g",
);
// Remaining C0/C1 controls (keeps \t and \n) and the bidi marks stripInvisible keeps for mail (LRM, RLM, ALM).
// Schema keys and values keep \t and \n too (they may be meaningful in a default or an enum).
// oxlint-disable-next-line no-control-regex -- matching control characters is the point here
const CONTROLS_IN_VALUES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u061C]/g;
// oxlint-disable-next-line no-control-regex -- matching control characters is the point here
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u061C]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Strips ANSI escapes, controls, zero-width, bidi and tag characters. `removed` counts what could hide text. */
export function cleanText(input: string, max: number): { text: string; removed: number; truncated: boolean } {
  const raw = input.length > CLEAN_LIMITS.rawInput ? input.slice(0, CLEAN_LIMITS.rawInput) : input;
  let removed = 0;
  const noAnsi = raw.replace(/\r\n?/g, "\n").replace(ANSI, () => {
    removed++;
    return "";
  });
  const inv = stripInvisible(noAnsi);
  removed += inv.removed;
  const noCtl = inv.text.replace(CONTROLS, () => {
    removed++;
    return "";
  });
  const t = truncateText(noCtl.trim(), max);
  return { text: t.text, removed, truncated: t.truncated || input.length > CLEAN_LIMITS.rawInput };
}

export interface CleanStats {
  /** Hidden characters (ANSI, zero-width, bidi, tags, controls) removed. */
  removed: number;
  /** Fields cut to their cap. */
  truncated: number;
}

/** A tool the catalog can't serve: refused (not stored), with the reason shown on the connection page. */
export class ToolRefused extends Error {
  constructor(readonly reason: "too_deep" | "too_large" | "not_json" | "duplicate_key") {
    super(`Tool definition refused: ${reason}`);
    this.name = "ToolRefused";
  }
}

/** Strips ANSI, invisible and control characters from a schema key or value, without trimming or capping it. */
function cleanSchemaString(s: string, stats: CleanStats): string {
  if (s.length > CLEAN_LIMITS.schemaBytes) throw new ToolRefused("too_large");
  let removed = 0;
  const noAnsi = s.replace(ANSI, () => {
    removed++;
    return "";
  });
  const inv = stripInvisible(noAnsi);
  removed += inv.removed;
  const out = inv.text.replace(CONTROLS_IN_VALUES, () => {
    removed++;
    return "";
  });
  stats.removed += removed;
  return out;
}

/** Defines an own property, even for "__proto__" (consistent with JSON.parse). */
function put(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Walks a JSON schema and cleans every string, keys and values (`default`, `enum`, `examples`, `$comment`, `x-*`,
 * property names). `description` / `title` values are also capped. Never passes a subtree through raw: past the
 * depth limit, or on a non-JSON value, the whole tool is refused.
 */
function cleanSchema(node: unknown, stats: CleanStats, depth = 0): unknown {
  if (depth > CLEAN_LIMITS.schemaDepth) throw new ToolRefused("too_deep");
  if (node === null || typeof node === "boolean") return node;
  if (typeof node === "number") {
    if (!Number.isFinite(node)) throw new ToolRefused("not_json");
    return node;
  }
  if (typeof node === "string") return cleanSchemaString(node, stats);
  if (Array.isArray(node)) return node.map((v) => cleanSchema(v === undefined ? null : v, stats, depth + 1));
  if (typeof node !== "object") throw new ToolRefused("not_json");
  const out = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(node)) {
    const v = (node as Record<string, unknown>)[k];
    if (v === undefined) continue;
    const key = cleanSchemaString(k, stats);
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new ToolRefused("duplicate_key");
    if ((k === "description" || k === "title") && typeof v === "string") {
      const c = cleanText(v, CLEAN_LIMITS.param);
      stats.removed += c.removed;
      if (c.truncated) stats.truncated++;
      put(out, key, c.text);
    } else {
      put(out, key, cleanSchema(v, stats, depth + 1));
    }
  }
  return out;
}

const BOOL_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** The known annotation fields only, typed; unknown keys and non-boolean hints are dropped. */
function cleanAnnotations(a: unknown, stats: CleanStats): ToolAnnotations | undefined {
  if (!a || typeof a !== "object" || Array.isArray(a)) return undefined;
  const src = a as Record<string, unknown>;
  const out: ToolAnnotations = {};
  if (typeof src.title === "string") {
    const c = cleanText(src.title, CLEAN_LIMITS.title);
    stats.removed += c.removed;
    if (c.truncated) stats.truncated++;
    if (c.text) out.title = c.text;
  }
  for (const k of BOOL_HINTS) if (typeof src[k] === "boolean") out[k] = src[k] as boolean;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The cleaned definition (the one pinned and served) and what cleaning removed. `name` is kept verbatim.
 * Throws ToolRefused when the definition can't be served safely (too deep, too large, not JSON).
 */
export function cleanToolDef(def: ToolDef): { def: ToolDef; stats: CleanStats } {
  const stats: CleanStats = { removed: 0, truncated: 0 };
  const desc = cleanText(typeof def.description === "string" ? def.description : "", CLEAN_LIMITS.description);
  stats.removed += desc.removed;
  if (desc.truncated) stats.truncated++;
  const out: ToolDef = {
    name: def.name,
    description: desc.text,
    inputSchema: isObject(def.inputSchema) ? (cleanSchema(def.inputSchema, stats) as Record<string, unknown>) : { type: "object" },
  };
  if (typeof def.title === "string") {
    const t = cleanText(def.title, CLEAN_LIMITS.title);
    stats.removed += t.removed;
    if (t.truncated) stats.truncated++;
    if (t.text) out.title = t.text;
  }
  if (isObject(def.outputSchema)) out.outputSchema = cleanSchema(def.outputSchema, stats) as Record<string, unknown>;
  const ann = cleanAnnotations(def.annotations, stats);
  if (ann) out.annotations = ann;
  const size = Buffer.byteLength(JSON.stringify([out.inputSchema, out.outputSchema ?? null]), "utf8");
  if (size > CLEAN_LIMITS.schemaBytes) throw new ToolRefused("too_large");
  return { def: out, stats };
}

/** Cleaned server instructions (hashed separately from the tools). */
export function cleanInstructions(s: string | undefined): string | null {
  if (typeof s !== "string") return null;
  const c = cleanText(s, CLEAN_LIMITS.instructions);
  return c.text || null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
