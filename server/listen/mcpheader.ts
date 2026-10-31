import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIN_NODE, nodeVersionError } from "../node-check.ts";
import { assertOurs, writePrivateFile } from "./fsutil.ts";
import { PRODUCT } from "../brand.ts";
import { configDir, profilePath } from "./paths.ts";

/**
 * Keeps the API key out of argv and out of agent config files: Claude Code's `headersHelper` runs a
 * command at connection time and uses the JSON it prints as request headers. The helper is a tiny
 * dependency-free script next to the profiles (stable, unlike the npx cache) that reads the key from
 * the 0600 profile and prints `{"Authorization":"Bearer …"}` to Claude Code's pipe, never a terminal.
 */

export const helperScriptPath = () => join(configDir(), "bin", "mcp-header.mjs");
/** The MCP config the Claude Code recipe loads with --strict-mcp-config (no key inside). */
export const claudeMcpConfigPath = () => join(configDir(), "mcp", "default.claude.json");

/** POSIX single-quoting for the shell Claude Code runs the helper in. */
const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

export function helperScript(profileFile: string): string {
  return `#!/usr/bin/env node
// xaq MCP header helper (written by \`xaq connect\` / \`setup-mcp\`). Prints the
// Authorization header of this machine's xaq pairing as JSON for Claude Code's headersHelper.
import { readFileSync } from "node:fs";
if (process.stdout.isTTY) { console.error("This prints a secret header; it is meant to be piped to an MCP client."); process.exit(2); }
const profile = JSON.parse(readFileSync(${JSON.stringify(profileFile)}, "utf8"));
process.stdout.write(JSON.stringify({ Authorization: "Bearer " + profile.apiKey }));
`;
}

/** Node installs whose path names one version, so upgrading or removing that version breaks anything that recorded it. */
const VERSIONED_NODE = /\/\.?fnm\/node-versions\/|\/\.?nvm\/versions\/node\/|\/\.volta\/tools\/image\/node\/|\/\.asdf\/installs\/nodejs\/|\/mise\/installs\/node\/|\/n\/versions\/node\/|\/Cellar\/node(@\d+)?\//;

export interface NodeChoice {
  /** The node binary recorded in the header helper command. */
  path: string;
  /** `path` is version-specific: replacing or removing that Node breaks the helper. */
  versioned: boolean;
}

/** A node binary that runs and is new enough for the helper (ESM with node: imports). */
function worksAsNode(path: string): boolean {
  if (!existsSync(path)) return false;
  const r = spawnSync(path, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  const major = /^v(\d+)\./.exec(r.stdout ?? "")?.[1];
  return r.status === 0 && major !== undefined && Number(major) >= 18;
}

/**
 * The node to record for Claude Code's header helper. A version manager's node (fnm, nvm, Volta, asdf,
 * mise, n, a Homebrew Cellar keg) disappears on upgrade, so prefer a path that stays put: the same
 * Homebrew keg's opt/ link (then the prefix's bin/node), fnm's default alias, or a system node, but only
 * when it exists and runs.
 * Version-manager shims that pick a version per directory (asdf, mise, Volta) aren't used: Claude Code
 * runs the helper in whatever project it's in. Otherwise the current node is kept (and reported).
 */
export function helperNode(execPath = process.execPath, works: (path: string) => boolean = worksAsNode): NodeChoice {
  if (!VERSIONED_NODE.test(execPath)) return { path: execPath, versioned: false };
  const candidates: string[] = [];
  // Homebrew: <prefix>/opt/node@22 (or opt/node) follows the same formula across upgrades; bin/node may be another one.
  const cellar = /^(.*)\/Cellar\/(node(?:@\d+)?)\//.exec(execPath);
  if (cellar) candidates.push(join(cellar[1]!, "opt", cellar[2]!, "bin", "node"), join(cellar[1]!, "bin", "node"));
  // fnm: ~/.local/share/fnm (or the older ~/.fnm)/node-versions/… → <fnm dir>/aliases/default.
  const fnm = /^(.*\/\.?fnm)\/node-versions\//.exec(execPath);
  if (fnm) candidates.push(join(fnm[1]!, "aliases", "default", "bin", "node"));
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
  const stable = candidates.find((c) => c !== execPath && !VERSIONED_NODE.test(c) && works(c));
  return stable ? { path: stable, versioned: false } : { path: execPath, versioned: true };
}

/**
 * The environment a Node binary is probed with (`node --version` and the like): built from scratch, so the
 * binary never sees the caller's secrets (an exported XAQ_MASTER_KEY, API keys), and NODE_OPTIONS can't change
 * or break what it does (a `--require` of a missing file would fail every probe).
 */
export function nodeProbeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "LANG"] as const) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

