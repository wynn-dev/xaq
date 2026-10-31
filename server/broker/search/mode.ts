// When /mcp serves search mode instead of every tool (docs/MCP-BROKER.md, "One endpoint with 100+ tools").
import { type Db, json } from "../../db/index.ts";
import type { SettingsStore } from "../../settings.ts";

/** Above this many visible tools (native + broker), an agent gets search mode unless its setting says otherwise. */
export const SEARCH_MODE_THRESHOLD = 30;

/** Hot tools stay directly exposed in search mode: at most this many. */
export const MAX_HOT_TOOLS = 5;

/** Configured hot tools when an agent's setting names none. */
export const DEFAULT_HOT_TOOLS: readonly string[] = [];

export type ToolMode = "direct" | "search";

/**
 * The per-agent choice: `search` and `direct` force it (`?mode=search` still wins). `auto` means not decided yet: the
 * agent's first /mcp request resolves it by the threshold and records the result (exposeTools), so it sticks.
 */
export type AgentSearchPreference = "auto" | "search" | "direct";

export interface AgentSearchSettings {
  mode: AgentSearchPreference;
  /** Extra tools exposed directly in search mode (exposed names). */
  hot: string[];
}

const PREFERENCES: readonly AgentSearchPreference[] = ["auto", "search", "direct"];
const key = (agentId: string) => `broker.search:${agentId}`;

/** The agent's search-mode setting, kept in the settings table (no migration). */
export function agentSearchSettings(db: Db, agentId: string): AgentSearchSettings {
  const row = db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key(agentId));
  const v = json.parse<Partial<AgentSearchSettings>>(row?.value, {});
  return {
    mode: PREFERENCES.includes(v.mode as AgentSearchPreference) ? (v.mode as AgentSearchPreference) : "auto",
    hot: Array.isArray(v.hot) ? v.hot.filter((x): x is string => typeof x === "string").slice(0, MAX_HOT_TOOLS) : [...DEFAULT_HOT_TOOLS],
  };
}

export function setAgentSearchSettings(db: Db, agentId: string, patch: Partial<AgentSearchSettings>): AgentSearchSettings {
  const next = { ...agentSearchSettings(db, agentId), ...patch };
  if (!PREFERENCES.includes(next.mode)) throw new Error(`Unknown search mode ${String(next.mode)}`);
  next.hot = [...new Set(next.hot)].slice(0, MAX_HOT_TOOLS);
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key(agentId),
    JSON.stringify(next),
  );
  return next;
}

/**
 * Once per install, at startup: every agent without a setting gets `direct`, so an upgrade never takes its tools
 * out of tools/list (scripts and prompts that expect them listed keep working); search mode is opt-in for them.
 * Agents created later have no setting and follow `auto`. Explicit settings are kept; a new install pins nobody.
 * Returns how many agents were pinned (0 once the marker is set).
 */
export function pinExistingAgentsDirect(db: Db, settings: SettingsStore): number {
  if (settings.getState("broker.searchDirectPinned")) return 0;
  return db.tx(() => {
    const ids = db
      .all<{ id: string }>("SELECT id FROM agents WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'broker.search:' || agents.id)")
      .map((r) => r.id);
    for (const id of ids) setAgentSearchSettings(db, id, { mode: "direct" });
    settings.setState("broker.searchDirectPinned", new Date().toISOString());
    return ids.length;
  });
}

export interface ModeInput {
  /** `?mode=` on /mcp. */
  query: string | undefined;
  preference: AgentSearchPreference;
  /** Native tools this agent can use (registered TOOL_NAMES). */
  nativeCount: number;
  /** ToolRegistry.forAgent(agentId).length. */
  brokerCount: number;
}

export function chooseMode(m: ModeInput): ToolMode {
  if (m.query === "search") return "search";
  if (m.preference === "search") return "search";
  if (m.preference === "direct") return "direct";
  return m.nativeCount + m.brokerCount > SEARCH_MODE_THRESHOLD ? "search" : "direct";
}

/** Directly exposed tools in search mode: the configured ones. */
export function hotToolNames(configured: readonly string[]): string[] {
  return [...new Set(configured)].slice(0, MAX_HOT_TOOLS);
}
