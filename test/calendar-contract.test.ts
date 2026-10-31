// The Google Calendar contract (docs/calendar.md): migration 7 on existing data, grant fields, event
// visibility, the event store and the pure helpers every workstream builds on.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CalendarEventSummary } from "../shared/types.ts";
import { summarizeEvent, isInvitation } from "../server/calendar/summary.ts";
import { Db } from "../server/db/index.ts";
import { MIGRATIONS } from "../server/db/schema.ts";
import { type AccountRow, toAccount } from "../server/google/accounts.ts";
import { classifyCalendarError } from "../server/google/calendar.ts";
import { googleErrorFromBody } from "../server/google/http.ts";
import { CALENDAR_SCOPES } from "../server/google/scopes.ts";
import { GoogleApiError } from "../server/google/types.ts";
import { attendeeImpact } from "../server/policy/calendar.ts";
import { type GrantRow, toGrant } from "../server/policy/grants.ts";
import { testContext } from "./helpers.ts";
import { grantInput, mailTestContext } from "./mail-fakes.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const T = "2026-01-01T00:00:00.000Z";
const GMAIL = "https://www.googleapis.com/auth/gmail.modify";
const PUBSUB = "https://www.googleapis.com/auth/pubsub";

/** A database as the last pre-calendar release left it (migrations 1–6), with live mail data in it. */
function preCalendarDb(dir: string, withAccounts = true): string {
  const path = join(dir, "db.sqlite");
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  MIGRATIONS.slice(0, 6).forEach((sql, i) => {
    raw.exec(sql);
    raw.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(i + 1, T);
  });
  if (withAccounts) {
    const account = raw.prepare(
      `INSERT INTO accounts (id, email, status, refresh_token_enc, access_token_enc, access_expires_at, scopes, history_id, watch_expires_at, created_at)
       VALUES (?, ?, 'active', ?, 'at', ?, ?, '12345', ?, ?)`,
    );
    account.run("acc_1", "wynn@example.com", "rt1", T, JSON.stringify([GMAIL, PUBSUB, "openid"]), T, T);
    account.run("acc_2", "ops@example.com", "rt2", T, JSON.stringify([GMAIL, "openid"]), T, T);
    raw.prepare("INSERT INTO agents (id, name, key_prefix, key_hash, created_at, origin) VALUES ('agt_hermes', 'Hermes', 'aib_x', 'h', ?, 'paired')").run(T);
    raw
      .prepare(
        `INSERT INTO grants (id, agent_id, account_id, capabilities, label_scope, send_mode, allow_to, reply_only, max_sends_per_hour, created_at)
         VALUES ('grt_1', 'agt_hermes', 'acc_1', '["read","send"]', '["INBOX"]', 'approval', '["*@example.com"]', 1, 5, ?)`,
      )
      .run(T);
    raw
      .prepare(
        `INSERT INTO approvals (id, agent_id, account_id, kind, status, draft_id, payload, created_at, expires_at)
         VALUES ('apr_1', 'agt_hermes', 'acc_1', 'send', 'pending', 'r-123', ?, ?, '2099-01-01T00:00:00.000Z')`,
      )
      .run(JSON.stringify({ to: [{ name: null, email: "a@example.com" }], cc: [], bcc: [], subject: "Hi", body: "Hello", threadId: null, attachments: [], reason: null }), T);
    raw
      .prepare(
        `INSERT INTO events (id, type, account_id, gmail_message_id, label_ids, message, dedupe_key, created_at)
         VALUES ('evt_1', 'message.received', 'acc_1', 'm1', '["INBOX"]', '{"id":"m1"}', 'acc_1:m1:message.received', ?)`,
      )
      .run(T);
  }
  raw.close();
  return path;
}

