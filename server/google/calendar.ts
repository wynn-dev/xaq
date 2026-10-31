// Google Calendar REST client contract (https://developers.google.com/workspace/calendar/api/v3/reference).
// Owned by workstream A. Mirrors server/google/gmail.ts: one client per account, built
// on GoogleRuntime.request (token refresh, 401 retry, backoff, AccountNeedsReauthError), base URL
// ctx.config.google.calendarBase + "/calendar/v3".

import type { CalendarAccessRole, CalendarResponseStatus } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { hasReason, isOutcomeUnknown } from "./http.ts";
import { googleRuntime, type RequestOptions } from "./runtime.ts";
import { GoogleApiError } from "./types.ts";

export const CALENDAR_API_SERVICE = "calendar-json.googleapis.com";

/** Console deep link that enables the Calendar API in `projectId` (Google picks the project when null). */
export const enableCalendarApiUrl = (projectId: string | null): string =>
  `https://console.cloud.google.com/flows/enableapi?apiid=${CALENDAR_API_SERVICE}${projectId ? `&project=${encodeURIComponent(projectId)}` : ""}`;

export const enableCalendarApiCommand = (projectId: string): string => `gcloud services enable ${CALENDAR_API_SERVICE} --project=${projectId}`;

// ───────────── Raw Calendar REST shapes (subset) ─────────────

export interface CalendarListEntryRaw {
  id: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  timeZone?: string;
  accessRole: CalendarAccessRole;
  primary?: boolean;
  backgroundColor?: string;
  selected?: boolean;
  hidden?: boolean;
  deleted?: boolean;
}

export interface CalendarDateTimeRaw {
  /** RFC 3339, for timed events. */
  dateTime?: string;
  /** YYYY-MM-DD, for all-day events. */
  date?: string;
  timeZone?: string;
}

export interface CalendarAttendeeRaw {
  email?: string;
  displayName?: string;
  responseStatus?: CalendarResponseStatus;
  optional?: boolean;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  comment?: string;
}

export interface CalendarEventRaw {
  id: string;
  /** Incremental sync: deleted events come back with status "cancelled" and maybe only `id`. */
  status?: "confirmed" | "tentative" | "cancelled";
  etag?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarDateTimeRaw;
  end?: CalendarDateTimeRaw;
  endTimeUnspecified?: boolean;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: CalendarDateTimeRaw;
  iCalUID?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string; displayName?: string; self?: boolean };
  attendees?: CalendarAttendeeRaw[];
  attendeesOmitted?: boolean;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[]; createRequest?: unknown };
  eventType?: string;
  transparency?: "opaque" | "transparent";
  visibility?: string;
  guestsCanModify?: boolean;
  /** false: attendees (and the account, when it doesn't organize) can't see the guest list. */
  guestsCanSeeOtherGuests?: boolean;
}

export interface EventsListParams {
  /** Incremental sync: mutually exclusive with timeMin, timeMax, q, orderBy, iCalUID, updatedMin (400 otherwise). */
  syncToken?: string;
  pageToken?: string;
  timeMin?: string;
  timeMax?: string;
  q?: string;
  /** Expand recurring series into instances (needs timeMin/timeMax to stay bounded). */
  singleEvents?: boolean;
  orderBy?: "startTime" | "updated";
  showDeleted?: boolean;
  maxResults?: number;
  iCalUID?: string;
}

export interface EventsListResult {
  items: CalendarEventRaw[];
  nextPageToken: string | null;
  /** Only on the last page. */
  nextSyncToken: string | null;
  timeZone: string | null;
}

/** Google's sendUpdates: who gets an email about a write. */
export type SendUpdates = "all" | "externalOnly" | "none";

export interface WriteOptions {
  sendUpdates: SendUpdates;
  /** Create a Meet link (conferenceDataVersion=1 with a createRequest). */
  conferenceDataVersion?: 0 | 1;
  /** Fail with 412 when the event changed since this etag (If-Match), e.g. for approved updates. */
  ifMatchEtag?: string;
}

