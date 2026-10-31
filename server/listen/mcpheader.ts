import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertOurs, writePrivateFile } from "./fsutil.ts";
import { profileBrand } from "./names.ts";
import { configDir, profilePath, validProfileName } from "./paths.ts";
import { loadProfile } from "./profile.ts";

/**
 * Keeps the API key out of argv and out of agent config files: Claude Code's `headersHelper` runs a
 * command at connection time and uses the JSON it prints as request headers. The helper is a tiny
 * dependency-free script next to the profiles (stable, unlike the npx cache) that reads the key from
 * the 0600 profile and prints `{"Authorization":"Bearer …"}` to Claude Code's pipe, never a terminal.
 */

export const helperScriptPath = () => join(configDir(), "bin", "mcp-header.mjs");
/** The MCP config the Claude Code recipe loads with --strict-mcp-config (no key inside). */
export const claudeMcpConfigPath = (profile: string) => join(configDir(), "mcp", `${validProfileName(profile)}.claude.json`);

/** POSIX single-quoting for the shell Claude Code runs the helper in. */
const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

export function helperScript(profilesDir: string): string {
  return `#!/usr/bin/env node
// xaq MCP header helper (written by \`xaq connect\` / \`setup-mcp\`). Prints the
// Authorization header for one xaq profile as JSON for Claude Code's headersHelper.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const name = process.argv[2] || "default";
if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) { console.error("invalid profile name"); process.exit(2); }
if (process.stdout.isTTY) { console.error("This prints a secret header; it is meant to be piped to an MCP client."); process.exit(2); }
const profile = JSON.parse(readFileSync(join(${JSON.stringify(profilesDir)}, name + ".json"), "utf8"));
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

/**
 * The node to record for Claude Code's header helper: the one running this command. A version manager's node
 * (fnm, nvm, Volta, asdf, mise, n, a Homebrew Cellar keg) disappears on upgrade, which the note says.
 */
export function helperNode(execPath = process.execPath): NodeChoice {
  return { path: execPath, versioned: VERSIONED_NODE.test(execPath) };
}

export interface ServiceNodeChoice extends NodeChoice {
  version: string;
  /** Why this node, in words (printed by `listen service install`). */
  why: string;
}

/** The node the listener service runs on: the one running `listen service install`. */
export function serviceNode(execPath = process.execPath, current = process.versions.node): ServiceNodeChoice {
  const choice = helperNode(execPath);
  return {
    ...choice,
    version: current,
    why: choice.versioned ? "this shell's node; its path belongs to one Node version, so re-run install after upgrading or removing it" : "this shell's node",
  };
}

let chosenNode: NodeChoice | undefined;
/** helperNode() for this process, computed once (it may run a candidate's --version). */
export const helperNodeChoice = (): NodeChoice => (chosenNode ??= helperNode());

/** The shell command Claude Code runs as headersHelper (nothing is written). */
export const headerHelperCommand = (profile: string) => `${sq(helperNodeChoice().path)} ${sq(helperScriptPath())} ${validProfileName(profile)}`;

/** The note setup-mcp prints about the recorded node (like `listen service install`'s Node.js line). */
export function helperNodeNote(profile: string, rerun: string): string {
  const { path, versioned } = helperNodeChoice();
  const v = path === process.execPath ? ` (v${process.versions.node})` : "";
  return versioned
    ? `Node.js: Claude Code runs the header helper with ${path}${v}. That path belongs to one Node version: if you upgrade or remove it, run \`${rerun}\` again.`
    : `Node.js: Claude Code runs the header helper with ${path}${v}; if you remove it, run \`${rerun}\` again.`;
}

/** Writes (or refreshes) the helper script, 0700. Returns the shell command for headersHelper. */
export function installHeaderHelper(profile: string): string {
  const command = headerHelperCommand(profile);
  // Ours: written by connect / setup-mcp (named agentinbox in helpers from before the rename). bin/ may sit in a
  // directory another program called xaq owns, so an existing bin/ keeps its mode.
  assertOurs(helperScriptPath(), (p) => /^#!\/usr\/bin\/env node\n\/\/ (?:xaq|agentinbox) MCP header helper/.test(readFileSync(p, "utf8")), "MCP header helper");
  writePrivateFile(helperScriptPath(), helperScript(join(configDir(), "profiles")), { privateDir: "new" });
  // writePrivateFile leaves 0600; the script itself is run through node, so it needn't be executable.
  return command;
}

/** Claude Code MCP server entry: URL plus the helper, no secret. `install: false` (dry runs) doesn't write the helper. */
export function claudeServerEntry(url: string, profile: string, opts: { install?: boolean } = {}): { type: "http"; url: string; headersHelper: string } {
  return { type: "http", url, headersHelper: opts.install === false ? headerHelperCommand(profile) : installHeaderHelper(profile) };
}

/** One of our keyless MCP configs: a single server whose headers come from our header helper. */
function isOurClaudeMcpConfig(path: string): boolean {
  const servers = (JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, { headersHelper?: unknown }> }).mcpServers ?? {};
  const entries = Object.values(servers);
  return entries.length === 1 && typeof entries[0]?.headersHelper === "string" && entries[0].headersHelper.includes("mcp-header.mjs");
}

/** Writes the per-profile MCP config the Claude Code listener recipe uses. Returns its path. */
export function writeClaudeMcpConfig(profile: string, url: string): string {
  const path = claudeMcpConfigPath(profile);
  // The recipe allows exactly `mcp__<brand>`, so the server is always named that in this file: xaq, or
  // agentinbox for a profile from before the rename, whose saved recipe allows `mcp__agentinbox`.
  assertOurs(path, isOurClaudeMcpConfig, "Claude Code MCP config");
  writePrivateFile(path, JSON.stringify({ mcpServers: { [profileBrand(profile)]: claudeServerEntry(url, profile) } }, null, 2) + "\n", { privateDir: "new" });
  return path;
}

/** `xaq mcp-header`: the header JSON for MCP clients that run a helper. Refuses to print to a terminal. */
export function printMcpHeader(profile: string): number {
  const name = validProfileName(profile);
  if (process.stdout.isTTY) {
    process.stderr.write(`This prints the agent's secret Authorization header; pipe it into the tool that needs it (profile file: ${profilePath(name)}).\n`);
    return 2;
  }
  const p = loadProfile(name);
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${p.apiKey}` }));
  return 0;
}
