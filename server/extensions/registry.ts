// The official registry: index.json at the root of wynn-dev/xaq-extensions (docs/EXTENSIONS.md). The index is only a
// catalog; what gets installed is pinned by each entry's `commit` and `integrity`.

import { envVar } from "../brand.ts";
import { INTEGRITY_RE } from "./integrity.ts";

export const OFFICIAL_OWNER = "wynn-dev";
export const OFFICIAL_REPO = "xaq-extensions";
/**
 * The official extensions core knows of (the bootstrap pins, docs/EXTENSIONS.md "Migration"): a third-party extension
 * can't take these names even when the registry can't be read. The registry index's names are refused too.
 * google-workspace has no bootstrap pin; it's reserved because it uses connected Google accounts.
 */
export const OFFICIAL_NAMES: readonly string[] = ["notion", "t3code", "whoop", "brightspace", "google-workspace"];

/** Where sources are fetched from. XAQ_EXT_GITHUB_BASE (tests only) points all three at a fake GitHub. */
export interface ExtensionUrls {
  /** index.json. */
  registry: string;
  /** api.github.com (resolving a ref to a commit). */
  githubApi: string;
  /** codeload.github.com (tarballs). */
  codeload: string;
}

export function defaultExtensionUrls(): ExtensionUrls {
  const base = envVar("EXT_GITHUB_BASE");
  if (base) return { registry: `${base}/raw/index.json`, githubApi: `${base}/api`, codeload: `${base}/codeload` };
  return {
    registry: `https://raw.githubusercontent.com/${OFFICIAL_OWNER}/${OFFICIAL_REPO}/main/index.json`,
    githubApi: "https://api.github.com",
    codeload: "https://codeload.github.com",
  };
}

export const EXTENSION_NAME_RE = /^[a-z0-9-]{1,32}$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;

export interface RegistryEntry {
  name: string;
  displayName: string;
  description: string;
  kind: "remote" | "code";
  version: string;
  path: string;
  commit: string;
  integrity: string;
}

export interface RegistryIndex {
  schema: 1;
  extensions: RegistryEntry[];
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;

/** Checks index.json's shape; entries that don't fit are refused (the whole index, so a typo is noticed). */
export function parseIndex(raw: unknown): RegistryIndex {
  const o = raw as { schema?: unknown; extensions?: unknown } | null;
  if (!o || typeof o !== "object" || o.schema !== 1 || !Array.isArray(o.extensions)) throw new RegistryError("The registry index isn't schema 1.");
  const names = new Set<string>();
  const extensions = o.extensions.map((e: Record<string, unknown>, i: number): RegistryEntry => {
    const where = `entry ${i + 1}${typeof e?.name === "string" ? ` (${e.name})` : ""}`;
    if (!e || typeof e !== "object") throw new RegistryError(`The registry index's ${where} isn't an object.`);
    if (typeof e.name !== "string" || !EXTENSION_NAME_RE.test(e.name)) throw new RegistryError(`The registry index's ${where} has a bad name.`);
    if (names.has(e.name)) throw new RegistryError(`The registry index lists ${e.name} twice.`);
    names.add(e.name);
    if (e.kind !== "remote" && e.kind !== "code") throw new RegistryError(`The registry index's ${where} has a bad kind.`);
    if (typeof e.commit !== "string" || !COMMIT_RE.test(e.commit)) throw new RegistryError(`The registry index's ${where} has a bad commit.`);
    if (typeof e.integrity !== "string" || !INTEGRITY_RE.test(e.integrity)) throw new RegistryError(`The registry index's ${where} has a bad integrity.`);
    if (e.path !== `extensions/${e.name}`) throw new RegistryError(`The registry index's ${where} must have path extensions/${e.name}.`);
    if (!str(e.version, 64) || !str(e.displayName ?? "", 100) || !str(e.description ?? "", 1000)) throw new RegistryError(`The registry index's ${where} has a bad field.`);
    return {
      name: e.name,
      displayName: (e.displayName as string | undefined) || e.name,
      description: (e.description as string | undefined) ?? "",
      kind: e.kind,
      version: e.version as string,
      path: e.path,
      commit: e.commit,
      integrity: e.integrity,
    };
  });
  return { schema: 1, extensions };
}

const INDEX_MAX_BYTES = 1024 * 1024;

export async function fetchIndex(urls: ExtensionUrls, doFetch: typeof fetch = fetch): Promise<RegistryIndex> {
  let res: Response;
  try {
    res = await doFetch(urls.registry, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new RegistryError(`Couldn't fetch the extension registry (${urls.registry}): ${(err as Error).message}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new RegistryError(`Couldn't fetch the extension registry: HTTP ${res.status} from ${urls.registry}.`);
  }
  const text = await res.text();
  if (text.length > INDEX_MAX_BYTES) throw new RegistryError("The registry index is too large.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RegistryError("The registry index isn't valid JSON.");
  }
  return parseIndex(raw);
}
