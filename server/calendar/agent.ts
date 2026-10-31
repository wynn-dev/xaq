// Agent-facing calendar actions (workstream B). Like AgentMail: each
// method resolves the agent's grant, enforces capabilities, calendar scope, write mode, attendee allowTo
// and send caps, and returns structured data that server/mcp/calendar.ts (C) formats. Denials throw
// PolicyDenied (audited as "denied" with the reason); fixable input problems throw ToolError.

import type {
  Account,
  CalendarApprovalDetail,
  CalendarCapability,
  CalendarEventInput,
  CalendarEventSummary,
  CalendarInfo,
  CalendarResponseStatus,
  Grant,
  MessageContent,
} from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { type CalendarClient, type CalendarEventRaw, classifyCalendarError } from "../google/calendar.ts";
import { GoogleApiError } from "../google/types.ts";
import { Approvals, type ApprovalPayload } from "../mail/approvals.ts";
import { AgentMail, MAX_RECIPIENTS, ToolError, type ToolTrace } from "../mail/agent.ts";
import { cleanLine } from "../mail/content.ts";
import {
  assertAttendeesAllowed,
  assertNoNewAttendees,
  attendeeImpact,
  calendarNotAccessible,
  newCalendarEventId,
  normalizeCalendarId,
  resolveCalendarId,
} from "../policy/calendar.ts";
import { reserveSend } from "../policy/enforce.ts";
import type { AgentPrincipal } from "../policy/types.ts";
import { HttpError, PolicyDenied } from "../util/errors.ts";
import { addedAttendees, afterFailure, applyChange, CalendarApplyError, type CalendarWriteKind, isAmbiguous } from "./approvals.ts";
import { cleanEventDescription } from "./content.ts";
import { selfAttendee, summarizeEvent } from "./summary.ts";

export interface CalendarAccess {
  grant: Grant;
  account: Account;
  calendar: CalendarClient;
}

/** Options every write takes. */
export interface WriteArgs {
  /** sendUpdates "all" (true, default) or "none". RSVP: whether the organizer is told. */
  notifyAttendees?: boolean;
  /** Shown to the human when the write needs approval. */
  reason?: string;
}

export type CalendarWriteOutcome =
  | { status: "applied"; event: CalendarEventSummary; notified: string[] }
  | { status: "deleted"; calendarId: string; eventId: string; notified: string[] }
  | { status: "pending_approval"; approvalId: string; expiresAt: string; message: string };

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/i;
const RECURRENCE = /^(RRULE|EXRULE|RDATE|EXDATE)[:;][^\r\n]{1,500}$/i;
const MAX_RESULTS = 250;
const MAX_FREEBUSY = 50;

const CAP_HINT = "Try again later, or ask your user to make this change in Google Calendar.";

const eventNotAccessible = (eventId: string) =>
  `Event ${eventId} was not found or is not accessible to you. Use list_calendar_events to find events you can access.`;

/**
 * Ids end up in Google URL paths: letters, digits and "_.@-" only (calendar ids also "#", as in Google's
 * holiday calendars "en.usa#holiday@group.v.calendar.google.com", and "+", as in "alice+work@example.com"),
 * and never a bare "." or "..".
 */
function checkId(what: "Calendar" | "Event", id: string): string {
  const s = id.trim();
  const allowed = what === "Calendar" ? /^[A-Za-z0-9_.@#+-]+$/ : /^[A-Za-z0-9_.@-]+$/;
  if (s.length > 1024 || !allowed.test(s) || /^\.+$/.test(s)) throw new ToolError("invalid_arguments", `${what} "${cleanLine(s, 80)}" is not a valid id.`);
  return s;
}

/** Google's rules for event ids a client chooses: base32hex (a-v, 0-9), 5 to 1024 characters. */
const CLIENT_EVENT_ID = /^[a-v0-9]{5,1024}$/;

function checkTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    throw new ToolError("invalid_arguments", `Unknown time zone "${cleanLine(tz, 60)}". Use an IANA name such as "Europe/Berlin".`);
  }
}

