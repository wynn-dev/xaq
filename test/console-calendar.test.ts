// The console's calendar logic (workstream F): grants always carry their calendar fields, presets keep
// calendar access, grant summaries in words, calendar approval rendering, calendar event rows and event
// visibility (which must agree with policy.canSeeEvent).
import { describe, expect, it } from "vitest";
import type { Approval, CalendarApprovalDetail, CalendarEventSummary, Grant, MailEvent } from "../shared/types.ts";
import { calendarInWords, grantInWords } from "../src/components/agents/grant-words.ts";
import { type CalendarApproval, calendarApprovalTexts, calendarApprovalView, isCalendarApproval } from "../src/components/approvals/calendar-approval.ts";
import { asksForMore, PAIRING_DEFAULT } from "../src/components/approvals/pairing-grant.ts";
import { calendarEventLines, changesInWords, grantSees, httpsUrl } from "../src/components/events/calendar-event.ts";
import { fmtEventWhen } from "../src/lib/format.ts";
import {
  calendarWriteChoice,
  DEFAULT_GRANT,
  GRANT_PRESETS,
  type GrantFields,
  grantInput,
  grantProblem,
  presetGrant,
  sameGrant,
  toGrantFields,
  withCalendarWriteChoice,
} from "../src/lib/grants.ts";
import { approvalStatusInfo, DENIAL_REASONS } from "../src/lib/labels.ts";

const FMT = { timeZone: "UTC", locale: "en-US", now: Date.parse("2026-10-16T10:00:00Z") };
const ME = "ops@acme.dev";

const grant = (patch: Partial<Grant> = {}): Grant => ({
  id: "grt_1",
  agentId: "agt_1",
  accountId: "acc_1",
  capabilities: ["read"],
  labelScope: null,
  sendMode: "draft_only",
  allowTo: [],
  replyOnly: false,
  maxSendsPerHour: null,
  maxSendsPerDay: null,
  calendarScope: null,
  calendarWriteMode: "approval",
  createdAt: "2026-10-01T00:00:00Z",
  ...patch,
});

const summary = (patch: Partial<CalendarEventSummary> = {}): CalendarEventSummary => ({
  id: "evt123",
  calendarId: ME,
  iCalUID: "evt123@google.com",
  recurringEventId: null,
  recurring: false,
  status: "confirmed",
  summary: "Quarterly review",
  location: "Room 4",
  start: "2026-10-20T14:00:00Z",
  end: "2026-10-20T15:00:00Z",
  allDay: false,
  timeZone: "Europe/Berlin",
  organizer: { name: "Dana Lee", email: "dana@vendor.com" },
  organizerSelf: false,
  attendees: [
    { email: "dana@vendor.com", name: "Dana Lee", responseStatus: "accepted", optional: false, organizer: true, self: false, resource: false },
    { email: ME, name: null, responseStatus: "needsAction", optional: false, organizer: false, self: true, resource: false },
    { email: "room4@resource.calendar.google.com", name: "Room 4", responseStatus: "accepted", optional: false, organizer: false, self: false, resource: true },
  ],
  attendeeCount: 3,
  selfResponse: "needsAction",
  conferenceUrl: null,
  htmlLink: "https://www.google.com/calendar/event?eid=abc",
  eventType: "default",
  created: "2026-10-10T09:00:00Z",
  updated: "2026-10-15T09:00:00Z",
  ...patch,
});

const approval = (kind: CalendarApproval["kind"], calendar: Partial<CalendarApprovalDetail>, patch: Partial<Approval> = {}): CalendarApproval => {
  const detail: CalendarApprovalDetail = {
    calendarId: ME,
    calendarName: "Ops",
    eventId: null,
    change: {},
    before: null,
    etag: null,
    response: null,
    notifyAttendees: true,
    notified: [],
    ...calendar,
  };
  return {
    id: "apr_1",
    agentId: "agt_1",
    agentName: "Hermes",
    accountId: "acc_1",
    accountEmail: ME,
    kind,
    status: "pending",
    calendar: detail,
    draftId: "",
    to: detail.notified.map((email) => ({ name: null, email })),
    cc: [],
    bcc: [],
    subject: detail.change.summary ?? detail.before?.summary ?? "",
    body: detail.change.description ?? "",
    threadId: null,
    attachments: [],
    reason: null,
    decidedAt: null,
    decisionNote: null,
    sentMessageId: null,
    error: null,
    createdAt: "2026-10-16T09:00:00Z",
    expiresAt: "2026-10-17T09:00:00Z",
    ...patch,
  } as CalendarApproval;
};

