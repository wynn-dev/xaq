// Console-side logic of the setup wizard's last mile: the Verify checks, the commands the console
// prints (they must match what `connect` prints).

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../shared/agent-api.ts";
import { type AuditEntry, isMcpToolAction, type ListenerInfo, type MailEvent, type PairingRequest, type SetupState } from "../shared/types.ts";
import { printNextSteps } from "../server/listen/connect.ts";
import type { Profile } from "../server/listen/profile.ts";
import { deniedDescription, linkedPairing } from "../src/components/approvals/pairing-link.ts";
import { listenerHandled } from "../src/components/agents/listener-handled.ts";
import { allStepsDone, type SetupDraft, showsSetupLink, skippedPatch, STEP_IDS, startsVerify, type StepId, type StepStatus, stepStatuses, verifiedPatch, verifyDoneHeading, wizardStep } from "../src/components/setup/steps.ts";
import { lastCallShown } from "../src/components/agents/last-call.ts";
import { activeTest, checksComplete, doneSummary, TEST_SUBJECT, TEST_TTL_MS, type VerifyTest, verifyChecks, verifyFooter, verifyMode } from "../src/components/setup/verify-checks.ts";
import { connectCommands, NPX } from "../src/lib/cli.ts";
import { accountsStat, agentOnHost, fmtAgo } from "../src/lib/format.ts";

// ───────────── Verify checks ─────────────

const SENT_AT = "2026-10-15T10:00:00.000Z";
const later = (s: number) => new Date(Date.parse(SENT_AT) + s * 1000).toISOString();

const test0: VerifyTest = { messageId: "m1", threadId: "t1", sentAt: SENT_AT, accountId: "acc_1", listenersAtSend: ["host-default"] };

function event(seq: number, type: MailEvent["type"], over: { id?: string; subject?: string; createdAt?: string; accountId?: string } = {}): MailEvent {
  return {
    id: `evt_${seq}`,
    seq,
    type,
    accountId: over.accountId ?? "acc_1",
    accountEmail: "me@example.com",
    createdAt: over.createdAt ?? later(2),
    message: {
      id: over.id ?? "m1",
      threadId: "t1",
      from: { name: null, email: "me@example.com" },
      to: [],
      cc: [],
      subject: over.subject ?? TEST_SUBJECT,
      snippet: "",
      date: SENT_AT,
      labelIds: [],
      hasAttachments: false,
    },
  };
}

const listener = (consumer: string, ackedSeq: number, connected = true, startSeq: number | null = null, types: ListenerInfo["types"] = null): ListenerInfo => ({
  consumer,
  connected,
  startSeq,
  ackedSeq,
  types,
  lastSeenAt: null,
  client: {},
});
const call = (action: string, outcome: AuditEntry["outcome"], ts: string): AuditEntry => ({
  id: 1,
  ts,
  actorType: "agent",
  actorId: "agt_1",
  actorName: "a",
  action,
  accountId: null,
  target: null,
  outcome,
  reason: null,
  durationMs: 1,
  detail: null,
});

const base = { events: [] as MailEvent[], listeners: [] as ListenerInfo[], calls: [] as AuditEntry[], skipListen: false };

describe("listenerHandled", () => {
  const sent = { seq: 7, type: "message.sent" as const };
  const received = { seq: 8, type: "message.received" as const };
  it("needs the event's type among the listener's types", () => {
    const l = listener("x", 9, true, 5, ["message.received"]);
    expect(listenerHandled(l, received)).toBe(true);
    expect(listenerHandled(l, sent)).toBe(false);
  });
  it("counts every type when the types are unknown (cursors from older daemons)", () => {
    const l = listener("x", 9, true, 5, null);
    expect(listenerHandled(l, received)).toBe(true);
    expect(listenerHandled(l, sent)).toBe(true);
  });
  it("needs the event after the cursor's start and at or below the ack", () => {
    expect(listenerHandled(listener("x", 7, true, 7, ["message.received", "message.sent"]), sent)).toBe(false);
    expect(listenerHandled(listener("x", 6, true, 0, ["message.sent"]), sent)).toBe(false);
    expect(listenerHandled(listener("x", 7, true, null, ["message.sent"]), sent)).toBe(true);
  });
});

