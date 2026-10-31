// "Add Google Calendar" decisions as pure functions of the server's CalendarSetupState and SetupWarnings
// (docs/calendar.md, "OAuth, setup and the upgrade flow"), so they can be tested directly. Relative
// imports only: vitest and the server typecheck load this module too.

import type { AccountCalendarStatus, CalendarSetupState, SetupWarning } from "../../../shared/types.ts";

/** A subset of the console's Tone (src/lib/labels.ts, not importable here). */
type Tone = "good" | "warn" | "bad" | "idle";

export type CalendarAccount = CalendarSetupState["accounts"][number];

/**
 * The dialog's pages: 1 turn on the Calendar API, 2 list the scopes on the consent screen (optional),
 * 3 add Calendar to each account and see how each went.
 */
export const CALENDAR_PAGES = ["api", "scopes", "accounts"] as const;
export type CalendarPage = (typeof CALENDAR_PAGES)[number];

/** Where the dialog opens: the API page until Calendar is turned on (or while Google says the API is off), else the accounts. */
export function startPage(s: Pick<CalendarSetupState, "step">): CalendarPage {
  return s.step === "off" || s.step === "enable_api" ? "api" : "accounts";
}

const SCOPE_NAMES: Record<string, string> = {
  "https://www.googleapis.com/auth/calendar.events": "events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly": "calendar list",
  "https://www.googleapis.com/auth/calendar.events.freebusy": "free/busy",
};

