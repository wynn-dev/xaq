// Calendar approvals (workstream B): approving applies the stored change with
// If-Match, rejecting and expiring discard it, the grant is re-checked at approval, a retried create never
// duplicates the event, and malformed changes fail for good.

import { afterEach, describe, expect, it } from "vitest";
import type { Approval, CalendarApprovalDetail, GoogleApprovalKind, GrantInput } from "../shared/types.ts";
import type { CalendarWriteOutcome } from "../server/calendar/agent.ts";
import { GoogleApiError } from "../server/google/types.ts";
import { Approvals } from "../server/mail/approvals.ts";
import { HttpError } from "../server/util/errors.ts";
import { calendarTestContext, tool } from "./calendar-fakes.ts";
import { grantInput } from "./mail-fakes.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const ME = "me@acme.com";
const TEAM = "team@group.calendar.google.com";
const AT = { start: "2026-10-20T09:00:00Z", end: "2026-10-20T09:30:00Z" };

function setup(grant: Partial<GrantInput> = {}) {
  const t = calendarTestContext();
  dispose = t.dispose;
  const cal = t.addAccount("acc_a", ME);
  cal.addCalendar(TEAM, "Team");
  const base = { capabilities: ["send", "calendar.read", "calendar.write"] as GrantInput["capabilities"], calendarWriteMode: "approval" as const, ...grant };
  const { agent } = t.ctx.policy.createAgent({ name: "hermes", grants: [grantInput("acc_a", base)] });
  const approvals = new Approvals(t.ctx);
  /** Queues a write through AgentCalendar (approval mode) and returns the approval. */
  const queue = async (action: string, fn: Parameters<typeof tool<CalendarWriteOutcome>>[3]): Promise<Approval> => {
    const r = await tool(t.ctx, agent.id, action, fn);
    if (r.value?.status !== "pending_approval") throw new Error(`not queued: ${String(r.error ?? r.value?.status)}`);
    return approvals.get(r.value.approvalId)!;
  };
  const meeting = (patch: object = {}) =>
    cal.put(ME, {
      id: "m1",
      summary: "Plan",
      organizer: { email: ME, self: true },
      attendees: [{ email: ME, self: true }, { email: "ann@acme.com", responseStatus: "accepted" }],
      start: { dateTime: AT.start },
      end: { dateTime: AT.end },
      ...patch,
    });
  const regrant = (patch: Partial<GrantInput>) => t.ctx.policy.upsertGrant(agent.id, "acc_a", grantInput("acc_a", { ...base, ...patch }));
  t.kicks.length = 0;
  return { ...t, cal, agentId: agent.id, approvals, queue, meeting, regrant };
}

