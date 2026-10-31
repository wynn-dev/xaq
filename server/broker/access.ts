// Connection grants as the events side sees them.
// Plain reads of connection_grants, so policy, events and the listener stream can ask without the broker service.

import type { AccessLevel } from "../../shared/types.ts";
import { bool, type Db } from "../db/index.ts";

export interface ConnectionGrantRef {
  connectionId: string;
  slug: string;
  name: string;
  level: AccessLevel;
}

/** The agent's connection grants (any level), with the connection's slug and name; [] for a disabled agent. */
export function connectionGrantsOf(db: Db, agentId: string): ConnectionGrantRef[] {
  return db
    .all<{ connection_id: string; slug: string; name: string; level: AccessLevel; disabled: number }>(
      `SELECT g.connection_id, c.slug, c.name, g.level, a.disabled FROM connection_grants g
         JOIN connections c ON c.id = g.connection_id JOIN agents a ON a.id = g.agent_id
       WHERE g.agent_id = ? ORDER BY c.slug`,
      agentId,
    )
    .filter((r) => !bool(r.disabled))
    .map((r) => ({ connectionId: r.connection_id, slug: r.slug, name: r.name, level: r.level }));
}

/** Connection events are visible to an enabled agent with a grant on the connection. */
export function canSeeConnection(db: Db, agentId: string, connectionId: string): boolean {
  const r = db.get<{ disabled: number }>(
    "SELECT a.disabled FROM connection_grants g JOIN agents a ON a.id = g.agent_id WHERE g.agent_id = ? AND g.connection_id = ?",
    agentId,
    connectionId,
  );
  return !!r && !bool(r.disabled);
}

/** Connection ids whose events the agent may see. */
export function visibleConnectionIds(db: Db, agentId: string): string[] {
  return db.all<{ connection_id: string }>("SELECT connection_id FROM connection_grants WHERE agent_id = ?", agentId).map((r) => r.connection_id);
}
