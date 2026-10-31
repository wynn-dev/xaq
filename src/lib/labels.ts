// Relative (not @shared): unit tests load this file under the server config.
import {
  type AccountStatus,
  type ApprovalKind,
  type ApprovalStatus,
  type AuditOutcome,
  type CalendarEventChange,
  type CalendarResponseStatus,
  type CalendarWriteMode,
  type Capability,
  type EventType,
  isCalendarApprovalKind,
  type SendMode,
} from "../../shared/types.ts";

export type Tone = "good" | "warn" | "bad" | "idle" | "info";

export const CAPABILITY_INFO: Record<Capability, { label: string; description: string }> = {
  read: {
    label: "Read",
    description: "Search and read messages, threads, labels and attachments, and receive mail events.",
  },
  draft: { label: "Draft", description: "Create, update and delete drafts. Nothing is sent." },
  send: {
    label: "Send",
    description: "Send, reply and forward. How sending behaves is set by the send mode below.",
  },
  organize: { label: "Organize", description: "Add and remove labels, archive, mark read or unread, star." },
  trash: { label: "Trash", description: "Move messages and threads to the trash (recoverable for 30 days in Gmail)." },
  "calendar.read": {
    label: "Calendar: read",
    description: "List calendars, read and search events, check free/busy, and receive calendar events.",
  },
  "calendar.write": {
    label: "Calendar: write",
    description: "Create, change and delete events and answer invitations. How writes run is set by the calendar write mode.",
  },
};

export const CALENDAR_WRITE_MODE_INFO: Record<CalendarWriteMode, { label: string; short: string; description: string }> = {
  direct: {
    label: "Direct",
    short: "Direct",
    description: "Changes go to Google Calendar immediately. The attendee allowlist and send limits still apply.",
  },
  approval: {
    label: "Ask me first",
    short: "Approval",
    description: "Changes wait in Approvals here. Approving applies them; rejecting discards them. Nothing reaches Google before.",
  },
};

/** The grant editor's third calendar write choice: no calendar.write at all. */
export const CALENDAR_NO_WRITE_INFO = {
  label: "None",
  description: "The agent can't create, change or delete events or answer invitations.",
} as const;

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

export const SEND_MODE_INFO: Record<SendMode, { label: string; short: string; description: string }> = {
  direct: {
    label: "Send directly",
    short: "Direct",
    description: "Messages go out immediately. Recipient allowlist and rate limits still apply.",
  },
  draft_only: {
    label: "Draft only",
    short: "Draft only",
    description: "Sending creates a Gmail draft instead. A human reviews and sends it from Gmail.",
  },
  approval: {
    label: "Needs approval",
    short: "Approval",
    description:
      "Sending creates a draft and queues it in Approvals here. Approving sends it; rejecting deletes the draft.",
  },
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
  "approval.requested": { label: "Approval requested", description: "An agent's risky tool call waits for your approval." },
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

export const APPROVAL_STATUS: Record<ApprovalStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "warn" },
  approved: { label: "Approved", tone: "info" },
  rejected: { label: "Rejected", tone: "idle" },
  sent: { label: "Sent", tone: "good" },
  failed: { label: "Send failed", tone: "bad" },
  expired: { label: "Expired", tone: "idle" },
};

export const AUDIT_OUTCOME: Record<AuditOutcome, { label: string; tone: Tone }> = {
  ok: { label: "OK", tone: "good" },
  denied: { label: "Denied", tone: "warn" },
  error: { label: "Error", tone: "bad" },
};

/** Plain-language explanations for guardrail denial reasons (and why a tool call was rejected). */
export const DENIAL_REASONS: Record<string, string> = {
  allow_to: "A recipient isn't on the grant's allowlist",
  label_scope: "The message is outside the agent's label scope",
  rate_limit: "The grant's send cap was reached",
  capability: "The grant doesn't include this capability",
  reply_only: "The grant only allows replies in visible threads",
  no_grant: "The agent has no access to this account",
  disabled: "The agent is disabled",
  account_paused: "The account is paused",
  account_required: "The agent has several accounts and didn't say which one",
  needs_reauth: "The account needs to be reconnected",
  pairing_disabled: "Pairing is turned off in Settings",
  pending_cap: "Too many pairing requests are already waiting",
  lockout: "Too many wrong codes or keys from this address",
  not_found: "The item doesn't exist or is outside the agent's access",
  calendar_scope: "The calendar is outside the agent's calendar scope",
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

export const KIND_LABEL = {
  send: "New message",
  reply: "Reply",
  forward: "Forward",
  "calendar.create": "New calendar event",
  "calendar.update": "Calendar event change",
  "calendar.delete": "Calendar event deletion",
  "calendar.rsvp": "Invitation answer",
  "mcp.call": "Tool call",
} as const satisfies Record<ApprovalKind, string>;

/** Approval status in its kind's words: a calendar approval that went through was applied, not sent. */
export function approvalStatusInfo(status: ApprovalStatus, kind: ApprovalKind | "mcp.call"): { label: string; tone: Tone } {
  // A broker tool call (mcp.call) that went through ran; it wasn't sent.
  if (kind === "mcp.call" && status === "sent") return { label: "Ran", tone: "good" };
  if (kind === "mcp.call" && status === "failed") return { label: "Call failed", tone: "bad" };
  if (isCalendarApprovalKind(kind) && status === "sent") return { label: "Applied", tone: "good" };
  if (isCalendarApprovalKind(kind) && status === "failed") return { label: "Couldn't apply", tone: "bad" };
  return APPROVAL_STATUS[status];
}
