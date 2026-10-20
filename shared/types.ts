// Shared contract between the server (server/) and the web console (src/).
// Everything crossing the HTTP boundary of the console API (/api/*) is typed here.
// Timestamps are ISO-8601 strings in UTC. IDs are prefixed opaque strings (e.g. "agt_…").

/** The npm package (`npx xaq-cli`); the command it installs is `xaq`. */
export const NPM_PACKAGE = "xaq-cli";
/** The command the package installs (`npm i -g xaq-cli`, or the copy a service runs). */
export const CLI_NAME = "xaq";

// ───────────────────────────── Domain enums ─────────────────────────────

/** What an agent may do with a mailbox. `read` also grants search, labels, attachments and the event feed. */
export const MAIL_CAPABILITIES = ["read", "draft", "send", "organize", "trash"] as const;
/**
 * What an agent may do with the account's Google Calendar (see docs/calendar.md). Independent of the mail
 * capabilities: existing grants have none of these (mail-only).
 * - calendar.read: list calendars, list/search/get events, free/busy, and calendar.* events in the feed.
 * - calendar.write: create, update and delete events and respond to invitations. How a write executes is
 *   Grant.calendarWriteMode. The console shows "no calendar.write" as write mode "None".
 */
export const CALENDAR_CAPABILITIES = ["calendar.read", "calendar.write"] as const;
export const CAPABILITIES = [...MAIL_CAPABILITIES, ...CALENDAR_CAPABILITIES] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type CalendarCapability = (typeof CALENDAR_CAPABILITIES)[number];
export const isCalendarCapability = (c: string): c is CalendarCapability => (CALENDAR_CAPABILITIES as readonly string[]).includes(c);

/**
 * How `send`/`reply`/`forward` behave for a grant.
 * - direct: sent immediately (still subject to allowlist + rate limits)
 * - draft_only: a Gmail draft is created instead; a human sends it from Gmail
 * - approval: a draft is created and an approval request is queued in the console;
 *   approving sends the draft, rejecting deletes it
 */
export const SEND_MODES = ["direct", "draft_only", "approval"] as const;
export type SendMode = (typeof SEND_MODES)[number];

/**
 * How calendar writes (create/update/delete event, RSVP) execute for a grant that has `calendar.write`.
 * - direct: applied to Google Calendar at once (attendee allowlist and send caps still apply)
 * - approval: nothing touches Google until a human approves it in the console; approving applies the
 *   stored change, rejecting discards it. Default for new grants.
 */
export const CALENDAR_WRITE_MODES = ["direct", "approval"] as const;
export type CalendarWriteMode = (typeof CALENDAR_WRITE_MODES)[number];

/** Prefix of Account.lastError when the account's Gmail watch (Pub/Sub push) couldn't be started or renewed. */
export const GMAIL_WATCH_ERROR = "Gmail watch failed";

/**
 * Whether an audit action is an MCP tool call: tool names never contain a "." (send_message), while
 * console and pairing actions do (agent.create, pairing.key_delivered). The SQL form of this rule is
 * mcpToolCallSql in server/audit.ts; keep the two in step. Any outcome: calls rejected before a tool
 * ran (unknown tool, invalid arguments) are tool calls with outcome "error"; proof that an agent
 * works needs outcome "ok".
 */
export const isMcpToolAction = (action: string): boolean => !action.includes(".");

export const EVENT_TYPES = [
  "message.received", // new message landed in the mailbox (not sent by the account; except the console's setup test email)
  "message.sent", // message sent from the account (by an agent or by a human)
  "thread.reply_received", // received message in a thread the account previously sent into
  "label.added",
  "label.removed",
  "account.auth_failed", // refresh token revoked/expired; account needs re-auth
  "sync.gap", // history was too old; a bounded resync ran and events may be missing
  // Google Calendar (MailEvent.calendarEvent is set, message is null). Visible with calendar.read + calendar scope.
  "calendar.event_created", // a new event appeared on a synced calendar (not an invitation)
  "calendar.event_updated", // a material change (detail.changes) to a known event
  "calendar.event_cancelled", // the event was cancelled or deleted
  "calendar.invitation_received", // someone else's event now lists the account as an attendee awaiting a response
] as const;
/** Gmail, Calendar and account events: the closed set that existed before the broker. */
export type NativeEventType = (typeof EVENT_TYPES)[number];

/**
 * MCP broker events (docs/MCP-BROKER.md "Events from integrations"). They concern a connection, not an
 * account: MailEvent.connectionId is set and accountId/accountEmail are "". Visible to agents with a grant
 * on that connection, while the brokerUpstreams setting is on.
 */
export const BROKER_EVENT_TYPES = [
  "connection.auth_failed", // the upstream's credential stopped working; the owner must reconnect
  // Never emitted since the tool-change hold was removed (2026-10-16): a changed tool is only audited. Kept as an
  // accepted type so saved listener `--types` and webhook filters naming it stay valid.
  "connection.tool_changed",
  "connection.expiring", // the credential stops working on a known date (no refresh, or a cap): reconnect before it
  "approval.requested", // a risky upstream tool call waits for a human (detail.approvalUrl: the one-tap page)
] as const;
export type BrokerEventType = (typeof BROKER_EVENT_TYPES)[number];
/**
 * Events a native integration emits: `<preset>.<name>`, e.g. `whoop.recovery_updated` (IntegrationPreset.id and
 * NativeEvents.types). Open-ended, so EventType as a whole is too: code that needs the known set uses
 * EVENT_TYPES and BROKER_EVENT_TYPES.
 */
export type PresetEventType = `${string}.${string}`;
export type EventType = NativeEventType | BrokerEventType | PresetEventType;

const PRESET_EVENT_RE = /^([a-z0-9-]{1,24})\.[a-z0-9_]{1,64}$/;
/** Prefixes of xaq's own events: a preset can't be named like one. */
const RESERVED_EVENT_PREFIXES = new Set(["message", "thread", "label", "account", "sync", "calendar", "connection", "approval"]);
export const isPresetEventType = (t: string): t is PresetEventType => {
  const m = PRESET_EVENT_RE.exec(t);
  return !!m && !RESERVED_EVENT_PREFIXES.has(m[1]!);
};
/** Events about a connection (broker or preset), never an account. */
export const isConnectionEventType = (t: string): t is BrokerEventType | PresetEventType =>
  (BROKER_EVENT_TYPES as readonly string[]).includes(t) || isPresetEventType(t);
/** Any event type the server accepts in filters (webhooks, the listener stream, the console). */
export const isEventType = (t: string): t is EventType => (EVENT_TYPES as readonly string[]).includes(t) || isConnectionEventType(t);

export const CALENDAR_EVENT_TYPES = [
  "calendar.event_created",
  "calendar.event_updated",
  "calendar.event_cancelled",
  "calendar.invitation_received",
] as const satisfies readonly EventType[];
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];
export const isCalendarEventType = (t: string): t is CalendarEventType => (CALENDAR_EVENT_TYPES as readonly string[]).includes(t);

export type AccountStatus = "active" | "needs_reauth" | "paused" | "error";
export type IngestMode = "pubsub" | "poll";
export type DeliveryStatus = "pending" | "succeeded" | "failed" | "dead";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "sent" | "failed" | "expired";
export type AuditOutcome = "ok" | "denied" | "error";
export type ActorType = "agent" | "admin" | "system";

/** OAuth consent configuration the operator chose in Google Cloud. Drives setup guidance only. */
export type GoogleAppType = "internal" | "external";

// ───────────────────────────── Setup / system ─────────────────────────────

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  setupComplete: boolean;
}

/** GET /api/setup/status (unauthenticated). Drives the console's first route decision: claim, login or app. */
export interface SetupStatus {
  claimed: boolean;
  /** The request carries a valid admin session. */
  authenticated: boolean;
}

/** Live state of the ingest pipeline (Pub/Sub pull loop or history polling). */
export interface IngestStatus {
  mode: IngestMode;
  running: boolean;
  lastPullAt: string | null;
  lastError: string | null;
}

/** GET /api/system: facts about this instance for the settings page and connect snippets. */
export interface SystemInfo {
  version: string;
  nodeVersion: string;
  dataDir: string;
  /** Running under `xaq service install` (systemd/launchd). */
  service: boolean;
  /** URLs this machine is reachable at (localhost first, then LAN addresses). */
  addresses: string[];
  publicUrl: string;
  ingest: IngestStatus;
  /** Installs this instance as a service with the flags it runs with (`… service install --port 9000`), as the startup banner prints it. */
  serviceCommand: string;
}

/** GET /api/system/latest: update notice. */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Shell command that runs (or reinstalls the service with) the latest version using this instance's options. */
  command: string;
}

