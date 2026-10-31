import type { OverviewStats } from "../../shared/types.ts";
import { mcpToolCallSql } from "../audit.ts";
import type { AppContext } from "../context.ts";
import { router } from "./util.ts";

const HOUR = 3600_000;

/** Paths are relative to /api. */
export function overviewApi(ctx: AppContext) {
  return router().get("/overview", (c) => c.json(overviewStats(ctx)));
}

export function overviewStats(ctx: AppContext, at = new Date()): OverviewStats {
  const db = ctx.db;
  const since = new Date(at.getTime() - 24 * HOUR).toISOString();
  const n = (sql: string, ...params: string[]) => db.get<{ n: number }>(sql, ...params)?.n ?? 0;

  const accounts = db.get<{ total: number; active: number | null; attention: number | null }>(
    `SELECT COUNT(*) AS total, SUM(status = 'active') AS active, SUM(status IN ('needs_reauth', 'error')) AS attention FROM accounts`,
  )!;
  const deliveries = db.get<{ ok: number | null; failed: number | null }>(
    `SELECT SUM(status = 'succeeded') AS ok, SUM(status IN ('failed', 'dead')) AS failed
     FROM deliveries WHERE updated_at >= ? AND attempts > 0 AND event_seq > 0`,
    since,
  )!;
  // MCP tool calls only (the same rule as anyAgentVerified): not pairing.key_delivered and the like.
  // Every outcome, including calls rejected for invalid arguments or an unknown tool (outcome "error").
  const agentCalls = db.get<{ calls: number; denied: number | null }>(
    `SELECT COUNT(*) AS calls, SUM(outcome = 'denied') AS denied FROM audit_log WHERE ${mcpToolCallSql()} AND ts >= ?`,
    since,
  )!;

  // 24 hourly buckets ending with the current hour, keyed by the ISO "YYYY-MM-DDTHH" prefix.
  const currentHour = Math.floor(at.getTime() / HOUR) * HOUR;
  const firstHour = new Date(currentHour - 23 * HOUR).toISOString();
  const bucketCounts = (sql: string) =>
    new Map(db.all<{ h: string; n: number }>(sql, firstHour).map((r) => [r.h, r.n] as const));
  const events = bucketCounts(`SELECT substr(created_at, 1, 13) AS h, COUNT(*) AS n FROM events WHERE seq > 0 AND created_at >= ? GROUP BY h`);
  const calls = bucketCounts(`SELECT substr(ts, 1, 13) AS h, COUNT(*) AS n FROM audit_log WHERE ${mcpToolCallSql()} AND ts >= ? GROUP BY h`);
  const activity = Array.from({ length: 24 }, (_, i) => {
    const hour = new Date(currentHour - (23 - i) * HOUR).toISOString();
    const key = hour.slice(0, 13);
    return { hour, events: events.get(key) ?? 0, toolCalls: calls.get(key) ?? 0 };
  });

  return {
    accounts: { total: accounts.total, active: accounts.active ?? 0, needsAttention: accounts.attention ?? 0 },
    agents: {
      total: n("SELECT COUNT(*) AS n FROM agents"),
      activeLast24h: n("SELECT COUNT(*) AS n FROM agents WHERE last_used_at >= ?", since),
    },
    events24h: n("SELECT COUNT(*) AS n FROM events WHERE seq > 0 AND created_at >= ?", since),
    deliveries24h: { succeeded: deliveries.ok ?? 0, failed: deliveries.failed ?? 0 },
    toolCalls24h: agentCalls.calls,
    denied24h: agentCalls.denied ?? 0,
    activity,
  };
}
