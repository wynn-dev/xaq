import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const PRODUCT = "xaq";
export const LEGACY_PRODUCT = "agentinbox";

/** `XAQ_<name>`. */
export const envVar = (name: string, env: NodeJS.ProcessEnv = process.env): string | undefined => env[`XAQ_${name}`];

/** Whether this process runs under `service install` (XAQ_SERVICE=1). */
export const underService = (env: NodeJS.ProcessEnv = process.env) => envVar("SERVICE", env) === "1";

// pickDir is still used by server/listen/paths.ts, LEGACY_PRODUCT by the listener's own compat; both go with it.

/**
 * What pickDir chose: `xaq` holding our files (or not there yet), the pre-rename `agentinbox`, or a `xaq`
 * that another program owns, which we share by only adding our own paths to it.
 */
export type DirKind = "ours" | "legacy" | "shared";

/** The listener's directory under `base`: `xaq` when it holds one of `markers`, else an existing `agentinbox`, else `xaq`. */
export function pickDir(base: string, markers: string[], opts: { dot?: boolean } = {}): { dir: string; kind: DirKind } {
  const name = (n: string) => join(base, opts.dot ? `.${n}` : n);
  const next = name(PRODUCT);
  if (markers.some((m) => isPresent(join(next, m)))) return { dir: next, kind: "ours" };
  const legacy = name(LEGACY_PRODUCT);
  if (existsSync(legacy)) return { dir: legacy, kind: "legacy" };
  return { dir: next, kind: isPresent(next) ? "shared" : "ours" };
}

function isPresent(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
