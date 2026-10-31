// Calendar policy (docs/calendar.md "Access"): account and level resolution, calendar ids, writes, attendees
// against allowTo, audit detail and Google errors in words.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GrantInput, MessageContent } from "../shared/types.ts";
import { GoogleApiError } from "../server/google/types.ts";
import { HttpError } from "../server/util/errors.ts";
import { attendeeImpact } from "../server/policy/calendar.ts";
import { calendarTestContext, messageOf, tool } from "./calendar-fakes.ts";
import { grantInput } from "./mail-fakes.ts";

// C's worker-pool cleaning isn't on this branch; the description passes through.
vi.mock("../server/calendar/content.ts", async (orig) => ({
  ...(await orig<typeof import("../server/calendar/content.ts")>()),
  cleanEventDescription: async (_ctx: unknown, e: { description?: string }): Promise<MessageContent | null> =>
    e.description ? { body: e.description, truncated: false, attachments: [], signals: { hiddenContentRemoved: false, suspiciousInstructions: [], auth: null, external: false } } : null,
}));

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const ME = "me@acme.com";
const TEAM = "team@group.calendar.google.com";
const WINDOW = { timeMin: "2026-10-20T00:00:00Z", timeMax: "2026-10-21T00:00:00Z" };
const AT = { start: "2026-10-20T09:00:00Z", end: "2026-10-20T09:30:00Z" };

function setup(grant: Partial<GrantInput> = {}, opts: { calendar?: boolean } = {}) {
  const t = calendarTestContext();
  dispose = t.dispose;
  const cal = t.addAccount("acc_a", ME, opts);
  cal.addCalendar(TEAM, "Team");
  const { agent } = t.ctx.policy.createAgent({
    name: "hermes",
    grants: [grantInput("acc_a", { level: "full", ...grant })],
  });
  const run = <T>(action: string, fn: Parameters<typeof tool<T>>[3]) => tool(t.ctx, agent.id, action, fn);
  t.kicks.length = 0;
  return { ...t, cal, agentId: agent.id, run };
}

