import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getSelf } from "../server/listen/api.ts";
import { EXIT, runListener, type RunListenerOptions } from "../server/listen/listen.ts";
import { EventStream } from "../server/listen/stream.ts";
import { saveProfile } from "../server/listen/profile.ts";
import { readStatus } from "../server/listen/state.ts";
import { FAKE_KEY, FakeAgentApi, isolateXdg, makeEvent, waitFor } from "./listen-client-fake.ts";

let api: FakeAgentApi;
let env: ReturnType<typeof isolateXdg>;
let out: string;
let output = "";

beforeEach(async () => {
  env = isolateXdg();
  api = await new FakeAgentApi().start();
  out = join(env.root, "handled.txt");
  // Inherited by the command (only XAQ_* variables are stripped).
  process.env.LISTEN_TEST_OUT = out;
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => ((output += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((output += String(c)), true));
  saveProfile({
    url: api.url,
    apiKey: FAKE_KEY,
    agentId: "agt_1",
    agentName: "Test agent",
    consumer: "testhost-default",
    exec: `printf '%s\\n' "$XAQ_EVENT_SEQ" >> "$LISTEN_TEST_OUT"`,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.LISTEN_TEST_OUT;
  await api.stop().catch(() => {});
  env.restore();
});

const handled = () => (existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);

function start(extra: Partial<RunListenerOptions> = {}) {
  const ac = new AbortController();
  const done = runListener({ flags: {}, signal: ac.signal, minBackoffMs: 50, maxBackoffMs: 200, retryDelayMs: () => 20, ...extra });
  return { stop: () => ac.abort(), done };
}

describe("listen stream", () => {
  it("resumes after drops and a daemon restart without losing or duplicating events", async () => {
    const l = start();
    await waitFor(() => api.live.size === 1, 5000, "stream");
    expect(api.streamRequests[0]).toMatchObject({ consumer: "testhost-default", authorization: `Bearer ${FAKE_KEY}`, lastEventId: null });
    expect(api.streamRequests[0]!.userAgent).toMatch(/^xaq\//);
    // The daemon reads listener client info from this header (server/agentapi/stream.ts).
    expect(JSON.parse(api.streamRequests[0]!.client!)).toEqual({ hostname: hostname(), platform: process.platform, version: expect.any(String) });

    for (const s of [1, 2, 3]) api.publish(makeEvent(s));
    await waitFor(() => handled().length === 3, 5000, "first batch");

    // Network drop mid-stream; events keep arriving at the daemon meanwhile.
    api.dropConnections();
    for (const s of [4, 5, 6]) api.publish(makeEvent(s));
    await waitFor(() => handled().length === 6, 5000, "second batch");
    const reconnect = api.streamRequests[1]!;
    expect(Number(reconnect.lastEventId)).toBeGreaterThanOrEqual(3);

    // The daemon goes away entirely and comes back on the same port.
    await api.stop();
    api.events.push(makeEvent(7));
    await new Promise((r) => setTimeout(r, 300));
    await api.restart();
    await waitFor(() => handled().length === 7, 8000, "after restart");
    await waitFor(() => api.acked === 7, 5000, "final ack");

    expect(handled().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    l.stop();
    expect(await l.done).toBe(EXIT.ok);
    const st = readStatus()!;
    expect(st).toMatchObject({ ackedSeq: 7, receivedSeq: 7, connected: false, exitReason: "stopped" });
    expect(output).toContain("Connected");
    expect(output).toContain("Disconnected");
    expect(output).not.toContain(FAKE_KEY);
  });

  it("detects a stalled stream (no pings) and reconnects", async () => {
    api.sendPings = false;
    const l = start({ stallMs: 300 });
    await waitFor(() => api.streamRequests.length >= 3, 5000, "reconnects after stalls");
    expect(output).toMatch(/stream stalled/);
    l.stop();
    await l.done;
  });

  it("exits with the revoked code on `event: revoked`", async () => {
    const l = start();
    await waitFor(() => api.live.size === 1, 5000, "stream");
    api.revoke("key_rotated");
    expect(await l.done).toBe(EXIT.revoked);
    expect(output).toContain("Access revoked: This agent's API key was replaced (rotated)");
    expect(output).toContain("connect");
    expect(readStatus()!.exitReason).toMatch(/revoked/);
  });

  it("exits with the revoked code when the key is rejected (401)", async () => {
    api.keyValid = false;
    const l = start();
    expect(await l.done).toBe(EXIT.revoked);
    expect(output).toContain("Access revoked");
  });

  it("passes types and include_body to the daemon and keeps the server cursor in charge", async () => {
    api.acked = 5;
    for (const s of [3, 4, 5, 6]) api.events.push(makeEvent(s));
    const l = start({ flags: { exec: `printf '%s\\n' "$XAQ_EVENT_SEQ" >> "$LISTEN_TEST_OUT"`, types: "message.received,label.added", includeBody: true } });
    await waitFor(() => handled().length === 1, 5000, "event after the cursor");
    expect(handled()).toEqual([6]);
    expect(api.streamRequests[0]).toMatchObject({ types: "message.received,label.added", includeBody: "1" });
    l.stop();
    await l.done;
  });
});

describe("abort always wins (undici may not settle on abort under load)", () => {
  const never = <T>() => new Promise<T>(() => {});
  /** A response whose body reads never settle, even after cancel: what a stuck undici body looks like. */
  const stuckResponse = () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: { getReader: () => ({ read: () => never(), cancel: async () => {} }) },
    }) as unknown as Response;
  const base = { url: "http://127.0.0.1:1", apiKey: FAKE_KEY, consumer: "c", lastEventId: () => 0, onMessage: () => {}, minBackoffMs: 10, maxBackoffMs: 20 };

  it("stop() ends the stream while a body read is stuck, or while fetch itself never settles", async () => {
    for (const stuck of ["body", "fetch"] as const) {
      let fetched = false;
      let opened = false;
      const fetchImpl = (() => {
        fetched = true;
        return stuck === "body" ? Promise.resolve(stuckResponse()) : never<Response>();
      }) as typeof fetch;
      const s = new EventStream({ ...base, fetch: fetchImpl, onOpen: () => (opened = true), onDisconnect: () => {} });
      const run = s.run();
      // Wait on the stream's own state: reading the open stream, or with the fetch in flight.
      await waitFor(() => (stuck === "body" ? opened : fetched), 2000, `stuck ${stuck}`);
      s.stop();
      const result = await Promise.race([run, new Promise((r) => setTimeout(() => r("still running"), 2000))]);
      expect(result).toEqual({ kind: "stopped" });
    }
  });

  it("the stall timer still reconnects when a stuck read never returns", async () => {
    const reasons: string[] = [];
    let calls = 0;
    const s = new EventStream({ ...base, stallMs: 50, fetch: (async () => (calls++, stuckResponse())) as typeof fetch, onOpen: () => {}, onDisconnect: (r) => reasons.push(r) });
    const run = s.run();
    await waitFor(() => calls >= 2, 5000, "reconnect after the stall");
    s.stop();
    await run;
    expect(reasons[0]).toMatch(/stream stalled/);
  });

  it("API calls time out even when fetch never settles", async () => {
    vi.stubGlobal("fetch", () => never());
    try {
      const err = await Promise.race([getSelf("http://127.0.0.1:1", FAKE_KEY, 50).catch((e: unknown) => e), new Promise((r) => setTimeout(() => r("still waiting"), 2000))]);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toMatch(/timed out/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
