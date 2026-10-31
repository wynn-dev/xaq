// SQL for broker policy: connection status. Tables from migration 8 (server/db/schema.ts).

import type { ConnectionStatus } from "../../../shared/types.ts";
import type { Db } from "../../db/index.ts";

export interface ConnectionInfo {
  id: string;
  slug: string;
  name: string;
  status: ConnectionStatus;
  statusReason: string | null;
  /** IntegrationPreset.id, or null for a custom server. */
  preset: string | null;
  /** When the credential stops working without a human (connections.expires_at), or null. */
  expiresAt: string | null;
}

export function connectionInfo(db: Db, id: string): ConnectionInfo | null {
  const r = db.get<{ id: string; slug: string; name: string; status: ConnectionStatus; status_reason: string | null; preset: string | null; expires_at: string | null }>(
    "SELECT id, slug, name, status, status_reason, preset, expires_at FROM connections WHERE id = ?",
    id,
  );
  return r ? { id: r.id, slug: r.slug, name: r.name, status: r.status, statusReason: r.status_reason, preset: r.preset, expiresAt: r.expires_at } : null;
}

/** Past its credential's lifetime (no refresh token, or a hard cap): only a reconnect brings it back. */
export const isExpired = (c: Pick<ConnectionInfo, "expiresAt">, at = Date.now()): boolean => {
  if (!c.expiresAt) return false;
  const t = Date.parse(c.expiresAt);
  return Number.isFinite(t) && t <= at;
};
