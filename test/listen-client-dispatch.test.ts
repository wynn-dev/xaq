import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dispatcher, type Job } from "../server/listen/dispatcher.ts";
import { runListener } from "../server/listen/listen.ts";
import { EVENT_TYPES } from "../shared/types.ts";
import { describeFilter, resolveListen, typesNotes } from "../server/listen/options.ts";
import { recipe, recipesHelp } from "../server/listen/recipes.ts";
import { saveProfile } from "../server/listen/profile.ts";
import { readStatus } from "../server/listen/state.ts";
import { FAKE_KEY, FakeAgentApi, isolateXdg, makeEvent, waitFor } from "./listen-client-fake.ts";

describe("dispatcher", () => {
  it("acknowledges only the contiguous prefix of finished events", async () => {
    const release = new Map<number, (error: string | null) => void>();
    const advanced: number[] = [];
    const d = new Dispatcher({
      concurrency: 3,
      maxAttempts: 1,
      run: (job: Job) => new Promise<string | null>((resolve) => release.set(job.seq, resolve)),
      onAdvance: (seq) => advanced.push(seq),
      onFailed: () => {},
    });
    for (const s of [10, 11, 12, 13]) d.push(makeEvent(s));
    await waitFor(() => release.size === 3, 1000, "three running");
    expect(release.has(13)).toBe(false); // concurrency limit

    release.get(12)!(null);
    await waitFor(() => release.has(13), 1000, "13 starts when a slot frees");
    release.get(11)!(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(advanced).toEqual([]); // 10 is still running: nothing may be acked

    release.get(10)!("boom"); // failed (maxAttempts 1) still counts as finished
    await waitFor(() => advanced.length === 1, 1000, "advance");
    expect(advanced).toEqual([12]);
    release.get(13)!(null);
    await waitFor(() => advanced.length === 2, 1000, "advance to 13");
    expect(advanced).toEqual([12, 13]);
    expect(d.finishedThrough).toBe(13);
  });

  it("skips filtered events immediately and ignores duplicates", () => {
    const advanced: number[] = [];
    const d = new Dispatcher({ concurrency: 1, maxAttempts: 1, run: async () => null, onAdvance: (s) => advanced.push(s), onFailed: () => {} });
    expect(d.push(makeEvent(6), { skip: true })).toBe(true);
    expect(d.push(makeEvent(6))).toBe(false);
    expect(advanced).toEqual([6]);
  });
});

describe("listener settings", () => {
  const profile = { url: "https://x", apiKey: FAKE_KEY, agentId: "a", agentName: "n", consumer: "c", exec: "old" };

  it("--recipe claude-code is the built-in command as the exec; it excludes --exec and unknown recipes", () => {
    const r = resolveListen(profile, { recipe: "claude-code" });
    expect(r.config.exec).toBe(recipe("claude-code").exec);
    expect(r.config.exec).toContain("default.claude.json");
    expect(r.settings.exec).toBe(r.config.exec);
    expect(resolveListen(profile, { recipe: "Claude" }).config.exec).toBe(recipe("claude-code").exec);
    expect(() => resolveListen(profile, { recipe: "claude-code", exec: "x" })).toThrow(/--recipe and --exec can't be combined/);
    expect(() => resolveListen(profile, { recipe: "codex" })).toThrow(/Unknown --recipe "codex"\. The built-in recipe is claude-code; for any other agent, pass your own command with --exec/);
    expect(() => resolveListen(profile, { exec: " " })).toThrow(/--exec needs a command/);
    expect(() => resolveListen(profile, { types: "message.received,nope" })).toThrow(/Unknown event type nope/);
  });

  it("wakes only on new mail unless --types or the profile asks for more", () => {
    // One test email produces message.sent and message.received: only the latter starts the agent.
    expect(resolveListen(profile, {}).config.types).toEqual(["message.received"]);
    // Without --types nothing is saved, so the saved settings keep following the default.
    expect(resolveListen(profile, { exec: "run" }).settings.types).toBeUndefined();
    const opted = resolveListen(profile, { types: "message.received,thread.reply_received" });
    expect(opted.config.types).toEqual(["message.received", "thread.reply_received"]);
    expect(opted.settings.types).toEqual(["message.received", "thread.reply_received"]);
    expect(resolveListen({ ...profile, types: ["message.sent"] }, {}).config.types).toEqual(["message.sent"]);
    const all = resolveListen(profile, { types: "all" }).config;
    expect(all.types).toContain("message.sent");
    expect(all.types).toContain("sync.gap");
    expect(describeFilter(all)).toBe("all event types · skipping Gmail promotions, social, forums");
    expect(describeFilter(resolveListen(profile, {}).config)).toBe("types message.received · skipping Gmail promotions, social, forums");
    expect(() => resolveListen(profile, { types: "" })).toThrow(/at least one event type/);
    expect(() => resolveListen(profile, { types: "all,message.sent" })).toThrow(/can't be combined/);
  });

  it("says when the default types are in use, and warns when replies would run twice", () => {
    const defaulted = resolveListen(profile, {}).config;
    expect(defaulted.typesDefaulted).toBe(true);
    expect(typesNotes(defaulted).info).toEqual(["Using default types: message.received (add --types all for every event)."]);
    expect(resolveListen({ ...profile, types: ["message.received"] }, {}).config.typesDefaulted).toBe(false);
    // A reply produces message.received AND thread.reply_received (server/ingest/sync.ts).
    const both = resolveListen(profile, { types: "message.received,thread.reply_received" }).config;
    expect(typesNotes(both)).toEqual({ info: [], warn: [expect.stringMatching(/subset of message\.received.*twice/)] });
    expect(typesNotes(resolveListen(profile, { types: "thread.reply_received" }).config).warn).toEqual([]);
    // --types all is recommended in several places: a dedupe note, not the "keep one of them" warning.
    expect(typesNotes(resolveListen(profile, { types: "all" }).config)).toEqual({
      info: ["With all types, each reply also arrives as thread.reply_received: dedupe on the message id."],
      warn: [],
    });
    expect(typesNotes(resolveListen({ ...profile, types: [...EVENT_TYPES] }, {}).config).warn).toEqual([]);
  });

  it("never suggests combining message.received with thread.reply_received (each reply would run twice)", () => {
    const both = /message\.received,\s*thread\.reply_received|thread\.reply_received,\s*message\.received/;
    const texts: Record<string, string> = {
      "listen --help": recipesHelp(),
      "docs/listen.md": readFileSync(join(import.meta.dirname, "../docs/listen.md"), "utf8"),
      "docs/reference.md": readFileSync(join(import.meta.dirname, "../docs/reference.md"), "utf8"),
      "SKILL.md": readFileSync(join(import.meta.dirname, "../server/skill/SKILL.md"), "utf8"),
      "connect.ts": readFileSync(join(import.meta.dirname, "../server/listen/connect.ts"), "utf8"),
    };
    for (const [name, text] of Object.entries(texts)) expect(both.test(text), name).toBe(false);
    for (const name of ["listen --help", "docs/listen.md", "docs/reference.md", "SKILL.md"]) expect(texts[name], name).toMatch(/subset of\s+`?message\.received/);
  });
});

describe("retries", () => {
  let api: FakeAgentApi;
  let env: ReturnType<typeof isolateXdg>;
  beforeEach(async () => {
    env = isolateXdg();
    api = await new FakeAgentApi().start();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await api.stop();
    env.restore();
  });

  it("retries with backoff, then gives up on the event, keeps going, and acknowledges it", async () => {
    const attempts = join(env.root, "attempts.txt");
    process.env.LISTEN_TEST_OUT = attempts;
    saveProfile({ url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c" });
    const ac = new AbortController();
    const delays: number[] = [];
    const run = runListener({
      // Event 1 always fails; the others succeed.
      flags: { exec: `echo "$XAQ_EVENT_SEQ" >> "$LISTEN_TEST_OUT"; [ "$XAQ_EVENT_SEQ" != 1 ]`, notFrom: ["*@other.org"] },
      signal: ac.signal,
      retryDelayMs: (n) => {
        delays.push(n);
        return 10;
      },
    });
    await waitFor(() => api.live.size === 1, 5000, "stream");
    api.publish(makeEvent(1));
    api.publish(makeEvent(2));
    api.publish(makeEvent(3, { message: { from: { name: null, email: "x@other.org" } } })); // filtered out
    await waitFor(() => api.acked === 3, 5000, "ack through 3");
    ac.abort();
    await run;

    const lines = readFileSync(attempts, "utf8").trim().split("\n");
    expect(lines.filter((l) => l === "1")).toHaveLength(5);
    expect(lines.filter((l) => l === "2")).toHaveLength(1);
    expect(lines).not.toContain("3");
    expect(delays).toEqual([1, 2, 3, 4]);
    // Acks only move forward (the strict prefix rule is covered by the dispatcher test above).
    expect([...api.acks].sort((a, b) => a - b)).toEqual(api.acks);
    expect(api.acks.at(-1)).toBe(3);
    expect(readStatus()!.recent.find((r) => r.seq === 1)).toMatchObject({ outcome: "failed", attempts: 5 });
    delete process.env.LISTEN_TEST_OUT;
  });
});
