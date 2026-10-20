// Every OAuth scope xaq asks Google for, in one place (docs/calendar.md, "Google facts").
// Scopes are compared as full URLs; Google's token responses name the identity scopes as
// "openid", ".../userinfo.email" and ".../userinfo.profile".

const G = "https://www.googleapis.com/auth/";

/** Read, compose, send and label mail (restricted scope). Every account has it. */
export const GMAIL_SCOPE = `${G}gmail.modify`;
/** Pub/Sub provisioning and pulling, for the provisioning ("principal") account only. */
export const PUBSUB_SCOPE = `${G}pubsub`;
/** Identity (display name, email, Workspace domain from the id_token). */
export const IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

/** What every account is connected with. */
export const MAIL_SCOPES: readonly string[] = [GMAIL_SCOPE, ...IDENTITY_SCOPES];

/** events list/get/insert/patch/delete/watch on every calendar the user can access (sensitive). */
export const CALENDAR_EVENTS_SCOPE = `${G}calendar.events`;
/** calendarList.list: which calendars the user has (sensitive). calendar.events doesn't cover it. */
export const CALENDAR_LIST_SCOPE = `${G}calendar.calendarlist.readonly`;
/** freebusy.query on calendars the user can access, including colleagues' (calendar.events doesn't cover it). */
export const CALENDAR_FREEBUSY_SCOPE = `${G}calendar.events.freebusy`;

/**
 * Read any Drive file the user can open (restricted scope). Optional: attaching Drive files to mail
 * (server/mail/drive-files.ts) needs it; the Google Workspace extension's opt-in asks for it.
 */
export const DRIVE_READONLY_SCOPE = `${G}drive.readonly`;

/**
 * Google Calendar: the minimal set covering every calendar tool (docs/calendar.md). All three are needed
 * for Account.calendar.status "active"; with granular consent a user can untick some (missingScopes).
 */
export const CALENDAR_SCOPES: readonly string[] = [CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_SCOPE, CALENDAR_FREEBUSY_SCOPE];

/** Optional scope sets requested incrementally (include_granted_scopes), by ConnectAccountInput.scopes name. */
export const EXTRA_SCOPE_SETS = { pubsub: [PUBSUB_SCOPE], calendar: CALENDAR_SCOPES } as const satisfies Record<string, readonly string[]>;

/** Scopes in `wanted` that `granted` lacks. */
export const missingScopes = (granted: readonly string[], wanted: readonly string[]): string[] => wanted.filter((s) => !granted.includes(s));

export const hasScopes = (granted: readonly string[], wanted: readonly string[]): boolean => missingScopes(granted, wanted).length === 0;

/** What each calendar scope lets xaq do, in the words used to report unticked permissions. */
export const CALENDAR_SCOPE_WORDS: Record<string, string> = {
  [CALENDAR_EVENTS_SCOPE]: "view and edit events",
  [CALENDAR_LIST_SCOPE]: "see the list of calendars",
  [CALENDAR_FREEBUSY_SCOPE]: "see when people are free or busy",
};

/** "view and edit events, see the list of calendars" for missing calendar scopes. */
export const describeScopes = (scopes: readonly string[]): string => scopes.map((s) => CALENDAR_SCOPE_WORDS[s] ?? s).join(", ");
