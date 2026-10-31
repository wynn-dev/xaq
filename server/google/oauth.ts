import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Account, ApiError as ApiErrorBody, ConnectAccountResponse, ConnectAttempt, ExtraScopeName } from "../../shared/types.ts";
import { ADMIN_ACTOR } from "../api/util.ts";
import { calendarEnabled, CONNECT_PROBE_WAIT_MS, probeCalendar } from "../calendar/setup.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { badRequest, errorMessage, HttpError } from "../util/errors.ts";
import { newId, randomToken } from "../util/ids.ts";
import { type AccountRow, accountScopes, getRow, toAccount } from "./accounts.ts";
import { callbackMode, clientCredentials, markRedirectVerified } from "./client.ts";
import { asHttpError, buildUrl, REQUEST_TIMEOUT_MS } from "./http.ts";
import { postToken, refreshExpiry, refreshExpiryKind, type TokenResponse } from "./tokens.ts";
import {
  CALENDAR_SCOPES,
  describeScopes,
  EXTRA_SCOPE_SETS,
  GMAIL_SCOPE,
  hasScopes,
  IDENTITY_TOKEN_SCOPES,
  MAIL_SCOPES,
  missingScopes,
  scopeGrants,
  scopeWithout,
} from "./scopes.ts";
import { GoogleApiError } from "./types.ts";

export { GMAIL_SCOPE };
/** Every account: Gmail plus identity (for the display name). See server/google/scopes.ts. */
export const BASE_SCOPES = [...MAIL_SCOPES];

const STATE_TTL_MS = 15 * 60_000;

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Human explanations for errors Google returns on the redirect or the token endpoint. `redirectUri` is
 * the exact URI this instance uses (for redirect_uri_mismatch).
 */
export function oauthErrorHint(code: string, redirectUri?: string, opts: { calendar?: boolean } = {}): { message: string; hint: string } {
  switch (code) {
    // On the redirect this only ever means the user said no: Google shows its own blocking errors
    // (not a test user, unverified app) on its page and never redirects back with them.
    case "access_denied":
      return {
        message: "You clicked Cancel (or denied access) on Google's screen, so nothing was connected.",
        hint:
          "Nothing needs fixing in Google Cloud. Start the connection again and click Continue on each Google screen " +
          "(on \"Google hasn't verified this app\": Advanced → Go to <your app name> (unsafe)), keeping the Gmail permission ticked.",
      };
    case "org_internal":
      return {
        message: "This OAuth app is Internal, so only accounts in its own Google Workspace organization can connect.",
        hint:
          "Sign in with an account from that Workspace organization. To connect personal (non-Workspace) Google accounts or other organizations' accounts, " +
          "make the app External instead: Google Cloud → Google Auth Platform → Audience → Make external, then publish it (In production).",
      };
    case "admin_policy_enforced":
      // Admins can block Calendar (or any scope) for apps they haven't configured; Google then rejects the
      // whole consent, Gmail included. Mail alone may still be allowed.
      if (opts.calendar) {
        return {
          message: "Your Google Workspace admin blocks this app, or blocks Google Calendar access for apps they haven't approved, so Google rejected the whole sign-in.",
          hint:
            "Connect again with mail only (the connect dialog offers it), or turn Calendar off in Settings → Google Calendar → Turn off: mail needs only Gmail access. " +
            "To use Calendar later, ask the admin to trust the OAuth client ID in Admin console → Security → API controls → App access control.",
        };
      }
      return {
        message: "Your Google Workspace admin blocks this app.",
        hint: "Ask the admin to trust the OAuth client ID in Admin console → Security → API controls → App access control.",
      };
    case "redirect_uri_mismatch":
      return {
        message: "Google rejected the redirect URI.",
        hint: redirectUri
          ? `In Google Cloud → Clients → your client → Authorized redirect URIs, add exactly ${redirectUri} (no trailing slash), save, wait a minute, then connect again.`
          : "Add the exact redirect URI shown in the setup wizard to the OAuth client's Authorized redirect URIs.",
      };
    case "invalid_client":
    case "unauthorized_client":
      return {
        message: "Google rejected the client ID or secret.",
        hint:
          "Re-import the client JSON (Clients → your client → Download JSON). If the downloaded file has no secret, " +
          "click Add secret on that page and enter the ID and new secret manually. The client type must be Web application.",
      };
    case "invalid_grant":
      return {
        message: "The authorization code is invalid or has expired.",
        hint: "Codes are single-use and expire quickly. Start the connection again from the console.",
      };
    default:
      return { message: `Google returned an error: ${code}.`, hint: "Start the connection again from the console." };
  }
}