/** Ordered setup checklist; the console's setup wizard and overview both render this. */
export interface SetupState {
  /** True once an admin password exists. Before that, only /api/setup/claim with the setup token works. */
  claimed: boolean;
  googleClientConfigured: boolean;
  /** Google project id (needed for Pub/Sub). */
  gcpProjectId: string | null;
  googleAppType: GoogleAppType | null;
  pubsub: PubsubState;
  accountsConnected: number;
  agentsCreated: number;
  /** Some agent is known to work: its tool called /mcp (Agent.lastMcpAt), or a listener acked an event. */
  verified: boolean;
  /** All required steps done (claimed + client configured + ≥1 account). Pub/Sub is optional (poll fallback). */
  complete: boolean;
  /**
   * Problems with the setup as configured, most severe first (errors, then warnings, then info).
   * Recomputed on every GET /api/setup/state; empty when everything looks right. See SetupWarning.
   */
  warnings: SetupWarning[];
}

/**
 * - testing_mode: an account's refresh token was issued with a ~7-day lifetime (External app still in
 *   Testing). One per affected account (accountId set); `url` opens the project's Audience page.
 * - sign_in_expires: an account's refresh token expires for another reason (any other lifetime, e.g.
 *   time-based access the user chose on Google's consent screen). Neutral: reconnect before the date.
 *   One per account (accountId set). Both are "error" within 24 h of the expiry or after it.
 * - app_type_mismatch: the app type saved here contradicts the connected accounts. "warning" when it is
 *   "internal" but a personal (non-Workspace) Google account is connected (so the app is really External); "info" when it is
 *   "external" and every account is a Workspace account of one domain (Internal would avoid the 7-day
 *   Testing expiry and verification entirely).
 * - redirect_uri_missing: Google said the redirect URI isn't registered (GoogleClientCheck), or, when the
 *   check couldn't tell, the imported client JSON doesn't list it. Clears on a check or re-import that
 *   finds it, or once an account connects through the current redirect URI. Severity "error".
 * - redirect_uri_changed: the redirect URI changed (a public URL change) since the OAuth client was saved or
 *   imported, and nothing has shown the new one is registered yet. Names both URIs. Clears on a client check
 *   that finds it, a re-save/re-import of the client, or a connection through it. Severity "error".
 * - client_invalid: the last GoogleClientCheck found Google doesn't know the client ID. "error".
 * - client_secret_invalid: the last GoogleClientCheck found Google rejects the secret. "error".
 * - needs_reauth: an account's sign-in was rejected; one per account (accountId set). Severity "error".
 * - pubsub_failing: ingest mode is pubsub and Pub/Sub has an error (hint carries the remediation). "error".
 * - calendar_not_added: Google Calendar isn't added to this install yet (existing installs after the upgrade).
 *   "info"; `url` is unset, the console links its "Add Google Calendar" flow. Gone once added or dismissed.
 * - calendar_api_disabled: Google said the Calendar API is disabled in the project (SERVICE_DISABLED). "error"
 *   when some grant has a calendar capability, else "warning". `url` = the enable-API deep link.
 * - calendar_scope_missing: Calendar is added to this install but this account hasn't granted the calendar
 *   scopes (Account.calendar.missingScopes). One per account. "info" ("error" when a grant on the account
 *   has a calendar capability). Fixed by the per-account incremental consent.
 * - calendar_sync_failing: calendar sync for this account keeps failing (Account.calendar.error). "error".
 */
export type SetupWarningCode =
  | "testing_mode"
  | "sign_in_expires"
  | "client_invalid"
  | "client_secret_invalid"
  | "app_type_mismatch"
  | "redirect_uri_missing"
  | "redirect_uri_changed"
  | "needs_reauth"
  | "pubsub_failing"
  | "calendar_not_added"
  | "calendar_api_disabled"
  | "calendar_scope_missing"
  | "calendar_sync_failing";

export interface SetupWarning {
  code: SetupWarningCode;
  /** "error": something is broken or will break; "warning": will cause trouble later; "info": a suggestion. */
  severity: "error" | "warning" | "info";
  /** One sentence: what is wrong (names the account / date / URI when relevant). */
  message: string;
  /** What to do about it, with Google Cloud console click paths. */
  hint: string;
  /**
   * Deep link for the fix (a Google Cloud console page, project preselected), when there is one. The
   * hint always also names the menu path (e.g. "Google Auth Platform → Audience") in case the link
   * lands elsewhere: show both.
   */
  url?: string;
  /** Set for per-account warnings (testing_mode, sign_in_expires, needs_reauth, app_type_mismatch for a personal account). */
  accountId?: string;
}

export interface PubsubState {
  mode: IngestMode;
  topic: string | null; // projects/{p}/topics/{t}
  subscription: string | null; // projects/{p}/subscriptions/{s}
  /** Last provisioning/health error, human readable, with remediation hint. */
  lastError: string | null;
  /** Last time a Pub/Sub message was pulled (proves the pipeline works end-to-end). */
  lastMessageAt: string | null;
  /**
   * The connected account whose Google identity pulls the subscription ("Pub/Sub is set up with
   * <principalEmail>"): the one the last successful provisioning used. Before any provisioning (or if it
   * became inactive), the fallback: first active account with the Pub/Sub scope, else first active account.
   * null when no active account exists.
   */
  principalAccountId: string | null;
  principalEmail: string | null;
  /**
   * An account chosen with POST /api/google/pubsub/provision {accountId} whose provisioning hasn't
   * succeeded yet ("Switching to <pendingPrincipalEmail>…"). Provisioning and the incremental Pub/Sub
   * consent (POST /api/accounts/connect {scopes:["pubsub"]}) use it; it replaces the principal only once
   * provisioning (and its watch) succeed, so a failed switch never disturbs a working setup. null when none.
   */
  pendingPrincipalAccountId: string | null;
  pendingPrincipalEmail: string | null;
}

export interface Settings {
  /**
   * How often calendars are polled for changes (incremental sync with syncToken), in seconds. With a
   * working push channel (public https publicUrl) polling slows to a 15-minute safety net. Default 60.
   */
  calendarPollSeconds: number;
  /** Externally reachable base URL of this instance, e.g. https://mail.example.com. Used in MCP snippets + OAuth redirect. */
  publicUrl: string;
  ingestMode: IngestMode;
  pollIntervalSeconds: number;
  /** Max characters of message body returned to agents per message (0 = unlimited). */
  maxBodyChars: number;
  /** Days to keep events, deliveries and audit entries. */
  retentionDays: number;
  /** Approval requests auto-expire after this many hours. */
  approvalTtlHours: number;
  /**
   * SSRF guard: webhook targets that resolve to private, loopback or link-local addresses are refused
   * unless their host matches one of these entries (hostnames, IPs or CIDRs, e.g. "127.0.0.0/8",
   * "10.0.0.0/8", "n8n.internal"). Defaults to loopback only.
   */
  webhookAllowlist: string[];
  /** Accept device-flow pairing requests from `npx xaq-cli connect` (each still needs approval). */
  pairingEnabled: boolean;
  /**
   * Absolute directories on xaq's machine whose files agents may attach to mail by path (attachments
   * `{ path }`). Empty (the default): path attachments are off. xaq's own directories and secret-looking
   * files (master.key, *.db, .env, id_*, *.pem, *.key) are refused even inside them. Admin only (console
   * Settings, `npx xaq-cli settings attachment-dirs`); no agent tool changes it.
   */
  attachmentDirs: string[];
  /**
   * The MCP broker's upstream connections (docs/MCP-BROKER.md): the Connections page, connection access on agents,
   * `mcp.call` approvals and first run with Google optional. On by default since the console shipped (M1 PR 8).
   */
  brokerUpstreams: boolean;
  /**
   * Where get_attachment saves files it can't show (and files an agent asks for as a file): `<dir>/<message id>/<name>`.
   * Absolute path; "" (default) = `attachments/` in the data directory. Saved files are deleted after
   * ATTACHMENT_RETENTION_DAYS (7), only in a directory xaq created (server/mail/saved-attachments.ts).
   */
  attachmentSaveDir: string;
}

export interface GoogleClientConfig {
  clientId: string;
  /** Write-only: never returned by the API. */
  clientSecret?: string;
  projectId: string;
  appType: GoogleAppType;
}

/**
 * POST /api/google/client/import: the client-secret JSON downloaded from Google Cloud
 * (Google Auth Platform → Clients → your client → Download JSON), pasted or read from the file as text.
 * Only Web application clients (`{"web": {...}}`) are accepted.
 */
export interface GoogleClientImportInput {
  /** The file's contents, verbatim. */
  json: string;
  /** Omit to keep the app type saved before (null when there was none). */
  appType?: GoogleAppType;
}

/**
 * POST /api/google/client/check (also run automatically by PUT /api/google/client and
 * POST /api/google/client/import): asks Google whether the saved client works, so problems show up
 * before connecting (Google reports them on its own page and never redirects back).
 * Undocumented Google behavior, classified conservatively: "unknown" means "couldn't tell", not "bad".
 * Each probe times out after 5 s. Results are kept for GET /api/setup/state warnings until the client is
 * saved again or an account connects (which proves everything).
 */
