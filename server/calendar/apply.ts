// Applying calendar changes to Google (docs/calendar.md). AgentCalendar's writes go through applyChange, and
// afterFailure judges a failed attempt from the event as it is now.

import { randomUUID } from "node:crypto";
import type { CalendarEventInput, CalendarResponseStatus } from "../../shared/types.ts";
import type { CalendarAttendeeRaw, CalendarClient, CalendarDateTimeRaw, CalendarEventRaw } from "../google/calendar.ts";
import { hasReason } from "../google/http.ts";
import { AccountNeedsReauthError, GoogleApiError } from "../google/types.ts";
import { selfAttendee } from "./summary.ts";

export type CalendarWriteKind = "create" | "update" | "delete" | "rsvp";

/** One calendar write as sent to Google. */
export interface CalendarChange {
  calendarId: string;
  /** Target event (update/delete/rsvp). For create, the id xaq chose, so a retried create can't make a second event. */
  eventId: string;
  /** create: the new event; update: only the changed fields; delete/rsvp: {}. */
  change: CalendarEventInput;
  /** Google etag of the event when it was read: update and delete send If-Match. */
  etag: string | null;
  /** rsvp only. */
  response: CalendarResponseStatus | null;
  /** rsvp only: the note sent to the organizer with the answer. */
  comment: string | null;
  /** Google emails attendees (sendUpdates "all"); false = "none". */
  notifyAttendees: boolean;
}

/** A write that is known not to have been applied (or can't be, or may have been). `code` is the agent-facing ToolError code. */
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

const rsvpMatches = (d: CalendarChange, e: CalendarEventRaw): boolean => {
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
  d: CalendarChange,
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
 *   "may already have been applied" when the failed attempt may have landed and the event moved on since.
 */
export async function afterFailure(
  client: CalendarClient,
  kind: CalendarWriteKind,
  d: CalendarChange,
  err: unknown,
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
  const mayHaveLanded = ambiguous;
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
