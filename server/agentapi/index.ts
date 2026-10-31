// Agent-facing API under /agent/v1 (contract: shared/agent-api.ts): device-flow pairing for
// `npx xaq-cli connect` and the event stream for `npx xaq-cli listen`. Mounted at the
// root; it uses bearer keys or no auth, so it sits outside the console's cookie/CSRF guard, behind
// its own browser/DNS-rebinding guard instead.

import { Hono } from "hono";
import { z } from "zod";
import type { AgentSelf } from "../../shared/agent-api.ts";
import { connectionGrantsOf } from "../broker/access.ts";
import { readBody } from "../api/util.ts";
import { clientIp, lockedOut } from "../auth/index.ts";
import { clientKey, LoginLimiter } from "../auth/lockout.ts";
import type { AppContext } from "../context.ts";
import { HttpError, notFound } from "../util/errors.ts";
import { type AgentApiEnv, agentAuth } from "./auth.ts";
import { agentRequestGuard, isLocalAddress } from "./guard.ts";
import { ackListener, newestVisibleSeq, parseConsumer } from "./listeners.ts";
import { createPairingService, type PairingOptions, type PairingService, pairingStartSchema, pollSchema } from "./pairing.ts";
import { OncePer, RateLimiter, tooManyRequests } from "./ratelimit.ts";
import { streamEvents } from "./stream.ts";

export interface AgentApiOptions extends PairingOptions {
  /** Stream heartbeat (`: ping` + access re-check). Default 15 s. */
  heartbeatMs?: number;
  /** How long a final `event: revoked` frame may take before the connection is destroyed. Default 2 s. */
  revokeWriteTimeoutMs?: number;
  /** Pairing starts per source (IPv4 address or IPv6 /64) per hour. Default 10. */
  startsPerHour?: number;
  /** Pairing starts per hour from everyone together. Default 60. */
  globalStartsPerHour?: number;
  /** Concurrent streams per agent. Default 5. */
  maxStreams?: number;
  /** Consumer cursors per agent. Default 20. */
  maxConsumers?: number;
}

export interface AgentApiState {
  pairings: PairingService;
  options: AgentApiOptions;
  /** Wrong bearer keys per source. */
  authLimiter: LoginLimiter;
  /** Unknown device codes per source. */
  codeLimiter: LoginLimiter;
  starts: RateLimiter;
  globalStarts: RateLimiter;
  /** Audits a repeated refusal (per reason and source) once per window. */
  auditOnce: OncePer;
  /** Open streams per agent. */
  streams: Map<string, number>;
}

const states = new WeakMap<AppContext, AgentApiState>();
const HOUR = 3600_000;

/**
 * Per-context agent API state (pairing service and in-memory rate limiters). Passing options
 * (tests: clock, TTL, limits) replaces the state; routes read it per request.
 */
export function agentApi(ctx: AppContext, options?: AgentApiOptions): AgentApiState {
  let state = states.get(ctx);
  if (!state || options) {
    const opts = options ?? {};
    const clock = opts.clock ?? Date.now;
    const first = !state;
    state = {
      pairings: createPairingService(ctx, opts),
      options: opts,
      authLimiter: new LoginLimiter(clock),
      codeLimiter: new LoginLimiter(clock),
      starts: new RateLimiter(opts.startsPerHour ?? 10, HOUR, clock),
      globalStarts: new RateLimiter(opts.globalStartsPerHour ?? 60, HOUR, clock),
      auditOnce: new OncePer(10 * 60_000, clock),
      streams: state?.streams ?? new Map(),
    };
    states.set(ctx, state);
    if (first) {
      // No stream survives a restart: connection counts from a previous run are stale.
      ctx.db.run("UPDATE listener_cursors SET connected = 0 WHERE connected <> 0");
      ctx.bus.on("agent", (change) => {
        try {
          states.get(ctx)?.pairings.onAgentChange(change);
        } catch (err) {
          ctx.log.warn("Pairing update failed", { error: err instanceof Error ? err.message : String(err) });
        }
      });
    }
  }
  return state;
}