describe("approve", () => {
  it("applies a create with the id chosen when queued, and audits it", async () => {
    const s = setup();
    const a = await s.queue("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "Lunch", ...AT, attendees: ["ann@acme.com"] }, {}));
    expect(a.calendar!.eventId).toMatch(/^[0-9a-v]{26}$/);
    expect(s.cal.writes).toEqual([]);

    const done = await s.approvals.approve(a.id, "ok");
    expect(done).toMatchObject({ status: "sent", sentMessageId: a.calendar!.eventId, error: null });
    expect(s.cal.writes).toEqual([
      expect.objectContaining({ op: "insert", calendarId: ME, eventId: a.calendar!.eventId, opts: { sendUpdates: "all", conferenceDataVersion: 0 } }),
    ]);
    expect(s.cal.event(ME, a.calendar!.eventId!)?.summary).toBe("Lunch");
    expect(s.kicks).toEqual([["acc_a", ME]]);
    expect(s.ctx.audit.list({ action: "approval.approve" }).items[0]).toMatchObject({
      actorType: "admin",
      outcome: "ok",
      target: a.id,
      detail: { kind: "calendar.create", calendarId: ME, eventId: a.calendar!.eventId, emailed: true, notified: 1 },
    });
  });

  it("applies update, delete and RSVP with the stored notify setting", async () => {
    const s = setup();
    const ev = s.meeting();
    const upd = await s.queue("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { summary: "Plan v2" }, { notifyAttendees: false }));
    expect((await s.approvals.approve(upd.id)).status).toBe("sent");
    expect(s.cal.writes[0]).toMatchObject({ op: "patch", eventId: "m1", body: { summary: "Plan v2" }, opts: { sendUpdates: "none", ifMatchEtag: ev.etag } });

    const del = await s.queue("delete_calendar_event", (c) => c.deleteEvent(ME, undefined, "m1", {}));
    expect(await s.approvals.approve(del.id)).toMatchObject({ status: "sent", sentMessageId: "m1" });
    expect(s.cal.writes[1]).toMatchObject({ op: "delete", eventId: "m1", opts: { sendUpdates: "all", ifMatchEtag: del.calendar!.etag } });
    expect(s.cal.event(ME, "m1")?.status).toBe("cancelled");

    s.cal.put(ME, {
      id: "inv",
      summary: "Party",
      organizer: { email: "host@acme.com" },
      attendees: [{ email: "host@acme.com", organizer: true }, { email: ME, self: true, responseStatus: "needsAction" }],
      start: { dateTime: AT.start },
      end: { dateTime: AT.end },
    });
    const rsvp = await s.queue("respond_to_invitation", (c) => c.respond(ME, undefined, "inv", "accepted", { comment: "See you" }));
    expect(rsvp).toMatchObject({ kind: "calendar.rsvp", body: "See you", to: [{ email: "host@acme.com" }], calendar: { response: "accepted", comment: "See you" } });
    expect((await s.approvals.approve(rsvp.id)).status).toBe("sent");
    expect(s.cal.writes[2]).toMatchObject({ op: "patch", body: { attendees: [{ email: ME, responseStatus: "accepted", comment: "See you" }], attendeesOmitted: true } });
  });

  it("fails cleanly when the event changed in Google Calendar since it was queued", async () => {
    const s = setup();
    s.meeting();
    const a = await s.queue("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { summary: "Ours" }, {}));
    // A human edits the event in Google Calendar meanwhile (new etag).
    s.cal.put(ME, { ...s.cal.event(ME, "m1")!, summary: "Theirs" });
    const done = await s.approvals.approve(a.id);
    expect(done).toMatchObject({ status: "failed", error: "The event changed in Google Calendar since the change was prepared, so it was not applied." });
    expect(s.cal.writes).toEqual([]);
    expect(s.cal.event(ME, "m1")?.summary).toBe("Theirs");
    expect(s.ctx.audit.list({ action: "approval.approve" }).items[0]).toMatchObject({ outcome: "error", detail: { kind: "calendar.update", transient: false } });
    // Google's own 412 (a change between our read and the patch) fails the same way.
    const b = await s.queue("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { summary: "Ours" }, {}));
    s.cal.fail.patch = [new GoogleApiError(412, "Precondition Failed", "conditionNotMet")];
    expect(await s.approvals.approve(b.id)).toMatchObject({ status: "failed", error: expect.stringContaining("changed in Google Calendar") });
    // And a delete after a change: If-Match.
    const c = await s.queue("delete_calendar_event", (cal) => cal.deleteEvent(ME, undefined, "m1", {}));
    s.cal.put(ME, { ...s.cal.event(ME, "m1")!, location: "Room 2" });
    expect(await s.approvals.approve(c.id)).toMatchObject({ status: "failed", error: expect.stringContaining("changed in Google Calendar") });
    expect(s.cal.event(ME, "m1")?.status).toBe("confirmed");
  });

  it("fails when the event is gone", async () => {
    const s = setup();
    s.meeting();
    const a = await s.queue("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { summary: "x" }, {}));
    s.cal.calendars.get(ME)!.events.delete("m1");
    expect(await s.approvals.approve(a.id)).toMatchObject({ status: "failed", error: "The event no longer exists in Google Calendar." });
  });

  it("marks the attempt before calling Google", async () => {
    const s = setup();
    const a = await s.queue("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "Lunch", ...AT }, {}));
    expect(a.calendar!.attemptedAt).toBeUndefined();
    let marked: unknown;
    const insert = s.cal.insertEvent.bind(s.cal);
    s.cal.insertEvent = async (cal, ev, opts) => {
      marked = s.approvals.get(a.id)!.calendar!.attemptedAt;
      return insert(cal, ev, opts);
    };
    await s.approvals.approve(a.id);
    expect(marked).toEqual(expect.any(String));
  });

  it("a create whose answer was lost counts as applied when Google has it (timeouts included)", async () => {
    for (const lost of [new GoogleApiError(503, "Backend Error", "backendError"), new GoogleApiError(0, "Google didn't respond within 30s", "timeout")]) {
      const s = setup();
      const a = await s.queue("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "Once", ...AT, attendees: ["ann@acme.com"] }, {}));
      const insert = s.cal.insertEvent.bind(s.cal);
      s.cal.insertEvent = async (cal, ev, opts) => {
        await insert(cal, ev, opts);
        // Google created it and emailed Ann, but the answer never arrived.
        throw lost;
      };
      expect(await s.approvals.approve(a.id)).toMatchObject({ status: "sent", sentMessageId: a.calendar!.eventId });
      expect([...s.cal.calendars.get(ME)!.events.keys()]).toEqual([a.calendar!.eventId]);
      await s.dispose();
    }
    dispose = undefined;
  });

  it("a transient failure that didn't land goes back to pending, and the retry applies it once", async () => {
    const s = setup();
    const a = await s.queue("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "Once", ...AT }, {}));
    s.cal.fail.insert = [new GoogleApiError(0, "Could not reach Google", "network")];
    expect(await s.approvals.approve(a.id)).toMatchObject({ status: "pending", error: expect.stringContaining("Approve again to retry") });
    expect(await s.approvals.approve(a.id)).toMatchObject({ status: "sent" });
    expect(s.cal.calendars.get(ME)!.events.size).toBe(1);
  });

  it("an approval interrupted by a crash is recovered with calendar wording and applied once", async () => {
    const s = setup();
    const a = await s.queue("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "Once", ...AT }, {}));
    // The process died after marking the attempt and Google creating the event, before recording it.
    s.ctx.db.run(
      "UPDATE approvals SET status = 'approved', decided_at = '2000-01-01T00:00:00.000Z', payload = json_set(payload, '$.calendar.attemptedAt', '2000-01-01T00:00:00.000Z') WHERE id = ?",
      a.id,
    );
    s.cal.put(ME, { id: a.calendar!.eventId!, summary: "Once, renamed by a human since" });
    expect(s.approvals.recoverInterrupted()).toBe(1);
    expect(s.approvals.get(a.id)!.error).toBe(
      "Applying the change was interrupted before it finished. Approve again to retry: xaq checks Google Calendar first, so it is never applied twice.",
    );
    expect(await s.approvals.approve(a.id)).toMatchObject({ status: "sent" });
    expect(s.cal.calendars.get(ME)!.events.size).toBe(1);
  });

  it("an update whose answer was lost counts as applied when every field is in place", async () => {
    const s = setup();
    s.meeting();
    const a = await s.queue("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { summary: "Plan v2", ...{ start: "2026-10-20T10:00:00Z", end: "2026-10-20T10:30:00Z" } }, {}));
    const patch = s.cal.patchEvent.bind(s.cal);
    s.cal.patchEvent = async (...args) => {
      await patch(...args);
      // The workstream A client marks a retried If-Match write whose retry got 412.
      throw new GoogleApiError(503, "Backend Error", "outcome_unknown");
    };
    expect(await s.approvals.approve(a.id)).toMatchObject({ status: "sent", sentMessageId: "m1" });
  });

  it("after an earlier attempt, an event that moved on is 'may already have been applied', never 'not applied'", async () => {
    const s = setup();
    s.meeting();
    const a = await s.queue("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { summary: "Ours" }, {}));
    s.cal.fail.patch = [new GoogleApiError(503, "Backend Error", "backendError")];
    expect(await s.approvals.approve(a.id)).toMatchObject({ status: "pending" });
    // Unknown to us, it landed after all; then a human renamed the event.
    s.cal.put(ME, { ...s.cal.event(ME, "m1")!, summary: "Theirs" });
    const done = await s.approvals.approve(a.id);
    expect(done).toMatchObject({ status: "failed", error: "The change may already have been applied, but the event has changed in Google Calendar since, so xaq can't tell. Check Google Calendar." });
    expect(s.cal.writes).toEqual([]);
  });

  it("a retried delete that finds the event gone counts as applied", async () => {
    const s = setup();
    s.meeting();
    const a = await s.queue("delete_calendar_event", (c) => c.deleteEvent(ME, undefined, "m1", {}));
    const del = s.cal.deleteEvent.bind(s.cal);
    s.cal.deleteEvent = async (...args) => {
      await del(...args);
      // The client retried after a lost answer; the retry found it deleted.
      throw new GoogleApiError(410, "Resource has been deleted", "deleted");
    };
    expect(await s.approvals.approve(a.id)).toMatchObject({ status: "sent", sentMessageId: "m1" });
  });

  it("a needs_reauth answer from the calendar list is transient", async () => {
    const s = setup();
    const a = await s.queue("create_calendar_event", (c) => c.createEvent(ME, TEAM, { summary: "x", ...AT }, {}));
    s.ctx.calendar.calendars = async () => {
      throw new HttpError(409, "needs_reauth", "me@acme.com needs to be reconnected before xaq can read its calendars.", "Accounts → Reconnect.");
    };
    expect(await s.approvals.approve(a.id)).toMatchObject({ status: "pending" });
  });
});

describe("reject and expire", () => {
  it("discard the change without touching Google", async () => {
    const s = setup();
    s.meeting();
    const a = await s.queue("delete_calendar_event", (c) => c.deleteEvent(ME, undefined, "m1", {}));
    expect(await s.approvals.reject(a.id, "no")).toMatchObject({ status: "rejected", decisionNote: "no" });
    expect(s.ctx.audit.list({ action: "approval.reject" }).items[0]).toMatchObject({ detail: { kind: "calendar.delete" } });

    const b = await s.queue("delete_calendar_event", (c) => c.deleteEvent(ME, undefined, "m1", {}));
    s.ctx.db.run("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", b.id);
    expect(await s.approvals.expireOverdue()).toBe(1);
    expect(s.approvals.get(b.id)!.status).toBe("expired");
    await expect(s.approvals.approve(b.id)).rejects.toThrow(/already expired/);

    expect(s.cal.writes).toEqual([]);
    expect(s.cal.calls.filter((c) => c !== "get" && c !== "calendarList")).toEqual([]);
    expect(s.cal.event(ME, "m1")?.status).toBe("confirmed");
  });
});

describe("re-checks at approval", () => {
  const blocked = async (s: ReturnType<typeof setup>, a: Approval, why: RegExp) => {
    await expect(s.approvals.approve(a.id)).rejects.toThrow(why);
    expect(s.approvals.get(a.id)).toMatchObject({ status: "rejected", decisionNote: expect.stringMatching(/^cancelled: /) });
    expect(s.cal.writes).toEqual([]);
  };

  it("removing calendar.write cancels pending calendar approvals only", async () => {
    const s = setup();
    const cal = await s.queue("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "x", ...AT }, {}));
    const mail = s.approvals.create({
      agentId: s.agentId,
      accountId: "acc_a",
      kind: "send",
      draftId: "d1",
      payload: { to: [], cc: [], bcc: [], subject: "s", body: "b", threadId: null, attachments: [], reason: null },
    });
    s.regrant({ capabilities: ["send", "calendar.read"] });
    expect([s.approvals.get(cal.id)!.status, s.approvals.get(mail.id)!.status]).toEqual(["rejected", "pending"]);
    expect(s.approvals.get(cal.id)!.decisionNote).toBe("cancelled: the agent's calendar.write permission was removed");
  });

  it("a narrowed calendar scope blocks it", async () => {
    const s = setup();
    const a = await s.queue("create_calendar_event", (c) => c.createEvent(ME, TEAM, { summary: "x", ...AT }, {}));
    expect(a.calendar).toMatchObject({ calendarId: TEAM, calendarName: "Team" });
    s.regrant({ calendarScope: [ME] });
    await blocked(s, a, /can no longer be applied: the calendar is no longer in the agent's calendar scope/);
  });

  it("a narrowed allowlist blocks it, including people checked but not emailed", async () => {
    const s = setup();
    s.meeting({ attendees: [{ email: ME, self: true }, { email: "eve@evil.com" }] });
    const quiet = await s.queue("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { description: "notes" }, { notifyAttendees: false }));
    expect(quiet.calendar).toMatchObject({ notified: [], checked: ["eve@evil.com"] });
    s.regrant({ allowTo: ["*@acme.com"] });
    await blocked(s, quiet, /the agent may no longer involve eve@evil\.com/);
  });

  it("checks approvals stored without `checked` by recomputing it", async () => {
    const s = setup();
    s.meeting({ attendees: [{ email: ME, self: true }, { email: "eve@evil.com" }] });
    const a = await s.queue("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { description: "notes" }, { notifyAttendees: false }));
    s.ctx.db.run("UPDATE approvals SET payload = json_remove(payload, '$.calendar.checked') WHERE id = ?", a.id);
    s.regrant({ allowTo: ["*@acme.com"] });
    await blocked(s, a, /eve@evil\.com/);
  });

  it("replyOnly turned on blocks changes that add attendees", async () => {
    const s = setup();
    s.meeting();
    const add = await s.queue("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { attendees: ["ann@acme.com", "bob@acme.com"] }, {}));
    const edit = await s.queue("update_calendar_event", (c) => c.updateEvent(ME, undefined, "m1", { location: "Room 1" }, {}));
    s.regrant({ replyOnly: true });
    await blocked(s, add, /only reply on this account, not invite people/);
    expect((await s.approvals.approve(edit.id)).status).toBe("sent");
  });

  it("an RSVP comment is re-checked against who can see it now", async () => {
    const s = setup({ allowTo: ["*@acme.com"] });
    const invite = (patch: object = {}) =>
      s.cal.put(ME, {
        id: "inv",
        summary: "Offsite",
        organizer: { email: "boss@acme.com" },
        attendees: [{ email: "boss@acme.com", organizer: true }, { email: ME, self: true, responseStatus: "needsAction" }],
        start: { dateTime: AT.start },
        end: { dateTime: AT.end },
        ...patch,
      });
    invite();
    const added = await s.queue("respond_to_invitation", (c) => c.respond(ME, undefined, "inv", "accepted", { comment: "Q3 numbers" }));
    const hidden = await s.queue("respond_to_invitation", (c) => c.respond(ME, undefined, "inv", "accepted", { comment: "Q3 numbers" }));
    const bare = await s.queue("respond_to_invitation", (c) => c.respond(ME, undefined, "inv", "accepted", {}));
    // The organizer invites an outsider after the answer was queued.
    invite({ attendees: [{ email: "boss@acme.com", organizer: true }, { email: "eve@evil.com" }, { email: ME, self: true, responseStatus: "needsAction" }] });
    expect(await s.approvals.approve(added.id)).toMatchObject({ status: "failed", error: "The comment would now be shown to eve@evil.com, whom the agent may no longer contact." });
    invite({ guestsCanSeeOtherGuests: false });
    expect(await s.approvals.approve(hidden.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/^The organizer now hides the guest list/) });
    // A bare answer carries no text: still fine.
    expect((await s.approvals.approve(bare.id)).status).toBe("sent");
    expect(s.cal.writes).toHaveLength(1);
  });

  it("a disabled or deleted agent blocks it (the check shared with mail)", async () => {
    const s = setup();
    const a = await s.queue("create_calendar_event", (c) => c.createEvent(ME, undefined, { summary: "x", ...AT }, {}));
    // Disabling cancels pending approvals; re-open this one to approve it anyway.
    s.ctx.policy.updateAgent(s.agentId, { disabled: true });
    s.ctx.db.run("UPDATE approvals SET status = 'pending' WHERE id = ?", a.id);
    await expect(s.approvals.approve(a.id)).rejects.toThrow(/can no longer be applied: the agent is disabled\./);
  });

  it("under a null scope, a calendar dropped from the account's list fails it", async () => {
    const s = setup();
    const a = await s.queue("create_calendar_event", (c) => c.createEvent(ME, TEAM, { summary: "x", ...AT }, {}));
    s.cal.calendars.delete(TEAM);
    expect(await s.approvals.approve(a.id)).toMatchObject({ status: "failed", error: "The calendar is no longer in the account's calendar list." });
  });
});

describe("malformed changes", () => {
  const detail = (patch: Partial<CalendarApprovalDetail>): CalendarApprovalDetail => ({
    calendarId: ME,
    calendarName: null,
    eventId: "m1",
    change: {},
    before: null,
    etag: '"e1"',
    response: null,
    notifyAttendees: false,
    notified: [],
    checked: [],
    ...patch,
  });

  it("fail for good instead of going back to pending", async () => {
    const s = setup();
    s.meeting();
    const cases: [GoogleApprovalKind, CalendarApprovalDetail | undefined][] = [
      ["calendar.update", undefined],
      ["calendar.update", detail({ eventId: null })],
      ["calendar.delete", detail({ etag: null })],
      ["calendar.rsvp", detail({ response: null })],
      ["calendar.create", detail({ eventId: null })],
      ["calendar.delete", detail({ notified: "x" as unknown as string[] })],
    ];
    for (const [kind, calendar] of cases) {
      const a = s.approvals.create({
        agentId: s.agentId,
        accountId: "acc_a",
        kind,
        draftId: "",
        payload: { to: [], cc: [], bcc: [], subject: "", body: "", threadId: null, attachments: [], reason: null, ...(calendar ? { calendar } : {}) },
      });
      expect([kind, await s.approvals.approve(a.id)]).toEqual([kind, expect.objectContaining({ status: "failed", error: "This calendar request is incomplete and can't be applied." })]);
    }
    expect(s.cal.writes).toEqual([]);
  });
});
