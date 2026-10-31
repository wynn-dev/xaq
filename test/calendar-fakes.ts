// In-memory fake of the CalendarClient interface (server/google/calendar.ts) and a context for the calendar
// policy and approval tests (workstream B). Follows Google's semantics where they matter to policy: etags and
// If-Match (412), client-chosen event ids (409 when taken), attendeesOmitted patches, 404 for unknown ids.

import type { CalendarInfo } from "../shared/types.ts";
import { AgentCalendar } from "../server/calendar/agent.ts";
import { createCalendarService } from "../server/calendar/index.ts";
import type { CalendarService } from "../server/calendar/types.ts";
import type { AppContext } from "../server/context.ts";
import type {
  CalendarAttendeeRaw,
  CalendarClient,
  CalendarEventRaw,
  CalendarListEntryRaw,
  EventsListParams,
  WriteOptions,
} from "../server/google/calendar.ts";
import { CALENDAR_SCOPES, MAIL_SCOPES } from "../server/google/scopes.ts";
import { GoogleApiError, type GoogleService } from "../server/google/types.ts";
import type { IngestService } from "../server/ingest/types.ts";
import { AgentMail, ToolError, type ToolTrace } from "../server/mail/agent.ts";
import { PolicyDenied } from "../server/util/errors.ts";
import { testContext } from "./helpers.ts";
import { FakeGoogle } from "./mail-fakes.ts";

type Op = "list" | "get" | "insert" | "patch" | "delete" | "freeBusy" | "calendarList";

export interface FakeWrite {
  op: "insert" | "patch" | "delete";
  calendarId: string;
  eventId: string;
  body?: Partial<CalendarEventRaw>;
  opts: WriteOptions;
}

const notFound = () => new GoogleApiError(404, "Not Found", "notFound");

export class FakeCalendar implements CalendarClient {
  readonly calendars = new Map<string, { entry: CalendarListEntryRaw; events: Map<string, CalendarEventRaw> }>();
  readonly writes: FakeWrite[] = [];
  readonly calls: Op[] = [];
  readonly freeBusyItems: string[][] = [];
  /** Errors thrown (once each, in order) by the next calls of an operation. */
  readonly fail: Partial<Record<Op, Error[]>> = {};
  private n = 0;

  constructor(
    readonly accountId: string,
    readonly email: string,
  ) {
    this.addCalendar(email, "Me", "owner", true);
  }

  addCalendar(id: string, summary: string, accessRole: CalendarListEntryRaw["accessRole"] = "owner", primary = false): string {
    this.calendars.set(id, { entry: { id, summary, accessRole, primary, timeZone: "Europe/Berlin" }, events: new Map() });
    return id;
  }

  /** Stores an event as Google would have it (fresh etag and `updated`). */
  put(calendarId: string, ev: Partial<CalendarEventRaw> & { id: string }): CalendarEventRaw {
    const stored: CalendarEventRaw = { status: "confirmed", ...ev, etag: `"e${++this.n}"`, updated: new Date(Date.now() + this.n).toISOString() };
    this.cal(calendarId).events.set(ev.id, stored);
    return structuredClone(stored);
  }

  event(calendarId: string, eventId: string): CalendarEventRaw | undefined {
    return this.calendars.get(calendarId)?.events.get(eventId);
  }

  private step(op: Op): void {
    this.calls.push(op);
    const err = this.fail[op]?.shift();
    if (err) throw err;
  }

  private cal(id: string) {
    const c = this.calendars.get(id);
    if (!c) throw notFound();
    return c;
  }

  private ifMatch(current: CalendarEventRaw, opts: WriteOptions) {
    if (opts.ifMatchEtag && opts.ifMatchEtag !== current.etag) throw new GoogleApiError(412, "Precondition Failed", "conditionNotMet");
  }

  async listCalendars() {
    this.step("calendarList");
    return [...this.calendars.values()].map((c) => ({ ...c.entry }));
  }