export interface FreeBusyResult {
  calendars: Record<string, { busy: { start: string; end: string }[]; errors?: { domain: string; reason: string }[] }>;
}

/**
 * Thin Calendar REST client bound to one account. Throws GoogleApiError (see classifyCalendarError for the
 * disabled-API and missing-scope cases) or AccountNeedsReauthError, like GmailClient. Calendar calls don't
 * use the Gmail quota bucket (cost 0); Google's Calendar quotas are per minute per user and per project.
 * Inserts are retried only when Google provably didn't act, unless the event carries a client-chosen id (a
 * repeat then gets 409, classified "duplicate"). Patch and delete are retried; when a retry fails its If-Match
 * after an attempt that may have been applied, the error says the change may already have happened.
 */
export interface CalendarClient {
  readonly accountId: string;
  /** calendarList.list, every page, deleted entries skipped. Hidden calendars are kept (`hidden: true`): callers filter. */
  listCalendars(): Promise<CalendarListEntryRaw[]>;
  /** events.list. A stale syncToken throws GoogleApiError 410 (isSyncTokenExpired): full resync. */
  listEvents(calendarId: string, p: EventsListParams): Promise<EventsListResult>;
  /** events.get. 404 → GoogleApiError.notFound. */
  getEvent(calendarId: string, eventId: string): Promise<CalendarEventRaw>;
  insertEvent(calendarId: string, event: Partial<CalendarEventRaw>, opts: WriteOptions): Promise<CalendarEventRaw>;
  /** events.patch: only the given fields change. */
  patchEvent(calendarId: string, eventId: string, patch: Partial<CalendarEventRaw>, opts: WriteOptions): Promise<CalendarEventRaw>;
  deleteEvent(calendarId: string, eventId: string, opts: WriteOptions): Promise<void>;
  /** freebusy.query. `items` are calendar ids or email addresses. */
  freeBusy(p: { timeMin: string; timeMax: string; items: string[]; timeZone?: string }): Promise<FreeBusyResult>;
}

/** Pages of calendarList / events.list fetched per request (Google's maximums are 250 and 2500). */
const LIST_PAGE = 250;

const writeQuery = (o: WriteOptions) => ({ sendUpdates: o.sendUpdates, conferenceDataVersion: o.conferenceDataVersion });
const ifMatch = (o: WriteOptions) => (o.ifMatchEtag ? { "if-match": o.ifMatchEtag } : undefined);
const MAY_HAVE_CHANGED = "The change may already have been applied: check the event in Google Calendar before retrying.";

