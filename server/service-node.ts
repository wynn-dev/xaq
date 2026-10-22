import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { belowRecommendedNode, CODE_EXTENSION_NODE_FLOOR, codeExtensionNodeProblem, RECOMMENDED_NODE } from "./extensions/host/spawn.ts";
import { nodeProbeEnv, trustedNodeFile } from "./listen/mcpheader.ts";
import { MIN_NODE, nodeVersionError } from "./node-check.ts";

/**
 * Which Node.js the daemon service (systemd unit / launchd plist) runs on. A service installed from a
 * non-interactive shell would otherwise record whatever `node` that shell found first (say an old
 * /usr/local/bin/node instead of the fnm Node the service ran on), and code extensions then can't start.
 *
 * The order: the Node running the installer, if it is new enough; else the Node the existing service uses;
 * else the newest new-enough Node in the usual places (fnm, nvm, Volta, Homebrew, asdf, mise, /usr/bin).
 * "New enough" is the code-extension floor while code extensions are installed in the data directory, else
 * xaq's own minimum (MIN_NODE), still preferring a Node that meets the floor when there is one. Before both, a
 * Node with Node's October 2026 security release (RECOMMENDED_NODE) is preferred when there is one.
 */

/** Where a chosen Node came from. */
export type NodeSource = "flag" | "installer" | "previous" | "found";

export interface ServiceNodePick {
  path: string;
  version: string;
  source: NodeSource;
  /** Why it was picked, for the success message. */
  why: string;
  /** The Node meets the code-extension floor. */
  codeReady: boolean;
  /** The Node meets RECOMMENDED_NODE. */
  recommended: boolean;
}

export interface NodeSearchDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  /** Prefix for absolute system paths (/opt/homebrew, /usr/local, /usr/bin). Tests point it at a temp dir. */
  root: string;
  /** The Node running the installer. */
  installer: { path: string; version: string };
  versionOf(path: string): string | null;
  /**
   * Whether a found binary may be recorded (see trustedNodeFile). Not asked of the installer's Node or --node.
   * `previous`: the Node the existing service runs, which may be group-writable (the service already runs it at every start).
   */
  trusted(path: string, previous?: boolean): boolean;
}

export const defaultNodeSearch = (): NodeSearchDeps => ({
  home: homedir(),
  env: process.env,
  root: "",
  installer: { path: process.execPath, version: process.versions.node },
  versionOf: nodeVersionOf,
  trusted: (p, previous) => trustedNodeFile(p, { groupWritable: previous }),
});

/**
 * `<node> -p process.versions.node` ("24.19.0"), or null when it doesn't run or says something else. The binary
 * gets a minimal environment (nodeProbeEnv: no NODE_OPTIONS, no XAQ_MASTER_KEY) and is killed outright on timeout.
 */
