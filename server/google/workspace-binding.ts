// Which Google account a Google Workspace connection is bound to. Writer C owns this binding (Google scope opt-in
// and the extension's auth in core, branch feat/google-extension-auth); this file is the one place that reads it.

import type { Db } from "../db/index.ts";

/** The extension (connections.preset) whose connections give agents Google Workspace, Drive included. */
export const GOOGLE_WORKSPACE_EXTENSION = "google-workspace";

/**
 * The xaq Google account id (acc_…) the google-workspace connection `connectionId` is bound to, or null when it
 * isn't bound (or the binding can't be read).
 *
 * TODO(C, feat/google-extension-auth): read C's binding here. C stores the account id on the connection or on its
 * credential; that shape wasn't visible when this was written, so until C's branch merges no connection counts as
 * bound and agentCanReadDrive is always false (attaching by drive_file_id is refused for every agent: fail closed).
 * Replace the body with the lookup, e.g. `SELECT google_account_id FROM connections WHERE id = ? AND preset = ?`.
 */
export function workspaceConnectionAccount(db: Db, connectionId: string): string | null {
  void db;
  void connectionId;
  return null;
}
