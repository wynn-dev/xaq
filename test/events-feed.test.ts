import { afterEach, describe, expect, it } from "vitest";
import type { MailEvent, MessageSummary } from "../shared/types.ts";
import type { AppContext } from "../server/context.ts";
import type { NewEvent } from "../server/events/types.ts";
import type { PolicyService } from "../server/policy/types.ts";
import { testContext } from "./helpers.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

/** Agent "agt_scoped" sees only threads labelled "Label_ok"; every other agent sees everything. */
const policy = () =>
  ({
    canSeeEvent: (agentId: string, ev: { threadLabelIds: string[] }) => agentId !== "agt_scoped" || ev.threadLabelIds.includes("Label_ok"),
  }) as unknown as PolicyService;

function setup(overrides: Parameters<typeof testContext>[0] = {}) {
  const t = testContext({ policy, ...overrides });
  dispose = t.dispose;
  const { ctx } = t;
  ctx.db.run("INSERT INTO accounts (id, email, refresh_token_enc, created_at) VALUES ('acc_1', 'me@example.com', 'x', ?)", new Date().toISOString());
  for (const id of ["agt_all", "agt_scoped"]) {
    ctx.db.run("INSERT INTO agents (id, name, key_prefix, key_hash, created_at) VALUES (?, ?, 'aib_x', ?, ?)", id, id, `hash_${id}`, new Date().toISOString());
  }
  return ctx;
}

const message = (id: string, labelIds: string[] = ["INBOX"]): MessageSummary => ({
  id,
  threadId: `t_${id}`,
  from: { name: "Alice", email: "alice@example.com" },
  to: [{ name: null, email: "me@example.com" }],
  cc: [],
  subject: `Subject ${id}`,
  snippet: "hi",
  date: new Date().toISOString(),
  labelIds,
  hasAttachments: false,
});

const received = (id: string, labels?: string[], extra: Partial<NewEvent> = {}): NewEvent => ({
  type: "message.received",
  accountId: "acc_1",
  message: message(id, labels),
  dedupeKey: `acc_1:${id}:message.received`,
  ...extra,
});

const emit = (ctx: AppContext, e: NewEvent) => ctx.events.emit(e)!;

describe("events.emit", () => {
  it("stores, publishes and dedupes", () => {
    const ctx = setup();
    const seen: MailEvent[] = [];
    ctx.bus.on("event", (e) => seen.push(e));
    const ev = emit(ctx, received("m1", ["INBOX", "Label_ok"], { threadLabelIds: ["INBOX", "Label_ok", "Label_other"] }));
    expect(ev).toMatchObject({ type: "message.received", accountId: "acc_1", accountEmail: "me@example.com" });
    expect(ev.seq).toBeGreaterThan(0);
    expect(ev).not.toHaveProperty("threadLabelIds");
    expect(seen).toEqual([ev]);
    expect(ctx.events.get(ev.id)?.threadLabelIds).toEqual(["INBOX", "Label_ok", "Label_other"]);

    expect(ctx.events.emit(received("m1"))).toBeNull();
    expect(seen).toHaveLength(1);
    expect(ctx.events.list({}).items).toHaveLength(1);
  });

  it("defaults scope labels to the message labels and keeps label changes", () => {
    const ctx = setup();
    const ev = emit(ctx, { type: "label.added", accountId: "acc_1", message: message("m2", ["Label_ok"]), labelIds: ["Label_ok"], dedupeKey: "k" });
    expect(ev.labelIds).toEqual(["Label_ok"]);
    expect(ctx.events.get(ev.id)?.threadLabelIds).toEqual(["Label_ok"]);
  });

  it("falls back to detail.email when the account is gone", () => {
    const ctx = setup();
    const ev = emit(ctx, { type: "account.auth_failed", accountId: "acc_gone", detail: { email: "old@example.com" }, dedupeKey: "gone" });
    expect(ev.accountEmail).toBe("old@example.com");
    expect(ev.message).toBeNull();
  });
});