/** `node --version` of a binary ("22.20.0"), or null when it doesn't run. */
export function nodeVersionOf(path: string): string | null {
  if (!existsSync(path)) return null;
  const r = spawnSync(path, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, killSignal: "SIGKILL", env: nodeProbeEnv() });
  const v = /^v(\d+\.\d+\.\d+)/.exec(r.stdout ?? "")?.[1];
  return r.status === 0 && v ? v : null;
}

/**
 * The user's own private group (Linux's user-private-group scheme: group `ada` for user `ada`), whose write bit
 * gives no one else anything: the gid when the user's primary group (in /etc/passwd) lists no member in
 * /etc/group but the user, and is no other user's primary group. Null when that can't be shown: on macOS (users
 * live in Directory Services and share `staff`), without entries in /etc/passwd and /etc/group (LDAP, NIS), or
 * when anyone else is in the group. Under umask 002 (common on Linux) fnm and nvm create their directories
 * group-writable for this group.
 */
export function userPrivateGroup(opts: { platform?: NodeJS.Platform; uid?: number; passwd?: string; group?: string } = {}): number | null {
  if ((opts.platform ?? process.platform) !== "linux") return null;
  try {
    const uid = opts.uid ?? process.getuid?.() ?? -1;
    // NIS compat lines (+ / -) pull in entries this can't see: then nothing is known to be private.
    const rows = (text: string) => text.split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split(":"));
    const users = rows(opts.passwd ?? readFileSync("/etc/passwd", "utf8"));
    const groups = rows(opts.group ?? readFileSync("/etc/group", "utf8"));
    if ([...users, ...groups].some((r) => /^[+-]/.test(r[0] ?? ""))) return null;
    const me = users.find((u) => u[2] !== undefined && Number(u[2]) === uid);
    if (!me || !/^\d+$/.test(me[3] ?? "")) return null;
    const gid = Number(me[3]);
    if (gid === 0) return null;
    if (users.some((u) => u !== me && u[3] !== undefined && Number(u[3]) === gid)) return null;
    const mine = groups.filter((g) => g[2] !== undefined && Number(g[2]) === gid);
    if (mine.length !== 1) return null;
    const members = (mine[0]![3] ?? "").split(",").map((m) => m.trim()).filter(Boolean);
    return members.every((m) => m === me[0]) ? gid : null;
  } catch {
    return null;
  }
}

let privateGroup: { gid: number | null } | null = null;

export interface TrustOptions {
  /** This user (default: the process's uid). */
  uid?: number;
  /** The user's private group, whose write bit is harmless (default: userPrivateGroup()); null for none. */
  privateGid?: number | null;
  /** Accept group-writable (never world-writable): for a Node the service already runs at every start. */
  groupWritable?: boolean;
}

/**
 * A node binary the service may run: the real file, and every directory above both the path as given and
 * the real file, are owned by root or by this user and not writable by others. Never world-writable (a
 * sticky directory such as /tmp excepted); group-writable only when the group is the user's private group
 * (see userPrivateGroup), or with opts.groupWritable. Otherwise someone else could replace what the service
 * runs at every login.
 */
export function trustedNodeFile(path: string, opts: TrustOptions = {}): boolean {
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  const privateGid = opts.privateGid !== undefined ? opts.privateGid : (privateGroup ??= { gid: userPrivateGroup() }).gid;
  const owned = (st: { uid: number }) => st.uid === 0 || st.uid === uid;
  const notWritable = (st: { mode: number; gid: number }) =>
    (st.mode & 0o002) === 0 && ((st.mode & 0o020) === 0 || !!opts.groupWritable || (privateGid !== null && st.gid === privateGid));
  const dirsOk = (p: string) => {
    for (let d = dirname(p); ; d = dirname(d)) {
      const st = statSync(d);
      if (!owned(st) || (!notWritable(st) && (st.mode & 0o1000) === 0)) return false;
      if (d === dirname(d)) return true;
    }
  };
  try {
    const real = realpathSync(path);
    const st = statSync(real);
    return owned(st) && notWritable(st) && dirsOk(path) && dirsOk(real);
  } catch {
    return false;
  }
}

