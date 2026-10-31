// How a code extension's child is started: the exact argv, the
// environment built from nothing, and the per-connection state directory.
//
// The flags were checked on Node 22.13.0, 22.23.3, 24.22.0 and 26.12.0:
// - `--permission` is stable, and each allowed path is its own `--allow-fs-read=` / `--allow-fs-write=` flag. The comma
//   form (`--allow-fs-read=a,b`) is read as one literal path, so it must never come back (test/extension-host.test.ts
//   pins the argv). Without `--allow-child-process`, `--allow-worker`, `--allow-addons` and `--allow-wasi`, those are
//   all refused.
// - `--no-experimental-sqlite`: `node:sqlite` ignores the permission model (it opens, ATTACHes and VACUUMs INTO any
//   path), so a child could open xaq's own database. With the flag, `import("node:sqlite")` fails and
//   `process.getBuiltinModule("node:sqlite")` is undefined.
// - `--import <CHILD_PRELOAD>`: signals and scheduling priority aren't covered by the permission model. The preload
//   pins `process.kill`, `_kill`, `_debugProcess`, `_debugEnd` and `os.setPriority` to throwers (non-writable,
//   non-configurable, on the module objects `getBuiltinModule("node:process")` / `("os")` and `require` return; then
//   `syncBuiltinESMExports` so `import { setPriority } from "node:os"` gets the thrower too). So the child can't
//   SIGUSR1 xaq into opening its inspector, kill xaq or another process of the same user, or lower xaq's priority.
//   It also ignores SIGUSR1 itself. v8.setFlagsFromString is pinned the same way (it could turn on
//   --allow-natives-syntax, and from there memory-corruption primitives). Only OS-level isolation closes this fully.
//   Verified on 22.13.0, 22.23.3, 24.22.0 and 26.12.0, every route (default, named and dynamic imports,
//   getBuiltinModule).
// - The Node floor (codeExtensionNodeProblem): releases before the 2026 permission-model fixes have known bypasses.

import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Bumped only with a protocol change C and the extensions repo agree on. */
export const XAQ_EXT_PROTOCOL = "1";

/** Loaded before the extension's entry (a data: URL needs no file-system allow). See the header. */
export const CHILD_PRELOAD =
  'data:text/javascript,const deny=(o,k,m)=>Object.defineProperty(o,k,{value(){throw new Error(m)},writable:false,configurable:false});for(const k of ["kill","_kill","_debugProcess","_debugEnd"])deny(process,k,"Signals are disabled for xaq extensions");deny(process.getBuiltinModule("node:os"),"setPriority","os.setPriority is disabled for xaq extensions");deny(process.getBuiltinModule("node:v8"),"setFlagsFromString","v8.setFlagsFromString is disabled for xaq extensions");process.getBuiltinModule("node:module").syncBuiltinESMExports();process.on("SIGUSR1",()=>{});';

/**
 * The oldest release of each Node line that may run code extensions: the latest security release with
 * permission-model fixes. Checked on 2026-10-17 against https://nodejs.org/dist/index.json (the `security` releases)
 * and each post under https://nodejs.org/en/blog/vulnerability/:
 * - 2025-01-21, january-2025-security-releases (22.13.1): CVE-2025-23083, a worker permission bypass through an
 *   InternalWorker leaked via diagnostics_channel (reproduced on 22.13.0 against this host).
 * - 2026-01-13, december-2025-security-releases (the post kept its pre-announcement slug; 22.22.0, 24.13.0, 25.3.0):
 *   CVE-2025-55130 (fs bypass with crafted symlinks), CVE-2025-55132 (`futimes` on read-only paths).
 * - 2026-03-24, march-2026-security-releases (22.22.2, 24.14.1): CVE-2026-21715 (`realpathSync.native` reads),
 *   CVE-2026-21716 (`FileHandle.chmod`).
 * - 2026-06-18, june-2026-security-releases (22.23.0, 24.17.0, 26.3.1): CVE-2026-48617 (`process.report` paths),
 *   CVE-2026-48935 (`FileHandle.utimes`).
 * - 2026-07-29, july-2026-security-releases (22.23.2, 24.18.1, 26.5.1): CVE-2026-58043 (High: path matching
 *   over-grants fs access at prefix boundaries), CVE-2026-56847 (trace events), CVE-2026-58039 (process reports).
 * Lines not listed (23, 25: end of life) are refused; lines after 26 are allowed.
 *
 * Not raised for 2026-10-21, october-2026-security-releases (22.23.4, 24.22.1, 26.12.1; checked 2026-10-22): its
 * permission-model fixes are rated low, CVE-2026-106073 (bypass with `fs.realpathSync`, all lines) and
 * CVE-2026-106071 (fs over-grant via wildcard radix lookup, 26.x only). Raising the floor would stop working
 * code extensions on 24.19 with no grace period, so that release is RECOMMENDED_NODE instead.
 */
export const CODE_EXTENSION_NODE_FLOOR: Record<number, string> = { 22: "22.23.2", 24: "24.18.1", 26: "26.5.1" };

/**
 * The release of each line xaq recommends: Node's 2026-10-21 security release
 * (https://nodejs.org/en/blog/vulnerability/october-2026-security-releases, checked 2026-10-22). Besides the two
 * low-rated permission-model fixes above (a sandbox bypass for code extensions), it fixes high-severity issues in
 * Node itself, on every line: CVE-2026-111497 (Brotli decoder out-of-bounds write, remote code execution),
 * CVE-2026-106069 and CVE-2026-105483 (TLS certificate hostname bypasses; the latter 24.x and 26.x), and
 * CVE-2026-105482 (`dns.resolve` truncates names at a NUL). Below it (at or above the floor) xaq still runs, and
 * says so: `service status` warns, the daemon logs it at start, and `service install` prefers a Node that meets it.
 */
