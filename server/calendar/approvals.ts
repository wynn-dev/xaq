// Applying calendar changes (workstream B). The approval state machine stays
// in server/mail/approvals.ts; it calls these for calendar.* kinds. Direct-mode writes (AgentCalendar) go
// through the same applyChange and afterFailure, so both paths send the same requests to Google and judge
// a failed attempt the same way.

import { randomUUID } from "node:crypto";
import type { Approval, CalendarApprovalDetail, CalendarEventInput, CalendarResponseStatus, GoogleApproval, Grant } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import type { CalendarAttendeeRaw, CalendarClient, CalendarDateTimeRaw, CalendarEventRaw } from "../google/calendar.ts";
import { classifyCalendarError } from "../google/calendar.ts";
import { hasReason } from "../google/http.ts";
import { AccountNeedsReauthError, GoogleApiError } from "../google/types.ts";
import { now } from "../db/index.ts";
import { attendeeImpact, calendarInScope, normalizeCalendarId } from "../policy/calendar.ts";
import { disallowedRecipients } from "../policy/enforce.ts";
import { selfAttendee } from "./summary.ts";
import type { CalendarService } from "./types.ts";

export type CalendarApprovals = Pick<CalendarService, "approvalBlockedReason" | "applyApproval">;

export type CalendarWriteKind = "create" | "update" | "delete" | "rsvp";

export const writeKindOf = (kind: Approval["kind"]): CalendarWriteKind | null =>
  kind === "calendar.create" ? "create" : kind === "calendar.update" ? "update" : kind === "calendar.delete" ? "delete" : kind === "calendar.rsvp" ? "rsvp" : null;

/**
 * A write that is known not to have been applied (or can't be, or may have been), in words for the agent and
 * the approval card. `code` is the agent-facing ToolError code in direct mode.
 */
export class CalendarApplyError extends Error {
  constructor(
    readonly code: "calendar_conflict" | "not_found" | "write_uncertain" | "event_id_taken",
    message: string,
  ) {
    super(message);
  }
}

export const EVENT_CHANGED = "The event changed in Google Calendar since the change was prepared, so it was not applied.";
export const EVENT_GONE = "The event no longer exists in Google Calendar.";
export const MAYBE_APPLIED =
  "The change may already have been applied, but the event has changed in Google Calendar since, so xaq can't tell. Check Google Calendar.";
export const ID_TAKEN = "That event id already belongs to a different event, so nothing was created.";

const ALL_DAY = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/i;
const isRoom = (email: string) => /@resource\.calendar\.google\.com$/i.test(email);

/** Start/end for Google; the other form is cleared so a patch can switch between timed and all-day. */
function when(value: string, timeZone: string | undefined): CalendarDateTimeRaw {
  if (ALL_DAY.test(value)) return { date: value, dateTime: null, timeZone: null } as unknown as CalendarDateTimeRaw;
  return { dateTime: value, date: null, ...(timeZone ? { timeZone } : {}) } as unknown as CalendarDateTimeRaw;
}

/**
 * The new attendee list: people already on the event keep their entry (response, optional flag), new ones
 * are added by email. The account's own entry is always kept. Rooms are kept too unless the list names
 * rooms itself: then it is the full room list.
 */
function mergeAttendees(existing: CalendarAttendeeRaw[], emails: string[]): CalendarAttendeeRaw[] {
  const byEmail = new Map(existing.filter((x) => x.email).map((x) => [x.email!.toLowerCase(), x]));
  const wanted = new Set(emails);
  const listsRooms = emails.some(isRoom);
  const kept = existing.filter((x) => {
    const email = x.email?.toLowerCase() ?? "";
    if (wanted.has(email)) return false;
    return x.self || (!listsRooms && (x.resource || isRoom(email)));
  });
  return [...emails.map((e) => byEmail.get(e) ?? { email: e }), ...kept];
}

