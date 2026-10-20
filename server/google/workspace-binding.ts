// Which Google account a Google Workspace connection is bound to: connections.google_account_id (migration 12),
// set by the extension's Google setup (server/extensions/google-auth.ts) and cleared when the account is removed.

import type { Db } from "../db/index.ts";

/** The extension (connections.preset) whose connections give agents Google Workspace, Drive included. */
export const GOOGLE_WORKSPACE_EXTENSION = "google-workspace";

/**
 * The xaq Google account id (acc_…) the google-workspace connection `connectionId` is bound to, or null when it
 * isn't a google-workspace connection or isn't bound (no account picked yet, or the account was removed).
 */
export function workspaceConnectionAccount(db: Db, connectionId: string): string | null {
  const row = db.get<{ google_account_id: string | null }>(
    "SELECT google_account_id FROM connections WHERE id = ? AND preset = ?",
    connectionId,
    GOOGLE_WORKSPACE_EXTENSION,
  );
  return row?.google_account_id ?? null;
}