const event = (type: MailEvent["type"], patch: Partial<MailEvent> = {}): MailEvent => ({
  id: "evt_1",
  seq: 7,
  type,
  accountId: "acc_1",
  accountEmail: ME,
  message: null,
  createdAt: "2026-10-16T09:00:00Z",
  ...patch,
});

describe("grant serialization", () => {
  it("always sends the calendar fields explicitly, null scope included", () => {
    const bodies = [
      grantInput("acc_1", DEFAULT_GRANT),
      ...GRANT_PRESETS.map((p) => grantInput("acc_1", presetGrant(p))),
      grantInput("acc_1", PAIRING_DEFAULT),
      grantInput("acc_1", toGrantFields(grant({ calendarScope: ["team@group.calendar.google.com"], calendarWriteMode: "direct" }))),
    ];
    for (const body of bodies) {
      const sent = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
      expect(sent).toHaveProperty("calendarScope");
      expect(sent).toHaveProperty("calendarWriteMode");
      expect(sent.accountId).toBe("acc_1");
    }
    expect(grantInput("acc_1", DEFAULT_GRANT)).toMatchObject({ calendarScope: null, calendarWriteMode: "approval" });
    expect(toGrantFields(grant({ calendarScope: ["a"], calendarWriteMode: "direct" }))).toMatchObject({ calendarScope: ["a"], calendarWriteMode: "direct" });
  });

  it("new grants and pairings start without calendar access, writes set to ask first", () => {
    for (const g of [DEFAULT_GRANT, PAIRING_DEFAULT, ...GRANT_PRESETS.map((p) => presetGrant(p))]) {
      expect(g.capabilities.filter((c) => c.startsWith("calendar."))).toEqual([]);
      expect(g.calendarWriteMode).toBe("approval");
      expect(g.calendarScope).toBeNull();
    }
  });

  it("presets keep the calendar access of the grant being edited", () => {
    const from: GrantFields = { ...PAIRING_DEFAULT, capabilities: ["read", "calendar.read", "calendar.write"], calendarScope: ["team"], calendarWriteMode: "direct" };
    const full = presetGrant(GRANT_PRESETS.find((p) => p.id === "full")!, from);
    expect(full.capabilities).toEqual(["read", "draft", "send", "organize", "trash", "calendar.read", "calendar.write"]);
    expect(full).toMatchObject({ sendMode: "direct", calendarScope: ["team"], calendarWriteMode: "direct" });
    const read = presetGrant(GRANT_PRESETS.find((p) => p.id === "read")!, full);
    expect(read.capabilities).toEqual(["read", "calendar.read", "calendar.write"]);
    expect(read.calendarScope).toEqual(["team"]);
  });

  it("write mode None removes calendar.write and keeps the mode for later", () => {
    const g: GrantFields = { ...DEFAULT_GRANT, capabilities: ["read", "calendar.read"], calendarWriteMode: "direct" };
    expect(calendarWriteChoice(g)).toBe("none");
    const ask = { ...g, ...withCalendarWriteChoice(g, "approval") };
    expect(ask.capabilities).toEqual(["read", "calendar.read", "calendar.write"]);
    expect(calendarWriteChoice(ask)).toBe("approval");
    const none = { ...ask, ...withCalendarWriteChoice(ask, "none") };
    expect(none).toMatchObject({ capabilities: ["read", "calendar.read"], calendarWriteMode: "approval" });
    expect(calendarWriteChoice({ ...none, ...withCalendarWriteChoice(none, "direct") })).toBe("direct");
  });

  it("validates calendar scope only with calendar access, and compares scopes as sets", () => {
    const cal: GrantFields = { ...DEFAULT_GRANT, capabilities: ["calendar.read"] };
    expect(grantProblem(cal)).toBeNull();
    expect(grantProblem({ ...cal, calendarScope: [] })).toMatch(/at least one calendar/);
    expect(grantProblem({ ...DEFAULT_GRANT, calendarScope: [] })).toBeNull();
    expect(sameGrant({ ...cal, calendarScope: ["a", "b"] }, { ...cal, calendarScope: ["b", "a"] })).toBe(true);
    expect(sameGrant(cal, { ...cal, calendarWriteMode: "direct" })).toBe(false);
    expect(sameGrant(cal, { ...cal, calendarScope: [] })).toBe(false);
  });
});

