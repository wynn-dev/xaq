/**
 * In-memory fake of every Google endpoint xaq calls (OAuth, Gmail REST, Calendar, Drive read-only), served by
 * node:http on 127.0.0.1:<random port>. Deterministic and fast; used by unit tests and the end-to-end test.
 *
 *   const g = await startFakeGoogle();
 *   const { ctx } = testContext({}, { google: g.google });       // all four base URLs point at the fake
 *   ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" }); // the fake only accepts FAKE_CLIENT
 *   g.addAccount("me@example.com", { name: "Me" });
 *   g.consentAs("me@example.com");                                 // next /o/oauth2/v2/auth request consents as this account
 *   const { authUrl } = ctx.google.startConnect();
 *   const res = await fetch(authUrl, { redirect: "manual" });       // 302 → redirect_uri?code=…&state=…
 *   await ctx.google.completeConnectFromUrl(res.headers.get("location")!);
 *   g.deliver("me@example.com", { from: "Bob <bob@x.com>", subject: "Hi", text: "Hello" });
 *   await g.close();
 *
 * State helpers
 *   addAccount(email, { name?, workspaceDomain? })  create a mailbox (workspaceDomain → the id_token carries hd=<domain>)
 *   addLabel(email, name) → id                     create a user label ("Label_N")
 *   consentAs(email, { deny?, noRefreshToken?, scopes? })  queue the next consent (otherwise the only account, if exactly one exists)
 *   deliver(email, msg) → GmailMessage             incoming mail: builds RFC 5322, adds INBOX+UNREAD (or msg.labelIds), records
 *                                                  history
 *   setLabels(email, messageId, add, remove)       label change with history (unknown user label ids are created)
 *   failRefresh(email, { rapt? })                  revoke the user's grant: refresh → 400 invalid_grant (error_subtype invalid_rapt with rapt)
 *   expireAccessTokens(email)                      make cached access tokens invalid (next API call → 401)
 *   expireHistory(email)                           history.list with any cursor obtained before this call → 404
 *   disableApi("gmail", on)                    API calls → 403 SERVICE_DISABLED
 *   failNext({ method?, path, status, reason?, message?, retryAfter?, times?, afterProcessing? })  inject errors for matching
 *                                                  requests (afterProcessing: the request takes effect, then the error is returned)
 *   accessTokenTtl                                 seconds for newly issued access tokens (default 3600)
 *   registeredRedirectUris                         null (default): any redirect URI is accepted. A list emulates the client's
 *                                                  Authorized redirect URIs: others get Google's redirect_uri_mismatch error page
 *   refreshTokenTtl                                null (default): long-lived refresh tokens. A number simulates an External app in
 *                                                  Testing: new refresh tokens expire after that many seconds (Google: 604800) and
 *                                                  token responses carry refresh_token_expires_in (time left, on refreshes too)
 *
 * Inspection
 *   sent(email) / drafts(email) / messages(email) / message(email, id)   format=full Gmail JSON (+ drafts as {id, message})
 *   revoked (tokens)  requests ({method, path} log)
 *
 * Consent screen like Google's for a signed-out browser: an unknown client_id or unregistered redirect URI
 * redirects to /signin/oauth/error/v2?authError=<base64 "Error 401: invalid_client" / "Error 400: redirect_uri_mismatch">;
 * a request without PKCE (not xaq's connect flow, e.g. the client check) redirects to /v3/signin/identifier.
 * The token endpoint answers invalid_client for a wrong client id or secret before looking at the code.
 *
 * OAuth grants are per user (like Google): revoking any token of a user revokes all of that user's tokens, and
 * consent with include_granted_scopes=true adds to the scopes granted before. Unknown routes (or wrong verbs)
 * get Google's HTML 404. Payload headers keep structured values (From, To, Message-ID, …) raw and decode
 * encoded-words only in free-text headers (Subject).
 *
 * Google Calendar (`g.calendar.*`, routes under /calendar/v3; every account starts with a primary calendar whose id is its email)
 *   addCalendar(email, { name, accessRole?, id?, timeZone?, hidden? }) → id    a calendar in the account's list (default role owner)
 *   removeCalendar(email, calendarId)              deleted or unshared: gone from the list, its routes answer 404
 *   putEvent(email, calendarId, event) → event     create, or replace by id (bumps `updated`, etag and the change log sync tokens read)
 *   invite(organizer, attendees, event) → event    the organizer's event (when the organizer is a fake account) plus each fake
 *                                                  attendee's copy on their primary calendar (same id, `self`, needsAction), like Google
 *   respond(email, eventId, status)                a human RSVP, copied into the organizer's and the other copies
 *   cancelEvent(email, calendarId, eventId)        cancel (the organizer's cancel reaches every copy)
 *   events(email, calendarId) / event(email, calendarId, id)    live events / any event or recurring instance (null if none)
 *   expireSyncTokens(email, calendarId?)           sync tokens handed out so far → 410 fullSyncRequired
 *   disableApi("calendar", on)                     403 SERVICE_DISABLED (accessNotConfigured, ErrorInfo metadata.activationUrl)
 *   mailsSent(email)                               emails Google would have sent for that account's API writes (sendUpdates
 *                                                  all / externalOnly = non-fake guests): { to, kind: invite|update|cancel|reply, eventId }
 * Routes check the token's scopes like Google (consentAs { scopes } simulates granular consent → 403
 * ACCESS_TOKEN_SCOPE_INSUFFICIENT): calendarList needs calendar.calendarlist(.readonly), events calendar.events,
 * freeBusy calendar.events.freebusy (or the broad calendar scopes). events.list: syncToken (400 next to timeMin/timeMax/q/
 * orderBy/iCalUID/updatedMin/…, or a different singleEvents; deletions come back as id-only "cancelled" items),
 * pageToken/maxResults (nextSyncToken on the last page only), timeMin/timeMax overlap, q, iCalUID, showDeleted,
 * singleEvents (expands RRULE DAILY/WEEKLY with INTERVAL, COUNT, UNTIL, BYDAY and EXDATE, in UTC; instance ids
 * `<series>_<YYYYMMDDTHHMMSSZ>`) and orderBy=startTime. PATCH/DELETE honor If-Match (412) and answer 410 for deleted
 * events; invitees may only change their own response (403 forbiddenForNonOrganizer); insert with an id that exists → 409,
 * with an id that isn't base32hex (a-v0-9, 5–1024 chars) → 400. Unexpanded listings include cancelled occurrences of live series.
 *
 * Google Workspace files (code extensions' Google access; config.google.apisBase points here), on the Drive store
 * (`g.drive.addFile`): GET /drive/v3/about, /drive/v3/files, /v1/documents/:id, /v4/spreadsheets/:id,
 * /v1/presentations/:id. Each checks the token, then the API (disableApi("drive" | "docs" | "sheets" | "slides") → 403
 * SERVICE_DISABLED), then its scopes.
 *   tokenScopes(accessToken)                           the scopes an issued token carries (bookkeeping for downscoping)
 *   refreshes                                          every refresh grant: the `scope` asked for and what was issued
 * The refresh grant honours `scope` like RFC 6749 §6: a subset of the refresh token's scopes gets a token limited to
 * it; a scope the user didn't grant → 400 invalid_scope.
 *
 * Gmail search (`q`) supports label:, in:, is:, from:, to:, cc:, subject:, has:attachment, newer_than:, older_than:,
 * after:, before:, rfc822msgid:, quoted phrases, free text, -negation, OR, AND, (…) and {…}.
 * messages.send / drafts.create parse the raw RFC 5322 (headers, encoded-words, multipart, base64/QP, attachments)
 * and thread by threadId or In-Reply-To/References. Mail sent to another fake account is delivered to it too.
 * Their JSON bodies are capped at 1 MiB (400 "Request payload size exceeds the limit"); larger messages go to
 * /upload/gmail/v1/users/me/{messages/send,drafts} with uploadType=media (message/*) or multipart (multipart/related:
 * JSON metadata such as {threadId} or {message:{threadId}}, then the message), up to 35 MB. `uploads` logs them.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import addressparser from "nodemailer/lib/addressparser";
import type { Account, CalendarAccessRole, CalendarResponseStatus } from "../shared/types.ts";
import type { Config } from "../server/config.ts";
import type { AppContext } from "../server/context.ts";
import type { EventsService, NewEvent } from "../server/events/types.ts";
import type { CalendarAttendeeRaw, CalendarDateTimeRaw, CalendarEventRaw, CalendarListEntryRaw, FreeBusyResult } from "../server/google/calendar.ts";
import type { GmailHeader, GmailHistoryRecord, GmailLabelRaw, GmailMessage, GmailPart } from "../server/google/types.ts";

export const FAKE_CLIENT = {
  clientId: "fake-client.apps.googleusercontent.com",
  clientSecret: "fake-client-secret",
  projectId: "fake-project",
};

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export interface DeliverInput {
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  text?: string;
  html?: string;
  threadId?: string;
  labelIds?: string[];
  headers?: Record<string, string>;
  attachments?: { filename: string; mimeType: string; content: string | Buffer }[];
  date?: Date;
}

export interface FailRule {
  method?: string;
  path: string | RegExp;
  status: number;
  reason?: string;
  message?: string;
  retryAfter?: number;
  times?: number;
  /** Run the request normally first, then answer with the error (e.g. "sent, then 500"). */
  afterProcessing?: boolean;
}

export interface FakeGoogle {
  url: string;
  google: Config["google"];
  close(): Promise<void>;
  addAccount(email: string, opts?: { name?: string; workspaceDomain?: string }): void;
  addLabel(email: string, name: string): string;
  consentAs(email: string, opts?: { deny?: boolean; noRefreshToken?: boolean; scopes?: string[] }): void;
  deliver(email: string, msg: DeliverInput): GmailMessage;
  setLabels(email: string, messageId: string, add: string[], remove: string[]): void;
  failRefresh(email: string, opts?: { rapt?: boolean }): void;
  expireAccessTokens(email: string): void;
  expireHistory(email: string): void;
  disableApi(api: FakeApi, on: boolean): void;
  /** The scopes an access token was issued with (null: not one of ours). */
  tokenScopes(accessToken: string): { email: string; scopes: string[] } | null;
  /** Every access token issued so far, with its user and scopes. */
  issued(): { accessToken: string; email: string; scopes: string[] }[];
  /** Every refresh-grant request: the user, the `scope` it asked for (null: none) and what the issued token got (null: refused). */
  refreshes: { email: string; requested: string[] | null; issued: string[] | null }[];
  /** Answer refreshes with the whole grant whatever `scope` asks (a server that doesn't downscope). Default false. */
  ignoreRefreshScope: boolean;
  /** A downscoped refresh's answer (and token) also carries openid, userinfo.email and email. Default false. */
  refreshAddsIdentity: boolean;
  failNext(rule: FailRule): void;
  sent(email: string): GmailMessage[];
  drafts(email: string): { id: string; message: GmailMessage }[];
  messages(email: string): GmailMessage[];
  message(email: string, id: string): GmailMessage | null;
  accessTokenTtl: number;
  refreshTokenTtl: number | null;
  registeredRedirectUris: string[] | null;
  revoked: string[];
  requests: { method: string; path: string }[];
  /** Media uploads to messages.send / drafts.create: path, uploadType, the JSON metadata part and the message size. */
  uploads: { path: string; uploadType: string; metadata: Record<string, unknown>; size: number }[];
  /** Google Calendar (routes under /calendar/v3). See the header comment. */
  calendar: FakeCalendar;
  /** Google Drive, read-only (routes under /drive/v3). See FakeDrive. */
  drive: FakeDrive;
}

/** A file in a fake Drive. Google-native files (mimeType application/vnd.google-apps.*) have no content, only exports. */
export interface FakeDriveFileInput {
  id?: string;
  name: string;
  mimeType: string;
}

/**
 * Google Drive v3 files.get metadata, per account (code extensions' Google access). Needs drive.readonly or drive
 * (else 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT). Unknown ids → 404 notFound, like Google.
 */
export interface FakeDrive {
  addFile(email: string, file: FakeDriveFileInput): string;
}

/** An email Google Calendar would have sent for a write (sendUpdates). */
export interface FakeCalendarMail {
  to: string;
  kind: "invite" | "update" | "cancel" | "reply";
  eventId: string;
}

