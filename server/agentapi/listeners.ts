import { type EventType, isEventType, type ListenerInfo } from "../../shared/types.ts";
import { bool, type Db, json } from "../db/index.ts";
import { mcpToolCallSql } from "../audit.ts";
import { visibleConnectionIds } from "../broker/access.ts";
import type { AppContext } from "../context.ts";
import { EVENT_SELECT, type EventRow, toStoredEvent } from "../events/repo.ts";
import { badRequest, HttpError } from "../util/errors.ts";

const CONSUMER_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** Capabilities that put events in an agent's feed: mail `read` for mail events, `calendar.read` for calendar ones. */
export const readsEvents = (capabilities: readonly string[]): boolean => capabilities.includes("read") || capabilities.includes("calendar.read");

export type RevokeReason = "agent_deleted" | "agent_disabled" | "key_rotated" | "no_read_grant";

/**
 * Why a live stream must end, or null while the key, agent and a read grant (mail or calendar) are all still valid.
 * Any connection grant counts as a read grant too: an agent with connections and no Gmail can listen for its connection events.
 */
export function accessProblem(db: Db, agentId: string, keyHash: string): RevokeReason | null {
  const a = db.get<{ key_hash: string; disabled: number }>("SELECT key_hash, disabled FROM agents WHERE id = ?", agentId);
  if (!a) return "agent_deleted";
  if (a.key_hash !== keyHash) return "key_rotated";
  if (bool(a.disabled)) return "agent_disabled";
  const grants = db.all<{ capabilities: string }>("SELECT capabilities FROM grants WHERE agent_id = ?", agentId);
  if (grants.some((g) => readsEvents(json.parse<string[]>(g.capabilities, [])))) return null;
  if (visibleConnectionIds(db, agentId).length) return null;
  return "no_read_grant";
}

/** `ListenerInfo[]` for an agent, from listener_cursors. */
export function listenersOf(db: Db, agentId: string): ListenerInfo[] {
  return db
    .all<{ consumer: string; acked_seq: number; start_seq: number | null; client: string; connected: number; last_seen_at: string | null }>(
      "SELECT consumer, acked_seq, start_seq, client, connected, last_seen_at FROM listener_cursors WHERE agent_id = ? ORDER BY consumer",
      agentId,
    )
    .map((r) => {
      // The stream's types live in the `client` JSON next to the client info (see streamEvents).
      const { types, ...client } = json.parse<ListenerInfo["client"] & { types?: unknown }>(r.client, {});
      return {
        consumer: r.consumer,
        connected: r.connected > 0,
        startSeq: r.start_seq,
        ackedSeq: r.acked_seq,
        types: listenerTypes(types),
        lastSeenAt: r.last_seen_at,
        client,
      };
    });
}

/**
 * The stored types list, or null when every type counts ("all": the stream named none) or the types
 * are unknown (missing on cursors from before they were recorded, or malformed).
 */
function listenerTypes(raw: unknown): EventType[] | null {
  if (!Array.isArray(raw)) return null;
  const types = raw.filter((t): t is EventType => typeof t === "string" && isEventType(t));
  return types.length ? types : null;
}

/**
 * Consumer names ending in these are the CLI's throwaway cursors (`listen --backfill` replays on
 * `<consumer>-replay`, `listen --dry-run` peeks on `<consumer>-dry-run`). They are never acknowledged
 * and always start at 0, so a backfill can't attach to a cursor that has moved and skip mail.
 */
export const THROWAWAY_SUFFIXES = ["-replay", "-dry-run"] as const;
export const isThrowawayConsumer = (consumer: string) => THROWAWAY_SUFFIXES.some((s) => consumer.endsWith(s));

/** `throwaway: false` (acks): names with a reserved suffix are refused. */
export function parseConsumer(raw: unknown, opts: { throwaway?: boolean } = {}): string {
  const consumer = raw === undefined || raw === "" ? "default" : String(raw);
  if (!CONSUMER_RE.test(consumer)) throw badRequest("consumer must be 1-100 letters, digits, dots, underscores or dashes");
  if (opts.throwaway === false && isThrowawayConsumer(consumer)) {
    throw badRequest(
      `consumer names ending in ${THROWAWAY_SUFFIXES.join(" or ")} are reserved for throwaway cursors and can't be acknowledged`,
      "Pick a consumer name without that suffix.",
    );
  }
  return consumer;
}

export const ackedSeq = (db: Db, agentId: string, consumer: string): number =>
  db.get<{ acked_seq: number }>("SELECT acked_seq FROM listener_cursors WHERE agent_id = ? AND consumer = ?", agentId, consumer)?.acked_seq ?? 0;

/** Rows examined when looking for the newest event an agent can see. */
const VISIBLE_SCAN_MAX = 2000;

/**
 * Cursor cap: the newest event seq in the accounts this agent can read mail or calendars of (one indexed lookup per
 * account, no label check). Capping acks, `after` and Last-Event-ID there means a client can't skip
 * future events by acking ahead, and only learns seqs of accounts it already reads. Anything between
 * the newest visible event and this cap is invisible to the agent, so a new consumer starts here too.
 */
export function newestGrantedSeq(ctx: AppContext, agentId: string): number {
  let max = 0;
  for (const g of ctx.policy.grants(agentId)) {
    if (!readsEvents(g.capabilities)) continue;
    const r = ctx.db.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM events WHERE account_id = ? AND seq > 0", g.accountId);
    max = Math.max(max, r?.m ?? 0);
  }
  // Connection events (events.connection_id) of the connections it has a grant on.
  for (const id of visibleConnectionIds(ctx.db, agentId)) {
    const r = ctx.db.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM events WHERE connection_id = ? AND seq > 0", id);
    max = Math.max(max, r?.m ?? 0);
  }
  return max;
}

