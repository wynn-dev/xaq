import { z } from "zod";
import type { Delivery, DeliveryStatus, EventType, Page, Webhook, WebhookFilter, WebhookWithSecret } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { bool, json, now, type Param } from "../db/index.ts";
import { eventBySeq, TEST_ACCOUNT_EMAIL, TEST_ACCOUNT_ID } from "../events/repo.ts";
import type { StoredEvent } from "../events/types.ts";
import { badRequest, errorMessage, notFound } from "../util/errors.ts";
import { newId, randomToken } from "../util/ids.ts";
import { DELIVERY_SELECT, type DeliveryRow, deliveryById, toDelivery } from "./deliveries.ts";
import { matchesFilter, normalizeFilter, webhookInputSchema, webhookPatchSchema } from "./filter.ts";
import { buildPayload, scopeBodyCheck } from "./payload.ts";
import { newSecret, postPinned, secretPrefix, type SendResult, sign } from "./send.ts";
import { subjectPatternError } from "./regex.ts";
import { type LookupFn, resolveTarget, SsrfError } from "./ssrf.ts";
import type { WebhooksService } from "./types.ts";

/** Delay before each retry: after the n-th failed attempt, wait RETRY_SCHEDULE_MS[n-1]; after the last, the delivery is dead. */
export const RETRY_SCHEDULE_MS = [30, 120, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600].map((s) => s * 1000);

export interface WebhooksOptions {
  retryScheduleMs?: number[];
  /** Worker poll interval. New deliveries also wake it immediately. */
  tickMs?: number;
  concurrency?: number;
  /** In-flight requests per webhook, so one slow receiver can't take every worker slot. */
  perWebhookConcurrency?: number;
  timeoutMs?: number;
  /** DNS resolver for the SSRF guard (tests). */
  lookup?: LookupFn;
}

interface WebhookRow {
  id: string;
  agent_id: string;
  name: string;
  url: string;
  secret_enc: string;
  secret_prefix: string;
  event_types: string;
  filter: string;
  include_body: number;
  enabled: number;
  created_at: string;
  succeeded_24h: number;
  failed_24h: number;
  last_delivery_at: string | null;
}

/** The first two params are the 24 h cutoff (twice). Stats leave out test deliveries. Plain `?` only: Node 22's
 * node:sqlite rejects mixing numbered and anonymous placeholders. */
const WEBHOOK_SELECT = `SELECT w.*,
  (SELECT COUNT(*) FROM deliveries d WHERE d.webhook_id = w.id AND d.event_seq > 0 AND d.status = 'succeeded' AND d.updated_at >= ?) AS succeeded_24h,
  (SELECT COUNT(*) FROM deliveries d WHERE d.webhook_id = w.id AND d.event_seq > 0 AND d.status IN ('failed', 'dead') AND d.updated_at >= ?) AS failed_24h,
  (SELECT MAX(d.updated_at) FROM deliveries d WHERE d.webhook_id = w.id AND d.event_seq > 0 AND d.attempts > 0) AS last_delivery_at
  FROM webhooks w`;

const toWebhook = (r: WebhookRow): Webhook => ({
  id: r.id,
  agentId: r.agent_id,
  name: r.name,
  url: r.url,
  eventTypes: json.parse<EventType[]>(r.event_types, []),
  filter: json.parse<WebhookFilter>(r.filter, {}),
  includeBody: bool(r.include_body),
  enabled: bool(r.enabled),
  secretPrefix: r.secret_prefix,
  createdAt: r.created_at,
  stats: { succeeded24h: r.succeeded_24h, failed24h: r.failed_24h, lastDeliveryAt: r.last_delivery_at },
});

interface AttemptRow {
  id: string;
  event_seq: number;
  attempts: number;
  url: string;
  secret_enc: string;
  include_body: number;
  agent_id: string;
}

