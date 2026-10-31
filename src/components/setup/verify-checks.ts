// The Verify step's checks as a pure function of what the console knows, so they can be tested
// directly. No React and relative imports only (no @ aliases): vitest and the server/test typecheck
// load this module too.

import type { AuditEntry, EventType, ListenerInfo, MailEvent, TestEmailResult } from "../../../shared/types.ts";
import { listenerHandled } from "../agents/listener-handled.ts";

export const TEST_SUBJECT = "xaq test: your setup works";
/** A test email older than this is forgotten: its events may have scrolled out of the first page. */
export const TEST_TTL_MS = 60 * 60_000;
/** Read-type tools: the agent reading the test email over MCP. */
export const READ_TOOLS = new Set(["search_threads", "get_thread", "get_message", "list_events", "wait_for_events"]);

export interface VerifyTest extends TestEmailResult {
  accountId: string;
  /**
   * Consumers of the listeners that existed (connected or not) when the test was sent. Only these count for delivery: a
   * listener that connects later starts its cursor at the newest event, so its ackedSeq passes the
   * test email without ever having handled it.
   */
  listenersAtSend?: string[];
}

/** The test, unless it is too old to still be found among recent events. */
export function activeTest(test: VerifyTest | undefined, now: number): VerifyTest | undefined {
  return test && now - Date.parse(test.sentAt) < TEST_TTL_MS ? test : undefined;
}

export interface VerifyInput {
  test: VerifyTest | undefined;
  /** Recent events of the test's account, newest first. */
  events: MailEvent[];
  listeners: ListenerInfo[];
  /** This agent's MCP tool calls (audit entries), newest first. */
  calls: AuditEntry[];
  skipListen: boolean;
}

export interface VerifyResult {
  sent: boolean;
  received: MailEvent | undefined;
  /** A listener that was connected at send time has acknowledged the test email. */
  delivered: boolean;
  /** Received and not delivered, none of the listeners known at send time is connected, but another one is: send another. */
  resendForListener: boolean;
  /** The agent read mail over MCP (successfully) after the test was sent. */
  readIt: boolean;
  /**
   * Received and not delivered, and every listener known at send time asked for event types without
   * message.received (e.g. `--types thread.reply_received`): it acks the test email without running
   * its command. The types they asked for (sorted, no duplicates); null otherwise.
   */
  typesExcludeIt: EventType[] | null;
}

export function verifyChecks({ test, events, listeners, calls, skipListen }: VerifyInput): VerifyResult {
  if (!test) return { sent: false, received: undefined, delivered: false, resendForListener: false, readIt: false, typesExcludeIt: null };
  const ofTest = events.filter(
    (e) => e.accountId === test.accountId && (e.message?.id === test.messageId || (e.message?.subject === TEST_SUBJECT && e.createdAt >= test.sentAt)),
  );
  const received = ofTest.find((e) => e.type === "message.received") ?? ofTest[0];
  const atSend = new Set(test.listenersAtSend ?? []);
  // Of a type the listener asked for, past where its cursor started, and acked (see listenerHandled).
  const delivered = !!received && listeners.some((l) => atSend.has(l.consumer) && listenerHandled(l, received));
  const recorded = listeners.filter((l) => atSend.has(l.consumer));
  const excluding =
    received?.type === "message.received" && !delivered && recorded.length > 0 && recorded.every((l) => l.types && !l.types.includes(received.type));
  return {
    typesExcludeIt: excluding ? [...new Set(recorded.flatMap((l) => l.types ?? []))].sort() : null,
    sent: true,
    received,
    delivered,
    resendForListener:
      !!received && !skipListen && !delivered && !listeners.some((l) => atSend.has(l.consumer) && l.connected) && listeners.some((l) => l.connected),
    readIt: calls.some((e) => e.outcome === "ok" && READ_TOOLS.has(e.action) && e.ts >= test.sentAt),
  };
}