  async listEvents(calendarId: string, p: EventsListParams) {
    this.step("list");
    const items = [...this.cal(calendarId).events.values()].filter((e) => {
      const start = e.start?.dateTime ?? e.start?.date ?? "";
      const end = e.end?.dateTime ?? e.end?.date ?? "";
      if (p.timeMax && Date.parse(start) >= Date.parse(p.timeMax)) return false;
      if (p.timeMin && Date.parse(end) <= Date.parse(p.timeMin)) return false;
      return !p.q || (e.summary ?? "").toLowerCase().includes(p.q.toLowerCase());
    });
    return { items: items.map((e) => structuredClone(e)), nextPageToken: null, nextSyncToken: null, timeZone: "Europe/Berlin" };
  }

  async getEvent(calendarId: string, eventId: string) {
    this.step("get");
    const e = this.cal(calendarId).events.get(eventId);
    if (!e) throw notFound();
    return structuredClone(e);
  }

  async insertEvent(calendarId: string, event: Partial<CalendarEventRaw>, opts: WriteOptions) {
    this.step("insert");
    const cal = this.cal(calendarId);
    const id = event.id ?? `gen${++this.n}`;
    if (cal.events.has(id)) throw new GoogleApiError(409, "The requested identifier already exists.", "duplicate");
    this.writes.push({ op: "insert", calendarId, eventId: id, body: structuredClone(event), opts });
    return this.put(calendarId, { ...event, id, organizer: { email: this.email, self: true } });
  }

  async patchEvent(calendarId: string, eventId: string, patch: Partial<CalendarEventRaw>, opts: WriteOptions) {
    this.step("patch");
    const current = this.cal(calendarId).events.get(eventId);
    if (!current) throw notFound();
    this.ifMatch(current, opts);
    this.writes.push({ op: "patch", calendarId, eventId, body: structuredClone(patch), opts });
    const { attendeesOmitted, ...rest } = patch;
    let attendees = rest.attendees ?? current.attendees;
    if (attendeesOmitted && rest.attendees) {
      // Only the listed attendees change; the rest of the list stays.
      const byEmail = new Map(rest.attendees.map((a) => [a.email, a]));
      attendees = (current.attendees ?? []).map((a): CalendarAttendeeRaw => ({ ...a, ...byEmail.get(a.email) }));
    }
    return this.put(calendarId, { ...current, ...rest, attendees, id: eventId });
  }

  async deleteEvent(calendarId: string, eventId: string, opts: WriteOptions) {
    this.step("delete");
    const current = this.cal(calendarId).events.get(eventId);
    if (!current || current.status === "cancelled") throw new GoogleApiError(410, "Resource has been deleted", "deleted");
    this.ifMatch(current, opts);
    this.writes.push({ op: "delete", calendarId, eventId, opts });
    this.put(calendarId, { id: eventId, status: "cancelled" });
  }

  async freeBusy(p: { timeMin: string; timeMax: string; items: string[] }) {
    this.step("freeBusy");
    this.freeBusyItems.push(p.items);
    const calendars: Record<string, { busy: { start: string; end: string }[]; errors?: { domain: string; reason: string }[] }> = {};
    for (const id of p.items) {
      const c = this.calendars.get(id);
      calendars[id] = c
        ? { busy: [...c.events.values()].filter((e) => e.status !== "cancelled" && e.start?.dateTime).map((e) => ({ start: e.start!.dateTime!, end: e.end!.dateTime! })) }
        : { busy: [], errors: [{ domain: "global", reason: "notFound" }] };
    }
    return { calendars };
  }

  watchEvents(): never {
    throw new Error("not used");
  }

  stopChannel(): never {
    throw new Error("not used");
  }
}

