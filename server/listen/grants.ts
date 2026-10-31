import type { AgentSelf } from "../../shared/agent-api.ts";
import { safeText } from "./ui.ts";

type Grant = AgentSelf["grants"][number];

/** A grant in plain words, e.g. "ops@acme.dev: full access (mail and calendar); only to *@acme.dev". */
export function describeGrant(g: Grant): string {
  const parts = [g.level === "full" ? "full access (mail and calendar)" : "read only (mail and calendar)"];
  if (g.level === "full" && g.allowTo.length) {
    const shown = g.allowTo.slice(0, 3).map((a) => safeText(a, 80));
    parts.push(`only to ${shown.join(", ")}${g.allowTo.length > 3 ? ` and ${g.allowTo.length - 3} more` : ""}`);
  }
  return `${safeText(g.accountEmail || g.accountId, 120)}: ${parts.join("; ")}`;
}

type ConnectionAccess = NonNullable<AgentSelf["connections"]>[number];

const LEVEL_WORDS: Record<ConnectionAccess["level"], string> = {
  full: "full access",
  read: "read only",
};

/** A connection grant in plain words, e.g. "Notion (notion__… tools): read only". */
export const describeConnection = (c: ConnectionAccess): string =>
  `${safeText(c.name, 80)} (${safeText(c.slug, 24)}__… tools): ${LEVEL_WORDS[c.level] ?? safeText(String(c.level), 20)}`;

/** One line per mailbox grant and per connection, or a hint when there are none. */
export function describeGrants(grants: Grant[], connections: ConnectionAccess[] = []): string[] {
  if (!grants.length && !connections.length) return ["no mailbox or calendar access yet: add a grant for this agent in the console (Agents page)"];
  return [...grants.map(describeGrant), ...connections.map(describeConnection)];
}

/** Whether there's anything to describe (else describeGrants' single line is the "nothing yet" hint). */
export const hasAccess = (self: Pick<AgentSelf, "grants" | "connections">) => self.grants.length > 0 || (self.connections?.length ?? 0) > 0;

/** Stable key for "did the grants change?" (order-independent; connections too). */
export const grantsKey = (grants: Grant[], connections: ConnectionAccess[] = []) =>
  JSON.stringify(connections.length ? [grantsList(grants), connections.map((c) => [c.slug, c.level]).sort()] : grantsList(grants));

const grantsList = (grants: Grant[]) =>
  (
    grants
      .map((g) => [g.accountId, g.level, [...g.allowTo].sort()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  );