export interface ChecksState {
  mcpDone: boolean;
  listenDone: boolean;
  skipListen: boolean;
  sent: boolean;
  received: boolean;
  delivered: boolean;
}

/**
 * Every required check is green: what shows "Setup complete" and, from then on, marks step 7 done in
 * this browser (SetupDraft.verified) without waiting for "Finish setup". Reading the mail is optional.
 */
export function checksComplete({ mcpDone, listenDone, skipListen, sent, received, delivered }: ChecksState): boolean {
  return mcpDone && (listenDone || skipListen) && sent && received && (delivered || skipListen);
}

// ───────────── Revisiting a finished step ─────────────

/**
 * What step 7 shows. Done when it was opened (SetupDraft.verified, or the server's SetupState.verified):
 * its completed state, since this browser's test email may be gone (another browser, or older than
 * TEST_TTL_MS) and re-running every check would look like setup came undone. "Run the checks again"
 * (`recheck`) shows the live checks without un-completing anything. A step that turns done while open
 * keeps showing the checks (and their "Setup complete" panel).
 */
export function verifyMode(doneWhenOpened: boolean, recheck: boolean): "complete" | "checks" {
  return doneWhenOpened && !recheck ? "complete" : "checks";
}

/** Step 7's footer. "Finish setup" is never disabled once the step is done: the stepper shows it ✓. */
export function verifyFooter(stepDone: boolean, checksGreen: boolean): { nextDisabled: boolean; hint: string | null; skip: boolean } {
  if (stepDone || checksGreen) return { nextDisabled: false, hint: null, skip: false };
  return { nextDisabled: true, hint: "Finish turns on when every check is green", skip: true };
}

export interface DoneSummaryInput {
  /** SetupState.verified: some agent made a successful tool call, or a listener acked an event. */
  serverVerified: boolean;
  /** This browser's last test email, however old (not activeTest). */
  test: VerifyTest | undefined;
  /** The checked agent's recent tool calls (audit entries), newest first. */
  calls: AuditEntry[];
  /** Agent.lastMcpAt. */
  connectedAt: string | null;
  listeners: ListenerInfo[];
  /** No listener expected ("MCP only", or an agent that can't run one). */
  skipListen: boolean;
  /** SetupDraft.verifiedBy: how this browser finished the step; undefined when unknown (another browser, older drafts). */
  verifiedBy?: "checks" | "skip";
}

export type DoneLine =
  /** Every check went green in this browser. */
  | { id: "checked" }
  /** Finished with "Finish without checking". */
  | { id: "skipped" }
  /** The agent reached xaq: its last successful tool call, else when it last connected. */
  | { id: "mcp"; at: string; action: string | null }
  | { id: "listener"; connected: boolean; hostname: string | null; at: string | null }
  | { id: "mcpOnly" }
  /** A test email was sent from this browser. */
  | { id: "test"; at: string }
  /** How it was finished is unknown here, and xaq has no record of any agent working. */
  | { id: "unchecked" };

/** The completed step's summary of what was verified, from what is still known now. */
export function doneSummary({ serverVerified, test, calls, connectedAt, listeners, skipListen, verifiedBy }: DoneSummaryInput): DoneLine[] {
  const lines: DoneLine[] = [];
  if (verifiedBy === "checks") lines.push({ id: "checked" });
  const ok = calls.find((e) => e.outcome === "ok");
  if (ok || connectedAt) lines.push({ id: "mcp", at: ok?.ts ?? connectedAt!, action: ok?.action ?? null });
  const listener =
    listeners.find((l) => l.connected) ?? [...listeners].sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))[0];
  if (listener) lines.push({ id: "listener", connected: listener.connected, hostname: listener.client.hostname ?? null, at: listener.lastSeenAt });
  else if (skipListen) lines.push({ id: "mcpOnly" });
  if (test) lines.push({ id: "test", at: test.sentAt });
  if (verifiedBy === "skip") lines.push({ id: "skipped" });
  else if (!verifiedBy && !serverVerified) lines.push({ id: "unchecked" });
  return lines;
}
