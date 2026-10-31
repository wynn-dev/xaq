// Raw Google event → CalendarEventSummary, shared by sync (A), agent tools (B, C) and approvals.
// Owned by workstream A.

import type { CalendarAttendee, CalendarEventSummary } from "../../shared/types.ts";
import type { CalendarEventRaw, CalendarAttendeeRaw } from "../google/calendar.ts";
import { cleanLine } from "../mail/content.ts";

/** Attendees kept on a summary (attendeeCount has the total). */
export const MAX_SUMMARY_ATTENDEES = 50;

const name = (s: string | undefined) => (s ? cleanLine(s, 100) || null : null);

function attendee(a: CalendarAttendeeRaw): CalendarAttendee | null {
  if (!a.email) return null;
  return {
    email: a.email.toLowerCase(),
    name: name(a.displayName),
    responseStatus: a.responseStatus ?? "needsAction",
    optional: !!a.optional,
    organizer: !!a.organizer,
    self: !!a.self,
    resource: !!a.resource,
  };
}

/** The account's own attendee entry (Google marks it `self` on the copy in the account's calendar). */
export const selfAttendee = (e: CalendarEventRaw): CalendarAttendeeRaw | undefined => e.attendees?.find((a) => a.self);

/** Hosts Google serves event pages (htmlLink) from. */
const GOOGLE_EVENT_HOSTS = ["calendar.google.com", "www.google.com"];

/**
 * An https URL (optionally on one of `hosts`), else null. The organizer controls conferenceData, so a
 * "video link" can be anything: javascript:, http: or a look-alike host for htmlLink are dropped.
 */
function safeUrl(s: string | undefined, hosts?: string[]): string | null {
  if (!s || s.length > 2048) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return !hosts || hosts.includes(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

function conferenceUrl(e: CalendarEventRaw): string | null {
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video" && p.uri);
  return safeUrl(video?.uri) ?? safeUrl(e.hangoutLink);
}

/**
 * Normalizes a raw event. Free text (summary, location, names) is cleaned to single lines (cleanLine, which
 * also escapes the untrusted-content delimiters): invites are an injection vector, and these fields reach
 * agents and listeners as-is. Links are kept only when they are https (safeUrl). The description is never included.
 * Works on the minimal shape of a cancelled event from incremental sync (only `id`, `status`).
 */
export function summarizeEvent(e: CalendarEventRaw, calendarId: string): CalendarEventSummary {
  const all = (e.attendees ?? []).map(attendee).filter((a): a is CalendarAttendee => a !== null);
  const allDay = !!e.start?.date && !e.start?.dateTime;
  return {
    id: e.id,
    calendarId,
    iCalUID: e.iCalUID ?? null,
    recurringEventId: e.recurringEventId ?? null,
    recurring: !!e.recurrence?.length,
    status: e.status ?? "confirmed",
    summary: e.summary ? cleanLine(e.summary, 300) : "",
    location: e.location ? cleanLine(e.location, 300) || null : null,
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    allDay,
    timeZone: e.start?.timeZone ?? null,
    organizer: e.organizer?.email ? { name: name(e.organizer.displayName), email: e.organizer.email.toLowerCase() } : null,
    organizerSelf: !!e.organizer?.self,
    attendees: all.slice(0, MAX_SUMMARY_ATTENDEES),
    attendeeCount: all.length,
    selfResponse: selfAttendee(e)?.responseStatus ?? null,
    conferenceUrl: conferenceUrl(e),
    htmlLink: safeUrl(e.htmlLink, GOOGLE_EVENT_HOSTS),
    eventType: e.eventType ?? "default",
    created: e.created ?? null,
    updated: e.updated ?? null,
  };
}

/**
 * Someone else's event inviting the account and waiting for its answer: the account is an attendee
 * (`self`) with responseStatus needsAction, and doesn't organize it. Drives calendar.invitation_received.
 */
export function isInvitation(e: CalendarEventRaw): boolean {
  if (e.status === "cancelled" || e.organizer?.self) return false;
  return selfAttendee(e)?.responseStatus === "needsAction";
}
