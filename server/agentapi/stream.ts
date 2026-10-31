import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { BROKER_EVENT_TYPES, EVENT_TYPES, type EventType, isEventType, type ListenerInfo, type MailEvent } from "../../shared/types.ts";
import type { BusEvents } from "../bus.ts";
import type { AppContext } from "../context.ts";
import { json } from "../db/index.ts";
import type { StoredEvent } from "../events/types.ts";
import { badRequest, errorMessage, HttpError } from "../util/errors.ts";
import { buildPayload, scopeBodyCheck } from "../webhooks/payload.ts";
import type { AgentApiEnv } from "./auth.ts";
import { cleanText } from "./pairing.ts";
import { accessProblem, ackedSeq, ensureConsumerSlot, isThrowawayConsumer, newestGrantedSeq, parseConsumer, type RevokeReason } from "./listeners.ts";

export const HEARTBEAT_MS = 15_000;
const BATCH = 100;

export interface StreamOptions {
  heartbeatMs?: number;
  /** How long the final `event: revoked` frame may take before the connection is destroyed. Default 2 s. */
  revokeWriteTimeoutMs?: number;
  /** Concurrent streams per agent. Default 5. */
  maxStreams?: number;
  /** Consumer cursors per agent. Default 20. */
  maxConsumers?: number;
  /** Open streams per agent id (shared per context). */
  open: Map<string, number>;
}

const short = (v: unknown, max = 100) => {
  const s = typeof v === "string" ? cleanText(v).slice(0, max) : "";
  return s || undefined;
};

/** Listener client info: `x-agentinbox-client` JSON header, else query params, else the user agent. */
function clientInfo(c: Context): ListenerInfo["client"] {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(c.req.header("x-agentinbox-client") ?? "{}");
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
  } catch {
    // Ignore a malformed header: it's informational.
  }
  // xaq/<version>, or agentinbox/<version> from a listener older than the rename.
  const ua = /(?:xaq|agentinbox)[\w-]*\/(\S+)/i.exec(c.req.header("user-agent") ?? "")?.[1];
  const info: ListenerInfo["client"] = {
    hostname: short(raw.hostname) ?? short(c.req.query("hostname")),
    platform: short(raw.platform, 50) ?? short(c.req.query("platform"), 50),
    version: short(raw.version, 50) ?? short(c.req.query("version"), 50) ?? short(ua, 50),
  };
  return Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined));
}

function parseSeq(raw: string | undefined, name: string, strict: boolean): number {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (Number.isSafeInteger(n) && n >= 0) return n;
  if (strict) throw badRequest(`${name} must be a non-negative integer`);
  return 0;
}

function parseTypes(raw: string | undefined): EventType[] | undefined {
  if (!raw) return undefined;
  const types = raw.split(",").map((t) => t.trim()).filter(Boolean);
  const bad = types.filter((t) => !isEventType(t));
  if (bad.length) throw badRequest(`Unknown event type ${bad.join(", ")}`, `Use any of ${[...EVENT_TYPES, ...BROKER_EVENT_TYPES].join(", ")}, or <integration>.<event>`);
  return types.length ? (types as EventType[]) : undefined;
}

const OPEN_REFUSALS: Record<RevokeReason, [string, string]> = {
  agent_deleted: ["This agent no longer exists", "Pair again with `npx xaq-cli connect`."],
  agent_disabled: ["This agent is disabled", "Enable it in the xaq console under Agents."],
  key_rotated: ["This API key was replaced", "Pair again with `npx xaq-cli connect`, or use the new key."],
  no_read_grant: ["This agent has no read access to any account or connection", "Grant it read or calendar.read on an account (or access to a connection) in the xaq console."],
};

/** Destroys the underlying socket (a stalled client never drains, so a graceful end would hang). */
function destroyConnection(c: Context): void {
  try {
    (c.env as { outgoing?: { destroy(): void } } | undefined)?.outgoing?.destroy();
  } catch {
    // Already gone.
  }
}

/**
 * GET /agent/v1/events/stream. Backlog first (events.feed in batches), then live bus events; each
 * event's visibility is re-checked right before it is written. Revocation (bus "agent", and every
 * heartbeat as a backstop) ends the stream with `event: revoked`. A client that stops reading for
 * more than two heartbeats is disconnected.
 */