export const RECOMMENDED_NODE: Record<number, string> = { 22: "22.23.4", 24: "24.22.1", 26: "26.12.1" };

/** True when `version` is below RECOMMENDED_NODE: an older release of a listed line, or an end-of-life line before the newest listed. */
export function belowRecommendedNode(version: string = process.versions.node): boolean {
  const major = parts(version)[0]!;
  const rec = RECOMMENDED_NODE[major];
  if (rec) return !atLeast(version, rec);
  return major < Math.max(...Object.keys(RECOMMENDED_NODE).map(Number));
}

const parts = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
const atLeast = (v: string, floor: string) => {
  const a = parts(v);
  const b = parts(floor);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

/** Why code extensions can't run on this Node, in the user's words; null when they can. xaq itself runs on ≥ 22.13. */
export function codeExtensionNodeProblem(version: string = process.versions.node): string | null {
  const major = parts(version)[0]!;
  const floor = CODE_EXTENSION_NODE_FLOOR[major];
  const maxListed = Math.max(...Object.keys(CODE_EXTENSION_NODE_FLOOR).map(Number));
  if (floor ? atLeast(version, floor) : major > maxListed) return null;
  const need = floor ? `≥ ${floor}` : `${Object.values(CODE_EXTENSION_NODE_FLOOR).join(", ")} or newer on those lines`;
  return `Code extensions need Node ${need} (xaq is running on ${version.replace(/^v/, "")}). Update Node and restart xaq.`;
}

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `<dataDir>/extension-state/<name>/<connectionId>/`. Throws on a name or id that isn't a plain path segment. */
export function extensionStateDir(dataDir: string, name: string, connectionId: string): string {
  if (!NAME_RE.test(name)) throw new Error(`Invalid extension name: ${name.slice(0, 40)}`);
  if (!ID_RE.test(connectionId)) throw new Error("Invalid connection id");
  return join(resolve(dataDir), "extension-state", name, connectionId);
}

/**
 * Creates the state directory (and its parents) as 0700, owned by xaq. An existing one must be a real directory (not
 * a symlink) or nothing starts.
 */
export function ensureStateDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const st = lstatSync(stateDir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("The extension's state directory isn't a plain directory");
  if ((st.mode & 0o077) !== 0) {
    // Created before with a looser mode (by hand, or another umask): tighten it.
    chmodSync(stateDir, 0o700);
  }
}

/** Deletes the connection's state under every extension (on connection removal). Never follows a symlink out. */
export function removeConnectionState(dataDir: string, connectionId: string): void {
  if (!ID_RE.test(connectionId)) return;
  const root = join(resolve(dataDir), "extension-state");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    const dir = join(root, name, connectionId);
    try {
      lstatSync(dir);
    } catch {
      continue;
    }
    // rmSync never follows symlinks inside the tree; the directory itself is ours (lstat'ed above).
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `<installDir>/<entry>`, refused unless it's a regular file inside the install. */
export function entryPath(installDir: string, entry: string): string {
  const root = resolve(installDir);
  const full = resolve(root, entry);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error("The extension's entry is outside its install directory");
  const st = lstatSync(full);
  if (!st.isFile()) throw new Error("The extension's entry isn't a regular file (symlinks are refused)");
  return full;
}

/**
 * The child's argv after the Node binary. Exactly: `--permission`, `--no-experimental-sqlite`, the signal preload,
 * one read allow for the install and one for the state directory, one write allow for the state directory, then the
 * entry. Nothing else.
 */
export function childArgs(installDir: string, stateDir: string, entry: string, opts: { allowNet?: boolean } = {}): string[] {
  return [
    "--permission",
    "--no-experimental-sqlite",
    "--import",
    CHILD_PRELOAD,
    `--allow-fs-read=${resolve(installDir)}`,
    `--allow-fs-read=${resolve(stateDir)}`,
    `--allow-fs-write=${resolve(stateDir)}`,
    ...((opts.allowNet ?? NODE_HAS_ALLOW_NET) ? ["--allow-net"] : []),
    entry,
  ];
}

/**
 * Node 25+ also gates the network under `--permission` (checked on 26.12.0: fetch is ERR_ACCESS_DENIED), and
 * `--allow-net` is an unknown, fatal option before that (22.x, 24.x). The contract leaves the network open (the
 * manifest's hosts are declared, not enforced), so the flag is passed exactly when this Node has it. The child runs on
 * this same binary (process.execPath).
 */
export const NODE_HAS_ALLOW_NET = process.allowedNodeEnvironmentFlags.has("--allow-net");

/**
 * The child's whole environment, built from nothing: the four XAQ_EXT_* values, plus TZ and LANG when xaq has them.
 * No PATH, HOME, NODE_OPTIONS, XAQ_*, AGENTINBOX_* or anything else from xaq's environment.
 */
export function childEnv(p: { name: string; connectionId: string; stateDir: string }, from: { TZ?: string; LANG?: string } = process.env): Record<string, string> {
  const env: Record<string, string> = {
    XAQ_EXT_NAME: p.name,
    XAQ_EXT_CONNECTION_ID: p.connectionId,
    XAQ_EXT_STATE_DIR: resolve(p.stateDir),
    XAQ_EXT_PROTOCOL,
  };
  if (from.TZ) env.TZ = from.TZ;
  if (from.LANG) env.LANG = from.LANG;
  return env;
}
