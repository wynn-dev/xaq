import { afterEach, describe, expect, it } from "vitest";
import type { OverviewStats } from "../shared/types.ts";
import { overviewApi, overviewStats } from "../server/api/overview.ts";
import { testContext } from "./helpers.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const HOUR = 3600_000;

describe("overview", () => {
  it("aggregates counts and zero-filled hourly buckets", async () => {
    const t = testContext();
    dispose = t.dispose;
    const { db } = t.ctx;
    const at = new Date("2026-10-15T12:34:56.000Z");
    const ago = (ms: number) => new Date(at.getTime() - ms).toISOString();

    db.run("INSERT INTO accounts (id, email, status, refresh_token_enc, created_at) VALUES ('a1', 'a@x', 'active', 'x', ?), ('a2', 'b@x', 'needs_reauth', 'x', ?), ('a3', 'c@x', 'paused', 'x', ?)", ago(0), ago(0), ago(0));
    db.run("INSERT INTO agents (id, name, key_prefix, key_hash, last_used_at, created_at) VALUES ('g1', 'g1', 'p', 'h1', ?, ?), ('g2', 'g2', 'p', 'h2', ?, ?)", ago(HOUR), ago(0), ago(48 * HOUR), ago(0));

    let n = 0;
    const event = (createdAt: string, seq?: number) =>
      db.run(
        "INSERT INTO events (seq, id, type, account_id, dedupe_key, created_at) VALUES (?, ?, 'message.received', 'a1', ?, ?)",
        seq ?? null,
        `evt_${++n}`,
        `k${n}`,
        createdAt,
      );
    event(ago(5 * 60_000)); // current hour (12:xx)
    event(ago(40 * 60_000)); // 11:xx
    event(ago(41 * 60_000)); // 11:xx
    event(ago(23 * HOUR + 30 * 60_000)); // 13:04 yesterday: in the 24 h window but before the first bucket
    event(ago(30 * HOUR)); // outside the window
    event(ago(60_000), -1); // synthetic test event: never counted

    const audit = (ts: string, actorType: string, outcome: string) =>
      db.run("INSERT INTO audit_log (ts, actor_type, action, outcome) VALUES (?, ?, 'read_message', ?)", ts, actorType, outcome);
    audit(ago(60_000), "agent", "ok");
    audit(ago(2 * 60_000), "agent", "denied");
    audit(ago(3 * HOUR), "agent", "ok");
    audit(ago(60_000), "admin", "ok");
    audit(ago(25 * HOUR), "agent", "denied");
    // Not MCP tool calls: pairing.key_delivered (agent actor, dotted action) and console actions.
    db.run("INSERT INTO audit_log (ts, actor_type, action, outcome) VALUES (?, 'agent', 'pairing.key_delivered', 'ok')", ago(60_000));
    db.run("INSERT INTO audit_log (ts, actor_type, action, outcome) VALUES (?, 'agent', 'pairing.key_delivered', 'ok')", ago(3 * HOUR));
    db.run("INSERT INTO audit_log (ts, actor_type, action, outcome) VALUES (?, 'admin', 'agent.create', 'ok')", ago(60_000));

    db.run("INSERT INTO webhooks (id, agent_id, name, url, secret_enc, secret_prefix, event_types, created_at) VALUES ('w', 'g1', 'w', 'http://x', 'x', 'x', '[]', ?)", ago(0));
    const delivery = (id: string, status: string, updatedAt: string, attempts = 1) =>
      db.run("INSERT INTO deliveries (id, webhook_id, event_seq, status, attempts, created_at, updated_at) VALUES (?, 'w', ?, ?, ?, ?, ?)", id, Number(id.slice(1)), status, attempts, updatedAt, updatedAt);
    delivery("d1", "succeeded", ago(HOUR));
    delivery("d2", "failed", ago(HOUR));
    delivery("d3", "dead", ago(HOUR));
    delivery("d4", "succeeded", ago(30 * HOUR));
    delivery("d5", "pending", ago(HOUR), 0);
    db.run("INSERT INTO deliveries (id, webhook_id, event_seq, status, attempts, created_at, updated_at) VALUES ('t1', 'w', -1, 'succeeded', 1, ?, ?)", ago(HOUR), ago(HOUR)); // test delivery


    const s = overviewStats(t.ctx, at);
    expect(s.accounts).toEqual({ total: 3, active: 1, needsAttention: 1 });
    expect(s.agents).toEqual({ total: 2, activeLast24h: 1 });
    expect(s.events24h).toBe(4);
    expect(s.deliveries24h).toEqual({ succeeded: 1, failed: 2 });
    expect(s.toolCalls24h).toBe(3);
    expect(s.denied24h).toBe(1);

    expect(s.activity).toHaveLength(24);
    expect(s.activity[0]!.hour).toBe("2026-10-14T13:00:00.000Z");
    expect(s.activity[23]!.hour).toBe("2026-10-15T12:00:00.000Z");
    expect(s.activity[23]).toEqual({ hour: "2026-10-15T12:00:00.000Z", events: 1, toolCalls: 2 });
    expect(s.activity[22]).toEqual({ hour: "2026-10-15T11:00:00.000Z", events: 2, toolCalls: 0 });
    expect(s.activity[20]).toEqual({ hour: "2026-10-15T09:00:00.000Z", events: 0, toolCalls: 1 });
    expect(s.activity[0]).toEqual({ hour: "2026-10-14T13:00:00.000Z", events: 1, toolCalls: 0 });
    expect(s.activity.reduce((sum, b) => sum + b.events, 0)).toBe(4);
    for (let i = 1; i < 24; i++) expect(Date.parse(s.activity[i]!.hour) - Date.parse(s.activity[i - 1]!.hour)).toBe(HOUR);
  });

  it("serves GET /overview on an empty database", async () => {
    const t = testContext();
    dispose = t.dispose;
    const res = await overviewApi(t.ctx).request("/overview");
    const body = (await res.json()) as OverviewStats;
    expect(body.accounts).toEqual({ total: 0, active: 0, needsAttention: 0 });
    expect(body.deliveries24h).toEqual({ succeeded: 0, failed: 0 });
    expect(body.activity).toHaveLength(24);
    expect(body.activity.every((b) => b.events === 0 && b.toolCalls === 0)).toBe(true);
  });
});
