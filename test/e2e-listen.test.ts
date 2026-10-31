// E2E: device-flow pairing + the /agent/v1 listener stream (feat/listen-server) and the
// `xaq connect` / `listen` CLI end to end (feat/listen-client). Each part switches on when its
// code is present (test/e2e/features.ts); contract: shared/agent-api.ts, docs/listen.md.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Account, AuditEntry, MailEvent, Page, WebhookPayload } from "../shared/types.ts";
import { HAS_AGENT_API, HAS_LISTEN_CLIENT } from "./e2e/features.ts";
import { grant, mailbox, type Stack, startStack } from "./e2e/harness.ts";
import {
  ackEvents,
  agentMe,
  approvePairing,
  buildCli,
  cleanupListenTemp,
  cliHome,
  commandRecorder,
  denyPairing,
  execDir,
  findPairing,
  killAllCli,
  openAgentStream,
  pairAgent,
  type PairingRequest,
  pollPairing,
  setAgentApiOptions,
  spawnCli,
  startPairing,
} from "./e2e/listen.ts";
import { sleep, stays, waitFor } from "./e2e/wait.ts";

/**
 * How fast a revocation must reach a live stream and close it. The server reacts to the change
 * immediately (bus "agent" event; typically a few ms here); the bound is generous for slow CI.
 */
const REVOKE_BOUND_MS = 5000;

let s: Stack;
let email: string;
let other: string;
let account: Account;
let otherAccount: Account;
let scopeLabel: string;

async function setup() {
  s = await startStack();
  email = mailbox("listen");
  other = mailbox("listen-other");
  [account, otherAccount] = (await s.bootstrap({ accounts: [email, other], pubsub: true })) as [Account, Account];
  scopeLabel = s.fake.addLabel(email, "xaq");
  // Fast polling for the tests (the server exposes this for tests; production default is 3 s).
  await setAgentApiOptions(s, { intervalSeconds: 1 });
}

const deliver = (subject: string, extra: { labelIds?: string[]; to?: string } = {}) =>
  s.fake.deliver(extra.to ?? email, { from: "Sender <sender@else.test>", subject, text: `body of ${subject}`, labelIds: extra.labelIds });
/** The event as agents get it: the console's copy also carries threadLabelIds, which agents never see. */
const eventFor = async (id: string) => {
  const { threadLabelIds: _scope, ...ev } = await s.waitForEvent((e: MailEvent) => e.message?.id === id);
  return ev;
};

