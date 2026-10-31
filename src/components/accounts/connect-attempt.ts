// The connect dialog's decisions about one sign-in attempt, kept pure so they can be unit-tested.
// Relative (not @shared): unit tests type-check this file under the server config.
import type { ConnectAttempt } from "../../../shared/types.ts";

/** null: the status request itself failed (xaq unreachable, signed out…). */
export type AttemptStatus = ConnectAttempt["status"] | null;

export type CheckNote = "pending" | "pending-reauth" | "unreachable" | "already-connected" | "expired";

export const CHECK_NOTES: Record<CheckNote, string> = {
  pending: "No new account yet. Finish signing in with Google, or use the paste option below if the window ended on an error page.",
  "pending-reauth": "Google hasn't sent you back yet. Finish signing in with Google, or use the paste option below if the window ended on an error page.",
  unreachable: "Couldn't reach xaq to check. Make sure it's still running, then try again.",
  "already-connected": "This account was already connected, so there's nothing new to detect from here. If Google's window said it worked, close this dialog.",
  expired: "This sign-in may have expired (links last 15 minutes) or xaq restarted. Open Google sign-in again to start a fresh one.",
};

export interface AttemptContext {
  /** The dialog asked for extra access (Calendar). */
  scopes: boolean;
  /** Reconnecting a specific account. */
  reauth: boolean;
  /** …that was in needs_reauth when the dialog started (so "active again" in the list proves the sign-in). */
  reauthFromBroken: boolean;
}

export type CheckStep =
  /** connected / failed: the status answer already moved the dialog on. */
  | { kind: "stop" }
  | { kind: "note"; note: CheckNote }
  /** Extra access: close the dialog unconfirmed. */
  | { kind: "finish-unconfirmed" }
  /** The server doesn't know the attempt (expired, restarted): see whether the account list shows it. */
  | { kind: "check-list" };

/** What "I'm done, check again" does after asking the server about this attempt. */
export function checkAgainStep(status: AttemptStatus, c: AttemptContext): CheckStep {
  if (status === "connected" || status === "failed") return { kind: "stop" };
  if (status === null) return { kind: "note", note: "unreachable" };
  if (status === "pending") return { kind: "note", note: c.reauth ? "pending-reauth" : "pending" };
  // unknown
  if (c.scopes) return { kind: "finish-unconfirmed" };
  if (c.reauth && !c.reauthFromBroken) return { kind: "note", note: "already-connected" };
  return { kind: "check-list" };
}

/** In the account list, the account this attempt would have produced (the server forgot the attempt). */
export function listMatch<A extends { id: string; status: string }>(
  accounts: A[],
  c: { reauthAccountId?: string; reauthFromBroken: boolean; known: ReadonlySet<string> },
): A | undefined {
  if (c.reauthAccountId) return c.reauthFromBroken ? accounts.find((a) => a.id === c.reauthAccountId && a.status === "active") : undefined;
  return accounts.find((a) => !c.known.has(a.id));
}

/**
 * Whether an account update on the live stream is worth asking the server about: the account being
 * reconnected, or a new one. Without a target any account counts (signing in as an address that's
 * already here reconnects it).
 */
export function streamUpdateConcerns(accountId: string, c: { reauthAccountId?: string; known: ReadonlySet<string> }): boolean {
  return !c.reauthAccountId || accountId === c.reauthAccountId || !c.known.has(accountId);
}

/** A status answer applies only while the dialog still waits on that same attempt (not closed, retried or finished). */
export function answerApplies(phase: { kind: string; res?: { state: string } } | null | undefined, state: string): boolean {
  return phase?.kind === "waiting" && phase.res?.state === state;
}

/**
 * Sign-in failures a caller that shows the outcome itself (handBack: "Add Google Calendar") takes over:
 * nothing is broken, the user cancelled or unticked Calendar, and the account's mail is unaffected.
 */
export const handsBack = (code: string): boolean => code === "oauth_calendar_not_granted" || code === "oauth_access_denied";

/**
 * "Connect with mail only" after Google refused a sign-in that asked for Calendar (a Workspace admin may
 * block Calendar for unconfigured apps, which rejects the whole consent). Such a consent: Calendar is on for
 * the install, or a reconnect (it re-asks for Calendar the account had). Not for "Add Calendar to X" (its
 * mail is unaffected), nor after a mail-only attempt (then the admin blocks the app itself).
 */
export function offersMailOnly(
  code: string | undefined,
  req: { reauthAccountId?: string; scopes?: readonly string[]; mailOnly?: boolean },
  calendarOn: boolean,
): boolean {
  return code === "oauth_admin_policy_enforced" && !req.scopes?.length && !req.mailOnly && (calendarOn || !!req.reauthAccountId);
}