describe("events.list", () => {
  it("pages newest first and filters", () => {
    const ctx = setup();
    for (let i = 0; i < 5; i++) emit(ctx, received(`m${i}`));
    emit(ctx, { type: "sync.gap", accountId: "acc_1", dedupeKey: "gap" });
    const p1 = ctx.events.list({ limit: 3 });
    expect(p1.items.map((e) => e.message?.id ?? e.type)).toEqual(["sync.gap", "m4", "m3"]);
    const p2 = ctx.events.list({ limit: 3, cursor: p1.nextCursor });
    expect(p2.items.map((e) => e.message?.id)).toEqual(["m2", "m1", "m0"]);
    expect(p2.nextCursor).toBeNull();
    expect(ctx.events.list({ type: "sync.gap" }).items).toHaveLength(1);
    expect(ctx.events.list({ accountId: "acc_other" }).items).toHaveLength(0);
  });
});

describe("agent feed", () => {
  it("returns only visible events and skips past invisible ones", () => {
    const ctx = setup();
    const a = emit(ctx, received("a", ["Label_ok"]));
    emit(ctx, received("b", ["INBOX"]));
    const c = emit(ctx, received("c", ["INBOX"]));

    const all = ctx.events.feed("agt_all");
    expect(all.events.map((e) => e.message?.id)).toEqual(["a", "b", "c"]);
    expect(all.cursor).toBe(c.seq);

    const scoped = ctx.events.feed("agt_scoped");
    expect(scoped.events.map((e) => e.message?.id)).toEqual(["a"]);
    // Cursor moves past the invisible b and c.
    expect(scoped.cursor).toBe(c.seq);
    expect(ctx.events.feed("agt_scoped", { after: scoped.cursor })).toEqual({ events: [], cursor: c.seq, ackedSeq: 0, hasMore: false });

    // With a limit, the cursor stops at the last returned event.
    const limited = ctx.events.feed("agt_all", { limit: 1 });
    expect(limited.events).toHaveLength(1);
    expect(limited.cursor).toBe(a.seq);
    expect(limited.hasMore).toBe(true);
    expect(all.hasMore).toBe(false);
  });

  it("filters by type and account", () => {
    const ctx = setup();
    emit(ctx, received("a"));
    emit(ctx, { type: "sync.gap", accountId: "acc_1", dedupeKey: "gap" });
    expect(ctx.events.feed("agt_all", { types: ["sync.gap"] }).events.map((e) => e.type)).toEqual(["sync.gap"]);
    expect(ctx.events.feed("agt_all", { accountIds: ["acc_2"] }).events).toEqual([]);
  });

  it("defaults to the acked cursor, and ack only moves forward", () => {
    const ctx = setup();
    const a = emit(ctx, received("a"));
    const b = emit(ctx, received("b"));
    expect(ctx.events.ack("agt_all", a.seq)).toEqual({ ackedSeq: a.seq });
    const f = ctx.events.feed("agt_all");
    expect(f.ackedSeq).toBe(a.seq);
    expect(f.events.map((e) => e.id)).toEqual([b.id]);
    expect(ctx.events.ack("agt_all", 0)).toEqual({ ackedSeq: a.seq });
    // Can't ack beyond the newest event.
    expect(ctx.events.ack("agt_all", b.seq + 1000)).toEqual({ ackedSeq: b.seq });
    expect(ctx.events.feed("agt_all").events).toEqual([]);
  });

  it("wait resolves when a visible event arrives, not on invisible ones", async () => {
    const ctx = setup();
    const before = ctx.bus.listenerCount("event");
    const p = ctx.events.wait("agt_scoped", { timeoutMs: 5000 });
    expect(ctx.bus.listenerCount("event")).toBe(before + 1);
    const hidden = emit(ctx, received("hidden", ["INBOX"]));
    const shown = emit(ctx, received("shown", ["Label_ok"]));
    const r = await p;
    expect(r.events.map((e) => e.id)).toEqual([shown.id]);
    expect(r.cursor).toBe(shown.seq);
    expect(hidden.seq).toBeLessThan(shown.seq);
    expect(ctx.bus.listenerCount("event")).toBe(before);
  });

  it("wait returns immediately when events exist, and empty on timeout or abort", async () => {
    const ctx = setup();
    const before = ctx.bus.listenerCount("event");
    const hidden = emit(ctx, received("hidden", ["INBOX"]));

    const t0 = Date.now();
    const timedOut = await ctx.events.wait("agt_scoped", { timeoutMs: 50 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
    expect(timedOut).toEqual({ events: [], cursor: hidden.seq, ackedSeq: 0, hasMore: false });

    const ac = new AbortController();
    const p = ctx.events.wait("agt_scoped", { timeoutMs: 10_000, signal: ac.signal });
    ac.abort();
    expect((await p).events).toEqual([]);
    expect(ctx.bus.listenerCount("event")).toBe(before);

    const immediate = await ctx.events.wait("agt_all", { timeoutMs: 10_000 });
    expect(immediate.events.map((e) => e.id)).toEqual([hidden.id]);
  });

  it("wait honours type filters", async () => {
    const ctx = setup();
    const p = ctx.events.wait("agt_all", { timeoutMs: 5000, types: ["sync.gap"] });
    emit(ctx, received("a"));
    const gap = emit(ctx, { type: "sync.gap", accountId: "acc_1", dedupeKey: "gap" });
    expect((await p).events.map((e) => e.id)).toEqual([gap.id]);
  });
});

describe("feed scan bound", () => {
  /** Bulk-inserts events the scoped agent can't see, bypassing emit for speed. */
  function insertInvisible(ctx: AppContext, n: number) {
    ctx.db.tx(() => {
      const ts = new Date().toISOString();
      for (let i = 0; i < n; i++) {
        ctx.db.run(
          "INSERT INTO events (id, type, account_id, label_ids, dedupe_key, created_at) VALUES (?, 'message.received', 'acc_1', '[\"INBOX\"]', ?, ?)",
          `evt_bulk${i}`,
          `bulk${i}`,
          ts,
        );
      }
    });
  }

  it("reports hasMore when the scan stops at its bound", () => {
    const ctx = setup();
    insertInvisible(ctx, 5001);
    const visible = emit(ctx, received("visible", ["Label_ok"]));
    const first = ctx.events.feed("agt_scoped");
    expect(first.events).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBe(5000);
    const second = ctx.events.feed("agt_scoped", { after: first.cursor });
    expect(second.events.map((e) => e.id)).toEqual([visible.id]);
    expect(second.hasMore).toBe(false);
  });

  it("wait keeps scanning past the bound and resolves with the visible event", async () => {
    const ctx = setup();
    insertInvisible(ctx, 5001);
    const visible = emit(ctx, received("visible", ["Label_ok"]));
    const r = await ctx.events.wait("agt_scoped", { timeoutMs: 5000 });
    expect(r.events.map((e) => e.id)).toEqual([visible.id]);
  });

  it("wait stops rescanning when aborted", async () => {
    const ctx = setup();
    insertInvisible(ctx, 12_000);
    const ac = new AbortController();
    const p = ctx.events.wait("agt_scoped", { timeoutMs: 5000, signal: ac.signal });
    ac.abort();
    const r = await p;
    expect(r.events).toEqual([]);
    expect(r.hasMore).toBe(true);
    expect(ctx.bus.listenerCount("event")).toBe(0);
  });
});

describe("emit inside a transaction", () => {
  it("throws instead of publishing before the outer commit", () => {
    const ctx = setup();
    const seen: MailEvent[] = [];
    ctx.bus.on("event", (e) => seen.push(e));
    expect(() => ctx.db.tx(() => ctx.events.emit(received("m1")))).toThrow(/inside a transaction/);
    expect(seen).toEqual([]);
    expect(ctx.events.list({}).items).toEqual([]);
    expect(emit(ctx, received("m1"))).toBeTruthy();
  });
});

describe("events.prune", () => {
  it("deletes old events", () => {
    const ctx = setup();
    const old = emit(ctx, received("old"));
    const kept = emit(ctx, received("new"));
    ctx.db.run("UPDATE events SET created_at = '2000-01-01T00:00:00.000Z' WHERE seq = ?", old.seq);
    expect(ctx.events.prune("2001-01-01T00:00:00.000Z")).toBe(1);
    expect(ctx.events.get(old.id)).toBeNull();
    expect(ctx.events.get(kept.id)).not.toBeNull();
  });
});