/** Google error codes oauthErrorHint explains; any other code is reported as "oauth_error" where it's stored. */
export const KNOWN_OAUTH_ERRORS = new Set(["access_denied", "org_internal", "admin_policy_enforced", "redirect_uri_mismatch", "invalid_client", "unauthorized_client", "invalid_grant"]);

/**
 * An error Google reported (on the redirect or the token endpoint). The redirect's `error` and
 * `error_description` come from the URL, so anyone holding a pending state can choose them: the
 * attempt status (connectAttempt) keeps only `googleCode`'s fixed explanation, never the text.
 */
export class GoogleOAuthError extends HttpError {
  constructor(
    readonly googleCode: string,
    message: string,
    hint: string,
    readonly redirectUri: string,
    /** The consent asked for the Calendar scopes too (changes some explanations). */
    readonly calendar = false,
  ) {
    super(400, `oauth_${googleCode}`, message, hint);
  }
}

const oauthError = (ctx: AppContext, code: string, description?: string | null, redirectUri?: string, calendar = false) => {
  const uri = redirectUri ?? callbackMode(ctx).redirectUri;
  const { message, hint } = oauthErrorHint(code, uri, { calendar });
  return new GoogleOAuthError(code, description && !message.includes(description) ? `${message} (${description})` : message, hint, uri, calendar);
};

/**
 * Starts a consent flow. `scopes: ["calendar"]` adds
 * CALENDAR_SCOPES; with `reauthAccountId` that is "Add Calendar to <email>" (see calendarAttempts). While
 * Calendar is part of this install (calendarEnabled), every connect and reconnect asks for it too, and a
 * reconnect asks again for calendar scopes the account had. `mailOnly` asks for neither: when a Workspace
 * admin blocks Calendar, Google rejects any consent that includes it, so mail must be reconnectable
 * without it. Extra scopes are incremental (include_granted_scopes): Google asks only for what isn't
 * granted yet, and keeps what it still grants.
 */
export function startConnect(
  ctx: AppContext,
  opts: { reauthAccountId?: string; scopes?: ExtraScopeName[]; mailOnly?: boolean; extension?: ExtensionConsent } = {},
): ConnectAccountResponse {
  const { clientId } = clientCredentials(ctx);
  const extra = new Set(opts.scopes ?? []);
  if (opts.mailOnly && extra.has("calendar")) throw badRequest("A mail-only connection can't add Google Calendar.", "Leave out either mailOnly or scopes [\"calendar\"].");
  const ext = opts.extension ?? null;
  if (ext && (!opts.reauthAccountId || extra.size || opts.mailOnly)) throw badRequest("An extension's consent is for one connected account, and only for the extension's access.");
  const reauthId = opts.reauthAccountId;
  const reauth = reauthId ? ctx.accounts.require(reauthId) : null;
  const addingCalendarTo = reauth && extra.has("calendar") ? reauth.email : null;
  // A reconnect asks again for extra scopes the account had: after a revocation Google forgets them.
  const had = reauthId ? accountScopes(getRow(ctx, reauthId)!) : [];
  // An extension's consent asks for the extension's scopes on top of what the account has: never for Calendar on its
  // own (that's Add Calendar's job), so the user sees only the new permissions.
  const calendarWanted = !opts.mailOnly && calendarEnabled(ctx) && (!ext || CALENDAR_SCOPES.some((s) => had.includes(s)));
  for (const [name, set] of Object.entries(EXTRA_SCOPE_SETS) as [ExtraScopeName, readonly string[]][]) {
    if (set.some((s) => had.includes(s)) && (name !== "calendar" || calendarWanted)) extra.add(name);
  }
  if (calendarWanted) extra.add("calendar");
  // Scopes the account granted outside xaq's named sets (an extension's earlier consent) are asked again too, so a
  // reconnect never drops them; include_granted_scopes keeps them anyway while Google still has them.
  const kept = had.filter(
    (s) => s.startsWith("https://www.googleapis.com/auth/") && !BASE_SCOPES.includes(s) && !IDENTITY_TOKEN_SCOPES.includes(s) && !Object.values(EXTRA_SCOPE_SETS).some((set: readonly string[]) => set.includes(s)),
  );
  const scopes = [...new Set([...BASE_SCOPES, ...[...extra].flatMap((x) => EXTRA_SCOPE_SETS[x]), ...kept, ...(ext?.scopes ?? [])])];
  const { mode, redirectUri } = callbackMode(ctx);
  const state = randomToken(32);
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  ctx.db.run("DELETE FROM oauth_states WHERE created_at < ?", new Date(Date.now() - STATE_TTL_MS).toISOString());
  ctx.db.run(
    "INSERT INTO oauth_states (state, code_verifier, redirect_uri, reauth_account_id, created_at) VALUES (?, ?, ?, ?, ?)",
    state,
    verifier,
    redirectUri,
    reauth?.id ?? null,
    now(),
  );
  if (extra.has("calendar")) rememberCalendarAttempt(ctx, state, addingCalendarTo);
  if (ext && reauth) rememberExtensionAttempt(ctx, state, { ...ext, email: reauth.email });
  const authUrl = buildUrl(ctx.config.google.authBase, "/o/oauth2/v2/auth", {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    login_hint: reauth?.email,
  });
  return { authUrl, state, callbackMode: mode };
}

