// The console's "Add Google Calendar" decisions (src/components/google/calendar-flow.ts): where the dialog
// opens, what each account shows, how a per-account consent ended, and which notice Overview shows.
import { describe, expect, it } from "vitest";
import type { CalendarSetupState, SetupWarning } from "../shared/types.ts";
import { CALENDAR_SCOPES } from "../shared/google-scopes.ts";
import {
  accountCalendarView,
  accountsToAdd,
  calendarNotice,
  CONSENT_OUTCOME,
  consentDirectly,
  consentOutcome,
  scopeNames,
  startPage,
} from "../src/components/google/calendar-flow.ts";

const [EVENTS, LIST, FREEBUSY] = CALENDAR_SCOPES as [string, string, string];

const acct = (over: Partial<CalendarSetupState["accounts"][number]> = {}): CalendarSetupState["accounts"][number] => ({
  accountId: "acc_1",
  email: "wynn@example.com",
  status: "not_granted",
  missingScopes: [...CALENDAR_SCOPES],
  syncedCalendars: 0,
  ...over,
});

const warning = (code: SetupWarning["code"], over: Partial<SetupWarning> = {}): SetupWarning => ({
  code,
  severity: "warning",
  message: `${code} message`,
  hint: `${code} hint`,
  ...over,
});

describe("Add Google Calendar: where the dialog opens", () => {
  it("starts at the Calendar API until Calendar is on, and goes back there while Google says the API is off", () => {
    expect(startPage({ step: "off" })).toBe("api");
    expect(startPage({ step: "enable_api" })).toBe("api");
    expect(startPage({ step: "connect_accounts" })).toBe("accounts");
    expect(startPage({ step: "done" })).toBe("accounts");
  });

  it("sends a per-account Add Calendar straight to Google only once Calendar is on and the API isn't known to be off", () => {
    expect(consentDirectly(undefined)).toBe(false);
    expect(consentDirectly({ enabled: false, api: "enabled" })).toBe(false);
    expect(consentDirectly({ enabled: true, api: "disabled" })).toBe(false);
    expect(consentDirectly({ enabled: true, api: "unknown" })).toBe(true);
    expect(consentDirectly({ enabled: true, api: "enabled" })).toBe(true);
  });

  it("lists the accounts still to add, in order", () => {
    const accounts = [acct({ accountId: "a" }), acct({ accountId: "b", status: "active", missingScopes: [] }), acct({ accountId: "c", missingScopes: [LIST] })];
    expect(accountsToAdd({ accounts }).map((a) => a.accountId)).toEqual(["a", "c"]);
  });
});

describe("account Calendar badge", () => {
  it("says mail still works whenever Calendar doesn't", () => {
    for (const status of ["not_granted", "api_disabled", "error"] as const) {
      for (const enabled of [true, false]) expect(accountCalendarView(acct({ status }), enabled).description).toMatch(/Mail works as usual/);
    }
  });

  it("is a neutral Mail only before Calendar is added to the install, and a to-do after", () => {
    expect(accountCalendarView(acct(), false)).toMatchObject({ label: "Mail only", tone: "idle", fix: "consent" });
    expect(accountCalendarView(acct(), true)).toMatchObject({ label: "No Calendar yet", tone: "warn", fix: "consent" });
  });

  it("names the permissions an unticked box left out", () => {
    const v = accountCalendarView(acct({ missingScopes: [FREEBUSY] }), true);
    expect(v).toMatchObject({ label: "Calendar: partly allowed", fix: "consent" });
    expect(v.description).toContain("free/busy");
    expect(scopeNames([EVENTS, LIST, FREEBUSY])).toBe("events, calendar list and free/busy");
    expect(scopeNames([LIST])).toBe("calendar list");
  });

  it("points an API that's off at the enable step, and shows sync errors without a consent", () => {
    expect(accountCalendarView(acct({ status: "api_disabled" }), true)).toMatchObject({ tone: "bad", fix: "enable_api" });
    const err = accountCalendarView({ ...acct({ status: "error", missingScopes: [] }), error: "Google answered 500." }, true);
    expect(err).toMatchObject({ label: "Calendar error", fix: null });
    expect(err.description).toContain("Google answered 500.");
  });

  it("says how an added calendar syncs", () => {
    expect(accountCalendarView(acct({ status: "active", missingScopes: [] }), true).description).toMatch(/once their access includes Calendar/);
    expect(accountCalendarView(acct({ status: "active", missingScopes: [], syncedCalendars: 2 }), true).description).toContain("2 calendars sync.");
    expect(accountCalendarView(acct({ status: "active", missingScopes: [], syncedCalendars: 1 }), true).description).toContain("1 calendar syncs.");
  });
});

