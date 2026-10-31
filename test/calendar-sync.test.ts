// Calendar sync (server/calendar/sync.ts, state.ts) against the fake Calendar API: baseline, the four
// calendar.* events (each once), 410 resync diffs, which accounts and calendars sync, account status,
// pruning, and that mail-only installs never call the Calendar API.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Capability, GrantInput } from "../shared/types.ts";
import { summarizeEvent } from "../server/calendar/summary.ts";
import { createCalendarSync, MAX_POLL_BACKOFF_MS, pollBackoffMs } from "../server/calendar/sync.ts";
import { endsAt, syncRows } from "../server/calendar/state.ts";
import type { AppContext } from "../server/context.ts";
import { CALENDAR_SCOPES, GMAIL_SCOPE } from "../shared/google-scopes.ts";
import { runMaintenance } from "../server/maintenance.ts";
import { connectFakeAccount, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

const ME = "me@example.com";
const BOB = "bob@example.com";
const MAIL = [GMAIL_SCOPE, "openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"];
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => ({ dateTime: new Date(ms).toISOString() });
/** An event `hours` from now (negative: in the past), an hour long. */
const slot = (hours: number) => ({ start: at(Date.now() + hours * HOUR), end: at(Date.now() + (hours + 1) * HOUR) });
const OLD = "2024-01-01T00:00:00.000Z";

let fake: FakeGoogle;
let ctx: AppContext;
let rec: ReturnType<typeof recordingEvents>;
let dispose: (() => Promise<void>) | undefined;
let accountId: string;
let agentId: string;

const grant = (account: string, capabilities: Capability[], patch: Partial<GrantInput> = {}): GrantInput => ({
  accountId: account,
  capabilities,
  labelScope: null,
  sendMode: "draft_only",
  allowTo: [],
  replyOnly: false,
  maxSendsPerHour: null,
  maxSendsPerDay: null,
  ...patch,
});

async function setup(opts: { scopes?: string[]; capabilities?: Capability[]; events?: "recording" | "real" } = {}) {
  fake = await startFakeGoogle();
  rec = recordingEvents();
  const t = testContext(opts.events === "real" ? {} : { events: rec.factory }, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
  fake.addAccount(BOB, { name: "Bob" });
  accountId = (await connectFakeAccount(ctx, fake, ME, { name: "Me", scopes: opts.scopes ?? [...MAIL, ...CALENDAR_SCOPES] })).id;
  agentId = ctx.policy.createAgent({ name: "Hermes", grants: [grant(accountId, opts.capabilities ?? ["read", "calendar.read"])] }).agent.id;
  markCalls();
}

const sync = () => ctx.calendar.syncAccount(accountId);
const allCalendarCalls = () => fake.requests.filter((r) => r.path.startsWith("/calendar/")).length;
/** Calendar requests since the last connect (connecting may probe the calendar list: workstream D). */
let callMark = 0;
const markCalls = () => (callMark = allCalendarCalls());
const calendarCalls = () => allCalendarCalls() - callMark;
const types = () => rec.events.map((e) => e.type);
const account = () => ctx.accounts.require(accountId);

const eventsPath = (calendarId: string) => `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
const listings = (calendarId: string) => fake.requests.filter((r) => r.method === "GET" && r.path === eventsPath(calendarId)).length;

/** Copies of the sync tables, to put back as if the process had died right after emitting. */
function snapshot() {
  const tables = ["calendar_sync", "calendar_event_state"];
  const rows = tables.map((t) => ctx.db.all<Record<string, string | number | null>>(`SELECT * FROM ${t}`));
  return () =>
    tables.forEach((t, i) => {
      ctx.db.run(`DELETE FROM ${t}`);
      for (const r of rows[i]!) {
        const keys = Object.keys(r);
        ctx.db.run(`INSERT INTO ${t} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...Object.values(r));
      }
    });
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(async () => {
  await dispose?.();
  await fake?.close();
  dispose = undefined;
});