export interface GoogleClientCheck {
  /** "invalid": Google doesn't know this client ID (deleted, mistyped, other project). */
  clientId: "ok" | "invalid" | "unknown";
  /** "missing": GoogleClientView.redirectUri isn't an Authorized redirect URI of the client. */
  redirectUri: "ok" | "missing" | "unknown";
  /** "invalid": Google rejected the secret. "unknown" whenever clientId is "invalid". */
  secret: "ok" | "invalid" | "unknown";
  /** client_invalid | client_secret_invalid | redirect_uri_missing (all severity "error"). */
  warnings: SetupWarning[];
}

/** Returned by PUT /api/google/client: the saved client plus the automatic check. */
export interface GoogleClientSaveResult extends GoogleClientView {
  /** Same as `check.warnings` (for import also the JSON's redirect URI list when the check couldn't tell). */
  warnings: SetupWarning[];
  check: GoogleClientCheck;
}

/**
 * Result of POST /api/google/client/import. The client is saved whenever the ID and secret are present;
 * problems that don't prevent saving come back as `warnings` (client_invalid, client_secret_invalid,
 * redirect_uri_missing: all severity "error", connecting will fail until fixed).
 *
 * Errors (400, ApiError.code):
 * - client_json_invalid: not JSON, or not a Google OAuth client file, or a malformed client ID
 * - client_json_desktop: an "installed" (Desktop app) client; a Web application client is needed
 * - client_secret_missing: the file has no client_secret and none is stored for this client ID
 * - bad_request: invalid project_id (same validation as PUT /api/google/client)
 */
export interface GoogleClientImportResult extends GoogleClientSaveResult {
  /** The redirect URIs listed in the imported JSON (what Google had registered when it was downloaded). */
  registeredRedirectUris: string[];
}

/** Returned by GET /api/google/client. */
export interface GoogleClientView {
  clientId: string | null;
  hasSecret: boolean;
  projectId: string | null;
  appType: GoogleAppType | null;
  /** The exact redirect URI the operator must register on the OAuth client. */
  redirectUri: string;
  /**
   * "direct": Google redirects straight back to this console (localhost or https publicUrl).
   * "paste": publicUrl is plain-http non-localhost; Google can't redirect here, so the console
   * asks the user to paste the URL they land on after consent.
   */
  callbackMode: "direct" | "paste";
  /** Last 4 characters of the saved secret (to recognize which one is saved), or null without a secret. */
  secretHint: string | null;
  /**
   * There is evidence `redirectUri` is registered on the saved client: an account connected through it,
   * a client check found it, or the imported client JSON lists it. False without a client.
   */
  redirectUriConfirmed: boolean;
}

// ───────────────────────────── Accounts ─────────────────────────────

export interface Account {
  id: string; // acc_…
  email: string;
  displayName: string | null;
  status: AccountStatus;
  lastError: string | null;
  historyId: string | null;
  watchExpiresAt: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  /**
   * When Google said the refresh token expires (token response `refresh_token_expires_in`), or null for a
   * long-lived token. The account needs reconnecting before this time.
   */
  refreshTokenExpiresAt: string | null;
  /**
   * Why it expires (null when refreshTokenExpiresAt is null, or unknown): "testing" = issued with the ~7-day
   * Testing lifetime (External app not published; publish it, then reconnect); "time_based" = any other
   * lifetime (e.g. time-based access chosen on the consent screen).
   */
  refreshTokenExpiryKind: "testing" | "time_based" | null;
  /** Google Workspace domain (id_token `hd` claim), or null for a personal (non-Workspace) Google account (or not yet known). */
  workspaceDomain: string | null;
  /**
   * OAuth scopes Google says this account granted (token response `scope`, refreshed on every token
   * refresh), full URLs. null when unknown.
   */
  grantedScopes: string[] | null;
  /**
   * Google Calendar state of this account. null when the account has granted none of the calendar scopes
   * and nothing calendar-related was recorded for it (a mail-only account). Whether Calendar is wanted
   * for it is install-wide: see CalendarSetupState (its `accounts` list covers every account).
   */
  calendar: AccountCalendar | null;
}

/**
 * - not_granted: some CALENDAR_SCOPES are missing (missingScopes); mail is unaffected. Fix: per-account consent.
 * - api_disabled: Google answered SERVICE_DISABLED: the Calendar API is off in the Cloud project.
 * - active: scopes granted and the last probe/sync worked (or nothing has run yet).
 * - error: the last sync failed for another reason (error says why); retried on the next poll.
 */
export type AccountCalendarStatus = "not_granted" | "api_disabled" | "active" | "error";

export interface AccountCalendar {
  status: AccountCalendarStatus;
  /** CALENDAR_SCOPES (full URLs) the account hasn't granted; empty when all are granted. */
  missingScopes: string[];
  /** Last successful incremental sync of any of its calendars. null = never (no grant has calendar.read yet, or not granted). */
  lastSyncAt: string | null;
  /** Human-readable reason for api_disabled / error, null otherwise. */
  error: string | null;
}

/** POST /api/accounts/:id/test-email: a self-addressed message sent through Gmail to prove delivery end to end. */
export interface TestEmailResult {
  /** Gmail message id of the sent message (matches MailEvent.message.id of the resulting events). */
  messageId: string;
  threadId: string;
  sentAt: string;
}

export interface GmailLabel {
  id: string; // Gmail label id, e.g. "INBOX" or "Label_123"
  name: string;
  type: "system" | "user";
}

/** POST /api/accounts/connect → start OAuth. */
export interface PubsubTestResult {
  ok: boolean;
  message: string;
}

/**
 * What the /oauth/callback page posts to its opener (window.postMessage) and on the
 * BroadcastChannel "agentinbox-oauth". On failure, `error`/`code`/`hint` mirror the ApiError that
 * POST /api/accounts/connect/complete returns for the same failure.
 */
export interface OAuthCallbackMessage {
  type: "agentinbox:oauth";
  ok: boolean;
  email: string | null;
  /** Human-readable message (null on success). */
  error: string | null;
  /** ApiError code, e.g. "oauth_access_denied" (null on success). See the route map for the list. */
  code: string | null;
  hint: string | null;
}

/**
 * POST /api/accounts/connect/status {state}: what became of one sign-in (ConnectAccountResponse.state). The
 * console asks when the callback page's message can't reach it (the console is open on another origin than
 * the redirect URI's, or Google severed the opener). Remembered in memory for an hour; "unknown" once the
 * state expired unused, after a restart, or for a state this server never issued.
 */
export type ConnectAttempt =
  | { status: "pending" }
  | { status: "connected"; accountId: string; email: string }
  /** `code`/`error`/`hint` mirror the ApiError POST /api/accounts/connect/complete returns for the same failure. */
  | { status: "failed"; code: string; error: string; hint: string | null }
  | { status: "unknown" };

export interface ConnectAccountResponse {
  authUrl: string;
  /** Echoed state; in paste mode the console POSTs the pasted URL to /api/accounts/connect/complete. */
  state: string;
  callbackMode: "direct" | "paste";
}

// ───────────────────────────── Agents & grants ─────────────────────────────

/** How an agent was added: approved from `xaq connect` (its key lives in a profile on that machine), or created here with a copied key. */
export type AgentOrigin = "paired" | "key";

export interface Agent {
  id: string; // agt_…
  name: string;
  description: string | null;
  /** First chars of the key, for identification (e.g. "aib_7Hk2"). The full key is shown once at creation/rotation. */
  keyPrefix: string;
  disabled: boolean;
  origin: AgentOrigin;
  /** Last request with this agent's key (MCP or the listener API), written at most once a minute. */
  lastUsedAt: string | null;
  /** Last request to /mcp only (a tool's startup `tools/list` counts), written at most once a minute. */
  lastMcpAt: string | null;
  createdAt: string;
  grants: Grant[];
  /** `xaq listen` instances (one per consumer name) and their stream position. */
  listeners: ListenerInfo[];
}

export interface ListenerInfo {
  consumer: string;
  connected: boolean;
  /**
   * Where the cursor started when the consumer was created (the head, or 0 for start=beginning):
   * events at or below it predate the listener and weren't delivered to it. Null = unknown (created
   * before this was recorded, or by an ack).
   */
  startSeq: number | null;
  ackedSeq: number;
  /**
   * Event types the listener's stream asked for when it last connected (every type when it named
   * none). Events of other types are acknowledged without running its command. Null = unknown
   * (recorded before this existed).
   */
  types: EventType[] | null;
  lastSeenAt: string | null;
  client: { hostname?: string; platform?: string; version?: string };
}

export type PairingStatus = "pending" | "approved" | "denied" | "expired";

