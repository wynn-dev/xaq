// Namespacing: upstream tools are exposed as `<slug>__<name>`.

import { TOOL_NAMES } from "../../mcp/server.ts";
import { sha256Hex } from "./jcs.ts";

/** Claude Code prepends `mcp__<server>__` and drops names over 128, so ours stay at or below 64. */
export const MAX_EXPOSED_NAME = 64;
export const SLUG_RE = /^[a-z0-9-]{1,24}$/;
const EXPOSED_RE = /^[A-Za-z0-9_-]+$/;

let native: ReadonlySet<string> | null = null;
/**
 * Case-folded native tool names (server/mcp): neither a slug nor an exposed name may take one. Lazy, because
 * server/mcp will import the registry (a circular import must not read TOOL_NAMES at module load).
 */
export function nativeNames(): ReadonlySet<string> {
  return (native ??= new Set(TOOL_NAMES.map((n) => n.toLowerCase())));
}

export const fold = (s: string) => s.toLowerCase();

/** Why a slug can't be used, or null. `others`: the other connections' slugs. */
export function slugProblem(slug: string, others: Iterable<string>): string | null {
  if (!SLUG_RE.test(slug)) return "A slug is 1 to 24 lowercase letters, digits or dashes";
  if (nativeNames().has(fold(slug))) return `"${slug}" is the name of a built-in tool`;
  for (const o of others) if (fold(o) === fold(slug)) return `Another connection already uses "${slug}"`;
  return null;
}

/**
 * The exposed name for an upstream tool: `<slug>__<name>` with every character outside `[A-Za-z0-9_-]` (dots
 * included) replaced by `_`. Over 64 characters, it's cut and suffixed with a short hash of the original name,
 * so two long names stay distinct. Null when nothing usable is left.
 */
export function exposedName(slug: string, name: string): string | null {
  if (!SLUG_RE.test(slug)) return null;
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!/[A-Za-z0-9]/.test(safe)) return null;
  let out = `${slug}__${safe}`;
  if (out.length > MAX_EXPOSED_NAME) {
    const suffix = `_${sha256Hex(name).slice(0, 8)}`;
    out = out.slice(0, MAX_EXPOSED_NAME - suffix.length) + suffix;
  }
  return EXPOSED_RE.test(out) && !out.includes(".") ? out : null;
}

export interface NameCandidate {
  connectionId: string;
  name: string;
  exposedName: string | null;
  /** Kept on a collision over a newcomer (an already-pinned tool keeps its name). */
  established: boolean;
}

export type NameRefusal = {
  connectionId: string;
  name: string;
  /** invalid_definition: too deep, too large or not JSON (`detail` says which). */
  reason: "invalid_name" | "collision" | "invalid_definition";
  with?: string;
  detail?: string;
};

/**
 * Collision check across every connection, case-folded, against native names and each other. Deterministic: an
 * established tool wins over a newcomer, then the lower (connectionId, name). Returns the refused ones.
 */
export function checkCollisions(all: NameCandidate[]): { ok: Set<string>; refused: NameRefusal[] } {
  const key = (c: NameCandidate) => `${c.connectionId}\u0000${c.name}`;
  const sorted = [...all].sort(
    (a, b) =>
      Number(b.established) - Number(a.established) ||
      (a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : 0) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const taken = new Map<string, NameCandidate>();
  const ok = new Set<string>();
  const refused: NameRefusal[] = [];
  for (const c of sorted) {
    if (!c.exposedName) {
      refused.push({ connectionId: c.connectionId, name: c.name, reason: "invalid_name" });
      continue;
    }
    const f = fold(c.exposedName);
    if (nativeNames().has(f)) {
      refused.push({ connectionId: c.connectionId, name: c.name, reason: "collision", with: f });
      continue;
    }
    const prior = taken.get(f);
    if (prior) {
      refused.push({ connectionId: c.connectionId, name: c.name, reason: "collision", with: prior.exposedName! });
      continue;
    }
    taken.set(f, c);
    ok.add(key(c));
  }
  return { ok, refused };
}

export const candidateKey = (connectionId: string, name: string) => `${connectionId}\u0000${name}`;