export interface ServiceNodeChoice extends NodeChoice {
  version: string;
  /** Why this node, in words (printed by `listen service install`). */
  why: string;
}

/**
 * The node the listener service runs on: the same stable-path preference as the header helper (a path
 * that survives fnm/nvm/Homebrew upgrades), but only a candidate that is trusted (trustedNodeFile) and new
 * enough for xaq (MIN_NODE); else this shell's node, reported as version-specific.
 */
export function serviceNode(
  execPath = process.execPath,
  versionOf: (path: string) => string | null = nodeVersionOf,
  current = process.versions.node,
  trusted: (path: string) => boolean = trustedNodeFile,
): ServiceNodeChoice {
  const versions = new Map<string, string | null>();
  const okVersion = (p: string) => {
    if (!trusted(p)) return false;
    if (!versions.has(p)) versions.set(p, versionOf(p));
    const v = versions.get(p);
    return !!v && nodeVersionError(v) === null;
  };
  const choice = helperNode(execPath, okVersion);
  if (choice.path !== execPath) {
    return { ...choice, version: versions.get(choice.path)!, why: `a stable path that survives fnm/nvm upgrades (this shell's is ${execPath}, v${current})` };
  }
  return {
    ...choice,
    version: current,
    why: choice.versioned
      ? `this shell's node; its path belongs to one Node version (no stable node ${MIN_NODE}+ found in the usual places), so re-run install after upgrading or removing it`
      : "this shell's node",
  };
}

let chosenNode: NodeChoice | undefined;
/** helperNode() for this process, computed once (it may run a candidate's --version). */
export const helperNodeChoice = (): NodeChoice => (chosenNode ??= helperNode());

/** The shell command Claude Code runs as headersHelper (nothing is written). */
export const headerHelperCommand = () => `${sq(helperNodeChoice().path)} ${sq(helperScriptPath())}`;

/** The note setup-mcp prints about the recorded node (like `listen service install`'s Node.js line). */
export function helperNodeNote(rerun: string): string {
  const { path, versioned } = helperNodeChoice();
  const v = path === process.execPath ? ` (v${process.versions.node})` : "";
  return versioned
    ? `Node.js: Claude Code runs the header helper with ${path}${v}. That path belongs to one Node version: if you upgrade or remove it, run \`${rerun}\` again.`
    : `Node.js: Claude Code runs the header helper with ${path}${v}; if you remove it, run \`${rerun}\` again.`;
}

/** Writes (or refreshes) the helper script, 0700. Returns the shell command for headersHelper. */
export function installHeaderHelper(): string {
  const command = headerHelperCommand();
  // Ours: written by connect / setup-mcp. bin/ may sit in a directory another program called xaq owns, so an
  // existing bin/ keeps its mode.
  assertOurs(helperScriptPath(), (p) => /^#!\/usr\/bin\/env node\n\/\/ xaq MCP header helper/.test(readFileSync(p, "utf8")), "MCP header helper");
  writePrivateFile(helperScriptPath(), helperScript(profilePath()), { privateDir: "new" });
  // writePrivateFile leaves 0600; the script itself is run through node, so it needn't be executable.
  return command;
}

/** Claude Code MCP server entry: URL plus the helper, no secret. `install: false` (dry runs) doesn't write the helper. */
export function claudeServerEntry(url: string, opts: { install?: boolean } = {}): { type: "http"; url: string; headersHelper: string } {
  return { type: "http", url, headersHelper: opts.install === false ? headerHelperCommand() : installHeaderHelper() };
}

/** One of our keyless MCP configs: a single server whose headers come from our header helper. */
function isOurClaudeMcpConfig(path: string): boolean {
  const servers = (JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, { headersHelper?: unknown }> }).mcpServers ?? {};
  const entries = Object.values(servers);
  return entries.length === 1 && typeof entries[0]?.headersHelper === "string" && entries[0].headersHelper.includes("mcp-header.mjs");
}

/** Writes the MCP config the Claude Code listener recipe uses. Returns its path. */
export function writeClaudeMcpConfig(url: string): string {
  const path = claudeMcpConfigPath();
  // The recipe allows exactly `mcp__xaq`, so the server is always named that in this file.
  assertOurs(path, isOurClaudeMcpConfig, "Claude Code MCP config");
  writePrivateFile(path, JSON.stringify({ mcpServers: { [PRODUCT]: claudeServerEntry(url) } }, null, 2) + "\n", { privateDir: "new" });
  return path;
}