/** Google event resource for a create, or the changed fields for a patch (`current` = the event being changed). */
export function eventResource(change: CalendarEventInput, current: CalendarEventRaw | null): Partial<CalendarEventRaw> {
  const r: Partial<CalendarEventRaw> = {};
  if (change.summary !== undefined) r.summary = change.summary;
  if (change.description !== undefined) r.description = change.description;
  if (change.location !== undefined) r.location = change.location;
  if (change.start !== undefined) r.start = when(change.start, change.timeZone);
  if (change.end !== undefined) r.end = when(change.end, change.timeZone);
  if (change.attendees !== undefined) r.attendees = mergeAttendees(current?.attendees ?? [], change.attendees);
  if (change.recurrence !== undefined) r.recurrence = change.recurrence;
  if (change.addConference) r.conferenceData = { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  return r;
}

/** Whether a start/end Google returned is the one asked for (Google may re-express a time in the event's zone). */
function sameTime(asked: string, got: CalendarDateTimeRaw | undefined, timeZone: string | undefined): boolean {
  if (ALL_DAY.test(asked)) return got?.date === asked;
  const dt = got?.dateTime;
  if (!dt) return false;
  if (OFFSET.test(asked)) return Date.parse(asked) === Date.parse(dt);
  return dt.slice(0, 19) === asked.slice(0, 19) && (!timeZone || got?.timeZone === timeZone);
}

/** Whether every field of `change` already holds on `e` (so the change is in Google Calendar). */
export function changeMatches(change: CalendarEventInput, e: CalendarEventRaw): boolean {
  if (change.summary !== undefined && (e.summary ?? "") !== change.summary) return false;
  if (change.description !== undefined && (e.description ?? "") !== change.description) return false;
  if (change.location !== undefined && (e.location ?? "") !== change.location) return false;
  if (change.start !== undefined && !sameTime(change.start, e.start, change.timeZone)) return false;
  if (change.end !== undefined && !sameTime(change.end, e.end, change.timeZone)) return false;
  if (change.attendees !== undefined) {
    const people = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()).filter((x) => !isRoom(x)))].sort();
    const self = (e.attendees ?? []).filter((x) => x.self).map((x) => x.email?.toLowerCase());
    const now = people((e.attendees ?? []).filter((x) => x.email && !x.self && !x.resource).map((x) => x.email!));
    if (people(change.attendees.filter((x) => !self.includes(x))).join() !== now.join()) return false;
  }
  if (change.recurrence !== undefined && JSON.stringify(e.recurrence ?? []) !== JSON.stringify(change.recurrence)) return false;
  if (change.addConference && !e.conferenceData && !e.hangoutLink) return false;
  return true;
}

const rsvpMatches = (d: CalendarApprovalDetail, e: CalendarEventRaw): boolean => {
  const self = selfAttendee(e);
  return self?.responseStatus === d.response && (self.comment ?? null) === (d.comment ?? null);
};

const status = (err: unknown) => (err instanceof GoogleApiError ? err.status : null);

/**
 * A failure after which Google may still have acted: a timeout or dropped connection (status 0), a 5xx, a
 * retried If-Match write the client marks "outcome_unknown" (workstream A's isOutcomeUnknown), or a network
 * error outside the Google client.
 */
export function isAmbiguous(err: unknown): boolean {
  if (err instanceof GoogleApiError) return err.status === 0 || err.status >= 500 || hasReason(err, "outcome_unknown");
  return !(err instanceof AccountNeedsReauthError) && !(err instanceof CalendarApplyError);
}

/**
 * Sends one change to Google. `current` is the event as it is now (update: to keep existing attendees'
 * entries; rsvp: to find the account's own attendee entry). Update and delete send If-Match with the stored
 * etag (412 = changed since). A create uses the id chosen in advance (409 = it exists). Returns the event
 * after the change (null for delete). Failures are judged by afterFailure.
 */
