import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSelf } from "../shared/agent-api.ts";
import type { Agent } from "../shared/types.ts";
import { type AgentApiOptions, agentApi } from "../server/agentapi/index.ts";
import { createApp } from "../server/app.ts";
import { type RunningServer, startServer } from "../server/server.ts";
import type { GoogleService } from "../server/google/types.ts";
import type { MailService } from "../server/mail/types.ts";
import { testConfig } from "./helpers.ts";
import { addAccount, emitMessage, fakeMail, readGrant, SseReader } from "./listen-server-helpers.ts";
import { fakeGoogle, fakeIngest } from "./platform-helpers.ts";

let running: RunningServer | undefined;
const readers: SseReader[] = [];
afterEach(async () => {
  for (const r of readers.splice(0)) r.cancel();
  await running?.close();
  if (running) rmSync(running.ctx.config.dataDir, { recursive: true, force: true });
  running = undefined;
});

/** Current thread labels for the fake Gmail (include_body scope check); defaults to the event's. */
let threadLabelsNow: Map<string, string[]>;

function google(): () => GoogleService {
  const base = fakeGoogle()();
  return () =>
    ({
      ...base,
      gmail: () => ({
        getThread: async (id: string) => ({ id, messages: [{ id: "x", threadId: id, labelIds: threadLabelsNow.get(id) ?? ["INBOX", "Label_work"] }] }),
      }),
    }) as unknown as GoogleService;
}

async function setup(opts: AgentApiOptions = {}, mail: () => MailService = fakeMail()) {
  threadLabelsNow = new Map();
  running = await startServer({ config: testConfig(), overrides: { google: google(), ingest: fakeIngest(), mail } });
  const { ctx, url } = running;
  agentApi(ctx, { heartbeatMs: 60_000, ...opts });
  addAccount(ctx, "acc_a", "me@acme.com");
  addAccount(ctx, "acc_b", "other@acme.com");
  const { agent, apiKey } = ctx.policy.createAgent({ name: "Hermes", grants: [readGrant("acc_a")] });

  /** New consumers default to the head; these tests want the backlog unless they say otherwise. */
  const open = async (query = "", headers: Record<string, string> = {}, key = apiKey) => {
    if (!query.includes("start=")) query += `${query ? "&" : "?"}start=beginning`;
    const res = await fetch(`${url}/agent/v1/events/stream${query}`, { headers: { authorization: `Bearer ${key}`, ...headers } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = new SseReader(res);
    readers.push(reader);
    await reader.until((f) => f.some((x) => x.comment === "connected"));
    return reader;
  };
  const ack = (consumer: string, seq: number, key = apiKey) =>
    fetch(`${url}/agent/v1/events/ack`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ consumer, seq }) });
  return { ctx, url, agent, apiKey, open, ack };
}

const seqs = (r: SseReader) => r.mail().map((m) => m.seq);