/** Expires overdue pairings (server/maintenance.ts runs this on a short timer). Never throws. */
export function sweepPairings(ctx: AppContext): number {
  try {
    return agentApi(ctx).pairings.sweep();
  } catch (err) {
    ctx.log.warn("Pairing sweep failed", { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

export function agentApiRoutes(ctx: AppContext): Hono<AgentApiEnv> {
  const app = new Hono<AgentApiEnv>();
  agentApi(ctx); // resets stale listener connection counts at startup
  const state = () => agentApi(ctx);
  const sourceOf = (c: Parameters<typeof clientIp>[0]) => {
    const ip = clientIp(c, ctx.config.trustProxy);
    return { ip, source: clientKey(ip) };
  };
  /** Refusals are audited once per reason and source per window, not per request. */
  const denied = (action: string, reason: string, source: string, detail: Record<string, unknown>) => {
    if (state().auditOnce.first(`${action}:${reason}:${source}`)) ctx.audit.record({ actorType: "system", action, outcome: "denied", reason, detail });
  };

  app.use("/agent/*", agentRequestGuard(ctx));

  // ── Pairing (public) ──
  app.post("/agent/v1/pairings", async (c) => {
    const s = state();
    const { ip, source } = sourceOf(c);
    const take = s.starts.take(source);
    if (!take.ok) {
      denied("pairing.requested", "rate_limit", source, { ip });
      return tooManyRequests(c, "rate_limited", "Too many pairing requests from this address", take.retryAfter, "Wait a while, or create the agent in the console.");
    }
    if (!ctx.settings.get().pairingEnabled) {
      denied("pairing.requested", "pairing_disabled", source, { ip });
      throw new HttpError(
        403,
        "pairing_disabled",
        "Pairing is turned off on this xaq",
        "An admin can turn on pairing in the console under Settings, or create the agent under Agents and copy its key.",
      );
    }
    const body = await readBody(c, pairingStartSchema);
    s.pairings.sweep();
    // The owner on this machine can always pair: a remote flood only fills the global caps.
    const local = isLocalAddress(ip);
    const cap = s.pairings.capReached(source, local);
    if (cap) {
      denied("pairing.requested", cap === "global" ? "pending_cap" : "pending_cap_source", cap === "global" ? "*" : source, { ip, name: body.name });
      return tooManyRequests(
        c,
        "too_many_pending",
        cap === "global" ? "Too many pairing requests are waiting for approval" : "This address already has pairing requests waiting for approval",
        60,
        "Approve or deny the waiting requests in the console, or let them expire.",
      );
    }
    const global = local ? { ok: true, retryAfter: 0 } : s.globalStarts.take("*");
    if (!global.ok) {
      denied("pairing.requested", "global_rate_limit", "*", { ip });
      return tooManyRequests(c, "rate_limited", "Too many pairing requests right now", global.retryAfter, "Try again later, or create the agent in the console.");
    }
    return c.json(s.pairings.start(body, ip));
  });

  app.post("/agent/v1/pairings/poll", async (c) => {
    const s = state();
    const { ip, source } = sourceOf(c);
    const { deviceCode } = await readBody(c, pollSchema);
    // A valid code is never refused (per-code pacing is slow_down); only unknown codes are limited.
    const result = s.pairings.poll(deviceCode);
    if (result) return c.json(result);
    const banned = s.codeLimiter.bannedMinutes(source);
    if (banned) return lockedOut(c, banned);
    if (s.codeLimiter.fail(source, deviceCode, { global: false })) denied("pairing.poll", "lockout", source, { ip });
    // Indistinguishable from a request that was pruned.
    return c.json({ status: "expired" });
  });

  // ── Listener (bearer aib_ key) ──
  const auth = agentAuth(ctx, () => state().authLimiter);
  app.use("/agent/v1/me", auth);
  app.use("/agent/v1/events/*", auth);

  app.get("/agent/v1/me", (c) => {
    const agent = ctx.policy.getAgent(c.get("agent")!.agentId);
    if (!agent) throw notFound("Agent");
    const base = ctx.settings.publicUrl();
    const self: AgentSelf = {
      id: agent.id,
      name: agent.name,
      grants: agent.grants.map((g) => ({
        accountId: g.accountId,
        accountEmail: ctx.accounts.get(g.accountId)?.email ?? "",
        capabilities: g.capabilities,
        labelScope: g.labelScope,
        sendMode: g.sendMode,
        allowTo: g.allowTo,
        replyOnly: g.replyOnly,
        maxSendsPerHour: g.maxSendsPerHour,
        maxSendsPerDay: g.maxSendsPerDay,
        calendarScope: g.calendarScope,
        calendarWriteMode: g.calendarWriteMode,
      })),
      consumers: ctx.db
        .all<{ consumer: string; start_seq: number | null; acked_seq: number; connected: number }>(
          "SELECT consumer, start_seq, acked_seq, connected FROM listener_cursors WHERE agent_id = ? ORDER BY consumer",
          agent.id,
        )
        .map((r) => ({ consumer: r.consumer, startSeq: r.start_seq, ackedSeq: r.acked_seq, connected: r.connected > 0 })),
      connections: connectionGrantsOf(ctx.db, agent.id).map((g) => ({ name: g.name, slug: g.slug, level: g.level })),
      mcpUrl: `${base}/mcp`,
      skillUrl: `${base}/skill.md`,
      headSeq: newestVisibleSeq(ctx, agent.id),
    };
    return c.json(self);
  });

  app.get("/agent/v1/events/stream", (c) => {
    const s = state();
    return streamEvents(ctx, c, {
      heartbeatMs: s.options.heartbeatMs,
      revokeWriteTimeoutMs: s.options.revokeWriteTimeoutMs,
      maxStreams: s.options.maxStreams,
      maxConsumers: s.options.maxConsumers,
      open: s.streams,
    });
  });

  app.post("/agent/v1/events/ack", async (c) => {
    const body = await readBody(c, z.object({ consumer: z.string().optional(), seq: z.number().int().nonnegative() }));
    return c.json(ackListener(ctx, c.get("agent")!.agentId, parseConsumer(body.consumer, { throwaway: false }), body.seq, state().options.maxConsumers ?? 20));
  });

  app.all("/agent/*", (c) => c.json({ error: { code: "not_found", message: "No such agent API route" } }, 404));

  return app;
}