describe("verifyChecks", () => {
  it("is all false before a test email is sent", () => {
    expect(verifyChecks({ ...base, test: undefined })).toEqual({
      sent: false,
      received: undefined,
      delivered: false,
      resendForListener: false,
      readIt: false,
      typesExcludeIt: null,
    });
  });

  it("matches the test by message id and prefers message.received over message.sent", () => {
    const r = verifyChecks({ ...base, test: test0, events: [event(2, "message.received"), event(1, "message.sent"), event(3, "message.received", { id: "other", subject: "hi" })] });
    expect(r.sent).toBe(true);
    expect(r.received?.seq).toBe(2);
  });

  it("falls back to the subject for events after the send, but not older ones or other accounts", () => {
    const sameSubjectAfter = event(5, "message.received", { id: "m-other", createdAt: later(3) });
    const sameSubjectBefore = event(4, "message.received", { id: "m-old", createdAt: later(-60) });
    const otherAccount = event(6, "message.received", { id: "m1", accountId: "acc_2" });
    expect(verifyChecks({ ...base, test: test0, events: [sameSubjectAfter] }).received?.seq).toBe(5);
    expect(verifyChecks({ ...base, test: test0, events: [sameSubjectBefore] }).received).toBeUndefined();
    expect(verifyChecks({ ...base, test: test0, events: [otherAccount] }).received).toBeUndefined();
  });

  it("counts delivery only from listeners that were connected when the test was sent", () => {
    const events = [event(7, "message.received")];
    expect(verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 7)] }).delivered).toBe(true);
    expect(verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 6)] }).delivered).toBe(false);
  });

  it("does not count a listener that connected after the send, and asks for another test email", () => {
    const events = [event(7, "message.received")];
    // A new listener's cursor starts at the newest event, so its ackedSeq passes the test without handling it.
    const r = verifyChecks({ ...base, test: { ...test0, listenersAtSend: [] }, events, listeners: [listener("host-default", 9)] });
    expect(r.delivered).toBe(false);
    expect(r.resendForListener).toBe(true);
    const other = verifyChecks({ ...base, test: test0, events, listeners: [listener("laptop-default", 9)] });
    expect(other.delivered).toBe(false);
  });

  it("counts delivery only for event types the listener asked for", () => {
    // The default listener takes message.received only: it acks the test's message.sent without running anything.
    const onlyReceived = [listener("host-default", 9, true, null, ["message.received"])];
    expect(verifyChecks({ ...base, test: test0, events: [event(7, "message.sent")], listeners: onlyReceived }).delivered).toBe(false);
    expect(verifyChecks({ ...base, test: test0, events: [event(8, "message.received"), event(7, "message.sent")], listeners: onlyReceived }).delivered).toBe(true);
    const onlySent = [listener("host-default", 9, true, null, ["message.sent"])];
    expect(verifyChecks({ ...base, test: test0, events: [event(8, "message.received"), event(7, "message.sent")], listeners: onlySent }).delivered).toBe(false);
  });

  it("says when every listener known at send time asked for types without message.received", () => {
    const events = [event(8, "message.received"), event(7, "message.sent")];
    const replies = listener("host-default", 9, true, null, ["thread.reply_received"]);
    expect(verifyChecks({ ...base, test: test0, events, listeners: [replies] }).typesExcludeIt).toEqual(["thread.reply_received"]);
    // Not while one of them takes it, its types are unknown, or the received event hasn't arrived yet.
    const both = [replies, listener("laptop-default", 7, true, null, ["message.received"])];
    expect(verifyChecks({ ...base, test: { ...test0, listenersAtSend: ["host-default", "laptop-default"] }, events, listeners: both }).typesExcludeIt).toBeNull();
    expect(verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 7)] }).typesExcludeIt).toBeNull();
    expect(verifyChecks({ ...base, test: test0, events: [event(7, "message.sent")], listeners: [replies] }).typesExcludeIt).toBeNull();
    // Only listeners recorded at send time count.
    expect(verifyChecks({ ...base, test: { ...test0, listenersAtSend: [] }, events, listeners: [replies] }).typesExcludeIt).toBeNull();
  });

  it("does not count a listener whose cursor started at or after the event", () => {
    const events = [event(7, "message.received")];
    expect(verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 9, true, 7)] }).delivered).toBe(false);
    expect(verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 9, true, 6)] }).delivered).toBe(true);
  });

  it("counts a recorded listener that is disconnected now but acked past the event", () => {
    const r = verifyChecks({ ...base, test: test0, events: [event(7, "message.received")], listeners: [listener("host-default", 7, false)] });
    expect(r.delivered).toBe(true);
    expect(r.resendForListener).toBe(false);
  });

  it("waits for a recorded listener that is disconnected and behind, without asking for a resend", () => {
    // Recorded at send time (even while disconnected): it keeps its cursor and handles the mail on reconnect.
    const r = verifyChecks({ ...base, test: test0, events: [event(7, "message.received")], listeners: [listener("host-default", 5, false)] });
    expect(r.delivered).toBe(false);
    expect(r.resendForListener).toBe(false);
  });

  it("asks for a resend when no recorded listener is connected but another one is", () => {
    const events = [event(7, "message.received")];
    const r = verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 5, false), listener("laptop-default", 9)] });
    expect(r.delivered).toBe(false);
    expect(r.resendForListener).toBe(true);
    // …but not while a recorded listener is connected and still catching up.
    const catchingUp = verifyChecks({ ...base, test: test0, events, listeners: [listener("host-default", 5), listener("laptop-default", 9)] });
    expect(catchingUp.resendForListener).toBe(false);
  });

  it("doesn't ask for a resend when the listener is skipped", () => {
    const r = verifyChecks({ ...base, skipListen: true, test: { ...test0, listenersAtSend: [] }, events: [event(7, "message.received")], listeners: [listener("x", 9)] });
    expect(r.resendForListener).toBe(false);
    expect(r.received?.seq).toBe(7);
  });

  it("counts only successful reads after the send", () => {
    const at = (calls: AuditEntry[]) => verifyChecks({ ...base, test: test0, calls }).readIt;
    expect(at([call("get_thread", "ok", later(5))])).toBe(true);
    expect(at([call("search_threads", "denied", later(5))])).toBe(false);
    expect(at([call("get_message", "error", later(5))])).toBe(false);
    expect(at([call("get_thread", "ok", later(-5))])).toBe(false);
    expect(at([call("list_accounts", "ok", later(5))])).toBe(false);
  });

  it("forgets a test email after an hour", () => {
    expect(activeTest(test0, Date.parse(SENT_AT) + 1000)).toBe(test0);
    expect(activeTest(test0, Date.parse(SENT_AT) + TEST_TTL_MS + 1)).toBeUndefined();
    expect(activeTest(undefined, 0)).toBeUndefined();
  });
});