/** The calendar list as ctx.calendar.calendars returns it (workstream D's shape). */
const infoOf = (c: CalendarListEntryRaw): CalendarInfo => ({
  id: c.id,
  name: c.summaryOverride ?? c.summary ?? c.id,
  primary: !!c.primary,
  accessRole: c.accessRole,
  timeZone: c.timeZone ?? null,
  color: null,
  synced: c.accessRole === "owner" || c.accessRole === "writer",
});

/**
 * A wired context with fake Gmail and Calendar, the real accounts repo and policy, and the real calendar
 * service with sync stubbed out (kicks recorded) and `calendars` answered from the fake's list.
 */
export function calendarTestContext() {
  const google = new FakeGoogle();
  const fakes = new Map<string, FakeCalendar>();
  const kicks: [string | undefined, string | undefined][] = [];
  const t = testContext({
    google: () => {
      const base = google.service();
      return new Proxy(base, {
        get: (target, prop) => (prop === "calendar" ? (id: string) => fakes.get(id)! : Reflect.get(target, prop)),
      }) as GoogleService;
    },
    ingest: () => ({ kick: () => {} }) as unknown as IngestService,
    calendar: (ctx): CalendarService => ({
      ...createCalendarService(ctx),
      kick: (accountId, calendarId) => void kicks.push([accountId, calendarId]),
      calendars: async (accountId) => (await fakes.get(accountId)!.listCalendars()).map(infoOf),
    }),
  });
  const { ctx } = t;

  /** An account; `calendar: false` leaves it mail-only (no calendar scopes granted). */
  const addAccount = (id: string, email: string, opts: { calendar?: boolean } = {}) => {
    const scopes = opts.calendar === false ? MAIL_SCOPES : [...MAIL_SCOPES, ...CALENDAR_SCOPES];
    ctx.db.run(
      "INSERT INTO accounts (id, email, display_name, status, refresh_token_enc, scopes, created_at) VALUES (?, ?, 'Me', 'active', 'x', ?, ?)",
      id,
      email,
      JSON.stringify(scopes),
      new Date().toISOString(),
    );
    const fake = new FakeCalendar(id, email);
    fakes.set(id, fake);
    google.gmail(id);
    return fake;
  };

  return { ...t, google, fakes, kicks, addAccount };
}

export interface ToolCall<T> {
  value?: T;
  error?: unknown;
  outcome: "ok" | "denied" | "error";
  reason: string | null;
  detail: Record<string, unknown>;
}

/**
 * Runs an action the way an MCP tool handler does (server/mcp/server.ts register): one trace, the audit
 * entry recorded under `action`, then the send-cap reservation released.
 */
export async function tool<T>(
  ctx: AppContext,
  agentId: string,
  action: string,
  fn: (cal: AgentCalendar, mail: AgentMail) => Promise<T>,
): Promise<ToolCall<T>> {
  const trace: ToolTrace = { detail: {} };
  const principal = { agentId, name: "agent" };
  let r: ToolCall<T>;
  try {
    const value = await fn(new AgentCalendar(ctx, principal, trace), new AgentMail(ctx, principal, trace));
    r = { value, outcome: "ok", reason: null, detail: trace.detail };
  } catch (error) {
    const outcome = error instanceof PolicyDenied ? "denied" : "error";
    const reason = error instanceof PolicyDenied ? error.reason : error instanceof ToolError ? error.code : "internal";
    r = { error, outcome, reason, detail: trace.detail };
  }
  try {
    ctx.audit.record({
      actorType: "agent",
      actorId: agentId,
      action,
      accountId: trace.accountId ?? null,
      target: trace.target ?? null,
      outcome: r.outcome,
      reason: r.reason,
      detail: Object.keys(trace.detail).length ? trace.detail : null,
    });
  } finally {
    trace.release?.();
  }
  return r;
}

/** The error message of a failed call (for asserting plain-words denials). */
export const messageOf = (r: ToolCall<unknown>): string => (r.error instanceof Error ? r.error.message : "");