describe.runIf(HAS_AGENT_API)("pairing (device flow)", () => {
  beforeAll(setup);
  afterAll(() => s.close());

  it("delivers the key exactly once after the admin approves the matching code", async () => {
    const stream = await s.admin.stream();
    try {
      const start = await startPairing(s.url, { name: "Hermes on e2e", requested: { accounts: [email], capabilities: ["read"], reason: "triage" }, client: { tool: "hermes", hostname: "e2e-box", platform: "linux" } });
      expect(start.status).toBe(200);
      expect(start.body.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(start.body.verificationUrl).toContain(start.body.userCode);
      expect(start.body.interval).toBe(1);
      expect((await pollPairing(s.url, start.body.deviceCode)).body).toEqual({ status: "pending" });

      const req = await findPairing(s.admin, start.body.userCode);
      expect(req).toMatchObject({ name: "Hermes on e2e", status: "pending", agentId: null, client: { tool: "hermes", hostname: "e2e-box" } });
      expect(JSON.stringify(req)).not.toContain(start.body.deviceCode);
      expect((stream.messages as { kind: string; data: { id?: string } }[]).some((m) => m.kind === "pairing" && m.data.id === req.id)).toBe(true);

      // The human must type the code shown in the agent's terminal.
      const wrong = await s.admin.failure(approvePairing(s.admin, req.id, "AAAA-AAAA", [grant(account.id)]));
      expect(wrong.status).toBe(409);
      expect(wrong.code).toBe("user_code_mismatch");

      const agent = await approvePairing(s.admin, req.id, start.body.userCode.toLowerCase().replace("-", " "), [grant(account.id)]);
      expect(agent.name).toBe("Hermes on e2e");
      expect(JSON.stringify(agent)).not.toMatch(/aib_[A-Za-z0-9]{20,}/); // the key never goes to the console

      await sleep(1000);
      const approved = await pollPairing(s.url, start.body.deviceCode);
      expect(approved.body).toMatchObject({ status: "approved", agent: { id: agent.id, name: "Hermes on e2e" }, mcpUrl: `${s.url}/mcp`, skillUrl: `${s.url}/skill.md` });
      const apiKey = (approved.body as { apiKey: string }).apiKey;
      expect(apiKey).toMatch(/^aib_/);

      await sleep(1000);
      expect((await pollPairing(s.url, start.body.deviceCode)).body).toEqual({ status: "consumed" });

      const me = await agentMe(s.url, apiKey);
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ id: agent.id, name: "Hermes on e2e", grants: [{ accountId: account.id, accountEmail: email, capabilities: ["read"] }] });

      const audit = (await s.admin.get<Page<AuditEntry>>("/api/audit?limit=200")).items.filter((e) => e.target === req.id).map((e) => [e.action, e.outcome]);
      expect(audit).toEqual(expect.arrayContaining([["pairing.approved", "denied"], ["pairing.approved", "ok"], ["pairing.key_delivered", "ok"]]));
    } finally {
      stream.close();
    }
  });

  it("polling faster than the interval gets slow_down", async () => {
    const start = await startPairing(s.url, { name: "Impatient" });
    await pollPairing(s.url, start.body.deviceCode);
    const fast = await pollPairing(s.url, start.body.deviceCode);
    expect(fast.body).toMatchObject({ status: "slow_down" });
    expect((fast.body as { interval: number }).interval).toBeGreaterThan(1);
    await denyPairing(s.admin, (await findPairing(s.admin, start.body.userCode)).id);
  });

  it("deny: the agent learns the note, no agent is created, and the request can't be approved afterwards", async () => {
    const agentsBefore = (await s.admin.get<unknown[]>("/api/agents")).length;
    const start = await startPairing(s.url, { name: "Unwanted" });
    const req = await findPairing(s.admin, start.body.userCode);
    const denied = await denyPairing(s.admin, req.id, "not this one");
    expect(denied).toMatchObject({ status: "denied", decisionNote: "not this one" });
    expect((await pollPairing(s.url, start.body.deviceCode)).body).toEqual({ status: "denied", note: "not this one" });
    const late = await s.admin.failure(approvePairing(s.admin, req.id, start.body.userCode, [grant(account.id)]));
    expect(late.status).toBe(409);
    expect((await s.admin.get<unknown[]>("/api/agents")).length).toBe(agentsBefore);
  });

  it("expire: an unapproved code expires and can't be approved", async () => {
    await setAgentApiOptions(s, { intervalSeconds: 1, ttlMs: 400 });
    try {
      const start = await startPairing(s.url, { name: "Too slow" });
      expect(Date.parse(start.body.expiresAt) - Date.now()).toBeLessThan(1000);
      await sleep(600);
      expect((await pollPairing(s.url, start.body.deviceCode)).body).toEqual({ status: "expired" });
      const req = (await s.admin.get<PairingRequest[]>("/api/pairings?status=expired")).find((p) => p.userCode === start.body.userCode);
      expect(req).toBeTruthy();
      expect((await s.admin.failure(approvePairing(s.admin, req!.id, start.body.userCode, [grant(account.id)]))).status).toBe(409);
    } finally {
      await setAgentApiOptions(s, { intervalSeconds: 1 });
    }
  });

  it("refuses browser requests and unknown device codes", async () => {
    const browser = await startPairing(s.url, { name: "From a web page" }, { origin: "https://evil.test" });
    expect(browser.status).toBe(403);
    expect((await pollPairing(s.url, "not-a-real-device-code")).body).toEqual({ status: "expired" });
  });
});