describe("events", () => {
  beforeEach(() => setup());

  it("takes a baseline that emits nothing and keeps upcoming and recurring events", async () => {
    const upcoming = fake.calendar.putEvent(ME, ME, { summary: "Planning", ...slot(2) });
    fake.calendar.putEvent(ME, ME, { summary: "Last week", ...slot(-7 * 24) });
    const series = fake.calendar.putEvent(ME, ME, { summary: "Standup", ...slot(-30 * 24), recurrence: ["RRULE:FREQ=DAILY"] });
    await sync();
    expect(rec.events).toEqual([]);
    const states = ctx.db.all<{ event_id: string; ends_at: string | null }>("SELECT event_id, ends_at FROM calendar_event_state ORDER BY event_id");
    expect(states.map((s) => s.event_id).sort()).toEqual([upcoming.id, series.id].sort());
    expect(states.find((s) => s.event_id === series.id)!.ends_at).toBeNull();
    expect(syncRows(ctx.db, accountId)).toMatchObject([{ calendar_id: ME, is_primary: 1, name: ME }]);
    expect(syncRows(ctx.db, accountId)[0]!.sync_token).toBeTruthy();
    await sync();
    expect(rec.events).toEqual([]);
  });

  it("emits created, updated (with what changed), cancelled and invitations, each once", async () => {
    const known = fake.calendar.putEvent(ME, ME, { summary: "Planning", location: "Room 1", ...slot(2) });
    await sync();

    const created = fake.calendar.putEvent(ME, ME, { summary: "Dentist", ...slot(30) });
    fake.calendar.putEvent(ME, ME, { id: known.id, summary: "Planning v2", location: "Room 2" });
    const invite = fake.calendar.invite(BOB, [ME], { summary: "Bob's review", ...slot(5) });
    await sync();
    await sync();
    expect(types().sort()).toEqual(["calendar.event_created", "calendar.event_updated", "calendar.invitation_received"]);
    const [c, u, i] = (["calendar.event_created", "calendar.event_updated", "calendar.invitation_received"] as const).map((t) => rec.ofType(t)[0]);
    expect(c!.calendarEvent).toMatchObject({ id: created.id, calendarId: ME, summary: "Dentist", organizerSelf: true });
    expect(c!.dedupeKey).toBe(`${accountId}:${ME}:${created.id}:calendar.event_created:${created.created}`);
    expect(c!.message).toBeNull();
    expect(u!.detail).toEqual({ changes: ["summary", "location"] });
    expect(i!.calendarEvent).toMatchObject({ id: invite.id, selfResponse: "needsAction", organizer: { email: BOB, name: "Bob" } });
    expect(i!.dedupeKey).toBe(`${accountId}:${ME}:${invite.id}:invitation`);

    // Answering is an update of the responses; Bob moving it is a time change; cancelling reports the last version.
    fake.calendar.respond(ME, invite.id, "accepted");
    await sync();
    expect(rec.events.at(-1)).toMatchObject({ type: "calendar.event_updated", detail: { changes: ["responses"] } });
    await ctx.google.calendar(accountId).patchEvent(ME, created.id, { start: slot(31).start, end: slot(31).end }, { sendUpdates: "none" });
    await sync();
    expect(rec.events.at(-1)).toMatchObject({ type: "calendar.event_updated", detail: { changes: ["time"] } });
    fake.calendar.cancelEvent(ME, ME, known.id);
    await sync();
    await sync();
    const cancelled = rec.ofType("calendar.event_cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.calendarEvent).toMatchObject({ id: known.id, status: "cancelled", summary: "Planning v2", location: "Room 2" });
    expect(cancelled[0]!.detail).toEqual({ wasOrganizer: true });
    expect(ctx.db.get("SELECT 1 FROM calendar_event_state WHERE event_id = ?", known.id)).toBeUndefined();
  });

  it("reports being added to a meeting created long ago as an invitation", async () => {
    await sync();
    const old = fake.calendar.invite(BOB, [ME], { summary: "Quarterly review", created: OLD, ...slot(48) });
    await sync();
    expect(types()).toEqual(["calendar.invitation_received"]);
    expect(rec.events[0]!.calendarEvent!.id).toBe(old.id);
  });

  it("reports an invitation when the account is added to an event it already knew", async () => {
    const shared = fake.calendar.addCalendar(ME, { name: "Team", accessRole: "writer" });
    const e = fake.calendar.putEvent(ME, shared, { summary: "Offsite", organizer: { email: BOB }, ...slot(72) });
    await sync();
    fake.calendar.putEvent(ME, shared, { id: e.id, attendees: [{ email: BOB, organizer: true, responseStatus: "accepted" }, { email: ME, self: true, responseStatus: "needsAction" }] });
    await sync();
    expect(types()).toEqual(["calendar.invitation_received"]);
    expect(rec.events[0]!.calendarEvent!.calendarId).toBe(shared);
  });

  it("treats unknown older events as updated (changes unknown) when upcoming, and ignores past ones", async () => {
    const rescheduled = fake.calendar.putEvent(ME, ME, { summary: "Moved", created: OLD, ...slot(-72) });
    const past = fake.calendar.putEvent(ME, ME, { summary: "Old notes", created: OLD, ...slot(-72) });
    await sync();
    fake.calendar.putEvent(ME, ME, { id: rescheduled.id, ...slot(24) });
    fake.calendar.putEvent(ME, ME, { id: past.id, summary: "Old notes (edited)" });
    // Deleting something never seen reports nothing either.
    fake.calendar.cancelEvent(ME, ME, past.id);
    await sync();
    expect(rec.events.map((e) => [e.type, e.calendarEvent!.id, e.detail])).toEqual([["calendar.event_updated", rescheduled.id, { changes: null }]]);
  });

  it("replays a 410 full resync as changes, then continues incrementally", async () => {
    const a = fake.calendar.putEvent(ME, ME, { summary: "A", ...slot(2) });
    const b = fake.calendar.putEvent(ME, ME, { summary: "B", ...slot(3) });
    const same = fake.calendar.putEvent(ME, ME, { summary: "Same", ...slot(4) });
    await sync();
    const before = syncRows(ctx.db, accountId)[0]!;

    fake.calendar.putEvent(ME, ME, { id: a.id, summary: "A2" });
    fake.calendar.cancelEvent(ME, ME, b.id);
    // Touched without a material change: not reported.
    fake.calendar.putEvent(ME, ME, { id: same.id, transparency: "transparent" });
    const c = fake.calendar.putEvent(ME, ME, { summary: "C", ...slot(6) });
    const d = fake.calendar.invite(BOB, [ME], { summary: "D", ...slot(7) });
    fake.calendar.expireSyncTokens(ME);
    await sync();
    expect(rec.events.map((e) => [e.type, e.calendarEvent!.id]).sort()).toEqual(
      [
        ["calendar.event_updated", a.id],
        ["calendar.event_cancelled", b.id],
        ["calendar.event_created", c.id],
        ["calendar.invitation_received", d.id],
      ].sort(),
    );
    expect(rec.ofType("calendar.event_updated")[0]!.detail).toEqual({ changes: ["summary"] });
    const after = syncRows(ctx.db, accountId)[0]!;
    expect(after.sync_token).not.toBe(before.sync_token);
    expect(after.baseline_at! >= before.baseline_at!).toBe(true);
    const n = rec.events.length;
    await sync();
    expect(rec.events).toHaveLength(n);
    expect(fake.requests.filter((r) => r.path === `/calendar/v3/calendars/${encodeURIComponent(ME)}/events`).length).toBeGreaterThan(3);
  });
});

describe("edge cases", () => {
  beforeEach(() => setup());

  it("reports a cancelled occurrence of a known series with the occurrence's id and times, once", async () => {
    const series = fake.calendar.putEvent(ME, ME, { summary: "Standup", ...slot(-50), recurrence: ["RRULE:FREQ=DAILY;COUNT=10"] });
    await sync();
    const client = ctx.google.calendar(accountId);
    const window = { singleEvents: true, orderBy: "startTime" as const, timeMin: new Date(Date.now() - 3 * DAY).toISOString(), timeMax: new Date(Date.now() + 3 * DAY).toISOString() };
    const occurrences = (await client.listEvents(ME, window)).items;
    const past = occurrences[0]!;
    const upcoming = occurrences.find((o) => Date.parse(o.start!.dateTime!) > Date.now())!;
    await client.deleteEvent(ME, past.id, { sendUpdates: "none" });
    await client.deleteEvent(ME, upcoming.id, { sendUpdates: "none" });
    await sync();
    await sync();
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({
      type: "calendar.event_cancelled",
      calendarEvent: { id: upcoming.id, recurringEventId: series.id, recurring: false, status: "cancelled", summary: "Standup", start: upcoming.start!.dateTime, end: upcoming.end!.dateTime },
      detail: { wasOrganizer: true },
    });
    // A full resync lists the cancelled occurrences again: already reported, not news.
    fake.calendar.expireSyncTokens(ME);
    await sync();
    expect(rec.events).toHaveLength(1);
  });

  it("reports a past event created after the last sync once, however often it is edited", async () => {
    await sync();
    const notes = fake.calendar.putEvent(ME, ME, { summary: "Notes", ...slot(-72) });
    await sync();
    for (const n of [1, 2, 3]) {
      fake.calendar.putEvent(ME, ME, { id: notes.id, summary: `Notes v${n}` });
      await sync();
    }
    expect(rec.events.map((e) => [e.type, e.calendarEvent!.summary])).toEqual([["calendar.event_created", "Notes"]]);
    // After a 410 the edited past event is history, not a new event.
    fake.calendar.putEvent(ME, ME, { id: notes.id, summary: "Notes v4" });
    fake.calendar.expireSyncTokens(ME);
    await sync();
    expect(rec.events).toHaveLength(1);
  });

  it("replays changes after a crash between emitting and saving the cursor without reporting them twice", async () => {
    const known = fake.calendar.putEvent(ME, ME, { summary: "Planning", ...slot(2) });
    const gone = fake.calendar.putEvent(ME, ME, { summary: "Gone", ...slot(3) });
    await sync();
    fake.calendar.putEvent(ME, ME, { summary: "New", ...slot(4) });
    fake.calendar.putEvent(ME, ME, { id: known.id, summary: "Planning v2" });
    fake.calendar.cancelEvent(ME, ME, gone.id);
    fake.calendar.invite(BOB, [ME], { summary: "Review", ...slot(5) });
    const crash = snapshot();
    await sync();
    expect(rec.events).toHaveLength(4);
    crash();
    await sync();
    expect(rec.events).toHaveLength(4);
  });

  it("follows an incremental sync across pages", async () => {
    await sync();
    const before = listings(ME);
    for (let i = 0; i < 1005; i++) fake.calendar.putEvent(ME, ME, { summary: `E${i}`, ...slot(1 + i / 100) });
    await sync();
    expect(listings(ME) - before).toBe(2);
    expect(rec.ofType("calendar.event_created")).toHaveLength(1005);
    await sync();
    expect(rec.events).toHaveLength(1005);
  });

  it("doesn't report events that ended before the resync window as deleted", async () => {
    const e = fake.calendar.putEvent(ME, ME, { summary: "Yesterday-ish", ...slot(2) });
    await sync();
    // Stored as ending three days ago (the state outlived its event, e.g. maintenance hasn't run).
    ctx.db.run("UPDATE calendar_event_state SET ends_at = ?", new Date(Date.now() - 3 * DAY).toISOString());
    fake.calendar.cancelEvent(ME, ME, e.id);
    fake.calendar.expireSyncTokens(ME);
    await sync();
    expect(rec.events).toEqual([]);
  });

  it("after a 410, reports a series missing from the listing only when Google says it was deleted", async () => {
    const finished = fake.calendar.putEvent(ME, ME, { summary: "Sprint standup", ...slot(1), recurrence: ["RRULE:FREQ=DAILY"] });
    const deleted = fake.calendar.putEvent(ME, ME, { summary: "Old 1:1", ...slot(2), recurrence: ["RRULE:FREQ=WEEKLY"] });
    await sync();
    // The sprint ended days ago (its last occurrence is outside the listed window); the 1:1 was deleted.
    fake.calendar.putEvent(ME, ME, { id: finished.id, ...slot(-5 * 24), recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] });
    fake.calendar.cancelEvent(ME, ME, deleted.id);
    fake.calendar.expireSyncTokens(ME);
    await sync();
    expect(rec.events.map((e) => [e.type, e.calendarEvent!.id])).toEqual([["calendar.event_cancelled", deleted.id]]);
    expect(fake.requests.some((r) => r.method === "GET" && r.path === `${eventsPath(ME)}/${finished.id}`)).toBe(true);
  });

  it("gives finite series an end, so their state is pruned", () => {
    const start = { dateTime: "2030-01-01T09:00:00Z" };
    const end = { dateTime: "2030-01-01T10:00:00Z" };
    expect(endsAt({ id: "a", start, end, recurrence: ["RRULE:FREQ=DAILY"] })).toBeNull();
    expect(endsAt({ id: "b", start, end, recurrence: ["RRULE:FREQ=DAILY;UNTIL=20300110"] })).toBe("2030-01-11T01:00:00.000Z");
    // COUNT occurrences span COUNT − 1 periods after the start.
    expect(endsAt({ id: "c", start, end, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"] })).toBe("2030-01-22T10:00:00.000Z");
    expect(endsAt({ id: "c2", start, end, recurrence: ["RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3"] })).toBe("2030-01-05T10:00:00.000Z");
    // Tue Jan 1 + MO,WE,FR × 4 → Jan 1, 2, 4, 7: the bound may be later, never earlier.
    const weekdays = Date.parse(endsAt({ id: "c3", start, end, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4"] })!);
    expect(weekdays).toBeGreaterThanOrEqual(Date.parse("2030-01-07T10:00:00Z"));
    // Rules that can skip ahead have no bound: BYMONTHDAY=31 from Jan 1 runs Jan 31, Mar 31, May 31.
    expect(endsAt({ id: "e", start, end, recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3"] })).toBeNull();
    const jan31 = { dateTime: "2030-01-31T09:00:00Z" };
    expect(endsAt({ id: "f", start: jan31, end: { dateTime: "2030-01-31T10:00:00Z" }, recurrence: ["RRULE:FREQ=MONTHLY;COUNT=3"] })).toBeNull();
    expect(endsAt({ id: "d", start, end })).toBe("2030-01-01T10:00:00.000Z");
  });
});

describe("what syncs", () => {
  it("syncs owner and writer calendars in the grants' calendar scope, not read-only subscriptions", async () => {
    await setup();
    const team = fake.calendar.addCalendar(ME, { name: "Team", accessRole: "writer" });
    const other = fake.calendar.addCalendar(ME, { name: "Side project" });
    fake.calendar.addCalendar(ME, { name: "Holidays", accessRole: "reader" });
    await sync();
    const rows = syncRows(ctx.db, accountId);
    expect(rows[0]!.calendar_id).toBe(ME);
    expect(rows.map((r) => r.calendar_id).sort()).toEqual([ME, team, other].sort());
    expect(rows.map((r) => r.name).sort()).toEqual([ME, "Side project", "Team"].sort());

    ctx.policy.upsertGrant(agentId, accountId, grant(accountId, ["calendar.read"], { calendarScope: [team] }));
    await sync();
    expect(syncRows(ctx.db, accountId).map((r) => r.calendar_id)).toEqual([team]);
    fake.calendar.putEvent(ME, other, { summary: "Not synced", ...slot(1) });
    fake.calendar.putEvent(ME, team, { summary: "Synced", ...slot(1) });
    await sync();
    expect(rec.events.map((e) => e.calendarEvent!.summary)).toEqual(["Synced"]);
    // Calendar ids in grants match whatever their case.
    ctx.policy.upsertGrant(agentId, accountId, grant(accountId, ["calendar.read"], { calendarScope: [other.toUpperCase()] }));
    await sync();
    expect(syncRows(ctx.db, accountId).map((r) => r.calendar_id)).toEqual([other]);
  });

  it("tells push about changes to the set of synced calendars", async () => {
    await setup();
    const changed: string[] = [];
    const sync2 = createCalendarSync(ctx, {
      onSyncSetChanged: (id) => {
        changed.push(id);
      },
    });
    await sync2.syncAccount(accountId);
    await sync2.syncAccount(accountId);
    expect(changed).toEqual([accountId]);
    fake.calendar.addCalendar(ME, { name: "Team" });
    await sync2.syncAccount(accountId);
    expect(changed).toEqual([accountId, accountId]);
  });

  it("survives a push hook that throws or rejects", async () => {
    await setup();
    const calls: string[] = [];
    const throwing = createCalendarSync(ctx, {
      onSyncSetChanged: (id) => {
        calls.push(id);
        throw new Error("push down");
      },
    });
    await throwing.syncAccount(accountId);
    fake.calendar.addCalendar(ME, { name: "Team" });
    const rejecting = createCalendarSync(ctx, {
      onSyncSetChanged: async (id) => {
        calls.push(id);
        throw new Error("push down");
      },
    });
    await rejecting.syncAccount(accountId);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([accountId, accountId]);
    expect(account().calendar!.status).toBe("active");
  });

  it("forgets an account's calendars once no grant reads them, stopping their push channels", async () => {
    await setup();
    await sync();
    const client = ctx.google.calendar(accountId);
    fake.calendar.autoNotify = false;
    const ch = await client.watchEvents(ME, { id: "chn_x", address: "https://inbox.example.com/google/calendar/push", token: "t" });
    ctx.db.run("UPDATE calendar_sync SET channel_id = ?, channel_resource_id = ?", ch.id, ch.resourceId);
    ctx.policy.upsertGrant(agentId, accountId, grant(accountId, ["read"]));
    await sync();
    expect(syncRows(ctx.db, accountId)).toEqual([]);
    expect(ctx.db.get("SELECT 1 FROM calendar_event_state")).toBeUndefined();
    expect(fake.calendar.channels()).toEqual([]);
    // Granted again later: a fresh baseline, so nothing that happened meanwhile floods the agent.
    fake.calendar.putEvent(ME, ME, { summary: "Meanwhile", ...slot(1) });
    ctx.policy.upsertGrant(agentId, accountId, grant(accountId, ["calendar.read"]));
    await sync();
    expect(rec.events).toEqual([]);
  });

  it("makes no Calendar calls without a calendar.read grant, for disabled agents, or without the scopes", async () => {
    await setup({ capabilities: ["read", "draft", "send", "calendar.write"] });
    await sync();
    expect(calendarCalls()).toBe(0);
    ctx.policy.upsertGrant(agentId, accountId, grant(accountId, ["calendar.read"]));
    ctx.policy.updateAgent(agentId, { disabled: true });
    await sync();
    expect(calendarCalls()).toBe(0);
    ctx.policy.updateAgent(agentId, { disabled: false });
    await sync();
    expect(calendarCalls()).toBeGreaterThan(0);

    const mailOnly = (await connectFakeAccount(ctx, fake, BOB, { scopes: MAIL })).id;
    markCalls();
    ctx.policy.upsertGrant(agentId, mailOnly, grant(mailOnly, ["read", "calendar.read"]));
    await ctx.calendar.syncAccount(mailOnly);
    expect(calendarCalls()).toBe(0);
  });

  it("skips paused and needs_reauth accounts", async () => {
    await setup();
    ctx.accounts.setStatus(accountId, "paused", null);
    await sync();
    ctx.accounts.setStatus(accountId, "needs_reauth", "reconnect");
    await sync();
    expect(calendarCalls()).toBe(0);
    expect(syncRows(ctx.db, accountId)).toEqual([]);
  });
});

describe("mail-only installs", () => {
  it("never call the Calendar API, while mail ingest runs as before", async () => {
    await setup({ scopes: MAIL, capabilities: ["read", "draft"], events: "real" });
    await ctx.calendar.start?.();
    ctx.calendar.kick();
    ctx.calendar.kick(accountId);
    await ctx.calendar.syncAccount(accountId);
    fake.deliver(ME, { from: "Ann <ann@example.org>", subject: "Hello", text: "Hi" });
    await (ctx.ingest as unknown as { sync(id: string): Promise<void> }).sync(accountId);
    expect(ctx.events.list({}).items.map((e) => e.type)).toEqual(["message.received"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(calendarCalls()).toBe(0);
    expect(account().calendar).toBeNull();
    expect(ctx.db.get("SELECT 1 FROM calendar_sync")).toBeUndefined();
  });
});

describe("account status", () => {
  beforeEach(() => setup());

  it("reflects a disabled API, other errors and recovery", async () => {
    fake.disableApi("calendar", true);
    await expect(sync()).rejects.toThrow(/Calendar API has not been used/);
    expect(account().calendar).toMatchObject({ status: "api_disabled", error: expect.stringMatching(/calendar-json/) });
    expect(ctx.settings.getState("calendar.setup")?.api?.state).toBe("disabled");

    fake.disableApi("calendar", false);
    await sync();
    expect(account().calendar).toMatchObject({ status: "active", error: null, lastSyncAt: expect.any(String) });
    expect(ctx.settings.getState("calendar.setup")?.api?.state).toBe("enabled");

    fake.failNext({ path: "/events", status: 400, message: "Bad things" });
    await expect(sync()).rejects.toThrow(/Bad things/);
    expect(account().calendar).toMatchObject({ status: "error", error: "Calendar sync failed: Bad things" });
    expect(syncRows(ctx.db, accountId)[0]!.last_error).toBe("Bad things");
    await sync();
    expect(account().calendar).toMatchObject({ status: "active", error: null });
  });

  it("re-reads the granted scopes after Google says they are missing", async () => {
    // The row claims the scopes, but the user unticked Calendar: Google's token lacks them.
    await dispose?.();
    await fake.close();
    await setup({ scopes: MAIL });
    ctx.db.run("UPDATE accounts SET scopes = ? WHERE id = ?", JSON.stringify([...MAIL, ...CALENDAR_SCOPES]), accountId);
    const refreshes = () => fake.requests.filter((r) => r.path === "/token").length;
    const before = refreshes();
    await expect(sync()).rejects.toThrow(/insufficient authentication scopes/);
    expect(refreshes()).toBe(before + 1);
    // The refresh backfilled the scopes: no calendar scope is left, so Account.calendar is null (not granted).
    expect(account().calendar?.status ?? "not_granted").toBe("not_granted");
  });
});

describe("service", () => {
  it("backs off a failing account exponentially without holding up the others", async () => {
    await setup();
    const bob = (await connectFakeAccount(ctx, fake, BOB, { scopes: [...MAIL, ...CALENDAR_SCOPES] })).id;
    ctx.policy.upsertGrant(agentId, bob, grant(bob, ["calendar.read"]));
    fake.failNext({ path: eventsPath(BOB), status: 429, retryAfter: 0, times: 100_000 });
    const loop = createCalendarSync(ctx, { timing: { pollMs: 40, tickMs: 5 } });
    loop.start?.();
    await new Promise((r) => setTimeout(r, 800));
    await loop.stop?.();
    // Each failing pass makes 5 attempts (429 is retried); passes at 0, 80, 240, 560 ms.
    const bobPasses = fake.requests.filter((r) => r.path === eventsPath(BOB)).length / 5;
    expect(bobPasses).toBeGreaterThanOrEqual(2);
    expect(bobPasses).toBeLessThanOrEqual(5);
    expect(listings(ME)).toBeGreaterThanOrEqual(8);
    expect(ctx.accounts.require(bob).calendar).toMatchObject({ status: "error" });
    expect(account().calendar).toMatchObject({ status: "active" });
  });

  it("re-reads the calendar list at once when a synced calendar is gone (404)", async () => {
    await setup();
    const team = fake.calendar.addCalendar(ME, { name: "Team" });
    await sync();
    fake.calendar.removeCalendar(ME, team);
    const lists = () => fake.requests.filter((r) => r.path === "/calendar/v3/users/me/calendarList").length;
    const before = lists();
    await ctx.calendar.start?.();
    ctx.calendar.kick(accountId, team);
    await waitFor(() => syncRows(ctx.db, accountId).length === 1);
    expect(lists()).toBeGreaterThan(before);
    expect(syncRows(ctx.db, accountId)[0]!.calendar_id).toBe(ME);
    expect(account().calendar).toMatchObject({ status: "active", error: null });
  });

  it("caps the backoff, and never polls faster than the interval", () => {
    expect([1, 2, 3].map((n) => pollBackoffMs(60_000, n))).toEqual([120_000, 240_000, 480_000]);
    expect(pollBackoffMs(60_000, 20)).toBe(MAX_POLL_BACKOFF_MS);
    expect(pollBackoffMs(3_600_000, 1)).toBe(3_600_000);
  });

  it("syncs on start and on kick", async () => {
    await setup();
    await ctx.calendar.start?.();
    await waitFor(() => !!syncRows(ctx.db, accountId)[0]?.baseline_at);
    fake.calendar.putEvent(ME, ME, { summary: "Kicked", ...slot(1) });
    ctx.calendar.kick(accountId, ME);
    await waitFor(() => rec.events.length === 1);
    expect(rec.events[0]!.calendarEvent!.summary).toBe("Kicked");
  });

  it("stores calendar events through the real events pipeline, visible to calendar.read only", async () => {
    await setup({ events: "real" });
    const mailOnly = ctx.policy.createAgent({ name: "Mail", grants: [grant(accountId, ["read"])] }).agent.id;
    await sync();
    fake.calendar.invite(BOB, [ME], { summary: "Sync", ...slot(3) });
    await sync();
    const [stored] = ctx.events.list({}).items;
    expect(stored).toMatchObject({ type: "calendar.invitation_received", message: null, calendarEvent: { summary: "Sync", calendarId: ME } });
    expect(ctx.events.feed(agentId).events.map((e) => e.type)).toEqual(["calendar.invitation_received"]);
    expect(ctx.events.feed(mailOnly).events).toEqual([]);
  });
});

describe("maintenance", () => {
  it("prunes state of events that ended over a day ago, keeping recurring series", async () => {
    await setup();
    const series = fake.calendar.putEvent(ME, ME, { summary: "Weekly", ...slot(1), recurrence: ["RRULE:FREQ=WEEKLY"] });
    const soon = fake.calendar.putEvent(ME, ME, { summary: "Soon", ...slot(1) });
    await sync();
    ctx.db.run("UPDATE calendar_event_state SET ends_at = ? WHERE event_id = ?", new Date(Date.now() - 2 * DAY).toISOString(), soon.id);
    runMaintenance(ctx);
    expect(ctx.db.all<{ event_id: string }>("SELECT event_id FROM calendar_event_state").map((r) => r.event_id)).toEqual([series.id]);
  });
});

describe("summaries", () => {
  it("keeps only https conference links and Google-hosted event links", () => {
    const base = { id: "e1", summary: "x" };
    const s = (extra: object) => summarizeEvent({ ...base, ...extra }, ME);
    expect(s({ hangoutLink: "https://meet.google.com/abc-defg-hij" }).conferenceUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(s({ conferenceData: { entryPoints: [{ entryPointType: "video", uri: "javascript:alert(1)" }] }, hangoutLink: "http://meet.example" }).conferenceUrl).toBeNull();
    expect(s({ conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://user:pw@zoom.example/j/1" }] } }).conferenceUrl).toBeNull();
    expect(s({ htmlLink: "https://www.google.com/calendar/event?eid=abc" }).htmlLink).toBe("https://www.google.com/calendar/event?eid=abc");
    expect(s({ htmlLink: "https://calendar.google.com.evil.example/event" }).htmlLink).toBeNull();
    expect(s({ htmlLink: "http://calendar.google.com/event" }).htmlLink).toBeNull();
  });
});
