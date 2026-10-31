import { type EventType, isConnectionEventType, type MailEvent, type Page } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { type Db, json, now, type Param } from "../db/index.ts";
import { newId } from "../util/ids.ts";
import { deliveriesForEvent } from "../webhooks/deliveries.ts";
import { EVENT_SELECT, type EventRow, eventBySeq, toMailEvent, toStoredEvent } from "./repo.ts";
import type { EventsService, FeedOptions, FeedResult, NewEvent, StoredEvent } from "./types.ts";

const FEED_DEFAULT_LIMIT = 20;
const FEED_MAX_LIMIT = 100;
const SCAN_BATCH = 200;
/** Upper bound on rows examined per feed call, so a mostly invisible backlog can't stall a request. */
const SCAN_MAX = 5000;

export function createEventsService(ctx: AppContext): EventsService {
  const log = ctx.log.child("events");

  function emit(e: NewEvent): MailEvent | null {
    if (inTransaction(ctx.db)) throw new Error("events.emit must not be called inside a transaction: it publishes after its own commit");
    const connection = isConnectionEventType(e.type);
    if (connection ? !e.connectionId : !e.accountId) throw new Error(`events.emit: ${e.type} needs ${connection ? "connectionId" : "accountId"}`);
    const stored = ctx.db.tx((): StoredEvent | null => {
      const createdAt = now();
      const id = newId("evt");
      const message = e.message ?? null;
      const threadLabelIds = e.threadLabelIds ?? message?.labelIds ?? [];
      const calendarEvent = e.calendarEvent ?? null;
      const inserted = ctx.db.get<{ seq: number }>(
        `INSERT INTO events (id, type, account_id, gmail_message_id, gmail_thread_id, label_ids, message, changed_label_ids, detail, dedupe_key, created_at,
           calendar_id, calendar_event, connection_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(dedupe_key) DO NOTHING RETURNING seq`,
        id,
        e.type,
        // Connection events store '' (migration 8 keeps account_id NOT NULL) and their connection_id.
        connection ? "" : (e.accountId ?? ""),
        message?.id ?? null,
        message?.threadId ?? null,
        json.str(threadLabelIds),
        message ? json.str(message) : null,
        e.labelIds ? json.str(e.labelIds) : null,
        e.detail ? json.str(e.detail) : null,
        e.dedupeKey,
        createdAt,
        calendarEvent?.calendarId ?? null,
        calendarEvent ? json.str(calendarEvent) : null,
        connection ? (e.connectionId ?? null) : null,
      );
      if (!inserted) return null;
      const event = eventBySeq(ctx.db, inserted.seq)!;
      ctx.webhooks.enqueue(event);
      return event;
    });
    if (!stored) return null;
    const pub = toMailEvent(stored);
    publish(() => ctx.bus.emit("event", pub));
    for (const d of deliveriesForEvent(ctx.db, stored.seq)) publish(() => ctx.bus.emit("delivery", d));
    return pub;
  }

  /** Bus listeners must not throw, but a buggy one must not turn a committed emit into an error either. */
  function publish(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.error("Bus listener failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  function get(id: string): StoredEvent | null {
    const row = ctx.db.get<EventRow>(`${EVENT_SELECT} WHERE e.id = ? AND e.seq > 0`, id);
    return row ? toStoredEvent(row) : null;
  }

  function list(q: { accountId?: string; type?: EventType; cursor?: string | null; limit?: number }): Page<MailEvent> {
    const where = ["e.seq > 0"];
    const params: Param[] = [];
    if (q.accountId) {
      where.push("e.account_id = ?");
      params.push(q.accountId);
    }
    if (q.type) {
      where.push("e.type = ?");
      params.push(q.type);
    }
    const before = Number(q.cursor);
    if (q.cursor && Number.isInteger(before)) {
      where.push("e.seq < ?");
      params.push(before);
    }
    const limit = clamp(q.limit ?? 50, 1, 200);
    const rows = ctx.db.all<EventRow>(`${EVENT_SELECT} WHERE ${where.join(" AND ")} ORDER BY e.seq DESC LIMIT ?`, ...params, limit + 1);
    // Console only: keeps threadLabelIds.
    const items = rows.slice(0, limit).map((r) => toStoredEvent(r));
    return { items, nextCursor: rows.length > limit ? String(items.at(-1)!.seq) : null };
  }

  function ackedSeq(agentId: string): number {
    return ctx.db.get<{ acked_seq: number }>("SELECT acked_seq FROM agent_cursors WHERE agent_id = ?", agentId)?.acked_seq ?? 0;
  }

  function feed(agentId: string, opts: FeedOptions = {}): FeedResult {
    const acked = ackedSeq(agentId);
    const after = Math.max(0, Math.floor(opts.after ?? acked));
    const limit = clamp(opts.limit ?? FEED_DEFAULT_LIMIT, 1, FEED_MAX_LIMIT);
    const where = ["e.seq > ?"];
    const params: Param[] = [];
    if (opts.types?.length) {
      where.push(`e.type IN (${opts.types.map(() => "?").join(", ")})`);
      params.push(...opts.types);
    }
    if (opts.accountIds?.length) {
      where.push(`e.account_id IN (${opts.accountIds.map(() => "?").join(", ")})`);
      params.push(...opts.accountIds);
    }
    const filter = where.join(" AND ");
    const sql = `${EVENT_SELECT} WHERE ${filter} ORDER BY e.seq ASC LIMIT ?`;

    const events: MailEvent[] = [];
    let cursor = after;
    let scanned = 0;
    scan: while (scanned < SCAN_MAX) {
      const rows = ctx.db.all<EventRow>(sql, cursor, ...params, SCAN_BATCH);
      for (const row of rows) {
        scanned++;
        cursor = row.seq;
        const ev = toStoredEvent(row);
        if (ctx.policy.canSeeEvent(agentId, ev)) events.push(toMailEvent(ev));
        if (events.length >= limit || scanned >= SCAN_MAX) break scan;
      }
      if (rows.length < SCAN_BATCH) break;
    }
    const hasMore = !!ctx.db.get(`SELECT 1 FROM events e WHERE ${filter} LIMIT 1`, cursor, ...params);
    return { events, cursor, ackedSeq: acked, hasMore };
  }

  function wait(agentId: string, opts: FeedOptions & { timeoutMs: number; signal?: AbortSignal }): Promise<FeedResult> {
    const { timeoutMs, signal, ...feedOpts } = opts;
    const first = feed(agentId, feedOpts);
    if (first.events.length || signal?.aborted || timeoutMs <= 0) return Promise.resolve(first);
    return new Promise<FeedResult>((resolve) => {
      let last = first;
      let done = false;
      let pending: NodeJS.Immediate | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (pending) clearImmediate(pending);
        ctx.bus.off("event", onEvent);
        signal?.removeEventListener("abort", finish);
        resolve(last);
      };
      // Continues from the last scanned position, so invisible events aren't rescanned. A scan that
      // hit its bound yields to the event loop and goes on until it finds something or catches up.
      const scan = () => {
        pending = null;
        if (done) return;
        try {
          last = feed(agentId, { ...feedOpts, after: last.cursor });
        } catch (err) {
          log.error("wait_for_events feed failed", { error: err instanceof Error ? err.message : String(err) });
          return finish();
        }
        if (last.events.length) return finish();
        if (last.hasMore) pending = setImmediate(scan);
      };
      const onEvent = (ev: MailEvent) => {
        if (pending || ev.seq <= last.cursor) return;
        if (feedOpts.types?.length && !feedOpts.types.includes(ev.type)) return;
        if (feedOpts.accountIds?.length && !feedOpts.accountIds.includes(ev.accountId)) return;
        scan();
      };
      const timer = setTimeout(finish, timeoutMs);
      ctx.bus.on("event", onEvent);
      signal?.addEventListener("abort", finish, { once: true });
      if (first.hasMore) pending = setImmediate(scan);
    });
  }

  function ack(agentId: string, seq: number): { ackedSeq: number } {
    // Never beyond the newest event: acking ahead would silently skip future events.
    const max = ctx.db.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM events")?.m ?? 0;
    const target = clamp(Math.floor(seq), 0, Math.max(max, 0));
    ctx.db.run(
      `INSERT INTO agent_cursors (agent_id, acked_seq, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq), updated_at = excluded.updated_at`,
      agentId,
      target,
      now(),
    );
    return { ackedSeq: ackedSeq(agentId) };
  }

  /** Keeps events still referenced by a delivery; webhooks.prune expires and removes those first. */
  function prune(beforeIso: string): number {
    return ctx.db.run(`DELETE FROM events WHERE created_at < ? AND seq NOT IN (SELECT event_seq FROM deliveries)`, beforeIso).changes;
  }

  return { emit, get, list, feed, wait, ack, prune };
}

/** node:sqlite exposes `isTransaction` from Node 22.16; older versions get a BEGIN probe (fails inside a transaction). */
function inTransaction(db: Db): boolean {
  const flag = (db.raw as { isTransaction?: unknown }).isTransaction;
  if (typeof flag === "boolean") return flag;
  try {
    db.raw.exec("BEGIN; ROLLBACK");
    return false;
  } catch {
    return true;
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(Number.isFinite(n) ? n : min, min), max);