describe("grants in words", () => {
  it("says what the calendar part allows", () => {
    expect(calendarInWords({ capabilities: ["read"] })).toBeNull();
    expect(calendarInWords({ capabilities: ["calendar.read"], calendarScope: null })).toBe("Can read every calendar; can't change events");
    expect(calendarInWords({ capabilities: ["calendar.read", "calendar.write"], calendarScope: ["a", "b"], calendarWriteMode: "approval" })).toBe(
      "Can read 2 calendars; writes need your approval",
    );
    expect(calendarInWords({ capabilities: ["calendar.read", "calendar.write"], calendarScope: ["a"], calendarWriteMode: "direct" })).toBe("Can read and change 1 calendar");
    // Write without read only creates: changing, deleting and answering need read too.
    expect(calendarInWords({ capabilities: ["calendar.write"], calendarScope: null, calendarWriteMode: "approval" })).toBe(
      "Can create events on every calendar once you approve; can't read or change existing ones",
    );
    expect(calendarInWords({ capabilities: ["calendar.write"], calendarScope: ["a", "b"], calendarWriteMode: "direct" })).toBe(
      "Can create events on 2 calendars; can't read or change existing ones",
    );
  });

  it("joins mail and calendar, and a calendar-only grant isn't 'No access'", () => {
    expect(grantInWords(grant({ capabilities: ["read", "draft", "send", "calendar.read", "calendar.write"], calendarScope: ["a", "b"] }))).toBe(
      "Can read and save drafts; can't send. Can read 2 calendars; writes need your approval",
    );
    expect(grantInWords(grant({ capabilities: ["calendar.read"] }))).toBe("Can read every calendar; can't change events");
    expect(grantInWords(grant({ capabilities: ["read"] }))).toBe("Can read; can't change or send anything");
  });
});

describe("pairing requests", () => {
  it("counts calendar capabilities and direct calendar writes as asking for more", () => {
    expect(asksForMore({ requested: { capabilities: ["read", "draft"] } })).toEqual([]);
    expect(asksForMore({ requested: { capabilities: ["read", "calendar.read"] } })).toEqual(["Calendar: read"]);
    expect(asksForMore({ requested: { capabilities: ["calendar.write"], calendarWriteMode: "direct" } })).toEqual(["Calendar: write", "Calendar writes: Direct"]);
    expect(asksForMore({ requested: { capabilities: ["calendar.write"], calendarWriteMode: "approval" } })).toEqual(["Calendar: write"]);
  });
});