export function nodeVersionOf(path: string, timeoutMs = 5000): string | null {
  if (!isAbsolute(path) || !existsSync(path)) return null;
  const r = spawnSync(path, ["-p", "process.versions.node"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: nodeProbeEnv(),
  });
  const v = (r.stdout ?? "").trim();
  return r.status === 0 && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

/**
 * fnm's per-shell links (`fnm env` puts `<state>/fnm_multishells/<pid>_<ms>/bin` on PATH: under
 * $XDG_RUNTIME_DIR or ~/.local/state on Linux, ~/Library/Caches or $TMPDIR on macOS). Each points at an alias
 * or a version, and is deleted with the shell's runtime directory or a cache sweep: never recorded.
 */
export const isMultishell = (path: string) => /[\\/]fnm_multishells[\\/]/.test(path);

/** A path that stays put: a multishell link is replaced by the install it points to; null when it points nowhere. */
export function stableNodePath(path: string): string | null {
  if (!isMultishell(path)) return path;
  try {
    const real = realpathSync(path);
    return isMultishell(real) ? null : real;
  } catch {
    return null;
  }
}

const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export const meetsGeneral = (version: string) => nodeVersionError(version) === null;
export const meetsCodeFloor = (version: string) => meetsGeneral(version) && codeExtensionNodeProblem(version) === null;
export const meetsRecommended = (version: string) => meetsCodeFloor(version) && !belowRecommendedNode(version);

/** "22.23.2+, 24.18.1+ or 26.5.1+ (or a newer line)". */
export function codeFloorText(): string {
  const v = Object.values(CODE_EXTENSION_NODE_FLOOR).map((f) => `${f}+`);
  return `${v.slice(0, -1).join(", ")} or ${v.at(-1)} (or a newer line)`;
}

/** "22.23.4, 24.22.1 or 26.12.1". */
export function recommendedNodeText(): string {
  const v = Object.values(RECOMMENDED_NODE);
  return `${v.slice(0, -1).join(", ")} or ${v.at(-1)}`;
}

/**
 * The warning for a Node that runs xaq but is below RECOMMENDED_NODE, with the fix; null at or above it (or
 * when xaq can't run on it at all). A warning, not a problem: `service status` exits as before. `rerun`: the
 * `service install` command to run again after updating Node; omitted for a daemon not run as a service.
 */
export function recommendedNodeWarning(version: string, rerun?: string): string | null {
  if (!meetsGeneral(version) || !belowRecommendedNode(version)) return null;
  const then = rerun ? `Update Node, then run \`${rerun}\` again` : "Update Node, then restart xaq";
  return [
    `Node.js ${version} runs xaq; the October 2026 security release (${recommendedNodeText()}) fixes a sandbox bypass and high-severity issues in Node itself. ${then}. For example:`,
    "    fnm install 24 && fnm default 24",
    "    nvm install 24 && nvm alias default 24",
    "    brew upgrade node@24",
  ].join("\n  ");
}

const children = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/** The Node binaries in the usual places, in search order (fnm, nvm, Volta, Homebrew, asdf, mise, /usr/bin). Only what exists. */
export function knownNodes(deps: Pick<NodeSearchDeps, "home" | "env" | "root">): { path: string; where: string }[] {
  const { home, env } = deps;
  const sys = (p: string) => (deps.root ? join(deps.root, p) : p);
  const out: { path: string; where: string }[] = [];
  const add = (where: string, path: string) => {
    if (!out.some((c) => c.path === path) && existsSync(path)) out.push({ path, where });
  };
  const each = (where: string, dir: string, sub: string, match: (name: string) => boolean = () => true) => {
    for (const name of children(dir)) if (match(name)) add(where, join(dir, name, sub));
  };

  const fnmDirs = [env.FNM_DIR, join(env.XDG_DATA_HOME || join(home, ".local/share"), "fnm"), join(home, ".local/share/fnm"), join(home, "Library/Application Support/fnm"), join(home, ".fnm")];
  for (const d of fnmDirs) if (d) each("fnm", join(d, "node-versions"), "installation/bin/node");
  for (const d of [env.NVM_DIR, join(home, ".nvm")]) if (d) each("nvm", join(d, "versions/node"), "bin/node");
  for (const d of [env.VOLTA_HOME, join(home, ".volta")]) if (d) each("Volta", join(d, "tools/image/node"), "bin/node");
  const formula = (n: string) => n === "node" || /^node@\d+$/.test(n);
  for (const prefix of ["/opt/homebrew", "/usr/local"]) {
    add("Homebrew", sys(join(prefix, "bin/node")));
    each("Homebrew", sys(join(prefix, "opt")), "bin/node", formula);
  }
  // asdf and mise installs (their shims pick a version per directory and need the manager on PATH, so they aren't used).
  for (const d of [env.ASDF_DATA_DIR, join(home, ".asdf")]) if (d) each("asdf", join(d, "installs/nodejs"), "bin/node");
  for (const d of [env.MISE_DATA_DIR, join(env.XDG_DATA_HOME || join(home, ".local/share"), "mise"), join(home, ".local/share/mise")]) if (d) each("mise", join(d, "installs/node"), "bin/node");
  add("system", sys("/usr/bin/node"));
  return out.filter((c) => !isMultishell(c.path));
}

/** Names of the code extensions installed in a data directory (its database), read-only. Empty when there is none. */
export function installedCodeExtensions(dbPath: string): string[] {
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return (db.prepare("SELECT name FROM extensions WHERE kind = 'code' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  } catch {
    // No extensions table yet (an older database).
    return [];
  } finally {
    db?.close();
  }
}

/** The Node a systemd unit (ExecStart's first word) or launchd plist (ProgramArguments' first string) runs. */
export function unitNodePath(text: string): string | null {
  const sd = /^ExecStart=(?:"((?:[^"\\]|\\.)*)"|(\S+))/m.exec(text);
  if (sd) return sd[1] !== undefined ? sd[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%") : sd[2]!;
  const pl = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text);
  if (pl) return pl[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return null;
}

/** The fix text for a missing or too-old Node. */
export function nodeFixLines(rerun: string): string[] {
  return [
    "To fix it, install a newer Node.js, then run this again. For example:",
    "    fnm install 24 && fnm default 24",
    "    nvm install 24 && nvm alias default 24",
    "    brew install node@24",
    `  Or name the Node to use: \`${rerun} --node /path/to/node\`.`,
  ];
}

export class ServiceNodeError extends Error {
  override name = "ServiceNodeError";
}

const pick = (path: string, version: string, source: NodeSource, why: string): ServiceNodePick => ({
  path,
  version,
  source,
  why,
  codeReady: meetsCodeFloor(version),
  recommended: meetsRecommended(version),
});

const show = (path: string, version: string | null, note?: string) => `    ${path} → ${version ?? "doesn't run"}${note ? ` (${note})` : ""}`;

/**
 * Chooses the service's Node (see the top of this file). `previous`: the Node paths the installed units use
 * (the current service first, then one from before the rename). `flag`: --node. Throws ServiceNodeError, before
 * anything is touched, when no Node qualifies.
 */
export function chooseServiceNode(
  input: { previous: (string | null)[]; flag?: string; codeExtensions: string[]; rerun: string },
  deps: NodeSearchDeps = defaultNodeSearch(),
): ServiceNodePick {
  const code = input.codeExtensions.length > 0;
  const exts = input.codeExtensions.join(", ");
  const need = code ? `Code extensions (${exts}) need Node.js ${codeFloorText()}.` : `xaq needs Node.js ${MIN_NODE} or newer.`;

  if (input.flag !== undefined) {
    const given = resolve(input.flag);
    const path = stableNodePath(given);
    if (!path) throw new ServiceNodeError(`--node ${input.flag} is a per-shell fnm link that points nowhere. Name the Node itself (e.g. ~/.local/share/fnm/node-versions/v24.19.0/installation/bin/node). Nothing was changed.`);
    const version = deps.versionOf(path);
    const ok = version !== null && (code ? meetsCodeFloor(version) : meetsGeneral(version));
    if (!ok) {
      throw new ServiceNodeError(
        [`--node ${path} can't run the service (${version ? `it is Node.js ${version}` : "it doesn't run as Node.js"}). ${need} Nothing was changed.`, ...nodeFixLines(input.rerun).slice(0, 4)].join("\n  "),
      );
    }
    return pick(path, version!, "flag", "given with --node");
  }

  const seen: string[] = [];
  const versions = new Map<string, string | null>();
  const versionOf = (p: string) => {
    if (!versions.has(p)) versions.set(p, deps.versionOf(p));
    return versions.get(p)!;
  };

  const installerPath = stableNodePath(deps.installer.path);
  const installer = installerPath ? { path: installerPath, version: installerPath === deps.installer.path ? deps.installer.version : versionOf(installerPath) } : null;
  if (installer) seen.push(show(installer.path, installer.version, "the Node running this install"));
  else seen.push(show(deps.installer.path, deps.installer.version, "the Node running this install: a per-shell fnm link, skipped"));

  const previous: { path: string; version: string | null }[] = [];
  for (const raw of input.previous) {
    if (!raw) continue;
    const path = stableNodePath(raw);
    if (!path) {
      seen.push(show(raw, null, "the previous service's: a per-shell fnm link that points nowhere, skipped"));
      continue;
    }
    if (previous.some((p) => p.path === path) || path === installer?.path) continue;
    if (!deps.trusted(path, true)) {
      seen.push(show(path, null, "the previous service's: world-writable or owned by another user, skipped"));
      continue;
    }
    const version = versionOf(path);
    previous.push({ path, version });
    seen.push(show(path, version, "the previous service's"));
  }

  let found: { path: string; version: string | null; where: string }[] | null = null;
  const search = () => {
    if (found) return found;
    found = [];
    for (const c of knownNodes(deps)) {
      if (c.path === installer?.path || previous.some((p) => p.path === c.path)) continue;
      if (!deps.trusted(c.path)) {
        seen.push(show(c.path, null, `${c.where}: group- or world-writable, or owned by another user, skipped`));
        continue;
      }
      const version = versionOf(c.path);
      found.push({ ...c, version });
      seen.push(show(c.path, version, c.where));
    }
    // Newest first; the search order breaks ties.
    found = found.map((c, i) => ({ c, i })).sort((a, b) => compareVersions(b.c.version ?? "0", a.c.version ?? "0") || a.i - b.i).map((x) => x.c);
    return found;
  };

  // A Node with the October 2026 security release first. Then, with code extensions installed, only the floor
  // counts; without, a floor-meeting Node is preferred, then xaq's minimum.
  const tiers: ((v: string) => boolean)[] = code ? [meetsRecommended, meetsCodeFloor] : [meetsRecommended, meetsCodeFloor, meetsGeneral];
  for (const ok of tiers) {
    if (installer?.version && ok(installer.version)) return pick(installer.path, installer.version, "installer", "the Node running this install");
    const prev = previous.find((p) => p.version && ok(p.version));
    if (prev) return pick(prev.path, prev.version!, "previous", "the Node the previous service used");
    const hit = search().find((c) => c.version && ok(c.version));
    if (hit) {
      const bar =
        ok === meetsRecommended
          ? `has Node's October 2026 security release (${recommendedNodeText()})`
          : ok === meetsCodeFloor
            ? "meets the code-extension floor"
            : `meets xaq's minimum (${MIN_NODE})`;
      const mine = installer ? `the Node running this install is ${installer.version}` : "the Node running this install is a per-shell fnm link";
      return pick(hit.path, hit.version!, "found", `found at ${hit.path} (${hit.where}), the newest one that ${bar}; ${mine}`);
    }
  }

  search();
  throw new ServiceNodeError(
    [
      `No Node.js on this machine can run ${code ? "your code extensions" : "xaq"}, so the service was not installed. Nothing was changed.`,
      need,
      "Found:",
      ...seen.map((l) => l.slice(2)),
      ...nodeFixLines(input.rerun),
    ].join("\n  "),
  );
}

/**
 * What's wrong with the Node an installed service runs (for `service status`), or null. `version` null: it doesn't run.
 */
export function serviceNodeProblem(path: string, version: string | null, codeExtensions: string[], rerun: string): string | null {
  const code = codeExtensions.length > 0;
  if (version && meetsGeneral(version) && (!code || meetsCodeFloor(version))) return null;
  const what = version === null ? "doesn't run as Node.js" : `is Node.js ${version}`;
  const need = !version || !meetsGeneral(version) ? `xaq needs Node.js ${MIN_NODE} or newer${code ? `, and code extensions (${codeExtensions.join(", ")}) ${codeFloorText()}` : ""}.` : `Code extensions (${codeExtensions.join(", ")}) need Node.js ${codeFloorText()}.`;
  return [`The service runs ${path}, which ${what}. ${need}`, ...nodeFixLines(rerun)].join("\n  ");
}
