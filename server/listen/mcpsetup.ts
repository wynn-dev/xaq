import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "../../shared/agent-api.ts";
import { backupFile, isTooOpen } from "./fsutil.ts";
import { claudeServerEntry, helperNodeNote, helperScriptPath } from "./mcpheader.ts";
import type { Profile } from "./profile.ts";
import { MCP_SERVER } from "./recipes.ts";
import { NPX } from "./version.ts";
import { safeText } from "./ui.ts";

/**
 * `setup-mcp` / `connect --setup-mcp`: registers the xaq MCP server in Claude Code without the key ever
 * being shown or pasted. ~/.claude.json is backed up first; the key is redacted from any output we relay.
 */

export interface McpSetupResult {
  ok: boolean;
  /** What happened, safe to print (never contains the key). */
  message: string;
  backup?: string | null;
  /** Manual steps when automatic setup isn't possible. Never contains the key. */
  manual?: string[];
  /** Exactly what was (or, in a dry run, would be) changed. Never contains the key. */
  changes?: string[];
  /** How to check it worked. */
  verify?: string[];
  /** Nothing was changed (--dry-run). */
  dryRun?: boolean;
  /** Things to know afterwards, e.g. which Node.js the setup depends on. */
  notes?: string[];
}

export interface McpSetupOptions {
  /** Print what would change; change nothing. */
  dryRun?: boolean;
}

const backupLine = (file: string) => (existsSync(file) ? `back up ${file} to ${file}.xaq-backup-<timestamp> (0600)` : `${file} doesn't exist yet: nothing to back up`);

const redact = (s: string, key: string) => s.split(key).join("aib_…(redacted)");

/**
 * Registers the xaq MCP server in Claude Code; any other tool gets the manual steps. The MCP endpoint is
 * always derived from the URL the user connected to (and transport-checked there), never taken from the
 * daemon: a daemon's advertised mcpUrl comes from its publicUrl setting, which could point the key elsewhere.
 */
export function setupMcp(tool: AgentTool, profile: Profile, profileFile: string, opts: McpSetupOptions = {}): McpSetupResult {
  const url = `${profile.url}/mcp`;
  if (tool === "claude-code") return setupClaude(url, profile.apiKey, opts);
  return { ok: false, message: "Automatic MCP setup is for Claude Code only.", manual: manualSteps(url, profileFile) };
}

export function manualSteps(url: string, profileFile: string): string[] {
  return [`MCP endpoint (streamable HTTP): ${url}`, `Header: Authorization: Bearer <key>. The key is the "apiKey" field in ${profileFile}.`];
}

export const claudeConfigFile = () => (process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json"));

function setupClaude(url: string, key: string, opts: McpSetupOptions): McpSetupResult {
  const name = MCP_SERVER;
  // headersHelper: Claude Code asks our helper for the header at connect time, so the key is never in
  // argv (visible in `ps`), in ~/.claude.json, or on screen.
  const json = JSON.stringify(claudeServerEntry(url, { install: !opts.dryRun }));
  const addCommand = `claude mcp add-json --scope user ${name} '${json.replace(/'/g, `'"'"'`)}'`;
  const manual = [addCommand];
  const file = claudeConfigFile();
  const verify = [`claude mcp list   (shows "${name}" as connected; inside Claude Code: /mcp)`];
  // The helper command names a node binary: say which, and how to recover when it goes away.
  const notes = [helperNodeNote(`${NPX} setup-mcp`)];
  const changes = [
    `write the header helper ${helperScriptPath()} (0600; reads the key from your profile when Claude Code connects)`,
    backupLine(file),
    `run: claude mcp remove ${name} --scope user   (drops an earlier "${name}" entry, if any)`,
    `run: ${addCommand}`,
    `the key stays in your xaq profile: neither the command line nor ${file} contains it`,
  ];
  if (opts.dryRun) return { ok: true, dryRun: true, message: `Dry run for Claude Code: nothing was changed. setup-mcp would:`, changes, verify, notes };
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) return { ok: false, message: "The `claude` CLI was not found on PATH.", manual };
  const backup = backupFile(file);
  // `add-json` refuses an existing name, so replace it. argv arrays only, and nothing secret in them.
  spawnSync("claude", ["mcp", "remove", name, "--scope", "user"], { stdio: "ignore" });
  const r = spawnSync("claude", ["mcp", "add-json", "--scope", "user", name, json], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    const out = redact(`${r.stderr ?? ""}${r.stdout ?? ""}`, key).trim();
    return { ok: false, message: `claude mcp add-json failed${out ? `: ${safeText(out, 300)}` : ""}`, backup, manual };
  }
  if (existsSync(file) && isTooOpen(file)) chmodSync(file, 0o600);
  return {
    ok: true,
    message: `Registered MCP server "${name}" in Claude Code (user scope). The key stays in your xaq profile; Claude Code asks for it through a header helper.`,
    backup,
    changes: [`ran: ${addCommand}`, `${file} now lists "${name}" (user scope)`],
    verify,
    notes,
  };
}