export interface FakeCalendar {
  addCalendar(email: string, opts: { name: string; accessRole?: CalendarAccessRole; id?: string; timeZone?: string; hidden?: boolean }): string;
  removeCalendar(email: string, calendarId: string): void;
  putEvent(email: string, calendarId: string, event: Partial<CalendarEventRaw>): CalendarEventRaw;
  invite(organizer: string, attendees: string[], event: Partial<CalendarEventRaw>): CalendarEventRaw;
  respond(email: string, eventId: string, status: CalendarResponseStatus): void;
  cancelEvent(email: string, calendarId: string, eventId: string): void;
  events(email: string, calendarId: string): CalendarEventRaw[];
  event(email: string, calendarId: string, id: string): CalendarEventRaw | null;
  expireSyncTokens(email: string, calendarId?: string): void;
  mailsSent(email: string): FakeCalendarMail[];
}

// ───────────── MIME (fake side) ─────────────

function decodeWords(value: string): string {
  if (!value.includes("=?")) return value;
  return value
    .replace(/(\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, text: string) => {
      const bytes =
        enc.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9a-fA-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
      try {
        return new TextDecoder(cs.split("*")[0]).decode(bytes);
      } catch {
        return bytes.toString("utf8");
      }
    });
}

const encodeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);

function encodeAddressHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return addressparser(value, { flatten: true })
    .map((a) => (a.name ? `${encodeWord(a.name)} <${a.address}>` : a.address))
    .join(", ");
}

interface MimeNode {
  headers: GmailHeader[];
  type: string;
  params: Record<string, string>;
  disposition: string;
  dispParams: Record<string, string>;
  body: Buffer;
  children: MimeNode[];
}

function splitHead(buf: Buffer): [string, Buffer] {
  const crlf = buf.indexOf("\r\n\r\n");
  const lf = buf.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return [buf.subarray(0, crlf).toString("latin1"), buf.subarray(crlf + 4)];
  if (lf >= 0) return [buf.subarray(0, lf).toString("latin1"), buf.subarray(lf + 2)];
  return [buf.toString("latin1"), Buffer.alloc(0)];
}

function parseHeaderBlock(head: string): GmailHeader[] {
  const out: GmailHeader[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1]!.value += " " + line.trim();
    else {
      const i = line.indexOf(":");
      if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
    }
  }
  // Header bytes are UTF-8 when not encoded-words.
  const text = new Set(["subject", "comments", "keywords", "thread-topic"]);
  return out.map((h) => {
    const value = Buffer.from(h.value, "latin1").toString("utf8");
    return { name: h.name, value: text.has(h.name.toLowerCase()) ? decodeWords(value) : value };
  });
}