describe.runIf(HAS_AGENT_API)("listener stream (/agent/v1/events/stream)", () => {
  beforeAll(setup);
  afterAll(() => s.close());

  it("starts a new consumer at the newest event (no backlog); start=beginning replays the backlog", async () => {
    const { apiKey } = await pairAgent(s, "Streamer", [grant(account.id)]);
    const old1 = deliver("Backlog 1");
    const old2 = deliver("Backlog 2");
    await eventFor(old1.id);
    await eventFor(old2.id);

    const fresh = await openAgentStream(s.url, apiKey, { consumer: "fresh" });
    const replay = await openAgentStream(s.url, apiKey, { consumer: "replay", start: "beginning", includeBody: true });
    try {
      const live = deliver("Live one");
      await fresh.next((e) => e.event === "mail");
      await waitFor(() => replay.mail().length >= 3, { what: "backlog + live on the replay consumer" });
      expect(fresh.mail().map((p) => p.data.message?.subject)).toEqual(["Live one"]);
      const subjects = replay.mail().map((p) => p.data.message?.subject);
      expect(subjects.slice(0, 2)).toEqual(["Backlog 1", "Backlog 2"]);
      expect(subjects).toContain("Live one");

      // Frames carry the seq as id and the same payload as a webhook.
      const frame = fresh.mail()[0]!;
      const ev = await eventFor(live.id);
      expect(frame.seq).toBe(ev.seq);
      expect(frame.type).toBe("message.received");
      const { content, ...data } = replay.mail().find((p) => p.data.id === ev.id)!.data;
      expect(data).toEqual(ev);
      expect(content?.body).toContain("body of Live one");
      expect(fresh.mail()[0]!.data.content).toBeUndefined();
    } finally {
      fresh.close();
      replay.close();
    }
  });

  it("resumes from the acked cursor, and from Last-Event-ID when it is further", async () => {
    const { apiKey } = await pairAgent(s, "Resumer", [grant(account.id)]);
    const first = await openAgentStream(s.url, apiKey, { consumer: "resume" });
    const e1 = deliver("Resume 1");
    await first.next((e) => e.event === "mail" && e.data.includes(e1.id));
    const seq1 = first.mail()[0]!.seq;
    expect((await ackEvents(s.url, apiKey, "resume", seq1)).body).toEqual({ ackedSeq: seq1 });
    first.close();

    const e2 = deliver("Resume 2");
    const e3 = deliver("Resume 3");
    const ev3 = await eventFor(e3.id);
    const ev2 = await eventFor(e2.id);

    const again = await openAgentStream(s.url, apiKey, { consumer: "resume" });
    await waitFor(() => again.mail().length >= 2, { what: "missed events" });
    expect(again.mail().map((p) => p.data.id)).toEqual([ev2.id, ev3.id]);
    again.close();

    // Not acked past seq1, but Last-Event-ID says ev2 was already seen.
    const withId = await openAgentStream(s.url, apiKey, { consumer: "resume", lastEventId: ev2.seq });
    await waitFor(() => withId.mail().length >= 1, { what: "event after Last-Event-ID" });
    await stays(() => withId.mail().length > 1, 300, "a second event after Last-Event-ID");
    expect(withId.mail().map((p) => p.data.id)).toEqual([ev3.id]);
    withId.close();

    // Acks can't point past what the agent can see.
    const capped = await ackEvents(s.url, apiKey, "resume", 10_000_000);
    expect(capped.body.ackedSeq).toBe(ev3.seq);
  });

  it("never streams events from ungranted accounts or out-of-scope labels", async () => {
    const { apiKey } = await pairAgent(s, "Scoped listener", [grant(account.id, { labelScope: [scopeLabel] })]);
    const stream = await openAgentStream(s.url, apiKey, { consumer: "scoped" });
    const otherBox = deliver("Other mailbox", { to: other });
    const outOfScope = deliver("No label");
    const inScope = deliver("Labeled", { labelIds: ["INBOX", "UNREAD", scopeLabel] });
    await eventFor(otherBox.id);
    await eventFor(outOfScope.id);
    await eventFor(inScope.id);
    await stream.next((e) => e.event === "mail");
    await stays(() => stream.mail().length > 1, 300, "an out-of-scope event on the stream");
    expect(stream.mail().map((p) => p.data.message?.subject)).toEqual(["Labeled"]);
    stream.close();

    const backlog = await openAgentStream(s.url, apiKey, { consumer: "scoped-all", start: "beginning" });
    await backlog.next((e) => e.event === "mail");
    await stays(() => backlog.mail().length > 1, 300, "an out-of-scope event in the backlog");
    expect(backlog.mail().every((p) => p.data.accountId === account.id && p.data.message?.subject === "Labeled")).toBe(true);
    backlog.close();
    expect(otherAccount.id).not.toBe(account.id);
  });

  it("revokes a live stream promptly when the agent is disabled (403 after) or its key rotated (401 after)", async () => {
    const { apiKey, agentId } = await pairAgent(s, "Revokee", [grant(account.id)]);
    const live = await openAgentStream(s.url, apiKey, { consumer: "revoke" });
    let t = Date.now();
    await s.admin.patch(`/api/agents/${agentId}`, { disabled: true });
    const revoked = await live.next((e) => e.event === "revoked", REVOKE_BOUND_MS);
    expect(JSON.parse(revoked.data)).toEqual({ reason: "agent_disabled" });
    await Promise.race([live.closed, sleep(REVOKE_BOUND_MS)]);
    expect(live.isClosed()).toBe(true);
    expect(Date.now() - t).toBeLessThan(REVOKE_BOUND_MS);
    const refused = await openAgentStream(s.url, apiKey, { consumer: "revoke" });
    expect(refused.status).toBe(403);
    expect(refused.error?.error?.code).toBe("agent_disabled");
    expect((await agentMe(s.url, apiKey)).status).toBe(403);

    await s.admin.patch(`/api/agents/${agentId}`, { disabled: false });
    const live2 = await openAgentStream(s.url, apiKey, { consumer: "revoke" });
    expect(live2.status).toBe(200);
    t = Date.now();
    await s.admin.post(`/api/agents/${agentId}/rotate-key`);
    expect(JSON.parse((await live2.next((e) => e.event === "revoked", REVOKE_BOUND_MS)).data)).toEqual({ reason: "key_rotated" });
    await Promise.race([live2.closed, sleep(REVOKE_BOUND_MS)]);
    expect(live2.isClosed()).toBe(true);
    expect(Date.now() - t).toBeLessThan(REVOKE_BOUND_MS);
    expect((await openAgentStream(s.url, apiKey, { consumer: "revoke" })).status).toBe(401);
    expect((await agentMe(s.url, apiKey)).status).toBe(401);
  });

  it("revokes a live stream when the agent loses its last read grant (account removed)", async () => {
    const extra = await s.connectAccount(mailbox("listen-removed"));
    const { apiKey } = await pairAgent(s, "Grant loser", [grant(extra.id)]);
    const live = await openAgentStream(s.url, apiKey, { consumer: "grant" });
    await s.admin.del(`/api/accounts/${extra.id}`);
    expect(JSON.parse((await live.next((e) => e.event === "revoked", REVOKE_BOUND_MS)).data)).toEqual({ reason: "no_read_grant" });
    const refused = await openAgentStream(s.url, apiKey, { consumer: "grant" });
    expect(refused.status).toBe(403);
    expect(refused.error?.error?.code).toBe("no_read_grant");
  });
});

