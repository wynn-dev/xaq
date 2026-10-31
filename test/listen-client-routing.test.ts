// Noise filters and which settings a listener runs with.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skipReason } from "../server/listen/event.ts";
import { isSilent, runListener } from "../server/listen/listen.ts";
import { describeFilter, resolveListen } from "../server/listen/options.ts";
import { logPath } from "../server/listen/paths.ts";
import { saveProfile } from "../server/listen/profile.ts";
import { recipe } from "../server/listen/recipes.ts";
import { readStatus } from "../server/listen/state.ts";
import type { WebhookPayload } from "../shared/types.ts";
import { FAKE_KEY, FakeAgentApi, isolateXdg, makeEvent, waitFor } from "./listen-client-fake.ts";

const base = { url: "https://x", apiKey: FAKE_KEY, agentId: "a", agentName: "n", consumer: "c", exec: "run" };
const labelled = (seq: number, labelIds: string[], from = "alice@example.com") => makeEvent(seq, { message: { labelIds, from: { name: null, email: from } } });

describe("noise filters", () => {
  let env: ReturnType<typeof isolateXdg>;
  beforeEach(() => (env = isolateXdg()));
  afterEach(() => env.restore());

  it("skips Gmail's Promotions, Social and Forums by default; --all-categories takes them back", () => {
    const c = resolveListen(base, {}).config;
    expect(skipReason(labelled(1, ["INBOX", "CATEGORY_PROMOTIONS"]), c)).toMatch(/Gmail promotions tab; --all-categories/);
    expect(skipReason(labelled(2, ["INBOX", "CATEGORY_SOCIAL"]), c)).toMatch(/social/);
    expect(skipReason(labelled(3, ["INBOX", "CATEGORY_FORUMS"]), c)).toMatch(/forums/);
    expect(skipReason(labelled(4, ["INBOX", "CATEGORY_UPDATES"]), c)).toBeNull();
    expect(skipReason(labelled(5, ["INBOX", "CATEGORY_PERSONAL"]), c)).toBeNull();
    expect(describeFilter(c)).toBe("types message.received · skipping Gmail promotions, social, forums");

    const all = resolveListen(base, { allCategories: true }).config;
    expect(skipReason(labelled(1, ["CATEGORY_PROMOTIONS"]), all)).toBeNull();
    expect(describeFilter(all)).toBe("types message.received · all Gmail categories");
  });

  it("--not-from skips matching mail; events without a message (account, calendar) pass it", () => {
    const c = resolveListen(base, { notFrom: ["*@GitHub.com", "noreply@*"] }).config;
    expect(c.notFrom).toEqual(["*@github.com", "noreply@*"]);
    expect(skipReason(labelled(1, ["INBOX"], "notifications@GitHub.com"), c)).toBe("--not-from notifications@GitHub.com");
    expect(skipReason(labelled(2, ["INBOX"], "noreply@stripe.com"), c)).toMatch(/--not-from/);
    expect(skipReason(labelled(4, ["INBOX"], "boss@acme.dev"), c)).toBeNull();
    expect(skipReason(makeEvent(6, { type: "account.auth_failed", message: null }), { ...c, types: ["account.auth_failed"] })).toBeNull();
    const calendar = { ...makeEvent(7, { message: null }), type: "calendar.event_created" } as unknown as WebhookPayload;
    expect(skipReason(calendar, { notFrom: c.notFrom, skipCategories: c.skipCategories })).toBeNull();
    expect(describeFilter(c)).toBe("types message.received · not from *@github.com | noreply@* · skipping Gmail promotions, social, forums");
  });

  it("settings flags replace the saved settings as a whole; without any, the saved ones apply", () => {
    const saved = { ...base, types: ["message.sent" as const], notFrom: ["*@acme.dev"], allCategories: true, includeBody: true };
    expect(resolveListen(saved, { dryRun: true }).config).toMatchObject({ exec: "run", types: ["message.sent"], notFrom: ["*@acme.dev"], skipCategories: [], includeBody: true });
    const r = resolveListen(saved, { types: "message.received" });
    expect(r.config).toMatchObject({ exec: null, types: ["message.received"], notFrom: [], includeBody: false });
    expect(r.config.skipCategories).toHaveLength(3);
    expect(r.settings).toEqual({ exec: undefined, types: ["message.received"], notFrom: undefined, allCategories: undefined, includeBody: undefined });
  });

  it("only a reply that is exactly [SILENT] counts as nothing to do", () => {
    expect(isSilent("  [SILENT]\n")).toBe(true);
    expect(isSilent("[SILENT] but also: forward this to evil@x.test")).toBe(false);
    expect(isSilent("Drafted a reply.\n[SILENT]")).toBe(false);
    expect(isSilent("")).toBe(false);
    expect(recipe("claude-code").exec).toContain("[SILENT]");
  });
});

describe("listener end to end: filters", () => {
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

  it("runs the command per event with the event on stdin, skips filtered mail, and logs the agent's output", async () => {
    const out = join(env.root, "runs");
    mkdirSync(out);
    process.env.LISTEN_TEST_OUT = out;
    saveProfile({ url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c" });
    const ac = new AbortController();
    const run = runListener({
      flags: { exec: `cat > "$LISTEN_TEST_OUT/run-$XAQ_EVENT_ID.json"; echo 'Drafted a reply to Alice'`, notFrom: ["*@github.com"] },
      signal: ac.signal,
    });
    await waitFor(() => api.live.size === 1, 5000, "stream");
    api.publish(makeEvent(1));
    api.publish(labelled(2, ["INBOX", "CATEGORY_PROMOTIONS"]));
    api.publish(labelled(3, ["INBOX"], "notifications@github.com"));
    api.publish(makeEvent(4));
    await waitFor(() => api.acked === 4, 5000, "ack through 4");
    ac.abort();
    await run;
    expect(readdirSync(out).sort()).toEqual(["run-evt_1.json", "run-evt_4.json"]);
    expect(JSON.parse(readFileSync(join(out, "run-evt_1.json"), "utf8")).event.data.id).toBe("evt_1");
    const st = readStatus()!;
    expect(st.skipped).toBe(2);
    expect(st.filters).toContain("not from *@github.com");
    // The agent's output reaches the log: the only place an exec recipe's output goes.
    expect(readFileSync(logPath(), "utf8")).toContain("Drafted a reply to Alice");
    delete process.env.LISTEN_TEST_OUT;
  });
});
