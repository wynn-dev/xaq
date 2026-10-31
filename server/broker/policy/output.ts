// Upstream output is untrusted (docs/MCP-BROKER.md "Upstream output is untrusted"): every text block is cleaned
// (ANSI, invisible characters), scrubbed of this connection's secrets, truncated and nonce-wrapped, with every
// xaq delimiter escaped inside. structuredContent is validated against the pinned outputSchema.

import { handedTokens } from "../../extensions/handed-tokens.ts";
import { escapeDelimiters, stripInvisible, truncateText } from "../../mail/content.ts";
import { randomToken } from "../../util/ids.ts";
import type { CredentialStore } from "../credentials/store.ts";
import type { ContentBlock, ToolResult } from "../types.ts";

// ───────────── ANSI and control characters ─────────────

// CSI / OSC / other escape sequences (the ansi-regex pattern), then stray C0/C1 controls except \t \n \r.
const ANSI =
  // oxlint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
// oxlint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function stripAnsi(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text
    .replace(ANSI, () => {
      removed++;
      return "";
    })
    .replace(CONTROLS, () => {
      removed++;
      return "";
    });
  return { text: out, removed };
}

// ───────────── Secret scrubbing ─────────────

/** Secrets shorter than this aren't scrubbed by exact match (too likely to hit ordinary text). */
const MIN_SECRET_CHARS = 8;
const BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/gi;
export const REDACTED = "[redacted]";

export interface Scrubber {
  scrub(text: string): { text: string; redacted: number };
}

/** Exact matches of the given secrets (longest first), plus `Bearer <long>` patterns, become [redacted]. */
export function makeScrubber(secrets: (string | null | undefined)[]): Scrubber {
  const exact = [...new Set(secrets.filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_CHARS))].sort((a, b) => b.length - a.length);
  return {
    scrub(text: string) {
      let redacted = 0;
      let out = text;
      for (const s of exact) {
        if (!out.includes(s)) continue;
        const parts = out.split(s);
        redacted += parts.length - 1;
        out = parts.join(REDACTED);
      }
      out = out.replace(BEARER, () => {
        redacted++;
        return REDACTED;
      });
      return { text: out, redacted };
    },
  };
}

/** This connection's decrypted secrets: access and refresh tokens, and the static header's value (and its token part). */
export function connectionSecrets(credentials: Pick<CredentialStore, "tokens" | "header" | "client">, connectionId: string): string[] {
  // Tokens handed to a code extension that no store holds (a Google extension's downscoped ones).
  const out: string[] = handedTokens(connectionId);
  try {
    // The OAuth client registration / user app (client_secret, a WHOOP app's secret…): every secret-named string.
    const c = credentials.client(connectionId);
    for (const [k, v] of Object.entries(c ?? {})) if (/secret/i.test(k) && typeof v === "string") out.push(v);
  } catch {
    // As below.
  }
  try {
    const t = credentials.tokens(connectionId);
    if (t) out.push(t.accessToken, ...(t.refreshToken ? [t.refreshToken] : []));
  } catch {
    // An unreadable credential can't be in the output either.
  }
  try {
    const h = credentials.header(connectionId);
    if (h?.value) {
      out.push(h.value);
      // "Bearer abc…", "Token abc…": the bare token too.
      const sp = h.value.indexOf(" ");
      if (sp > 0) out.push(h.value.slice(sp + 1).trim());
    }
  } catch {
    // As above.
  }
  return out;
}

// ───────────── Results ─────────────

/** Images, audio and blobs above this (decoded) size are dropped with a note. */
export const MAX_BINARY_BYTES = 5 * 1024 * 1024;
/** structuredContent above this (as JSON) is dropped: the text twin carries the result. */
export const MAX_STRUCTURED_CHARS = 1_000_000;

export interface OutputSignals {
  invisibleRemoved: number;
  ansiRemoved: number;
  redacted: number;
  truncated: boolean;
  droppedBlocks: number;
  structuredDropped?: "invalid" | "too_large";
}

export interface ProcessOptions {
  /** `<slug>/<tool>`, shown in the wrapper. */
  source: string;
  scrubber: Scrubber;
  /** Characters of text per response (Settings.maxBodyChars; 0 = unlimited). */
  maxChars: number;
  /** Validates structuredContent against the pinned outputSchema; returns false when it doesn't match. */
  validateStructured?: (value: unknown) => boolean;
  /** Tests only. */
  nonce?: string;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const newNonce = () => randomToken(16);

/** Cleans one piece of untrusted text: ANSI and controls, invisible characters, then secrets (so they can't hide behind either). */
function clean(text: string, scrubber: Scrubber, signals: OutputSignals): string {
  const a = stripAnsi(text);
  const i = stripInvisible(a.text);
  const s = scrubber.scrub(i.text);
  signals.ansiRemoved += a.removed;
  signals.invisibleRemoved += i.removed;
  signals.redacted += s.redacted;
  return s.text;
}

/** Deep-cleans every string in a JSON value (structuredContent): cleaned, scrubbed and delimiter-escaped. */
function cleanValue(v: unknown, scrubber: Scrubber, signals: OutputSignals): unknown {
  if (typeof v === "string") return escapeDelimiters(clean(v, scrubber, signals));
  if (Array.isArray(v)) return v.map((x) => cleanValue(x, scrubber, signals));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [escapeDelimiters(clean(k, scrubber, signals)), cleanValue(x, scrubber, signals)]));
  }
  return v;
}