describe("calendar approvals", () => {
  it("create: the full event, every guest, who gets emailed and the full description", () => {
    const a = approval("calendar.create", {
      change: {
        summary: "Kickoff",
        start: "2026-10-21T09:00:00Z",
        end: "2026-10-21T09:30:00Z",
        location: "https://evil.example/login",
        attendees: ["bob@acme.dev", "eve@other.com"],
        addConference: true,
        description: "Agenda\n\nPlease sign in at the link first.",
      },
      notified: ["bob@acme.dev", "eve@other.com"],
    });
    expect(isCalendarApproval(a)).toBe(true);
    const v = calendarApprovalView(a, FMT);
    expect(v.title).toBe("Kickoff");
    expect(v.calendar).toBe("Ops");
    expect(v.effects).toEqual([
      "Creates “Kickoff” on Ops, Wed, Oct 21, 9:00 – 9:30 AM.",
      "Adds a Google Meet link.",
      "Invites bob@acme.dev and eve@other.com.",
      "Google emails 2 people about it.",
    ]);
    expect(v.rows).toEqual([
      { label: "Title", before: null, after: "Kickoff", changed: true },
      { label: "When", before: null, after: "Wed, Oct 21, 9:00 – 9:30 AM", changed: true },
      { label: "Where", before: null, after: "https://evil.example/login", changed: true },
      { label: "Video call", before: null, after: "Yes", changed: true },
    ]);
    expect(v.description).toBe("Agenda\n\nPlease sign in at the link first.");
    expect(v.guests).toEqual(["bob@acme.dev", "eve@other.com"]);
    expect(v.emailed).toEqual(["bob@acme.dev", "eve@other.com"]);
    expect(calendarApprovalTexts(a)).toEqual(expect.arrayContaining(["https://evil.example/login", "Agenda\n\nPlease sign in at the link first.", "eve@other.com"]));
  });

  it("update: before and after for changed fields only, added and removed guests", () => {
    const before = summary({ organizerSelf: true, organizer: { name: null, email: ME }, attendees: summary().attendees.slice(0, 2) });
    const a = approval("calendar.update", {
      eventId: "evt123",
      before,
      etag: '"3"',
      change: { start: "2026-10-20T16:00:00Z", end: "2026-10-20T17:00:00Z", attendees: [ME, "carol@acme.dev"] },
      notified: ["carol@acme.dev", "dana@vendor.com"],
    });
    const v = calendarApprovalView(a, FMT);
    const when = v.rows.find((r) => r.label === "When")!;
    // The event's zone (Europe/Berlin, UTC+2 in October), labeled.
    expect(when).toEqual({ label: "When", before: "Tue, Oct 20, 4:00 – 5:00 PM (Europe/Berlin)", after: "Tue, Oct 20, 6:00 – 7:00 PM (Europe/Berlin)", changed: true });
    expect(v.rows.find((r) => r.label === "Where")).toEqual({ label: "Where", before: "Room 4", after: "Room 4", changed: false });
    expect(v.effects).toEqual([
      "Changes the time and the guests of “Quarterly review” on Ops.",
      "Invites carol@acme.dev.",
      "Removes dana@vendor.com from the guest list.",
      "Google emails 2 people about it.",
    ]);
    expect(v.guests).toEqual(["carol@acme.dev"]);
    expect(v.description).toBeNull();
  });

  it("date-times without an offset are wall-clock time in the change's time zone, labeled", () => {
    const a = approval("calendar.create", {
      change: { summary: "Sync", start: "2026-10-20T14:00:00", end: "2026-10-20T15:00:00", allDay: false, timeZone: "Asia/Tokyo" },
    });
    // The console's zone doesn't matter: 14:00 Tokyo is shown as 14:00 Tokyo (05:00 UTC, 07:00 Berlin).
    for (const timeZone of ["UTC", "Europe/Berlin", "America/Los_Angeles"]) {
      const v = calendarApprovalView(a, { ...FMT, timeZone });
      expect(v.rows.find((r) => r.label === "When")!.after).toBe("Tue, Oct 20, 2:00 – 3:00 PM (Asia/Tokyo)");
      expect(v.effects[0]).toBe("Creates “Sync” on Ops, Tue, Oct 20, 2:00 – 3:00 PM (Asia/Tokyo).");
    }
    // Just after New York leaves DST (Nov 1 2026, 02:00): 03:00 is EST (08:00 UTC), not EDT.
    const dst = approval("calendar.update", {
      before: summary(),
      change: { start: "2026-11-01T03:00:00", end: "2026-11-01T10:00:00", allDay: false, timeZone: "America/New_York" },
    });
    expect(calendarApprovalView(dst, FMT).rows.find((r) => r.label === "When")!.after).toBe("Sun, Nov 1, 3:00 – 10:00 AM (America/New_York)");
  });

  it("all-day dates show no zone and never shift", () => {
    const a = approval("calendar.update", {
      before: summary({ allDay: true, start: "2026-10-22", end: "2026-10-23", timeZone: "Pacific/Auckland" }),
      change: { start: "2026-10-23", end: "2026-10-25", allDay: true },
    });
    const when = calendarApprovalView(a, { ...FMT, timeZone: "America/Los_Angeles" }).rows.find((r) => r.label === "When")!;
    expect(when).toMatchObject({ before: "Thu, Oct 22 (all day)", after: "Oct 23 – 24 (all day)" });
  });

  it("notifications off: says nobody is emailed and that new guests still see the event", () => {
    const a = approval("calendar.update", { before: summary(), change: { attendees: ["dana@vendor.com", ME, "new@x.com"] }, notifyAttendees: false });
    expect(calendarApprovalView(a, FMT).effects).toEqual([
      "Changes the guests of “Quarterly review” on Ops.",
      "Invites new@x.com.",
      "New guests see the event on their calendars even without an email.",
      "Nobody is emailed: the agent turned notifications off.",
    ]);
  });

  it("delete: the event that goes, recurring series named, guests beyond Google's list counted", () => {
    const a = approval("calendar.delete", { before: summary({ recurring: true, attendeeCount: 60 }), eventId: "evt123", notified: ["dana@vendor.com"] });
    const v = calendarApprovalView(a, FMT);
    expect(v.effects[0]).toBe("Deletes “Quarterly review” from Ops, every occurrence of the series.");
    expect(v.rows.every((r) => r.changed && r.after === null)).toBe(true);
    expect(v.guests).toEqual(["dana@vendor.com"]);
    expect(v.moreGuests).toBe(57);
  });

  it("rsvp: the answer, the organizer and the comment", () => {
    const a = approval("calendar.rsvp", { before: summary(), eventId: "evt123", response: "declined", notified: ["dana@vendor.com"] }, { body: "Out that week, sorry." });
    const v = calendarApprovalView(a, FMT);
    expect(v.effects[0]).toBe("Answers “Declined” to “Quarterly review”, organized by Dana Lee.");
    expect(v.rows.find((r) => r.label === "Your answer")).toEqual({ label: "Your answer", before: "No answer yet", after: "Declined", changed: true });
    expect(v.comment).toBe("Out that week, sorry.");
  });

  it("calls an applied calendar approval applied, not sent", () => {
    expect(approvalStatusInfo("sent", "calendar.create").label).toBe("Applied");
    expect(approvalStatusInfo("failed", "calendar.update").label).toBe("Couldn't apply");
    expect(approvalStatusInfo("sent", "send").label).toBe("Sent");
    expect(isCalendarApproval({ ...approval("calendar.create", {}), kind: "send", calendar: undefined } as unknown as Approval)).toBe(false);
  });
});

