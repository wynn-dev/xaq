// Google domain contract. Owned by the Google + ingest work area.
// Members marked FROZEN are used by other domains: do not rename or change them. Adding members is fine.

import type {
  Account,
  AccountStatus,
  Address,
  Attachment,
  ConnectAccountResponse,
  ConnectAttempt,
  ExtraScopeName,
  GmailLabel,
  GoogleClientCheck,
  GoogleClientConfig,
  GoogleClientImportInput,
  GoogleClientImportResult,
  GoogleClientView,
  MessageSummary,
  PubsubState,
  PubsubTestResult,
  SetupWarning,
  TestEmailResult,
} from "../../shared/types.ts";
import type { Lifecycle } from "../context.ts";
import type { CalendarClient } from "./calendar.ts";

// ───────────── Raw Gmail REST shapes (subset of https://developers.google.com/gmail/api/reference/rest) ─────────────

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: GmailHeader[];
  /** `data` is base64url; large parts and attachments have `attachmentId` instead. */
  body: { attachmentId?: string; size: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  /** Epoch milliseconds as a string. */
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
  /** Only with format=raw: base64url RFC 5322. */
  raw?: string;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  snippet?: string;
  messages?: GmailMessage[];
}

export interface GmailDraft {
  id: string;
  message: GmailMessage;
}

export interface GmailLabelRaw {
  id: string;
  name: string;
  type: "system" | "user";
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
}

type HistoryMessageRef = { message: GmailMessage };
type HistoryLabelChange = { message: GmailMessage; labelIds: string[] };

export interface GmailHistoryRecord {
  id: string;
  messages?: GmailMessage[];
  messagesAdded?: HistoryMessageRef[];
  messagesDeleted?: HistoryMessageRef[];
  labelsAdded?: HistoryLabelChange[];
  labelsRemoved?: HistoryLabelChange[];
}

export type GmailFormat = "full" | "metadata" | "minimal" | "raw";

// ───────────── Errors (FROZEN) ─────────────

/** Extra structure parsed from a Google error body (not frozen; informational). */
export interface GoogleErrorDetails {
  /** Canonical status, e.g. "PERMISSION_DENIED", or the OAuth `error` code, e.g. "invalid_grant". */
  status?: string;
  /** Every reason found: errors[].reason, ErrorInfo.reason, PreconditionFailure violation types. */
  reasons?: string[];
  /** ErrorInfo metadata, e.g. { service: "pubsub.googleapis.com" }. */
  metadata?: Record<string, string>;
  /** Parsed Retry-After header. */
  retryAfterMs?: number;
}

/** Any non-2xx from a Google API, after retries. */
export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Google's error `reason`/`status` string when present, e.g. "notFound", "PERMISSION_DENIED". */
    readonly reason: string | null = null,
    readonly details: GoogleErrorDetails = {},
  ) {
    super(message);
  }

  get notFound(): boolean {
    return this.status === 404;
  }
}

/**
 * The account's refresh token was revoked or expired (`invalid_grant`). By the time this is thrown,
 * the account is already marked `needs_reauth` and `account.auth_failed` was emitted.
 */
export class AccountNeedsReauthError extends Error {
  constructor(
    readonly accountId: string,
    readonly email: string,
  ) {
    super(`The Gmail account ${email} needs to be reconnected in the xaq console.`);
  }
}

/**
 * A downscoped token was asked for scopes the account hasn't granted xaq (never asked for, unticked on Google's
 * screen, or revoked since). Nothing is marked: the account's own access is unchanged. `missing` are full scope URLs.
 */
export class ScopesNotGrantedError extends Error {
  constructor(
    readonly accountId: string,
    readonly email: string,
    readonly missing: string[],
  ) {
    super(`${email} hasn't given xaq this access yet (missing: ${missing.join(", ")}).`);
    this.name = "ScopesNotGrantedError";
  }
}

/**
 * Google's answer to a downscoped refresh didn't prove the token is limited to what was asked for: it named other
 * scopes too, or none at all. The token is dropped, never handed out (server/google/tokens.ts scopedAccessToken).
 */