/** A list/free-busy window: RFC 3339 timestamps with an offset (Google requires one), min before max. */
function timeRange(timeMin: string, timeMax: string): { timeMin: string; timeMax: string } {
  for (const t of [timeMin, timeMax]) {
    if (!DATE_TIME.exec(t)?.[1] || Number.isNaN(Date.parse(t))) {
      throw new ToolError("invalid_arguments", `"${cleanLine(t, 60)}" is not a timestamp with a time zone offset, e.g. 2026-10-20T09:00:00Z or 2026-10-20T09:00:00+02:00.`);
    }
  }
  if (Date.parse(timeMin) >= Date.parse(timeMax)) throw new ToolError("invalid_arguments", "time_min must be before time_max.");
  return { timeMin, timeMax };
}

/**
 * Validates what the agent wants to write and normalizes it (attendees lower-cased and deduplicated, all_day
 * derived from the time format). Create needs summary, start and end; update needs start and end together.
 */
export function validateEventInput(input: CalendarEventInput, kind: "create" | "update"): CalendarEventInput {
  const out: CalendarEventInput = {};
  const bad = (msg: string) => new ToolError("invalid_arguments", msg);
  if (input.summary !== undefined) {
    if (input.summary.length > 1024) throw bad("summary is too long (max 1024 characters).");
    out.summary = input.summary.trim();
  }
  if (kind === "create" && !out.summary) throw bad("Give the event a summary (its title).");
  if (input.description !== undefined) {
    if (input.description.length > 20_000) throw bad("description is too long (max 20000 characters).");
    out.description = input.description;
  }
  if (input.location !== undefined) {
    if (input.location.length > 1000) throw bad("location is too long (max 1000 characters).");
    out.location = input.location.trim();
  }
  if (input.timeZone !== undefined) out.timeZone = checkTimeZone(input.timeZone.trim());
  if (out.timeZone && input.start === undefined) throw bad("time_zone applies to start and end: pass them with it.");
  if ((input.start === undefined) !== (input.end === undefined)) throw bad("Pass start and end together.");
  if (input.start !== undefined && input.end !== undefined) {
    const start = input.start.trim();
    const end = input.end.trim();
    const allDay = DATE.test(start);
    if (allDay !== DATE.test(end)) throw bad("start and end must both be dates (all-day) or both date-times.");
    if (input.allDay !== undefined && input.allDay !== allDay) {
      throw bad(input.allDay ? "All-day events take dates like 2026-10-20 (end is exclusive: the day after)." : "Timed events take date-times like 2026-10-20T09:00:00+02:00.");
    }
    if (!allDay) {
      const s = DATE_TIME.exec(start);
      const e = DATE_TIME.exec(end);
      if (!s || !e || Number.isNaN(Date.parse(s[1] ? start : `${start}Z`)) || Number.isNaN(Date.parse(e[1] ? end : `${end}Z`))) {
        throw bad("start and end must be date-times like 2026-10-20T09:00:00+02:00, or dates like 2026-10-20 for all-day events.");
      }
      if ((!s[1] || !e[1]) && !out.timeZone) throw bad("Date-times without an offset need time_zone (e.g. \"Europe/Berlin\").");
      // Without offsets both are wall-clock times in the same zone, so the strings compare like the times
      // (with one offset only, Google judges).
      const ordered = s[1] && e[1] ? Date.parse(start) < Date.parse(end) : !s[1] && !e[1] ? start < end : true;
      if (!ordered) throw bad("end must be after start.");
    } else {
      if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) throw bad("start and end must be real dates.");
      if (end <= start) throw bad("end must be after start (for all-day events, end is the day after the last day).");
    }
    out.start = start;
    out.end = end;
    out.allDay = allDay;
  } else if (input.allDay !== undefined) {
    throw bad("Pass start and end with all_day.");
  } else if (kind === "create") {
    throw bad("Pass start and end.");
  }
  if (input.attendees !== undefined) {
    const emails = [...new Set(input.attendees.map((x) => x.trim().toLowerCase()).filter(Boolean))];
    const invalid = emails.filter((x) => !EMAIL.test(x));
    if (invalid.length) throw bad(`Not email addresses: ${invalid.map((x) => cleanLine(x, 80)).join(", ")}. Attendees are plain addresses like alice@example.com.`);
    if (emails.length > MAX_RECIPIENTS) throw bad(`At most ${MAX_RECIPIENTS} attendees.`);
    out.attendees = emails;
  }
  if (input.recurrence !== undefined) {
    if (input.recurrence.length > 10 || !input.recurrence.every((r) => RECURRENCE.test(r.trim()))) {
      throw bad('recurrence takes up to 10 RRULE/EXDATE/RDATE lines, e.g. ["RRULE:FREQ=WEEKLY;COUNT=4"].');
    }
    out.recurrence = input.recurrence.map((r) => r.trim());
  }
  if (input.addConference) out.addConference = true;
  if (kind === "update" && !Object.keys(out).length) throw bad("Nothing to change: pass at least one field.");
  return out;
}