export async function applyChange(
  client: CalendarClient,
  kind: CalendarWriteKind,
  d: CalendarApprovalDetail & { eventId: string },
  current: CalendarEventRaw | null,
): Promise<CalendarEventRaw | null> {
  const sendUpdates = d.notifyAttendees ? "all" : "none";
  const conferenceDataVersion = d.change.addConference ? 1 : 0;
  switch (kind) {
    case "create":
      return client.insertEvent(d.calendarId, { id: d.eventId, ...eventResource(d.change, null) }, { sendUpdates, conferenceDataVersion });
    case "update":
      return client.patchEvent(d.calendarId, d.eventId, eventResource(d.change, current), { sendUpdates, conferenceDataVersion, ifMatchEtag: d.etag ?? undefined });
    case "delete":
      await client.deleteEvent(d.calendarId, d.eventId, { sendUpdates, ifMatchEtag: d.etag ?? undefined });
      return null;
    case "rsvp": {
      const self = current && selfAttendee(current);
      if (!self?.email) throw new CalendarApplyError("not_found", "The account is no longer invited to this event.");
      const attendee: CalendarAttendeeRaw = { email: self.email, responseStatus: d.response as CalendarResponseStatus, ...(d.comment ? { comment: d.comment } : {}) };
      return client.patchEvent(d.calendarId, d.eventId, { attendees: [attendee], attendeesOmitted: true }, { sendUpdates });
    }
  }
}

/**
 * What a failed write means, judged from the event as it is now. A 412, a 409 on create, a 404/410 on
 * delete and ambiguous failures (isAmbiguous) are checked; anything else is returned as is.
 * - `applied`: the change is in Google Calendar (an earlier attempt, or a lost answer, did it).
 * - `error`: the original error when retrying is safe (known not applied; a create retries with the same
 *   id, an update with the same If-Match), or a CalendarApplyError: changed since (not applied), gone, or
 *   "may already have been applied" when an earlier attempt may have landed and the event moved on since.
 * `attemptedBefore`: an earlier attempt at this same change reached Google (approval retries, crash recovery).
 */
export async function afterFailure(
  client: CalendarClient,
  kind: CalendarWriteKind,
  d: CalendarApprovalDetail & { eventId: string },
  err: unknown,
  attemptedBefore: boolean,
): Promise<{ applied: CalendarEventRaw | null } | { error: unknown }> {
  const code = status(err);
  const ambiguous = isAmbiguous(err);
  const gone = code === 404 || code === 410;
  if (kind === "delete" && gone) return { applied: null };
  if (!ambiguous && code !== 412 && !(kind === "create" && code === 409)) return { error: err };
  let current: CalendarEventRaw | null;
  try {
    current = await client.getEvent(d.calendarId, d.eventId);
  } catch (e) {
    if (status(e) !== 404 && status(e) !== 410) return { error: ambiguous ? err : e };
    current = null;
  }
  const live = current && current.status !== "cancelled" ? current : null;
  const mayHaveLanded = attemptedBefore || ambiguous;
  switch (kind) {
    case "create":
      if (live && (mayHaveLanded || changeMatches(d.change, live))) return { applied: live };
      if (current && !live && mayHaveLanded) return { applied: current }; // created, then deleted by someone
      if (code === 409) return { error: new CalendarApplyError("event_id_taken", ID_TAKEN) };
      return { error: err };
    case "delete":
      if (!live) return { applied: null };
      return { error: ambiguous ? err : new CalendarApplyError("calendar_conflict", EVENT_CHANGED) };
    case "update":
      if (!live) return { error: new CalendarApplyError("not_found", EVENT_GONE) };
      if (changeMatches(d.change, live)) return { applied: live };
      if (live.etag === d.etag) return { error: ambiguous ? err : new CalendarApplyError("calendar_conflict", EVENT_CHANGED) };
      return { error: new CalendarApplyError(mayHaveLanded ? "write_uncertain" : "calendar_conflict", mayHaveLanded ? MAYBE_APPLIED : EVENT_CHANGED) };
    case "rsvp":
      if (!live) return { error: new CalendarApplyError("not_found", EVENT_GONE) };
      if (rsvpMatches(d, live)) return { applied: live };
      return { error: err };
  }
}