describe("calendar event rows", () => {
  it("shows title, time, organizer and what changed", () => {
    expect(calendarEventLines(event("calendar.invitation_received", { calendarEvent: summary() }), FMT)).toEqual({
      title: "Quarterly review",
      when: "Tue, Oct 20, 2:00 – 3:00 PM",
      organizer: "organized by Dana Lee",
      note: "Room 4",
      needsAnswer: true,
    });
    const updated = calendarEventLines(event("calendar.event_updated", { calendarEvent: summary({ organizerSelf: true }), detail: { changes: ["time", "location"] } }), FMT)!;
    expect(updated).toMatchObject({ organizer: "you organize", note: "Changed: time and place", needsAnswer: false });
    expect(calendarEventLines(event("calendar.event_cancelled", { calendarEvent: summary(), detail: { wasOrganizer: false } }), FMT)!.note).toBe("Cancelled");
    expect(calendarEventLines(event("calendar.event_created", { calendarEvent: summary({ summary: "", allDay: true, start: "2026-10-22", end: "2026-10-23" }) }), FMT)).toMatchObject({
      title: "(no title)",
      when: "Thu, Oct 22 (all day)",
    });
    expect(calendarEventLines(event("calendar.invitation_received", { calendarEvent: summary({ selfResponse: "accepted" }) }), FMT)).toMatchObject({
      note: "Answered: Accepted",
      needsAnswer: false,
    });
    expect(calendarEventLines(event("message.received"))).toBeNull();
  });

  it("says 'you organize' for the account's own events, including a secondary calendar named as organizer", () => {
    const lines = (patch: Partial<CalendarEventSummary>) => calendarEventLines(event("calendar.event_created", { calendarEvent: summary(patch) }), FMT)!.organizer;
    const ROTA = "rota@group.calendar.google.com";
    expect(lines({ calendarId: ROTA, organizer: { name: "Support rota", email: ROTA }, organizerSelf: true })).toBe("you organize");
    expect(lines({ calendarId: ROTA, organizer: { name: "Support rota", email: ROTA }, organizerSelf: false })).toBe("you organize");
    expect(lines({ organizer: { name: null, email: "OPS@acme.dev" }, organizerSelf: false })).toBe("you organize");
    expect(lines({ organizer: { name: "Dana Lee", email: "dana@vendor.com" }, organizerSelf: false })).toBe("organized by Dana Lee");
    expect(lines({ organizer: null, organizerSelf: false })).toBeNull();
  });

  it("says when the earlier version wasn't seen", () => {
    expect(changesInWords({ changes: null })).toBe("Changed (xaq hadn't seen the earlier version)");
    expect(changesInWords({ changes: ["summary", "attendees", "responses"] })).toBe("Changed: title, guests and answers");
  });

  it("formats event times, all-day ends being exclusive", () => {
    expect(fmtEventWhen({ start: "2026-10-20", end: "2026-10-23", allDay: true }, FMT)).toBe("Oct 20 – 22 (all day)");
    expect(fmtEventWhen({ start: "2026-10-20T22:00:00Z", end: "2026-10-21T01:00:00Z", allDay: false }, FMT)).toBe("Tue, Oct 20, 10:00 PM – Wed, Oct 21, 1:00 AM");
    expect(fmtEventWhen({ start: "2027-01-05T09:00:00Z", end: "2027-01-05T09:00:00Z", allDay: false }, FMT)).toBe("Tue, Jan 5, 2027, 9:00 AM");
  });

  it("links only https URLs", () => {
    expect(httpsUrl("https://meet.google.com/abc-defg-hij")).toBe("https://meet.google.com/abc-defg-hij");
    for (const bad of ["http://meet.example.com", "javascript:alert(1)", "data:text/html,x", "zoom.us/j/1", "", null]) expect(httpsUrl(bad)).toBeNull();
  });
});

