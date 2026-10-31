// Everything the console tells people to paste into a terminal: the npm package name, the
// `connect` / `listen` commands and per-tool recipes. Mirrors server/listen/recipes.ts (agent side).

// Relative (not @shared): the setup-logic unit tests type-check this file under the server config.
import { AGENT_TOOLS, type AgentTool } from "../../shared/agent-api.ts";

/** The npm package; the command it installs is `xaq`. Swap for NPM_PACKAGE from @shared/types once it exists. */
export const NPM_PACKAGE = "xaq-cli";
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

/**
 * The console never spells out `listen --exec` commands itself: for known tools it uses
 * `listen --recipe <tool>`, so the confined command (and this machine's paths) always come
 * from the CLI that runs it. The trigger is an email anyone can send, so confinement matters.
 */
export const RECIPES: Record<AgentTool, Recipe> = {
  "claude-code": {
    note: "Claude triages each email with its built-in tools turned off, only the xaq MCP server loaded and project settings ignored. Its reply is only logged on that machine: it can't notify you by itself.",
  },
  codex: {
    note: "Codex triages each email in a read-only sandbox with its shell tool off. Other MCP servers you configured stay available, so give listener agents draft-only access. Its reply is only logged.",
  },
  cursor: {
    note: "Cursor's CLI can't be confined by flags: deny other tools in its permissions config (see docs/listen.md) and give listener agents draft-only access. Its reply is only logged.",
  },
  hermes: {
    note: "Each email goes to your running Hermes gateway, which triages it with only the xaq tools and tells you where the route says (Telegram, Discord…) only when it matters.",
  },
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
  /** `connect <url> --tool <tool> --setup-mcp`: pairing, then the MCP setup in the tool. */
  connect: string;
  /** Register the MCP server in the tool again (after connect without --setup-mcp, or a reinstall). */
  setupMcp: string;
  /** How to see that the tool has the server, when it has a command for that. */
  mcpCheck: string | null;
  /** Install the xaq skill for this tool. */
  skillInstall: string;
  /** Try the listener in the foreground first (Ctrl-C stops it). `--save` keeps the command for the service. */
  listenTry: string;
  /** Then keep it running in the background (systemd / launchd). */
  listenService: string;
  /** Hermes only: create the gateway route the listener forwards to (before trying the listener). */
  hermesRoute: string | null;
  /** Prompt for an agent that sets itself up from the skill. */
  selfSetup: string;
  insecure: boolean;
}

/** A listener command that only acknowledges events: proves delivery without starting anything. */
export const LISTEN_TEST_EXEC = "cat > /dev/null";

// "other" installs into ./skills rather than `skill print > SKILL.md`: a redirect would capture npx's install prompt.
const SKILL_TARGET: Record<AgentTool, string> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "agents",
  hermes: "~/.hermes/skills/email",
  other: "./skills",
};

const MCP_CHECK: Partial<Record<AgentTool, string>> = {
  "claude-code": "claude mcp list",
  codex: "codex mcp list",
  hermes: "hermes mcp test xaq",
};

/**
 * Commands for one tool, in the order `connect` itself prints them (server/listen/connect.ts).
 * `acceptInsecure`: the human explicitly accepted plain http; only then is --insecure added.
 */
export function connectCommands(publicUrl: string, tool: AgentTool, acceptInsecure = false): ConnectCommands {
  const insecure = transportOf(publicUrl) === "insecure";
  const flag = insecure && acceptInsecure ? " --insecure" : "";
  const url = shellQuote(publicUrl);
  // Known tools name the CLI's built-in recipe (never `--exec "$(npx … --print-recipe …)"`: inside `$(…)` npx's
  // "Ok to proceed?" install prompt is captured, so the terminal looks idle and the prompt text becomes the command).
  const target = tool === "other" ? "--exec /path/to/handle-email.sh" : `--recipe ${tool}`;
  // Claude Code's web fetch refuses localhost, so point loopback setups at curl.
  const fetchSkill = transportOf(publicUrl) === "loopback" ? `Run curl -s ${publicUrl}/skill.md and follow it` : `Read ${publicUrl}/skill.md and follow it`;
  return {
    connect: `${NPX} connect ${url} --tool ${tool}${tool === "other" ? "" : " --setup-mcp"}${flag}`,
    setupMcp: `${NPX} setup-mcp --tool ${tool}`,
    mcpCheck: MCP_CHECK[tool] ?? null,
    skillInstall: `${NPX} skill install --target ${SKILL_TARGET[tool]} --url ${url}`,
    listenTry: tool === "other" ? `${NPX} listen --exec ${shellQuote(LISTEN_TEST_EXEC)}${flag}` : `${NPX} listen --save ${target}${flag}`,
    listenService: `${NPX} listen service install ${target}${flag}`,
    hermesRoute: tool === "hermes" ? `${NPX} listen hermes --deliver telegram --run` : null,
    selfSetup: `${fetchSkill} to set yourself up with xaq.`,
    insecure,
  };
}
