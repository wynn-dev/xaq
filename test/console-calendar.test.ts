// The console's calendar and grant logic: grants in words, calendar event rows and calendar webhook filters.
import { describe, expect, it } from "vitest";
import type { CalendarEventSummary, Grant, MailEvent } from "../shared/types.ts";
import { PAIRING_DEFAULT } from "../src/components/approvals/pairing-grant.ts";
import { calendarEventLines, changesInWords, httpsUrl } from "../src/components/events/calendar-event.ts";
import { fmtEventWhen } from "../src/lib/format.ts";
import { DEFAULT_GRANT, grantInput, grantInWords, sameGrant, toGrantFields } from "../src/lib/grants.ts";
import { DENIAL_REASONS } from "../src/lib/labels.ts";
import { cleanFilter, describeWebhook } from "../src/lib/webhook-filter.ts";

const FMT = { timeZone: "UTC", locale: "en-US", now: Date.parse("2026-10-16T10:00:00Z") };
const ME = "ops@acme.dev";

const grant = (patch: Partial<Grant> = {}): Grant => ({
  id: "grt_1",
  agentId: "agt_1",
  accountId: "acc_1",
  level: "read",
  allowTo: [],
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

describe("grants", () => {
  it("new grants and pairings start read only, without an allowlist", () => {
    expect(DEFAULT_GRANT).toEqual({ level: "read", allowTo: [] });
    expect(PAIRING_DEFAULT).toEqual({ level: "read", allowTo: [] });
    expect(grantInput("acc_1", { level: "full", allowTo: ["*@acme.dev"] })).toEqual({ accountId: "acc_1", level: "full", allowTo: ["*@acme.dev"] });
  });

  it("compares allowlists as sets", () => {
    expect(sameGrant({ level: "full", allowTo: ["a@x.com", "b@x.com"] }, { level: "full", allowTo: ["b@x.com", "a@x.com"] })).toBe(true);
    expect(sameGrant({ level: "full", allowTo: [] }, { level: "read", allowTo: [] })).toBe(false);
    expect(toGrantFields(grant({ level: "full", allowTo: ["a@x.com"] }))).toEqual({ level: "full", allowTo: ["a@x.com"] });
  });

  it("says what the grant allows", () => {
    expect(grantInWords({ level: "read", allowTo: ["a@x.com"] })).toBe("Read only");
    expect(grantInWords({ level: "full", allowTo: [] })).toBe("Full access");
    expect(grantInWords({ level: "full", allowTo: ["a@x.com"] })).toBe("Full access, sends only to 1 allowed recipient");
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

describe("calendar webhook filters", () => {
  it("keeps calendarIds and describes calendar matching", () => {
    expect(cleanFilter({ calendarIds: [] })).toEqual({});
    expect(cleanFilter({ calendarIds: ["team"], from: ["*@vendor.com"] })).toEqual({ calendarIds: ["team"], from: ["*@vendor.com"] });
    const lines = describeWebhook(
      { eventTypes: ["calendar.invitation_received"], filter: { calendarIds: ["team"], from: ["*@vendor.com"], labelIds: ["Label_1"] }, includeBody: true },
      [],
      (id) => id,
      (id) => (id === "team" ? "Team" : id),
    );
    expect(lines).toEqual([
      "Sends invitation received events",
      "from every account the agent can read",
      "only for calendar events on Team",
      "where the organizer matches *@vendor.com",
      "including the cleaned event description",
    ]);
    const mixed = describeWebhook({ eventTypes: ["message.received", "calendar.event_created"], filter: { to: ["me@x.com"] }, includeBody: false }, []);
    expect(mixed).toContain("where a recipient (or guest) matches me@x.com");
  });
});

describe("denial reasons", () => {
  it("explains every calendar denial code", () => {
    for (const code of ["calendar_not_found", "calendar_not_granted", "calendar_api_disabled", "allow_to", "read_only", "no_access"]) expect(DENIAL_REASONS[code]).toBeTruthy();
  });
});