describe("per-account consent outcome", () => {
  it("reads the probe after Google answered", () => {
    expect(consentOutcome(acct({ status: "active", missingScopes: [] }), true)).toBe("added");
    expect(consentOutcome(acct({ status: "api_disabled", missingScopes: [] }), true)).toBe("api_disabled");
    expect(consentOutcome(acct({ status: "error", missingScopes: [] }), true)).toBe("error");
    expect(consentOutcome(acct({ missingScopes: [FREEBUSY] }), true)).toBe("partial");
  });

  it("tells unticked Calendar boxes from a sign-in that never finished", () => {
    expect(consentOutcome(acct(), true)).toBe("declined");
    expect(consentOutcome(acct(), false)).toBe("not_finished");
    expect(consentOutcome(undefined, true)).toBe("not_finished");
  });

  it("never dead-ends: every outcome but success says what to do and that mail is fine", () => {
    for (const [k, o] of Object.entries(CONSENT_OUTCOME)) {
      expect(o.title("wynn@example.com")).toBeTruthy();
      if (k !== "added") expect(o.body).toMatch(/mail works as usual/i);
    }
  });
});

describe("Calendar notice on Overview and Accounts", () => {
  it("is nothing without Calendar warnings", () => {
    expect(calendarNotice([])).toBeNull();
    expect(calendarNotice([warning("needs_reauth", { accountId: "acc_1" })])).toBeNull();
  });

  it("invites existing installs to add Calendar, and only that notice can be dismissed", () => {
    const n = calendarNotice([warning("calendar_not_added", { severity: "info" })]);
    expect(n).toMatchObject({ code: "calendar_not_added", severity: "info", action: { label: "Add Google Calendar" }, dismissible: true });
    expect(n?.body).toMatch(/never interrupts mail/);
  });

  it("puts the API being off first, with Google's link", () => {
    const n = calendarNotice([
      warning("calendar_scope_missing", { accountId: "acc_1" }),
      warning("calendar_api_disabled", { severity: "error", url: "https://console.cloud.google.com/apis/api/calendar-json.googleapis.com/overview?project=p" }),
    ]);
    expect(n).toMatchObject({ code: "calendar_api_disabled", severity: "error", action: { page: "api" }, dismissible: false });
    expect(n?.url).toContain("calendar-json.googleapis.com");
  });

  it("folds accounts without Calendar into one notice that opens the accounts step", () => {
    const one = calendarNotice([warning("calendar_scope_missing", { accountId: "a", message: "Add Google Calendar to a@example.com" })]);
    expect(one).toMatchObject({ title: "Add Google Calendar to a@example.com", action: { page: "accounts" } });
    const two = calendarNotice([
      warning("calendar_scope_missing", { accountId: "a" }),
      warning("calendar_scope_missing", { accountId: "b", severity: "error" }),
    ]);
    expect(two).toMatchObject({ title: "2 accounts don't have Google Calendar yet", severity: "error" });
    expect(two?.body).toMatch(/Mail works as usual/);
  });

  it("reports failing sync, which retries by itself", () => {
    expect(calendarNotice([warning("calendar_sync_failing", { severity: "error" }), warning("calendar_not_added")])).toMatchObject({
      code: "calendar_sync_failing",
      action: null,
    });
  });
});