/**
 * An RSVP comment is shown to the organizer and every invitee: under the grant's allowlist they must all
 * still pass when it's applied, and the guest list must still be visible to the account. Throws (for good)
 * otherwise.
 */
function commentStillAllowed(grant: Grant, e: CalendarEventRaw, selfEmail: string): void {
  if (!grant.allowTo.length || e.organizer?.self) return;
  if (e.guestsCanSeeOtherGuests === false || e.attendeesOmitted) {
    throw new Error("The organizer now hides the guest list, so who would see the comment can't be checked against the agent's allowlist.");
  }
  const others = (e.attendees ?? []).filter((x) => x.email && !x.self && !x.resource).map((x) => x.email!);
  const { checked } = attendeeImpact({ kind: "rsvp", selfEmail, before: others, after: [], notify: false, organizer: e.organizer?.email ?? null, comment: true });
  const bad = disallowedRecipients(grant, checked);
  if (bad.length) throw new Error(`The comment would now be shown to ${bad.join(", ")}, whom the agent may no longer contact.`);
}

/** Who the stored change involves (CalendarApprovalDetail.checked; recomputed for approvals stored without it). */
function checkedOf(kind: CalendarWriteKind, d: CalendarApprovalDetail, selfEmail: string): string[] {
  if (d.checked) return d.checked;
  const before = (d.before?.attendees ?? []).filter((x) => !x.self && !x.resource).map((x) => x.email);
  return attendeeImpact({
    kind,
    selfEmail,
    before,
    after: d.change.attendees ?? before,
    notify: d.notifyAttendees,
    organizer: d.before?.organizer?.email ?? null,
    organizerSelf: kind === "create" || !!d.before?.organizerSelf,
    comment: !!d.comment,
  }).checked;
}

/** Attendees `change` adds to an event that had `before` (the account and rooms excluded). */
export function addedAttendees(change: CalendarEventInput, before: string[], selfEmail: string): string[] {
  if (!change.attendees) return [];
  const had = new Set(before.map((x) => x.toLowerCase()));
  return attendeeImpact({ kind: "create", selfEmail, before: [], after: change.attendees, notify: false }).checked.filter((x) => !had.has(x));
}

/** The stored change, when it has everything its kind needs (else applying fails for good). */
function wellFormed(a: GoogleApproval): { kind: CalendarWriteKind; d: CalendarApprovalDetail & { eventId: string } } | null {
  const kind = writeKindOf(a.kind);
  const d = a.calendar;
  if (!kind || !d || typeof d.calendarId !== "string" || !d.calendarId || !d.change || typeof d.eventId !== "string" || !d.eventId) return null;
  if (!Array.isArray(d.notified) || (d.checked !== undefined && !Array.isArray(d.checked))) return null;
  if ((kind === "update" || kind === "delete") && !d.etag) return null;
  if (kind === "rsvp" && !["accepted", "declined", "tentative"].includes(d.response ?? "")) return null;
  return { kind, d: d as CalendarApprovalDetail & { eventId: string } };
}