export function streamEvents(ctx: AppContext, c: Context<AgentApiEnv>, opts: StreamOptions): Response {
  const { agentId } = c.get("agent")!;
  const keyHash = c.get("keyHash");
  const consumer = parseConsumer(c.req.query("consumer"));
  const types = parseTypes(c.req.query("types"));
  const includeBody = ["1", "true"].includes(c.req.query("include_body") ?? "");
  const after = parseSeq(c.req.query("after"), "after", true);
  const lastEventId = parseSeq(c.req.header("last-event-id"), "Last-Event-ID", false);
  const start = c.req.query("start");
  if (start !== undefined && start !== "now" && start !== "beginning") throw badRequest("start must be now or beginning");
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const problem = accessProblem(ctx.db, agentId, keyHash);
  if (problem) throw new HttpError(403, problem, ...OPEN_REFUSALS[problem]);
  const maxStreams = opts.maxStreams ?? 5;
  if ((opts.open.get(agentId) ?? 0) >= maxStreams) {
    throw new HttpError(429, "too_many_streams", `This agent already has ${maxStreams} open streams`, "Stop a running `xaq listen` first.");
  }

  const { db } = ctx;
  const log = ctx.log.child("listen");
  ensureConsumerSlot(ctx, agentId, consumer, opts.maxConsumers ?? 20);
  const touch = (delta: number) =>
    db.run(
      "UPDATE listener_cursors SET connected = MAX(0, connected + ?), last_seen_at = ? WHERE agent_id = ? AND consumer = ?",
      delta,
      new Date().toISOString(),
      agentId,
      consumer,
    );
  // A new consumer starts at the head (only new mail), unless it asks for start=beginning; an
  // existing one resumes from its cursor.
  const newest = newestGrantedSeq(ctx, agentId);
  const isNew = !db.get("SELECT 1 FROM listener_cursors WHERE agent_id = ? AND consumer = ?", agentId, consumer);
  // Throwaway cursors (`-replay`, `-dry-run`) always start at 0: the client positions them with `after`.
  const startAt = isNew && start !== "beginning" && !isThrowawayConsumer(consumer) ? newest : 0;
  const t = new Date().toISOString();
  db.run(
    `INSERT INTO listener_cursors (agent_id, consumer, acked_seq, start_seq, client, connected, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(agent_id, consumer) DO UPDATE SET client = excluded.client, connected = connected + 1, last_seen_at = excluded.last_seen_at`,
    agentId,
    consumer,
    startAt,
    startAt,
    // What this stream asked for, so the console only counts events of these types as delivered.
    // No types param means every type, including ones added later: stored as "all".
    json.str({ ...clientInfo(c), types: types ?? "all" }),
    t,
    t,
  );
  opts.open.set(agentId, (opts.open.get(agentId) ?? 0) + 1);
  ctx.policy.publishAgent(agentId);
  // Client-supplied positions can't point past what this agent can see (that would skip future events).
  let cursor = Math.max(Math.min(after, newest), Math.min(lastEventId, newest), ackedSeq(db, agentId, consumer));

  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let closed = false;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const close = () => {
      closed = true;
      finish();
    };
    const destroy = () => {
      close();
      stream.abort();
      destroyConnection(c);
    };

    // Writes in flight and when the last one completed: a client that stops reading stalls them.
    let inflight = 0;
    let progressAt = Date.now();
    const write = async (fn: () => Promise<unknown>) => {
      if (!inflight) progressAt = Date.now();
      inflight++;
      try {
        await fn();
      } finally {
        inflight--;
        progressAt = Date.now();
      }
    };

    const revoke = (reason: RevokeReason) => {
      if (closed) return;
      closed = true;
      // Written directly (frames are single writes), so a slow body fetch can't delay it; a client
      // that doesn't drain it in time is cut off.
      const timer = setTimeout(destroy, opts.revokeWriteTimeoutMs ?? 2000);
      stream.writeSSE({ event: "revoked", data: JSON.stringify({ reason }) }).finally(() => {
        clearTimeout(timer);
        finish();
      });
    };
    const checkAccess = () => {
      const reason = accessProblem(db, agentId, keyHash);
      if (reason) revoke(reason);
      return !reason;
    };
    const visible = (ev: StoredEvent) => ctx.policy.canSeeEvent(agentId, ev, "listener");

    let pumping = false;
    let again = false;
    const pump = async () => {
      if (pumping) {
        again = true;
        return;
      }
      pumping = true;
      try {
        do {
          again = false;
          for (;;) {
            if (closed || !checkAccess()) return;
            const from = cursor;
            const batch = ctx.events.feed(agentId, { after: from, limit: BATCH, types });
            for (const ev of batch.events) {
              const stored = ctx.events.get(ev.id);
              if (!stored || !visible(stored)) continue;
              const payload = await buildPayload(ctx, stored, includeBody, { bodyCheck: scopeBodyCheck(ctx, agentId, stored) });
              // The body fetch can take seconds: access may have changed meanwhile.
              if (closed || !checkAccess() || !visible(stored)) {
                if (closed) return;
                continue;
              }
              await write(() => stream.writeSSE({ id: String(ev.seq), event: "mail", data: JSON.stringify(payload) }));
            }
            cursor = Math.max(cursor, batch.cursor);
            if (cursor === from) break;
          }
        } while (again);
      } catch (err) {
        if (!closed) log.warn("Listener stream failed", { agent: agentId, consumer, error: errorMessage(err) });
        close();
      } finally {
        pumping = false;
      }
    };

    const onEvent = (ev: MailEvent) => {
      if (ev.seq > cursor && (!types || types.includes(ev.type))) void pump();
    };
    const onAgent = (change: BusEvents["agent"][0]) => {
      if (change.agentId === agentId) checkAccess();
    };
    ctx.bus.on("event", onEvent);
    ctx.bus.on("agent", onAgent);
    const heartbeat = setInterval(() => {
      if (closed) return;
      if (inflight && Date.now() - progressAt > 2 * heartbeatMs) {
        log.info("Disconnecting a listener that stopped reading", { agent: agentId, consumer });
        return destroy();
      }
      if (!checkAccess()) return;
      touch(0);
      // Don't pile pings onto a backed-up stream.
      if (!inflight) void write(() => stream.write(": ping\n\n"));
    }, heartbeatMs);

    stream.onAbort(close);
    c.req.raw.signal.addEventListener("abort", close, { once: true });
    if (stream.aborted || c.req.raw.signal.aborted) close();

    try {
      await write(() => stream.write(": connected\n\n"));
      void pump();
      await done;
    } finally {
      clearInterval(heartbeat);
      ctx.bus.off("event", onEvent);
      ctx.bus.off("agent", onAgent);
      const n = (opts.open.get(agentId) ?? 1) - 1;
      if (n > 0) opts.open.set(agentId, n);
      else opts.open.delete(agentId);
      try {
        touch(-1);
        ctx.policy.publishAgent(agentId);
      } catch {
        // The database may already be closed on shutdown.
      }
    }
  });
}
