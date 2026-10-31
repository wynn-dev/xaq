// Calendar guardrails as pure functions over a Grant (workstream B).
// Callers (server/calendar/agent.ts, server/calendar/approvals.ts) throw these as PolicyDenied.

import { randomBytes } from "node:crypto";
import type { Grant } from "../../shared/types.ts";
import { PolicyDenied } from "../util/errors.ts";
import { disallowedRecipients } from "./enforce.ts";

export { CALENDAR_WRITE_ACTIONS } from "./enforce.ts";

/**
 * Canonical form of a calendar id: trimmed, and lower-cased when email-shaped (the primary calendar's id
 * is the account email; group calendars are "…@group.calendar.google.com"). Grants store this form.
 */
export const normalizeCalendarId = (calendarId: string): string => {
  const id = calendarId.trim();
  return id.includes("@") ? id.toLowerCase() : id;
};

/** Google's "primary" alias resolves to the account's own calendar id: its email. */
export const resolveCalendarId = (calendarId: string, accountEmail: string): string =>
  calendarId.trim().toLowerCase() === "primary" ? accountEmail.toLowerCase() : normalizeCalendarId(calendarId);

/**
 * Whether the grant's calendar scope lists this calendar id. A null scope means "every calendar in the
 * account's list": callers must still check the id against that list (AgentCalendar.calendarFor).
 */
export function calendarInScope(grant: Pick<Grant, "calendarScope">, calendarId: string): boolean {
  return grant.calendarScope === null || grant.calendarScope.includes(normalizeCalendarId(calendarId));
}

/** Like notAccessible for mail: never reveals whether an out-of-scope calendar exists. */
export const calendarNotAccessible = (calendarId: string) =>
  `Calendar ${calendarId} was not found or is not accessible to you. Use list_calendars to see the calendars you can use.`;

export function assertCalendarInScope(grant: Grant, calendarId: string): void {
  if (!calendarInScope(grant, calendarId)) throw new PolicyDenied("calendar_scope", calendarNotAccessible(calendarId));
}

const isResource = (email: string) => /@resource\.calendar\.google\.com$/i.test(email);

/**
 * Who a write puts in touch with whom. Emails are compared
 * lower-cased; the account itself and rooms never count.
 * - `emailed`: addresses Google emails when notifying (sendUpdates "all"). Create/update: every attendee
 *   after the change plus removed ones (they get a cancellation) and the organizer when it's someone else.
 *   Delete: every attendee of an event the account organizes, else the organizer. RSVP: the organizer.
 *   Empty without notify.
 * - `checked`: addresses the grant's allowTo must cover. Create/update, whatever notify says (the event stays
 *   visible to them and anyone who can edit it can read what the agent wrote): every attendee after the
 *   change and the organizer when it's someone else, plus `emailed`. Delete: `emailed` only (nothing is
 *   written to anyone else). RSVP with a comment: the organizer and every attendee, since Google shows the
 *   note to all of them; a bare answer is like replying and isn't checked.
 */
export function attendeeImpact(input: {
  kind: "create" | "update" | "delete" | "rsvp";
  selfEmail: string;
  /** Attendees before the change (update/delete). */
  before: string[];
  /** Attendees after the change (create/update; for update omit = unchanged → pass `before`). */
  after: string[];
  notify: boolean;
  /** The event's organizer (update/delete/rsvp), null when unknown or the account itself. */
  organizer?: string | null;
  /** delete: whether the account organizes the event (only then do attendees get a cancellation). */
  organizerSelf?: boolean;
  /** rsvp: a comment goes to the organizer with the answer. */
  comment?: boolean;
}): { emailed: string[]; checked: string[] } {
  const self = input.selfEmail.trim().toLowerCase();
  const norm = (xs: (string | null | undefined)[]) => [
    ...new Set(xs.map((x) => (x ?? "").trim().toLowerCase()).filter((x) => x && x !== self && !isResource(x))),
  ];
  const organizer = input.organizerSelf ? [] : norm([input.organizer]);
  const before = norm(input.before);
  if (input.kind === "rsvp") return { emailed: input.notify ? organizer : [], checked: input.comment ? norm([...organizer, ...before]) : [] };
  const after = input.kind === "delete" ? [] : norm(input.after);
  const removed = before.filter((x) => !after.includes(x));
  let emailed: string[] = [];
  if (input.notify) {
    if (input.kind === "delete") emailed = input.organizerSelf ? before : organizer;
    else emailed = norm([...after, ...removed, ...organizer]);
  }
  return { emailed, checked: input.kind === "delete" ? emailed : norm([...after, ...organizer, ...emailed]) };
}

/** Throws allow_to when the grant's recipient allowlist doesn't cover every `checked` attendee. */
export function assertAttendeesAllowed(grant: Grant, checked: string[]): void {
  const bad = disallowedRecipients(grant, checked);
  if (bad.length) {
    throw new PolicyDenied(
      "allow_to",
      `Not allowed to involve ${bad.join(", ")} in this event. This account only lets you contact: ${grant.allowTo.join(", ")}. ` +
        "Remove those attendees, leave events organized by others alone, or ask the operator to extend the allowlist.",
    );
  }
}

/**
 * replyOnly grants may answer and edit, but not reach new people: adding attendees (on create or update) is
 * denied, whatever notify says. `added` is attendees not on the event before (self and rooms excluded).
 */
export function assertNoNewAttendees(grant: Grant, added: string[]): void {
  if (grant.replyOnly && added.length) {
    throw new PolicyDenied(
      "reply_only",
      `This account only lets you reply, so you can't invite new people (${added.join(", ")}). Leave attendees unchanged, or ask the operator to lift the reply-only rule.`,
    );
  }
}

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/**
 * A fresh Google event id, chosen before the insert so a retried create can't make a second event: Google
 * answers 409 for an id that exists. Google's rules: base32hex characters (a-v, 0-9), 5-1024 long.
 * 26 characters = 130 random bits.
 */
export function newCalendarEventId(): string {
  const bytes = randomBytes(26);
  let out = "";
  for (const b of bytes) out += BASE32HEX[b & 31];
  return out;
}