describe("migration 7 (Google Calendar)", () => {
  it("keeps accounts, grants and events intact; later migrations turn grants into full or read and drop approvals", () => {
    const dir = mkdtempSync(join(tmpdir(), "xaq-mig-"));
    try {
      const db = new Db(preCalendarDb(dir));
      expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM _migrations")!.v).toBe(MIGRATIONS.length);

      const accounts = db.all<AccountRow>("SELECT * FROM accounts ORDER BY id");
      expect(accounts.map((a) => [a.id, a.status, a.refresh_token_enc, a.history_id, a.watch_expires_at])).toEqual([
        ["acc_1", "active", "rt1", "12345", T],
        ["acc_2", "active", "rt2", "12345", T],
      ]);
      const a1 = toAccount(accounts[0]!);
      expect(a1.grantedScopes).toEqual([GMAIL, PUBSUB, "openid"]);
      expect(a1.calendar).toBeNull(); // mail-only account: the console shows nothing calendar-related

      const grant = toGrant(db.get<GrantRow>("SELECT * FROM grants WHERE id = 'grt_1'")!);
      expect(grant).toMatchObject({
        level: "full",
        allowTo: ["*@example.com"],
      });

      expect(db.get("SELECT name FROM sqlite_master WHERE name IN ('approvals', 'approval_rules')")).toBeUndefined();
      expect(db.get<{ calendar_event: string | null; message: string }>("SELECT calendar_event, message FROM events WHERE id = 'evt_1'")).toEqual({
        calendar_event: null,
        message: '{"id":"m1"}',
      });

      // Existing installs add Calendar explicitly ("Add Google Calendar"); scopes don't change by themselves.
      expect(JSON.parse(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'calendar.setup'")!.value)).toEqual({ enabled: false });
      db.close();

      // Reopening doesn't run it again.
      const again = new Db(join(dir, "db.sqlite"));
      expect(again.get<{ n: number }>("SELECT COUNT(*) AS n FROM _migrations WHERE version = 7")!.n).toBe(1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves Calendar on by default for an install without accounts", () => {
    const dir = mkdtempSync(join(tmpdir(), "xaq-mig-"));
    try {
      const db = new Db(preCalendarDb(dir, false));
      expect(db.get("SELECT 1 FROM settings WHERE key = 'calendar.setup'")).toBeUndefined();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Account.calendar", () => {
  const row = (scopes: string[], patch: Partial<AccountRow> = {}): AccountRow => ({
    id: "acc_1",
    email: "me@example.com",
    display_name: null,
    status: "active",
    last_error: null,
    refresh_token_enc: "x",
    access_token_enc: null,
    access_expires_at: null,
    scopes: JSON.stringify(scopes),
    history_id: null,
    watch_expires_at: null,
    last_sync_at: null,
    created_at: T,
    refresh_expires_at: null,
    refresh_expiry_kind: null,
    workspace_domain: null,
    calendar_status: null,
    calendar_error: null,
    calendar_synced_at: null,
    ...patch,
  });

  it("derives the status from the granted scopes and recorded problems", () => {
    expect(toAccount(row([GMAIL])).calendar).toBeNull();
    expect(toAccount(row([GMAIL, CALENDAR_SCOPES[0]!])).calendar).toEqual({
      status: "not_granted",
      missingScopes: CALENDAR_SCOPES.slice(1),
      lastSyncAt: null,
      error: null,
    });
    expect(toAccount(row([GMAIL, ...CALENDAR_SCOPES])).calendar?.status).toBe("active");
    const disabled = toAccount(row([GMAIL, ...CALENDAR_SCOPES], { calendar_status: "api_disabled", calendar_error: "off" })).calendar;
    expect(disabled).toMatchObject({ status: "api_disabled", error: "off" });
  });
});

const calEvent = (calendarId: string, patch: Partial<CalendarEventSummary> = {}): CalendarEventSummary => ({
  ...summarizeEvent({ id: "ev1", summary: "Standup", start: { dateTime: "2026-10-20T09:00:00Z" }, end: { dateTime: "2026-10-20T09:15:00Z" } }, calendarId),
  ...patch,
});

describe("calendar event visibility", () => {
  it("every event of the account is visible to any grant on it", () => {
    const t = mailTestContext();
    dispose = t.dispose;
    t.addAccount("acc_a", "me@acme.com");
    const reader = t.addAgent("reader", [grantInput("acc_a")]).agent.id;
    const none = t.addAgent("none", []).agent.id;
    const see = (agentId: string, type: Parameters<typeof t.ctx.policy.canSeeEvent>[1]["type"]) => t.ctx.policy.canSeeEvent(agentId, { accountId: "acc_a", type });
    expect([see(reader, "calendar.event_created"), see(reader, "message.received"), see(reader, "account.auth_failed")]).toEqual([true, true, true]);
    expect(see(none, "calendar.event_created")).toBe(false);
  });

  it("stores calendarEvent with the event and leaves mail payloads unchanged", () => {
    const t = testContext();
    dispose = t.dispose;
    const ev = t.ctx.events.emit({
      type: "calendar.event_updated",
      accountId: "acc_1",
      calendarEvent: calEvent("me@acme.com"),
      detail: { changes: ["time"] },
      dedupeKey: "acc_1:me@acme.com:ev1:calendar.event_updated:1",
    });
    expect(ev?.calendarEvent?.summary).toBe("Standup");
    expect(t.ctx.events.get(ev!.id)).toMatchObject({ message: null, calendarEvent: { id: "ev1", calendarId: "me@acme.com" }, detail: { changes: ["time"] } });
    const mail = t.ctx.events.emit({ type: "sync.gap", accountId: "acc_1", dedupeKey: "gap" });
    expect(mail && "calendarEvent" in mail).toBe(false);
  });
});

describe("calendar helpers", () => {
  it("summarizes events with cleaned text and spots invitations", () => {
    const raw = {
      id: "e1",
      status: "confirmed" as const,
      summary: "Sync​  with\nBob",
      start: { date: "2026-10-20" },
      end: { date: "2026-10-21" },
      organizer: { email: "Bob@Other.com", displayName: "Bob" },
      attendees: [
        { email: "me@acme.com", self: true, responseStatus: "needsAction" as const },
        { email: "bob@other.com", organizer: true, responseStatus: "accepted" as const },
      ],
      conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc" }] },
    };
    const s = summarizeEvent(raw, "me@acme.com");
    expect(s).toMatchObject({ summary: "Sync with Bob", allDay: true, start: "2026-10-20", selfResponse: "needsAction", organizerSelf: false, attendeeCount: 2 });
    expect(s.organizer).toEqual({ name: "Bob", email: "bob@other.com" });
    expect(s.conferenceUrl).toBe("https://meet.google.com/abc");
    expect(isInvitation(raw)).toBe(true);
    expect(isInvitation({ ...raw, organizer: { email: "me@acme.com", self: true } })).toBe(false);
    expect(summarizeEvent({ id: "gone", status: "cancelled" }, "c").status).toBe("cancelled");
  });

  it("classifies Calendar API errors", () => {
    const disabled = googleErrorFromBody(403, {
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "Google Calendar API has not been used in project 1 before or it is disabled.",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", metadata: { activationUrl: "https://x" } }],
      },
    }, "x");
    const scope = googleErrorFromBody(403, {
      error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes.", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] },
    }, "x");
    const legacy = googleErrorFromBody(403, { error: { code: 403, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } }, "x");
    expect([disabled, scope, legacy, new GoogleApiError(410, "gone", "fullSyncRequired"), new GoogleApiError(403, "rate", "rateLimitExceeded")].map(classifyCalendarError)).toEqual([
      "api_disabled",
      "scope_missing",
      "scope_missing",
      "sync_token_expired",
      "other",
    ]);
  });

  it("works out who a write emails and who allowTo must cover", () => {
    const base = { selfEmail: "me@acme.com", notify: true };
    expect(attendeeImpact({ ...base, kind: "create", before: [], after: ["A@x.com", "me@acme.com", "room@resource.calendar.google.com"] })).toEqual({
      emailed: ["a@x.com"],
      checked: ["a@x.com"],
    });
    expect(attendeeImpact({ ...base, kind: "update", before: ["a@x.com", "b@x.com"], after: ["a@x.com", "c@x.com"] }).emailed).toEqual(["a@x.com", "c@x.com", "b@x.com"]);
    // Without notify nobody is emailed, but everyone who can see the event still has to pass allowTo.
    expect(attendeeImpact({ ...base, notify: false, kind: "update", before: ["a@x.com"], after: ["a@x.com", "c@x.com"] })).toEqual({ emailed: [], checked: ["a@x.com", "c@x.com"] });
    expect(attendeeImpact({ ...base, kind: "delete", before: ["a@x.com"], after: [], organizerSelf: false }).emailed).toEqual([]);
  });
});