export class AgentCalendar {
  /** Per call: the account's calendar list (null calendar scopes are checked against it). */
  private readonly lists = new Map<string, Promise<CalendarInfo[]>>();

  constructor(
    protected readonly ctx: AppContext,
    readonly principal: AgentPrincipal,
    readonly trace: ToolTrace = { detail: {} },
  ) {}

  /** Grants with any calendar capability, joined with their accounts. */
  accessible(): { grant: Grant; account: Account }[] {
    return new AgentMail(this.ctx, this.principal, this.trace)
      .accessible()
      .filter((x) => x.grant.capabilities.includes("calendar.read") || x.grant.capabilities.includes("calendar.write"));
  }

  /**
   * Picks the account (email or id; optional when exactly one qualifies) and checks `cap`. Sets
   * trace.accountId. ToolError calendar_not_granted / needs_reauth when the account can't serve calendar calls.
   */
  resolve(account: string | undefined, cap: CalendarCapability): CalendarAccess {
    let found;
    try {
      found = new AgentMail(this.ctx, this.principal, this.trace).resolve(account, cap);
    } catch (err) {
      const email = this.trace.accountId ? this.ctx.accounts.get(this.trace.accountId)?.email : null;
      if (err instanceof ToolError && err.code === "needs_reauth" && email) {
        throw new ToolError("needs_reauth", `The Google account ${email} needs to be reconnected. Ask the operator to reconnect it in the xaq console.`);
      }
      throw err;
    }
    const { grant, account: acc } = found;
    if (!acc.calendar || acc.calendar.status === "not_granted") throw notGranted(acc.email);
    return { grant, account: acc, calendar: this.ctx.google.calendar(acc.id) };
  }

  /**
   * Writes to an existing event read it first and their answers and denials describe it, so they need
   * calendar.read as well as calendar.write.
   */
  private resolveExisting(account: string | undefined): CalendarAccess {
    const a = this.resolve(account, "calendar.write");
    if (!a.grant.capabilities.includes("calendar.read")) {
      throw new PolicyDenied(
        "capability",
        `Your access to ${a.account.email} lets you create events but not read them, and changing an existing event needs both. Ask the operator to add calendar.read.`,
      );
    }
    return a;
  }