/**
 * The newest event seq this agent may actually see (label scope included), or 0 if none: reported
 * as /me `headSeq`. When the scan budget runs out (narrow scope on a busy mailbox), the newest
 * granted seq stands in: everything scanned was invisible, so nothing visible lies above it.
 */
export function newestVisibleSeq(ctx: AppContext, agentId: string): number {
  const accounts = ctx.policy
    .grants(agentId)
    .filter((g) => readsEvents(g.capabilities))
    .map((g) => g.accountId);
  const connections = visibleConnectionIds(ctx.db, agentId);
  if (!accounts.length && !connections.length) return 0;
  const inList = (ids: string[]) => (ids.length ? ids.map(() => "?").join(", ") : "NULL");
  const sql = `${EVENT_SELECT} WHERE e.seq > 0 AND e.seq < ? AND (e.account_id IN (${inList(accounts)}) OR e.connection_id IN (${inList(connections)})) ORDER BY e.seq DESC LIMIT 200`;
  let before = Number.MAX_SAFE_INTEGER;
  for (let scanned = 0; ; ) {
    if (scanned >= VISIBLE_SCAN_MAX) return newestGrantedSeq(ctx, agentId);
    const rows = ctx.db.all<EventRow>(sql, before, ...accounts, ...connections);
    for (const r of rows) {
      const ev = toStoredEvent(r);
      if (ctx.policy.canSeeEvent(agentId, ev)) return ev.seq;
      before = r.seq;
    }
    scanned += rows.length;
    if (rows.length < 200) break;
  }
  return 0;
}

/**
 * Makes room for a new consumer: at most `max` per agent. The longest-idle disconnected consumer is
 * dropped only if it hasn't been seen within the retention window (its cursor is stale anyway);
 * otherwise 409, so a listener that reconnects later never silently restarts at the head.
 */
export function ensureConsumerSlot(ctx: AppContext, agentId: string, consumer: string, max: number): void {
  const { db } = ctx;
  if (db.get("SELECT 1 FROM listener_cursors WHERE agent_id = ? AND consumer = ?", agentId, consumer)) return;
  const { n } = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM listener_cursors WHERE agent_id = ?", agentId)!;
  if (n < max) return;
  const staleBefore = new Date(Date.now() - ctx.settings.get().retentionDays * 86_400_000).toISOString();
  const idle = db.get<{ consumer: string }>(
    `SELECT consumer FROM listener_cursors WHERE agent_id = ? AND connected = 0 AND COALESCE(last_seen_at, updated_at) < ?
     ORDER BY COALESCE(last_seen_at, updated_at) ASC LIMIT 1`,
    agentId,
    staleBefore,
  );
  if (!idle) {
    throw new HttpError(
      409,
      "too_many_consumers",
      `This agent already has ${max} listener consumers`,
      "Reuse an existing consumer name. Unused consumers are freed once they haven't connected for the retention period.",
    );
  }
  db.run("DELETE FROM listener_cursors WHERE agent_id = ? AND consumer = ?", agentId, idle.consumer);
}

/**
 * Evidence that some agent works end to end (SetupState.verified), for old installs and browsers
 * that never ran the wizard's last step: a successful audited MCP tool call, or a listener that
 * acked an event past where its cursor started (a new consumer starts at the head, so acked_seq
 * alone isn't proof; start_seq is NULL for cursors from before migration 4 or made by an ack).
 * Merely connecting doesn't count: `claude mcp list`'s health check sets last_mcp_at with only
 * initialize/tools/list, which aren't audited. Agent audit rows are tool calls (snake_case) plus
 * dotted actions like pairing.key_delivered, which don't count. Per agent, so audit_actor is used.
 */
export function anyAgentVerified(db: Db): boolean {
  return !!db.get(
    `SELECT 1 AS ok WHERE EXISTS (
         SELECT 1 FROM agents ag WHERE EXISTS (
           SELECT 1 FROM audit_log l WHERE l.actor_id = ag.id AND ${mcpToolCallSql("l")} AND l.outcome = 'ok'))
       OR EXISTS (SELECT 1 FROM listener_cursors WHERE acked_seq > COALESCE(start_seq, 0))`,
  );
}

/** Console pushes for acks: at most one per agent per this interval (the last ack in a burst still goes out). */
const ACK_PUSH_INTERVAL_MS = 1000;

/** Moves the consumer's cursor forward only, and never past the newest event in its granted accounts. */
export function ackListener(ctx: AppContext, agentId: string, consumer: string, seq: number, maxConsumers: number): { ackedSeq: number } {
  const { db } = ctx;
  ensureConsumerSlot(ctx, agentId, consumer, maxConsumers);
  const target = Math.min(Math.max(0, Math.floor(seq)), newestGrantedSeq(ctx, agentId));
  const t = new Date().toISOString();
  db.run(
    `INSERT INTO listener_cursors (agent_id, consumer, acked_seq, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_id, consumer) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq), updated_at = excluded.updated_at`,
    agentId,
    consumer,
    target,
    t,
  );
  ctx.policy.publishAgent(agentId, ACK_PUSH_INTERVAL_MS);
  return { ackedSeq: ackedSeq(db, agentId, consumer) };
}
