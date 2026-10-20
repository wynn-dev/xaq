// Whether an agent may read an account's Google Drive (attachments by drive_file_id). The account's Drive scope
// isn't enough on its own, or any agent with mail access could mail out any Drive file: the agent also needs a
// grant (any level: read, ask or full) on a google-workspace connection bound to that same Google account.

import type { AppContext } from "../context.ts";
import { bool } from "../db/index.ts";
import { GOOGLE_WORKSPACE_EXTENSION, workspaceConnectionAccount } from "./workspace-binding.ts";

/**
 * True when `agentId` (enabled) has a grant on an enabled google-workspace connection bound to `accountId`, with
 * the broker's connections switched on (Settings.brokerUpstreams; off, connection grants give nothing).
 */
export function agentCanReadDrive(ctx: Pick<AppContext, "db" | "settings">, agentId: string, accountId: string): boolean {
  if (!ctx.settings.get().brokerUpstreams) return false;
  const rows = ctx.db.all<{ connection_id: string; disabled: number }>(
    `SELECT g.connection_id, a.disabled FROM connection_grants g
       JOIN connections c ON c.id = g.connection_id JOIN agents a ON a.id = g.agent_id
     WHERE g.agent_id = ? AND c.preset = ? AND c.status <> 'disabled' AND g.level IN ('read', 'ask', 'full')`,
    agentId,
    GOOGLE_WORKSPACE_EXTENSION,
  );
  return rows.some((r) => !bool(r.disabled) && workspaceConnectionAccount(ctx.db, r.connection_id) === accountId);
}

/** The refusal when it doesn't. */
export const driveNotGrantedMessage = (accountEmail: string): string =>
  `This agent has no access to Google Drive for ${accountEmail}: grant it the Google Workspace connection.`;