const decodedSize = (b64: unknown) => (typeof b64 === "string" ? Math.floor((b64.length * 3) / 4) : 0);

/**
 * The result as the agent gets it. Text (including embedded text resources and resource links) is wrapped as
 * one `<tool_output source="…" nonce="…" untrusted>` per block with a fresh nonce per response; images and
 * audio pass through under a size cap; anything else is dropped with a note.
 */
export function processResult(result: ToolResult, opts: ProcessOptions): { result: ToolResult; signals: OutputSignals } {
  const signals: OutputSignals = { invisibleRemoved: 0, ansiRemoved: 0, redacted: 0, truncated: false, droppedBlocks: 0 };
  const nonce = opts.nonce ?? newNonce();
  const source = escapeAttr(opts.source);
  let budget = opts.maxChars > 0 ? opts.maxChars : Infinity;
  const notes: string[] = [];

  const wrapText = (raw: string): ContentBlock | null => {
    let text = clean(raw, opts.scrubber, signals);
    let cut = "";
    if (Number.isFinite(budget)) {
      if (budget <= 0) {
        signals.truncated = true;
        return null;
      }
      const t = truncateText(text, budget);
      if (t.truncated) {
        signals.truncated = true;
        cut = `\n[output truncated to ${opts.maxChars} characters]`;
      }
      text = t.text;
      budget -= text.length;
    }
    return { type: "text", text: `<tool_output source="${source}" nonce="${nonce}" untrusted>\n${escapeDelimiters(text)}\n</tool_output>${cut}` };
  };

  const content: ContentBlock[] = [];
  for (const block of Array.isArray(result.content) ? result.content : []) {
    const type = typeof block?.type === "string" ? block.type : "";
    if (type === "text") {
      const b = wrapText(typeof block.text === "string" ? block.text : "");
      if (b) content.push(b);
    } else if (type === "image" || type === "audio") {
      if (typeof block.data !== "string" || decodedSize(block.data) > MAX_BINARY_BYTES) {
        signals.droppedBlocks++;
        notes.push(`[${type} omitted: larger than ${MAX_BINARY_BYTES / 1024 / 1024} MB]`);
        continue;
      }
      content.push({ type, data: block.data, mimeType: typeof block.mimeType === "string" ? clean(block.mimeType, opts.scrubber, signals).slice(0, 100) : "application/octet-stream" });
    } else if (type === "resource") {
      const r = (block.resource ?? {}) as Record<string, unknown>;
      const uri = typeof r.uri === "string" ? r.uri : "";
      if (typeof r.text === "string") {
        const b = wrapText(`Resource ${uri}:\n${r.text}`);
        if (b) content.push(b);
      } else if (typeof r.blob === "string" && decodedSize(r.blob) <= MAX_BINARY_BYTES) {
        content.push({
          type: "resource",
          resource: { uri: clean(uri, opts.scrubber, signals), blob: r.blob, ...(typeof r.mimeType === "string" ? { mimeType: clean(r.mimeType, opts.scrubber, signals).slice(0, 100) } : {}) },
        });
      } else {
        signals.droppedBlocks++;
        notes.push("[resource omitted: too large or empty]");
      }
    } else if (type === "resource_link") {
      const name = typeof block.name === "string" ? block.name : "";
      const uri = typeof block.uri === "string" ? block.uri : "";
      const desc = typeof block.description === "string" ? `\n${block.description}` : "";
      const b = wrapText(`Link: ${name} <${uri}>${desc}`);
      if (b) content.push(b);
    } else {
      signals.droppedBlocks++;
      notes.push(`[content of type "${escapeAttr(type.slice(0, 40))}" omitted]`);
    }
  }
  if (notes.length) content.push({ type: "text", text: notes.join("\n") });

  const out: ToolResult = { content };
  if (result.isError) out.isError = true;
  if (result.structuredContent !== undefined) {
    let size = Infinity;
    try {
      size = JSON.stringify(result.structuredContent)?.length ?? 0;
    } catch {
      // Not JSON: dropped below.
    }
    if (size > MAX_STRUCTURED_CHARS) signals.structuredDropped = "too_large";
    else if (opts.validateStructured && !result.isError && !opts.validateStructured(result.structuredContent)) signals.structuredDropped = "invalid";
    else out.structuredContent = cleanValue(result.structuredContent, opts.scrubber, signals);
  }
  return { result: out, signals };
}

/** UTF-8 size of a result as JSON (audit). */
export function resultBytes(r: ToolResult): number {
  try {
    return Buffer.byteLength(JSON.stringify(r));
  } catch {
    return 0;
  }
}