describe("event visibility mirrors policy.canSeeEvent", () => {
  const cal = event("calendar.event_created", { calendarEvent: summary({ calendarId: "team@group.calendar.google.com" }) });
  const mail = event("message.received", { threadLabelIds: ["Label_1"] });
  const account = event("account.auth_failed");
  const table: [string, Partial<Grant>, [boolean, boolean, boolean]][] = [
    // grant, then [calendar event, mail event, account event]
    ["mail read", { capabilities: ["read"] }, [false, true, true]],
    ["calendar read", { capabilities: ["calendar.read"] }, [true, false, true]],
    ["calendar write only", { capabilities: ["calendar.write"] }, [false, false, false]],
    ["calendar read, other calendar", { capabilities: ["calendar.read"], calendarScope: [ME] }, [false, false, true]],
    ["calendar read, in scope", { capabilities: ["read", "calendar.read"], calendarScope: ["team@group.calendar.google.com"] }, [true, true, true]],
    ["mail read, other label", { capabilities: ["read"], labelScope: ["Label_2"] }, [false, false, true]],
    ["other account", { accountId: "acc_2", capabilities: ["read", "calendar.read"] }, [false, false, false]],
  ];
  it.each(table)("%s", (_name, patch, expected) => {
    const g = grant(patch);
    expect([grantSees(g, cal), grantSees(g, mail), grantSees(g, account)]).toEqual(expected);
  });
  it("a calendar event without its calendar id is never visible", () => {
    expect(grantSees(grant({ capabilities: ["calendar.read"] }), event("calendar.event_created"))).toBe(false);
  });
});

describe("denial reasons", () => {
  it("explains every calendar denial code", () => {
    for (const code of ["calendar_scope", "calendar_not_granted", "calendar_api_disabled", "allow_to", "rate_limit", "capability"]) expect(DENIAL_REASONS[code]).toBeTruthy();
  });
});
