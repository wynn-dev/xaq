// Relative (not @shared): unit tests load this file under the server config.
import type { AccountStatus, AuditOutcome, CalendarEventChange, CalendarResponseStatus, EventType } from "../../shared/types.ts";

export type Tone = "good" | "warn" | "bad" | "idle" | "info";

export const CALENDAR_RESPONSE_LABEL: Record<CalendarResponseStatus, string> = {
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Maybe",
  needsAction: "No answer yet",
};

/** detail.changes of calendar.event_updated, as words for "Changed: time and place". */
export const CALENDAR_CHANGE_LABEL: Record<CalendarEventChange, string> = {
  summary: "title",
  time: "time",
  location: "place",
  description: "description",
  attendees: "guests",
  responses: "answers",
  status: "status",
  recurrence: "repeat",
  conference: "video call",
};

export const EVENT_TYPE_INFO: Record<EventType, { label: string; description: string }> = {
  "message.received": { label: "Message received", description: "A new message arrived (not sent by the account itself)." },
  "message.sent": { label: "Message sent", description: "A message was sent from the account, by an agent or a person." },
  "thread.reply_received": {
    label: "Reply received",
    description: "Someone replied in a thread the account has sent into. Great for follow-up agents.",
  },
  "label.added": { label: "Label added", description: "A label was added to a message." },
  "label.removed": { label: "Label removed", description: "A label was removed from a message." },
  "account.auth_failed": {
    label: "Account auth failed",
    description: "Google revoked or expired the account's access; it needs to be reconnected.",
  },
  "sync.gap": {
    label: "Sync gap",
    description: "History was too old to replay; a bounded resync ran and some events may be missing.",
  },
  "calendar.event_created": { label: "Calendar event created", description: "A new event appeared on a synced calendar." },
  "calendar.event_updated": { label: "Calendar event updated", description: "An event's time, title, place, attendees or answers changed." },
  "calendar.event_cancelled": { label: "Calendar event cancelled", description: "An event was cancelled or deleted." },
  "calendar.invitation_received": {
    label: "Invitation received",
    description: "Someone invited the account to an event and is waiting for an answer.",
  },
  "connection.auth_failed": {
    label: "Connection auth failed",
    description: "An integration's credential stopped working; it needs to be reconnected.",
  },
  "connection.expiring": { label: "Connection expiring", description: "An integration's sign-in stops working soon; reconnect it before then." },
};

export const ACCOUNT_STATUS: Record<AccountStatus, { label: string; tone: Tone; description: string }> = {
  active: { label: "Active", tone: "good", description: "Syncing normally." },
  needs_reauth: {
    label: "Needs reconnect",
    tone: "bad",
    description: "Google no longer accepts this account's token. Reconnect it to resume.",
  },
  paused: { label: "Paused", tone: "idle", description: "Not syncing and not available to agents until resumed." },
  error: { label: "Error", tone: "bad", description: "Syncing failed. See the error for details." },
};

export const AUDIT_OUTCOME: Record<AuditOutcome, { label: string; tone: Tone }> = {
  ok: { label: "OK", tone: "good" },
  denied: { label: "Denied", tone: "warn" },
  error: { label: "Error", tone: "bad" },
};

/** Plain-language explanations for guardrail denial reasons (and why a tool call was rejected). */
export const DENIAL_REASONS: Record<string, string> = {
  allow_to: "A recipient isn't on the grant's allowlist",
  read_only: "The agent has read-only access",
  no_access: "The agent has no access to this account",
  no_grant: "The agent has no access to this account",
  disabled: "The agent is disabled",
  account_paused: "The account is paused",
  account_required: "The agent has several accounts and didn't say which one",
  needs_reauth: "The account needs to be reconnected",
  pairing_disabled: "Pairing is turned off in Settings",
  pending_cap: "Too many pairing requests are already waiting",
  lockout: "Too many wrong codes or keys from this address",
  not_found: "The item doesn't exist or is outside the agent's access",
  calendar_not_found: "The calendar isn't in the account's calendar list",
  calendar_not_granted: "The account hasn't added Google Calendar yet (add it on the Accounts page)",
  calendar_api_disabled: "The Google Calendar API is turned off in the Google Cloud project",
  // Tool calls rejected before the tool ran (outcome "error").
  invalid_arguments: "The agent's arguments don't match the tool's schema",
  unknown_tool: "No such tool for this agent (unknown, or its grants don't include it)",
  invalid_request: "The agent sent a malformed tool call",
};

/** A denial or rejection reason in plain words, to follow "denied: " and the like (the code when unknown). */
export function explainReason(reason: string): string {
  const text = DENIAL_REASONS[reason];
  return text ? text[0]!.toLowerCase() + text.slice(1) : reason;
}