describe("account and capability resolution", () => {
  it("denies writes on a read-only grant and names the accounts that would work", async () => {
    const s = setup({ level: "read" });
    s.addAccount("acc_b", "ops@acme.com");
    s.ctx.policy.upsertGrant(s.agentId, "acc_b", grantInput("acc_b", { level: "full" }));

    const denied = await s.run("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "x", ...AT }, {}));
    expect(denied).toMatchObject({ outcome: "denied", reason: "read_only" });
    expect(messageOf(denied)).toBe("You have read-only access to me@acme.com. Accounts with full access: ops@acme.com.");

    const unknown = await s.run("list_calendar_events", (c) => c.listEvents("nobody@acme.com", WINDOW));
    expect(messageOf(unknown)).toMatch(/^You have no access to the account "nobody@acme.com"\. Accounts you can use for this: me@acme.com, ops@acme.com\.$/);

    // The one account with full access is picked without "account".
    expect((await s.run("create_calendar_event", (c) => c.createEvent(undefined, undefined, { summary: "x", ...AT }, {}))).outcome).toBe("ok");
    expect((await s.run("list_calendar_events", (c) => c.listEvents(ME, WINDOW))).outcome).toBe("ok");
  });

  it("asks for an account when several qualify, and lists every grant as accessible", async () => {
    const s = setup();
    s.addAccount("acc_b", "ops@acme.com");
    s.ctx.policy.upsertGrant(s.agentId, "acc_b", grantInput("acc_b"));
    const r = await s.run("list_calendar_events", (c) => c.listEvents(undefined, WINDOW));
    expect(r).toMatchObject({ outcome: "error", reason: "account_required" });
    expect(messageOf(r)).toContain("me@acme.com, ops@acme.com");
    const r2 = await s.run("list_calendars", async (c) => c.accessible().map((x) => x.account.email));
    expect(r2.value).toEqual([ME, "ops@acme.com"]);
  });

  it("answers calendar_not_granted for an account that hasn't added Google Calendar, without calling Google", async () => {
    const s = setup({}, { calendar: false });
    const r = await s.run("list_calendar_events", (c) => c.listEvents(ME, WINDOW));
    expect(r).toMatchObject({ outcome: "error", reason: "calendar_not_granted" });
    expect(messageOf(r)).toBe("Google Calendar isn't connected for me@acme.com yet. Ask the operator to add Google Calendar for me@acme.com in the xaq console.");
    expect(s.cal.calls).toEqual([]);
  });

  it("says Google account (not Gmail) when it needs reconnecting, and keeps operator hints out of agent errors", async () => {
    const s = setup();
    s.ctx.calendar.calendars = async () => {
      throw new HttpError(409, "calendar_api_disabled", "The Google Calendar API is turned off.", "Run gcloud services enable calendar-json.googleapis.com --project=p");
    };
    const listed = await s.run("list_calendars", (c) => c.listCalendars(ME));
    expect(listed).toMatchObject({ reason: "calendar_api_disabled" });
    expect(messageOf(listed)).toBe("The Google Calendar API is turned off.");
    s.ctx.db.run("UPDATE accounts SET status = 'needs_reauth' WHERE id = 'acc_a'");
    const r = await s.run("list_calendar_events", (c) => c.listEvents(ME, WINDOW));
    expect(r.reason).toBe("needs_reauth");
    expect(messageOf(r)).toBe("The Google account me@acme.com needs to be reconnected. Ask the operator to reconnect it in the xaq console.");
  });

  it("turns Google's disabled-API and missing-scope answers into words", async () => {
    const s = setup();
    s.cal.fail.list = [
      new GoogleApiError(403, "Calendar API has not been used in project 1 before or it is disabled.", "SERVICE_DISABLED"),
      new GoogleApiError(403, "Request had insufficient authentication scopes.", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"),
      new GoogleApiError(429, "Rate Limit Exceeded", "rateLimitExceeded"),
    ];
    const disabled = await s.run("list_calendar_events", (c) => c.listEvents(ME, WINDOW));
    expect(disabled.reason).toBe("calendar_api_disabled");
    expect(messageOf(disabled)).toMatch(/Ask the operator to turn it on/);
    expect((await s.run("list_calendar_events", (c) => c.listEvents(ME, WINDOW))).reason).toBe("calendar_not_granted");
    // Anything else stays a Google error for the MCP layer to describe.
    expect((await s.run("list_calendar_events", (c) => c.listEvents(ME, WINDOW))).error).toBeInstanceOf(GoogleApiError);
  });
});

describe("calendar ids", () => {
  it("omission and primary are the account's own calendar", async () => {
    const s = setup();
    expect((await s.run("list_calendar_events", (c) => c.listEvents(ME, WINDOW))).value?.calendarId).toBe(ME);
    expect((await s.run("list_calendar_events", (c) => c.listEvents(ME, { ...WINDOW, calendarId: "PRIMARY" }))).value?.calendarId).toBe(ME);
    expect((await s.run("list_calendar_events", (c) => c.listEvents(ME, { ...WINDOW, calendarId: "Team@Group.Calendar.Google.com" }))).value?.calendarId).toBe(TEAM);
  });

  it("covers only the calendars in the account's list", async () => {
    const s = setup();
    const listed = await s.run("list_calendar_events", (c) => c.listEvents(ME, { ...WINDOW, calendarId: TEAM }));
    expect(listed.outcome).toBe("ok");
    // A calendar the user can reach in Google but isn't in their list (someone's calendar id) is denied.
    const other = await s.run("list_calendar_events", (c) => c.listEvents(ME, { ...WINDOW, calendarId: "boss@acme.com" }));
    expect(other).toMatchObject({ outcome: "denied", reason: "calendar_not_found" });
    expect(messageOf(other)).toBe("Calendar boss@acme.com was not found or is not accessible to you. Use list_calendars to see the calendars you can use.");
    expect(s.cal.calls.filter((c) => c === "list")).toHaveLength(1);
  });

  it("list_calendars lists the account's calendars, on a read-only grant too", async () => {
    const s = setup({ level: "read" });
    expect((await s.run("list_calendars", (c) => c.listCalendars(ME))).value?.calendars.map((c) => c.id)).toEqual([ME, TEAM]);
  });

  it("only finds events on the calendar asked for (an id from another calendar is not found)", async () => {
    const s = setup();
    s.cal.put(TEAM, { id: "t1", summary: "Team only", start: { dateTime: AT.start }, end: { dateTime: AT.end } });
    s.cal.put(ME, { id: "m1", summary: "Mine", description: "notes", start: { dateTime: AT.start }, end: { dateTime: AT.end } });
    const r = await s.run("get_calendar_event", (c) => c.getEvent(ME, undefined, "t1"));
    expect(r).toMatchObject({ outcome: "error", reason: "not_found" });
    expect(messageOf(r)).toBe("Event t1 was not found or is not accessible to you. Use list_calendar_events to find events you can access.");
    const ok = await s.run("get_calendar_event", (c) => c.getEvent(ME, undefined, "m1"));
    expect(ok.value).toMatchObject({ event: { id: "m1", calendarId: ME }, content: { body: "notes" } });
    // Updating or deleting it from the other calendar finds nothing either.
    expect((await s.run("delete_calendar_event", (c) => c.deleteEvent(ME, ME, "t1", {}))).reason).toBe("not_found");
    expect(s.cal.event(TEAM, "t1")?.status).toBe("confirmed");
  });

  it("free/busy: the primary calendar by default, any address when asked", async () => {
    const s = setup();
    await s.run("get_free_busy", (c) => c.freeBusy(ME, WINDOW));
    expect(s.cal.freeBusyItems.at(-1)).toEqual([ME]);
    const any = await s.run("get_free_busy", (c) => c.freeBusy(ME, { ...WINDOW, calendars: ["primary", "Boss@Acme.com"] }));
    expect(any.value?.calendars).toEqual([
      { id: ME, busy: [], error: null },
      { id: "boss@acme.com", busy: [], error: "notFound" },
    ]);
  });

  it("rejects ids that could leave the Calendar URL path, and bad windows", async () => {
    const s = setup();
    for (const id of ["..", ".", "a/b", "x y", "a\u0000", "a#b", "a%2Fb", "a?b"]) {
      expect((await s.run("get_calendar_event", (c) => c.getEvent(ME, undefined, id))).reason).toBe("invalid_arguments");
    }
    expect((await s.run("list_calendar_events", (c) => c.listEvents(ME, { ...WINDOW, calendarId: ".." }))).reason).toBe("invalid_arguments");
    // Google's holiday calendar ids carry "#": a valid id (here not in the account's list).
    expect((await s.run("list_calendar_events", (c) => c.listEvents(ME, { ...WINDOW, calendarId: "en.usa#holiday@group.v.calendar.google.com" }))).reason).toBe("calendar_not_found");
    // "+" addresses are valid calendar ids (free/busy and shared calendars): not in the list, not malformed.
    expect((await s.run("list_calendar_events", (c) => c.listEvents(ME, { ...WINDOW, calendarId: "alice+work@example.com" }))).reason).toBe("calendar_not_found");
    expect((await s.run("list_calendar_events", (c) => c.listEvents(ME, { timeMin: "2026-10-20T00:00:00", timeMax: WINDOW.timeMax }))).reason).toBe("invalid_arguments");
    expect((await s.run("list_calendar_events", (c) => c.listEvents(ME, { timeMin: WINDOW.timeMax, timeMax: WINDOW.timeMin }))).reason).toBe("invalid_arguments");
    // Only the two calendars' lookups in the account's list; no event call went out.
    expect(s.cal.calls).toEqual(["calendarList", "calendarList"]);
  });
});

describe("writes", () => {
  it("writes at once with a chosen event id, notifies by default and is audited", async () => {
    const s = setup();
    const r = await s.run("create_calendar_event", (c) =>
      c.createEvent(ME, undefined, { summary: "Lunch", ...AT, attendees: ["Bob@Example.com", "room1@resource.calendar.google.com"], addConference: true }, {}),
    );
    expect(r.outcome).toBe("ok");
    expect(r.value).toMatchObject({ status: "applied", notified: ["bob@example.com"], event: { summary: "Lunch", calendarId: ME } });
    const [w] = s.cal.writes;
    expect(w).toMatchObject({ op: "insert", calendarId: ME, opts: { sendUpdates: "all", conferenceDataVersion: 1 } });
    expect(w!.eventId).toMatch(/^[0-9a-v]{26}$/);
    expect(w!.body).toMatchObject({ id: w!.eventId, start: { dateTime: AT.start }, attendees: [{ email: "bob@example.com" }, { email: "room1@resource.calendar.google.com" }] });
    expect(s.kicks).toContainEqual(["acc_a", ME]);
    const entry = s.ctx.audit.list({ action: "create_calendar_event" }).items[0]!;
    expect(entry).toMatchObject({ outcome: "ok", target: w!.eventId, detail: { calendarId: ME, eventId: w!.eventId, emailed: true, notified: 1 } });
  });

  it("notify_attendees false sends sendUpdates none and emails nobody", async () => {
    const s = setup();
    const r = await s.run("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "Quiet", ...AT, attendees: ["bob@example.com"] }, { notifyAttendees: false }));
    expect(r.value).toMatchObject({ status: "applied", notified: [] });
    expect(s.cal.writes[0]!.opts.sendUpdates).toBe("none");
    expect(r.detail).toMatchObject({ emailed: false, notified: 0 });
  });

  it("updates keep existing attendees' answers and the account's own entry", async () => {
    const s = setup();
    s.cal.put(ME, {
      id: "m1",
      summary: "Review",
      organizer: { email: ME, self: true },
      attendees: [
        { email: ME, self: true, organizer: true, responseStatus: "accepted" },
        { email: "bob@example.com", responseStatus: "accepted", optional: true },
        { email: "carol@example.com", responseStatus: "declined" },
      ],
      start: { dateTime: AT.start },
      end: { dateTime: AT.end },
    });
    const r = await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { attendees: ["bob@example.com", "dan@example.com"] }, {}));
    expect(r.value).toMatchObject({ status: "applied", notified: ["bob@example.com", "dan@example.com", "carol@example.com"] });
    expect(s.cal.writes[0]!.body!.attendees).toEqual([
      { email: "bob@example.com", responseStatus: "accepted", optional: true },
      { email: "dan@example.com" },
      { email: ME, self: true, organizer: true, responseStatus: "accepted" },
    ]);
  });

  it("sends If-Match on direct updates and deletes; a change in between fails cleanly", async () => {
    const s = setup();
    const ev = s.cal.put(ME, { id: "m1", summary: "A", organizer: { email: ME, self: true }, start: { dateTime: AT.start }, end: { dateTime: AT.end } });
    s.cal.fail.patch = [new GoogleApiError(412, "Precondition Failed", "conditionNotMet")];
    const r = await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { summary: "B" }, {}));
    expect(r).toMatchObject({ outcome: "error", reason: "calendar_conflict" });
    expect(messageOf(r)).toMatch(/changed in Google Calendar since you read it, so nothing was changed/);
    expect(s.cal.event(ME, "m1")?.summary).toBe("A");
    expect((await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { summary: "B" }, {}))).outcome).toBe("ok");
    expect(s.cal.writes[0]!.opts.ifMatchEtag).toBe(ev.etag);
    const del = await s.run("delete_calendar_event", (c) => c.deleteEvent(ME, undefined, "m1", {}));
    expect(del.value).toMatchObject({ status: "deleted", calendarId: ME, eventId: "m1" });
    expect(s.cal.writes[1]!.opts.ifMatchEtag).toMatch(/^"e\d+"$/);
    expect((await s.run("delete_calendar_event", (c) => c.deleteEvent(ME, undefined, "m1", {}))).reason).toBe("not_found");
  });

  it("an uncertain write counts as maybe sent and names the event id to check", async () => {
    const s = setup();
    s.cal.fail.insert = [new GoogleApiError(503, "Backend Error", "backendError")];
    const r = await s.run("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "x", ...AT, attendees: ["bob@example.com"] }, {}));
    expect(r).toMatchObject({ outcome: "error", reason: "write_uncertain", detail: { maybeSent: true, emailed: true } });
    expect(messageOf(r)).toContain(`event_id ${r.detail.eventId}`);
  });

  it("a create whose id Google already has is the earlier attempt: applied, not duplicated", async () => {
    const s = setup();
    const ids: string[] = [];
    const insert = s.cal.insertEvent.bind(s.cal);
    s.cal.insertEvent = async (cal, ev, opts) => {
      ids.push(ev.id!);
      // The client's first attempt landed, but its answer was lost; its retry gets 409.
      s.cal.put(cal, { ...ev, id: ev.id! });
      return insert(cal, ev, opts);
    };
    const r = await s.run("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "x", ...AT }, {}));
    expect(r.value).toMatchObject({ status: "applied", event: { id: ids[0], summary: "x" } });
    expect([...s.cal.calendars.get(ME)!.events.keys()]).toEqual(ids);
  });

  it("an uncertain create names its event_id; retrying with it is idempotent", async () => {
    const s = setup();
    const insert = s.cal.insertEvent.bind(s.cal);
    s.cal.insertEvent = async (cal, ev, opts) => {
      await insert(cal, ev, opts);
      throw new GoogleApiError(0, "Google didn't respond within 30s", "timeout");
    };
    s.cal.fail.get = [new GoogleApiError(0, "Google didn't respond within 30s", "timeout")];
    const first = await s.run("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "x", ...AT, attendees: ["ann@acme.com"] }, {}));
    const id = first.detail.eventId as string;
    expect(first).toMatchObject({ outcome: "error", reason: "write_uncertain", detail: { maybeSent: true } });
    expect(messageOf(first)).toBe(
      `The connection to Google Calendar failed, so the change may or may not have been applied. To retry, call create_calendar_event again with the same details and event_id ${id}: it can't create a second event. Or check with get_calendar_event (event_id ${id}) first.`,
    );
    s.cal.insertEvent = insert;
    const retry = await s.run("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "x", ...AT, attendees: ["ann@acme.com"] }, { eventId: id }));
    expect(retry.value).toMatchObject({ status: "applied", event: { id } });
    expect(s.cal.calendars.get(ME)!.events.size).toBe(1);

    const other = await s.run("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "different", ...AT }, { eventId: id }));
    expect(other).toMatchObject({ outcome: "error", reason: "event_id_taken" });
    expect(messageOf(other)).toBe(`event_id ${id} already belongs to a different event. Leave event_id out to create a new event.`);
    expect((await s.run("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "x", ...AT }, { eventId: "Not-Base32" }))).reason).toBe("invalid_arguments");
  });

  it("an update whose answer was lost: applied when in place, uncertain otherwise", async () => {
    const s = setup();
    s.cal.put(ME, { id: "m1", summary: "A", organizer: { email: ME, self: true }, attendees: [{ email: "ann@acme.com" }], start: { dateTime: AT.start }, end: { dateTime: AT.end } });
    const patch = s.cal.patchEvent.bind(s.cal);
    s.cal.patchEvent = async (...args) => {
      await patch(...args);
      throw new GoogleApiError(503, "Backend Error", "outcome_unknown");
    };
    const landed = await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { summary: "B" }, {}));
    expect(landed).toMatchObject({ outcome: "ok", value: { status: "applied", event: { summary: "B" } }, detail: { maybeSent: true } });

    s.cal.patchEvent = async () => {
      throw new GoogleApiError(0, "Could not reach Google", "network");
    };
    const lost = await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { summary: "C" }, {}));
    expect(lost).toMatchObject({ outcome: "error", reason: "write_uncertain", detail: { maybeSent: true } });
    expect(messageOf(lost)).toContain("Check with get_calendar_event (event_id m1) before retrying.");
  });

  it("RSVP answers only invitations, patching the account's own entry", async () => {
    const s = setup();
    s.cal.put(ME, {
      id: "inv",
      summary: "Party",
      organizer: { email: "host@other.com" },
      attendees: [
        { email: "host@other.com", organizer: true, responseStatus: "accepted" },
        { email: ME, self: true, responseStatus: "needsAction" },
      ],
      start: { dateTime: AT.start },
      end: { dateTime: AT.end },
    });
    s.cal.put(ME, { id: "mine", summary: "Mine", organizer: { email: ME, self: true }, start: { dateTime: AT.start }, end: { dateTime: AT.end } });
    expect((await s.run("respond_to_invitation", (c) => c.respond(ME, undefined, "mine", "accepted", {}))).reason).toBe("not_invited");
    const r = await s.run("respond_to_invitation", (c) => c.respond(ME, undefined, "inv", "tentative", { notifyAttendees: false }));
    expect(r.value).toMatchObject({ status: "applied", event: { selfResponse: "tentative" }, notified: [] });
    expect(s.cal.writes[0]).toMatchObject({ op: "patch", body: { attendees: [{ email: ME, responseStatus: "tentative" }], attendeesOmitted: true }, opts: { sendUpdates: "none" } });
    expect(s.cal.event(ME, "inv")!.attendees![0]!.responseStatus).toBe("accepted");
  });

  it("rejects a time_zone-only update instead of sending an empty patch", async () => {
    const s = setup();
    s.cal.put(ME, { id: "m1", summary: "A", organizer: { email: ME, self: true }, attendees: [{ email: "ann@acme.com" }], start: { dateTime: AT.start }, end: { dateTime: AT.end } });
    const r = await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { timeZone: "Europe/Berlin" }, {}));
    expect(r).toMatchObject({ outcome: "error", reason: "invalid_arguments" });
    expect(messageOf(r)).toBe("time_zone applies to start and end: pass them with it.");
    expect(s.cal.writes).toEqual([]);
  });

  it("keeps rooms on an update unless the new list names rooms itself", async () => {
    const s = setup();
    const room = "r1@resource.calendar.google.com";
    s.cal.put(ME, {
      id: "m1",
      summary: "A",
      organizer: { email: ME, self: true },
      attendees: [{ email: "ann@acme.com" }, { email: room, resource: true, responseStatus: "accepted" }],
      start: { dateTime: AT.start },
      end: { dateTime: AT.end },
    });
    await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { attendees: ["bob@acme.com"] }, {}));
    expect(s.cal.writes[0]!.body!.attendees).toEqual([{ email: "bob@acme.com" }, { email: room, resource: true, responseStatus: "accepted" }]);
    await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { attendees: ["bob@acme.com", "r2@resource.calendar.google.com"] }, {}));
    expect(s.cal.writes[1]!.body!.attendees).toEqual([{ email: "bob@acme.com" }, { email: "r2@resource.calendar.google.com" }]);
  });

  it("validates event input", async () => {
    const s = setup();
    const bad = async (input: Parameters<import("../server/calendar/agent.ts").AgentCalendar["createEvent"]>[2]) =>
      messageOf(await s.run("create_calendar_event", (c) => c.createEvent(ME, undefined, input, {})));
    expect(await bad({ summary: "", ...AT })).toMatch(/summary/);
    expect(await bad({ summary: "x", start: AT.start })).toMatch(/start and end together/);
    expect(await bad({ summary: "x", start: AT.end, end: AT.start })).toMatch(/end must be after start/);
    expect(await bad({ summary: "x", start: "2026-10-20", end: AT.end })).toMatch(/both be dates/);
    expect(await bad({ summary: "x", start: "2026-10-20T09:00:00", end: "2026-10-20T10:00:00" })).toMatch(/time_zone/);
    expect(await bad({ summary: "x", ...AT, timeZone: "Mars/Olympus" })).toMatch(/Unknown time zone/);
    expect(await bad({ summary: "x", ...AT, attendees: ["not-an-address"] })).toMatch(/Not email addresses/);
    expect(await bad({ summary: "x", ...AT, recurrence: ["FREQ=DAILY"] })).toMatch(/RRULE/);
    expect(s.cal.writes).toEqual([]);
    const allDay = await s.run("create_calendar_event", (c) =>
      c.createEvent(ME, undefined, { summary: "Off", start: "2026-10-20", end: "2026-10-21", allDay: true }, {}),
    );
    expect(allDay.value).toMatchObject({ status: "applied", event: { allDay: true, start: "2026-10-20" } });
    const local = await s.run("create_calendar_event", (c) =>
      c.createEvent(ME, undefined, { summary: "Local", start: "2026-10-20T09:00:00", end: "2026-10-20T10:00:00", allDay: false, timeZone: "Europe/Berlin" }, {}),
    );
    expect(s.cal.writes.at(-1)!.body!.start).toEqual({ dateTime: "2026-10-20T09:00:00", date: null, timeZone: "Europe/Berlin" });
    expect(local.outcome).toBe("ok");
  });
});

