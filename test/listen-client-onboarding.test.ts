// Zero-context onboarding of the agent-side CLI: what `connect`, `setup-mcp` and `listen` tell a
// first-time user (actual grant, approve link, MCP changes, backfill, transport refusals, next steps).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../server/config.ts";
import { printStatus } from "../server/listen/admin.ts";
import { approveLinks, CONNECT_EXIT, runConnect } from "../server/listen/connect.ts";
import { describeGrant, describeGrants } from "../server/listen/grants.ts";
import { EXIT, runListener, type RunListenerOptions } from "../server/listen/listen.ts";
import { backfillLockPath, lockPath } from "../server/listen/lock.ts";
import { helperScriptPath } from "../server/listen/mcpheader.ts";
import { setupMcp } from "../server/listen/mcpsetup.ts";
import { throwawayConsumer } from "../server/listen/options.ts";
import { readStatus } from "../server/listen/state.ts";
import { saveProfile } from "../server/listen/profile.ts";
import { checkTransport } from "../server/listen/transport.ts";
import { FAKE_KEY, FakeAgentApi, isolateXdg, makeEvent, waitFor } from "./listen-client-fake.ts";

let api: FakeAgentApi;
let env: ReturnType<typeof isolateXdg>;
let output = "";

beforeEach(async () => {
  env = isolateXdg();
  api = await new FakeAgentApi().start();
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => ((output += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((output += String(c)), true));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await api.stop().catch(() => {});
  env.restore();
});

// eslint-disable-next-line no-control-regex
const plain = () => output.replace(/\x1b\[[0-9;]*m/g, "");
const approved = () => ({
  status: "approved" as const,
  apiKey: FAKE_KEY,
  agent: { id: "agt_1", name: "Claude Code on testhost" },
  mcpUrl: `${api.url}/mcp`,
  skillUrl: `${api.url}/skill.md`,
});
const baseProfile = () => ({ url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c", exec: "cat > /dev/null" });
function start(extra: Partial<RunListenerOptions> = {}) {
  const ac = new AbortController();
  const done = runListener({ flags: {}, signal: ac.signal, minBackoffMs: 50, maxBackoffMs: 200, blockedRetryMs: 100, ...extra });
  return { stop: () => ac.abort(), done };
}

describe("grants in plain words", () => {
  const g = (capabilities: string[], sendMode: "draft_only" | "approval" | "direct", labelScope: string[] | null = null) =>
    ({ accountId: "a", accountEmail: "ops@acme.dev", capabilities, labelScope, sendMode }) as Parameters<typeof describeGrant>[0];

  it("matches the console's choices", () => {
    expect(describeGrant(g(["read"], "draft_only"))).toBe("ops@acme.dev: read only (can't draft or send)");
    expect(describeGrant(g(["read", "draft", "send"], "draft_only"))).toBe("ops@acme.dev: read, draft, send; sends become Gmail drafts for you to send");
    expect(describeGrant(g(["read", "draft", "send", "organize"], "approval"))).toBe("ops@acme.dev: read, draft, send, organize; sends need your approval in the console");
    expect(describeGrant(g(["read", "draft", "send"], "direct"))).toBe("ops@acme.dev: read, draft, send; sends go out directly");
    expect(describeGrant(g(["read", "draft"], "draft_only"))).toBe("ops@acme.dev: read, draft; can't send");
    expect(describeGrant(g(["read"], "draft_only", ["INBOX"]))).toContain("only label INBOX");
    expect(describeGrant({ ...g(["read", "send"], "direct"), allowTo: ["*@acme.dev"], replyOnly: true, maxSendsPerHour: 5, maxSendsPerDay: null })).toBe(
      "ops@acme.dev: read, send; sends go out directly to allowed recipients; only to *@acme.dev; replies in existing threads only; at most 5/hour",
    );
    expect(describeGrants([])[0]).toMatch(/no mailbox or calendar access yet/);
    expect(describeGrants([], [{ name: "WHOOP", slug: "whoop", level: "read" }])).toEqual(["WHOOP (whoop__… tools): read only"]);
    expect(describeGrants([g(["read"], "draft_only")], [{ name: "Notion", slug: "notion", level: "full" }])).toEqual([
      "ops@acme.dev: read only (can't draft or send)",
      "Notion (notion__… tools): full access",
    ]);
    expect(describeGrant(g(["calendar.read"], "draft_only"))).toBe("ops@acme.dev: calendar.read");
    expect(describeGrant(g(["read", "calendar.read"], "draft_only"))).toBe("ops@acme.dev: read, calendar.read; mail read only (can't draft or send)");
    expect(describeGrant({ ...g(["read", "calendar.read", "calendar.write"], "draft_only"), calendarScope: ["team@group.calendar.google.com"] })).toBe(
      "ops@acme.dev: read, calendar.read, calendar.write; mail read only (can't draft or send); calendar changes need your approval in the console; only calendar team@group.calendar.google.com",
    );
    expect(describeGrant({ ...g(["read", "calendar.write"], "draft_only"), calendarWriteMode: "direct" })).toBe("ops@acme.dev: read, calendar.write; mail read only (can't draft or send); calendar changes apply directly");
  });
});

describe("connect", () => {
  it("prints the grant the approver actually chose (not a draft-only boilerplate)", async () => {
    api.grants = [{ accountId: "acc_1", accountEmail: "ops@acme.dev", capabilities: ["read", "draft", "send", "organize"], labelScope: null, sendMode: "approval" }];
    api.pollScript = [approved()];
    expect(await runConnect(api.url, { tool: "claude-code" }, { pollIntervalMs: 10 })).toBe(CONNECT_EXIT.approved);
    expect(plain()).toContain("Access granted");
    expect(plain()).toContain("ops@acme.dev: read, draft, send, organize; sends need your approval in the console");
    expect(plain()).not.toMatch(/New grants are draft-only/);
    expect(output).not.toContain(FAKE_KEY);
  });

  it("says so when no mailbox was granted", async () => {
    api.grants = [];
    api.pollScript = [approved()];
    await runConnect(api.url, {}, { pollIntervalMs: 10 });
    expect(plain()).toContain("no mailbox or calendar access yet");
  });

  it("lists connection access, and drops the mail-only next steps without a mailbox", async () => {
    api.grants = [];
    api.connections = [{ name: "Notion", slug: "notion", level: "ask" }];
    api.pollScript = [approved()];
    expect(await runConnect(api.url, { tool: "hermes" }, { pollIntervalMs: 10 })).toBe(CONNECT_EXIT.approved);
    const text = plain();
    expect(text).toContain("Notion (notion__… tools): ask before risky actions");
    expect(text).not.toContain("no mailbox or calendar access yet");
    expect(text).not.toContain("sends a test email");
    expect(text).not.toContain("when mail arrives");
    expect(text).toContain("--types connection.auth_failed,connection.expiring");
  });

  it("uses the address the CLI connected to for the approve link when the public URL differs", async () => {
    api.publicUrl = `http://localhost:${api.port}`;
    api.pollScript = [{ status: "expired" }];
    await runConnect(api.url, {}, { pollIntervalMs: 10 });
    const lines = plain().split("\n");
    const open = lines.find((l) => l.includes("Open:"))!;
    expect(open).toContain(`${api.url}/approvals?pairing=K7QM-2XPD`);
    const or = lines.find((l) => l.includes("or:"))!;
    expect(or).toContain(`http://localhost:${api.port}/approvals?pairing=K7QM-2XPD`);
    expect(plain()).toContain("the console's public URL");
  });

  it("approveLinks: same origin keeps the daemon's link; a path prefix we connected through is kept", () => {
    const start = { userCode: "AB12-CD34", verificationUrl: "http://localhost:8425/approvals?pairing=AB12-CD34" };
    expect(approveLinks("http://localhost:8425", start)).toEqual({ primary: start.verificationUrl, publicUrl: null });
    expect(approveLinks("http://127.0.0.1:8425", start)).toEqual({ primary: "http://127.0.0.1:8425/approvals?pairing=AB12-CD34", publicUrl: start.verificationUrl });
    expect(approveLinks("https://box.example.com/xaq", start).primary).toBe("https://box.example.com/xaq/approvals?pairing=AB12-CD34");
  });

  it("next steps: foreground listen first, then the console's test email, then the service", async () => {
    api.pollScript = [approved()];
    await runConnect(api.url, { tool: "claude-code" }, { pollIntervalMs: 10 });
    const text = plain();
    const fg = text.indexOf("First try it in the foreground");
    const check = text.indexOf('"Check that it works"');
    const svc = text.indexOf("listen service install");
    expect(fg).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(fg);
    expect(svc).toBeGreaterThan(check);
    expect(text).toContain("test email");
    expect(text).toContain("listen --recipe claude-code");
    expect(text).toContain("listen service install --recipe claude-code");
  });
});

describe("setup-mcp", () => {
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  let home: string;
  beforeEach(() => {
    home = join(env.root, "home");
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const target = { url: "https://mail.example.com", apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c" };

  it("--dry-run lists the exact Claude Code commands and changes nothing", () => {
    const bin = join(env.root, "bin");
    mkdirSync(bin);
    const log = join(env.root, "claude-called");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho called >> ${log}\nexit 0\n`);
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    writeFileSync(join(home, ".claude.json"), "{}");

    const r = setupMcp("claude-code", target, "/p.json", { dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true });
    const text = r.changes!.join("\n");
    expect(text).toContain("run: claude mcp remove xaq --scope user");
    expect(text).toContain("run: claude mcp add-json --scope user xaq '");
    expect(text).toContain("headersHelper");
    expect(text).toContain(`back up ${join(home, ".claude.json")}`);
    expect(r.verify!.join(" ")).toContain("claude mcp list");
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(helperScriptPath())).toBe(false);
    expect(readdirSync(home).filter((f) => f.includes("backup"))).toEqual([]);
  });

  it("other tools get the manual steps, without the key", () => {
    const r = setupMcp("codex", target, "/p.json");
    expect(r).toMatchObject({ ok: false, message: "Automatic MCP setup is for Claude Code only." });
    expect(r.manual).toEqual(["MCP endpoint (streamable HTTP): https://mail.example.com/mcp", 'Header: Authorization: Bearer <key>. The key is the "apiKey" field in /p.json.']);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("listen", () => {
  it("shows the access in plain words and logs a grant change", async () => {
    saveProfile(baseProfile());
    const l = start({ grantsRefreshMs: 100 });
    await waitFor(() => plain().includes("me@example.com: read, draft; can't send"), 5000, "initial grants");
    expect(plain()).not.toContain("draft_only");
    api.grants = [{ accountId: "acc_1", accountEmail: "me@example.com", capabilities: ["read", "draft", "send"], labelScope: null, sendMode: "approval" }];
    await waitFor(() => plain().includes("Access changed in the console"), 5000, "grant change");
    expect(plain()).toContain("me@example.com: read, draft, send; sends need your approval in the console");
    const changes = plain().match(/Access changed/g)!.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(plain().match(/Access changed/g)!.length).toBe(changes); // only on a change
    l.stop();
    await l.done;
  });

  it("listen status reports the access in plain words", async () => {
    saveProfile(baseProfile());
    await printStatus();
    expect(plain()).toMatch(/Access\s+me@example.com: read, draft; can't send/);
  });

  // The seqs the handler ran for, sorted: events run two at a time (default --concurrency 2), each `echo >>` its own
  // process, so the order they append in is unspecified (Dispatcher: "events can finish out of order").
  const lines = (file: string) =>
    (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []).sort((a, b) => Number(a) - Number(b));

  it("--backfill replays only the mail from before the listener started, next to the running listener", async () => {
    saveProfile(baseProfile());
    for (const s of [1, 2, 3]) api.events.push(makeEvent(s));
    const listenerRuns = join(env.root, "listener.txt");
    const runs = join(env.root, "backfill.txt");
    // The listener starts at the head (#3) and handles what arrives after it.
    api.acked = 3; // the fake's shared cursor: where a new consumer starts
    const listener = start({ flags: { exec: `echo "$XAQ_EVENT_SEQ" >> ${listenerRuns}` } });
    await waitFor(() => api.live.size === 1, 5000, "listener stream");
    expect(api.consumers.get("c")?.startSeq).toBe(3);
    api.publish(makeEvent(4));
    api.publish(makeEvent(5));
    await waitFor(() => lines(listenerRuns).length === 2, 5000, "listener handled #4, #5");

    const began = Date.now();
    const bf = start({ flags: { backfill: true, exec: `echo "$XAQ_EVENT_SEQ" >> ${runs}` } });
    expect(await bf.done).toBe(EXIT.ok);
    // It stopped at the end seq (#4 arrived past it), not on the 60 s safety net.
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(lines(runs)).toEqual(["1", "2", "3"]);
    expect(lines(listenerRuns)).toEqual(["4", "5"]);
    expect(api.streamRequests.at(-1)).toMatchObject({ consumer: "c-replay", start: "beginning" });
    expect(api.acks.every((a) => a >= 4)).toBe(true); // only the listener acknowledged anything
    expect(plain()).toContain("mail from before the listener started (events up to #3)");
    expect(plain()).toContain("Backfill done: 3 events handled");
    // The listener's lock and status are untouched; the backfill's own lock is gone.
    expect(existsSync(lockPath())).toBe(true);
    expect(existsSync(backfillLockPath())).toBe(false);
    expect(readStatus()?.consumer).toBe("c");
    listener.stop();
    await listener.done;
  });

  it("--backfill refuses when it can't know where the listener started, or when the replay cursor has moved", async () => {
    saveProfile(baseProfile());
    for (const s of [1, 2, 3]) api.events.push(makeEvent(s));
    await expect(start({ flags: { backfill: true } }).done).rejects.toThrow(/hasn't connected yet[\s\S]*Start it first/);
    api.consumers.set("c", { startSeq: null, acked: 3 });
    await expect(start({ flags: { backfill: true } }).done).rejects.toThrow(/doesn't know where consumer "c" started/);
    api.consumers.set("c", { startSeq: 2, acked: 3 });
    api.consumers.set("c-replay", { startSeq: 0, acked: 3 }); // e.g. an older daemon let something ack it
    await expect(start({ flags: { backfill: true } }).done).rejects.toThrow(/"c-replay" on the daemon has been moved to #3/);
  });

  it("--backfill: nothing to do when the listener started at the oldest event", async () => {
    saveProfile(baseProfile());
    api.events.push(makeEvent(1));
    api.consumers.set("c", { startSeq: 0, acked: 1 });
    expect(await start({ flags: { backfill: true } }).done).toBe(EXIT.ok);
    expect(plain()).toContain("Nothing to backfill");
  });

  it("--backfill --dry-run previews the backfill range on the replay cursor and runs nothing", async () => {
    saveProfile(baseProfile());
    for (const s of [1, 2, 3, 4]) api.events.push(makeEvent(s));
    api.consumers.set("c", { startSeq: 2, acked: 4 });
    const runs = join(env.root, "dry.txt");
    expect(await start({ flags: { backfill: true, dryRun: true, exec: `echo x >> ${runs}` } }).done).toBe(EXIT.ok);
    expect(api.streamRequests.at(-1)).toMatchObject({ consumer: "c-replay", start: "beginning", after: null });
    expect(plain()).toContain("#1 message.received");
    expect(plain()).toContain("#2 message.received");
    expect(plain()).not.toContain("#3 message.received");
    expect(existsSync(runs)).toBe(false);
  });

  it("--backfill: the safety net ends it when the rest isn't visible; gives up when the daemon stays unreachable", async () => {
    saveProfile(baseProfile());
    for (const s of [1, 2, 3]) api.events.push(makeEvent(s));
    api.consumers.set("c", { startSeq: 3, acked: 3 });
    api.hidden.add(3); // e.g. filtered out: the stream never sends it
    const runs = join(env.root, "safety.txt");
    expect(await start({ flags: { backfill: true, exec: `echo "$XAQ_EVENT_SEQ" >> ${runs}` }, backfillIdleMs: 300 }).done).toBe(EXIT.ok);
    expect(lines(runs)).toEqual(["1", "2"]);
    expect(plain()).toContain("aren't visible to this listener");

    api.blockedCode = "agent_disabled";
    expect(await start({ flags: { backfill: true }, backfillUnreachableMs: 300 }).done).toBe(EXIT.error);
    expect(plain()).toContain("Gave up: the daemon was unreachable");
  });
});

describe("throwaway consumer names", () => {
  it("never lets two consumers share a throwaway cursor", () => {
    expect(throwawayConsumer("laptop-default", "-replay")).toBe("laptop-default-replay");
    const a = `${"h".repeat(95)}-aaaa`;
    const b = `${"h".repeat(95)}-bbbb`;
    for (const suffix of ["-replay", "-dry-run"] as const) {
      const [ra, rb] = [throwawayConsumer(a, suffix), throwawayConsumer(b, suffix)];
      expect(ra).not.toBe(rb);
      expect(ra.length).toBeLessThanOrEqual(100);
      expect(ra.endsWith(suffix)).toBe(true);
      expect(/^[A-Za-z0-9._-]{1,100}$/.test(ra)).toBe(true);
      expect(throwawayConsumer(a, suffix)).toBe(ra); // stable
    }
  });
});

describe("transport refusal for *.ts.net", () => {
  it("says what the name resolved to and suggests an SSH tunnel or https", async () => {
    const err = await checkTransport("http://box.tail1234.ts.net:8425", { resolve: async () => ["203.0.113.7"] }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("box.tail1234.ts.net resolved to 203.0.113.7, which is not a Tailscale address");
    expect(msg).toContain("ssh -N -L 8425:localhost:8425 <user>@box.tail1234.ts.net");
    expect(msg).toContain("http://localhost:8425");
    expect(msg).toContain("https://");
    const unresolved = await checkTransport("http://box.tail1234.ts.net:8425", { resolve: async () => [] }).catch((e: Error) => e.message);
    expect(unresolved).toContain("could not be resolved here");
    expect(unresolved).toMatch(/Tailscale running/);
  });
});

describe("data directory notice", () => {
  it("only mentions tightening a directory that already held files", () => {
    const root = mkdtempSync(join(tmpdir(), "aib-data-"));
    try {
      const fresh = join(root, "fresh");
      loadConfig({ dataDir: fresh });
      expect(statSync(fresh).mode & 0o777).toBe(0o700);
      const empty = join(root, "empty");
      mkdirSync(empty, { mode: 0o755 });
      chmodSync(empty, 0o755);
      loadConfig({ dataDir: empty });
      expect(statSync(empty).mode & 0o777).toBe(0o700);
      expect(output).not.toContain("readable by other users");

      const used = join(root, "used");
      mkdirSync(used);
      writeFileSync(join(used, "xaq.db"), "");
      chmodSync(used, 0o755);
      loadConfig({ dataDir: used });
      expect(statSync(used).mode & 0o777).toBe(0o700);
      expect(output).toContain("readable by other users");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