describe("GET /agent/v1/events/stream", () => {
  it("sends the backlog then live events, only from the agent's accounts", async () => {
    const s = await setup();
    const visible1 = emitMessage(s.ctx, "acc_a", "m1", ["INBOX", "Label_work"]);
    emitMessage(s.ctx, "acc_b", "m3", ["INBOX", "Label_work"]); // ungranted account
    const visible2 = s.ctx.events.emit({ type: "sync.gap", accountId: "acc_a", dedupeKey: "gap1" })!.seq;

    const r = await s.open();
    await r.until(() => r.mail().length >= 2);
    expect(seqs(r)).toEqual([visible1, visible2]);
    const [first] = r.mail();
    expect(first!.payload).toMatchObject({ type: "message.received", data: { seq: visible1, accountId: "acc_a", accountEmail: "me@acme.com", message: { id: "m1" } } });
    expect(first!.payload.timestamp).toBe(first!.payload.data.createdAt);
    expect(first!.payload.data).not.toHaveProperty("threadLabelIds");
    expect(first!.payload.data).not.toHaveProperty("content");

    emitMessage(s.ctx, "acc_b", "m4", ["Label_work"]);
    const live = emitMessage(s.ctx, "acc_a", "m6", ["Label_work"]);
    await r.until(() => r.mail().length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seqs(r)).toEqual([visible1, visible2, live]);
  });

  it("filters by type and attaches cleaned content with include_body", async () => {
    const s = await setup();
    emitMessage(s.ctx, "acc_a", "m1", ["SENT"], "message.sent");
    const ok = emitMessage(s.ctx, "acc_a", "m2");
    const failing = emitMessage(s.ctx, "acc_a", "fail3");
    const r = await s.open("?types=message.received&include_body=1");
    await r.until(() => r.mail().length >= 2);
    const [a, b] = r.mail();
    expect([a!.seq, b!.seq]).toEqual([ok, failing]);
    expect(a!.payload.data.content).toMatchObject({ body: "Body of m2", signals: { external: true } });
    expect(b!.payload.data).not.toHaveProperty("content");
    expect(b!.payload.data.contentError).toMatch(/Message body unavailable: Gmail is down/);

    const bad = await fetch(`${s.url}/agent/v1/events/stream?types=bogus`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    expect(bad.status).toBe(400);
    const badConsumer = await fetch(`${s.url}/agent/v1/events/stream?consumer=${encodeURIComponent("a b")}`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    expect(badConsumer.status).toBe(400);
  });

  it("resumes after max(after, Last-Event-ID, the consumer's acked cursor)", async () => {
    const s = await setup();
    const all = ["m1", "m2", "m3", "m4", "m5"].map((id) => emitMessage(s.ctx, "acc_a", id));

    let r = await s.open(`?consumer=laptop&after=${all[1]}`);
    await r.until(() => r.mail().length >= 3);
    expect(seqs(r)).toEqual(all.slice(2));
    r.cancel();

    r = await s.open(`?consumer=laptop&after=${all[0]}`, { "last-event-id": String(all[2]) });
    await r.until(() => r.mail().length >= 2);
    expect(seqs(r)).toEqual(all.slice(3));
    r.cancel();

    expect(await (await s.ack("laptop", all[3]!)).json()).toEqual({ ackedSeq: all[3] });
    r = await s.open("?consumer=laptop", { "last-event-id": String(all[1]) });
    await r.until(() => r.mail().length >= 1);
    expect(seqs(r)).toEqual([all[4]]);

    // Cursors are per consumer.
    const other = await s.open("?consumer=desktop");
    await other.until(() => other.mail().length >= 5);
    expect(seqs(other)).toEqual(all);
  });

  it("tracks listeners on the agent while connected", async () => {
    const s = await setup();
    const r = await s.open("?consumer=laptop", { "user-agent": "xaq-listen/1.2.3", "x-agentinbox-client": JSON.stringify({ hostname: "wynn-mbp", platform: "darwin" }) });
    const listeners = s.ctx.policy.getAgent(s.agent.id)!.listeners;
    expect(listeners).toEqual([
      {
        consumer: "laptop",
        connected: true,
        startSeq: 0,
        ackedSeq: 0,
        // No types param: every type counts, including types added later.
        types: null,
        lastSeenAt: expect.any(String),
        client: { hostname: "wynn-mbp", platform: "darwin", version: "1.2.3" },
      },
    ]);
    r.cancel();
    const deadline = Date.now() + 2000;
    while (s.ctx.policy.getAgent(s.agent.id)!.listeners[0]!.connected && Date.now() < deadline) await new Promise((x) => setTimeout(x, 10));
    expect(s.ctx.policy.getAgent(s.agent.id)!.listeners[0]!.connected).toBe(false);
  });

  it("records the event types each listener's stream asked for, as of its latest connection", async () => {
    const s = await setup();
    const typesOf = (consumer: string) => s.ctx.policy.getAgent(s.agent.id)!.listeners.find((l) => l.consumer === consumer)!.types;
    // The client header can't set them: only the stream's own `types` counts.
    const a = await s.open("?consumer=laptop&types=message.received", { "x-agentinbox-client": JSON.stringify({ hostname: "h", types: ["message.sent"] }) });
    expect(typesOf("laptop")).toEqual(["message.received"]);
    a.cancel();
    const b = await s.open("?consumer=laptop&types=message.received,message.sent");
    expect(typesOf("laptop")).toEqual(["message.received", "message.sent"]);
    b.cancel();
    // No types param: stored as "all" (not today's list), so every type counts.
    const c = await s.open("?consumer=laptop");
    expect(JSON.parse(s.ctx.db.get<{ client: string }>("SELECT client FROM listener_cursors WHERE consumer = ?", "laptop")!.client).types).toBe("all");
    expect(typesOf("laptop")).toBeNull();
    c.cancel();
    // Cursors recorded before types were: unknown, which counts the same.
    s.ctx.db.run("UPDATE listener_cursors SET client = ? WHERE consumer = ?", JSON.stringify({ hostname: "old" }), "laptop");
    expect(typesOf("laptop")).toBeNull();
    expect(s.ctx.policy.getAgent(s.agent.id)!.listeners[0]!.client).toEqual({ hostname: "old" });
  });

  it("pushes the agent to the console bus on connect, disconnect and acks (at most once a second)", async () => {
    const s = await setup();
    const states: { at: number; agent: Agent }[] = [];
    s.ctx.bus.on("agentState", (agent) => states.push({ at: Date.now(), agent }));
    const listener = () => states.at(-1)?.agent.listeners.find((l) => l.consumer === "laptop");
    const waitFor = async (pred: () => boolean, ms = 3000) => {
      const deadline = Date.now() + ms;
      while (!pred() && Date.now() < deadline) await new Promise((x) => setTimeout(x, 10));
      expect(pred()).toBe(true);
    };
    const seq = [1, 2, 3].map((i) => emitMessage(s.ctx, "acc_a", `m${i}`));

    const r = await s.open("?consumer=laptop");
    await waitFor(() => listener()?.connected === true);

    // A burst of acks right after connecting: one trailing push, a second after the last one, with the final cursor.
    const before = states.length;
    const lastPush = states.at(-1)!.at;
    for (const n of seq) expect((await s.ack("laptop", n)).status).toBe(200);
    await waitFor(() => listener()?.ackedSeq === seq[2]);
    const ackPushes = states.slice(before);
    expect(ackPushes).toHaveLength(1);
    expect(ackPushes[0]!.at - lastPush).toBeGreaterThanOrEqual(990);

    r.cancel();
    await waitFor(() => listener()?.connected === false);
    expect(states.at(-1)!.agent).toMatchObject({ id: s.agent.id, listeners: [{ consumer: "laptop", ackedSeq: seq[2] }] });
  });

  it("sends heartbeats and re-checks access on each one", async () => {
    const s = await setup({ heartbeatMs: 40 });
    const r = await s.open();
    await r.until((f) => f.filter((x) => x.comment === "ping").length >= 2);
    // Bypass policy (no bus event): only the heartbeat can notice.
    s.ctx.db.run("UPDATE agents SET disabled = 1 WHERE id = ?", s.agent.id);
    const frames = await r.end();
    expect(frames.at(-1)).toEqual({ event: "revoked", data: JSON.stringify({ reason: "agent_disabled" }) });
  });

  const revocations: [string, string, (s: Awaited<ReturnType<typeof setup>>) => void][] = [
    ["disabling the agent", "agent_disabled", (s) => s.ctx.policy.updateAgent(s.agent.id, { disabled: true })],
    ["rotating the key", "key_rotated", (s) => s.ctx.policy.rotateKey(s.agent.id)],
    ["deleting the agent", "agent_deleted", (s) => s.ctx.policy.deleteAgent(s.agent.id)],
    ["deleting the read grant", "no_read_grant", (s) => s.ctx.policy.deleteGrant(s.agent.id, "acc_a")],
  ];
  for (const [what, reason, revoke] of revocations) {
    it(`closes a live stream with event: revoked on ${what}`, async () => {
      const s = await setup();
      const baseline = s.ctx.bus.listenerCount("agent");
      const r = await s.open();
      const started = performance.now();
      revoke(s);
      const frames = await r.end(1000);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(frames.at(-1)).toEqual({ event: "revoked", data: JSON.stringify({ reason }) });
      // Nothing more is delivered on a revoked stream, and the agent's listener shows disconnected.
      expect(s.ctx.bus.listenerCount("agent")).toBe(baseline);
    });
  }

  it("keeps a stream open on unrelated agent changes", async () => {
    const s = await setup();
    const other = s.ctx.policy.createAgent({ name: "Other", grants: [readGrant("acc_a")] });
    const r = await s.open();
    s.ctx.policy.rotateKey(other.agent.id);
    s.ctx.policy.updateAgent(s.agent.id, { name: "Renamed" });
    const seq = emitMessage(s.ctx, "acc_a", "m1");
    await r.until(() => r.mail().length >= 1);
    expect(seqs(r)).toEqual([seq]);
    expect(r.ended).toBe(false);
  });

  it("refuses to open without a read grant", async () => {
    const s = await setup();
    s.ctx.policy.deleteGrant(s.agent.id, "acc_a");
    const res = await fetch(`${s.url}/agent/v1/events/stream`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("no_read_grant");
  });
});

describe("POST /agent/v1/events/ack", () => {
  it("only moves the cursor forward and never past the newest event", async () => {
    const s = await setup();
    const a = emitMessage(s.ctx, "acc_a", "m1");
    const b = emitMessage(s.ctx, "acc_a", "m2");
    expect(await (await s.ack("laptop", b)).json()).toEqual({ ackedSeq: b });
    expect(await (await s.ack("laptop", a)).json()).toEqual({ ackedSeq: b });
    expect(await (await s.ack("laptop", b + 1000)).json()).toEqual({ ackedSeq: b });
    // Capped at the newest event this agent can see, not the global newest.
    for (let i = 0; i < 5; i++) emitMessage(s.ctx, "acc_b", `other${i}`);
    expect(await (await s.ack("laptop", 1e12)).json()).toEqual({ ackedSeq: b });
    expect(await (await s.ack("desktop", a)).json()).toEqual({ ackedSeq: a });
    expect((await s.ack("laptop", -1)).status).toBe(400);
    expect(s.ctx.policy.getAgent(s.agent.id)!.listeners.map((l) => [l.consumer, l.ackedSeq])).toEqual([
      ["desktop", a],
      ["laptop", b],
    ]);
    // MCP's cursor is separate.
    expect(s.ctx.events.feed(s.agent.id).ackedSeq).toBe(0);
  });
});

describe("agent API auth", () => {
  it("returns AgentSelf for a valid key and 401 with WWW-Authenticate otherwise", async () => {
    const s = await setup();
    const me = await fetch(`${s.url}/agent/v1/me`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    expect(me.status).toBe(200);
    const self = (await me.json()) as AgentSelf;
    const base = s.ctx.settings.publicUrl();
    expect(self).toEqual({
      id: s.agent.id,
      name: "Hermes",
      grants: [
        {
          accountId: "acc_a",
          accountEmail: "me@acme.com",
          level: "read",
          allowTo: [],
        },
      ],
      consumers: [],
      connections: [], // the broker is on by default: no connection grants here
      mcpUrl: `${base}/mcp`,
      skillUrl: `${base}/skill.md`,
      headSeq: 0,
    });
    for (const headers of [{}, { authorization: "Bearer aib_wrong" }]) {
      const res = await fetch(`${s.url}/agent/v1/events/stream`, { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
    }
    // No CSRF header needed for a bearer POST.
    expect((await s.ack("x", 0)).status).toBe(200);
  });

  it("locks out an address after 5 distinct bad keys without refusing valid keys or other addresses", async () => {
    const s = await setup();
    s.ctx.config.trustProxy = true;
    const app = createApp(s.ctx);
    // Behind a local proxy (XFF is only honored from a private peer).
    const peer = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
    const me = (ip: string, key: string) => app.request("/agent/v1/me", { headers: { authorization: `Bearer ${key}`, "x-forwarded-for": ip } }, peer);
    // Retrying the same stale key counts once.
    for (let i = 0; i < 6; i++) expect((await me("10.0.0.1", "aib_stale")).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await me("10.0.0.1", `aib_bad${i}`)).status).toBe(401);
    expect((await me("10.0.0.1", s.apiKey)).status).toBe(200);
    expect((await me("10.0.0.1", "aib_bad4")).status).toBe(401);
    const locked = await me("10.0.0.1", "aib_bad5");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
    // A valid key is never refused, even from the locked-out address (shared NAT/proxy).
    expect((await me("10.0.0.1", s.apiKey)).status).toBe(200);
    expect((await me("10.0.0.2", "aib_other")).status).toBe(401);
    expect(s.ctx.audit.list({ action: "agent_api.auth" }).items).toMatchObject([{ outcome: "denied", reason: "lockout", detail: { ip: "10.0.0.1" } }]);
  });
});

describe("stream hardening", () => {
  it("does not write an event whose access was revoked while its body was being fetched", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let fetching!: () => void;
    const started = new Promise<void>((r) => (fetching = r));
    const slow = fakeMail()();
    const s = await setup({}, () =>
      ({
        async messageContent(accountId: string, id: string) {
          if (id === "slow") {
            fetching();
            await gate;
          }
          return slow.messageContent(accountId, id);
        },
      }) as unknown as MailService,
    );
    s.ctx.policy.upsertGrant(s.agent.id, "acc_b", readGrant("acc_b"));
    emitMessage(s.ctx, "acc_a", "slow");
    const r = await s.open("?include_body=1");
    await started;
    s.ctx.policy.deleteGrant(s.agent.id, "acc_a"); // acc_b keeps the stream alive
    release();
    const next = emitMessage(s.ctx, "acc_b", "m2");
    await r.until(() => r.mail().length >= 1);
    expect(r.mail().map((m) => [m.seq, m.payload.data.accountId])).toEqual([[next, "acc_b"]]);
  });

  it("caps after and Last-Event-ID at the newest visible event", async () => {
    const s = await setup();
    emitMessage(s.ctx, "acc_a", "m1");
    for (let i = 0; i < 3; i++) emitMessage(s.ctx, "acc_b", `b${i}`);
    let r = await s.open("?after=1000000000");
    const next = emitMessage(s.ctx, "acc_a", "m2");
    await r.until(() => r.mail().length >= 1);
    expect(seqs(r)).toEqual([next]);
    r.cancel();
    r = await s.open("", { "last-event-id": "999999999" });
    const later = emitMessage(s.ctx, "acc_a", "m3");
    await r.until(() => r.mail().length >= 1);
    expect(seqs(r)).toEqual([later]);
  });

  it("ends streams immediately when an account with the agent's only read grant is removed", async () => {
    const s = await setup();
    const r = await s.open();
    const started = performance.now();
    await s.ctx.accounts.remove("acc_a");
    const frames = await r.end(1000);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(frames.at(-1)).toEqual({ event: "revoked", data: JSON.stringify({ reason: "no_read_grant" }) });
  });

  it("limits concurrent streams and consumers per agent", async () => {
    const s = await setup({ maxStreams: 2, maxConsumers: 3 });
    const a = await s.open("?consumer=a");
    await s.open("?consumer=b");
    const third = await fetch(`${s.url}/agent/v1/events/stream?consumer=c`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe("too_many_streams");
    a.cancel();
    const deadline = Date.now() + 2000;
    while (s.ctx.policy.getAgent(s.agent.id)!.listeners.find((l) => l.consumer === "a")!.connected && Date.now() < deadline) await new Promise((x) => setTimeout(x, 10));
    expect((await s.ack("c", 0)).status).toBe(200); // 3 consumers: a (idle), b, c
    // Recently seen consumers are never evicted: a reconnecting listener must not restart at the head.
    const full = await s.ack("d", 0);
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe("too_many_consumers");
    // Once idle past the retention period, the longest-idle one makes room.
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    s.ctx.db.run("UPDATE listener_cursors SET last_seen_at = ?, updated_at = ? WHERE consumer IN ('a', 'c')", old, old);
    s.ctx.db.run("UPDATE listener_cursors SET last_seen_at = ? WHERE consumer = 'a'", new Date(Date.now() - 50 * 86_400_000).toISOString());
    expect((await s.ack("d", 0)).status).toBe(200);
    expect(s.ctx.policy.getAgent(s.agent.id)!.listeners.map((l) => l.consumer)).toEqual(["b", "c", "d"]);
  });

  it("refuses browser requests on the stream", async () => {
    const s = await setup();
    const res = await fetch(`${s.url}/agent/v1/events/stream`, { headers: { authorization: `Bearer ${s.apiKey}`, origin: "http://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("disconnects a client that stops reading", async () => {
    const s = await setup({ heartbeatMs: 50 });
    const baseline = s.ctx.bus.listenerCount("event");
    const res = await fetch(`${s.url}/agent/v1/events/stream?include_body=1&consumer=stalled`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    expect(res.status).toBe(200);
    // Never read: ~40 MB of bodies fill the socket buffers and the server's writes stall.
    for (let i = 0; i < 40; i++) emitMessage(s.ctx, "acc_a", `big${i}`);
    const waitFor = async (pred: () => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (!pred() && Date.now() < deadline) await new Promise((x) => setTimeout(x, 20));
      return pred();
    };
    expect(await waitFor(() => s.ctx.bus.listenerCount("event") === baseline, 5000)).toBe(true);
    expect(s.ctx.policy.getAgent(s.agent.id)!.listeners[0]!.connected).toBe(false);
    void res.body?.cancel().catch(() => {});
  });

  it("cuts the connection when a stalled client can't take the revoked frame", async () => {
    // Heartbeat far away: only the revoked-frame timeout can end this stream.
    const s = await setup({ heartbeatMs: 60_000, revokeWriteTimeoutMs: 200 });
    const agentBaseline = s.ctx.bus.listenerCount("agent");
    const waitFor = async (pred: () => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (!pred() && Date.now() < deadline) await new Promise((x) => setTimeout(x, 20));
      return pred();
    };
    const res2 = await fetch(`${s.url}/agent/v1/events/stream?include_body=1&consumer=stalled2`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    for (let i = 40; i < 80; i++) emitMessage(s.ctx, "acc_a", `big${i}`);
    await new Promise((x) => setTimeout(x, 100));
    s.ctx.policy.updateAgent(s.agent.id, { disabled: true });
    expect(await waitFor(() => s.ctx.bus.listenerCount("agent") === agentBaseline, 2000)).toBe(true);
    void res2.body?.cancel().catch(() => {});
  });
});

describe("consumer start and reversible refusals", () => {
  it("starts a new consumer at the head unless it asks for the beginning; existing ones resume", async () => {
    const s = await setup();
    const old = ["m1", "m2", "m3"].map((id) => emitMessage(s.ctx, "acc_a", id));
    emitMessage(s.ctx, "acc_b", "b1"); // invisible: the head is the newest visible event
    const me = await (await fetch(`${s.url}/agent/v1/me`, { headers: { authorization: `Bearer ${s.apiKey}` } })).json();
    expect((me as { headSeq: number }).headSeq).toBe(old[2]);

    let fresh = await s.open("?consumer=fresh&start=now");
    const live = emitMessage(s.ctx, "acc_a", "m4");
    await fresh.until(() => fresh.mail().length >= 1);
    expect(seqs(fresh)).toEqual([live]);
    expect(s.ctx.policy.getAgent(s.agent.id)!.listeners.find((l) => l.consumer === "fresh")!.ackedSeq).toBe(old[2]);
    fresh.cancel();

    // Default (no start) is the head too.
    const dflt = await fetch(`${s.url}/agent/v1/events/stream?consumer=dflt`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    const reader = new SseReader(dflt);
    readers.push(reader);
    const next = emitMessage(s.ctx, "acc_a", "m5");
    await reader.until(() => reader.mail().length >= 1);
    expect(seqs(reader)).toEqual([next]);

    const all = await s.open("?consumer=history&start=beginning");
    await all.until(() => all.mail().length >= 5);
    expect(seqs(all)).toEqual([...old, live, next]);
    all.cancel();

    // An existing consumer resumes from its cursor; start=beginning no longer applies.
    expect(await (await s.ack("history", old[0]!)).json()).toEqual({ ackedSeq: old[0] });
    fresh = await s.open("?consumer=history&start=beginning");
    await fresh.until(() => fresh.mail().length >= 4);
    expect(seqs(fresh)).toEqual([old[1], old[2], live, next]);
    expect((await fetch(`${s.url}/agent/v1/events/stream?start=later`, { headers: { authorization: `Bearer ${s.apiKey}` } })).status).toBe(400);
  });

  it("/me reports where each consumer started (null when created by an ack), plus grant restrictions", async () => {
    const s = await setup();
    const old = ["m1", "m2"].map((id) => emitMessage(s.ctx, "acc_a", id));
    const now = await s.open("?consumer=listener&start=now");
    const all = await s.open("?consumer=history&start=beginning");
    await all.until(() => all.mail().length >= 2);
    now.cancel();
    all.cancel();
    emitMessage(s.ctx, "acc_a", "m3");
    expect((await s.ack("acked-only", 0)).status).toBe(200);
    // Reconnecting never moves the recorded start.
    const again = await s.open("?consumer=listener&start=beginning");
    again.cancel();
    const me = (await (await fetch(`${s.url}/agent/v1/me`, { headers: { authorization: `Bearer ${s.apiKey}` } })).json()) as AgentSelf;
    const by = Object.fromEntries(me.consumers!.map((c) => [c.consumer, c.startSeq]));
    expect(by).toEqual({ listener: old[1], history: 0, "acked-only": null });
    expect(me.grants[0]).toMatchObject({ level: "read", allowTo: expect.any(Array) });
  });

  it("reserves the -replay / -dry-run suffixes: never acknowledged, always created at 0", async () => {
    const s = await setup();
    const old = ["m1", "m2"].map((id) => emitMessage(s.ctx, "acc_a", id));
    for (const name of ["c-replay", "c-dry-run"]) {
      const res = await s.ack(name, old[1]!);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/reserved/);
    }
    // Even without start=beginning, a throwaway cursor starts at 0 (a backfill replays everything).
    const r = await s.open("?consumer=c-replay&start=now");
    await r.until(() => r.mail().length >= 2);
    expect(seqs(r)).toEqual(old);
    r.cancel();
    const me = (await (await fetch(`${s.url}/agent/v1/me`, { headers: { authorization: `Bearer ${s.apiKey}` } })).json()) as AgentSelf;
    expect(me.consumers).toEqual([{ consumer: "c-replay", startSeq: 0, ackedSeq: 0, connected: expect.any(Boolean) }]);
    expect((await s.ack("c-replayed", 0)).status).toBe(200); // only the suffix is reserved
  });

  it("/me lists only this agent's consumers", async () => {
    const s = await setup();
    const other = s.ctx.policy.createAgent({ name: "Other", grants: [readGrant("acc_a")] });
    expect((await s.ack("mine", 0)).status).toBe(200);
    expect((await s.ack("theirs", 0, other.apiKey)).status).toBe(200);
    const me = (await (await fetch(`${s.url}/agent/v1/me`, { headers: { authorization: `Bearer ${s.apiKey}` } })).json()) as AgentSelf;
    expect(me.consumers!.map((c) => c.consumer)).toEqual(["mine"]);
  });

  it("accepts consumer names up to 100 characters", async () => {
    const s = await setup();
    expect((await s.ack("a".repeat(100), 0)).status).toBe(200);
    expect((await s.ack("host-name.example_profile", 0)).status).toBe(200);
    expect((await s.ack("a".repeat(101), 0)).status).toBe(400);
    expect((await s.ack("with space", 0)).status).toBe(400);
  });

  it("answers a disabled agent's key with 403 agent_disabled (reversible), unknown keys with 401", async () => {
    const s = await setup();
    s.ctx.policy.updateAgent(s.agent.id, { disabled: true });
    for (const path of ["/agent/v1/me", "/agent/v1/events/stream"]) {
      const res = await fetch(`${s.url}${path}`, { headers: { authorization: `Bearer ${s.apiKey}` } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("agent_disabled");
    }
    s.ctx.policy.updateAgent(s.agent.id, { disabled: false });
    s.ctx.policy.deleteGrant(s.agent.id, "acc_a");
    const noGrant = await fetch(`${s.url}/agent/v1/events/stream`, { headers: { authorization: `Bearer ${s.apiKey}` } });
    expect(noGrant.status).toBe(403);
    expect(((await noGrant.json()) as { error: { code: string } }).error.code).toBe("no_read_grant");
    const { apiKey: rotated } = s.ctx.policy.rotateKey(s.agent.id);
    expect((await fetch(`${s.url}/agent/v1/me`, { headers: { authorization: `Bearer ${s.apiKey}` } })).status).toBe(401);
    expect((await fetch(`${s.url}/agent/v1/me`, { headers: { authorization: `Bearer ${rotated}` } })).status).toBe(200);
  });
});