  /** Like resolve, accepting any of several capabilities. */
  private resolveAny(account: string | undefined, caps: CalendarCapability[]): CalendarAccess {
    let lastErr: unknown;
    for (const cap of caps) {
      try {
        return this.resolve(account, cap);
      } catch (err) {
        if (!(err instanceof PolicyDenied)) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** The account's calendar list (ctx.calendar.calendars), once per call. */
  private listed(a: CalendarAccess): Promise<CalendarInfo[]> {
    let p = this.lists.get(a.account.id);
    if (!p) {
      p = this.ctx.calendar.calendars(a.account.id).catch((err: unknown) => {
        // 409 calendar_not_granted / calendar_api_disabled / needs_reauth: the agent can't fix these.
        // The hint is for the operator (console paths, gcloud commands), not the agent.
        throw err instanceof HttpError ? new ToolError(err.code, err.message) : err;
      });
      this.lists.set(a.account.id, p);
    }
    return p;
  }

  /**
   * The calendar id to act on. Omitted means the account's primary calendar when it is in scope, else the
   * only calendar in scope, else ToolError calendar_required. "primary" is the primary calendar. Out of
   * scope → PolicyDenied calendar_scope (the message never reveals whether it exists). A null scope covers
   * the calendars in the account's list, nothing else.
   */
  async calendarFor(a: CalendarAccess, calendarId: string | undefined): Promise<string> {
    const primary = a.account.email.toLowerCase();
    const scope = a.grant.calendarScope;
    let id: string;
    if (calendarId?.trim()) {
      id = resolveCalendarId(checkId("Calendar", calendarId), a.account.email);
    } else if (scope === null || scope.includes(primary)) {
      id = primary;
    } else if (scope.length === 1) {
      id = scope[0]!;
    } else {
      throw new ToolError("calendar_required", `Pass calendar_id; you can use these calendars: ${scope.join(", ")}.`);
    }
    const shown = calendarId?.trim() || id;
    if (scope !== null) {
      if (!scope.includes(id)) throw new PolicyDenied("calendar_scope", calendarNotAccessible(shown));
    } else if (id !== primary && !(await this.listed(a)).some((c) => normalizeCalendarId(c.id) === id)) {
      throw new PolicyDenied("calendar_scope", calendarNotAccessible(shown));
    }
    return id;
  }

  /**
   * Runs a Calendar call; errors the agent can understand become ToolErrors: the API being off, missing
   * calendar scopes, a missing item (as `missing`), an event changed since it was read. Others pass through.
   */
  private async google<T>(a: CalendarAccess, fn: () => Promise<T>, missing?: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw translate(a, err, missing);
    }
  }

  private async fetchEvent(a: CalendarAccess, calendarId: string, eventId: string): Promise<CalendarEventRaw> {
    return this.google(a, () => a.calendar.getEvent(calendarId, eventId), eventNotAccessible(eventId));
  }

  // ───────────── Read ─────────────

  /** Calendars in the grant's scope. */
  async listCalendars(account: string | undefined): Promise<{ account: Account; calendars: CalendarInfo[] }> {
    const a = this.resolveAny(account, ["calendar.read", "calendar.write"]);
    const scope = a.grant.calendarScope;
    const calendars = (await this.listed(a)).filter((c) => scope === null || scope.includes(normalizeCalendarId(c.id)));
    this.trace.detail = { results: calendars.length, scoped: scope !== null };
    return { account: a.account, calendars };
  }

  /** Events overlapping [timeMin, timeMax) (singleEvents, ordered by start), optional free-text query. */
  async listEvents(
    account: string | undefined,
    p: { calendarId?: string; timeMin: string; timeMax: string; query?: string; maxResults?: number; pageToken?: string },
  ): Promise<{ account: Account; calendarId: string; events: CalendarEventSummary[]; nextPageToken: string | null; timeZone: string | null }> {
    const a = this.resolve(account, "calendar.read");
    const range = timeRange(p.timeMin, p.timeMax);
    if (p.query && p.query.length > 500) throw new ToolError("invalid_query", "query is too long (max 500 characters).");
    const calendarId = await this.calendarFor(a, p.calendarId);
    this.trace.target = calendarId;
    this.trace.detail = { calendarId, ...(p.query ? { queryLength: p.query.length } : {}) };
    const res = await this.google(
      a,
      () =>
        a.calendar.listEvents(calendarId, {
          ...range,
          q: p.query?.trim() || undefined,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: Math.min(Math.max(p.maxResults ?? 25, 1), MAX_RESULTS),
          pageToken: p.pageToken || undefined,
        }),
      calendarNotAccessible(p.calendarId?.trim() || calendarId),
    );
    const events = res.items.filter((e) => e.status !== "cancelled").map((e) => summarizeEvent(e, calendarId));
    this.trace.detail.results = events.length;
    return { account: a.account, calendarId, events, nextPageToken: res.nextPageToken, timeZone: res.timeZone };
  }

  /** One event plus its cleaned description (server/calendar/content.ts). */
  async getEvent(
    account: string | undefined,
    calendarId: string | undefined,
    eventId: string,
  ): Promise<{ account: Account; event: CalendarEventSummary; content: MessageContent | null }> {
    const a = this.resolve(account, "calendar.read");
    const id = checkId("Event", eventId);
    const cal = await this.calendarFor(a, calendarId);
    this.trace.target = id;
    this.trace.detail = { calendarId: cal };
    const raw = await this.fetchEvent(a, cal, id);
    const content = await cleanEventDescription(this.ctx, raw, { accountEmail: a.account.email, maxChars: this.ctx.settings.get().maxBodyChars });
    return { account: a.account, event: summarizeEvent(raw, cal), content };
  }

  /**
   * Busy intervals. `calendars` default to the in-scope calendars (the primary calendar under a null scope);
   * with a null calendar scope any calendar id or address may be asked (Google decides what the user can
   * see), otherwise only in-scope ids.
   */
  async freeBusy(
    account: string | undefined,
    p: { timeMin: string; timeMax: string; calendars?: string[] },
  ): Promise<{ account: Account; calendars: { id: string; busy: { start: string; end: string }[]; error: string | null }[] }> {
    const a = this.resolve(account, "calendar.read");
    const range = timeRange(p.timeMin, p.timeMax);
    const scope = a.grant.calendarScope;
    let items: string[];
    if (!p.calendars?.length) {
      items = scope === null ? [a.account.email.toLowerCase()] : [...scope];
    } else {
      if (p.calendars.length > MAX_FREEBUSY) throw new ToolError("invalid_arguments", `At most ${MAX_FREEBUSY} calendars per query.`);
      items = p.calendars.map((c) => {
        const id = resolveCalendarId(checkId("Calendar", c), a.account.email);
        if (scope !== null && !scope.includes(id)) throw new PolicyDenied("calendar_scope", calendarNotAccessible(c.trim()));
        return id;
      });
    }
    items = [...new Set(items)];
    this.trace.detail = { calendars: items.length, scoped: scope !== null };
    const res = await this.google(a, () => a.calendar.freeBusy({ ...range, items }));
    const byLower = new Map(Object.entries(res.calendars).map(([k, v]) => [normalizeCalendarId(k), v]));
    return {
      account: a.account,
      calendars: items.map((id) => {
        const c = res.calendars[id] ?? byLower.get(id);
        return { id, busy: c?.busy ?? [], error: c ? (c.errors?.[0]?.reason ?? null) : "notFound" };
      }),
    };
  }

  // ───────────── Write ─────────────

  /**
   * `opts.eventId`: the id from an earlier attempt (write_uncertain names it). Retrying with it can't create a
   * second event: if Google has it with the same content, the earlier attempt counts as applied.
   */
  async createEvent(
    account: string | undefined,
    calendarId: string | undefined,
    input: CalendarEventInput,
    opts: WriteArgs & { eventId?: string },
  ): Promise<CalendarWriteOutcome> {
    const a = this.resolve(account, "calendar.write");
    const change = validateEventInput(input, "create");
    const eventId = opts.eventId?.trim();
    if (eventId !== undefined && !CLIENT_EVENT_ID.test(eventId)) {
      throw new ToolError("invalid_arguments", "event_id must be the id from an earlier create_calendar_event attempt (5-1024 characters a-v and 0-9).");
    }
    const cal = await this.calendarFor(a, calendarId);
    return this.write(a, "create", cal, eventId || newCalendarEventId(), null, { change }, opts);
  }

  /** `change` holds only the fields to change; attendees, when given, is the full new list. */
  async updateEvent(
    account: string | undefined,
    calendarId: string | undefined,
    eventId: string,
    change: CalendarEventInput,
    opts: WriteArgs,
  ): Promise<CalendarWriteOutcome> {
    const a = this.resolveExisting(account);
    const id = checkId("Event", eventId);
    const valid = validateEventInput(change, "update");
    const cal = await this.calendarFor(a, calendarId);
    const raw = await this.existing(a, cal, id);
    return this.write(a, "update", cal, id, raw, { change: valid }, opts);
  }

  async deleteEvent(account: string | undefined, calendarId: string | undefined, eventId: string, opts: WriteArgs): Promise<CalendarWriteOutcome> {
    const a = this.resolveExisting(account);
    const id = checkId("Event", eventId);
    const cal = await this.calendarFor(a, calendarId);
    const raw = await this.existing(a, cal, id);
    return this.write(a, "delete", cal, id, raw, { change: {} }, opts);
  }

  /**
   * RSVP on an event the account is invited to (not its own). A bare answer isn't checked against allowTo
   * (the organizer invited the account); with a comment the organizer and every attendee must pass it, since
   * Google shows the comment to all of them.
   */
  async respond(
    account: string | undefined,
    calendarId: string | undefined,
    eventId: string,
    response: Exclude<CalendarResponseStatus, "needsAction">,
    opts: WriteArgs & { comment?: string },
  ): Promise<CalendarWriteOutcome> {
    const a = this.resolveExisting(account);
    const id = checkId("Event", eventId);
    if (!["accepted", "declined", "tentative"].includes(response)) throw new ToolError("invalid_arguments", "response must be accepted, declined or tentative.");
    const comment = opts.comment?.trim() || null;
    if (comment && comment.length > 1000) throw new ToolError("invalid_arguments", "comment is too long (max 1000 characters).");
    const cal = await this.calendarFor(a, calendarId);
    const raw = await this.existing(a, cal, id);
    if (raw.organizer?.self || !selfAttendee(raw)) {
      throw new ToolError("not_invited", `Event ${id} isn't an invitation to ${a.account.email}; you can only answer events someone else invited it to.`);
    }
    return this.write(a, "rsvp", cal, id, raw, { change: {}, response, comment }, opts);
  }

  /** The event a write targets; cancelled events count as gone. */
  private async existing(a: CalendarAccess, calendarId: string, eventId: string): Promise<CalendarEventRaw> {
    const raw = await this.fetchEvent(a, calendarId, eventId);
    if (raw.status === "cancelled") throw new ToolError("not_found", `Event ${eventId} was cancelled or deleted.`);
    return raw;
  }

  /**
   * The shared write path: who the change involves (attendeeImpact), replyOnly against new attendees,
   * allowTo over everyone involved, a send-cap slot when Google will email anyone or the event lands on new
   * attendees' calendars, then the grant's write mode. Audit detail: {calendarId, eventId, mode, emailed,
   * notified, invited}.
   */
  private async write(
    a: CalendarAccess,
    kind: CalendarWriteKind,
    calendarId: string,
    eventId: string,
    raw: CalendarEventRaw | null,
    w: { change: CalendarEventInput; response?: CalendarResponseStatus; comment?: string | null },
    opts: WriteArgs,
  ): Promise<CalendarWriteOutcome> {
    const notify = opts.notifyAttendees !== false;
    const others = (raw?.attendees ?? []).filter((x) => x.email && !x.self && !x.resource).map((x) => x.email!);
    const impact = attendeeImpact({
      kind,
      selfEmail: a.account.email,
      before: others,
      after: w.change.attendees ?? others,
      notify,
      organizer: raw?.organizer?.email ?? null,
      organizerSelf: kind === "create" || !!raw?.organizer?.self,
      comment: !!w.comment,
    });
    const before = raw ? summarizeEvent(raw, calendarId) : null;
    const added = addedAttendees(w.change, others, a.account.email);
    // Even without an email, a create or an added attendee puts the event on their calendar: it counts too.
    const counts = impact.emailed.length > 0 || added.length > 0;
    this.trace.target = eventId;
    this.trace.detail = {
      calendarId,
      eventId,
      mode: a.grant.calendarWriteMode,
      emailed: impact.emailed.length > 0,
      notified: impact.emailed.length,
      invited: added.length,
    };
    // Who would see the change can't be checked when Google hides the guest list from the account.
    const hidden = raw && !raw.organizer?.self && (raw.guestsCanSeeOtherGuests === false || raw.attendeesOmitted);
    if (hidden && a.grant.allowTo.length && (kind === "update" || (kind === "rsvp" && w.comment))) {
      throw new PolicyDenied(
        "allow_to",
        `The organizer hides this event's guest list, so xaq can't check who would see your ${kind === "rsvp" ? "comment" : "change"} against this account's allowlist. ` +
          (kind === "rsvp" ? "Answer without a comment, or ask your user." : "Ask your user to change it in Google Calendar."),
      );
    }
    assertNoNewAttendees(a.grant, added);
    assertAttendeesAllowed(a.grant, impact.checked);
    // Synchronous check-and-reserve, shared with mail sends: no await between the cap check and taking the slot.
    if (counts) this.trace.release = reserveSend(this.ctx.db, a.grant, Date.now(), CAP_HINT);

    const detail: CalendarApprovalDetail & { eventId: string } = {
      calendarId,
      calendarName: null,
      eventId,
      change: w.change,
      before,
      etag: raw?.etag ?? null,
      response: w.response ?? null,
      comment: w.comment ?? null,
      notifyAttendees: notify,
      notified: impact.emailed,
      checked: impact.checked,
    };

    if (a.grant.calendarWriteMode === "direct") {
      const after = await this.apply(a, kind, detail, raw, counts);
      try {
        this.ctx.calendar.kick(a.account.id, calendarId);
      } catch {
        // kick never throws; tolerate placeholders.
      }
      if (kind === "delete" || !after) return { status: "deleted", calendarId, eventId, notified: impact.emailed };
      // Without calendar.read the result says only what the agent sent (a retried event_id may have matched
      // an event with more in it).
      const shown = kind === "create" && !a.grant.capabilities.includes("calendar.read") ? ownView(eventId, w.change) : after;
      return { status: "applied", event: summarizeEvent(shown, calendarId), notified: impact.emailed };
    }

    detail.calendarName = (await this.listed(a).catch(() => [])).find((c) => normalizeCalendarId(c.id) === calendarId)?.name ?? null;
    const payload: ApprovalPayload = {
      to: impact.emailed.map((email) => ({ name: null, email })),
      cc: [],
      bcc: [],
      subject: w.change.summary ?? before?.summary ?? "",
      body: kind === "rsvp" ? (w.comment ?? "") : (w.change.description ?? ""),
      threadId: null,
      attachments: [],
      reason: opts.reason?.trim() || null,
      calendar: detail,
    };
    const approval = new Approvals(this.ctx).create({
      agentId: this.principal.agentId,
      accountId: a.account.id,
      kind: `calendar.${kind}`,
      draftId: "",
      payload,
    });
    this.trace.target = approval.id;
    return {
      status: "pending_approval",
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      message: "Queued for human approval; nothing has changed in Google Calendar yet. Check later with get_send_status.",
    };
  }

  /**
   * A direct write. A failed attempt is judged by afterFailure (the event re-read): already in place counts
   * as applied. A failure that may have happened after Google accepted it is recorded as maybeSent when the
   * write counts toward the send caps, and the agent is told how to check or retry safely.
   */
  private async apply(
    a: CalendarAccess,
    kind: CalendarWriteKind,
    d: CalendarApprovalDetail & { eventId: string },
    raw: CalendarEventRaw | null,
    counts: boolean,
  ): Promise<CalendarEventRaw | null> {
    try {
      return await applyChange(a.calendar, kind, d, raw);
    } catch (err) {
      const r = await afterFailure(a.calendar, kind, d, err, false);
      if ("applied" in r) {
        if (counts && isAmbiguous(err)) this.trace.detail.maybeSent = true;
        return r.applied;
      }
      const e = r.error;
      if (e instanceof CalendarApplyError) {
        if (e.code === "write_uncertain") {
          if (counts) this.trace.detail.maybeSent = true;
          throw new ToolError("write_uncertain", `The change may already have been applied, but the event changed since, so xaq can't tell. ${this.checkAdvice(a, kind, d.eventId)}`);
        }
        if (e.code === "event_id_taken") throw new ToolError("event_id_taken", `event_id ${d.eventId} already belongs to a different event. Leave event_id out to create a new event.`);
        if (e.code === "calendar_conflict") throw translate(a, new GoogleApiError(412, "Precondition Failed"));
        throw new ToolError("not_found", eventNotAccessible(d.eventId));
      }
      const known = translate(a, e, eventNotAccessible(d.eventId));
      if (known !== e) throw known;
      if (!isAmbiguous(e)) throw e;
      if (counts) this.trace.detail.maybeSent = true;
      throw new ToolError("write_uncertain", `The connection to Google Calendar failed, so the change may or may not have been applied. ${this.checkAdvice(a, kind, d.eventId)}`);
    }
  }

  /** How to find out whether an uncertain write landed, with the tools this grant has. */
  private checkAdvice(a: CalendarAccess, kind: CalendarWriteKind, eventId: string): string {
    const canRead = a.grant.capabilities.includes("calendar.read");
    const check = `check with get_calendar_event (event_id ${eventId})`;
    if (kind !== "create") return `${check[0]!.toUpperCase()}${check.slice(1)} before retrying.`;
    const retry = `To retry, call create_calendar_event again with the same details and event_id ${eventId}: it can't create a second event.`;
    return canRead ? `${retry} Or ${check} first.` : retry;
  }
}

/** The event as the agent described it, with Google's id: nothing read back from Google. */
function ownView(eventId: string, change: CalendarEventInput): CalendarEventRaw {
  const at = (v: string | undefined) => (v === undefined ? undefined : change.allDay ? { date: v } : { dateTime: v, ...(change.timeZone ? { timeZone: change.timeZone } : {}) });
  return {
    id: eventId,
    summary: change.summary,
    location: change.location,
    start: at(change.start),
    end: at(change.end),
    recurrence: change.recurrence,
    attendees: change.attendees?.map((email) => ({ email })),
  };
}

const notGranted = (email: string) =>
  new ToolError("calendar_not_granted", `Google Calendar isn't connected for ${email} yet. Ask the operator to add Google Calendar for ${email} in the xaq console.`);

/** A Calendar API error as something the agent can act on, or the error itself. */
function translate(a: CalendarAccess, err: unknown, missing?: string): unknown {
  if (!(err instanceof GoogleApiError)) return err;
  const kind = classifyCalendarError(err);
  if (kind === "api_disabled") {
    return new ToolError("calendar_api_disabled", "The Google Calendar API is turned off in xaq's Google Cloud project. Ask the operator to turn it on (xaq console, Accounts).");
  }
  if (kind === "scope_missing") return notGranted(a.account.email);
  if (err.status === 412) {
    return new ToolError("calendar_conflict", "The event changed in Google Calendar since you read it, so nothing was changed. Fetch it again with get_calendar_event and retry.");
  }
  if (missing && (err.status === 404 || err.status === 410)) return new ToolError("not_found", missing);
  return err;
}