// ───────────── Commands: console vs `connect` ─────────────

/** Minimal POSIX word splitting (quotes and backslashes; no expansion), to check quoting round-trips. */
function words(cmd: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      cur = (cur ?? "") + cmd.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      let s = "";
      for (; cmd[j] !== '"'; j++) s += cmd[j] === "\\" ? cmd[++j] : cmd[j];
      cur = (cur ?? "") + s;
      i = j;
    } else if (ch === "\\") {
      cur = (cur ?? "") + cmd[++i];
    } else if (/\s/.test(ch)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else {
      cur = (cur ?? "") + ch;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

function nextSteps(tool: AgentTool, url: string): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
    lines.push(...String(s).split("\n"));
    return true;
  });
  try {
    const profile = { url, apiKey: "aib_test", agentId: "agt_1", agentName: "a", consumer: "host-default", mcpUrl: `${url}/mcp` } as unknown as Profile;
    printNextSteps(profile, tool, null);
  } finally {
    spy.mockRestore();
  }
  // eslint-disable-next-line no-control-regex
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean);
}

describe("connectCommands matches what `connect` prints", () => {
  afterEach(() => vi.restoreAllMocks());
  const URL_ = "https://mail.example.com";
  const known: AgentTool[] = ["claude-code", "codex", "cursor", "hermes"];

  it.each([...known, "other" as const])("skill install for %s", (tool) => {
    expect(nextSteps(tool, URL_)).toContain(connectCommands(URL_, tool).skillInstall);
  });

  it("setup-mcp, listen try and service for claude-code", () => {
    const c = connectCommands(URL_, "claude-code");
    const cli = nextSteps("claude-code", URL_);
    // connect prints the command followed by a dry-run hint on the same line.
    expect(cli.some((l) => l === c.setupMcp || l.startsWith(`${c.setupMcp}  `))).toBe(true);
    // Both name the CLI's built-in recipe: exactly the commands connect prints.
    expect(c.listenTry).toBe(`${NPX} listen --recipe claude-code`);
    expect(cli).toContain(c.listenTry);
    expect(c.listenService).toBe(`${NPX} listen service install --recipe claude-code`);
    expect(cli).toContain(c.listenService);
    // Neither passes --types: listen's default (new mail only) applies, and connect says so.
    expect(c.listenTry).not.toContain("--types");
    expect(c.listenService).not.toContain("--types");
    expect(cli.some((l) => l.includes("Only new mail wakes it (message.received), not mail you send"))).toBe(true);
  });

  it.each(known.filter((t) => t !== "claude-code"))("%s: no MCP setup command; listen runs the user's own script", (tool) => {
    const c = connectCommands(URL_, tool);
    expect(c.setupMcp).toBeNull();
    expect(c.connect).toBe(`${NPX} connect ${URL_} --tool ${tool}`);
    expect(c.listenService).toBe(`${NPX} listen service install --exec /path/to/handle-email.sh`);
    expect(nextSteps(tool, URL_)).toContain(c.listenService);
  });

  it.each([...known, "other" as const])("no %s command runs npx inside $(…), a pipe or a redirect (npx's install prompt would be swallowed)", (tool) => {
    const c = connectCommands("http://127.0.0.1:8425", tool);
    const commands = [c.connect, ...(c.setupMcp ? [c.setupMcp] : []), c.skillInstall, c.listenTry, c.listenService, ...nextSteps(tool, URL_).filter((l) => l.startsWith(NPX))];
    // Quoted arguments (e.g. --exec 'cat > /dev/null') are data for the CLI, not shell syntax around npx.
    for (const cmd of commands) expect(cmd.replace(/'[^']*'/g, "''"), cmd).not.toMatch(/\$\(|\||>/);
  });

  it("other: the service runs the same script connect suggests; the try command is a harmless test", () => {
    const c = connectCommands(URL_, "other");
    expect(nextSteps("other", URL_)).toContain(c.listenService);
    expect(nextSteps("other", URL_)).toContain(c.listenService.replace("listen service install", "listen"));
    expect(c.listenTry).toBe(`${NPX} listen --exec 'cat > /dev/null'`);
    expect(c.connect).toBe(`${NPX} connect ${URL_} --tool other`);
  });

  it.each(["https://mail.example.com/it's", "https://mail.example.com/a b", "http://127.0.0.1:8712"])("quotes the URL %s so the shell passes it unchanged", (url) => {
    const c = connectCommands(url, "claude-code");
    expect(words(c.connect)).toEqual(["npx", "xaq-cli", "connect", url, "--tool", "claude-code", "--setup-mcp"]);
    expect(words(c.skillInstall).at(-1)).toBe(url);
  });

  it("adds --insecure only after the explicit opt-in, and only for plain http off loopback/Tailscale", () => {
    expect(connectCommands("http://192.168.1.20:8425", "codex").connect).not.toContain("--insecure");
    expect(connectCommands("http://192.168.1.20:8425", "codex", true).connect).toContain("--insecure");
    // listen takes the transport choice from the pairing.
    expect(connectCommands("http://192.168.1.20:8425", "codex", true).listenTry).not.toContain("--insecure");
    expect(connectCommands("http://127.0.0.1:8425", "codex", true).connect).not.toContain("--insecure");
  });
});

// ───────────── Grants in plain words ─────────────

// ───────────── Stepper: when "Check that it works" is done ─────────────

describe("stepStatuses: the verify step", () => {
  const state = (verified: boolean): SetupState => ({
    claimed: true,
    googleClientConfigured: true,
    gcpProjectId: "p-123456",
    googleAppType: "external",
    accountsConnected: 1,
    agentsCreated: 1,
    verified,
    complete: true,
    warnings: [],
  });
  const verify = (verified: boolean, draft: SetupDraft) => stepStatuses(state(verified), draft).verify;

  it("follows the server for browsers that never opened the step (old installs, other browsers)", () => {
    expect(verify(true, {})).toBe("done");
    expect(verify(false, {})).toBe("todo");
  });

  it("stays todo once this browser started the step, until Finish", () => {
    // The server has evidence (a tool call) long before the listener and the test email.
    expect(verify(true, { verifyStarted: true })).toBe("todo");
    expect(allStepsDone(stepStatuses(state(true), { verifyStarted: true }))).toBe(false);
    // "Finish setup" or "Finish without checking".
    expect(verify(true, { verifyStarted: true, verified: true })).toBe("done");
    expect(verify(false, { verifyStarted: true, verified: true })).toBe("done");
  });

  it("is done as soon as every required check is green, without clicking Finish setup", () => {
    const green = { mcpDone: true, listenDone: true, skipListen: false, sent: true, received: true, delivered: true };
    expect(checksComplete(green)).toBe(true);
    expect(checksComplete({ ...green, delivered: false })).toBe(false);
    expect(checksComplete({ ...green, listenDone: false })).toBe(false);
    expect(checksComplete({ ...green, mcpDone: false })).toBe(false);
    expect(checksComplete({ ...green, received: false })).toBe(false);
    // MCP only: no listener, no delivery.
    expect(checksComplete({ ...green, listenDone: false, delivered: false, skipListen: true })).toBe(true);

    const draft: SetupDraft = { verifyStarted: true };
    expect(verifiedPatch(false, draft)).toBeNull();
    const patched = { ...draft, ...verifiedPatch(checksComplete(green), draft) };
    expect(patched.verified).toBe(true);
    expect(patched.verifiedBy).toBe("checks");
    const statuses = stepStatuses(state(true), patched);
    expect(statuses.verify).toBe("done");
    expect(allStepsDone(statuses)).toBe(true);
    expect(STEP_IDS.filter((id) => statuses[id] !== "todo")).toHaveLength(STEP_IDS.length);
    // Already done: nothing to write.
    expect(verifiedPatch(true, patched)).toBeNull();
  });

  it("shows a done step as complete when revisited, even with this browser's test email gone", () => {
    // An hour later (test past TEST_TTL_MS), or another browser (no draft): the step is still done.
    expect(activeTest(test0, Date.parse(SENT_AT) + TEST_TTL_MS + 1)).toBeUndefined();
    for (const draft of [{ verifyStarted: true, verified: true }, {}] as SetupDraft[]) {
      const done = stepStatuses(state(true), draft).verify === "done";
      expect(done).toBe(true);
      expect(verifyMode(done, false)).toBe("complete");
      // Never a disabled Finish next to a ✓ in the stepper, even while the checks run again.
      expect(verifyFooter(done, false)).toEqual({ nextDisabled: false, hint: null, skip: false });
    }
    // "Run the checks again": the live checks, and the step stays done.
    expect(verifyMode(true, true)).toBe("checks");
    // Opened before it was done: the checks, which stay up when they turn green.
    expect(verifyMode(false, false)).toBe("checks");
    expect(verifyFooter(false, false)).toEqual({ nextDisabled: true, hint: "Finish turns on when every check is green", skip: true });
    expect(verifyFooter(false, true).nextDisabled).toBe(false);
  });

  it("records how step 7 was finished", () => {
    expect(skippedPatch({ verifyStarted: true })).toEqual({ verified: true, verifiedBy: "skip" });
    // Skipping after the checks passed doesn't forget that they did.
    expect(skippedPatch({ verified: true, verifiedBy: "checks" })).toEqual({ verified: true, verifiedBy: "checks" });
    // Checks that pass later (Run the checks again) replace a skip, and an older draft without verifiedBy.
    expect(verifiedPatch(true, { verified: true, verifiedBy: "skip" })).toEqual({ verified: true, verifiedBy: "checks" });
    expect(verifiedPatch(true, { verified: true })).toEqual({ verified: true, verifiedBy: "checks" });
    expect(verifiedPatch(true, { verified: true, verifiedBy: "checks" })).toBeNull();
  });

  it("says 'Setup complete' only when every required step is done", () => {
    const all = stepStatuses(state(true), { verified: true });
    expect(verifyDoneHeading(all)).toEqual({ title: "Setup complete", nextStep: null });
    // Step 7 itself (about to be marked) doesn't matter.
    expect(verifyDoneHeading({ ...all, verify: "todo" })).toEqual({ title: "Setup complete", nextStep: null });
    // A required step is still to do: the first one is linked.
    expect(verifyDoneHeading({ ...all, consent: "todo", accounts: "todo" })).toEqual({ title: "This check is done", nextStep: "consent" });
    expect(verifyDoneHeading({ ...all, url: "todo", agent: "todo" })).toEqual({ title: "This check is done", nextStep: "url" });
  });

  it("shows the last successful tool call, or marks a failed one", () => {
    expect(lastCallShown([])).toBeNull();
    const rejected = { ...call("get_message", "error", later(9)), reason: "invalid_arguments" };
    const ok = call("search_threads", "ok", later(5));
    expect(lastCallShown([rejected, ok])).toEqual({ call: ok, ok: true, note: null });
    expect(lastCallShown([rejected])).toEqual({ call: rejected, ok: false, note: "rejected: invalid_arguments" });
    expect(lastCallShown([{ ...call("send_message", "denied", later(1)), reason: "allow_to" }])?.note).toBe("denied: allow_to");
    expect(lastCallShown([{ ...call("get_thread", "error", later(1)), reason: "gmail_error" }])?.note).toBe("failed: gmail_error");
    // The console passes a plain-words explainer; unknown codes fall back to the code.
    const words = (r: string) => (r === "allow_to" ? "a recipient isn't on the grant's allowlist" : r);
    expect(lastCallShown([{ ...call("send_message", "denied", later(1)), reason: "allow_to" }], words)?.note).toBe(
      "denied: a recipient isn't on the grant's allowlist",
    );
  });

  it("summarizes what was verified from what is still known", () => {
    const old = { ...listener("host-default", 9, false), lastSeenAt: later(60), client: { hostname: "anvil" } };
    expect(
      doneSummary({
        serverVerified: true,
        test: test0,
        calls: [call("get_message", "error", later(90)), call("get_message", "ok", later(30))],
        connectedAt: later(90),
        listeners: [old],
        skipListen: false,
        verifiedBy: "checks",
      }),
    ).toEqual([
      { id: "checked" },
      // The last successful call, not the newer rejected one.
      { id: "mcp", at: later(30), action: "get_message" },
      { id: "listener", connected: false, hostname: "anvil", at: later(60) },
      { id: "test", at: SENT_AT },
    ]);
    // Another browser, MCP only: no test email known here; the connection alone still shows.
    expect(doneSummary({ serverVerified: true, test: undefined, calls: [], connectedAt: later(5), listeners: [], skipListen: true })).toEqual([
      { id: "mcp", at: later(5), action: null },
      { id: "mcpOnly" },
    ]);
    // Skipped: said so, whatever the server knows; nothing claims checks passed.
    expect(doneSummary({ serverVerified: true, test: undefined, calls: [], connectedAt: null, listeners: [], skipListen: true, verifiedBy: "skip" })).toEqual([
      { id: "mcpOnly" },
      { id: "skipped" },
    ]);
    // A connected listener wins over an older one; unknown how it finished, and no evidence: said so.
    expect(
      doneSummary({ serverVerified: false, test: undefined, calls: [], connectedAt: null, listeners: [old, { ...listener("b", 0), client: {} }], skipListen: false }),
    ).toEqual([{ id: "listener", connected: true, hostname: null, at: null }, { id: "unchecked" }]);
  });

  it("keeps the sidebar entry while on /get-started, and drops it on navigation once done", () => {
    expect(showsSetupLink(false, false, "/")).toBe(false);
    expect(showsSetupLink(true, false, "/")).toBe(true);
    expect(showsSetupLink(true, true, "/get-started")).toBe(true);
    expect(showsSetupLink(true, true, "/")).toBe(false);
    expect(showsSetupLink(true, true, "/events")).toBe(false);
  });

  it("calls setup done once every step is", () => {
    expect(allStepsDone(stepStatuses(state(true), {}))).toBe(true);
  });
});

// ───────────── Relative times ─────────────

describe("accountsStat (Overview's Accounts tile)", () => {
  it("asks to connect Gmail instead of saying 'all active' about no accounts", () => {
    expect(accountsStat({ total: 0, active: 0, needsAttention: 0 })).toEqual({ value: "0", hint: "Connect Gmail", connect: true });
    expect(accountsStat({ total: 1, active: 1, needsAttention: 0 })).toEqual({ value: "1", hint: "active" });
    expect(accountsStat({ total: 3, active: 3, needsAttention: 0 })).toEqual({ value: "3", hint: "all active" });
    expect(accountsStat({ total: 3, active: 2, needsAttention: 0 })).toEqual({ value: "2 of 3", hint: "1 paused" });
    expect(accountsStat({ total: 3, active: 1, needsAttention: 2 })).toEqual({ value: "1 of 3", hint: "2 need attention", tone: "critical" });
  });
});

describe("fmtAgo", () => {
  const now = Date.parse(SENT_AT);
  it('says "just now" under 10 seconds instead of "0 seconds ago"', () => {
    expect(fmtAgo(SENT_AT, now)).toBe("just now");
    expect(fmtAgo(later(-9), now)).toBe("just now");
    expect(fmtAgo(later(1), now)).toBe("just now"); // clock skew
    expect(fmtAgo(later(-12), now)).toBe("12 seconds ago");
    expect(fmtAgo(later(-180), now)).toBe("3 minutes ago");
    expect(fmtAgo(later(30), now)).toBe("in 30 seconds");
    expect(fmtAgo(null, now)).toBe("—");
  });
});

describe("isMcpToolAction (the console's side of mcpToolCallSql)", () => {
  it("counts tool names, not dotted console or pairing actions", () => {
    for (const a of ["send_message", "search_threads", "list_accounts"]) expect(isMcpToolAction(a)).toBe(true);
    for (const a of ["pairing.key_delivered", "agent.create", "account.connect"]) expect(isMcpToolAction(a)).toBe(false);
  });
});

describe("agentOnHost", () => {
  it("adds the host only when the agent's name doesn't already end with it", () => {
    expect(agentOnHost("Claude Code on anvil", "anvil")).toBe("Claude Code on anvil");
    expect(agentOnHost("Claude Code on anvil", "anvil.local")).toBe("Claude Code on anvil");
    expect(agentOnHost("Claude Code on Anvil", "anvil")).toBe("Claude Code on Anvil");
    expect(agentOnHost("Claude Code on anvil", "forge")).toBe("Claude Code on anvil on forge");
    expect(agentOnHost("Inbox bot", "anvil")).toBe("Inbox bot on anvil");
    expect(agentOnHost("Inbox bot", null)).toBe("Inbox bot");
    // A name that is just the host, with or without .local/.lan/.home on either side.
    expect(agentOnHost("anvil", "anvil")).toBe("anvil");
    expect(agentOnHost("anvil", "anvil.local")).toBe("anvil");
    expect(agentOnHost("anvil.lan", "anvil")).toBe("anvil.lan");
    expect(agentOnHost("Claude Code on anvil.local", "anvil")).toBe("Claude Code on anvil.local");
    expect(agentOnHost("Claude Code on anvil.home", "anvil.local")).toBe("Claude Code on anvil.home");
    // Not a suffix match on a longer word.
    expect(agentOnHost("Claude Code on xanvil", "anvil")).toBe("Claude Code on xanvil on anvil");
  });
});

describe("Approvals: the CLI's ?pairing= link after a decision", () => {
  const req = (id: string, status: PairingRequest["status"], over: Partial<PairingRequest> = {}): PairingRequest => ({
    id,
    userCode: "ABCD-EFGH",
    name: "Claude Code on anvil",
    description: null,
    requested: {},
    client: {},
    ip: "127.0.0.1",
    status,
    agentId: null,
    createdAt: SENT_AT,
    expiresAt: later(600),
    decidedAt: null,
    decisionNote: null,
    ...over,
  });

  it("says what was decided instead of \"isn't waiting anymore\"", () => {
    expect(linkedPairing("ABCD-EFGH", [req("par_1", "pending")]).kind).toBe("pending");
    expect(linkedPairing("ABCD-EFGH", [req("par_1", "denied")]).kind).toBe("denied");
    const approved = linkedPairing("ABCD-EFGH", [req("par_1", "approved", { agentId: "agt_1" })]);
    expect(approved.kind === "approved" && approved.p.agentId).toBe("agt_1");
    expect(linkedPairing("ABCD-EFGH", [req("par_1", "expired")]).kind).toBe("gone");
    expect(linkedPairing("ABCD-EFGH", []).kind).toBe("gone");
    expect(linkedPairing("WXYZ-0000", [req("par_1", "denied")]).kind).toBe("gone");
  });

  it("follows the newest request when a code was reused, and a pending one first", () => {
    // Newest first, as the API lists them: a denied request's code came back on a new request.
    expect(linkedPairing("ABCD-EFGH", [req("par_2", "pending"), req("par_1", "denied")])).toMatchObject({ kind: "pending", p: { id: "par_2" } });
    expect(linkedPairing("ABCD-EFGH", [req("par_2", "expired"), req("par_1", "denied")]).kind).toBe("gone");
  });

  it("mentions the note only when one was entered", () => {
    expect(deniedDescription("")).toBe("The agent's terminal shows that it was denied.");
    expect(deniedDescription("   ")).toBe("The agent's terminal shows that it was denied.");
    expect(deniedDescription(null)).toBe("The agent's terminal shows that it was denied.");
    expect(deniedDescription("Ask in #ops first")).toBe("The agent's terminal shows that it was denied, with your note.");
  });
});

describe("wizardStep: which step /get-started shows", () => {
  it("shows ?step= as given and never pins it", () => {
    expect(wizardStep("agent", { loaded: true, firstTodo: "consent" })).toEqual({ shown: "agent", pin: null });
  });

  it("without ?step=, shows the first unfinished step and pins it once progress has loaded", () => {
    expect(wizardStep(undefined, { loaded: false, firstTodo: undefined })).toEqual({ shown: "verify", pin: null });
    expect(wizardStep(undefined, { loaded: true, firstTodo: "consent" })).toEqual({ shown: "consent", pin: "consent" });
    expect(wizardStep(undefined, { loaded: true, firstTodo: undefined })).toEqual({ shown: "verify", pin: "verify" });
  });

  it("keeps the pinned step after its requirements are met (ticking \"In production\" doesn't jump to step 4)", () => {
    const { pin } = wizardStep(undefined, { loaded: true, firstTodo: "consent" });
    // The page writes the pin into the URL; consent being done now moves firstTodo, not the user.
    expect(wizardStep(pin!, { loaded: true, firstTodo: "client" })).toEqual({ shown: "consent", pin: null });
  });
});

describe("startsVerify: which steps start the end-to-end check in this browser", () => {
  const statuses = (over: Partial<Record<StepId, StepStatus>> = {}): Record<StepId, StepStatus> => ({
    url: "done",
    project: "done",
    consent: "done",
    client: "done",
    accounts: "done",
    agent: "todo",
    verify: "todo",
    ...over,
  });

  it("starts on step 6 while no agent exists, so an early tool call can't complete step 7", () => {
    expect(startsVerify("agent", statuses(), {})).toBe(true);
    // Then the server's evidence arrives (a tool call before step 7 is opened): step 7 stays todo.
    const s = { claimed: true, googleClientConfigured: true, gcpProjectId: "p-123456", googleAppType: "external", accountsConnected: 1, agentsCreated: 1, verified: true } as SetupState;
    expect(stepStatuses(s, { verifyStarted: true }).verify).toBe("todo");
  });

  it("starts on step 7 while it is todo", () => {
    expect(startsVerify("verify", statuses({ agent: "done" }), {})).toBe(true);
  });

  it("doesn't start on an install already verified, or twice", () => {
    expect(startsVerify("verify", statuses({ agent: "done", verify: "done" }), {})).toBe(false);
    expect(startsVerify("agent", statuses({ agent: "done", verify: "done" }), {})).toBe(false);
    expect(startsVerify("verify", statuses({ agent: "done" }), { verifyStarted: true })).toBe(false);
    expect(startsVerify("verify", statuses({ agent: "done" }), { verified: true })).toBe(false);
    // Revisiting step 6 to add a second agent changes nothing.
    expect(startsVerify("agent", statuses({ agent: "done" }), {})).toBe(false);
    expect(startsVerify("accounts", statuses(), {})).toBe(false);
  });
});