/**
 * Pending consents that asked for Calendar, by state. `addingTo` is set for "Add Calendar to <email>" (a
 * reconnect with scopes ["calendar"]): a cancel or an unticked Calendar is then reported as that (the
 * account and its mail are unchanged) rather than as a failed connection. In memory like `completed`:
 * after a restart the generic messages apply.
 */
interface CalendarAttempt {
  addingTo: string | null;
  at: number;
}
const calendarAttempts = new WeakMap<AppContext, Map<string, CalendarAttempt>>();

function rememberCalendarAttempt(ctx: AppContext, state: string, addingTo: string | null): void {
  let m = calendarAttempts.get(ctx);
  if (!m) calendarAttempts.set(ctx, (m = new Map()));
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of m) if (v.at < cutoff || m.size >= COMPLETED_MAX) m.delete(k);
  m.set(state, { addingTo, at: Date.now() });
}

/** Whether a state's consent asked for Calendar, and for which account it was adding it (single use). */
function takeCalendarAttempt(ctx: AppContext, state: string): CalendarAttempt | null {
  const m = calendarAttempts.get(ctx);
  const hit = m?.get(state);
  m?.delete(state);
  return hit && hit.at >= Date.now() - STATE_TTL_MS ? hit : null;
}

/** An admin blocked an explicit "Add Calendar to <email>": the account is as it was. */
const calendarBlocked = (ctx: AppContext, email: string) =>
  new HttpError(
    400,
    "oauth_admin_policy_enforced",
    `Your Google Workspace admin doesn't allow xaq to use Google Calendar, so nothing changed for ${email}: its mail is unaffected.`,
    `Ask your admin to trust the app: Admin console → Security → API controls → App access control → trust the OAuth client ID ${clientCredentials(ctx).clientId}. Then click Add Calendar for ${email} again.`,
  );

const calendarCancelled = (email: string) =>
  new HttpError(
    400,
    "oauth_access_denied",
    `You cancelled adding Google Calendar to ${email}, so nothing changed: its mail keeps working as before.`,
    `To add it, click Add Calendar for ${email} again and choose Continue on Google's screens, leaving the Calendar permissions ticked.`,
  );

/** The consent went through but Calendar was (partly) unticked. The account was saved as usual: mail is unaffected. */
const calendarNotGranted = (email: string, missing: string[]) => {
  const all = missing.length === CALENDAR_SCOPES.length;
  return new HttpError(
    400,
    "oauth_calendar_not_granted",
    all
      ? `Google Calendar wasn't added to ${email}: its Calendar permissions were unticked on Google's screen. Its mail keeps working as before.`
      : `Google Calendar was only partly added to ${email}: some Calendar permissions were unticked on Google's screen (${describeScopes(missing)}). Its mail keeps working as before.`,
    `Click Add Calendar for ${email} again and tick every Calendar permission on Google's screen. Agents can't use ${email}'s calendar until all of them are granted.`,
  );
};

/**
 * A code extension's incremental consent (docs/EXTENSIONS.md "Google accounts for code extensions"): exactly its
 * manifest's scopes, on top of what one connected account already granted, for one connection. `onDone` runs once
 * Google answered and the account's tokens and granted scopes were saved (with what was granted).
 */
export interface ExtensionConsent {
  connectionId: string;
  /** The extension's display name ("Google Workspace"), for the messages. */
  displayName: string;
  /** The connection's name, for "click Reconnect on <name>" (default: displayName). */
  connectionName?: string;
  scopes: readonly string[];
  onDone?: (accountId: string, granted: string[]) => void;
}

interface ExtensionAttempt extends ExtensionConsent {
  email: string;
  at: number;
}
const extensionAttempts = new WeakMap<AppContext, Map<string, ExtensionAttempt>>();

function rememberExtensionAttempt(ctx: AppContext, state: string, a: Omit<ExtensionAttempt, "at">): void {
  let m = extensionAttempts.get(ctx);
  if (!m) extensionAttempts.set(ctx, (m = new Map()));
  // Expired ones go; then, when full, only the oldest pending ones (Map keeps insertion order), never the rest.
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [k, v] of m) if (v.at < cutoff) m.delete(k);
  while (m.size >= COMPLETED_MAX) m.delete(m.keys().next().value!);
  m.set(state, { ...a, at: Date.now() });
}