export class DownscopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownscopeError";
  }
}

// ───────────── Gmail client (FROZEN) ─────────────

export interface ListParams {
  q?: string;
  labelIds?: string[];
  maxResults?: number;
  pageToken?: string;
  includeSpamTrash?: boolean;
}

/**
 * Thin, quota-aware Gmail REST client bound to one account (userId "me"). Refreshes the access token
 * transparently, retries 429/5xx with backoff, throws GoogleApiError or AccountNeedsReauthError.
 */
export interface GmailClient {
  readonly accountId: string;
  getProfile(): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number; historyId: string }>;
  listMessages(p: ListParams): Promise<{ messages: { id: string; threadId: string }[]; nextPageToken: string | null; resultSizeEstimate: number }>;
  listThreads(p: ListParams): Promise<{ threads: { id: string; snippet: string; historyId: string }[]; nextPageToken: string | null; resultSizeEstimate: number }>;
  getMessage(id: string, format?: GmailFormat, metadataHeaders?: string[]): Promise<GmailMessage>;
  getThread(id: string, format?: Exclude<GmailFormat, "raw">, metadataHeaders?: string[]): Promise<GmailThread>;
  /** Returns base64url data. */
  getAttachment(messageId: string, attachmentId: string): Promise<{ data: string; size: number }>;
  listLabels(): Promise<GmailLabelRaw[]>;
  modifyMessage(id: string, add: string[], remove: string[]): Promise<GmailMessage>;
  modifyThread(id: string, add: string[], remove: string[]): Promise<GmailThread>;
  trashMessage(id: string): Promise<GmailMessage>;
  trashThread(id: string): Promise<GmailThread>;
  /** `raw` is base64url RFC 5322 (see MimeTools.compose). */
  send(raw: string, threadId?: string | null): Promise<GmailMessage>;
  createDraft(raw: string, threadId?: string | null): Promise<GmailDraft>;
  getDraft(draftId: string): Promise<GmailDraft>;
  sendDraft(draftId: string): Promise<GmailMessage>;
  deleteDraft(draftId: string): Promise<void>;
  /** Throws GoogleApiError with status 404 when startHistoryId is too old. */
  listHistory(p: { startHistoryId: string; pageToken?: string; maxResults?: number; historyTypes?: string[] }): Promise<{
    history: GmailHistoryRecord[];
    nextPageToken: string | null;
    historyId: string;
  }>;
  watch(p: { topicName: string; labelIds?: string[]; labelFilterBehavior?: "include" | "exclude" }): Promise<{ historyId: string; expiration: string }>;
  stopWatch(): Promise<void>;
}

// ───────────── MIME (FROZEN) ─────────────

export interface ParsedMessage {
  summary: MessageSummary;
  /** Lower-cased header name → first value. Only free-text headers (Subject, …) are RFC 2047-decoded. */
  headers: Record<string, string>;
  /** RFC 5322 Message-ID (with angle brackets), for threading replies. */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  replyTo: Address[];
  /** Decoded text/plain body (preferring the top-level alternative), or null. */
  text: string | null;
  /** Decoded text/html body, or null. Not sanitized: content cleaning is server/mail's job. */
  html: string | null;
  attachments: Attachment[];
  /** Raw Authentication-Results header(s) joined with "\n", or null. */
  authenticationResults: string | null;
  /**
   * Text/html bodies Gmail returned by reference (very large parts); `text`/`html` are null for these.
   * Fill them with `loadLargeBodies(gmail, messageId, parsed)` from server/google/mime.ts.
   */
  largeBodies?: LargeBody[];
}

export interface LargeBody {
  kind: "text" | "html";
  attachmentId: string;
  charset: string | null;
}

export interface ComposeInput {
  from: Address;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  replyTo?: Address[];
  subject: string;
  text: string;
  html?: string;
  /** Threading headers for replies. */
  inReplyTo?: string | null;
  references?: string[];
  attachments?: { filename: string; contentType?: string; content: Buffer }[];
  /** Extra header lines, e.g. { "X-Agentinbox-Test": "setup" }. */
  headers?: Record<string, string>;
}