describe("attendees and allowTo", () => {
  const allow = { allowTo: ["*@acme.com"] };
  const meeting = (attendees: string[], organizer = ME) => ({
    id: "m1",
    summary: "Plan",
    organizer: { email: organizer, self: organizer === ME },
    attendees: [...attendees.map((email) => ({ email, responseStatus: "accepted" as const })), { email: ME, self: true }],
    guestsCanModify: true,
    start: { dateTime: AT.start },
    end: { dateTime: AT.end },
  });

  it("checks every attendee after the change, with notify on and off", async () => {
    const s = setup(allow);
    for (const notifyAttendees of [true, false]) {
      const r = await s.run("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "x", ...AT, attendees: ["ann@acme.com", "eve@evil.com"] }, { notifyAttendees }));
      expect(r).toMatchObject({ outcome: "denied", reason: "allow_to" });
      expect(messageOf(r)).toBe(
        "Not allowed to involve eve@evil.com in this event. This account only lets you contact: *@acme.com. Remove those attendees, leave events organized by others alone, or ask the operator to extend the allowlist.",
      );
    }
    const ok = await s.run("create_calendar_event", (c) =>
      c.createEvent(ME, undefined, { summary: "x", ...AT, attendees: ["ann@acme.com", ME, "room@resource.calendar.google.com"] }, {}),
    );
    expect(ok.value).toMatchObject({ status: "applied", notified: ["ann@acme.com"] });
    expect(s.cal.writes).toHaveLength(1);
  });

  it("can't write into an event an outsider can read, even quietly (exfiltration through a shared event)", async () => {
    const s = setup(allow);
    s.cal.put(ME, meeting(["eve@evil.com"], "eve@evil.com"));
    for (const notifyAttendees of [true, false]) {
      const r = await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { description: "the secret" }, { notifyAttendees }));
      expect(r).toMatchObject({ outcome: "denied", reason: "allow_to" });
    }
    // Removing the outsider while notifying emails them a cancellation: also checked.
    s.cal.put(ME, meeting(["ann@acme.com", "eve@evil.com"]));
    const remove = await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { attendees: ["ann@acme.com"] }, {}));
    expect(remove.reason).toBe("allow_to");
    const quiet = await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { attendees: ["ann@acme.com"] }, { notifyAttendees: false }));
    expect(quiet.value).toMatchObject({ status: "applied", notified: [] });
    expect(s.cal.writes).toHaveLength(1);
  });

  it("deletes: attendees of the account's own event, the organizer of someone else's", async () => {
    const s = setup(allow);
    s.cal.put(ME, meeting(["eve@evil.com"]));
    expect((await s.run("delete_calendar_event", (c) => c.deleteEvent(ME, undefined, "m1", {}))).reason).toBe("allow_to");
    const quiet = await s.run("delete_calendar_event", (c) => c.deleteEvent(ME, undefined, "m1", { notifyAttendees: false }));
    expect(quiet.value).toMatchObject({ status: "deleted", notified: [] });

    s.cal.put(ME, { ...meeting(["ann@acme.com"], "eve@evil.com"), id: "m2" });
    const theirs = await s.run("delete_calendar_event", (c) => c.deleteEvent(ME, undefined, "m2", {}));
    expect(theirs.reason).toBe("allow_to");
    expect(messageOf(theirs)).toContain("eve@evil.com");
    // Quietly removing someone else's event from the account's calendar writes nothing to its organizer.
    expect((await s.run("delete_calendar_event", (c) => c.deleteEvent(ME, undefined, "m2", { notifyAttendees: false }))).value).toMatchObject({ status: "deleted" });
    expect(attendeeImpact({ kind: "delete", selfEmail: ME, before: ["ann@acme.com"], after: [], notify: true, organizer: "eve@evil.com" }).emailed).toEqual(["eve@evil.com"]);
  });

  it("RSVP: a comment must pass allowTo for every attendee, since Google shows it to all of them", async () => {
    const s = setup(allow);
    s.cal.put(ME, {
      id: "inv",
      summary: "Offsite",
      organizer: { email: "boss@acme.com" },
      attendees: [{ email: "boss@acme.com", organizer: true }, { email: "eve@evil.com" }, { email: "r@resource.calendar.google.com", resource: true }, { email: ME, self: true }],
      start: { dateTime: AT.start },
      end: { dateTime: AT.end },
    });
    const commented = await s.run("respond_to_invitation", (c) => c.respond(ME, undefined, "inv", "accepted", { comment: "Q3 numbers attached" }));
    expect(commented).toMatchObject({ outcome: "denied", reason: "allow_to" });
    expect(messageOf(commented)).toContain("eve@evil.com");
    s.ctx.policy.upsertGrant(s.agentId, "acc_a", grantInput("acc_a", { level: "full", allowTo: ["*@acme.com", "eve@evil.com"] }));
    const answered = await s.run("respond_to_invitation", (c) => c.respond(ME, undefined, "inv", "accepted", { comment: "See you" }));
    expect(answered.value).toMatchObject({ status: "applied", notified: ["boss@acme.com"] });
  });

  it("won't change or comment on an event whose guest list is hidden from the account", async () => {
    const s = setup(allow);
    for (const hide of [{ guestsCanSeeOtherGuests: false }, { attendeesOmitted: true }]) {
      s.cal.put(ME, {
        id: "h1",
        summary: "All hands",
        organizer: { email: "boss@acme.com" },
        attendees: [{ email: ME, self: true, responseStatus: "needsAction" }],
        guestsCanModify: true,
        start: { dateTime: AT.start },
        end: { dateTime: AT.end },
        ...hide,
      });
      const upd = await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "h1", { description: "x" }, { notifyAttendees: false }));
      expect(upd).toMatchObject({ outcome: "denied", reason: "allow_to" });
      expect(messageOf(upd)).toMatch(/^The organizer hides this event's guest list/);
      expect((await s.run("respond_to_invitation", (c) => c.respond(ME, undefined, "h1", "accepted", { comment: "hi" }))).reason).toBe("allow_to");
      expect((await s.run("respond_to_invitation", (c) => c.respond(ME, undefined, "h1", "accepted", {}))).outcome).toBe("ok");
    }
    // Without an allowlist there's nothing to check.
    s.ctx.policy.upsertGrant(s.agentId, "acc_a", grantInput("acc_a", { level: "full" }));
    expect((await s.run("update_calendar_event", (c) => c.updateEvent(ME, undefined, "h1", { description: "x" }, {}))).outcome).toBe("ok");
  });

  it("RSVP: a bare answer goes to any organizer, a comment only to allowed ones", async () => {
    const s = setup(allow);
    s.cal.put(ME, {
      id: "inv",
      summary: "Pitch",
      organizer: { email: "eve@evil.com" },
      attendees: [{ email: "eve@evil.com", organizer: true }, { email: ME, self: true, responseStatus: "needsAction" }],
      start: { dateTime: AT.start },
      end: { dateTime: AT.end },
    });
    const commented = await s.run("respond_to_invitation", (c) => c.respond(ME, undefined, "inv", "declined", { comment: "the secret", notifyAttendees: false }));
    expect(commented).toMatchObject({ outcome: "denied", reason: "allow_to" });
    const bare = await s.run("respond_to_invitation", (c) => c.respond(ME, undefined, "inv", "declined", {}));
    expect(bare.value).toMatchObject({ status: "applied", notified: ["eve@evil.com"] });
    expect(bare.detail).toMatchObject({ emailed: true, notified: 1 });
  });

});

describe("grants", () => {
  it("starts calendar sync when a grant is added", () => {
    const s = setup();
    expect(s.kicks).toEqual([]);
    s.addAccount("acc_b", "ops@acme.com");
    s.ctx.policy.upsertGrant(s.agentId, "acc_b", grantInput("acc_b"));
    s.ctx.policy.upsertGrant(s.agentId, "acc_b", grantInput("acc_b", { level: "full" }));
    expect(s.kicks).toEqual([["acc_b", undefined]]);
    s.ctx.policy.createAgent({ name: "two", grants: [grantInput("acc_a")] });
    expect(s.kicks).toHaveLength(2);
  });

  it("shows account events to any grant on the account", () => {
    const s = setup({ level: "read" });
    const see = (type: "account.auth_failed" | "sync.gap") => s.ctx.policy.canSeeEvent(s.agentId, { accountId: "acc_a", type });
    expect([see("account.auth_failed"), see("sync.gap")]).toEqual([true, true]);
  });
});
