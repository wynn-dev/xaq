import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent, ConsoleStreamMessage, MailEvent, Page } from "../shared/types.ts";
import { auditApi } from "../server/api/audit.ts";
import { eventsApi } from "../server/api/events.ts";
import type { AppEnv } from "../server/api/util.ts";
import type { AppContext } from "../server/context.ts";
import type { PolicyService } from "../server/policy/types.ts";
import { HttpError } from "../server/util/errors.ts";
import { testContext } from "./helpers.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

function setup(heartbeatMs?: number, maxPendingWrites?: number) {
  const t = testContext({ policy: () => ({ canSeeEvent: () => true }) as unknown as PolicyService });
  dispose = t.dispose;
  const app = new Hono<AppEnv>().route("/api", eventsApi(t.ctx, { heartbeatMs, maxPendingWrites })).route("/api", auditApi(t.ctx));
  app.onError((err, c) => (err instanceof HttpError ? c.json(err.toJSON(), err.status as 400) : c.json({ error: { code: "internal", message: err.message } }, 500)));
  return { ctx: t.ctx, app };
}

const emitGap = (ctx: AppContext, key: string) => ctx.events.emit({ type: "sync.gap", accountId: "acc_1", dedupeKey: key, detail: { email: "me@example.com" } })!;

describe("GET /api/events", () => {
  it("lists newest first with filters and validates the type", async () => {
    const { ctx, app } = setup();
    emitGap(ctx, "a");
    emitGap(ctx, "b");
    ctx.events.emit({ type: "account.auth_failed", accountId: "acc_1", dedupeKey: "c" });
    const page = (await (await app.request("/api/events?limit=2")).json()) as Page<MailEvent>;
    expect(page.items.map((e) => e.type)).toEqual(["account.auth_failed", "sync.gap"]);
    const next = (await (await app.request(`/api/events?cursor=${page.nextCursor}`)).json()) as Page<MailEvent>;
    expect(next.items).toHaveLength(1);
    const gaps = (await (await app.request("/api/events?type=sync.gap&accountId=acc_1")).json()) as Page<MailEvent>;
    expect(gaps.items).toHaveLength(2);
    expect((await app.request("/api/events?type=bogus")).status).toBe(400);
    expect((await app.request("/api/events?cursor=abc")).status).toBe(400);
    expect((await app.request("/api/events?cursor=-5")).status).toBe(400);
  });

  it("includes the thread labels (console only: agents' label scopes match them)", async () => {
    const { ctx, app } = setup();
    const ev = ctx.events.emit({ type: "message.received", accountId: "acc_1", message: null, threadLabelIds: ["INBOX", "Label_work"], dedupeKey: "m" })!;
    expect(ev).not.toHaveProperty("threadLabelIds");
    const page = (await (await app.request("/api/events")).json()) as Page<MailEvent>;
    expect(page.items[0]).toEqual({ ...ev, threadLabelIds: ["INBOX", "Label_work"] });
  });
});

describe("GET /api/audit", () => {
  it("filters through ctx.audit.list", async () => {
    const { ctx, app } = setup();
    ctx.audit.record({ actorType: "system", action: "x", outcome: "ok" });
    ctx.audit.record({ actorType: "system", action: "y", outcome: "denied", reason: "rate_limit", accountId: "acc_1" });
    const page = (await (await app.request("/api/audit?outcome=denied&accountId=acc_1")).json()) as Page<{ action: string }>;
    expect(page.items.map((e) => e.action)).toEqual(["y"]);
    expect((await app.request("/api/audit?outcome=nope")).status).toBe(400);
    expect((await app.request("/api/audit?cursor=1;DROP")).status).toBe(400);
  });
});

describe("GET /api/events/stream", () => {
  it("streams bus messages as SSE and cleans up on disconnect", async () => {
    const { ctx, app } = setup(30);
    const before = ctx.bus.listenerCount("event");
    const res = await app.request("/api/events/stream");
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const messages: ConsoleStreamMessage[] = [];
    const readUntil = async (pred: () => boolean) => {
      while (!pred()) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop()!;
        for (const f of frames) {
          const data = f
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (data) messages.push(JSON.parse(data) as ConsoleStreamMessage);
        }
      }
    };

    await readUntil(() => buffer.length > 0 || ctx.bus.listenerCount("event") > before);
    expect(ctx.bus.listenerCount("event")).toBe(before + 1);

    const ev = emitGap(ctx, "a");
    ctx.audit.record({ actorType: "admin", action: "thing", outcome: "ok" });
    // Agent state goes out as kind "agent"; bus "agent" (access changes for listener streams) doesn't.
    ctx.bus.emit("agent", { agentId: "agt_1", reason: "updated" });
    ctx.bus.emit("agentState", { id: "agt_1", name: "Hermes" } as Agent);
    await readUntil(() => messages.length >= 3);
    expect(messages.map((m) => m.kind)).toEqual(["event", "audit", "agent"]);
    // The console's copy carries the thread labels the bus event leaves out.
    expect(messages[0]!.data).toEqual({ ...ev, threadLabelIds: [] });
    expect(messages[2]!.data).toEqual({ id: "agt_1", name: "Hermes" });

    // Heartbeat comments keep proxies from closing the connection.
    const chunks: string[] = [];
    while (!chunks.join("").includes(": ping")) {
      const { value } = await reader.read();
      chunks.push(decoder.decode(value));
    }

    await reader.cancel();
    for (let i = 0; i < 50 && ctx.bus.listenerCount("event") > before; i++) await new Promise((r) => setTimeout(r, 10));
    for (const ch of ["event", "approval", "audit", "account", "agentState"] as const) expect(ctx.bus.listenerCount(ch)).toBe(ch === "event" ? before : 0);
  });

  it("drops a stalled client instead of buffering without bound", async () => {
    const { ctx, app } = setup(60_000, 5);
    const res = await app.request("/api/events/stream");
    // Never read the body: writes back up until the cap trips.
    for (let i = 0; i < 20; i++) ctx.audit.record({ actorType: "admin", action: `a${i}`, outcome: "ok" });
    for (let i = 0; i < 50 && ctx.bus.listenerCount("audit") > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(ctx.bus.listenerCount("audit")).toBe(0);
    await res.body!.cancel().catch(() => {});
  });
});
