import pc from "picocolors";
import type { AccessLevel } from "../broker/types.ts";
import type { ConnectionsApi } from "./api.ts";
import type { Prompter } from "./prompt.ts";
import { safeText } from "../listen/ui.ts";

/** The one access question (docs/MCP-BROKER.md "Access") and which agents get it. */

export const ACCESS_LEVELS: { value: AccessLevel; label: string; short: string }[] = [
  { value: "full", label: "Full access: every tool", short: "Full access" },
  { value: "read", label: "Read only: only tools that read; the rest aren't listed", short: "Read only" },
];

export const accessLabel = (level: AccessLevel) => ACCESS_LEVELS.find((l) => l.value === level)?.short ?? level;

export function parseAccess(value: string): AccessLevel {
  const v = value.trim().toLowerCase();
  const map: Record<string, AccessLevel> = { full: "full", read: "read", "read-only": "read", readonly: "read" };
  if (!map[v]) throw new Error(`Unknown --access "${value}". Use full or read.`);
  return map[v];
}

export async function chooseAccess(p: Prompter, flag: AccessLevel | undefined): Promise<AccessLevel> {
  if (flag) return flag;
  return p.choose(
    "What can agents do with it?",
    ACCESS_LEVELS.map((l) => ({ value: l.value, label: l.label })),
    "full",
  );
}

/** Agent ids, or "all". `--agent` takes names or ids. */
export async function chooseAgents(p: Prompter, api: ConnectionsApi, flags: string[] | undefined): Promise<string[] | "all"> {
  const agents = (await api.agents()).filter((a) => !a.disabled);
  if (flags?.length) {
    if (flags.length === 1 && flags[0] === "all") return "all";
    return flags.map((f) => {
      const hit = agents.find((a) => a.id === f || a.name.toLowerCase() === f.toLowerCase());
      if (!hit) throw new Error(`No agent "${f}". Agents: ${agents.map((a) => a.name).join(", ") || "none yet"}.`);
      return hit.id;
    });
  }
  if (agents.length <= 1 || p.assumeYes || !p.interactive) return "all";
  const all = await p.confirm(`Give it to all ${agents.length} agents (${agents.map((a) => safeText(a.name, 40)).join(", ")})?`, true);
  if (all) return "all";
  const picked: string[] = [];
  for (const a of agents) if (await p.confirm(`  ${safeText(a.name, 60)}?`, false)) picked.push(a.id);
  if (!picked.length) p.print(pc.yellow("No agent gets it for now: give access on an agent's page in the console."));
  return picked;
}

export const agentsLabel = (agents: string[] | "all") => (agents === "all" ? "all agents" : `${agents.length} agent${agents.length === 1 ? "" : "s"}`);