/** ctx.google.calendar(accountId). Calendar calls aren't throttled by the Gmail quota bucket (cost 0). */
export function createCalendarClient(ctx: AppContext, accountId: string): CalendarClient {
  const rt = googleRuntime(ctx);
  const call = <T>(path: string, opts: Omit<RequestOptions, "cost"> = {}) =>
    rt.request<T>(accountId, ctx.config.google.calendarBase, `/calendar/v3${path}`, opts);
  const id = encodeURIComponent;
  const events = (calendarId: string) => `/calendars/${id(calendarId)}/events`;

  return {
    accountId,
    async listCalendars() {
      const out: CalendarListEntryRaw[] = [];
      let pageToken: string | undefined;
      do {
        const r = await call<{ items?: CalendarListEntryRaw[]; nextPageToken?: string }>("/users/me/calendarList", {
          query: { maxResults: LIST_PAGE, pageToken },
        });
        out.push(...(r?.items ?? []).filter((c) => !c.deleted));
        pageToken = r?.nextPageToken;
      } while (pageToken);
      return out;
    },
    async listEvents(calendarId, p) {
      const r = await call<{ items?: CalendarEventRaw[]; nextPageToken?: string; nextSyncToken?: string; timeZone?: string }>(events(calendarId), {
        query: {
          syncToken: p.syncToken,
          pageToken: p.pageToken,
          timeMin: p.timeMin,
          timeMax: p.timeMax,
          q: p.q || undefined,
          singleEvents: p.singleEvents,
          orderBy: p.orderBy,
          showDeleted: p.showDeleted,
          maxResults: p.maxResults,
          iCalUID: p.iCalUID,
        },
      });
      return { items: r?.items ?? [], nextPageToken: r?.nextPageToken ?? null, nextSyncToken: r?.nextSyncToken ?? null, timeZone: r?.timeZone ?? null };
    },
    getEvent: (calendarId, eventId) => call<CalendarEventRaw>(`${events(calendarId)}/${id(eventId)}`),
    insertEvent: (calendarId, event, opts) =>
      call<CalendarEventRaw>(events(calendarId), {
        method: "POST",
        query: writeQuery(opts),
        body: event,
        // With an id of our choosing a repeat can't create a second event (Google answers 409).
        idempotent: !!event.id,
        ambiguousHint: "The event may have been created: check Google Calendar before retrying.",
      }),
    patchEvent: (calendarId, eventId, patch, opts) =>
      call<CalendarEventRaw>(`${events(calendarId)}/${id(eventId)}`, {
        method: "PATCH",
        query: writeQuery(opts),
        body: patch,
        headers: ifMatch(opts),
        ambiguousHint: MAY_HAVE_CHANGED,
      }),
    async deleteEvent(calendarId, eventId, opts) {
      try {
        await call<void>(`${events(calendarId)}/${id(eventId)}`, { method: "DELETE", query: writeQuery(opts), headers: ifMatch(opts), ambiguousHint: MAY_HAVE_CHANGED });
      } catch (err) {
        // 410 "Resource has been deleted": already gone (e.g. a retry after Google acted on the first attempt).
        if (!(err instanceof GoogleApiError && err.status === 410)) throw err;
      }
    },
    async freeBusy(p) {
      const r = await call<FreeBusyResult>("/freeBusy", {
        method: "POST",
        body: { timeMin: p.timeMin, timeMax: p.timeMax, timeZone: p.timeZone, items: p.items.map((i) => ({ id: i })) },
      });
      return { calendars: r?.calendars ?? {} };
    },
  };
}

// ───────────── Errors ─────────────

/**
 * What a Calendar API failure means for setup:
 * - api_disabled: 403 SERVICE_DISABLED / accessNotConfigured: the Calendar API is off in the Cloud project
 *   (ErrorInfo metadata.activationUrl, when present, is the enable link).
 * - scope_missing: 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT / insufficientPermissions: the account hasn't granted
 *   the calendar scopes (or unticked them).
 * - sync_token_expired: 410 (fullSyncRequired): discard the sync token and do a full resync.
 * - duplicate: 409 on insert: an event with that (client-chosen) id already exists, e.g. a retried insert landed.
 * - outcome_unknown: a write that Google may or may not have applied (an insert after a 5xx or timeout, or a
 *   retried If-Match patch/delete whose precondition failed after such an attempt). Re-read the event and
 *   compare before retrying; never report it as a conflict. Checked first (the status is the first attempt's).
 * - other: anything else (retry, report).
 */
export type CalendarErrorKind = "api_disabled" | "scope_missing" | "sync_token_expired" | "duplicate" | "outcome_unknown" | "other";

export function classifyCalendarError(err: unknown): CalendarErrorKind {
  if (!(err instanceof GoogleApiError)) return "other";
  if (isOutcomeUnknown(err)) return "outcome_unknown";
  if (err.status === 410) return "sync_token_expired";
  if (err.status === 409) return "duplicate";
  if (err.status !== 403) return "other";
  if (hasReason(err, "SERVICE_DISABLED", "accessNotConfigured")) return "api_disabled";
  if (hasReason(err, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions")) return "scope_missing";
  // Older error bodies only say it in words.
  if (/has not been used in project|it is disabled/i.test(err.message)) return "api_disabled";
  if (/insufficient authentication scopes|insufficient permission/i.test(err.message)) return "scope_missing";
  return "other";
}

/** The enable link Google put in a SERVICE_DISABLED error, if any. */
export const activationUrl = (err: GoogleApiError): string | null => err.details.metadata?.activationUrl ?? null;