export interface MimeTools {
  /** Needs a format=full message. */
  parse(msg: GmailMessage): ParsedMessage;
  /** Works with format=metadata (From/To/Cc/Subject/Date headers) or full. */
  summarize(msg: GmailMessage): MessageSummary;
  /** Builds an RFC 5322 message with nodemailer's MailComposer; returns base64url for send/createDraft. */
  compose(input: ComposeInput): Promise<string>;
  /** Parses an address header value ("A <a@x>, b@y") into Address[]. */
  parseAddresses(value: string | null | undefined): Address[];
}

// ───────────── Services ─────────────

/** Accounts repository (FROZEN). Token and cursor columns are private to server/google and server/ingest. */
export interface AccountsService extends Lifecycle {
  list(): Account[];
  get(id: string): Account | null;
  /** Throws HttpError 404. */
  require(id: string): Account;
  getByEmail(email: string): Account | null;
  /** Persists and emits bus "account". */
  setStatus(id: string, status: AccountStatus, lastError?: string | null): Account;
  /** Stops the watch, revokes the token (best effort) and deletes the account (grants cascade). */
  remove(id: string): Promise<void>;
}

export interface GoogleService extends Lifecycle {
  // OAuth client
  clientView(): GoogleClientView;
  setClient(input: GoogleClientConfig): GoogleClientView;
  /** Imports Google's downloaded client-secret JSON (Web application clients only). */
  importClient(input: GoogleClientImportInput): Omit<GoogleClientImportResult, "check">;
  /** Asks Google whether the saved client ID, secret and redirect URI work (GoogleClientCheck). */
  checkClient(): Promise<GoogleClientCheck>;
  redirectUri(): string;
  /** Setup problems derived from the client config and connected accounts (SetupState.warnings). */
  setupWarnings(): SetupWarning[];

  // Connecting accounts (PKCE, access_type=offline, prompt=consent)
  /**
   * Accounts are connected with gmail.modify (+ openid email profile), plus CALENDAR_SCOPES while Calendar
   * is part of the install. `scopes: ["pubsub"]` adds the Pub/Sub scope incrementally for the provisioning
   * account (defaults to the account provisioning uses); `scopes: ["calendar"]` adds Calendar (with
   * `reauthAccountId`: "Add Calendar to <email>"). `mailOnly` leaves Calendar out (for admins who block it).
   */
  startConnect(opts?: { reauthAccountId?: string; scopes?: ExtraScopeName[]; mailOnly?: boolean }): ConnectAccountResponse;
  /** Exchanges the code, stores the encrypted refresh token, upserts the account and calls ingest.onAccountConnected. */
  completeConnect(code: string, state: string): Promise<Account>;
  /** Paste mode: the full URL the user landed on after consent. */
  completeConnectFromUrl(url: string): Promise<Account>;
  /** What became of the sign-in started with this state (the callback page can't always tell the console). */
  connectAttempt(state: string): ConnectAttempt;

  /** FROZEN. Gmail client for an account (cheap; may be cached). */
  gmail(accountId: string): GmailClient;
  /** FROZEN. Google Calendar client for an account (cheap; may be cached). See server/google/calendar.ts. */
  calendar(accountId: string): CalendarClient;
  /** FROZEN. */
  readonly mime: MimeTools;
  /**
   * FROZEN. Labels with ids and names, as shown in the console and to agents. Cached ~60 s; pass
   * `fresh: true` on a lookup miss (e.g. a label just created in Gmail) to refetch.
   */
  labels(accountId: string, opts?: { fresh?: boolean }): Promise<GmailLabel[]>;
  revoke(accountId: string): Promise<void>;
  /** Sends a self-addressed test message from the account and kicks ingest. Rate limited (HttpError 429). */
  sendTestEmail(accountId: string): Promise<TestEmailResult>;

  // Pub/Sub
  pubsubState(): PubsubState;
  /** `accountId` chooses (and saves) the principal account; default: the current principal. */
  provisionPubsub(opts?: { accountId?: string }): Promise<PubsubState>;
  testPubsub(): Promise<PubsubTestResult>;
}