function takeExtensionAttempt(ctx: AppContext, state: string): ExtensionAttempt | null {
  const m = extensionAttempts.get(ctx);
  const hit = m?.get(state);
  m?.delete(state);
  return hit && hit.at >= Date.now() - STATE_TTL_MS ? hit : null;
}

/** The connection a pending extension consent is for (paste mode routes the pasted address by it); not consumed. */
export function extensionConsentConnection(ctx: AppContext, state: string): string | null {
  const hit = state ? extensionAttempts.get(ctx)?.get(state) : undefined;
  return hit && hit.at >= Date.now() - STATE_TTL_MS ? hit.connectionId : null;
}

/** Plain words for unticked extension scopes: what each would have allowed, and what won't work without it. */
export function describeMissing(missing: readonly string[]): string {
  return missing.map((s) => `${scopeGrants(s)}${scopeWithout(s) ? ` (without it, ${scopeWithout(s)})` : ""}`).join("; ");
}

/** The console's own button for another try: Reconnect on the connection (Connections → <name>). */
const reconnectIt = (a: ExtensionAttempt) => `click Reconnect on ${a.connectionName ?? a.displayName} (Connections → ${a.connectionName ?? a.displayName})`;

const extensionCancelled = (a: ExtensionAttempt) =>
  new HttpError(
    400,
    "oauth_access_denied",
    `You cancelled giving ${a.displayName} access to ${a.email}, so nothing changed: the account's mail keeps working as before.`,
    `To try again, ${reconnectIt(a)} and choose Continue on Google's screens, leaving its permissions ticked.`,
  );

const extensionBlocked = (ctx: AppContext, a: ExtensionAttempt) =>
  new HttpError(
    400,
    "oauth_admin_policy_enforced",
    `Your Google Workspace admin doesn't allow xaq's app this access, so nothing changed for ${a.email}: its mail is unaffected.`,
    `Ask your admin to trust the app: Admin console → Security → API controls → App access control → trust the OAuth client ID ${clientCredentials(ctx).clientId}. Then ${reconnectIt(a)}.`,
  );

/** Saved, but some of the extension's permissions were unticked: what's missing and what won't work. */
const extensionNotGranted = (a: ExtensionAttempt, missing: string[]) => {
  const none = missing.length === new Set(a.scopes).size;
  return new HttpError(
    400,
    "oauth_extension_not_granted",
    none
      ? `${a.displayName} didn't get access to ${a.email}: every one of its permissions was unticked on Google's screen. The account's mail keeps working as before.`
      : `${a.displayName} got only part of the access it asks for on ${a.email}. Not granted: ${describeMissing(missing)}. The rest works, and the account's mail is unaffected.`,
    `To grant the rest, ${reconnectIt(a)} and tick every box on Google's screen.`,
  );
};

/** What a Google error on the redirect or the token endpoint means for this consent. */
function consentError(
  ctx: AppContext,
  code: string,
  description: string | null,
  redirectUri: string | undefined,
  calendar: CalendarAttempt | null,
  ext: ExtensionAttempt | null = null,
): HttpError {
  if (ext && code === "access_denied") return extensionCancelled(ext);
  if (ext && code === "admin_policy_enforced") return extensionBlocked(ctx, ext);
  if (calendar?.addingTo && code === "access_denied") return calendarCancelled(calendar.addingTo);
  if (calendar?.addingTo && code === "admin_policy_enforced") return calendarBlocked(ctx, calendar.addingTo);
  return oauthError(ctx, code, description, redirectUri, !!calendar);
}

/**
 * Connections that completed, by state, so reloading the callback page (or pasting its address again)
 * says "Already connected" instead of failing. Lookups need the same code too, and only ever report:
 * the state itself is gone from oauth_states, so it can't be used again. In memory; a restart forgets.
 */
const completed = new WeakMap<AppContext, Map<string, { codeHash: Buffer; accountId: string; at: number }>>();
export const COMPLETED_TTL_MS = 60 * 60_000;
export const COMPLETED_MAX = 200;
const digest = (s: string) => createHash("sha256").update(s).digest();

/** Records a state + code that connected `accountId` (exported for tests). Oldest entries go first past COMPLETED_MAX. */
export function rememberCompleted(ctx: AppContext, state: string, code: string, accountId: string): void {
  let m = completed.get(ctx);
  if (!m) completed.set(ctx, (m = new Map()));
  const cutoff = Date.now() - COMPLETED_TTL_MS;
  for (const [k, v] of m) if (v.at < cutoff || m.size >= COMPLETED_MAX) m.delete(k);
  m.set(state, { codeHash: digest(code), accountId, at: Date.now() });
}

/**
 * Failed connections, by state: the sign-in window can't always tell the console (another origin, a severed
 * opener), so the console asks with POST /api/accounts/connect/status. Only states that were pending are
 * recorded (never attacker-chosen ones), and never over a success. Same TTL, cap and lifetime as `completed`.
 */
