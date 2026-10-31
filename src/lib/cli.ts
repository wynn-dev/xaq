// Everything the console tells people to paste into a terminal: the npm package name, the
// `connect` / `listen` commands and per-tool recipes. Mirrors server/listen/recipes.ts (agent side).

// Relative (not @shared): the setup-logic unit tests type-check this file under the server config.
import { AGENT_TOOLS, type AgentTool } from "../../shared/agent-api.ts";
import { NPM_PACKAGE } from "../../shared/types.ts";

export const NPX = `npx ${NPM_PACKAGE}`;

export const TOOLS: readonly AgentTool[] = AGENT_TOOLS;

export const TOOL_LABEL: Record<AgentTool, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  hermes: "Hermes",
  other: "Other",
};

export interface Recipe {
  /** What the CLI's own recipe (`listen --recipe <tool>`) does and doesn't confine. */
  note: string;
}

const OWN_SCRIPT = "The built-in recipe is Claude Code's: start this agent from your own script with --exec. It gets the event as JSON on stdin; give listener agents draft-only access.";

/**
 * The console never spells out the Claude Code command itself: it uses `listen --recipe claude-code`, so the
 * confined command (and this machine's paths) always come from the CLI that runs it. The trigger is an email
 * anyone can send, so confinement matters.
 */
export const RECIPES: Record<AgentTool, Recipe> = {
  "claude-code": {
    note: "Claude triages each email with its built-in tools turned off, only the xaq MCP server loaded and project settings ignored. Its reply is only logged on that machine: it can't notify you by itself.",
  },
  codex: { note: OWN_SCRIPT },
  cursor: { note: OWN_SCRIPT },
  hermes: { note: OWN_SCRIPT },
  other: {
    note: "Your command gets the event as JSON on stdin (also in $XAQ_EVENT_FILE). Exit 0 when done; anything else is retried.",
  },
};

/** Single-quotes a string for POSIX shells. */
export const shellQuote = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`);

// ───────────── Transport rule ─────────────

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

export type Transport = "https" | "loopback" | "tailscale" | "insecure" | "invalid";

/**
 * Same rule as the CLI (server/listen/transport.ts): the agent's key crosses the network on every
 * request, so plain http is only fine to loopback or over Tailscale (100.64.0.0/10, *.ts.net).
 * The CLI refuses anything else unless --insecure is passed.
 */
export function transportOf(publicUrl: string): Transport {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return "invalid";
  }
  if (url.protocol === "https:") return "https";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return "loopback";
  const v4 = ipv4(host);
  if (v4 && v4[0] === 127) return "loopback";
  if (v4 && v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127) return "tailscale";
  if (host.endsWith(".ts.net")) return "tailscale";
  // Tailscale's IPv6 range fd7a:115c:a1e0::/48 (URL hosts are normalized to lowercase, compressed form).
  if (/^fd7a:115c:a1e0:/.test(host)) return "tailscale";
  return "insecure";
}

// ───────────── Commands ─────────────

export interface ConnectCommands {
  /** `connect <url> --tool <tool>` (Claude Code: `--setup-mcp`, the MCP setup in the tool). */
  connect: string;
  /** Claude Code only: register the MCP server again (after connect without --setup-mcp, or a reinstall). */
  setupMcp: string | null;
  /** How to see that the tool has the server, when it has a command for that. */
  mcpCheck: string | null;
  /** Install the xaq skill for this tool. */
  skillInstall: string;
  /** Try the listener in the foreground first (Ctrl-C stops it). */
  listenTry: string;
  /** Then keep it running in the background (systemd / launchd; saves the flags). */
  listenService: string;
  /** Prompt for an agent that sets itself up from the skill. */
  selfSetup: string;
  insecure: boolean;
}

/** A listener command that only acknowledges events: proves delivery without starting anything. */
export const LISTEN_TEST_EXEC = "cat > /dev/null";

// "other" installs into ./skills.
const SKILL_TARGET: Record<AgentTool, string> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "agents",
  hermes: "~/.hermes/skills/email",
  other: "./skills",
};


/**
 * Commands for one tool, in the order `connect` itself prints them (server/listen/connect.ts).
 * `acceptInsecure`: the human explicitly accepted plain http; only then is --insecure added.
 */
export function connectCommands(publicUrl: string, tool: AgentTool, acceptInsecure = false): ConnectCommands {
  const insecure = transportOf(publicUrl) === "insecure";
  const flag = insecure && acceptInsecure ? " --insecure" : "";
  const url = shellQuote(publicUrl);
  // Claude Code names the CLI's built-in recipe (never `--exec "$(npx … )"`: inside `$(…)` npx's "Ok to proceed?"
  // install prompt is captured, so the terminal looks idle and the prompt text becomes the command).
  const claude = tool === "claude-code";
  // Claude Code's web fetch refuses localhost, so point loopback setups at curl.
  const fetchSkill = transportOf(publicUrl) === "loopback" ? `Run curl -s ${publicUrl}/skill.md and follow it` : `Read ${publicUrl}/skill.md and follow it`;
  return {
    connect: `${NPX} connect ${url} --tool ${tool}${claude ? " --setup-mcp" : ""}${flag}`,
    setupMcp: claude ? `${NPX} setup-mcp` : null,
    mcpCheck: claude ? "claude mcp list" : null,
    skillInstall: `${NPX} skill install --target ${SKILL_TARGET[tool]} --url ${url}`,
    listenTry: claude ? `${NPX} listen --recipe claude-code` : `${NPX} listen --exec ${shellQuote(LISTEN_TEST_EXEC)}`,
    listenService: `${NPX} listen service install ${claude ? "--recipe claude-code" : "--exec /path/to/handle-email.sh"}`,
    selfSetup: `${fetchSkill} to set yourself up with xaq.`,
    insecure,
  };
}