describe.runIf(HAS_AGENT_API && HAS_LISTEN_CLIENT)("xaq connect + listen (CLI end to end)", () => {
  beforeAll(async () => {
    buildCli();
    await setup();
  }, 60_000);
  afterEach(() => killAllCli());
  afterAll(async () => {
    await killAllCli();
    cleanupListenTemp();
    await s.close();
  });

  it("pairs with connect, runs --exec per event with the event on stdin only, and resumes after a restart", async () => {
    const home = cliHome();
    const connect = spawnCli(["connect", s.url, "--name", "E2E listener", "--tool", "other"], home);
    const code = (await connect.waitForOutput(/Code:\s+([A-Z2-9]{4}-[A-Z2-9]{4})/))[1]!;
    const req = await findPairing(s.admin, code);
    const agent = await approvePairing(s.admin, req.id, code, [grant(account.id)]);
    expect(await connect.exited).toBe(0);
    const profile = join(home.configDir, "xaq", "profiles", "default.json");
    expect(existsSync(profile)).toBe(true);
    expect(statSync(profile).mode & 0o777).toBe(0o600);
    expect(connect.output()).not.toMatch(/aib_[A-Za-z0-9]{20,}/); // the key is never printed

    const rec = commandRecorder(execDir());
    const canary = rec.canary;
    // Attacker-controlled text: shell syntax that runs if anything ever hands it to a shell.
    const evilFor = (path: string) => `$(touch ${path}) \`touch ${path}\` "; touch ${path}; " '$(touch ${path})' \${IFS}`;
    const evil = evilFor(canary);
    // Positive control: the same payload interpolated into `sh -c "echo …"` does create the file.
    const control = join(execDir(), "CONTROL");
    execFileSync("sh", ["-c", `echo Invoice ${evilFor(control)}`], { stdio: "ignore" });
    expect(existsSync(control)).toBe(true);
    const listenArgs = ["listen", "--exec", rec.command, "--include-body"];
    // The consumer connect chose (this machine's hostname).
    const consumer = (JSON.parse(readFileSync(profile, "utf8")) as { consumer: string }).consumer;
    // A secret-looking XAQ_* variable in the listener's environment must not reach the command.
    const plant = { XAQ_PLANTED: "do-not-leak" };
    let listener = spawnCli(listenArgs, home, plant);
    const connected = async () =>
      waitFor(async () => (await s.admin.get<{ listeners?: { consumer: string; connected: boolean }[] }>(`/api/agents/${agent.id}`)).listeners?.find((l) => l.consumer === consumer && l.connected), {
        what: "listener connected",
        timeout: 10_000,
      });
    await connected();

    // The attacker's email carries it in the subject, the sender name and the body.
    const msg = s.fake.deliver(email, {
      from: `"${evil.replace(/"/g, "'")}" <attacker@evil.test>`,
      subject: `Invoice ${evil}`,
      text: `line one ${evil}\nline two; touch ${canary}\n$(touch ${canary})`,
    });
    const ev = await eventFor(msg.id);
    const call1 = await waitFor(() => rec.calls().find((c) => c.stdin.includes(ev.id)), { what: "command run", timeout: 10_000 });

    const input = JSON.parse(call1.stdin) as { notice: string; event: WebhookPayload };
    expect(input.notice).toMatch(/untrusted/i);
    const { content, ...data } = input.event.data;
    expect(data).toEqual(ev); // byte-exact fields: same event as the console API
    expect(input.event.data.message!.subject).toBe(`Invoice ${evil}`);
    expect(input.event.data.message!.from).toEqual({ name: evil.replace(/"/g, "'"), email: "attacker@evil.test" });
    expect(content!.body).toContain(`line two; touch ${canary}`);
    expect(content!.body).toMatch(/^<email_content from="attacker@evil\.test" untrusted>/);

    // Environment: only safe ids (plus the event file path), never text, never the planted variable.
    const allowed = ["XAQ_EVENT_ID", "XAQ_EVENT_TYPE", "XAQ_EVENT_SEQ", "XAQ_ACCOUNT", "XAQ_THREAD_ID", "XAQ_MESSAGE_ID", "XAQ_EVENT_FILE", "XAQ_EVENT_COUNT"];
    expect(Object.keys(call1.env).filter((k) => !allowed.includes(k))).toEqual([]);
    expect(call1.env).toMatchObject({ XAQ_EVENT_ID: ev.id, XAQ_EVENT_TYPE: "message.received", XAQ_EVENT_SEQ: String(ev.seq), XAQ_MESSAGE_ID: msg.id });
    for (const v of Object.values(call1.env)) expect(v).not.toMatch(/touch|\$\(|`/);
    expect(call1.argv).toEqual([]);
    // $XAQ_EVENT_FILE holds the same JSON as stdin, readable only by the user.
    expect(call1.eventFile).toEqual({ content: call1.stdin, mode: 0o600 });
    await stays(() => existsSync(canary), 300, "the canary file");

    // Kill the listener once it has acked, deliver while it's down, restart: nothing lost, nothing re-run.
    await waitFor(async () => (await s.admin.get<{ listeners: { consumer: string; ackedSeq: number }[] }>(`/api/agents/${agent.id}`)).listeners.find((l) => l.consumer === consumer && l.ackedSeq >= ev.seq), {
      what: "ack of the first event",
    });
    expect(await listener.kill("SIGTERM")).not.toBeNull();
    const down1 = s.fake.deliver(email, { from: "a@else.test", subject: "While listener down 1", text: "1" });
    const down2 = s.fake.deliver(email, { from: "b@else.test", subject: "While listener down 2", text: "2" });
    const evDown1 = await eventFor(down1.id);
    const evDown2 = await eventFor(down2.id);
    listener = spawnCli(listenArgs, home, plant);
    try {
      await waitFor(() => rec.calls().length >= 3, { what: "missed events run after restart", timeout: 10_000 });
      await stays(() => rec.calls().length > 3, 500, "a re-run after the listener restart");
      const ids = () => rec.calls().map((c) => (JSON.parse(c.stdin) as { event: WebhookPayload }).event.data.id);
      expect(ids().sort()).toEqual([ev.id, evDown1.id, evDown2.id].sort());
      expect(existsSync(canary)).toBe(false);

      // The daemon restarts under a running listener: it reconnects by itself and nothing runs twice.
      await waitFor(async () => (await s.admin.get<{ listeners: { consumer: string; ackedSeq: number }[] }>(`/api/agents/${agent.id}`)).listeners.find((l) => l.consumer === consumer && l.ackedSeq >= evDown2.seq), {
        what: "acks before the daemon restart",
      });
      await s.restart();
      const after = s.fake.deliver(email, { from: "c@else.test", subject: "After daemon restart", text: "3" });
      const evAfter = await eventFor(after.id);
      await waitFor(() => ids().includes(evAfter.id), { what: "event after the daemon restart", timeout: 20_000 });
      await stays(() => rec.calls().length > 4, 300, "a re-run after the daemon restart");
      expect(ids().sort()).toEqual([ev.id, evDown1.id, evDown2.id, evAfter.id].sort());

      // Revocation stops the listener for good: exit code 78 (the service won't restart it).
      await s.admin.post(`/api/agents/${agent.id}/rotate-key`);
      expect(await Promise.race([listener.exited, sleep(5000).then(() => "still running")])).toBe(78);
    } finally {
      await listener.kill("SIGTERM");
    }
  }, 60_000);

  it("exits with 2 when the pairing is denied", async () => {
    const home = cliHome();
    const connect = spawnCli(["connect", s.url, "--name", "Denied CLI", "--tool", "other"], home);
    const code = (await connect.waitForOutput(/Code:\s+([A-Z2-9]{4}-[A-Z2-9]{4})/))[1]!;
    await denyPairing(s.admin, (await findPairing(s.admin, code)).id, "nope");
    expect(await connect.exited).toBe(2);
    expect(existsSync(join(home.configDir, "xaq", "profiles", "default.json"))).toBe(false);
  }, 30_000);
});
