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

// ───────────── Google Workspace files (Drive, Docs, Sheets, Slides) ─────────────
// Used by the official google-workspace code extension (docs/EXTENSIONS.md "Google accounts for code extensions")
// and by core's own Drive use (Gmail's attach-from-Drive). Never part of what an account is connected with: they're
// added incrementally (include_granted_scopes) when the user opts in.

/** Read every file in the user's Drive, and its metadata (restricted scope). */
export const DRIVE_READONLY_SCOPE = `${G}drive.readonly`;
/** Create files, and edit or delete the files this app created or the user opened with it (non-sensitive). */
export const DRIVE_FILE_SCOPE = `${G}drive.file`;
/** See, edit, create and delete Google Docs documents (sensitive). */
export const DOCS_SCOPE = `${G}documents`;
/** See, edit, create and delete Google Sheets spreadsheets (sensitive). */
export const SHEETS_SCOPE = `${G}spreadsheets`;
/** See, edit, create and delete Google Slides presentations (sensitive). */
export const SLIDES_SCOPE = `${G}presentations`;

/** The google-workspace extension's scope set (its manifest's `code.auth.scopes`). */
export const WORKSPACE_SCOPES: readonly string[] = [DOCS_SCOPE, SHEETS_SCOPE, SLIDES_SCOPE, DRIVE_FILE_SCOPE, DRIVE_READONLY_SCOPE];

/** The scopes Google names for identity on a token (what `openid email profile` come back as). */
export const IDENTITY_TOKEN_SCOPES: readonly string[] = ["openid", `${G}userinfo.email`, `${G}userinfo.profile`, "email", "profile"];

/**
 * Scopes a code extension may never ask for: everything core itself uses (Gmail, Calendar, Pub/Sub) and what covers
 * them (cloud-platform includes Pub/Sub; https://mail.google.com/ is full Gmail). EXTENSION_SCOPE_RE refuses every
 * gmail*, calendar*, pubsub* and cloud-platform* name as well, so a new Gmail or Calendar scope can't slip through.
 */
export const CORE_ONLY_SCOPES: readonly string[] = [GMAIL_SCOPE, PUBSUB_SCOPE, ...CALENDAR_SCOPES, `${G}cloud-platform`, "https://mail.google.com/"];

/**
 * A scope a code extension's `code.auth` of type "google" may list: an https://www.googleapis.com/auth/ URL whose name
 * doesn't start with gmail, calendar, pubsub or cloud-platform (core's scopes, or ones covering them).
 */
export const EXTENSION_SCOPE_RE = /^https:\/\/www\.googleapis\.com\/auth\/(?!(?:gmail|calendar|pubsub|cloud-platform)(?:[.\-/]|$))[a-z0-9][a-z0-9._-]{0,99}$/;

export const isExtensionScope = (s: string): boolean => EXTENSION_SCOPE_RE.test(s) && !CORE_ONLY_SCOPES.includes(s);

/** A Google API's service name, as `gcloud services enable` and the API Library take it: `docs.googleapis.com`. */
export const GOOGLE_SERVICE_RE = /^[a-z][a-z0-9-]{0,62}\.googleapis\.com$/;

/** What each Workspace scope lets the extension do, and what stops working without it (consent step, unticked boxes). */
export const WORKSPACE_SCOPE_WORDS: Record<string, { grants: string; without: string }> = {
  [DOCS_SCOPE]: { grants: "see, edit, create and delete your Google Docs documents", without: "its Google Docs tools won't work" },
  [SHEETS_SCOPE]: { grants: "see, edit, create and delete your Google Sheets spreadsheets", without: "its Google Sheets tools won't work" },
  [SLIDES_SCOPE]: { grants: "see, edit, create and delete your Google Slides presentations", without: "its Google Slides tools won't work" },
  [DRIVE_FILE_SCOPE]: {
    grants: "see, edit, create and delete only the Drive files it creates or you open with it",
    without: "it can't create new files or save copies in your Drive",
  },
  [DRIVE_READONLY_SCOPE]: { grants: "see and download all your Google Drive files", without: "it can't search your Drive or open files it didn't create" },
};

/** What a scope lets the holder do, in plain words (the scope itself when xaq has no words for it). */
export const scopeGrants = (scope: string): string => WORKSPACE_SCOPE_WORDS[scope]?.grants ?? scope;
/** What stops working without a scope, or null when xaq has no words for it. */
export const scopeWithout = (scope: string): string | null => WORKSPACE_SCOPE_WORDS[scope]?.without ?? null;