const failed = new WeakMap<AppContext, Map<string, { code: string; error: string; hint: string | null; at: number }>>();

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What the attempt status reports for a failure: fixed text for Google's codes, capped lengths for the rest. */
export function storedFailure(err: unknown): { code: string; error: string; hint: string | null } {
  const e = asHttpError(err);
  if (e instanceof GoogleOAuthError) {
    if (!KNOWN_OAUTH_ERRORS.has(e.googleCode)) return { code: "oauth_error", error: "Google returned an error, so nothing was connected.", hint: "Start the connection again from the console." };
    const { message, hint } = oauthErrorHint(e.googleCode, e.redirectUri, { calendar: e.calendar });
    return { code: `oauth_${e.googleCode}`, error: message, hint };
  }
  if (e instanceof HttpError) return { code: cap(e.code, 64), error: cap(e.message, 500), hint: e.hint ? cap(e.hint, 1000) : null };
  return { code: "internal", error: "Something went wrong while finishing the connection.", hint: "Check the xaq server log, then try again." };
}

/** Records how a pending state failed (exported for tests). Never replaces a success for the same state. */
export function rememberFailed(ctx: AppContext, state: string, err: unknown): void {
  if (completed.get(ctx)?.has(state)) return;
  let m = failed.get(ctx);
  if (!m) failed.set(ctx, (m = new Map()));
  const cutoff = Date.now() - COMPLETED_TTL_MS;
  for (const [k, v] of m) if (v.at < cutoff || m.size >= COMPLETED_MAX) m.delete(k);
  m.set(state, { ...storedFailure(err), at: Date.now() });
}

/**
 * What became of the sign-in started with `state` (ConnectAccountResponse.state). Admin-only: the console
 * that started it asks when the callback page's message can't reach it.
 */
export function connectAttempt(ctx: AppContext, state: string): ConnectAttempt {
  if (!state) return { status: "unknown" };
  const cutoff = Date.now() - COMPLETED_TTL_MS;
  const ok = completed.get(ctx)?.get(state);
  if (ok && ok.at >= cutoff) {
    const row = getRow(ctx, ok.accountId);
    if (row) return { status: "connected", accountId: row.id, email: row.email };
  }
  const bad = failed.get(ctx)?.get(state);
  if (bad && bad.at >= cutoff) return { status: "failed", code: bad.code, error: bad.error, hint: bad.hint };
  const pending = ctx.db.get<{ created_at: string }>("SELECT created_at FROM oauth_states WHERE state = ? AND connection_id IS NULL", state);
  if (pending && Date.parse(pending.created_at) + STATE_TTL_MS >= Date.now()) return { status: "pending" };
  return { status: "unknown" };
}

/** The account a finished state + code connected, if it's recent and the account is still here. */
export function completedAccount(ctx: AppContext, state: string, code: string): AccountRow | null {
  const hit = state && code ? completed.get(ctx)?.get(state) : undefined;
  if (!hit || hit.at < Date.now() - COMPLETED_TTL_MS || !timingSafeEqual(hit.codeHash, digest(code))) return null;
  return getRow(ctx, hit.accountId) ?? null;
}

/**
 * Thrown for a reload of a callback that already connected `email`: a result page, not a failure.
 * The message names the account; the unauthenticated callback page shows it only to a signed-in admin.
 */
export class AlreadyConnectedError extends HttpError {
  constructor(readonly email: string) {
    super(409, "oauth_already_connected", `Already connected: ${email}.`, "This sign-in was already completed. Nothing else to do: go back to the console.");
  }

  /** The console's paste endpoint is admin-only: the body names the account so the console can show it as connected. */
  override toJSON(): ApiErrorBody {
    const body = super.toJSON();
    return { error: { ...body.error, email: this.email } };
  }
}

interface StateRow {
  state: string;
  code_verifier: string;
  redirect_uri: string;
  reauth_account_id: string | null;
  created_at: string;
}

/** Consumes a pending state (single use). */
function takeState(ctx: AppContext, state: string): StateRow {
  // connection_id IS NULL here and below: upstream connections' states (MCP broker) are never Google's to read or consume.
  const row = state ? ctx.db.get<StateRow>("SELECT * FROM oauth_states WHERE state = ? AND connection_id IS NULL", state) : undefined;
  if (row) ctx.db.run("DELETE FROM oauth_states WHERE state = ? AND connection_id IS NULL", state);
  if (!row || Date.parse(row.created_at) + STATE_TTL_MS < Date.now()) {
    throw new HttpError(
      400,
      "oauth_state",
      "This sign-in link has expired or was already used.",
      "Start the connection again from the Accounts page in the console.",
    );
  }
  return row;
}