function parseParams(value: string): { value: string; params: Record<string, string> } {
  const [first, ...rest] = value.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  const continuations: Record<string, string[]> = {};
  for (const p of rest) {
    const m = /^\s*([^=\s*]+)(\*\d+)?(\*)?\s*=\s*(.*)\s*$/.exec(p);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    let v = m[4]!.trim().replace(/^"(.*)"$/, "$1");
    if (m[3]) {
      const ext = /^([^']*)'[^']*'(.*)$/.exec(v);
      v = decodeURIComponent((ext ? ext[2]! : v).replace(/%(?![0-9a-fA-F]{2})/g, "%25"));
    }
    if (m[2]) (continuations[key] ??= [])[Number(m[2].slice(1))] = v;
    else params[key] = v;
  }
  for (const [k, parts] of Object.entries(continuations)) params[k] = parts.join("");
  return { value: (first ?? "").trim().toLowerCase(), params };
}

function decodeQp(s: string): Buffer {
  const bytes: number[] = [];
  const src = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(src.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

function parseMime(buf: Buffer): MimeNode {
  const [head, rawBody] = splitHead(buf);
  const headers = parseHeaderBlock(head);
  const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
  const ct = parseParams(get("content-type") || "text/plain; charset=utf-8");
  const cd = parseParams(get("content-disposition"));
  const node: MimeNode = {
    headers,
    type: ct.value,
    params: ct.params,
    disposition: cd.value,
    dispParams: cd.params,
    body: Buffer.alloc(0),
    children: [],
  };
  if (ct.value.startsWith("multipart/") && ct.params.boundary) {
    const text = rawBody.toString("latin1");
    const delim = `--${ct.params.boundary}`;
    const pieces = text.split(new RegExp(`(?:^|\\r?\\n)${delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith("--")) break;
      node.children.push(parseMime(Buffer.from(piece.replace(/^[ \t]*\r?\n/, ""), "latin1")));
    }
    return node;
  }
  const cte = get("content-transfer-encoding").toLowerCase();
  if (cte === "base64") node.body = Buffer.from(rawBody.toString("latin1").replace(/\s+/g, ""), "base64");
  else if (cte === "quoted-printable") node.body = decodeQp(rawBody.toString("latin1"));
  else node.body = rawBody.length && rawBody.toString("latin1").endsWith("\r\n") ? rawBody.subarray(0, -2) : rawBody;
  return node;
}

const b64url = (b: Buffer) => b.toString("base64url");

function buildRaw(m: DeliverInput & { to: string; messageId: string }): Buffer {
  const lines: string[] = [];
  const add = (k: string, v: string | undefined) => v && lines.push(`${k}: ${v}`);
  add("From", encodeAddressHeader(m.from));
  add("To", encodeAddressHeader(m.to));
  add("Cc", m.cc && encodeAddressHeader(m.cc));
  add("Subject", encodeWord(m.subject));
  add("Date", (m.date ?? new Date()).toUTCString().replace("GMT", "+0000"));
  add("Message-ID", m.messageId);
  for (const [k, v] of Object.entries(m.headers ?? {})) add(k, v);
  add("MIME-Version", "1.0");
  const leaf = (type: string, content: Buffer, extra: string[] = []) =>
    [`Content-Type: ${type}`, "Content-Transfer-Encoding: base64", ...extra, "", content.toString("base64").replace(/.{76}/g, "$&\r\n")].join("\r\n");
  const multipart = (sub: string, parts: string[]) => {
    const boundary = `----fake${randomBytes(8).toString("hex")}`;
    return [`Content-Type: multipart/${sub}; boundary="${boundary}"`, "", ...parts.map((p) => `--${boundary}\r\n${p}`), `--${boundary}--`, ""].join(
      "\r\n",
    );
  };
  const bodies: string[] = [];
  if (m.text !== undefined || m.html === undefined) bodies.push(leaf("text/plain; charset=utf-8", Buffer.from(m.text ?? "")));
  if (m.html !== undefined) bodies.push(leaf("text/html; charset=utf-8", Buffer.from(m.html)));
  let body = bodies.length > 1 ? multipart("alternative", bodies) : bodies[0]!;
  if (m.attachments?.length) {
    const atts = m.attachments.map((a) => {
      const name = /^[\x20-\x7e]*$/.test(a.filename) ? `filename="${a.filename}"` : `filename*=utf-8''${encodeURIComponent(a.filename)}`;
      return leaf(a.mimeType, Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content), [`Content-Disposition: attachment; ${name}`]);
    });
    body = multipart("mixed", [body, ...atts]);
  }
  return Buffer.from(lines.join("\r\n") + "\r\n" + body, "utf8");
}

// ───────────── State ─────────────

interface StoredMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  historyId: number;
  raw: Buffer;
  payload: GmailPart;
  snippet: string;
  attachments: Map<string, Buffer>;
  messageIdHeader: string | null;
  hasAttachment: boolean;
  search: { from: string; to: string; cc: string; subject: string; text: string };
}

interface Mailbox {
  email: string;
  name: string;
  historyId: number;
  minHistoryId: number;
  messages: Map<string, StoredMessage>;
  history: GmailHistoryRecord[];
  labels: Map<string, GmailLabelRaw>;
  drafts: Map<string, string>;
  nextLabel: number;
  workspaceDomain: string | null;
}

interface Token {
  email: string;
  scopes: string[];
  expiresAt: number;
  revoked: boolean;
  /** Grant generation this token belongs to; revoking the grant bumps it. */
  gen: number;
}

const SYSTEM_LABELS = [
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];

class HttpFail extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(`HTTP ${status}`);
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "ALREADY_EXISTS",
  412: "FAILED_PRECONDITION",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  503: "UNAVAILABLE",
};

const apiError = (status: number, message: string, reason?: string, extra: { status?: string; details?: unknown[] } = {}) =>
  new HttpFail(status, {
    error: {
      code: status,
      message,
      status: extra.status ?? STATUS_TEXT[status] ?? "UNKNOWN",
      errors: [{ message, domain: "global", reason: reason ?? (STATUS_TEXT[status] ?? "error").toLowerCase() }],
      ...(extra.details ? { details: extra.details } : {}),
    },
  });

/** Parts of a multipart/related body (Google's multipart upload): each part's Content-Type and bytes. */
function multipartRelated(body: Buffer, contentType: string): { contentType: string; body: Buffer }[] {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!/^multipart\/related/i.test(contentType) || !boundary) throw apiError(400, "Multipart upload needs Content-Type multipart/related with a boundary", "badContent");
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: { contentType: string; body: Buffer }[] = [];
  let at = body.indexOf(delimiter);
  while (at >= 0) {
    let start = at + delimiter.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    if (body.subarray(start, start + 2).toString() === "\r\n") start += 2;
    const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delimiter]), start);
    if (next < 0) throw apiError(400, "Multipart body is missing its closing boundary", "badContent");
    const part = body.subarray(start, next);
    const split = part.indexOf("\r\n\r\n");
    const head = split < 0 ? part.toString("utf8") : part.subarray(0, split).toString("utf8");
    parts.push({ contentType: /^content-type:\s*(.+)$/im.exec(head)?.[1]?.trim() ?? "", body: split < 0 ? Buffer.alloc(0) : part.subarray(split + 4) });
    at = next + 2;
  }
  return parts;
}

const SERVICES = {
  gmail: { name: "Gmail API", host: "gmail.googleapis.com" },
  calendar: { name: "Google Calendar API", host: "calendar-json.googleapis.com" },
  drive: { name: "Google Drive API", host: "drive.googleapis.com" },
  docs: { name: "Google Docs API", host: "docs.googleapis.com" },
  sheets: { name: "Google Sheets API", host: "sheets.googleapis.com" },
  slides: { name: "Google Slides API", host: "slides.googleapis.com" },
} as const;

export type FakeApi = keyof typeof SERVICES;

const serviceDisabled = (service: keyof typeof SERVICES) => {
  const { name, host } = SERVICES[service];
  const activationUrl = `https://console.developers.google.com/apis/api/${host}/overview?project=123456789`;
  return apiError(
    403,
    `${name} has not been used in project 123456789 before or it is disabled. Enable it by visiting ${activationUrl} then retry.`,
    "accessNotConfigured",
    {
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
          domain: "googleapis.com",
          // Newer error bodies carry the enable link (activationUrl is optional in Google's ErrorInfo).
          metadata: {
            service: host,
            consumer: "projects/123456789",
            ...(service === "calendar" || service === "drive" || service === "docs" ? { activationUrl, serviceTitle: name } : {}),
          },
        },
      ],
    },
  );
};

function sha256b64url(s: string): string {
  return createHash("sha256").update(s).digest("base64url");
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const mailboxes = new Map<string, Mailbox>();
  const accessTokens = new Map<string, Token>();
  const refreshTokens = new Map<string, Token>();
  /** Per-user OAuth grant for the fake client. */
  const grants = new Map<string, { scopes: Set<string>; gen: number; rapt: boolean }>();
  const grantOf = (email: string) => {
    let g = grants.get(email);
    if (!g) grants.set(email, (g = { scopes: new Set(), gen: 0, rapt: false }));
    return g;
  };
  const revokeGrant = (email: string, rapt = false) => {
    const g = grantOf(email);
    g.gen++;
    g.scopes.clear();
    g.rapt = rapt;
  };
  const valid = (t: Token | undefined): t is Token => Boolean(t && !t.revoked && t.gen === grantOf(t.email).gen);
  const codes = new Map<string, { email: string; scopes: string[]; challenge: string; redirectUri: string; noRefreshToken: boolean }>();
  const consents: { email: string; deny?: boolean; noRefreshToken?: boolean; scopes?: string[] }[] = [];
  const failRules: (FailRule & { left: number })[] = [];
  const disabled = new Set<string>();
  let idCounter = 0x18f2a00000000000n;
  let seq = 0;
  const newMsgId = () => (idCounter++).toString(16);
  const token = (prefix: string) => `${prefix}${randomBytes(12).toString("hex")}`;

  const box = (email: string): Mailbox => {
    const mb = mailboxes.get(email.toLowerCase());
    if (!mb) throw new Error(`fake-google: unknown account ${email}`);
    return mb;
  };

  // ───── Gmail model ─────

  const labelName = (mb: Mailbox, id: string) => mb.labels.get(id)?.name ?? id;
  const normLabel = (s: string) => s.toLowerCase().replace(/[\s/]+/g, "-");

  function ensureLabel(mb: Mailbox, id: string) {
    if (!mb.labels.has(id)) mb.labels.set(id, { id, name: id, type: "user" });
  }

  function format(m: StoredMessage, fmt = "full", metadataHeaders?: string[]): GmailMessage {
    const base: GmailMessage = {
      id: m.id,
      threadId: m.threadId,
      labelIds: [...m.labelIds],
      snippet: m.snippet,
      historyId: String(m.historyId),
      internalDate: String(m.internalDate),
      sizeEstimate: m.raw.length,
    };
    if (fmt === "minimal") return base;
    if (fmt === "raw") return { ...base, raw: b64url(m.raw) };
    if (fmt === "metadata") {
      const wanted = metadataHeaders?.map((h) => h.toLowerCase());
      const headers = (m.payload.headers ?? []).filter((h) => !wanted?.length || wanted.includes(h.name.toLowerCase()));
      return { ...base, payload: { partId: "", mimeType: m.payload.mimeType, filename: "", headers, body: { size: 0 } } };
    }
    return { ...base, payload: structuredClone(m.payload) };
  }

  function toPart(node: MimeNode, partId: string, atts: Map<string, Buffer>): GmailPart {
    const filename = node.dispParams.filename ?? node.params.name ?? "";
    const part: GmailPart = { partId, mimeType: node.type, filename, headers: node.headers, body: { size: 0 } };
    if (node.type.startsWith("multipart/")) {
      part.parts = node.children.map((c, i) => toPart(c, partId ? `${partId}.${i}` : String(i), atts));
    } else if (filename || node.disposition === "attachment") {
      const attachmentId = `ANGjdJ_${sha256b64url(`${seq++}:${partId}`).slice(0, 24)}`;
      atts.set(attachmentId, node.body);
      part.body = { attachmentId, size: node.body.length };
    } else {
      part.body = { size: node.body.length, data: b64url(node.body) };
    }
    return part;
  }

  function firstText(node: MimeNode): string {
    const leaves: MimeNode[] = [];
    (function walk(n: MimeNode): void {
      if (n.children.length) n.children.forEach(walk);
      else leaves.push(n);
    })(node);
    const body = (n: MimeNode) => {
      try {
        return new TextDecoder(n.params.charset ?? "utf-8").decode(n.body);
      } catch {
        return n.body.toString("utf8");
      }
    };
    const plain = leaves.find((n) => n.type === "text/plain" && !n.dispParams.filename);
    if (plain) return body(plain);
    const html = leaves.find((n) => n.type === "text/html");
    return html ? body(html).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ") : "";
  }

  const escapeSnippet = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

  function makeMessage(mb: Mailbox, raw: Buffer, labelIds: string[], threadHint: string | null, date?: Date): StoredMessage {
    const node = parseMime(raw);
    const header = (n: string) => node.headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    const atts = new Map<string, Buffer>();
    const payload = toPart(node, "", atts);
    const id = newMsgId();
    const refs: string[] = `${header("in-reply-to")} ${header("references")}`.match(/<[^<>\s]+>/g) ?? [];
    let threadId: string | null = threadHint && [...mb.messages.values()].some((m) => m.threadId === threadHint) ? threadHint : null;
    if (!threadId && refs.length) {
      threadId = [...mb.messages.values()].find((m) => m.messageIdHeader && refs.includes(m.messageIdHeader))?.threadId ?? null;
    }
    const text = firstText(node);
    for (const l of labelIds) ensureLabel(mb, l);
    return {
      id,
      threadId: threadId ?? id,
      labelIds: [...new Set(labelIds)],
      internalDate: (date ?? new Date()).getTime(),
      historyId: mb.historyId,
      raw,
      payload,
      snippet: escapeSnippet(text.replace(/\s+/g, " ").trim().slice(0, 200)),
      attachments: atts,
      messageIdHeader: header("message-id").match(/<[^<>\s]+>/)?.[0] ?? null,
      hasAttachment: atts.size > 0,
      search: { from: header("from"), to: `${header("to")} ${header("bcc")}`, cc: header("cc"), subject: header("subject"), text },
    };
  }

  function record(mb: Mailbox, rec: Omit<GmailHistoryRecord, "id">, touched: StoredMessage[]) {
    mb.historyId++;
    for (const m of touched) m.historyId = mb.historyId;
    mb.history.push({ id: String(mb.historyId), ...rec });
  }

  const ref = (m: StoredMessage) => ({ id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] });

  function insert(mb: Mailbox, m: StoredMessage) {
    mb.messages.set(m.id, m);
    record(mb, { messages: [ref(m)], messagesAdded: [{ message: ref(m) }] }, [m]);
  }

  function remove(mb: Mailbox, m: StoredMessage) {
    mb.messages.delete(m.id);
    record(mb, { messages: [ref(m)], messagesDeleted: [{ message: ref(m) }] }, []);
  }

  function modify(mb: Mailbox, m: StoredMessage, add: string[], removeIds: string[]) {
    for (const l of add) ensureLabel(mb, l);
    const added = add.filter((l) => !m.labelIds.includes(l));
    const removed = removeIds.filter((l) => m.labelIds.includes(l) && !add.includes(l));
    if (added.length) {
      m.labelIds.push(...added);
      record(mb, { messages: [ref(m)], labelsAdded: [{ message: ref(m), labelIds: added }] }, [m]);
    }
    if (removed.length) {
      m.labelIds = m.labelIds.filter((l) => !removed.includes(l));
      record(mb, { messages: [ref(m)], labelsRemoved: [{ message: ref(m), labelIds: removed }] }, [m]);
    }
  }

  const msgOr404 = (mb: Mailbox, id: string) => {
    const m = mb.messages.get(id);
    if (!m) throw apiError(404, "Requested entity was not found.", "notFound");
    return m;
  };

  const threadMessages = (mb: Mailbox, threadId: string) =>
    [...mb.messages.values()].filter((m) => m.threadId === threadId).sort((a, b) => a.internalDate - b.internalDate);

  /** Sends raw mail from `mb` and delivers copies to recipients that are fake accounts. */
  function sendRaw(mb: Mailbox, raw: Buffer, threadId: string | null): StoredMessage {
    let bytes = raw;
    if (!/^message-id:/im.test(splitHead(raw)[0])) {
      bytes = Buffer.concat([Buffer.from(`Message-ID: <fake-${randomBytes(8).toString("hex")}@mail.gmail.com>\r\n`), raw]);
    }
    const head = parseHeaderBlock(splitHead(bytes)[0]);
    const hv = (n: string) => head.find((h) => h.name.toLowerCase() === n)?.value ?? "";
    const rcpts = addressparser(`${hv("to")}, ${hv("cc")}, ${hv("bcc")}`, { flatten: true }).map((a) => a.address.toLowerCase());
    const labels = ["SENT", ...(rcpts.includes(mb.email) ? ["INBOX", "UNREAD"] : [])];
    const m = makeMessage(mb, bytes, labels, threadId);
    insert(mb, m);
    for (const r of new Set(rcpts)) {
      const other = mailboxes.get(r);
      if (other && other !== mb) insert(other, makeMessage(other, bytes, ["INBOX", "UNREAD"], null));
    }
    return m;
  }

  // ───── Gmail search ─────

  type Pred = (m: StoredMessage, mb: Mailbox) => boolean;

  function tokenize(q: string): string[] {
    const out: string[] = [];
    const re = /\s*(\(|\)|\{|\}|-?[a-zA-Z_]+:"[^"]*"|-?"[^"]*"|[^\s(){}]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(q))) out.push(m[1]!);
    return out;
  }

  const DURATION: Record<string, number> = { h: 3600e3, d: 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 };
  const IN: Record<string, string> = { inbox: "INBOX", sent: "SENT", spam: "SPAM", trash: "TRASH", drafts: "DRAFT", draft: "DRAFT", starred: "STARRED", important: "IMPORTANT", chats: "CHAT" };

  function term(tok: string): Pred {
    const t = tok.replace(/^"(.*)"$/, "$1");
    const m = /^([a-zA-Z_]+):(.*)$/.exec(t);
    const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
    if (!m) {
      return (msg, mb) =>
        [msg.search.subject, msg.search.from, msg.search.to, msg.search.cc, msg.search.text, msg.labelIds.map((l) => labelName(mb, l)).join(" ")].some(
          (h) => has(h, t),
        );
    }
    const key = m[1]!.toLowerCase();
    const val = m[2]!.replace(/^"(.*)"$/, "$1");
    const date = (s: string) => (/^\d+$/.test(s) ? Number(s) * 1000 : Date.parse(s.replace(/\//g, "-")));
    switch (key) {
      case "label":
        return (msg, mb) => msg.labelIds.some((l) => normLabel(l) === normLabel(val) || normLabel(labelName(mb, l)) === normLabel(val));
      case "in":
        return val.toLowerCase() === "anywhere" ? () => true : (msg) => msg.labelIds.includes(IN[val.toLowerCase()] ?? val.toUpperCase());
      case "is":
        if (val === "read") return (msg) => !msg.labelIds.includes("UNREAD");
        return (msg) => msg.labelIds.includes(val.toUpperCase());
      case "from":
      case "to":
      case "cc":
      case "subject":
        return (msg) => has(msg.search[key], val);
      case "has":
        return (msg) => (val === "attachment" ? msg.hasAttachment : false);
      case "newer_than":
      case "older_than": {
        const d = /^(\d+)([hdmy])$/.exec(val);
        const ms = d ? Number(d[1]) * DURATION[d[2]!]! : 0;
        return key === "newer_than" ? (msg) => msg.internalDate >= Date.now() - ms : (msg) => msg.internalDate < Date.now() - ms;
      }
      case "after":
        return (msg) => msg.internalDate >= date(val);
      case "before":
        return (msg) => msg.internalDate < date(val);
      case "rfc822msgid":
        return (msg) => msg.messageIdHeader === (val.startsWith("<") ? val : `<${val}>`);
      default:
        return (msg) => has(msg.search.text, t);
    }
  }

  function parseQuery(q: string): Pred {
    const toks = tokenize(q);
    let i = 0;
    const orExpr = (end?: string): Pred => {
      const alts: Pred[] = [andExpr(end)];
      while (toks[i] === "OR") {
        i++;
        alts.push(andExpr(end));
      }
      return alts.length === 1 ? alts[0]! : (m, mb) => alts.some((p) => p(m, mb));
    };
    const andExpr = (end?: string): Pred => {
      const all: Pred[] = [];
      while (i < toks.length && toks[i] !== "OR" && toks[i] !== ")" && toks[i] !== end) {
        if (toks[i] === "AND") {
          i++;
          continue;
        }
        all.push(unary());
      }
      return (m, mb) => all.every((p) => p(m, mb));
    };
    const unary = (): Pred => {
      const tok = toks[i++]!;
      if (tok === "-") {
        const p = unary();
        return (m, mb) => !p(m, mb);
      }
      if (tok === "(") {
        const p = orExpr();
        if (toks[i] === ")") i++;
        return p;
      }
      if (tok === "{") {
        const alts: Pred[] = [];
        while (i < toks.length && toks[i] !== "}") alts.push(unary());
        i++;
        return (m, mb) => alts.some((p) => p(m, mb));
      }
      if (tok.startsWith("-") && tok.length > 1) {
        const p = term(tok.slice(1));
        return (m, mb) => !p(m, mb);
      }
      return term(tok);
    };
    return orExpr();
  }

  function search(mb: Mailbox, query: URLSearchParams): StoredMessage[] {
    const q = query.get("q") ?? "";
    const labelIds = query.getAll("labelIds");
    const includeSpamTrash = query.get("includeSpamTrash") === "true" || /\b(in|label):(spam|trash|anywhere)\b/i.test(q);
    const pred = q.trim() ? parseQuery(q) : () => true;
    return [...mb.messages.values()]
      .filter((m) => includeSpamTrash || !m.labelIds.some((l) => l === "SPAM" || l === "TRASH"))
      .filter((m) => labelIds.every((l) => m.labelIds.includes(l)))
      .filter((m) => pred(m, mb))
      .sort((a, b) => b.internalDate - a.internalDate || (BigInt(`0x${b.id}`) > BigInt(`0x${a.id}`) ? 1 : -1));
  }

  function page<T>(items: T[], query: URLSearchParams, def = 100): { items: T[]; next: string | null } {
    const start = Number(query.get("pageToken") ?? 0) || 0;
    const max = Math.min(Number(query.get("maxResults") ?? def) || def, 500);
    const slice = items.slice(start, start + max);
    return { items: slice, next: start + max < items.length ? String(start + max) : null };
  }

  // ───── Auth ─────

  function bearer(req: IncomingMessage, scope: string, api: "gmail"): Token {
    const t = accessTokens.get((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (!valid(t) || t.expiresAt < Date.now()) {
      throw apiError(401, "Request had invalid authentication credentials. Expected OAuth 2 access token.", "authError");
    }
    if (!t.scopes.includes(scope)) {
      throw apiError(403, "Request had insufficient authentication scopes.", "insufficientPermissions", {
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", domain: "googleapis.com" }],
      });
    }
    if (disabled.has(api)) throw serviceDisabled(api);
    return t;
  }

  function issueAccess(email: string, scopes: string[]): string {
    const at = token("ya29.fake-");
    accessTokens.set(at, { email, scopes, expiresAt: Date.now() + fake.accessTokenTtl * 1000, revoked: false, gen: grantOf(email).gen });
    return at;
  }

  // ───── HTTP plumbing ─────

  type Handler = (req: IncomingMessage, url: URL, body: Buffer, m: RegExpExecArray, res: ServerResponse) => unknown | Promise<unknown>;
  const routes: [string, RegExp, Handler][] = [];
  const on = (method: string, re: RegExp, h: Handler) => routes.push([method, re, h]);

  const json = (body: Buffer): Record<string, unknown> => {
    try {
      return body.length ? (JSON.parse(body.toString("utf8")) as Record<string, unknown>) : {};
    } catch {
      throw apiError(400, "Invalid JSON payload received.");
    }
  };
  const form = (body: Buffer, url: URL) => {
    const p = new URLSearchParams(body.toString("utf8"));
    for (const [k, v] of url.searchParams) if (!p.has(k)) p.set(k, v);
    return p;
  };
  const oauthFail = (status: number, error: string, description: string) => new HttpFail(status, { error, error_description: description });

  // OAuth consent
  on("GET", /^\/o\/oauth2\/v2\/auth$/, (_req, url, _b, _m, res) => {
    const q = url.searchParams;
    const redirect = q.get("redirect_uri");
    const errorPage = (text: string) => {
      const target = new URL("/signin/oauth/error/v2", url);
      target.searchParams.set("authError", Buffer.from(text).toString("base64"));
      target.searchParams.set("client_id", q.get("client_id") ?? "");
      res.writeHead(302, { location: `${target.pathname}${target.search}` }).end();
    };
    if (q.get("client_id") !== FAKE_CLIENT.clientId) return errorPage("Error 401: invalid_client\nThe OAuth client was not found.");
    if (!redirect || q.get("response_type") !== "code") throw new HttpFail(400, "Error 400: invalid_request");
    if (fake.registeredRedirectUris && !fake.registeredRedirectUris.includes(redirect)) {
      return errorPage(`Error 400: redirect_uri_mismatch\nYou can't sign in because this app sent an invalid request. redirect_uri=${redirect}`);
    }
    if (!q.get("code_challenge")) {
      // Not xaq's connect flow (it always uses PKCE): behave like a signed-out browser.
      const target = new URL("/v3/signin/identifier", url);
      target.searchParams.set("continue", `${url.pathname}${url.search}`);
      res.writeHead(302, { location: `${target.pathname}${target.search}` }).end();
      return;
    }
    if (q.get("code_challenge_method") !== "S256") throw new HttpFail(400, "Error 400: PKCE required");
    const consent = consents.shift() ?? (mailboxes.size === 1 ? { email: [...mailboxes.keys()][0]! } : null);
    if (!consent) throw new HttpFail(400, "fake-google: no consent queued (call consentAs)");
    const target = new URL(redirect);
    const state = q.get("state");
    if (consent.deny) {
      target.searchParams.set("error", "access_denied");
    } else {
      const requested = (q.get("scope") ?? "").split(/\s+/).filter(Boolean);
      let scopes = consent.scopes ?? requested.map((s) => (s === "email" ? "https://www.googleapis.com/auth/userinfo.email" : s));
      const grant = grantOf(consent.email);
      if (q.get("include_granted_scopes") === "true") scopes = [...new Set([...grant.scopes, ...scopes])];
      grant.scopes = new Set(scopes);
      grant.rapt = false;
      const code = token("4/0fake-");
      codes.set(code, { email: consent.email, scopes, challenge: q.get("code_challenge")!, redirectUri: redirect, noRefreshToken: Boolean(consent.noRefreshToken) });
      target.searchParams.set("code", code);
      target.searchParams.set("scope", scopes.join(" "));
    }
    if (state) target.searchParams.set("state", state);
    res.writeHead(302, { location: target.toString() }).end();
  });

  on("GET", /^\/signin\/oauth\/error\/v2$/, (_req, url) => {
    const text = Buffer.from(url.searchParams.get("authError") ?? "", "base64").toString("utf8");
    throw new HttpFail(400, `<!doctype html><title>Error</title><h1>Access blocked: authorization error</h1><p>${text}</p>`);
  });
  on("GET", /^\/v3\/signin\/identifier$/, (_req, _url, _b, _m, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Sign in - Google Accounts</title><h1>Sign in</h1>");
  });

  on("POST", /^\/token$/, (_req, url, body) => {
    const p = form(body, url);
    // Like Google: same error code for an unknown client and a wrong secret, different descriptions.
    if (p.get("client_id") !== FAKE_CLIENT.clientId) throw oauthFail(401, "invalid_client", "The OAuth client was not found.");
    if (p.get("client_secret") !== FAKE_CLIENT.clientSecret) throw oauthFail(401, "invalid_client", "Unauthorized");
    if (p.get("grant_type") === "authorization_code") {
      const c = codes.get(p.get("code") ?? "");
      codes.delete(p.get("code") ?? "");
      if (!c) throw oauthFail(400, "invalid_grant", "Malformed auth code.");
      if (c.redirectUri !== p.get("redirect_uri")) throw oauthFail(400, "redirect_uri_mismatch", "Bad Request");
      if (sha256b64url(p.get("code_verifier") ?? "") !== c.challenge) throw oauthFail(400, "invalid_grant", "Invalid code verifier.");
      const mb = box(c.email);
      const out: Record<string, unknown> = {
        access_token: issueAccess(mb.email, c.scopes),
        expires_in: fake.accessTokenTtl,
        scope: c.scopes.join(" "),
        token_type: "Bearer",
      };
      if (!c.noRefreshToken) {
        const rt = token("1//fake-rt-");
        const ttl = fake.refreshTokenTtl;
        refreshTokens.set(rt, { email: mb.email, scopes: c.scopes, expiresAt: ttl ? Date.now() + ttl * 1000 : Infinity, revoked: false, gen: grantOf(mb.email).gen });
        out.refresh_token = rt;
        if (ttl) out.refresh_token_expires_in = ttl;
      }
      if (c.scopes.includes("openid")) {
        const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
        const claims = { iss: "https://accounts.google.com", email: mb.email, name: mb.name, sub: mb.email, ...(mb.workspaceDomain ? { hd: mb.workspaceDomain } : {}) };
        out.id_token = `${enc({ alg: "none" })}.${enc(claims)}.`;
      }
      return out;
    }
    if (p.get("grant_type") === "refresh_token") {
      const rt = refreshTokens.get(p.get("refresh_token") ?? "");
      if (rt && rt.gen !== grantOf(rt.email).gen && grantOf(rt.email).rapt) {
        throw new HttpFail(400, { error: "invalid_grant", error_description: "reauth related error (invalid_rapt)", error_subtype: "invalid_rapt" });
      }
      const requested = p.has("scope") ? (p.get("scope") ?? "").split(/\s+/).filter(Boolean) : null;
      if (!valid(rt) || rt.expiresAt <= Date.now()) {
        if (rt) fake.refreshes.push({ email: rt.email, requested, issued: null });
        throw oauthFail(400, "invalid_grant", "Token has been expired or revoked.");
      }
      // RFC 6749 §6 (and Google): `scope` on a refresh asks for a token limited to those scopes, which must all have
      // been granted to this refresh token; without it, the token gets everything originally granted.
      if (requested && (!requested.length || requested.some((s) => !rt.scopes.includes(s)))) {
        fake.refreshes.push({ email: rt.email, requested, issued: null });
        throw oauthFail(400, "invalid_scope", "Some requested scopes were not granted by the user.");
      }
      // ignoreRefreshScope: a server that ignores `scope` and answers with the whole grant (what xaq must refuse).
      // refreshAddsIdentity: a downscoped answer that also names the identity scopes (Google may add them).
      const base = fake.ignoreRefreshScope ? rt.scopes : (requested ?? rt.scopes);
      const scopes = fake.refreshAddsIdentity && requested ? [...new Set([...base, "openid", "https://www.googleapis.com/auth/userinfo.email", "email"])] : base;
      fake.refreshes.push({ email: rt.email, requested, issued: [...scopes] });
      return {
        access_token: issueAccess(rt.email, scopes),
        expires_in: fake.accessTokenTtl,
        scope: scopes.join(" "),
        token_type: "Bearer",
        ...(Number.isFinite(rt.expiresAt) ? { refresh_token_expires_in: Math.floor((rt.expiresAt - Date.now()) / 1000) } : {}),
      };
    }
    throw oauthFail(400, "unsupported_grant_type", "Invalid grant_type.");
  });

  on("POST", /^\/revoke$/, (_req, url, body) => {
    const t = form(body, url).get("token") ?? "";
    const found = refreshTokens.get(t) ?? accessTokens.get(t);
    if (!valid(found)) throw oauthFail(400, "invalid_token", "Token expired or revoked");
    // Like Google: revoking one token removes the user's whole grant for this client.
    revokeGrant(found.email);
    fake.revoked.push(t);
    return {};
  });

  // Gmail
  const G = "^/gmail/v1/users/me";
  const gmailRoute = (method: string, path: string, h: (mb: Mailbox, url: URL, body: Buffer, m: RegExpExecArray) => unknown) =>
    on(method, new RegExp(`${G}${path}$`), (req, url, body, m) => h(box(bearer(req, GMAIL_SCOPE, "gmail").email), url, body, m));

  gmailRoute("GET", "/profile", (mb) => ({
    emailAddress: mb.email,
    messagesTotal: mb.messages.size,
    threadsTotal: new Set([...mb.messages.values()].map((m) => m.threadId)).size,
    historyId: String(mb.historyId),
  }));

  gmailRoute("GET", "/messages", (mb, url) => {
    const all = search(mb, url.searchParams);
    const { items, next } = page(all, url.searchParams);
    return {
      ...(items.length ? { messages: items.map((m) => ({ id: m.id, threadId: m.threadId })) } : {}),
      ...(next ? { nextPageToken: next } : {}),
      resultSizeEstimate: all.length,
    };
  });

  gmailRoute("GET", "/messages/([^/]+)", (mb, url, _b, m) =>
    format(msgOr404(mb, m[1]!), url.searchParams.get("format") ?? "full", url.searchParams.getAll("metadataHeaders")),
  );

  gmailRoute("GET", "/messages/([^/]+)/attachments/([^/]+)", (mb, _u, _b, m) => {
    const data = msgOr404(mb, m[1]!).attachments.get(m[2]!);
    if (!data) throw apiError(404, "Requested entity was not found.", "notFound");
    return { attachmentId: m[2], size: data.length, data: b64url(data) };
  });

  gmailRoute("POST", "/messages/([^/]+)/modify", (mb, _u, body, m) => {
    const msg = msgOr404(mb, m[1]!);
    const b = json(body) as { addLabelIds?: string[]; removeLabelIds?: string[] };
    modify(mb, msg, b.addLabelIds ?? [], b.removeLabelIds ?? []);
    return format(msg, "minimal");
  });

  gmailRoute("POST", "/messages/([^/]+)/trash", (mb, _u, _b, m) => {
    const msg = msgOr404(mb, m[1]!);
    modify(mb, msg, ["TRASH"], ["INBOX"]);
    return format(msg, "minimal");
  });

  /**
   * JSON bodies of messages.send / drafts.create: Gmail documents no limit for `raw` there, but has answered
   * "Request payload size exceeds the limit: 1048576 bytes"; larger messages must go through /upload/.
   */
  const JSON_WRITE_LIMIT = 1_048_576;
  /** maxSize of the /upload/ endpoints of messages.send and drafts.create (Gmail's discovery document). */
  const UPLOAD_MAX = 36_700_160;
  const jsonWrite = (body: Buffer) => {
    if (body.length > JSON_WRITE_LIMIT) throw apiError(400, `Request payload size exceeds the limit: ${JSON_WRITE_LIMIT} bytes.`, "badRequest");
    return json(body);
  };
  const createDraft = (mb: Mailbox, raw: Buffer, threadId: string | null) => {
    const msg = makeMessage(mb, raw, ["DRAFT"], threadId);
    insert(mb, msg);
    const id = `r${(seq++).toString().padStart(19, "0")}`;
    mb.drafts.set(id, msg.id);
    return { id, message: format(msg, "minimal") };
  };

  // Media uploads: uploadType=media (the message alone, Content-Type message/*) or multipart (multipart/related:
  // JSON metadata, then the message). Resumable uploads aren't supported.
  on("POST", /^\/upload\/gmail\/v1\/users\/me\/(messages\/send|drafts)$/, (req, url, body, m) => {
    const mb = box(bearer(req, GMAIL_SCOPE, "gmail").email);
    const uploadType = url.searchParams.get("uploadType");
    const contentType = req.headers["content-type"] ?? "";
    let metadata: { threadId?: string; message?: { threadId?: string } } = {};
    let raw: Buffer;
    if (uploadType === "media") {
      if (!/^message\//i.test(contentType)) throw apiError(400, `Media type '${contentType}' is not supported. Valid media types: [message/*]`, "badContent");
      raw = body;
    } else if (uploadType === "multipart") {
      const parts = multipartRelated(body, contentType);
      if (parts.length !== 2 || !/^application\/json/i.test(parts[0]!.contentType) || !/^message\//i.test(parts[1]!.contentType)) {
        throw apiError(400, "Multipart upload needs a JSON metadata part, then a message/* part", "badContent");
      }
      metadata = JSON.parse(parts[0]!.body.toString("utf8") || "{}");
      raw = parts[1]!.body;
    } else {
      throw apiError(400, `Invalid upload type: ${uploadType}`, "invalidArgument");
    }
    if (raw.length > UPLOAD_MAX) throw apiError(413, "Request Too Large", "uploadTooLarge");
    if (!raw.length) throw apiError(400, "Media upload has no message", "invalidArgument");
    fake.uploads.push({ path: url.pathname, uploadType, metadata, size: raw.length });
    if (m[1] === "drafts") return createDraft(mb, raw, metadata.message?.threadId ?? null);
    return format(sendRaw(mb, raw, metadata.threadId ?? null), "minimal");
  });

  gmailRoute("POST", "/messages/send", (mb, _u, body) => {
    const b = jsonWrite(body) as { raw?: string; threadId?: string };
    if (!b.raw) throw apiError(400, "Invalid value for ByteString: raw is required", "invalidArgument");
    return format(sendRaw(mb, Buffer.from(b.raw, "base64url"), b.threadId ?? null), "minimal");
  });

  gmailRoute("GET", "/threads", (mb, url) => {
    const matched = search(mb, url.searchParams);
    const ids = [...new Set(matched.map((m) => m.threadId))];
    const all = ids.map((id) => {
      const msgs = threadMessages(mb, id);
      const last = msgs.at(-1)!;
      return { id, snippet: last.snippet, historyId: String(Math.max(...msgs.map((x) => x.historyId))) };
    });
    const { items, next } = page(all, url.searchParams);
    return { ...(items.length ? { threads: items } : {}), ...(next ? { nextPageToken: next } : {}), resultSizeEstimate: all.length };
  });

  const threadOr404 = (mb: Mailbox, id: string) => {
    const msgs = threadMessages(mb, id);
    if (!msgs.length) throw apiError(404, "Requested entity was not found.", "notFound");
    return msgs;
  };

  gmailRoute("GET", "/threads/([^/]+)", (mb, url, _b, m) => {
    const msgs = threadOr404(mb, m[1]!);
    const fmt = url.searchParams.get("format") ?? "full";
    return {
      id: m[1],
      historyId: String(Math.max(...msgs.map((x) => x.historyId))),
      messages: msgs.map((x) => format(x, fmt, url.searchParams.getAll("metadataHeaders"))),
    };
  });

  gmailRoute("POST", "/threads/([^/]+)/modify", (mb, _u, body, m) => {
    const b = json(body) as { addLabelIds?: string[]; removeLabelIds?: string[] };
    const msgs = threadOr404(mb, m[1]!);
    for (const x of msgs) modify(mb, x, b.addLabelIds ?? [], b.removeLabelIds ?? []);
    return { id: m[1], messages: msgs.map((x) => format(x, "minimal")) };
  });

  gmailRoute("POST", "/threads/([^/]+)/trash", (mb, _u, _b, m) => {
    const msgs = threadOr404(mb, m[1]!);
    for (const x of msgs) modify(mb, x, ["TRASH"], ["INBOX"]);
    return { id: m[1], messages: msgs.map((x) => format(x, "minimal")) };
  });

  gmailRoute("GET", "/labels", (mb) => ({
    labels: [...mb.labels.values()].map((l) => ({
      ...l,
      ...(l.type === "user" ? { messageListVisibility: "show", labelListVisibility: "labelShow" } : {}),
    })),
  }));

  const draftOr404 = (mb: Mailbox, id: string) => {
    const msgId = mb.drafts.get(id);
    const msg = msgId ? mb.messages.get(msgId) : undefined;
    if (!msgId || !msg) throw apiError(404, "Requested entity was not found.", "notFound");
    return msg;
  };

  gmailRoute("POST", "/drafts", (mb, _u, body) => {
    const b = jsonWrite(body) as { message?: { raw?: string; threadId?: string } };
    if (!b.message?.raw) throw apiError(400, "Missing draft message", "invalidArgument");
    return createDraft(mb, Buffer.from(b.message.raw, "base64url"), b.message.threadId ?? null);
  });

  gmailRoute("GET", "/drafts/([^/]+)", (mb, url, _b, m) => ({
    id: m[1],
    message: format(draftOr404(mb, m[1]!), url.searchParams.get("format") ?? "full"),
  }));

  gmailRoute("DELETE", "/drafts/([^/]+)", (mb, _u, _b, m) => {
    remove(mb, draftOr404(mb, m[1]!));
    mb.drafts.delete(m[1]!);
    return undefined;
  });

  gmailRoute("POST", "/drafts/send", (mb, _u, body) => {
    const b = json(body) as { id?: string };
    const draft = draftOr404(mb, b.id ?? "");
    mb.drafts.delete(b.id!);
    remove(mb, draft);
    return format(sendRaw(mb, draft.raw, draft.threadId), "minimal");
  });

  gmailRoute("GET", "/history", (mb, url) => {
    const start = Number(url.searchParams.get("startHistoryId"));
    if (!Number.isFinite(start) || start < mb.minHistoryId) throw apiError(404, "Requested entity was not found.", "notFound");
    const types = url.searchParams.getAll("historyTypes");
    const key: Record<string, keyof GmailHistoryRecord> = {
      messageAdded: "messagesAdded",
      messageDeleted: "messagesDeleted",
      labelAdded: "labelsAdded",
      labelRemoved: "labelsRemoved",
    };
    const wanted = types.length ? types.map((t) => key[t]) : Object.values(key);
    const records = mb.history
      .filter((r) => Number(r.id) > start)
      .map((r) => {
        const out: GmailHistoryRecord = { id: r.id, messages: r.messages };
        for (const k of wanted) if (k && r[k]) (out as unknown as Record<string, unknown>)[k] = r[k];
        return out;
      })
      .filter((r) => wanted.some((k) => k && k in r));
    const { items, next } = page(records, url.searchParams);
    return { ...(items.length ? { history: items } : {}), ...(next ? { nextPageToken: next } : {}), historyId: String(mb.historyId) };
  });

  // ───── Calendar ─────

  const CAL = "https://www.googleapis.com/auth/calendar";
  /** Scopes that cover each Calendar method (any one is enough), per Google's method reference pages. */
  const CAL_SCOPES = {
    list: [CAL, `${CAL}.readonly`, `${CAL}.calendarlist`, `${CAL}.calendarlist.readonly`],
    read: [CAL, `${CAL}.readonly`, `${CAL}.events`, `${CAL}.events.readonly`],
    write: [CAL, `${CAL}.events`],
    freebusy: [CAL, `${CAL}.readonly`, `${CAL}.events.freebusy`, `${CAL}.freebusy`],
  };
  /** events.list parameters Google refuses next to a syncToken (400). */
  const NOT_WITH_SYNC_TOKEN = ["iCalUID", "orderBy", "q", "timeMin", "timeMax", "updatedMin", "privateExtendedProperty", "sharedExtendedProperty"];
  const DAY = 86_400_000;
  const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

  interface FakeCal {
    entry: CalendarListEntryRaw;
    owner: string;
    /** Event id → current version and its position in the change log (deleted events stay as "cancelled"). */
    events: Map<string, { raw: CalendarEventRaw; seq: number }>;
    /** Bumped by expireSyncTokens: tokens of an older generation get 410. */
    gen: number;
  }
  /** Owner email → calendar id → calendar. */
  const calendars = new Map<string, Map<string, FakeCal>>();
  const calMails = new Map<string, FakeCalendarMail[]>();
  let calSeq = 0;
  let lastStamp = 0;

  const calendarsOf = (email: string) => {
    const c = calendars.get(email.toLowerCase());
    if (!c) throw new Error(`fake-google: unknown account ${email}`);
    return c;
  };
  /** The account's calendar (`primary` = its own); 404 like Google for anything else (or a test error with http=false). */
  function calendarOf(email: string, calendarId: string, http = true): FakeCal {
    const id = calendarId === "primary" ? email.toLowerCase() : calendarId;
    const c = calendarsOf(email).get(id);
    if (c) return c;
    if (http) throw apiError(404, "Not Found", "notFound");
    throw new Error(`fake-google: ${email} has no calendar ${calendarId}`);
  }
  const primaryOf = (email: string) => calendarsOf(email).get(email.toLowerCase())!;
  const addCalendarTo = (owner: string, entry: CalendarListEntryRaw) => {
    calendarsOf(owner).set(entry.id, { entry, owner, events: new Map(), gen: 0 });
    return entry.id;
  };
  const canWrite = (c: FakeCal) => c.entry.accessRole === "owner" || c.entry.accessRole === "writer";

  function calendarBearer(req: IncomingMessage, scopes: string[], api: "calendar" | "drive" = "calendar"): Token {
    const t = accessTokens.get((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (!valid(t) || t.expiresAt < Date.now()) {
      throw apiError(401, "Request had invalid authentication credentials. Expected OAuth 2 access token.", "authError");
    }
    if (!scopes.some((s) => t.scopes.includes(s))) {
      throw apiError(403, "Request had insufficient authentication scopes.", "insufficientPermissions", {
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", domain: "googleapis.com" }],
      });
    }
    if (disabled.has(api)) throw serviceDisabled(api);
    return t;
  }

  /** Stores a new version: fresh `updated` and etag, a change-log position (what sync tokens read). */
  function save(cal: FakeCal, raw: CalendarEventRaw): CalendarEventRaw {
    const at = (lastStamp = Math.max(Date.now(), lastStamp + 1));
    const seq = ++calSeq;
    const stored: CalendarEventRaw = { ...structuredClone(raw), updated: new Date(at).toISOString(), etag: `"${at}${String(seq).padStart(4, "0")}"` };
    cal.events.set(raw.id, { raw: stored, seq });
    return structuredClone(stored);
  }

  const isResource = (email: string) => email.endsWith("@resource.calendar.google.com");

  /** Google's attendee list: lowercased, the organizer listed (accepted), `self` on the owner's own entry. */
  function attendeeList(owner: string, organizer: string, list: CalendarAttendeeRaw[] | undefined, prev: CalendarAttendeeRaw[] = []): CalendarAttendeeRaw[] | undefined {
    if (!list?.length) return undefined;
    const known = new Map(prev.map((a) => [a.email, a]));
    const out = list
      .filter((a) => a.email)
      .map((a) => {
        const email = a.email!.toLowerCase();
        // Only each attendee changes their own response: the organizer's list keeps stored responses.
        const response = known.get(email)?.responseStatus ?? a.responseStatus ?? (email === organizer ? "accepted" : "needsAction");
        const { self: _s, organizer: _o, resource: _r, ...rest } = a;
        return {
          ...rest,
          email,
          responseStatus: response,
          ...(email === organizer ? { organizer: true } : {}),
          ...(email === owner ? { self: true } : {}),
          ...(isResource(email) ? { resource: true } : {}),
        };
      });
    if (!out.some((a) => a.email === organizer)) out.unshift({ email: organizer, organizer: true, responseStatus: "accepted", ...(organizer === owner ? { self: true } : {}) });
    return out;
  }

  function conference(body: Partial<CalendarEventRaw>, version: string | null): Pick<CalendarEventRaw, "hangoutLink" | "conferenceData"> {
    if (version !== "1" || !body.conferenceData?.createRequest) return body.conferenceData ? { conferenceData: body.conferenceData } : {};
    const code = [3, 4, 3].map((n) => randomBytes(n).toString("hex").replace(/\d/g, (d) => "abcdefghij"[Number(d)]!).slice(0, n)).join("-");
    const uri = `https://meet.google.com/${code}`;
    return { hangoutLink: uri, conferenceData: { entryPoints: [{ entryPointType: "video", uri }] } };
  }

  /** A new event on `cal`, organized by the calendar (Google: the calendar id, `self` on its owner's copy). */
  function newEvent(cal: FakeCal, body: Partial<CalendarEventRaw>, conferenceVersion: string | null = null): CalendarEventRaw {
    const id = body.id ?? randomBytes(13).toString("hex");
    const organizer = (body.organizer?.email ?? cal.entry.id).toLowerCase();
    const own = organizer === cal.entry.id;
    const mb = mailboxes.get(cal.owner);
    return {
      ...body,
      id,
      status: body.status ?? "confirmed",
      created: body.created ?? new Date().toISOString(),
      iCalUID: body.iCalUID ?? `${id}@google.com`,
      htmlLink: `https://www.google.com/calendar/event?eid=${Buffer.from(`${id} ${cal.entry.id}`).toString("base64url")}`,
      organizer: own
        ? { email: organizer, displayName: cal.entry.primary ? mb?.name : cal.entry.summary, self: true }
        : { email: organizer, ...(body.organizer?.displayName ? { displayName: body.organizer.displayName } : {}) },
      creator: own ? { email: cal.owner, self: true } : { email: organizer },
      attendees: attendeeList(cal.owner, organizer, body.attendees),
      eventType: body.eventType ?? "default",
      ...conference(body, conferenceVersion),
    };
  }

  /** The invitee's copy: shared fields from the organizer's event, `self` on the invitee's own entry, private fields kept. */
  function copyFor(source: CalendarEventRaw, email: string, existing?: CalendarEventRaw): CalendarEventRaw {
    const { self: _o, ...organizer } = source.organizer ?? {};
    const { self: _c, ...creator } = source.creator ?? {};
    return {
      ...existing,
      ...structuredClone(source),
      organizer,
      creator,
      attendees: source.attendees?.map(({ self: _s, ...a }) => (a.email === email ? { ...a, self: true } : a)),
      ...(existing?.transparency ? { transparency: existing.transparency } : {}),
    };
  }

  /** Mirrors the organizer's event onto fake attendees' primary calendars (Google adds invitations whatever sendUpdates says). */
  function fanOut(source: CalendarEventRaw, before: string[] = []) {
    const now = new Set((source.attendees ?? []).map((a) => a.email!));
    for (const email of new Set([...before, ...now])) {
      if (email === source.organizer?.email || !calendars.has(email)) continue;
      const cal = primaryOf(email);
      const existing = cal.events.get(source.id)?.raw;
      if (!now.has(email) || source.status === "cancelled") {
        if (existing && existing.status !== "cancelled") save(cal, { ...existing, status: "cancelled" });
      } else save(cal, copyFor(source, email, existing));
    }
  }

  /** An attendee's response, copied into every other copy of the event (the organizer's included). */
  function propagateResponse(from: FakeCal, ev: CalendarEventRaw, email: string) {
    const entry = ev.attendees?.find((a) => a.email === email);
    if (!entry) return;
    for (const cals of calendars.values()) {
      for (const cal of cals.values()) {
        const other = cal.events.get(ev.id)?.raw;
        if (cal === from || !other || other.iCalUID !== ev.iCalUID || other.status === "cancelled") continue;
        const attendees = other.attendees?.map((a) => (a.email === email ? { ...a, responseStatus: entry.responseStatus, ...(entry.comment ? { comment: entry.comment } : {}) } : a));
        save(cal, { ...other, attendees });
      }
    }
  }

  /** Records the emails Google would send for a write by `actor` (sendUpdates all / externalOnly = non-Google guests). */
  function mailOut(actor: string, sendUpdates: string | null, kind: FakeCalendarMail["kind"], eventId: string, to: string[]) {
    if (sendUpdates !== "all" && sendUpdates !== "externalOnly") return;
    const list = calMails.get(actor) ?? [];
    for (const addr of new Set(to)) {
      if (addr === actor || isResource(addr) || (sendUpdates === "externalOnly" && calendars.has(addr))) continue;
      list.push({ to: addr, kind, eventId });
    }
    calMails.set(actor, list);
  }
  const guests = (e: CalendarEventRaw | undefined) => (e?.attendees ?? []).filter((a) => !a.organizer).map((a) => a.email!);

  // Recurrence: RRULE FREQ=DAILY|WEEKLY with INTERVAL, COUNT, UNTIL and (weekly) BYDAY, plus EXDATE, in UTC.
  const timeOf = (d: CalendarDateTimeRaw | undefined) => (d?.dateTime ? Date.parse(d.dateTime) : d?.date ? Date.parse(`${d.date}T00:00:00Z`) : NaN);
  const isoBasic = (ms: number, allDay: boolean) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "").slice(0, allDay ? 8 : 16);
  const dateTime = (ms: number, allDay: boolean, timeZone?: string): CalendarDateTimeRaw =>
    allDay ? { date: new Date(ms).toISOString().slice(0, 10) } : { dateTime: new Date(ms).toISOString().replace(".000Z", "Z"), ...(timeZone ? { timeZone } : {}) };
  function parseIcalTime(s: string, endOfDay = false): number {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(s.trim());
    if (!m) return NaN;
    const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    return endOfDay && !m[4] ? t + DAY - 1 : t;
  }

  /** Start times (ms) of a series' occurrences up to `until` (one for a plain event). */
  function occurrences(e: CalendarEventRaw, until: number): number[] {
    const start = timeOf(e.start);
    const rule = e.recurrence?.find((r) => r.startsWith("RRULE:"));
    if (!rule) return [start];
    const p = Object.fromEntries(rule.slice(6).split(";").map((kv) => kv.split("=") as [string, string]));
    if (p.FREQ !== "DAILY" && p.FREQ !== "WEEKLY") return [start];
    const interval = Number(p.INTERVAL ?? 1) || 1;
    const count = p.COUNT ? Number(p.COUNT) : Infinity;
    const last = Math.min(until, p.UNTIL ? parseIcalTime(p.UNTIL, true) : Infinity, start + 3 * 365 * DAY);
    const byDay = p.FREQ === "WEEKLY" ? (p.BYDAY?.split(",") ?? [WEEKDAYS[new Date(start).getUTCDay()]!]) : null;
    const exdates = new Set(
      e.recurrence!.filter((r) => r.startsWith("EXDATE")).flatMap((r) => r.slice(r.indexOf(":") + 1).split(",").map((x) => parseIcalTime(x))),
    );
    const weekStart = start - new Date(start).getUTCDay() * DAY;
    const out: number[] = [];
    for (let t = start, n = 0; t <= last && n < count; t += DAY) {
      const due = byDay
        ? byDay.includes(WEEKDAYS[new Date(t).getUTCDay()]!) && Math.floor((t - weekStart) / (7 * DAY)) % interval === 0
        : Math.round((t - start) / DAY) % interval === 0;
      if (!due) continue;
      n++;
      if (!exdates.has(t)) out.push(t);
    }
    return out;
  }

  /** singleEvents expansion: instance ids `<series>_<YYYYMMDD[THHMMSSZ]>`; stored exceptions replace (or cancel) their instance. */
  function instances(cal: FakeCal, series: CalendarEventRaw, until: number): CalendarEventRaw[] {
    const allDay = !series.start?.dateTime;
    const length = timeOf(series.end) - timeOf(series.start);
    const { recurrence: _r, ...base } = series;
    return occurrences(series, until).flatMap((t) => {
      const id = `${series.id}_${isoBasic(t, allDay)}`;
      const exception = cal.events.get(id)?.raw;
      if (exception) return exception.status === "cancelled" ? [] : [structuredClone(exception)];
      const tz = series.start?.timeZone;
      return [{ ...structuredClone(base), id, recurringEventId: series.id, originalStartTime: dateTime(t, allDay, tz), start: dateTime(t, allDay, tz), end: dateTime(t + length, allDay, series.end?.timeZone) }];
    });
  }

  /** A stored event, or an instance of a stored series addressed by its instance id (null when neither exists). */
  function findEvent(cal: FakeCal, id: string): CalendarEventRaw | null {
    const stored = cal.events.get(id)?.raw;
    if (stored) return structuredClone(stored);
    const m = /^(.+)_(\d{8}(?:T\d{6}Z)?)$/.exec(id);
    const series = m ? cal.events.get(m[1]!)?.raw : undefined;
    if (!series?.recurrence || series.status === "cancelled") return null;
    // The id drops sub-second parts of the series start: look a day past it.
    return instances(cal, series, parseIcalTime(m![2]!) + DAY).find((i) => i.id === id) ?? null;
  }

  const overlaps = (e: CalendarEventRaw, min: number, max: number) => {
    const length = timeOf(e.end) - timeOf(e.start);
    return occurrences(e, max).some((t) => t + length > min && t < max);
  };
  const matchesText = (e: CalendarEventRaw, text: string) =>
    [e.summary, e.description, e.location, e.organizer?.email, e.organizer?.displayName, ...(e.attendees ?? []).flatMap((a) => [a.email, a.displayName])]
      .some((v) => v?.toLowerCase().includes(text));
  /** What listings carry for a deleted event: little more than its id (a cancelled occurrence also says which one, and when). */
  const tombstone = (e: CalendarEventRaw): CalendarEventRaw => ({
    id: e.id,
    status: "cancelled",
    etag: e.etag,
    ...(e.recurringEventId ? { recurringEventId: e.recurringEventId, originalStartTime: e.originalStartTime, updated: e.updated } : {}),
  });

  interface SyncTokenData {
    e: string;
    c: string;
    g: number;
    s: number;
    x: boolean;
  }
  const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  function decode<T>(s: string, what: string): T {
    try {
      return JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as T;
    } catch {
      throw apiError(400, `Invalid ${what} value.`, "invalid");
    }
  }

  function listEvents(cal: FakeCal, q: URLSearchParams) {
    const single = q.get("singleEvents") === "true";
    let since: number | null = null;
    const syncToken = q.get("syncToken");
    if (syncToken) {
      const bad = NOT_WITH_SYNC_TOKEN.find((p) => q.has(p));
      if (bad) throw apiError(400, `The ${bad} parameter can't be used with syncToken.`, "invalid");
      const t = decode<SyncTokenData>(syncToken, "sync token");
      if (t.e !== cal.owner || t.c !== cal.entry.id || t.x !== single) throw apiError(400, "Invalid sync token value.", "invalid");
      if (t.g !== cal.gen) throw apiError(410, "Sync token is no longer valid, a full sync is required.", "fullSyncRequired");
      since = t.s;
    }
    if (q.get("orderBy") === "startTime" && !single) throw apiError(400, "The requested ordering is not available for the particular query.", "badRequest");
    const pageToken = q.get("pageToken");
    const pageState = pageToken ? decode<{ o: number; s: number }>(pageToken, "page token") : { o: 0, s: calSeq };
    const min = q.get("timeMin") ? Date.parse(q.get("timeMin")!) : -Infinity;
    const max = q.get("timeMax") ? Date.parse(q.get("timeMax")!) : Infinity;
    const text = q.get("q")?.toLowerCase();
    const iCalUID = q.get("iCalUID");
    const showDeleted = since !== null || q.get("showDeleted") === "true";

    let items: CalendarEventRaw[] = [];
    for (const { raw, seq } of cal.events.values()) {
      if (since !== null && seq <= since) continue;
      if (raw.status === "cancelled") {
        // Unexpanded listings also carry cancelled occurrences of live series, so clients can hide them.
        const occurrence = !single && raw.recurringEventId && cal.events.get(raw.recurringEventId)?.raw.status !== "cancelled";
        if (showDeleted || (occurrence && overlaps(raw, min, max))) items.push(tombstone(raw));
        continue;
      }
      if (iCalUID && raw.iCalUID !== iCalUID) continue;
      if (text && !matchesText(raw, text)) continue;
      // Exceptions of an expanded series come through its instances.
      if (single && since === null && raw.recurringEventId && cal.events.has(raw.recurringEventId)) continue;
      if (single && raw.recurrence?.length) items.push(...instances(cal, raw, max).filter((i) => overlaps(i, min, max)));
      else if (overlaps(raw, min, max)) items.push(structuredClone(raw));
    }
    if (q.get("orderBy") === "startTime") items = items.sort((a, b) => timeOf(a.start) - timeOf(b.start));
    const pageSize = Math.min(Number(q.get("maxResults") ?? 250) || 250, 2500);
    const pageItems = items.slice(pageState.o, pageState.o + pageSize);
    const more = pageState.o + pageSize < items.length;
    return {
      kind: "calendar#events",
      summary: cal.entry.summary,
      timeZone: cal.entry.timeZone,
      items: pageItems,
      ...(more
        ? { nextPageToken: encode({ o: pageState.o + pageSize, s: pageState.s }) }
        : { nextSyncToken: encode({ e: cal.owner, c: cal.entry.id, g: cal.gen, s: pageState.s, x: single } satisfies SyncTokenData) }),
    };
  }

  /** The event a write targets; 404 when unknown, 410 when deleted, 412 when If-Match doesn't match its etag. */
  function writable(req: IncomingMessage, cal: FakeCal, id: string): CalendarEventRaw {
    if (!canWrite(cal)) throw apiError(403, "You need to have writer access to this calendar.", "requiredAccessLevel");
    const ev = findEvent(cal, decodeURIComponent(id));
    if (!ev) throw apiError(404, "Not Found", "notFound");
    if (ev.status === "cancelled") throw apiError(410, "Resource has been deleted", "deleted");
    const ifMatch = req.headers["if-match"];
    if (ifMatch && ifMatch !== ev.etag) throw apiError(412, "Precondition Failed", "conditionNotMet");
    return ev;
  }

  const SHARED_FIELDS = ["summary", "description", "location", "start", "end", "recurrence", "conferenceData", "visibility", "guestsCanModify"] as const;
  const calRoute = (method: string, path: string, scopes: string[], h: (t: Token, url: URL, body: Buffer, m: RegExpExecArray, req: IncomingMessage) => unknown) =>
    on(method, new RegExp(`^/calendar/v3${path}$`), (req, url, body, m) => h(calendarBearer(req, scopes), url, body, m, req));
  const calParam = (m: RegExpExecArray) => decodeURIComponent(m[1]!);

  calRoute("GET", "/users/me/calendarList", CAL_SCOPES.list, (t, url) => {
    const roles = ["freeBusyReader", "reader", "writer", "owner"];
    const min = roles.indexOf(url.searchParams.get("minAccessRole") ?? "freeBusyReader");
    const all = [...calendarsOf(t.email).values()].map((c) => structuredClone(c.entry)).filter((e) => roles.indexOf(e.accessRole) >= min);
    const { items, next } = page(all, url.searchParams, 100);
    return { kind: "calendar#calendarList", items, ...(next ? { nextPageToken: next } : {}) };
  });

  calRoute("GET", "/calendars/([^/]+)/events", CAL_SCOPES.read, (t, url, _b, m) => listEvents(calendarOf(t.email, calParam(m)), url.searchParams));

  calRoute("POST", "/calendars/([^/]+)/events", CAL_SCOPES.write, (t, url, body, m) => {
    const cal = calendarOf(t.email, calParam(m));
    if (!canWrite(cal)) throw apiError(403, "You need to have writer access to this calendar.", "requiredAccessLevel");
    const input = json(body) as Partial<CalendarEventRaw>;
    // Google's rule for client-chosen ids: base32hex (lowercase a-v, 0-9), 5 to 1024 characters.
    if (input.id !== undefined && !/^[a-v0-9]{5,1024}$/.test(input.id)) throw apiError(400, "Invalid resource id value.", "invalid");
    if (input.id && cal.events.has(input.id)) throw apiError(409, "The requested identifier already exists.", "duplicate");
    if (!input.start || !input.end) throw apiError(400, "Missing end time.", "required");
    const { organizer: _o, ...rest } = input;
    const ev = save(cal, newEvent(cal, rest, url.searchParams.get("conferenceDataVersion")));
    fanOut(ev);
    mailOut(cal.owner, url.searchParams.get("sendUpdates"), "invite", ev.id, guests(ev));
    return ev;
  });

  calRoute("GET", "/calendars/([^/]+)/events/([^/]+)", CAL_SCOPES.read, (t, _u, _b, m) => {
    const ev = findEvent(calendarOf(t.email, calParam(m)), decodeURIComponent(m[2]!));
    if (!ev) throw apiError(404, "Not Found", "notFound");
    return ev;
  });

  calRoute("PATCH", "/calendars/([^/]+)/events/([^/]+)", CAL_SCOPES.write, (t, url, body, m, req) => {
    const cal = calendarOf(t.email, calParam(m));
    const ev = writable(req, cal, m[2]!);
    const patch = json(body) as Partial<CalendarEventRaw>;
    const sendUpdates = url.searchParams.get("sendUpdates");
    if (!ev.organizer?.self) {
      // An invitee may only answer (their own attendee entry); shared properties belong to the organizer.
      if (SHARED_FIELDS.some((f) => f in patch)) throw apiError(403, "Shared properties can only be changed by the organizer of the event.", "forbiddenForNonOrganizer");
      const mine = patch.attendees?.find((a) => a.self || a.email?.toLowerCase() === cal.owner);
      const attendees = ev.attendees?.map((a) =>
        a.email === cal.owner && mine ? { ...a, responseStatus: mine.responseStatus ?? a.responseStatus, ...(mine.comment !== undefined ? { comment: mine.comment } : {}) } : a,
      );
      const saved = save(cal, { ...ev, ...(patch.transparency ? { transparency: patch.transparency } : {}), attendees });
      if (mine) {
        propagateResponse(cal, saved, cal.owner);
        if (ev.organizer?.email) mailOut(cal.owner, sendUpdates, "reply", ev.id, [ev.organizer.email]);
      }
      return saved;
    }
    const organizer = ev.organizer.email!;
    const before = guests(ev);
    const { attendees, attendeesOmitted: _a, id: _i, organizer: _o, ...fields } = patch;
    const next: CalendarEventRaw = {
      ...ev,
      ...fields,
      ...(attendees !== undefined ? { attendees: attendeeList(cal.owner, organizer, attendees, ev.attendees) } : {}),
      ...(patch.conferenceData ? conference(patch, url.searchParams.get("conferenceDataVersion")) : {}),
    };
    const saved = save(cal, next);
    fanOut(saved, before);
    const after = guests(saved);
    mailOut(cal.owner, sendUpdates, "invite", ev.id, after.filter((a) => !before.includes(a)));
    mailOut(cal.owner, sendUpdates, "update", ev.id, after.filter((a) => before.includes(a)));
    mailOut(cal.owner, sendUpdates, "cancel", ev.id, before.filter((a) => !after.includes(a)));
    return saved;
  });

  calRoute("DELETE", "/calendars/([^/]+)/events/([^/]+)", CAL_SCOPES.write, (t, url, _b, m, req) => {
    const cal = calendarOf(t.email, calParam(m));
    const ev = writable(req, cal, m[2]!);
    const saved = save(cal, { ...ev, status: "cancelled" });
    if (ev.organizer?.self) {
      fanOut(saved, guests(ev));
      mailOut(cal.owner, url.searchParams.get("sendUpdates"), "cancel", ev.id, guests(ev));
    }
    return undefined;
  });

  calRoute("POST", "/freeBusy", CAL_SCOPES.freebusy, (t, _u, body) => {
    const b = json(body) as { timeMin?: string; timeMax?: string; items?: { id?: string }[] };
    const min = Date.parse(b.timeMin ?? "");
    const max = Date.parse(b.timeMax ?? "");
    if (!Number.isFinite(min) || !Number.isFinite(max)) throw apiError(400, "Missing timeMin or timeMax.", "required");
    const out: FreeBusyResult["calendars"] = {};
    for (const { id: asked = "" } of b.items ?? []) {
      const id = asked === "primary" ? t.email : asked;
      // Own calendars, or another (fake) user's primary calendar by address.
      const cal = calendarsOf(t.email).get(id) ?? (calendars.has(id.toLowerCase()) ? primaryOf(id) : undefined);
      if (!cal) {
        out[asked] = { busy: [], errors: [{ domain: "global", reason: "notFound" }] };
        continue;
      }
      const busy: [number, number][] = [];
      for (const { raw } of cal.events.values()) {
        if (raw.status === "cancelled" || raw.transparency === "transparent") continue;
        if (raw.attendees?.find((a) => a.email === cal.owner)?.responseStatus === "declined") continue;
        if (raw.recurringEventId && cal.events.has(raw.recurringEventId)) continue;
        for (const i of raw.recurrence?.length ? instances(cal, raw, max) : [raw]) {
          const s = timeOf(i.start);
          const e = timeOf(i.end);
          if (e > min && s < max) busy.push([Math.max(s, min), Math.min(e, max)]);
        }
      }
      const merged: [number, number][] = [];
      for (const iv of busy.sort((x, y) => x[0] - y[0])) {
        const last = merged.at(-1);
        if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
        else merged.push([...iv]);
      }
      out[asked] = { busy: merged.map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() })) };
    }
    return { kind: "calendar#freeBusy", timeMin: b.timeMin, timeMax: b.timeMax, calendars: out };
  });

  const calendarApi: FakeCalendar = {
    addCalendar(email, opts) {
      const id = opts.id ?? `${randomBytes(16).toString("hex")}@group.calendar.google.com`;
      return addCalendarTo(email.toLowerCase(), {
        id,
        summary: opts.name,
        accessRole: opts.accessRole ?? "owner",
        timeZone: opts.timeZone ?? "UTC",
        backgroundColor: "#9fe1e7",
        selected: !opts.hidden,
        ...(opts.hidden ? { hidden: true } : {}),
      });
    },
    removeCalendar(email, calendarId) {
      calendarsOf(email).delete(calendarOf(email, calendarId, false).entry.id);
    },
    putEvent(email, calendarId, input) {
      const cal = calendarOf(email, calendarId, false);
      const existing = input.id ? cal.events.get(input.id)?.raw : undefined;
      return save(cal, existing ? { ...existing, ...input, id: existing.id } : newEvent(cal, input));
    },
    invite(organizer, attendees, input) {
      const org = organizer.toLowerCase();
      const list = attendees.map((email) => ({ email: email.toLowerCase() }));
      if (calendars.has(org)) {
        const ev = save(primaryOf(org), newEvent(primaryOf(org), { ...input, attendees: list }));
        fanOut(ev);
        return ev;
      }
      // An outside organizer: only the fake attendees' copies exist here.
      const id = input.id ?? randomBytes(13).toString("hex");
      const source: CalendarEventRaw = {
        ...input,
        id,
        status: input.status ?? "confirmed",
        created: input.created ?? new Date().toISOString(),
        iCalUID: input.iCalUID ?? `${id}@google.com`,
        organizer: { email: org, ...(input.organizer?.displayName ? { displayName: input.organizer.displayName } : {}) },
        creator: { email: org },
        attendees: attendeeList("", org, list),
        eventType: input.eventType ?? "default",
      };
      fanOut(source);
      return structuredClone(source);
    },
    respond(email, eventId, status) {
      const cal = primaryOf(email);
      const ev = cal.events.get(eventId)?.raw;
      if (!ev?.attendees?.some((a) => a.email === cal.owner)) throw new Error(`fake-google: ${email} isn't invited to ${eventId}`);
      const saved = save(cal, { ...ev, attendees: ev.attendees.map((a) => (a.email === cal.owner ? { ...a, responseStatus: status } : a)) });
      propagateResponse(cal, saved, cal.owner);
    },
    cancelEvent(email, calendarId, eventId) {
      const cal = calendarOf(email, calendarId, false);
      const ev = cal.events.get(eventId)?.raw;
      if (!ev) throw new Error(`fake-google: no event ${eventId} on ${calendarId}`);
      const saved = save(cal, { ...ev, status: "cancelled" });
      if (ev.organizer?.self) fanOut(saved, guests(ev));
    },
    events: (email, calendarId) => [...calendarOf(email, calendarId, false).events.values()].filter((e) => e.raw.status !== "cancelled").map((e) => structuredClone(e.raw)),
    event: (email, calendarId, id) => findEvent(calendarOf(email, calendarId, false), id),
    expireSyncTokens(email, calendarId) {
      for (const cal of calendarsOf(email).values()) if (!calendarId || cal.entry.id === calendarId || (calendarId === "primary" && cal.entry.primary)) cal.gen++;
    },
    mailsSent: (email) => [...(calMails.get(email.toLowerCase()) ?? [])],
  };

  // ───── Google Drive (read-only) ─────

  const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive"];
  const driveFiles = new Map<string, Map<string, FakeDriveFileInput & { id: string }>>();
  let nextDriveId = 1;

  on("GET", /^\/drive\/v3\/files\/([^/]+)$/, (req, _u, _b, m) => {
    const t = calendarBearer(req, DRIVE_SCOPES, "drive");
    const f = driveFiles.get(t.email)?.get(decodeURIComponent(m[1]!));
    if (!f) throw apiError(404, `File not found: ${decodeURIComponent(m[1]!)}.`, "notFound");
    return { id: f.id, name: f.name, mimeType: f.mimeType };
  });

  const driveApi: FakeDrive = {
    addFile(email, file) {
      const key = email.toLowerCase();
      box(key);
      const id = file.id ?? `1fakeDrive${String(nextDriveId++).padStart(6, "0")}Xy`;
      let files = driveFiles.get(key);
      if (!files) driveFiles.set(key, (files = new Map()));
      files.set(id, { ...file, id });
      return id;
    },
  };

  // ───── Google Workspace files: Docs, Sheets, Slides, Drive about/list (code extensions' Google access) ─────
  // Same store as Drive above. Each route checks the token like Google: valid, the API on in the project (403
  // SERVICE_DISABLED), then one of the API's scopes (403 ACCESS_TOKEN_SCOPE_INSUFFICIENT). A token minted for Gmail
  // only never passes here, and one minted for these scopes never passes the Gmail routes.

  const W = "https://www.googleapis.com/auth/";
  function workspaceBearer(req: IncomingMessage, api: FakeApi, scopes: string[]): Token {
    const t = accessTokens.get((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    if (!valid(t) || t.expiresAt < Date.now()) throw apiError(401, "Request had invalid authentication credentials. Expected OAuth 2 access token.", "authError");
    if (disabled.has(api)) throw serviceDisabled(api);
    if (!scopes.some((s) => t.scopes.includes(`${W}${s}`))) {
      throw apiError(403, "Request had insufficient authentication scopes.", "insufficientPermissions", {
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", domain: "googleapis.com" }],
      });
    }
    return t;
  }
  const filesOf = (email: string) => driveFiles.get(email.toLowerCase()) ?? new Map<string, FakeDriveFileInput & { id: string }>();
  const fileOr404 = (email: string, id: string, mime: string) => {
    const f = filesOf(email).get(id);
    if (!f || f.mimeType !== mime) throw apiError(404, `Requested entity was not found.`, "notFound");
    return f;
  };
  on("GET", /^\/drive\/v3\/about$/, (req) => {
    const t = workspaceBearer(req, "drive", ["drive", "drive.readonly", "drive.file", "drive.metadata.readonly"]);
    return { kind: "drive#about", user: { emailAddress: t.email } };
  });
  on("GET", /^\/drive\/v3\/files$/, (req) => {
    const t = workspaceBearer(req, "drive", ["drive", "drive.readonly", "drive.metadata.readonly"]);
    return { kind: "drive#fileList", files: [...filesOf(t.email).values()].map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })) };
  });
  on("GET", /^\/v1\/documents\/([^/]+)$/, (req, _url, _b, m) => {
    const t = workspaceBearer(req, "docs", ["documents", "documents.readonly", "drive", "drive.readonly", "drive.file"]);
    const f = fileOr404(t.email, decodeURIComponent(m[1]!), "application/vnd.google-apps.document");
    return { documentId: f.id, title: f.name };
  });
  on("GET", /^\/v4\/spreadsheets\/([^/]+)$/, (req, _url, _b, m) => {
    const t = workspaceBearer(req, "sheets", ["spreadsheets", "spreadsheets.readonly", "drive", "drive.readonly", "drive.file"]);
    const f = fileOr404(t.email, decodeURIComponent(m[1]!), "application/vnd.google-apps.spreadsheet");
    return { spreadsheetId: f.id, properties: { title: f.name } };
  });
  on("GET", /^\/v1\/presentations\/([^/]+)$/, (req, _url, _b, m) => {
    const t = workspaceBearer(req, "slides", ["presentations", "presentations.readonly", "drive", "drive.readonly", "drive.file"]);
    const f = fileOr404(t.email, decodeURIComponent(m[1]!), "application/vnd.google-apps.presentation");
    return { presentationId: f.id, title: f.name };
  });

  // ───── Server ─────

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    fake.requests.push({ method, path: url.pathname });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    try {
      const rule = failRules.find(
        (r) => r.left > 0 && (!r.method || r.method === method) && (typeof r.path === "string" ? url.pathname.includes(r.path) : r.path.test(url.pathname)),
      );
      const injected = () => {
        rule!.left--;
        const fail = apiError(rule!.status, rule!.message ?? `Injected failure ${rule!.status}`, rule!.reason);
        return new HttpFail(fail.status, fail.body, rule!.retryAfter !== undefined ? { "retry-after": String(rule!.retryAfter) } : {});
      };
      if (rule && !rule.afterProcessing) throw injected();
      for (const [m, re, h] of routes) {
        if (m !== method) continue;
        const match = re.exec(url.pathname);
        if (!match) continue;
        const out = await h(req, url, body, match, res);
        if (rule?.afterProcessing) throw injected();
        if (res.headersSent || res.writableEnded) return;
        if (out === undefined) res.writeHead(204).end();
        else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
        return;
      }
      // Google answers unknown paths and wrong verbs with an HTML page.
      throw new HttpFail(404, `<!DOCTYPE html><html lang=en><title>Error 404 (Not Found)!!1</title><p><b>404.</b> <ins>That’s an error.</ins><p>The requested URL <code>${url.pathname}</code> was not found on this server. <ins>That’s all we know.</ins>`);
    } catch (err) {
      if (res.writableEnded) return;
      if (err instanceof HttpFail) {
        const isText = typeof err.body === "string";
        res.writeHead(err.status, { "content-type": isText ? "text/html" : "application/json", ...err.headers });
        res.end(isText ? err.body : JSON.stringify(err.body));
      } else {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 500, message: String(err), status: "INTERNAL" } }));
      }
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const fake: FakeGoogle = {
    url,
    google: { oauthBase: url, authBase: url, gmailBase: url, calendarBase: url, apisBase: url },
    accessTokenTtl: 3600,
    refreshTokenTtl: null,
    registeredRedirectUris: null,
    revoked: [],
    requests: [],
    uploads: [],
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    addAccount(email, opts = {}) {
      const key = email.toLowerCase();
      if (mailboxes.has(key)) return;
      const labels = new Map<string, GmailLabelRaw>(SYSTEM_LABELS.map((id) => [id, { id, name: id, type: "system" as const }]));
      mailboxes.set(key, {
        email: key,
        name: opts.name ?? key.split("@")[0]!,
        historyId: 1000,
        minHistoryId: 0,
        messages: new Map(),
        history: [],
        labels,
        drafts: new Map(),
        nextLabel: 1,
        workspaceDomain: opts.workspaceDomain?.toLowerCase() ?? null,
      });
      calendars.set(key, new Map());
      addCalendarTo(key, { id: key, summary: key, accessRole: "owner", primary: true, timeZone: "UTC", backgroundColor: "#9fe1e7", selected: true });
    },
    addLabel(email, name) {
      const mb = box(email);
      const existing = [...mb.labels.values()].find((l) => l.name === name);
      if (existing) return existing.id;
      const id = `Label_${mb.nextLabel++}`;
      mb.labels.set(id, { id, name, type: "user" });
      return id;
    },
    consentAs(email, opts = {}) {
      box(email);
      consents.push({ email: email.toLowerCase(), ...opts });
    },
    deliver(email, input) {
      const mb = box(email);
      const thread = input.threadId ? threadMessages(mb, input.threadId) : [];
      const parent = thread.at(-1);
      const headers = { ...input.headers };
      if (parent?.messageIdHeader && !Object.keys(headers).some((k) => k.toLowerCase() === "in-reply-to")) {
        headers["In-Reply-To"] = parent.messageIdHeader;
        headers.References = thread.map((m) => m.messageIdHeader).filter(Boolean).join(" ");
      }
      const raw = buildRaw({
        ...input,
        headers,
        to: input.to ?? (mb.name ? `${mb.name} <${mb.email}>` : mb.email),
        messageId: `<fake-${randomBytes(8).toString("hex")}@mail.example>`,
      });
      const msg = makeMessage(mb, raw, input.labelIds ?? ["INBOX", "UNREAD"], input.threadId ?? null, input.date);
      insert(mb, msg);
      return format(msg, "full");
    },
    setLabels(email, messageId, add, removeIds) {
      const mb = box(email);
      modify(mb, msgOr404(mb, messageId), add, removeIds);
    },
    failRefresh(email, opts = {}) {
      revokeGrant(email.toLowerCase(), opts.rapt);
    },
    expireAccessTokens(email) {
      for (const t of accessTokens.values()) if (t.email === email.toLowerCase()) t.expiresAt = 0;
    },
    expireHistory(email) {
      const mb = box(email);
      // Every cursor handed out so far becomes too old; the profile's (bumped) historyId stays valid.
      mb.historyId++;
      mb.minHistoryId = mb.historyId;
    },
    disableApi(api, on) {
      if (on) disabled.add(api);
      else disabled.delete(api);
    },
    failNext(rule) {
      failRules.push({ ...rule, left: rule.times ?? 1 });
    },
    sent: (email) => {
      const mb = box(email);
      return [...mb.messages.values()].filter((m) => m.labelIds.includes("SENT")).map((m) => format(m));
    },
    drafts: (email) => {
      const mb = box(email);
      return [...mb.drafts.entries()].flatMap(([id, mid]) => {
        const m = mb.messages.get(mid);
        return m ? [{ id, message: format(m) }] : [];
      });
    },
    messages: (email) => {
      const mb = box(email);
      return [...mb.messages.values()].map((m) => format(m));
    },
    message: (email, id) => {
      const mb = box(email);
      const m = mb.messages.get(id);
      return m ? format(m) : null;
    },
    calendar: calendarApi,
    refreshes: [],
    ignoreRefreshScope: false,
    refreshAddsIdentity: false,
    tokenScopes(accessToken) {
      const t = accessTokens.get(accessToken);
      return t ? { email: t.email, scopes: [...t.scopes] } : null;
    },
    issued: () => [...accessTokens].map(([accessToken, t]) => ({ accessToken, email: t.email, scopes: [...t.scopes] })),
    drive: driveApi,
  };
  return fake;
}

// ───────────── Test helpers ─────────────

/**
 * Configures the fake OAuth client (unless already set) and runs the whole connect flow for `email`
 * (adding the mailbox if needed): startConnect → fake consent → completeConnectFromUrl.
 * `scopes` overrides what the fake user grants on the consent screen.
 */
export async function connectFakeAccount(
  ctx: AppContext,
  fake: FakeGoogle,
  email: string,
  opts: { name?: string; reauthAccountId?: string; scopes?: string[] } = {},
): Promise<Account> {
  if (!ctx.google.clientView().hasSecret) ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
  fake.addAccount(email, { name: opts.name });
  fake.consentAs(email, { scopes: opts.scopes });
  const { authUrl } = ctx.google.startConnect({ reauthAccountId: opts.reauthAccountId });
  const res = await fetch(authUrl, { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) throw new Error(`fake consent failed: HTTP ${res.status} ${await res.text()}`);
  return ctx.google.completeConnectFromUrl(location);
}

/**
 * A minimal EventsService that records emits and enforces dedupe keys, for tests that don't want the
 * real events pipeline: `testContext({ events: rec.factory })`, then inspect `rec.events`.
 */
export function recordingEvents() {
  const events: (NewEvent & { seq: number })[] = [];
  const keys = new Set<string>();
  const notImplemented = () => {
    throw new Error("recordingEvents: not implemented");
  };
  const service: EventsService = {
    emit(e) {
      if (keys.has(e.dedupeKey)) return null;
      keys.add(e.dedupeKey);
      const seq = events.length + 1;
      events.push({ ...e, seq });
      return {
        id: `evt_${seq}`,
        seq,
        type: e.type,
        accountId: e.accountId ?? "",
        accountEmail: "",
        ...(e.connectionId ? { connectionId: e.connectionId } : {}),
        message: e.message ?? null,
        ...(e.calendarEvent ? { calendarEvent: e.calendarEvent } : {}),
        labelIds: e.labelIds,
        detail: e.detail,
        createdAt: new Date().toISOString(),
      };
    },
    get: notImplemented,
    list: notImplemented,
    feed: notImplemented,
    wait: notImplemented,
    ack: notImplemented,
    prune: () => 0,
  };
  return {
    events,
    factory: () => service,
    ofType: (type: NewEvent["type"]) => events.filter((e) => e.type === type),
  };
}