export function createCalendarApprovals(ctx: AppContext): CalendarApprovals {
  const selfEmail = (a: GoogleApproval) => ctx.accounts.get(a.accountId)?.email ?? a.accountEmail;
  const markAttempt = (id: string) => ctx.db.run("UPDATE approvals SET payload = json_set(payload, '$.calendar.attemptedAt', ?) WHERE id = ?", now(), id);

  /** Applies the change, or finds that an earlier attempt already did. */
  async function apply(a: GoogleApproval, kind: CalendarWriteKind, d: CalendarApprovalDetail & { eventId: string }): Promise<void> {
    const client = ctx.google.calendar(a.accountId);
    const attemptedBefore = !!d.attemptedAt;
    const grant = ctx.policy.grant(a.agentId, a.accountId);
    if (grant?.calendarScope === null && normalizeCalendarId(d.calendarId) !== selfEmail(a).toLowerCase()) {
      const listed = await ctx.calendar.calendars(a.accountId);
      if (!listed.some((c) => normalizeCalendarId(c.id) === normalizeCalendarId(d.calendarId))) {
        throw new Error("The calendar is no longer in the account's calendar list.");
      }
    }
    let current: CalendarEventRaw | null = null;
    if (kind === "update" || kind === "rsvp") {
      current = await client.getEvent(d.calendarId, d.eventId);
      if (current.status === "cancelled") throw new Error(EVENT_GONE);
      if (attemptedBefore && (kind === "rsvp" ? rsvpMatches(d, current) : changeMatches(d.change, current))) return;
      if (kind === "rsvp" && d.comment && grant) commentStillAllowed(grant, current, selfEmail(a));
      if (kind === "update" && current.etag !== d.etag) {
        if (changeMatches(d.change, current)) return;
        throw new Error(attemptedBefore ? MAYBE_APPLIED : EVENT_CHANGED);
      }
    }
    markAttempt(a.id);
    try {
      await applyChange(client, kind, d, current);
    } catch (err) {
      const r = await afterFailure(client, kind, d, err, attemptedBefore);
      if ("error" in r) throw r.error;
    }
  }

  return {
    /**
     * The calendar rules under the agent's current grant (server/mail/approvals.ts checks first that the
     * agent still exists and is enabled): calendar.write, calendar scope, allowTo over everyone the change
     * involves, and replyOnly against new attendees. A malformed change isn't blocked here: applying fails.
     */
    approvalBlockedReason(a) {
      const grant = ctx.policy.grant(a.agentId, a.accountId);
      if (!grant || !grant.capabilities.includes("calendar.write")) return "the agent is no longer allowed to change calendars on this account";
      const ok = wellFormed(a);
      if (!ok) return null;
      const { kind, d } = ok;
      if (!calendarInScope(grant, d.calendarId)) return "the calendar is no longer in the agent's calendar scope";
      const bad = disallowedRecipients(grant, checkedOf(kind, d, selfEmail(a)));
      if (bad.length) return `the agent may no longer involve ${bad.join(", ")}`;
      if (grant.replyOnly && addedAttendees(d.change, (d.before?.attendees ?? []).map((x) => x.email), selfEmail(a)).length) {
        return "the agent may now only reply on this account, not invite people";
      }
      return null;
    },

    /**
     * Applies the stored change. Each attempt is marked on the approval (calendar.attemptedAt) before it is
     * sent. Update re-reads the event first; if its etag moved, the change counts as applied when every field
     * already matches, else it fails ("changed since", or "may already have been applied" after an earlier
     * attempt). Failures go through afterFailure. Under a null calendar scope the calendar must still be in
     * the account's list. Transient errors are rethrown as they are (the approval goes back to pending);
     * anything else becomes a plain message and fails it.
     */
    async applyApproval(a) {
      const ok = wellFormed(a);
      if (!ok) throw new Error("This calendar request is incomplete and can't be applied.");
      const { kind, d } = ok;
      try {
        await apply(a, kind, d);
      } catch (err) {
        throw explain(err);
      }
      try {
        ctx.calendar.kick(a.accountId, d.calendarId);
      } catch (err) {
        ctx.log.debug("Calendar kick failed", { error: err instanceof Error ? err.message : String(err) });
      }
      return { eventId: d.eventId };
    },
  };
}

/** A Google failure that retrying won't fix, in words for the approval card; anything else unchanged. */
function explain(err: unknown): unknown {
  if (err instanceof CalendarApplyError) return new Error(err.message);
  if (!(err instanceof GoogleApiError)) return err;
  const kind = classifyCalendarError(err);
  if (kind === "api_disabled") return new Error("The Google Calendar API is turned off in the Google Cloud project.");
  if (kind === "scope_missing") return new Error("The account no longer grants Google Calendar access.");
  if (err.status === 412) return new Error(EVENT_CHANGED);
  if (err.status === 404 || err.status === 410) return new Error(EVENT_GONE);
  return err;
}