/** A device-flow pairing request from `npx xaq-cli connect`, shown in the approvals inbox. */
export interface PairingRequest {
  id: string; // par_…
  /** The code the agent's terminal shows; the human must match it before approving. */
  userCode: string;
  name: string;
  description: string | null;
  requested: { accounts?: string[]; capabilities?: Capability[]; sendMode?: SendMode; calendarWriteMode?: CalendarWriteMode; reason?: string };
  client: { hostname?: string; platform?: string; tool?: string; version?: string };
  /** Requester IP as seen by the daemon. */
  ip: string | null;
  status: PairingStatus;
  /** Set once approved. */
  agentId: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

/** POST /api/pairings/:id/approve. Grants default to sendMode draft_only in the console. */
export interface ApprovePairingInput {
  /** Typed by the human from the agent's terminal (not pre-filled); case and dashes are ignored. 409 on mismatch. */
  userCode: string;
  name?: string;
  /** Mailbox grants; may be empty (an install with only connections). */
  grants: (GrantInput & { accountId: string })[];
  /** MCP broker connections: the level per connection ("none" = no access, also for "All agents" ones). */
  connections?: { connectionId: string; level: AccessLevel | "none" }[];
}

export interface Grant {
  id: string; // grt_…
  agentId: string;
  accountId: string;
  capabilities: Capability[];
  /** Gmail label ids the agent is confined to (thread-level: a thread is visible if any message carries one). null = whole mailbox. */
  labelScope: string[] | null;
  sendMode: SendMode;
  /** Recipient allowlist: exact addresses or "*@domain.com" globs. Empty = any recipient. */
  allowTo: string[];
  /** Only allow sending replies inside threads the agent can already see. */
  replyOnly: boolean;
  /** Counts mail sends and calendar writes that email people (see docs/calendar.md, "Send caps"). */
  maxSendsPerHour: number | null;
  maxSendsPerDay: number | null;
  /**
   * Calendar ids (CalendarInfo.id) the agent's calendar capabilities are confined to. The primary calendar is
   * stored by its real id (the account email), never the alias "primary". null = every calendar in the
   * account's list.
   * Ignored without a calendar capability. Default null.
   */
  calendarScope: string[] | null;
  /** How calendar.write executes. Ignored without calendar.write. Default "approval". */
  calendarWriteMode: CalendarWriteMode;
  createdAt: string;
}

/**
 * The calendar fields are optional for older callers: omitted means "unchanged" on an existing grant and
 * the default (calendarScope null, calendarWriteMode "approval") on a new one. Never widened by omission.
 */
export type GrantInput = Omit<Grant, "id" | "agentId" | "createdAt" | "calendarScope" | "calendarWriteMode"> &
  Partial<Pick<Grant, "calendarScope" | "calendarWriteMode">>;

export interface CreateAgentInput {
  name: string;
  description?: string | null;
  grants?: GrantInput[];
  /** MCP broker connections (pairing approve): the level per connection; "none" opts out of an "All agents" one. */
  connections?: { connectionId: string; level: AccessLevel | "none" }[];
}

/** POST /api/agents/:id/test: runs MCP initialize + tools/list as the agent, in-process. */
export interface AgentTestResult {
  ok: boolean;
  tools: string[];
  message: string;
}

/** GET /api/agents/:id/tool-mode: how /mcp lists this agent's tools (docs/MCP-BROKER.md, search mode). */
export interface AgentToolMode {
  /** The stored choice; "auto" until the agent's first /mcp request decides it. */
  setting: "auto" | "direct" | "search";
  /** What /mcp serves it now (without ?mode=search). */
  mode: "direct" | "search";
  /** Tools the agent can use (mail, calendar and connections). */
  tools: number;
  /** Above this many tools a new agent starts in search mode. */
  threshold: number;
}

/** Returned once on create and on key rotation. */
export interface AgentWithKey {
  agent: Agent;
  apiKey: string; // aib_…
}

// ───────────────────────────── Events ─────────────────────────────

export interface Address {
  name: string | null;
  email: string;
}

/** Normalized message metadata carried in events. No bodies are stored server-side. */
export interface MessageSummary {
  id: string; // Gmail message id
  threadId: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  subject: string;
  snippet: string;
  date: string; // ISO
  labelIds: string[];
  hasAttachments: boolean;
}

/**
 * One item of the agent event feed, webhooks and listeners. The name is historical: calendar.* events use
 * the same envelope with `message: null` and `calendarEvent` set.
 */
// ───────────────────────────── Calendar ─────────────────────────────

export type CalendarResponseStatus = "needsAction" | "declined" | "tentative" | "accepted";
export type CalendarAccessRole = "owner" | "writer" | "reader" | "freeBusyReader";

/** A calendar in the account's calendar list (calendarList.list). */
export interface CalendarInfo {
  /** Google calendar id: the account email for the primary calendar, "…@group.calendar.google.com" for others. */
  id: string;
  /** Display name (the user's override if any). Cleaned single line. */
  name: string;
  primary: boolean;
  accessRole: CalendarAccessRole;
  timeZone: string | null;
  /** Google's color for the calendar, e.g. "#9fe1e7" (console only). */
  color: string | null;
  /** Changes on it are synced into calendar.* events (owner/writer calendars, while a grant reads them). */
  synced: boolean;
}

export interface CalendarAttendee {
  email: string;
  name: string | null;
  responseStatus: CalendarResponseStatus;
  optional: boolean;
  organizer: boolean;
  /** This attendee is the account itself. */
  self: boolean;
  /** A room or other resource. */
  resource: boolean;
}

/** Fields compared to report a calendar.event_updated (detail.changes). */
export type CalendarEventChange = "summary" | "time" | "location" | "description" | "attendees" | "responses" | "status" | "recurrence" | "conference";

/**
 * Normalized event metadata carried in calendar.* events and tool results. Like MessageSummary, no
 * free text body: the description is fetched (cleaned and wrapped as untrusted) on demand. Free-text
 * fields (summary, location, names) are third-party input: cleaned single lines, never instructions.
 */
export interface CalendarEventSummary {
  /** Google event id (unique within its calendar). */
  id: string;
  calendarId: string;
  /** Same across calendars (an invitation's copy on each attendee's calendar shares it). */
  iCalUID: string | null;
  /** Set on instances/exceptions of a recurring event: the series' event id. */
  recurringEventId: string | null;
  /** The event is a recurring series (has RRULEs). */
  recurring: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  summary: string;
  location: string | null;
  /** RFC 3339 date-time, or YYYY-MM-DD for all-day events (end is exclusive, as in Google). */
  start: string;
  end: string;
  allDay: boolean;
  /** The event's time zone (IANA), null when Google gave none. */
  timeZone: string | null;
  organizer: Address | null;
  /** The account organizes this event. */
  organizerSelf: boolean;
  /** At most 50 attendees (attendeeCount has the total). */
  attendees: CalendarAttendee[];
  attendeeCount: number;
  /** The account's own response, null when it isn't an attendee. */
  selfResponse: CalendarResponseStatus | null;
  /** Video call link (Meet or another conference), null when none. */
  conferenceUrl: string | null;
  /** Link to the event in Google Calendar. */
  htmlLink: string | null;
  /** Google's eventType ("default", "outOfOffice", "focusTime", "workingLocation", "birthday", "fromGmail"). */
  eventType: string;
  created: string | null;
  updated: string | null;
}

/**
 * What an agent asked to write (create, or the changed fields of an update). Kept on calendar approvals so
 * the human sees exactly what will be applied. Times as in CalendarEventSummary.
 */
export interface CalendarEventInput {
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  timeZone?: string;
  /** Full attendee list after the change (emails). Omitted on update = unchanged. */
  attendees?: string[];
  /** Add a Google Meet link. */
  addConference?: boolean;
  /** RRULE/EXDATE lines, e.g. ["RRULE:FREQ=WEEKLY;COUNT=4"]. */
  recurrence?: string[];
}

/** POST /api/google/calendar/* and GET /api/google/calendar: the install's Google Calendar setup ("Add Google Calendar"). */
export interface CalendarSetupState {
  /**
   * Calendar is part of this install: every connect/reconnect requests CALENDAR_SCOPES. True by default on
   * new installs (no account connected before the upgrade); existing installs turn it on by starting "Add Google Calendar".
   */
  enabled: boolean;
  /** The operator hid the calendar_not_added notice. */
  dismissed: boolean;
  /** CALENDAR_SCOPES (full URLs), to list on the consent screen's Data Access page. */
  scopes: string[];
  /**
   * The Calendar API in the Cloud project, as last observed: "disabled" after a SERVICE_DISABLED answer,
   * "enabled" after any successful call, "unknown" before any account could try (no account has the scopes).
   */
  api: "enabled" | "disabled" | "unknown";
  /** Deep link enabling calendar-json.googleapis.com in the saved project (null without a project id). */
  enableApiUrl: string | null;
  /** `gcloud services enable calendar-json.googleapis.com --project=<id>` (null without a project id). */
  enableApiCommand: string | null;
  /** Google Auth Platform → Data Access page of the project, to add the scopes (null without a project id). */
  dataAccessUrl: string | null;
  /** Every connected account. */
  accounts: {
    accountId: string;
    email: string;
    status: AccountCalendarStatus;
    missingScopes: string[];
    /** Calendars whose changes are synced into events (owner/writer calendars), 0 while no grant reads them. */
    syncedCalendars: number;
    /** A verified push channel is live for at least one synced calendar (otherwise changes arrive by polling). */
    push: boolean;
  }[];
  /**
   * Next thing to do: enable_api (api "disabled"), connect_accounts (some active account lacks the scopes; the
   * Data Access step is shown with it, it can't be detected), done. "off" when not enabled.
   */
  step: "off" | "enable_api" | "connect_accounts" | "done";
}

/** PATCH /api/google/calendar. */
export interface CalendarSetupInput {
  enabled?: boolean;
  dismissed?: boolean;
}

/** POST /api/accounts/connect body. `scopes` adds optional scope sets incrementally (include_granted_scopes). */
export interface ConnectAccountInput {
  reauthAccountId?: string;
  scopes?: ExtraScopeName[];
  /**
   * Ask for mail only: no calendar scopes, even while Calendar is enabled or the account had them. For
   * Workspace admins who block Calendar (Google then rejects any consent that includes it). Not with scopes ["calendar"].
   */
  mailOnly?: boolean;
}
/** "pubsub": the Pub/Sub scope for the provisioning account. "calendar": CALENDAR_SCOPES. */
export const EXTRA_SCOPE_NAMES = ["pubsub", "calendar"] as const;
export type ExtraScopeName = (typeof EXTRA_SCOPE_NAMES)[number];

export interface MailEvent {
  id: string; // evt_…
  seq: number; // monotonic, used as cursor
  type: EventType;
  /** "" on connection events (BROKER_EVENT_TYPES and `<preset>.*`), which carry connectionId instead. */
  accountId: string;
  accountEmail: string;
  /** Connection events only. */
  connectionId?: string;
  message: MessageSummary | null;
  /** calendar.* events only (absent on mail events, so their payloads are unchanged). */
  calendarEvent?: CalendarEventSummary;
  /** For label.added / label.removed. */
  labelIds?: string[];
  /**
   * Free-form detail for account/sync events. calendar.event_updated: `{ changes: CalendarEventChange[] | null }`
   * (null = unknown: the previous version wasn't seen). calendar.event_cancelled: `{ wasOrganizer: boolean }`.
   */
  detail?: Record<string, unknown>;
  createdAt: string;
  /**
   * Console only (GET /api/events and the console stream): the thread's labels when the event was
   * recorded, which agents' label scopes are matched against. Never sent to agents or webhooks.
   */
  threadLabelIds?: string[];
}

// ───────────────────────────── Webhooks ─────────────────────────────

export interface WebhookFilter {
  accountIds?: string[];
  /** Match if the message has any of these label ids. */
  labelIds?: string[];
  /** Glob on sender address, e.g. "*@stripe.com". Any match passes. */
  from?: string[];
  /** Glob on any to/cc address. */
  to?: string[];
  /** Case-insensitive regular expression tested against the subject. */
  subject?: string;
  hasAttachments?: boolean;
  /**
   * calendar.* events: only these calendar ids. On calendar events `from` matches the organizer, `to` any
   * attendee and `subject` the event summary; labelIds and hasAttachments don't apply (ignored).
   */
  calendarIds?: string[];
}

export interface Webhook {
  id: string; // whk_…
  agentId: string;
  name: string;
  url: string;
  eventTypes: EventType[];
  filter: WebhookFilter;
  /** Include the cleaned message body (markdown) in the payload. */
  includeBody: boolean;
  enabled: boolean;
  /** Shown once at creation and on rotation ("whsec_…", Standard Webhooks format). */
  secretPrefix: string;
  createdAt: string;
  stats: { succeeded24h: number; failed24h: number; lastDeliveryAt: string | null };
}

export type WebhookInput = Omit<Webhook, "id" | "secretPrefix" | "createdAt" | "stats">;

export interface WebhookWithSecret {
  webhook: Webhook;
  secret: string;
}

export interface Delivery {
  id: string; // dlv_…
  webhookId: string;
  eventId: string;
  eventType: EventType;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  /** First ~500 chars of the receiver's response body. */
  lastResponse: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Webhook HTTP request body. Signed per https://www.standardwebhooks.com:
 * headers webhook-id, webhook-timestamp, webhook-signature ("v1,<base64 hmac-sha256>").
 */
export interface WebhookPayload {
  type: EventType;
  timestamp: string;
  data: MailEvent & {
    /**
     * Present only when the webhook has includeBody and the event concerns a message, or (calendar.* except
     * cancelled) an event with a description: then `body` is the cleaned description, attachments empty.
     */
    content?: MessageContent;
    /** Set instead of `content` when includeBody was requested but the body could not be fetched. */
    contentError?: string;
  };
}

// ───────────────────────────── Message content (returned to agents) ─────────────────────────────

/** Signals attached to content. Informational: the content itself is still delivered (cleaned, not censored). */
export interface ContentSignals {
  /** Invisible content (display:none, zero-size/transparent text, HTML comments, zero-width/tag unicode) was removed. */
  hiddenContentRemoved: boolean;
  /** Phrases that commonly appear in prompt-injection attempts ("ignore previous instructions", …). */
  suspiciousInstructions: string[];
  /** SPF/DKIM/DMARC results parsed from Authentication-Results. null when the header is absent. */
  auth: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  /** Sender is outside the account's own domain. */
  external: boolean;
}

export interface Attachment {
  id: string; // Gmail attachment id
  filename: string;
  mimeType: string;
  size: number;
}

export interface MessageContent {
  /** Body converted to markdown (from HTML) or the plain-text part. */
  body: string;
  truncated: boolean;
  attachments: Attachment[];
  signals: ContentSignals;
}

// ───────────────────────────── Approvals ─────────────────────────────

export const MAIL_APPROVAL_KINDS = ["send", "reply", "forward"] as const;
/** Calendar writes queued by calendarWriteMode "approval". Approving applies the stored change; rejecting discards it. */
export const CALENDAR_APPROVAL_KINDS = ["calendar.create", "calendar.update", "calendar.delete", "calendar.rsvp"] as const;
export type MailApprovalKind = (typeof MAIL_APPROVAL_KINDS)[number];
export type CalendarApprovalKind = (typeof CALENDAR_APPROVAL_KINDS)[number];
/** A risky upstream tool call at the "ask" level (docs/MCP-BROKER.md). Goes through a connection, not an account. */
export const MCP_APPROVAL_KINDS = ["mcp.call"] as const;
export type McpApprovalKind = (typeof MCP_APPROVAL_KINDS)[number];
/** The kinds that act on a Google account (an Approval with accountId set). */
export type GoogleApprovalKind = MailApprovalKind | CalendarApprovalKind;
export type ApprovalKind = GoogleApprovalKind | McpApprovalKind;
export const isCalendarApprovalKind = (k: string): k is CalendarApprovalKind => (CALENDAR_APPROVAL_KINDS as readonly string[]).includes(k);
export const isMcpApprovalKind = (k: string): k is McpApprovalKind => (MCP_APPROVAL_KINDS as readonly string[]).includes(k);

/** The calendar change a calendar.* approval applies. */
export interface CalendarApprovalDetail {
  calendarId: string;
  calendarName: string | null;
  /**
   * Target event (update/delete/rsvp). For create, the id xaq chose when queuing (Google accepts
   * client ids), so a retried apply can't create a second event.
   */
  eventId: string | null;
  /** create: the new event; update: only the changed fields; delete/rsvp: {}. */
  change: CalendarEventInput;
  /** The event when the change was queued (update/delete/rsvp), to show a before/after. null for create. */
  before: CalendarEventSummary | null;
  /** Google etag of `before`: applying sends If-Match, so an event changed since fails instead of being overwritten. */
  etag: string | null;
  /** rsvp only. */
  response: CalendarResponseStatus | null;
  /** rsvp only: the note sent to the organizer with the answer. */
  comment?: string | null;
  /** Google emails attendees (sendUpdates "all"); false = "none". */
  notifyAttendees: boolean;
  /** Addresses Google will email when applied. */
  notified: string[];
  /**
   * Addresses the grant's allowTo had to cover when queued (attendees after the change, another organizer,
   * everyone emailed; see attendeeImpact), checked again at approval. Absent on approvals from before it
   * existed: then recomputed from the change.
   */
  checked?: string[];
  /**
   * When xaq last started sending this change to Google (set before each attempt). Once set, a later
   * attempt can't assume the earlier one didn't land: it checks the event first.
   */
  attemptedAt?: string | null;
}

/** The exact call an mcp.call approval forwards once approved (approvals.tool_call). */
export interface McpCallApprovalDetail {
  /** The upstream's own tool name (UpstreamTool.name). */
  tool: string;
  /** The name the agent called (UpstreamTool.exposedName, `<slug>__<tool>`). */
  exposedName: string;
  /** The validated, canonicalised arguments: exactly the bytes shown on the card and forwarded on approve. */
  args: string;
  /** sha256 (hex) of `args`, re-checked on approve. */
  argsSha256: string;
  /** The tool's definition hash when the call was queued; a different one on approve means the tool changed since. */
  pinHash: string;
  /** The upstream's result once the approved call ran (what get_call_status returns). */
  result?: McpCallResult | null;
  /** When the approved call was last forwarded upstream (set right before it is). */
  attemptedAt?: string | null;
  /**
   * The approved call was interrupted (crash, timeout, lost answer): it may or may not have run upstream.
   * Status is "failed"; it is never retried automatically.
   */
  outcomeUnknown?: boolean;
}

/**
 * GET /api/approvals/:id for an mcp.call: the card. `approval.call.args` holds the exact bytes that run on approve.
 * `tool` is the tool as the agent can reach it now (null when it no longer can: access removed, or the tool was removed).
 */
export interface McpCallApprovalView {
  approval: McpCallApproval;
  connection: { id: string; slug: string; name: string; status: ConnectionStatus } | null;
  tool: { exposedName: string; name: string; title: string | null; risky: boolean; read: boolean; targetPath: string | null; level: AccessLevel; pinMatches: boolean } | null;
  /** The exact argument bytes with invisible and control characters shown as \u escapes. */
  argsDisplay: string;
  /** The same arguments indented (escaped the same way). */
  pretty: string;
  /** Email addresses and URLs found anywhere in the arguments: shown first on the card. */
  recipients: string[];
  urls: string[];
  /** The tool's target argument (ToolClass.targetPath, a JSON Pointer) and its value in this call, if any. */
  target: { path: string; value: unknown } | null;
  /** JSON Pointers a generic tool's "always allow for this argument" may pick from. */
  argumentPaths: string[];
  /** sha256 of the stored bytes still matches the fingerprint taken when the call was queued. */
  argsIntact: boolean;
}

/** POST /api/approvals/:id/approve for an mcp.call. */
export interface McpCallApproveInput {
  note?: string | null;
  /**
   * "Always allow this": a rule for this agent and tool, created when the call is approved. `target` limits it
   * to this call's target value (one rule per id when the target is an array); `targetPath` picks the argument
   * for generic tools (defaults to the tool's own targetPath).
   */
  alwaysAllow?: { target?: boolean; targetPath?: string };
}

/** An upstream CallToolResult as stored for get_call_status. */
export interface McpCallResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Where a file attached to an outgoing message came from (approval cards and the audit log show it):
 * - upload: the bytes were in the tool call (content_base64);
 * - path: a file on xaq's machine, inside an allowed attachment directory (Settings.attachmentDirs). `path` is the
 *   resolved real path that was read; `requested` the path the agent gave, when it differs (a symlink, "..");
 * - message: an attachment of another message in the same account (`attachmentId` as get_message lists it);
 * - drive: a Google Drive file, downloaded or (Google Docs, Sheets, Slides) exported (`exportedAs`, e.g. "pdf");
 * - forward: an original file carried by forward's include_attachments.
 */
export type AttachmentSource =
  | { kind: "upload" }
  | { kind: "path"; path: string; requested?: string }
  | { kind: "message"; messageId: string; attachmentId: string; filename: string }
  | { kind: "drive"; fileId: string; name: string; exportedAs?: string }
  | { kind: "forward"; messageId: string };

/** An outgoing file as approval cards and the audit log describe it (never the content). */
export interface OutgoingFileMeta {
  filename: string;
  size: number;
  mimeType?: string;
  /** Absent on approvals from before attachment sources were recorded. */
  source?: AttachmentSource;
}

interface ApprovalCommon {
  id: string; // apr_…
  agentId: string;
  agentName: string;
  status: ApprovalStatus;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** Full body as the agent wrote it (markdown/plain). */
  body: string;
  threadId: string | null;
  /** Files on the message: name, MIME type, decoded size and where each came from (never the content). */
  attachments: OutgoingFileMeta[];
  /** Why the agent says it is sending (optional `reason` tool arg). */
  reason: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  sentMessageId: string | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * A send or calendar change waiting for (or decided by) a human. For calendar kinds the mail fields are
 * filled so generic lists read well: to = `calendar.notified`, cc/bcc empty, subject = event summary,
 * body = description, draftId "" and threadId null; status "sent" means "applied" and sentMessageId holds
 * the Google event id.
 */
export interface GoogleApproval extends ApprovalCommon {
  kind: GoogleApprovalKind;
  accountId: string;
  accountEmail: string;
  draftId: string;
  /** Calendar kinds only. */
  calendar?: CalendarApprovalDetail;
  connectionId?: null;
  call?: undefined;
}

/**
 * A risky upstream tool call waiting for (or decided by) a human. No Google account and no draft; the
 * mail fields stay empty unless the server fills them for generic lists.
 */
export interface McpCallApproval extends ApprovalCommon {
  kind: McpApprovalKind;
  accountId: null;
  accountEmail: null;
  draftId: null;
  connectionId: string;
  call: McpCallApprovalDetail;
  calendar?: undefined;
}

export type Approval = GoogleApproval | McpCallApproval;

// ───────────────────────────── MCP broker: connections ─────────────────────────────
// docs/MCP-BROKER.md. Stored since migration 8; nothing serves these until the broker PRs land (behind the
// brokerUpstreams setting). Credentials never cross the API boundary: there's no DTO for them.
// AccessLevel and ToolAnnotations mirror server/broker/types.ts: the console can't import that file (it uses
// Node's Buffer, and tsconfig.app has no Node types). Keep them in step.

/** native_whoop (M2), stdio (M4) and native_google are reserved; M1 creates remote_http only. */
export const CONNECTION_KINDS = ["remote_http", "native_whoop", "stdio", "native_google"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const CONNECTION_AUTH_TYPES = ["none", "header", "oauth"] as const;
export type ConnectionAuthType = (typeof CONNECTION_AUTH_TYPES)[number];

export const CONNECTION_STATUSES = ["active", "needs_reauth", "error", "disabled"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/**
 * What an agent may do with a connection (Wynn's model). No grant row = no access.
 * - full: every tool listed and called without asking
 * - ask: every tool listed; risky (irreversible) tools wait for an mcp.call approval. The default.
 * - read: only read tools are listed or callable
 */
export const ACCESS_LEVELS = ["full", "ask", "read"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** Connection slugs, chosen by the operator: tools are exposed as `<slug>__<tool>`. Same rule as the schema CHECK. */
export const CONNECTION_SLUG_RE = /^[a-z0-9-]{1,24}$/;
/** Exposed tool names: `[A-Za-z0-9_-]`, at most 64 (clients prepend `mcp__<server>__` and cap at 128). */
export const EXPOSED_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** One upstream (an MCP server, or a native integration) with its credential. */
export interface Connection {
  id: string; // con_…
  /** null = the install's single owner. */
  ownerId: string | null;
  kind: ConnectionKind;
  /** IntegrationPreset.id (server/broker/types.ts), checked against the preset registry in code; null = custom. */
  preset: string | null;
  slug: string;
  name: string;
  /** The MCP endpoint (remote_http). */
  url: string | null;
  authType: ConnectionAuthType;
  /** The level new grants get. */
  levelDefault: AccessLevel;
  /** "All agents": agents created later get it too, at levelDefault. */
  allAgents: boolean;
  /** Admin-only private-target allow: the exact `scheme://host:port`, or null when off. */
  privateTarget: string | null;
  status: ConnectionStatus;
  statusReason: string | null;
  /** When the credential stops working without a human (no refresh, or a hard cap); null = not known to expire. */
  expiresAt: string | null;
  /** Negotiated protocol generation, cached. */
  protocol: string | null;
  toolsCachedAt: string | null;
  instructionsHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/** MCP tool annotations as the upstream sent them: hints only, never trusted on their own. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool definition as pinned (upstream_tools.definition). The pin hashes this plus the tool's name. */
export interface UpstreamToolDefinition {
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export type ToolClassSource = "preset" | "annotation" | "heuristic";

export interface UpstreamTool {
  connectionId: string;
  /** The upstream's own name. */
  name: string;
  /** `<slug>__<name>`, as listed to agents. */
  exposedName: string;
  /** What agents see: the upstream's latest definition (a change is used at once and audited). */
  definition: UpstreamToolDefinition;
  /** The definition's hash; a different one on a later listing is audited as connection.tool_changed. */
  pinHash: string;
  /** Irreversible: waits for approval at the "ask" level. */
  risky: boolean;
  /** Listed at the "read" level. Never both risky and read. */
  read: boolean;
  classSource: ToolClassSource;
  firstSeenAt: string;
  updatedAt: string;
}

/** One agent's access to one connection. */
export interface ConnectionGrant {
  agentId: string;
  connectionId: string;
  level: AccessLevel;
  createdAt: string;
  updatedAt: string;
}

/** "Always allow this": matching calls by this agent to this tool never ask again. */
export interface ApprovalRule {
  id: string; // rul_…
  agentId: string;
  connectionId: string;
  /** The upstream tool name (UpstreamTool.name). */
  tool: string;
  /** Only for one target: a JSON Pointer into the call's arguments, and that argument's canonical JSON. */
  targetPath: string | null;
  targetValue: string | null;
  createdAt: string;
}

// ───────────────────── MCP broker: connections admin API (/api/connections) ─────────────────────

/** A connection as the Connections list shows it. */
export interface ConnectionView extends Connection {
  tools: {
    /** Every tool the upstream lists (all usable: a changed tool is never held). */
    total: number;
  };
  /** Whole days until expiresAt (0 = today or past), or null when not known to expire. */
  expiresInDays: number | null;
  /**
   * The credential's lifetime is over (expiresAt is past: T3 Code's 30 days without refresh, or a preset's cap, or a
   * 401 with no refresh token). Only Reconnect brings it back; agents are told so. The stored status is needs_reauth.
   */
  expired: boolean;
  /**
   * OAuth scopes the server granted with the current sign-in (space-separated token response `scope`, split), or null
   * when not signed in with OAuth. May hold more than was asked for (T3 Code's Full access adds settings:write and
   * source-control:write) or less (its Read only grants orchestration:read alone).
   */
  grantedScopes: string[] | null;
  /**
   * Scopes that mean broad access on this connection's extension (its manifest's `remote.auth.broadScopes`, e.g. T3
   * Code's settings:write): the console warns when grantedScopes include any. null when the extension names none.
   */
  broadScopes: string[] | null;
  /**
   * What granted scopes mean on this connection's extension (its manifest's `remote.auth.scopeNotes`), in priority
   * order: the console shows the first granted one's note. null when the extension names none.
   */
  scopeNotes: { scope: string; note: string }[] | null;
  /** Agents with a grant on this connection. */
  agents: number;
}

/** POST /api/connections: a custom MCP URL, or a preset (its URL and auth come from the preset). */
export interface CreateConnectionInput {
  /** IntegrationPreset.id (GET /api/connections/presets). */
  preset?: string;
  /** Required without a preset, and with a preset whose server the user names (PresetView.userServer). */
  url?: string;
  /**
   * Default: the preset's display name, else the URL's host (`host:port`), with " (2)", " (3)"… when taken. Names are
   * unique per owner (case-insensitive): a name given here that's taken is a 409.
   */
  name?: string;
  /** Default: the preset's slug (`<slug>-<host>` for PresetView.userServer), else derived from the host. */
  slug?: string;
  levelDefault?: AccessLevel;
  /** Agents that get the connection at levelDefault. Default: every agent, including ones created later (allAgents). */
  agentIds?: string[];
}

/**
 * PATCH /api/connections/:id. Changing the URL (custom connections only) deletes the credentials, clears the
 * private-target allow, cancels pending calls and sets status needs_reauth: reconnect afterwards.
 */
export interface UpdateConnectionInput {
  /** true: every agent without access gets it at levelDefault now, and agents created later too. */
  allAgents?: boolean;
  name?: string;
  slug?: string;
  url?: string;
  levelDefault?: AccessLevel;
}

/** PUT /api/connections/:id/grants: the full list; agents not listed lose access. */
export interface ConnectionGrantsInput {
  grants: { agentId: string; level: AccessLevel }[];
}

/** PUT /api/connections/:id/private-target. Admin-only: the allow is pinned to the URL's exact scheme://host:port. */
export interface PrivateTargetInput {
  allow: boolean;
}

/** What probing an MCP URL found (POST /api/connections/probe), so the console shows the right button or field. */
export interface ConnectionProbe {
  reachable: boolean;
  /** none: open; header: needs an API key or bearer; oauth: OAuth discovered; unknown: couldn't tell. */
  auth: "none" | "header" | "oauth" | "unknown";
  /** private_target: the host is on loopback or a private network and the connection has no allow for it. */
  blocked?: "private_target" | "ssrf";
  /** OAuth: the authorization server's issuer and how the client registers. */
  issuer?: string;
  registration?: "preregistered" | "metadata_document" | "dcr" | "manual";
  /** OAuth: the server issues refresh tokens (false: dated reconnect warnings). */
  refresh?: boolean;
  /** blocked: the exact scheme://host:port an admin could allow for this connection, when an allow would help. */
  privateTarget?: string | null;
  /** Plain words for the console. */
  message: string;
}

/** POST /api/connections/:id/connect. */
export interface StartConnectInput {
  /** Static header auth (bearer or API key). Stored encrypted; never returned. */
  header?: { name: string; value: string };
  /** Setup inputs (e.g. a pasted client id and secret), keyed by SetupStepView.input.key. */
  inputs?: Record<string, string>;
}

export type StartConnectResult =
  | { status: "connected"; connection: ConnectionView }
  /**
   * Open this URL (the OAuth popup). direct: /oauth/connections/callback finishes the connection; paste: the user
   * copies the landing URL into POST /api/connections/finish.
   */
  | { status: "authorize"; authorizeUrl: string; callbackMode?: "direct" | "paste"; redirectUri?: string }
  | { status: "error"; message: string; probe?: ConnectionProbe };

/** One step of a preset's guided setup (server/broker/types.ts SetupStep), resolved for this install. */
export interface SetupStepView {
  id: string;
  title: string;
  body: string;
  link?: { label: string; url: string };
  copy?: { label: string; value: string };
  input?: { key: string; label: string; secret?: boolean; pattern?: string; placeholder?: string };
}

/** GET /api/connections/presets. */
export interface PresetView {
  id: string;
  displayName: string;
  slug: string;
  kind: "remote_http" | "native";
  url: string | null;
  authType: ConnectionAuthType;
  setupSteps: SetupStepView[];
  reconnectPolicy: { maxLifetimeDays?: number; idleDays?: number; tokenLifetimeCapDays?: number } | null;
  /** From the official xaq extensions (or core). false: third-party, shown with a badge; its risk map only adds risk. */
  official: boolean;
  /**
   * The user names the server (T3 Code, Brightspace): `url` is null, CreateConnectionInput.url is required, and `defaultPath` is
   * appended when only an origin is given. One connection per server, named after its host unless named.
   */
  userServer: { defaultPath: string } | null;
}

// ───────────────────────────── Audit ─────────────────────────────

export interface AuditEntry {
  id: number;
  ts: string;
  actorType: ActorType;
  actorId: string | null;
  actorName: string | null;
  action: string; // MCP tool name or console action, e.g. "send_message", "agent.create"
  accountId: string | null;
  target: string | null; // message/thread/draft id
  outcome: AuditOutcome;
  /** For denials: the guardrail that blocked it, e.g. "allow_to", "label_scope", "rate_limit". */
  reason: string | null;
  durationMs: number | null;
  detail: Record<string, unknown> | null;
}

// ───────────────────────────── Overview ─────────────────────────────

export interface OverviewStats {
  accounts: { total: number; active: number; needsAttention: number };
  agents: { total: number; activeLast24h: number };
  events24h: number;
  deliveries24h: { succeeded: number; failed: number };
  pendingApprovals: number;
  toolCalls24h: number;
  denied24h: number;
  /** Hourly buckets for the last 24h, oldest first. */
  activity: { hour: string; events: number; toolCalls: number }[];
}

// ───────────────────────────── Pagination & errors ─────────────────────────────

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page; null when exhausted. */
  nextCursor: string | null;
}

/** All non-2xx console API responses have this body. */
export interface ApiError {
  /** `email`: only on oauth_already_connected (from the authenticated paste endpoint), the account that sign-in connected. */
  error: { code: string; message: string; hint?: string; email?: string };
}

// ───────────────────────────── Console API route map ─────────────────────────────
// Session: cookie `aib_session` (HttpOnly, SameSite=Lax). Mutating requests must send header
// `x-agentinbox-csrf: 1` (simple CSRF guard; the console fetch wrapper always sets it).
//
// Unauthenticated:
//   GET    /api/health                                → HealthResponse
//   GET    /api/setup/status                          → SetupStatus
//   POST   /api/setup/claim {token,password}          → 204 + session cookie (only while unclaimed)
//   POST   /api/setup/verify-token {token}            → 204 when the setup token is right (same limiter as claim)
//   POST   /api/auth/login {password}                 → 204 + session cookie (5 failures/IP → 15 min lockout)
//   POST   /api/auth/logout                           → 204
//   GET    /oauth/callback?code&state                 → HTML result page; posts an OAuthCallbackMessage (ok/email or error/code/hint)
//                                                       to its opener and on BroadcastChannel "agentinbox-oauth"
//
// Authenticated (admin session):
//   GET    /api/setup/state                           → SetupState
//   GET    /api/system                                → SystemInfo
//   GET    /api/system/latest                         → UpdateInfo   (npm registry check, cached 30 min)
//   GET    /api/settings                              → Settings
//   PATCH  /api/settings Partial<Settings>            → Settings
//   POST   /api/auth/password {current,next}          → 204
//   GET    /api/google/client                         → GoogleClientView
//   PUT    /api/google/client GoogleClientConfig      → GoogleClientSaveResult   (manual entry; fallback to import; runs the check)
//   POST   /api/google/client/check                   → GoogleClientCheck   (400 google_client_missing when nothing is saved)
//   POST   /api/google/client/import GoogleClientImportInput → GoogleClientImportResult   (runs the check)
//          400 client_json_invalid | client_json_desktop | client_secret_missing | bad_request (see GoogleClientImportResult)
//   POST   /api/google/pubsub/provision {accountId?}  → PubsubState   (creates topic + IAM + subscription using the principal account's token;
//          `accountId` chooses the principal: saved as pending (PubsubState.pendingPrincipal*), so the follow-up
//          POST /api/accounts/connect {scopes:["pubsub"]} targets it; it becomes the principal only when provisioning succeeds)
//          409 pubsub_scope_required (the principal hasn't granted the Pub/Sub scope: run that incremental consent, retry)
//          409 needs_reauth | 409 account_paused (chosen account unusable) | 404 not_found (unknown accountId)
//          400 pubsub_permission_denied (principal lacks roles/pubsub.admin or Owner; hint: IAM link + gcloud command)
//              | pubsub_billing | pubsub_org_policy (Domain Restricted Sharing; hint: org policy link, polling alternative)
//              | pubsub_api_disabled | gmail_api_disabled | pubsub_publish_denied | pubsub_project_not_found
//              | pubsub_project_missing | pubsub_no_account | pubsub_provision_failed (anything else)
//   POST   /api/google/pubsub/test                    → PubsubTestResult
//   GET    /api/accounts                              → Account[]
//   POST   /api/accounts/connect ConnectAccountInput  → ConnectAccountResponse
//          400 google_client_missing (no OAuth client saved yet)
//          {reauthAccountId, scopes:["calendar"]}: the per-account "Add Google Calendar" consent (include_granted_scopes:
//          mail keeps working throughout; denying or unticking Calendar changes nothing). Its completion fails with
//          400 oauth_calendar_not_granted when Calendar was (partly) unticked, and a cancel's oauth_access_denied says
//          nothing changed, as does oauth_admin_policy_enforced (ask the admin to trust the app). On other consents that
//          asked for Calendar, oauth_admin_policy_enforced hints at reconnecting with {mailOnly:true} or turning Calendar
//          off (PATCH /api/google/calendar {enabled:false}).
//   POST   /api/accounts/connect/complete {url}       → Account   (paste mode)
//   POST   /api/accounts/connect/status {state}       → ConnectAttempt (the console's fallback when the callback page can't post to it)
//          Connect failures (same codes on this endpoint and in the callback page's OAuthCallbackMessage):
//          400 oauth_access_denied (cancelled on Google's screen) | oauth_org_internal | oauth_admin_policy_enforced
//              | oauth_redirect_uri_mismatch | oauth_invalid_client | oauth_unauthorized_client | oauth_invalid_grant
//              | oauth_<other Google error> | oauth_state (expired/used link) | oauth_no_code | oauth_url_invalid
//              | oauth_gmail_scope_missing | oauth_no_refresh_token | oauth_wrong_account | oauth_account_removed
//              | gmail_api_disabled | google_client_missing;  502 google_error
//   POST   /api/accounts/:id/resync                   → Account
//   POST   /api/accounts/:id/pause | /resume          → Account
//   DELETE /api/accounts/:id                          → 204 (stops watch, revokes token, deletes grants)
//   GET    /api/accounts/:id/labels                   → GmailLabel[]
//   GET    /api/accounts/:id/calendars                → CalendarInfo[]   (live calendarList, for the grant editor's calendar scope)
//          409 calendar_not_granted (missing scopes; hint: run the per-account consent) | 409 calendar_api_disabled | 409 needs_reauth
//   GET    /api/google/calendar                       → CalendarSetupState
//   PATCH  /api/google/calendar CalendarSetupInput    → CalendarSetupState   (enable = start "Add Google Calendar"; dismiss the notice)
//   POST   /api/google/calendar/check                 → CalendarSetupState   (probes every account with the scopes: API on? scopes still granted?)
//   POST   /api/accounts/:id/test-email               → TestEmailResult   (sends "xaq test: your setup works" from the
//          account to itself, then processes new mail at once; the resulting events are message.sent and message.received
//          (the latter only for this test message). Audited as account.test_email. 409 account_paused | 409 needs_reauth
//          | 429 rate_limited (5 per account per 10 min; hint says when to retry))
//   GET    /api/agents                                → Agent[]
//   POST   /api/agents CreateAgentInput               → AgentWithKey
//   GET    /api/agents/:id                            → Agent
//   PATCH  /api/agents/:id {name?,description?,disabled?} → Agent
//   POST   /api/agents/:id/rotate-key                 → AgentWithKey
//   DELETE /api/agents/:id                            → 204
//   PUT    /api/agents/:id/grants/:accountId GrantInput → Grant   (upsert; one grant per agent×account)
//   DELETE /api/agents/:id/grants/:accountId          → 204
//   POST   /api/agents/:id/test                       → AgentTestResult (runs MCP initialize+tools/list as the agent)
//   GET    /api/webhooks?agentId                      → Webhook[]
//   POST   /api/webhooks WebhookInput                 → WebhookWithSecret
//   PATCH  /api/webhooks/:id Partial<WebhookInput>    → Webhook
//   POST   /api/webhooks/:id/rotate-secret            → WebhookWithSecret
//   POST   /api/webhooks/:id/test                     → Delivery  (sends a synthetic event synchronously)
//   DELETE /api/webhooks/:id                          → 204
//   GET    /api/deliveries?webhookId&status&cursor    → Page<Delivery>
//   POST   /api/deliveries/:id/replay                 → Delivery
//   GET    /api/events?accountId&type&cursor          → Page<MailEvent>
//   GET    /api/events/stream                         → text/event-stream of ConsoleStreamMessage (SSE `data:` = JSON)
//   GET    /api/pairings?status                       → PairingRequest[]
//   POST   /api/pairings/:id/approve ApprovePairingInput → Agent   (the key goes to the polling CLI, never to the console)
//   POST   /api/pairings/:id/deny {note?}             → PairingRequest
//   (MCP broker, 404 unless Settings.brokerUpstreams)
//   GET    /api/connections                           → ConnectionView[]
//   POST   /api/connections CreateConnectionInput     → ConnectionView
//   GET    /api/connections/presets                   → PresetView[]
//   POST   /api/connections/probe {url, connectionId?} → ConnectionProbe
//   GET    /api/connections/:id                       → ConnectionView
//   PATCH  /api/connections/:id UpdateConnectionInput → ConnectionView
//   DELETE /api/connections/:id                       → 204 (kill switch, then removal)
//   POST   /api/connections/:id/kill                  → 204 (disabled; onKill hooks, then credentials deleted and pending calls cancelled)
//   POST   /api/connections/:id/connect StartConnectInput → StartConnectResult
//   POST   /api/connections/finish {url}               → StartConnectResult (paste mode: the copied landing URL)
//   GET    /api/connections/:id/grants                → ConnectionGrant[]
//   PUT    /api/connections/:id/grants ConnectionGrantsInput → ConnectionGrant[]
//   PUT    /api/connections/:id/private-target PrivateTargetInput → ConnectionView
//   POST   /api/connections/:id/refresh               → { ok, error, connection: ConnectionView } (list the tools again now)
//   GET    /api/approvals?status                      → Approval[]
//   POST   /api/approvals/:id/approve {note?}         → Approval
//   POST   /api/approvals/:id/reject {note?}          → Approval
//   GET    /api/audit?agentId&outcome&cursor          → Page<AuditEntry>
//   GET    /api/overview                              → OverviewStats
//
// Agent-facing (bearer = agent API key):
//   POST/GET/DELETE /mcp                               MCP streamable HTTP (stateless)
//   GET    /skill.md                                   the agent skill (public, no secrets)
//   /agent/v1/*                                        pairing + listener stream (see shared/agent-api.ts)
//   GET    /health                                     HealthResponse (alias of /api/health for uptime monitors; 503 when degraded)
//
// Google-facing (unauthenticated; verified by channel id + X-Goog-Channel-Token):
//   POST   /google/calendar/push                       Calendar push notifications (events.watch channels) → 204

export type ConsoleStreamMessage =
  | { kind: "event"; data: MailEvent }
  | { kind: "delivery"; data: Delivery }
  | { kind: "approval"; data: Approval }
  | { kind: "audit"; data: AuditEntry }
  | { kind: "account"; data: Account }
  | { kind: "pairing"; data: PairingRequest }
  /** An agent's state changed: listener connect/disconnect/ack (at most ~1/s), first use and lastMcpAt, access changes. */
  | { kind: "agent"; data: Agent };