interface IdClaims {
  email?: string;
  name?: string;
  /** Hosted domain: present only for Google Workspace accounts. */
  hd?: string;
}

/**
 * Decodes the id_token payload without verifying its signature. That is sound here: the token comes
 * straight from Google's token endpoint over TLS in response to our own authenticated request, so
 * there is no party in between that could forge it (OpenID Connect Core §3.1.3.7 allows this).
 */
function idTokenClaims(idToken: string | undefined): IdClaims | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return v && typeof v === "object" ? (v as IdClaims) : null;
  } catch {
    return null;
  }
}

/** accounts.workspace_domain from the claims: the domain, '' for a personal (non-Workspace) account, null when unknown (no id_token). */
const workspaceDomain = (claims: IdClaims | null): string | null =>
  claims ? (typeof claims.hd === "string" ? claims.hd.toLowerCase() : "") : null;

async function fetchProfile(ctx: AppContext, accessToken: string): Promise<{ emailAddress: string; historyId: string }> {
  const res = await fetch(buildUrl(ctx.config.google.gmailBase, "/gmail/v1/users/me/profile"), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { emailAddress?: string; historyId?: string; error?: { message?: string } } | null;
  if (!res.ok || !body?.emailAddress) {
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    if (/has not been used|is disabled/i.test(message)) {
      throw new HttpError(
        400,
        "gmail_api_disabled",
        "The Gmail API isn't enabled in your Google Cloud project.",
        "Enable it at https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com, wait a minute, then connect again.",
      );
    }
    throw new HttpError(502, "google_error", `Couldn't read the Gmail profile: ${message}`);
  }
  return { emailAddress: body.emailAddress, historyId: String(body.historyId ?? "") };
}

async function revokeToken(ctx: AppContext, token: string): Promise<void> {
  await fetch(buildUrl(ctx.config.google.oauthBase, "/revoke", { token }), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
}

const byEmail = (ctx: AppContext, email: string) =>
  ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE email = ? COLLATE NOCASE", email.trim());

/**
 * Discards tokens we won't keep. Revocation kills the user's whole grant for this OAuth client, so it
 * only happens when the Google account is not connected here (otherwise it would break that account).
 */
async function discardTokens(ctx: AppContext, tokens: TokenResponse, email: string | null | undefined): Promise<void> {
  if (!email || byEmail(ctx, email)) return;
  await revokeToken(ctx, tokens.refresh_token ?? tokens.access_token);
}

/** Saves fresh tokens on an existing account. needs_reauth/error become active; paused stays paused. */
function storeTokens(
  ctx: AppContext,
  row: AccountRow,
  tokens: TokenResponse & { refresh_token: string },
  granted: string[],
  claims: IdClaims | null,
): void {
  ctx.db.run(
    `UPDATE accounts SET display_name = ?, status = ?, last_error = NULL, refresh_token_enc = ?, access_token_enc = ?,
       access_expires_at = ?, scopes = ?, refresh_expires_at = ?, refresh_expiry_kind = ?, workspace_domain = ? WHERE id = ?`,
    claims?.name ?? row.display_name,
    row.status === "paused" ? "paused" : "active",
    ctx.crypto.encrypt(tokens.refresh_token),
    ctx.crypto.encrypt(tokens.access_token),
    expiry(tokens),
    JSON.stringify(granted),
    refreshExpiry(tokens),
    refreshExpiryKind(tokens),
    workspaceDomain(claims) ?? row.workspace_domain,
    row.id,
  );
}

const expiry = (t: TokenResponse) => new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString();

export async function completeConnect(ctx: AppContext, code: string, state: string): Promise<Account> {
  const done = completedAccount(ctx, state, code);
  if (done) throw new AlreadyConnectedError(done.email);
  const st = takeState(ctx, state);
  const calendar = takeCalendarAttempt(ctx, state);
  const ext = takeExtensionAttempt(ctx, state);
  try {
    return await exchange(ctx, st, code, state, calendar, ext);
  } catch (err) {
    rememberFailed(ctx, state, err);
    throw err;
  }
}

async function exchange(ctx: AppContext, st: StateRow, code: string, state: string, calendar: CalendarAttempt | null, ext: ExtensionAttempt | null = null): Promise<Account> {
  if (!code) throw new HttpError(400, "oauth_no_code", "Google didn't return an authorization code.", "Start the connection again from the console.");
  const { clientId, clientSecret } = clientCredentials(ctx);
  let tokens: TokenResponse;
  try {
    tokens = await postToken(ctx, {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: st.redirect_uri,
      code_verifier: st.code_verifier,
    });
  } catch (err) {
    if (err instanceof GoogleApiError && err.reason) {
      throw consentError(ctx, err.reason, err.message !== err.reason ? err.message : null, st.redirect_uri, calendar, ext);
    }
    throw err;
  }
  // Google accepted the redirect URI at consent and again here, so it is registered on the client.
  markRedirectVerified(ctx, st.redirect_uri);

  const claims = idTokenClaims(tokens.id_token);
  const granted = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
  if (granted.length && !granted.includes(GMAIL_SCOPE)) {
    await discardTokens(ctx, tokens, claims?.email);
    throw new HttpError(
      400,
      "oauth_gmail_scope_missing",
      "Gmail access wasn't granted.",
      "Connect again and keep the \"Read, compose, and send emails\" permission checked on Google's consent screen.",
    );
  }
  const profile = await fetchProfile(ctx, tokens.access_token);
  const email = profile.emailAddress;
  const existing = byEmail(ctx, email);
  // A response without `scope` says nothing about what changed: keep what was recorded, plus Gmail (the
  // profile call above just worked). Base scopes only for a new account (Google names identity scopes differently).
  const recorded = existing ? accountScopes(existing) : [];
  const scopes = granted.length ? granted : recorded.length ? [...new Set([...recorded, GMAIL_SCOPE])] : BASE_SCOPES;
  if (st.reauth_account_id) {
    const target = getRow(ctx, st.reauth_account_id);
    if (!target || target.email.toLowerCase() !== email.toLowerCase()) {
      // Keep the tokens if they belong to another connected account; never revoke them (that would break it).
      const keptForOther = !!existing && !!tokens.refresh_token;
      const addsCalendar = !!existing && !hasScopes(accountScopes(existing), CALENDAR_SCOPES) && hasScopes(scopes, CALENDAR_SCOPES);
      if (existing && tokens.refresh_token) {
        storeTokens(ctx, existing, { ...tokens, refresh_token: tokens.refresh_token }, scopes, claims);
        await afterConnect(ctx, existing.id, email);
      } else await discardTokens(ctx, tokens, email);
      // What happened to the account they did sign in as.
      const other = keptForOther
        ? ` ${email} is also connected here, so xaq saved that new sign-in for ${email}${addsCalendar ? ", which adds Google Calendar to it" : "; nothing else changed"}.`
        : existing
          ? ` ${email} is also connected here and wasn't changed.`
          : ` xaq didn't keep the sign-in for ${email}.`;
      if (!target) {
        throw new HttpError(
          400,
          "oauth_account_removed",
          `The account you were reconnecting was removed from xaq in the meantime.${other}`,
          "To add it back, use Connect account and sign in with it.",
        );
      }
      throw new HttpError(
        400,
        "oauth_wrong_account",
        ext
          ? `You were giving ${ext.displayName} access to ${target.email}, but signed in to Google as ${email}, so ${ext.displayName} got nothing: it works only with ${target.email}.${other}`
          : calendar?.addingTo
            ? `You were adding Google Calendar to ${target.email}, but signed in to Google as ${email}, so nothing changed for ${target.email}: its mail keeps working.${other}`
            : `You were reconnecting ${target.email}, but signed in to Google as ${email}, so ${target.email} is still not reconnected.${other}`,
        `${ext ? `Click Reconnect on ${ext.connectionName ?? ext.displayName}` : calendar?.addingTo ? `Click Add Calendar for ${target.email}` : `Reconnect ${target.email}`} again and pick ${target.email} in Google's account chooser (choose "Use another account" if it isn't listed). ` +
          `If Google skips the chooser, sign out of ${email} at accounts.google.com in this browser first, or use a private window.`,
      );
    }
  }
  if (!tokens.refresh_token) {
    throw new HttpError(
      400,
      "oauth_no_refresh_token",
      "Google didn't return a refresh token, so xaq can't stay connected.",
      "Remove xaq's access at https://myaccount.google.com/permissions, then connect again.",
    );
  }

  const id = existing?.id ?? newId("acc");
  if (existing) {
    storeTokens(ctx, existing, { ...tokens, refresh_token: tokens.refresh_token }, scopes, claims);
  } else {
    ctx.db.run(
      `INSERT INTO accounts (id, email, display_name, status, last_error, refresh_token_enc, access_token_enc, access_expires_at, scopes,
         refresh_expires_at, refresh_expiry_kind, workspace_domain, created_at)
       VALUES (?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      email,
      claims?.name ?? null,
      ctx.crypto.encrypt(tokens.refresh_token),
      ctx.crypto.encrypt(tokens.access_token),
      expiry(tokens),
      JSON.stringify(scopes),
      refreshExpiry(tokens),
      refreshExpiryKind(tokens),
      workspaceDomain(claims),
      now(),
    );
  }
  ctx.audit.record({
    ...ADMIN_ACTOR,
    action: existing ? "account.reconnect" : "account.connect",
    accountId: id,
    outcome: "ok",
    detail: {
      email,
      scopes,
      refreshTokenExpiresAt: refreshExpiry(tokens),
      refreshTokenExpiryKind: refreshExpiryKind(tokens),
      workspaceDomain: workspaceDomain(claims) || null,
    },
  });
  ctx.log.child("google").info(existing ? "Account reconnected" : "Account connected", { email });
  // Adding Calendar with Calendar unticked: the tokens above are still good (include_granted_scopes keeps
  // Gmail and Pub/Sub), so they are kept, but the step the user took didn't do what they wanted.
  const unticked = calendar?.addingTo && granted.length ? missingScopes(scopes, CALENDAR_SCOPES) : [];
  // The same for an extension's consent: the account keeps everything it had (include_granted_scopes), and the
  // extension gets what was ticked; what wasn't is said in plain words.
  const extMissing = ext && granted.length ? missingScopes(scopes, ext.scopes) : [];
  if (!unticked.length && !extMissing.length) rememberCompleted(ctx, state, code, id);
  const account = await afterConnect(ctx, id, email);
  if (ext) {
    try {
      ext.onDone?.(id, scopes);
    } catch (err) {
      ctx.log.child("google").warn("Updating the extension's connection after its consent failed", { connection: ext.connectionId, error: errorMessage(err) });
    }
    ctx.audit.record({
      ...ADMIN_ACTOR,
      action: "connection.google_consent",
      accountId: id,
      target: ext.connectionId,
      outcome: extMissing.length ? "error" : "ok",
      detail: { email, scopes: [...ext.scopes], missing: extMissing },
    });
  }
  if (unticked.length) {
    ctx.log.child("google").info("Google Calendar not granted", { email, missing: unticked });
    throw calendarNotGranted(email, unticked);
  }
  if (ext && extMissing.length) {
    ctx.log.child("google").info("Extension access not fully granted", { email, connection: ext.connectionId, missing: extMissing });
    throw extensionNotGranted(ext, extMissing);
  }
  return account;
}

/**
 * Baseline/watch/catch-up via ingest (ingest skips paused accounts; a reconnect continues from the history
 * cursor), then the Calendar probe (is the API on?), then broadcasts the account.
 */
async function afterConnect(ctx: AppContext, id: string, email: string): Promise<Account> {
  try {
    await ctx.ingest.onAccountConnected(id);
  } catch (err) {
    ctx.log.child("google").warn("Post-connect setup failed", { email, error: errorMessage(err) });
    ctx.db.run("UPDATE accounts SET last_error = ? WHERE id = ?", `Connected, but initial sync setup failed: ${errorMessage(err)}`, id);
  }
  await probeCalendar(ctx, id, { waitMs: CONNECT_PROBE_WAIT_MS });
  const account = toAccount(getRow(ctx, id)!);
  ctx.bus.emit("account", account);
  return account;
}

export async function completeConnectFromUrl(ctx: AppContext, raw: string): Promise<Account> {
  let url: URL;
  try {
    const text = raw.trim();
    url = new URL(text.startsWith("?") ? `http://localhost/oauth/callback${text}` : text);
  } catch {
    throw new HttpError(400, "oauth_url_invalid", "That isn't a valid URL.", "Copy the whole address from the browser's address bar after approving access.");
  }
  const q = url.searchParams;
  const error = q.get("error");
  if (error) {
    const state = q.get("state");
    const pending = state && ctx.db.run("DELETE FROM oauth_states WHERE state = ? AND connection_id IS NULL", state).changes ? state : null;
    const calendar = pending ? takeCalendarAttempt(ctx, pending) : null;
    const ext = pending ? takeExtensionAttempt(ctx, pending) : null;
    const err = consentError(ctx, error, q.get("error_description"), undefined, calendar, ext);
    if (pending) rememberFailed(ctx, pending, err);
    throw err;
  }
  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state) {
    throw new HttpError(
      400,
      "oauth_no_code",
      "That URL doesn't contain an authorization code.",
      "After approving access, copy the full address you land on (it starts with http://localhost and contains ?code=…&state=…), even if the page doesn't load.",
    );
  }
  return completeConnect(ctx, code, state);
}

/** Revokes the account's refresh token at Google (best effort; errors are thrown to the caller). */
export async function revokeAccount(ctx: AppContext, accountId: string): Promise<void> {
  const row = getRow(ctx, accountId);
  if (!row) return;
  const res = await fetch(buildUrl(ctx.config.google.oauthBase, "/revoke", { token: ctx.crypto.decrypt(row.refresh_token_enc) }), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // 400 invalid_token means it was already revoked.
  if (!res.ok && res.status !== 400) throw new GoogleApiError(res.status, `Token revocation failed (HTTP ${res.status})`);
}
