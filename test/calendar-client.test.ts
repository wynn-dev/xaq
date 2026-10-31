// The Google Calendar REST client (server/google/calendar.ts) against the fake Calendar API: paging and
// sync tokens, 410, error classes, retries (never re-sending a non-idempotent insert), If-Match, RSVP,
// free/busy and watch channels.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../server/context.ts";
import { activationUrl, type CalendarClient, classifyCalendarError } from "../server/google/calendar.ts";
import { CALENDAR_SCOPES, GMAIL_SCOPE } from "../shared/google-scopes.ts";
import { isOutcomeUnknown } from "../server/google/http.ts";
import { GoogleApiError } from "../server/google/types.ts";
import { connectFakeAccount, type FakeGoogle, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

const ME = "me@example.com";
const BOB = "bob@example.com";
const MAIL = [GMAIL_SCOPE, "openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"];
const T0 = Date.parse("2030-03-04T09:00:00Z");
const at = (h: number) => ({ dateTime: new Date(T0 + h * 3600_000).toISOString() });

let fake: FakeGoogle;
let ctx: AppContext;
let dispose: () => Promise<void>;
let cal: CalendarClient;

beforeEach(async () => {
  fake = await startFakeGoogle();
  const t = testContext({}, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
  const account = await connectFakeAccount(ctx, fake, ME, { name: "Me", scopes: [...MAIL, ...CALENDAR_SCOPES] });
  cal = ctx.google.calendar(account.id);
});

afterEach(async () => {
  await dispose();
  await fake.close();
});

const rejection = (p: Promise<unknown>) => p.then(() => null, (err: unknown) => err as GoogleApiError);
const posts = (path: RegExp) => fake.requests.filter((r) => r.method === "POST" && path.test(r.path)).length;

describe("calendar list and events", () => {
  it("lists the account's calendars, primary first, with their roles", async () => {
    const team = fake.calendar.addCalendar(ME, { name: "Team" });
    fake.calendar.addCalendar(ME, { name: "Holidays", accessRole: "reader" });
    fake.calendar.addCalendar(ME, { name: "Archive", hidden: true });
    const list = await cal.listCalendars();
    // Hidden calendars are the user's too; callers decide whether to show them.
    expect(list.map((c) => [c.summary, c.accessRole, !!c.primary, !!c.hidden])).toEqual([
      [ME, "owner", true, false],
      ["Team", "owner", false, false],
      ["Holidays", "reader", false, false],
      ["Archive", "owner", false, true],
    ]);
    expect(list[1]!.id).toBe(team);
  });

  it("pages, hands out the sync token on the last page only, and returns changes (deletions id-only)", async () => {
    const ids = [0, 1, 2, 3, 4].map((i) => fake.calendar.putEvent(ME, ME, { summary: `E${i}`, start: at(i), end: at(i + 1) }).id);
    const first = await cal.listEvents(ME, { maxResults: 2 });
    expect(first.items.map((e) => e.summary)).toEqual(["E0", "E1"]);
    expect(first).toMatchObject({ nextSyncToken: null, timeZone: "UTC" });
    const second = await cal.listEvents(ME, { maxResults: 2, pageToken: first.nextPageToken! });
    const third = await cal.listEvents(ME, { maxResults: 2, pageToken: second.nextPageToken! });
    expect(third.items.map((e) => e.summary)).toEqual(["E4"]);
    expect(third.nextPageToken).toBeNull();
    expect(third.nextSyncToken).toBeTruthy();

    fake.calendar.putEvent(ME, ME, { id: ids[1], summary: "E1 moved" });
    fake.calendar.cancelEvent(ME, ME, ids[2]!);
    const changes = await cal.listEvents(ME, { syncToken: third.nextSyncToken! });
    expect(changes.items.map((e) => [e.id, e.status, e.summary])).toEqual([
      [ids[1], "confirmed", "E1 moved"],
      [ids[2], "cancelled", undefined],
    ]);
    const quiet = await cal.listEvents(ME, { syncToken: changes.nextSyncToken! });
    expect(quiet.items).toEqual([]);
  });

  it("answers 410 for an expired sync token and 400 for parameters Google refuses next to one", async () => {
    fake.calendar.putEvent(ME, ME, { summary: "x", start: at(0), end: at(1) });
    const { nextSyncToken } = await cal.listEvents(ME, {});
    const bad = await rejection(cal.listEvents(ME, { syncToken: nextSyncToken!, timeMin: new Date(T0).toISOString() }));
    expect(bad?.status).toBe(400);
    fake.calendar.expireSyncTokens(ME);
    const gone = await rejection(cal.listEvents(ME, { syncToken: nextSyncToken! }));
    expect(gone).toBeInstanceOf(GoogleApiError);
    expect(gone!.status).toBe(410);
    expect(classifyCalendarError(gone)).toBe("sync_token_expired");
  });

  it("expands recurring events, orders by start, and edits a single instance", async () => {
    const series = fake.calendar.putEvent(ME, ME, { summary: "Standup", start: at(0), end: at(0.25), recurrence: ["RRULE:FREQ=DAILY;COUNT=3"] });
    fake.calendar.putEvent(ME, ME, { summary: "Lunch", start: at(3), end: at(4) });
    const window = { timeMin: new Date(T0 - 3600_000).toISOString(), timeMax: new Date(T0 + 5 * 86_400_000).toISOString() };
    const list = await cal.listEvents(ME, { ...window, singleEvents: true, orderBy: "startTime" });
    expect(list.items.map((e) => e.summary)).toEqual(["Standup", "Lunch", "Standup", "Standup"]);
    const second = list.items[2]!;
    expect(second).toMatchObject({ id: `${series.id}_20300305T090000Z`, recurringEventId: series.id });
    await cal.patchEvent(ME, second.id, { summary: "Standup (moved)" }, { sendUpdates: "none" });
    const after = await cal.listEvents(ME, { ...window, singleEvents: true, orderBy: "startTime" });
    expect(after.items.map((e) => e.summary)).toEqual(["Standup", "Lunch", "Standup (moved)", "Standup"]);
    expect((await cal.listEvents(ME, { q: "lunch" })).items.map((e) => e.summary)).toEqual(["Lunch"]);
  });

  it("lists cancelled occurrences of a series in unexpanded listings, and finds instances of a series starting at odd milliseconds", async () => {
    const start = T0 + 123;
    const series = fake.calendar.putEvent(ME, ME, {
      summary: "Standup",
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(start + 900_000).toISOString() },
      recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
    });
    const id = `${series.id}_20300305T090000Z`;
    expect((await cal.getEvent(ME, id)).recurringEventId).toBe(series.id);
    await cal.deleteEvent(ME, id, { sendUpdates: "none" });
    const listed = await cal.listEvents(ME, {});
    expect(listed.items.map((e) => [e.id, e.status])).toEqual([
      [series.id, "confirmed"],
      [id, "cancelled"],
    ]);
    expect(listed.items[1]).toMatchObject({ recurringEventId: series.id, originalStartTime: { dateTime: expect.stringMatching(/^2030-03-05T09:00:00/) } });
    const expanded = await cal.listEvents(ME, { singleEvents: true, timeMin: new Date(T0 - 1).toISOString(), timeMax: new Date(T0 + 5 * 86_400_000).toISOString() });
    expect(expanded.items).toHaveLength(2);
  });

  it("gets an event, and maps a missing one to 404", async () => {
    const e = fake.calendar.putEvent(ME, ME, { summary: "x", start: at(0), end: at(1) });
    expect((await cal.getEvent(ME, e.id)).summary).toBe("x");
    expect((await rejection(cal.getEvent(ME, "nope")))?.status).toBe(404);
  });
});

describe("writes", () => {
  it("records who Google emails per sendUpdates and mirrors invitations onto fake attendees", async () => {
    fake.addAccount(BOB);
    const created = await cal.insertEvent(
      ME,
      { summary: "Kickoff", start: at(0), end: at(1), attendees: [{ email: BOB }, { email: "Ext@Partner.test" }, { email: "room@resource.calendar.google.com" }] },
      { sendUpdates: "all" },
    );
    expect(created.organizer).toMatchObject({ email: ME, self: true });
    expect(fake.calendar.mailsSent(ME)).toEqual([
      { to: BOB, kind: "invite", eventId: created.id },
      { to: "ext@partner.test", kind: "invite", eventId: created.id },
    ]);
    const copy = fake.calendar.event(BOB, BOB, created.id)!;
    expect(copy.organizer?.self).toBeUndefined();
    expect(copy.attendees?.find((a) => a.self)).toMatchObject({ email: BOB, responseStatus: "needsAction" });

    await cal.patchEvent(ME, created.id, { attendees: [{ email: BOB }] }, { sendUpdates: "externalOnly" });
    // externalOnly: only guests outside Google Calendar (here: not fake accounts) hear about it.
    expect(fake.calendar.mailsSent(ME).slice(2)).toEqual([{ to: "ext@partner.test", kind: "cancel", eventId: created.id }]);
    await cal.deleteEvent(ME, created.id, { sendUpdates: "none" });
    expect(fake.calendar.mailsSent(ME)).toHaveLength(3);
    expect(fake.calendar.event(BOB, BOB, created.id)!.status).toBe("cancelled");
  });

  it("lets an invitee answer for itself only, and tells the organizer", async () => {
    fake.addAccount(BOB);
    const inv = fake.calendar.invite(BOB, [ME], { summary: "Review", start: at(0), end: at(1) });
    const answered = await cal.patchEvent(ME, inv.id, { attendeesOmitted: true, attendees: [{ email: ME, self: true, responseStatus: "accepted" }] }, { sendUpdates: "all" });
    expect(answered.attendees?.find((a) => a.self)?.responseStatus).toBe("accepted");
    expect(fake.calendar.event(BOB, BOB, inv.id)!.attendees?.find((a) => a.email === ME)?.responseStatus).toBe("accepted");
    expect(fake.calendar.mailsSent(ME)).toEqual([{ to: BOB, kind: "reply", eventId: inv.id }]);
    const denied = await rejection(cal.patchEvent(ME, inv.id, { summary: "Mine now" }, { sendUpdates: "none" }));
    expect(denied?.status).toBe(403);
  });

  it("sends If-Match: a stale etag gets 412", async () => {
    const e = await cal.insertEvent(ME, { summary: "v1", start: at(0), end: at(1) }, { sendUpdates: "none" });
    const v2 = await cal.patchEvent(ME, e.id, { summary: "v2" }, { sendUpdates: "none", ifMatchEtag: e.etag });
    expect(v2.etag).not.toBe(e.etag);
    const stale = await rejection(cal.patchEvent(ME, e.id, { summary: "v3" }, { sendUpdates: "none", ifMatchEtag: e.etag }));
    expect(stale?.status).toBe(412);
    expect((await rejection(cal.deleteEvent(ME, e.id, { sendUpdates: "none", ifMatchEtag: e.etag })))?.status).toBe(412);
    expect(fake.calendar.event(ME, ME, e.id)!.summary).toBe("v2");
  });

  it("treats deleting an already deleted event as done", async () => {
    const e = await cal.insertEvent(ME, { summary: "x", start: at(0), end: at(1) }, { sendUpdates: "none" });
    await cal.deleteEvent(ME, e.id, { sendUpdates: "none" });
    await expect(cal.deleteEvent(ME, e.id, { sendUpdates: "none" })).resolves.toBeUndefined();
  });

  it("never re-sends an insert after a 5xx (it may have been created), but retries a rate limit", async () => {
    const events = /^\/calendar\/v3\/calendars\/[^/]+\/events$/;
    fake.failNext({ method: "POST", path: events, status: 503, afterProcessing: true });
    const err = await rejection(cal.insertEvent(ME, { summary: "Once", start: at(0), end: at(1) }, { sendUpdates: "none" }));
    expect(err?.status).toBe(503);
    expect(err?.message).toMatch(/may have been created/);
    expect(posts(events)).toBe(1);
    expect(fake.calendar.events(ME, ME).map((e) => e.summary)).toEqual(["Once"]);

    fake.failNext({ method: "POST", path: events, status: 429, retryAfter: 0 });
    await cal.insertEvent(ME, { summary: "Twice asked", start: at(0), end: at(1) }, { sendUpdates: "none" });
    expect(posts(events)).toBe(3);
    expect(fake.calendar.events(ME, ME)).toHaveLength(2);
  });

  it("retries an insert with an id of its own, which Google answers 409 (duplicate) once it exists", async () => {
    const events = /^\/calendar\/v3\/calendars\/[^/]+\/events$/;
    fake.failNext({ method: "POST", path: events, status: 503, retryAfter: 0, afterProcessing: true });
    const err = await rejection(cal.insertEvent(ME, { id: "aib0000001", summary: "Once", start: at(0), end: at(1) }, { sendUpdates: "none" }));
    expect(posts(events)).toBe(2);
    expect(err?.status).toBe(409);
    expect(classifyCalendarError(err)).toBe("duplicate");
    expect(fake.calendar.events(ME, ME).map((e) => e.id)).toEqual(["aib0000001"]);

    fake.failNext({ method: "POST", path: events, status: 503, retryAfter: 0 });
    await cal.insertEvent(ME, { id: "aib0000002", summary: "Retried", start: at(0), end: at(1) }, { sendUpdates: "none" });
    expect(fake.calendar.events(ME, ME)).toHaveLength(2);
  });

  it("rejects event ids Google wouldn't accept", async () => {
    for (const id of ["abc", "Has-Upper-And-Dash", "wxyz12345"]) {
      const err = await rejection(cal.insertEvent(ME, { id, summary: "x", start: at(0), end: at(1) }, { sendUpdates: "none" }));
      expect([id, err?.status]).toEqual([id, 400]);
    }
  });

  it("calls a retried If-Match write that then fails its precondition an unknown outcome, not a conflict", async () => {
    const e = await cal.insertEvent(ME, { summary: "v1", start: at(0), end: at(1) }, { sendUpdates: "none" });
    // The first attempt is applied (the etag changes), then answers 503; the retry's If-Match no longer matches.
    fake.failNext({ method: "PATCH", path: "/events/", status: 503, retryAfter: 0, afterProcessing: true });
    const err = await rejection(cal.patchEvent(ME, e.id, { summary: "v2" }, { sendUpdates: "none", ifMatchEtag: e.etag }));
    expect(err?.status).toBe(503);
    expect(classifyCalendarError(err)).toBe("outcome_unknown");
    expect(isOutcomeUnknown(err)).toBe(true);
    expect(err?.message).toMatch(/may already have been applied/);
    expect(fake.calendar.event(ME, ME, e.id)!.summary).toBe("v2");

    const v2 = fake.calendar.event(ME, ME, e.id)!;
    fake.failNext({ method: "DELETE", path: "/events/", status: 503, retryAfter: 0, afterProcessing: true });
    const del = await rejection(cal.deleteEvent(ME, e.id, { sendUpdates: "none", ifMatchEtag: v2.etag }));
    // Deleted by the first attempt: the retry gets 410 (already gone), which counts as done.
    expect(del).toBeNull();
    // A plain stale etag is still a conflict.
    const f = await cal.insertEvent(ME, { summary: "f1", start: at(0), end: at(1) }, { sendUpdates: "none" });
    await cal.patchEvent(ME, f.id, { summary: "f2" }, { sendUpdates: "none" });
    const stale = await rejection(cal.patchEvent(ME, f.id, { summary: "f3" }, { sendUpdates: "none", ifMatchEtag: f.etag }));
    expect([stale?.status, classifyCalendarError(stale)]).toEqual([412, "other"]);
  });

  it("calls a write that fails with server errors on every attempt an unknown outcome, but not a read", async () => {
    const e = fake.calendar.putEvent(ME, ME, { summary: "x", start: at(0), end: at(1) });
    fake.failNext({ method: "PATCH", path: "/events/", status: 503, retryAfter: 0, times: 5 });
    const write = await rejection(cal.patchEvent(ME, e.id, { summary: "y" }, { sendUpdates: "none" }));
    expect([write?.status, classifyCalendarError(write)]).toEqual([503, "outcome_unknown"]);
    fake.failNext({ method: "GET", path: "/events/", status: 503, retryAfter: 0, times: 5 });
    const read = await rejection(cal.getEvent(ME, e.id));
    expect([read?.status, classifyCalendarError(read)]).toEqual([503, "other"]);
  });

  it("retries idempotent calls after a 5xx", async () => {
    const e = fake.calendar.putEvent(ME, ME, { summary: "x", start: at(0), end: at(1) });
    fake.failNext({ method: "PATCH", path: "/events/", status: 503, retryAfter: 0 });
    expect((await cal.patchEvent(ME, e.id, { summary: "y" }, { sendUpdates: "none" })).summary).toBe("y");
  });
});

describe("free/busy", () => {
  it("returns merged busy intervals for own and other users' calendars, and notFound for unknown ones", async () => {
    fake.addAccount(BOB);
    fake.calendar.putEvent(ME, ME, { summary: "a", start: at(0), end: at(2) });
    fake.calendar.putEvent(ME, ME, { summary: "b", start: at(1), end: at(3) });
    fake.calendar.putEvent(ME, ME, { summary: "free", start: at(5), end: at(6), transparency: "transparent" });
    fake.calendar.putEvent(BOB, BOB, { summary: "c", start: at(4), end: at(5) });
    const r = await cal.freeBusy({ timeMin: new Date(T0).toISOString(), timeMax: new Date(T0 + 86_400_000).toISOString(), items: ["primary", BOB, "ghost@example.com"] });
    expect(r.calendars.primary!.busy).toEqual([{ start: new Date(T0).toISOString(), end: new Date(T0 + 3 * 3600_000).toISOString() }]);
    expect(r.calendars[BOB]!.busy).toHaveLength(1);
    expect(r.calendars["ghost@example.com"]!.errors).toEqual([{ domain: "global", reason: "notFound" }]);
  });
});

describe("error classes", () => {
  it("classifies a disabled Calendar API, with Google's enable link", async () => {
    fake.disableApi("calendar", true);
    const err = await rejection(cal.listCalendars());
    expect(classifyCalendarError(err)).toBe("api_disabled");
    expect(activationUrl(err!)).toMatch(/calendar-json\.googleapis\.com/);
  });

  it("classifies missing calendar scopes (granular consent)", async () => {
    const other = await connectFakeAccount(ctx, fake, BOB, { scopes: [...MAIL, CALENDAR_SCOPES[0]!] });
    const client = ctx.google.calendar(other.id);
    expect(classifyCalendarError(await rejection(client.listCalendars()))).toBe("scope_missing");
    expect(classifyCalendarError(await rejection(client.freeBusy({ timeMin: new Date(T0).toISOString(), timeMax: new Date(T0 + 1).toISOString(), items: [BOB] })))).toBe(
      "scope_missing",
    );
    await expect(client.listEvents(BOB, {})).resolves.toMatchObject({ items: [] });
  });
});