export function createWebhooksService(ctx: AppContext, options: WebhooksOptions = {}): WebhooksService {
  const log = ctx.log.child("webhooks");
  const schedule = options.retryScheduleMs ?? RETRY_SCHEDULE_MS;
  const tickMs = options.tickMs ?? 1000;
  const concurrency = options.concurrency ?? 8;
  const perWebhook = options.perWebhookConcurrency ?? 2;
  const timeoutMs = options.timeoutMs ?? 10_000;

  /** Delivery id → its running attempt and webhook. */
  const inflight = new Map<string, { promise: Promise<void>; webhookId: string }>();
  let shutdown = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let wakeQueued = false;

  const since24h = () => new Date(Date.now() - 24 * 3600_000).toISOString();
  /** Bind params for WEBHOOK_SELECT's two cutoff placeholders. */
  const statsCutoffs = () => {
    const t = since24h();
    return [t, t];
  };

  // ───────────── CRUD ─────────────

  function row(id: string): WebhookRow | undefined {
    return ctx.db.get<WebhookRow>(`${WEBHOOK_SELECT} WHERE w.id = ?`, ...statsCutoffs(), id);
  }

  function requireRow(id: string): WebhookRow {
    const r = row(id);
    if (!r) throw notFound("Webhook");
    return r;
  }

  function list(agentId?: string): Webhook[] {
    const rows = agentId
      ? ctx.db.all<WebhookRow>(`${WEBHOOK_SELECT} WHERE w.agent_id = ? ORDER BY w.created_at DESC`, ...statsCutoffs(), agentId)
      : ctx.db.all<WebhookRow>(`${WEBHOOK_SELECT} ORDER BY w.created_at DESC`, ...statsCutoffs());
    return rows.map(toWebhook);
  }

  function get(id: string): Webhook | null {
    const r = row(id);
    return r ? toWebhook(r) : null;
  }

  function requireAgent(agentId: string): void {
    if (!ctx.db.get("SELECT 1 FROM agents WHERE id = ?", agentId)) throw badRequest("Agent not found", "Webhooks belong to an existing agent.");
  }

  /** Create/update-time SSRF check. Transient DNS failures pass; every delivery checks again. */
  async function checkUrl(url: string): Promise<void> {
    try {
      await resolveTarget(new URL(url), ctx.settings.get().webhookAllowlist, options.lookup);
    } catch (err) {
      if (err instanceof SsrfError && err.kind !== "dns") throw badRequest(err.message, err.hint);
      if (!(err instanceof SsrfError)) throw err;
    }
  }

  async function create(input: z.input<typeof webhookInputSchema>): Promise<WebhookWithSecret> {
    const v = parse(webhookInputSchema, input);
    requireAgent(v.agentId);
    await checkUrl(v.url);
    const id = newId("whk");
    const secret = newSecret();
    ctx.db.run(
      `INSERT INTO webhooks (id, agent_id, name, url, secret_enc, secret_prefix, event_types, filter, include_body, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      v.agentId,
      v.name,
      v.url,
      ctx.crypto.encrypt(secret),
      secretPrefix(secret),
      json.str([...new Set(v.eventTypes)]),
      json.str(normalizeFilter(v.filter)),
      v.includeBody ? 1 : 0,
      v.enabled ? 1 : 0,
      now(),
    );
    return { webhook: get(id)!, secret };
  }

  async function update(id: string, patch: z.input<typeof webhookPatchSchema>): Promise<Webhook> {
    const current = toWebhook(requireRow(id));
    const p = parse(webhookPatchSchema, patch);
    if (p.agentId !== undefined && p.agentId !== current.agentId) requireAgent(p.agentId);
    if (p.url !== undefined && p.url !== current.url) await checkUrl(p.url);
    const next = { ...current, ...stripUndefined(p) };
    ctx.db.run(
      `UPDATE webhooks SET agent_id = ?, name = ?, url = ?, event_types = ?, filter = ?, include_body = ?, enabled = ? WHERE id = ?`,
      next.agentId,
      next.name,
      next.url,
      json.str([...new Set(next.eventTypes)]),
      json.str(normalizeFilter(next.filter)),
      next.includeBody ? 1 : 0,
      next.enabled ? 1 : 0,
      id,
    );
    if (next.enabled && !current.enabled) wake();
    return get(id)!;
  }

  function rotateSecret(id: string): WebhookWithSecret {
    requireRow(id);
    const secret = newSecret();
    ctx.db.run("UPDATE webhooks SET secret_enc = ?, secret_prefix = ? WHERE id = ?", ctx.crypto.encrypt(secret), secretPrefix(secret), id);
    return { webhook: get(id)!, secret };
  }

  function remove(id: string): void {
    ctx.db.tx(() => {
      if (ctx.db.run("DELETE FROM webhooks WHERE id = ?", id).changes === 0) throw notFound("Webhook");
      deleteOrphanTestEvents();
    });
  }

  function deleteOrphanTestEvents(): void {
    ctx.db.run("DELETE FROM events WHERE seq < 0 AND seq NOT IN (SELECT event_seq FROM deliveries)");
  }

  // ───────────── Deliveries ─────────────

  function listDeliveries(q: { webhookId?: string; status?: DeliveryStatus; cursor?: string | null; limit?: number }): Page<Delivery> {
    const where: string[] = [];
    const params: Param[] = [];
    if (q.webhookId) {
      where.push("d.webhook_id = ?");
      params.push(q.webhookId);
    }
    if (q.status) {
      where.push("d.status = ?");
      params.push(q.status);
    }
    const before = Number(q.cursor);
    if (q.cursor && Number.isInteger(before)) {
      where.push("d.rowid < ?");
      params.push(before);
    }
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const rows = ctx.db.all<DeliveryRow>(
      `${DELIVERY_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.rowid DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    return { items: page.map(toDelivery), nextCursor: rows.length > limit ? String(page.at(-1)!.rid) : null };
  }

  /** Runs inside events.emit's transaction. */
  function enqueue(event: StoredEvent): number {
    const hooks = ctx.db.all<{ id: string; agent_id: string; event_types: string; filter: string }>(
      `SELECT w.id, w.agent_id, w.event_types, w.filter FROM webhooks w JOIN agents a ON a.id = w.agent_id
       WHERE w.enabled = 1 AND a.disabled = 0`,
    );
    const ts = now();
    let count = 0;
    for (const w of hooks) {
      if (!json.parse<EventType[]>(w.event_types, []).includes(event.type)) continue;
      if (!matchesFilter(json.parse<WebhookFilter>(w.filter, {}), event)) continue;
      if (!ctx.policy.canSeeEvent(w.agent_id, event)) continue;
      count += ctx.db.run(
        `INSERT INTO deliveries (id, webhook_id, event_seq, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?) ON CONFLICT(webhook_id, event_seq) DO NOTHING`,
        newId("dlv"),
        w.id,
        event.seq,
        ts,
        ts,
        ts,
      ).changes;
    }
    return count;
  }

  async function test(id: string): Promise<Delivery> {
    requireRow(id);
    const deliveryId = ctx.db.tx(() => {
      const ts = now();
      // Below every negative seq still in use by an event or a delivery.
      const seq = ctx.db.get<{ s: number }>(
        `SELECT MIN(0, COALESCE((SELECT MIN(seq) FROM events), 0), COALESCE((SELECT MIN(event_seq) FROM deliveries), 0)) - 1 AS s`,
      )!.s;
      const evtId = newId("evt");
      const msgId = `test_${randomToken(16)}`;
      const message = {
        id: msgId,
        threadId: msgId,
        from: { name: "Ada Lovelace (test)", email: "ada@example.com" },
        to: [{ name: null, email: TEST_ACCOUNT_EMAIL }],
        cc: [],
        subject: "Test event from xaq",
        snippet: "This is a test delivery sent from the xaq console. It is not a real email.",
        date: ts,
        labelIds: ["INBOX", "UNREAD"],
        hasAttachments: false,
      };
      ctx.db.run(
        `INSERT INTO events (seq, id, type, account_id, gmail_message_id, gmail_thread_id, label_ids, message, detail, dedupe_key, created_at)
         VALUES (?, ?, 'message.received', ?, ?, ?, ?, ?, ?, ?, ?)`,
        seq,
        evtId,
        TEST_ACCOUNT_ID,
        msgId,
        msgId,
        json.str(message.labelIds),
        json.str(message),
        json.str({ test: true }),
        `test:${evtId}`,
        ts,
      );
      const dlv = newId("dlv");
      ctx.db.run(
        `INSERT INTO deliveries (id, webhook_id, event_seq, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?)`,
        dlv,
        id,
        seq,
        ts,
        ts,
      );
      return dlv;
    });
    publishDelivery(deliveryId);
    await run(deliveryId);
    return deliveryById(ctx.db, deliveryId)!;
  }

  async function replay(deliveryId: string): Promise<Delivery> {
    const existing = deliveryById(ctx.db, deliveryId);
    if (!existing) throw notFound("Delivery");
    await inflight.get(deliveryId)?.promise;
    const ts = now();
    // Test deliveries stay off the worker's schedule (next_attempt_at NULL); this call delivers them.
    ctx.db.run(
      "UPDATE deliveries SET status = 'pending', next_attempt_at = CASE WHEN event_seq < 0 THEN NULL ELSE ? END, updated_at = ? WHERE id = ?",
      ts,
      ts,
      deliveryId,
    );
    publishDelivery(deliveryId);
    await run(deliveryId);
    return deliveryById(ctx.db, deliveryId)!;
  }

  /**
   * Retention: deliveries still pending or failed past the cutoff (e.g. on a webhook or agent that
   * stayed disabled) are given up as dead, so re-enabling doesn't flood the receiver with stale
   * events and their events can be pruned. Finished deliveries older than the cutoff are deleted.
   */
  function prune(beforeIso: string): number {
    return ctx.db.tx(() => {
      const ts = now();
      ctx.db.run(
        `UPDATE deliveries SET status = 'dead', next_attempt_at = NULL, last_error = 'expired (retention)', updated_at = ?
         WHERE status IN ('pending', 'failed') AND created_at < ?`,
        ts,
        beforeIso,
      );
      const removed = ctx.db.run(`DELETE FROM deliveries WHERE status IN ('succeeded', 'dead') AND updated_at < ?`, beforeIso).changes;
      deleteOrphanTestEvents();
      return removed;
    });
  }

  // ───────────── Worker ─────────────

  function wake(): void {
    if (!timer || wakeQueued) return;
    wakeQueued = true;
    setImmediate(() => {
      wakeQueued = false;
      tick();
    });
  }

  /**
   * Fills free worker slots round-robin across webhooks (at most `perWebhook` in flight each), so a
   * receiver that hangs or has a large backlog doesn't hold up the others.
   */
  function tick(): void {
    if (!timer) return;
    let capacity = concurrency - inflight.size;
    if (capacity <= 0) return;
    const busy = [...inflight.keys()];
    const perHook = new Map<string, number>();
    for (const { webhookId } of inflight.values()) perHook.set(webhookId, (perHook.get(webhookId) ?? 0) + 1);
    let due: { id: string; webhook_id: string }[];
    try {
      due = ctx.db.all<{ id: string; webhook_id: string }>(
        `SELECT id, webhook_id FROM (
           SELECT d.id, d.webhook_id, d.next_attempt_at,
             ROW_NUMBER() OVER (PARTITION BY d.webhook_id ORDER BY d.next_attempt_at, d.rowid) AS rn
           FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id JOIN agents a ON a.id = w.agent_id
           WHERE d.status IN ('pending', 'failed') AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?
             AND w.enabled = 1 AND a.disabled = 0 ${busy.length ? `AND d.id NOT IN (${busy.map(() => "?").join(", ")})` : ""}
         ) WHERE rn <= ? ORDER BY rn, next_attempt_at`,
        now(),
        ...busy,
        perWebhook,
      );
    } catch (err) {
      log.error("Delivery worker query failed", { error: errorMessage(err) });
      return;
    }
    for (const d of due) {
      if (capacity <= 0) break;
      const used = perHook.get(d.webhook_id) ?? 0;
      if (used >= perWebhook) continue;
      perHook.set(d.webhook_id, used + 1);
      capacity--;
      void run(d.id, d.webhook_id);
    }
  }

  /** One attempt per delivery at a time; the worker and manual replays share this. */
  function run(id: string, webhookId?: string): Promise<void> {
    const existing = inflight.get(id);
    if (existing) return existing.promise;
    const hook = webhookId ?? ctx.db.get<{ webhook_id: string }>("SELECT webhook_id FROM deliveries WHERE id = ?", id)?.webhook_id ?? "";
    const p = attempt(id)
      .catch((err) => log.error("Delivery attempt failed", { delivery: id, error: errorMessage(err) }))
      .finally(() => {
        inflight.delete(id);
        wake();
      });
    inflight.set(id, { promise: p, webhookId: hook });
    return p;
  }

  async function attempt(id: string): Promise<void> {
    const d = ctx.db.get<AttemptRow>(
      `SELECT d.id, d.event_seq, d.attempts, w.url, w.secret_enc, w.include_body, w.agent_id
       FROM deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ?`,
      id,
    );
    if (!d) return;
    const isTest = d.event_seq < 0;
    const event = eventBySeq(ctx.db, d.event_seq);
    if (!event) return record(d, isTest, fail("The event was removed by retention before it could be delivered"), true);
    if (!isTest && !ctx.policy.canSeeEvent(d.agent_id, event)) {
      return record(d, isTest, fail("The webhook's agent can no longer see this event (its grant changed)"), true);
    }

    const signal = shutdown.signal;
    // Shutting down mid-attempt: a real delivery keeps its state and is retried after restart; a
    // one-shot test delivery is reported as interrupted.
    const interrupted = () => (isTest ? record(d, isTest, fail("Interrupted by shutdown")) : undefined);
    const url = new URL(d.url);
    let target;
    try {
      target = await untilAborted(resolveTarget(url, ctx.settings.get().webhookAllowlist, options.lookup), signal);
    } catch (err) {
      if (signal.aborted) return interrupted();
      const hint = err instanceof SsrfError && err.hint ? ` ${err.hint}` : "";
      return record(d, isTest, fail(`${err instanceof SsrfError && err.kind === "blocked" ? "Blocked: " : ""}${errorMessage(err)}.${hint}`));
    }

    let body: string;
    try {
      body = JSON.stringify(await untilAborted(buildPayload(ctx, event, bool(d.include_body), { isTest, bodyCheck: scopeBodyCheck(ctx, d.agent_id, event) }), signal));
    } catch (err) {
      if (signal.aborted) return interrupted();
      throw err;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      "content-type": "application/json",
      "user-agent": `xaq/${ctx.config.version}`,
      "webhook-id": d.id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": sign(ctx.crypto.decrypt(d.secret_enc), d.id, timestamp, body),
    };
    const result = await postPinned(url, target, headers, body, { timeoutMs, signal });
    if (signal.aborted) return interrupted();
    record(d, isTest, result);
  }

  function record(d: AttemptRow, isTest: boolean, r: SendResult, final = false): void {
    const attempts = d.attempts + 1;
    const ok = r.error === null && r.statusCode !== null && r.statusCode >= 200 && r.statusCode < 300;
    let status: DeliveryStatus;
    let next: string | null = null;
    if (ok) status = "succeeded";
    // Test deliveries are one-shot: a failure is reported, not retried.
    else if (isTest) status = "failed";
    else if (final || attempts > schedule.length) status = "dead";
    else {
      status = "failed";
      next = new Date(Date.now() + schedule[attempts - 1]!).toISOString();
    }
    ctx.db.run(
      `UPDATE deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_status_code = ?, last_error = ?, last_response = ?,
       duration_ms = ?, updated_at = ? WHERE id = ?`,
      status,
      attempts,
      next,
      r.statusCode,
      r.error,
      r.response,
      r.durationMs,
      now(),
      d.id,
    );
    if (!ok) log.warn("Webhook delivery failed", { delivery: d.id, status, error: r.error });
    publishDelivery(d.id);
  }

  function publishDelivery(id: string): void {
    const delivery = deliveryById(ctx.db, id);
    if (!delivery) return;
    try {
      ctx.bus.emit("delivery", delivery);
    } catch (err) {
      log.error("Bus listener failed", { error: errorMessage(err) });
    }
  }

  /** Patterns stored before RE2 validation existed may be rejected now; those subject clauses never match. */
  function warnUnsupportedPatterns(): void {
    for (const w of ctx.db.all<{ id: string; name: string; filter: string }>("SELECT id, name, filter FROM webhooks")) {
      const subject = json.parse<WebhookFilter>(w.filter, {}).subject;
      const error = subject ? subjectPatternError(subject) : null;
      if (error) {
        log.warn("Webhook subject filter is not valid RE2; it matches nothing until edited", { webhook: w.id, name: w.name, error });
      }
    }
  }

  const onEvent = () => wake();

  return {
    list,
    get,
    create,
    update,
    rotateSecret,
    remove,
    test,
    listDeliveries,
    replay,
    enqueue,
    prune,
    start() {
      if (timer) return;
      if (shutdown.signal.aborted) shutdown = new AbortController();
      // Test deliveries are one-shot; any left pending were cut off by a crash.
      const busy = [...inflight.keys()];
      ctx.db.run(
        `UPDATE deliveries SET status = 'failed', last_error = 'Interrupted by a restart', updated_at = ?
         WHERE event_seq < 0 AND status = 'pending' AND next_attempt_at IS NULL
         ${busy.length ? `AND id NOT IN (${busy.map(() => "?").join(", ")})` : ""}`,
        now(),
        ...busy,
      );
      warnUnsupportedPatterns();
      timer = setInterval(tick, tickMs);
      timer.unref();
      ctx.bus.on("event", onEvent);
      wake();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      ctx.bus.off("event", onEvent);
      shutdown.abort();
      await Promise.allSettled([...inflight.values()].map((f) => f.promise));
    },
  };
}

const fail = (error: string): SendResult => ({ statusCode: null, response: null, error, durationMs: 0 });

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw badRequest(z.prettifyError(r.error));
  return r.data;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Rejects as soon as `signal` aborts; the underlying work is left to settle on its own. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let onAbort!: () => void;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  ]).finally(() => signal.removeEventListener("abort", onAbort));
}