/** "events and free/busy": the Calendar permissions an account lacks, as Google's screen groups them. */
export function scopeNames(scopes: readonly string[]): string {
  const names = scopes.map((s) => SCOPE_NAMES[s] ?? s);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Every Calendar permission is missing: the account never added Calendar (or unticked all of it). */
const noneGranted = (a: Pick<CalendarAccount, "missingScopes">) => a.missingScopes.length >= Object.keys(SCOPE_NAMES).length;

export interface AccountCalendarView {
  label: string;
  tone: Tone;
  /** One or two sentences; always says mail is unaffected when Calendar doesn't work. */
  description: string;
  /** What fixes it: the per-account consent, turning the API on, or nothing. */
  fix: "consent" | "enable_api" | null;
}

const MAIL_OK = "Mail works as usual.";

/**
 * An account's Calendar badge on the Accounts page. `enabled`: Calendar is part of this install
 * (CalendarSetupState.enabled); before that, an account without it is simply "Mail only".
 */
export function accountCalendarView(
  a: Pick<CalendarAccount, "status" | "missingScopes" | "syncedCalendars"> & { error?: string | null },
  enabled: boolean,
): AccountCalendarView {
  switch (a.status) {
    case "active":
      return {
        label: "Calendar",
        tone: "good",
        description:
          a.syncedCalendars > 0
            ? `Google Calendar is added. ${a.syncedCalendars === 1 ? "1 calendar syncs" : `${a.syncedCalendars} calendars sync`}.`
            : "Google Calendar is added. Agents can use it once their access includes Calendar.",
        fix: null,
      };
    case "api_disabled":
      return {
        label: "Calendar API off",
        tone: "bad",
        description: `The Google Calendar API is turned off in the Google Cloud project. ${MAIL_OK}`,
        fix: "enable_api",
      };
    case "error":
      return {
        label: "Calendar error",
        tone: "bad",
        description: `${a.error ?? "Calendar sync failed."} It retries on the next poll. ${MAIL_OK}`,
        fix: null,
      };
    case "not_granted":
      if (!noneGranted(a))
        return {
          label: "Calendar: partly allowed",
          tone: "warn",
          description: `Google wasn't allowed ${scopeNames(a.missingScopes)} for this account (a box was unticked). ${MAIL_OK}`,
          fix: "consent",
        };
      return enabled
        ? { label: "No Calendar yet", tone: "warn", description: `Google Calendar isn't added to this account yet. ${MAIL_OK}`, fix: "consent" }
        : { label: "Mail only", tone: "idle", description: `Google Calendar isn't added to this account. ${MAIL_OK}`, fix: "consent" };
  }
}

/** How a per-account "Add Calendar" consent ended, read from the state probed right after it. */
export type ConsentOutcome = "added" | "partial" | "declined" | "not_finished" | "api_disabled" | "error";

/**
 * `confirmed`: Google's callback reported success. A success that still grants nothing means every
 * Calendar box was unticked; without it the sign-in may simply not have finished.
 */
export function consentOutcome(a: Pick<CalendarAccount, "status" | "missingScopes"> | undefined, confirmed: boolean): ConsentOutcome {
  if (!a) return "not_finished";
  const by: Record<AccountCalendarStatus, ConsentOutcome> = {
    active: "added",
    api_disabled: "api_disabled",
    error: "error",
    not_granted: noneGranted(a) ? (confirmed ? "declined" : "not_finished") : "partial",
  };
  return by[a.status];
}

export const CONSENT_OUTCOME: Record<ConsentOutcome, { title: (email: string) => string; tone: Tone; body: string }> = {
  added: { title: (e) => `Google Calendar is added to ${e}`, tone: "good", body: "Mail kept working throughout." },
  partial: {
    title: (e) => `Some Calendar permissions weren't allowed for ${e}`,
    tone: "warn",
    body: "Google's screen has a checkbox per permission and one was unticked. Try again and tick every Calendar box (or Select all). Mail works as usual.",
  },
  declined: {
    title: (e) => `Calendar wasn't allowed for ${e}`,
    tone: "warn",
    body: "The Calendar boxes on Google's screen were unticked. Try again and tick them (or Select all). Mail works as usual.",
  },
  not_finished: {
    title: (e) => `Calendar isn't added to ${e} yet`,
    tone: "idle",
    body: "The Google sign-in didn't finish. Nothing changed: mail works as usual. Try again when you're ready.",
  },
  api_disabled: {
    title: () => "Google says the Calendar API is still off",
    tone: "bad",
    body: "The permissions are granted, but the Calendar API isn't enabled in the project yet. Turn it on (step 1), wait a minute, then check again. Mail works as usual.",
  },
  error: {
    title: (e) => `Calendar is added to ${e}, but Google answered with an error`,
    tone: "bad",
    body: "xaq retries on the next poll. Mail works as usual.",
  },
};

/** Accounts still to add Calendar to (step 3), in the server's order. */
export const accountsToAdd = (s: Pick<CalendarSetupState, "accounts">): CalendarAccount[] => s.accounts.filter((a) => a.status === "not_granted");

/** Whether an account's "Add Calendar" can go straight to Google's consent, or needs the dialog's earlier steps first. */
export function consentDirectly(s: Pick<CalendarSetupState, "enabled" | "api"> | undefined): boolean {
  return !!s?.enabled && s.api !== "disabled";
}

const CALENDAR_CODES = ["calendar_api_disabled", "calendar_sync_failing", "calendar_scope_missing", "calendar_not_added"] as const;
type CalendarCode = (typeof CALENDAR_CODES)[number];
export const isCalendarWarning = (w: SetupWarning): w is SetupWarning & { code: CalendarCode } =>
  (CALENDAR_CODES as readonly string[]).includes(w.code);

export interface CalendarNotice {
  code: CalendarCode;
  severity: SetupWarning["severity"];
  title: string;
  body: string;
  /** Google Cloud link for the fix (the enable-API deep link). */
  url?: string;
  /** The button: open the dialog (at its start, or on the accounts page). */
  action: { label: string; page?: CalendarPage } | null;
  /** Only the "not added" invitation can be hidden (PATCH /api/google/calendar {dismissed:true}). */
  dismissible: boolean;
}

/**
 * The one Calendar notice on Overview and Accounts, from SetupState.warnings: the most pressing Calendar
 * problem, with the per-account "scope missing" warnings folded into one. null when there is none.
 */
export function calendarNotice(warnings: readonly SetupWarning[]): CalendarNotice | null {
  const cal = warnings.filter(isCalendarWarning);
  const first = (code: CalendarCode) => cal.find((w) => w.code === code);
  const off = first("calendar_api_disabled");
  if (off)
    return { code: off.code, severity: off.severity, title: off.message, body: off.hint, url: off.url, action: { label: "Turn on the Calendar API", page: "api" }, dismissible: false };
  const failing = cal.filter((w) => w.code === "calendar_sync_failing");
  if (failing.length)
    return {
      code: "calendar_sync_failing",
      severity: "error",
      title: failing.length === 1 ? failing[0]!.message : `Calendar sync is failing for ${failing.length} accounts`,
      body: failing.length === 1 ? failing[0]!.hint : failing.map((w) => w.message).join(" "),
      action: null,
      dismissible: false,
    };
  const missing = cal.filter((w) => w.code === "calendar_scope_missing");
  if (missing.length)
    return {
      code: "calendar_scope_missing",
      severity: missing.some((w) => w.severity === "error") ? "error" : "warning",
      title: missing.length === 1 ? missing[0]!.message : `${missing.length} accounts don't have Google Calendar yet`,
      body: "Mail works as usual on them. Add Calendar to each with a short Google sign-in that asks only for the Calendar permissions.",
      action: { label: "Add Calendar to accounts", page: "accounts" },
      dismissible: false,
    };
  const notAdded = first("calendar_not_added");
  if (notAdded)
    return {
      code: notAdded.code,
      severity: "info",
      title: "New: Google Calendar for your agents",
      body: "Agents can read your calendars, find free time, schedule events and answer invitations, with the same per-agent access rules and approvals as mail. Adding it takes a few minutes and never interrupts mail.",
      action: { label: "Add Google Calendar" },
      dismissible: true,
    };
  return null;
}
