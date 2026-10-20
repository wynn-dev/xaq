import type { AppContext } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { errorMessage, notFound } from "../util/errors.ts";
import { type AccountRow, accountScopes, getRow, updateRow } from "./accounts.ts";
import { clientCredentials } from "./client.ts";
import {
  backoffMs,
  buildUrl,
  googleErrorFromBody,
  hasReason,
  isAbortError,
  isRetryable,
  networkError,
  rejectedBeforeProcessing,
  REQUEST_TIMEOUT_MS,
  sleep,
} from "./http.ts";
import { IDENTITY_TOKEN_SCOPES, missingScopes } from "./scopes.ts";
import { AccountNeedsReauthError, DownscopeError, GoogleApiError, ScopesNotGrantedError } from "./types.ts";

/** A downscoped access token (TokenManager.scopedAccessToken). */
export interface ScopedToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** The scopes Google says the token has: within the ones asked for, plus at most identity scopes Google added. */
  scopes: string[];
}

export interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  token_type?: string;
  /**
   * Seconds until the refresh token expires. Google only sends it for tokens that expire: an External
   * OAuth app in Testing (604800 = 7 days from consent), or time-based access the user chose on the
   * consent screen (any duration). On refreshes it is the time left.
   */
  refresh_token_expires_in?: number;
}

const lifetime = (t: TokenResponse): number | null => {
  const s = t.refresh_token_expires_in;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? s : null;
};

/** Absolute refresh-token expiry from a token response, or null when Google didn't send one (long-lived). */
export function refreshExpiry(t: TokenResponse): string | null {
  const s = lifetime(t);
  return s ? new Date(Date.now() + s * 1000).toISOString() : null;
}

const TESTING_LIFETIME_S = 604_800;
const TESTING_TOLERANCE_S = 86_400;

/**
 * Why a freshly issued (code exchange) refresh token expires: "testing" when its lifetime is the
 * Testing-mode 7 days (± 1 day), "time_based" for any other lifetime (e.g. user-chosen time-based
 * access), null when it doesn't expire. Only meaningful for the code exchange: refreshes report the time left.
 */
export function refreshExpiryKind(t: TokenResponse): "testing" | "time_based" | null {
  const s = lifetime(t);
  if (!s) return null;
  return Math.abs(s - TESTING_LIFETIME_S) <= TESTING_TOLERANCE_S ? "testing" : "time_based";
}

const sameScopes = (a: string[], b: string[]) => a.length === b.length && a.every((s) => b.includes(s));

/** Refresh this long before the access token expires. */
const EARLY_REFRESH_MS = 60_000;

/**
 * POSTs a form to Google's token endpoint (30 s per attempt). Refreshes retry timeouts, network errors
 * and 5xx; the one-time authorization code exchange only retries when the request never left this
 * machine (a retried code would fail with invalid_grant anyway, hiding the real error).
 */
export async function postToken(ctx: Pick<AppContext, "config">, params: Record<string, string>): Promise<TokenResponse> {
  const url = buildUrl(ctx.config.google.oauthBase, "/token");
  const host = new URL(url).host;
  const idempotent = params.grant_type !== "authorization_code";
  for (let attempt = 0; ; attempt++) {
    let err: GoogleApiError;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // handled below
      }
      if (res.ok && body && typeof (body as TokenResponse).access_token === "string") return body as TokenResponse;
      err = googleErrorFromBody(res.status, body, `Google's token endpoint returned HTTP ${res.status}`);
    } catch (e) {
      err = isAbortError(e)
        ? new GoogleApiError(0, `Google's token endpoint (${host}) didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s`, "timeout")
        : networkError(e, host);
    }
    const retry = idempotent ? isRetryable(err) : rejectedBeforeProcessing(err);
    if (!retry || attempt >= 2) throw err;
    await sleep(backoffMs(attempt, err.details.retryAfterMs));
  }
}

/**
 * Access tokens are cached encrypted on the account row and refreshed ~60s before expiry, one refresh
 * in flight per account. A revoked/expired refresh token (`invalid_grant`) marks the account
 * `needs_reauth`, emits `account.auth_failed`, audits, and throws AccountNeedsReauthError.
 */
export class TokenManager {
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly ctx: AppContext) {}

  async accessToken(accountId: string, opts: { force?: boolean } = {}): Promise<string> {
    const row = getRow(this.ctx, accountId);
    if (!row) throw notFound("Account");
    if (row.status === "needs_reauth") throw new AccountNeedsReauthError(row.id, row.email);
    if (!opts.force && row.access_token_enc && row.access_expires_at) {
      if (Date.parse(row.access_expires_at) - EARLY_REFRESH_MS > Date.now()) return this.ctx.crypto.decrypt(row.access_token_enc);
    }
    const pending = this.inflight.get(accountId);
    if (pending) return pending;
    const p = this.refresh(row).finally(() => this.inflight.delete(accountId));
    this.inflight.set(accountId, p);
    return p;
  }

  /** Drops the cached access token (e.g. after a 401). */
  invalidate(accountId: string): void {
    this.ctx.db.run("UPDATE accounts SET access_token_enc = NULL, access_expires_at = NULL WHERE id = ?", accountId);
  }

  // ───── Downscoped tokens ─────

  /** Downscoped tokens by account and sorted scope set (memory only, never on the row: the row's token is the full one). */
  private readonly scoped = new Map<string, ScopedToken & { refreshTokenEnc: string }>();
  private readonly scopedInflight = new Map<string, Promise<ScopedToken>>();

  /**
   * An access token for `accountId` limited to `scopes`, a subset of what the account granted: Google's refresh grant
   * with an explicit `scope` (RFC 6749 §6: it "MUST NOT include any scope not originally granted", and the token is
   * issued for exactly that scope). Google's answer is checked: its `scope` must be present and within `scopes`, or the
   * token is dropped (DownscopeError) and never returned. Cached per account and scope set until ~60 s before it
   * expires, and dropped when the account's refresh token changes (a reconnect or consent); one refresh in flight per
   * account and scope set. Never writes the account's own access token or recorded scopes.
   *
   * Throws ScopesNotGrantedError when the account hasn't granted all of `scopes`, AccountNeedsReauthError (as
   * accessToken) when its sign-in is gone.
   */
  async scopedAccessToken(accountId: string, scopes: readonly string[], opts: { force?: boolean } = {}): Promise<ScopedToken> {
    const want = [...new Set(scopes)].sort();
    if (!want.length) throw new Error("A downscoped token needs at least one scope");
    const row = getRow(this.ctx, accountId);
    if (!row) throw notFound("Account");
    if (row.status === "needs_reauth") throw new AccountNeedsReauthError(row.id, row.email);
    // In the caller's order (the manifest's), for the messages.
    const missing = missingScopes(accountScopes(row), [...new Set(scopes)]);
    if (missing.length) throw new ScopesNotGrantedError(row.id, row.email, missing);
    const key = `${accountId} ${want.join(" ")}`;
    const hit = this.scoped.get(key);
    if (!opts.force && hit && hit.refreshTokenEnc === row.refresh_token_enc && hit.expiresAt - EARLY_REFRESH_MS > Date.now()) {
      return { accessToken: hit.accessToken, expiresAt: hit.expiresAt, scopes: [...hit.scopes] };
    }
    const pending = this.scopedInflight.get(key);
    if (pending) return pending;
    const p = this.refreshScoped(row, want, key).finally(() => this.scopedInflight.delete(key));
    this.scopedInflight.set(key, p);
    return p;
  }

  /** Drops the account's cached downscoped tokens (all scope sets). */
  invalidateScoped(accountId: string): void {
    for (const k of [...this.scoped.keys()]) if (k.startsWith(`${accountId} `)) this.scoped.delete(k);
  }

  private async refreshScoped(row: AccountRow, want: string[], key: string): Promise<ScopedToken> {
    const { clientId, clientSecret } = clientCredentials(this.ctx);
    let res: TokenResponse;
    try {
      res = await postToken(this.ctx, {
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: this.ctx.crypto.decrypt(row.refresh_token_enc),
        scope: want.join(" "),
      });
    } catch (err) {
      if (err instanceof GoogleApiError && err.reason === "invalid_grant") {
        const fresh = getRow(this.ctx, row.id);
        if (fresh && fresh.status !== "needs_reauth" && fresh.refresh_token_enc !== row.refresh_token_enc) return this.refreshScoped(fresh, want, key);
        this.authFailed(row, err.message, hasReason(err, "invalid_rapt"));
      }
      if (err instanceof GoogleApiError && err.reason === "invalid_scope") {
        // The recorded scopes said yes, Google says no (revoked outside xaq): re-read them with a normal refresh,
        // which backfills accounts.scopes, and report what's missing now.
        await this.accessToken(row.id, { force: true }).catch(() => undefined);
        const fresh = getRow(this.ctx, row.id) ?? row;
        const missing = missingScopes(accountScopes(fresh), want);
        throw new ScopesNotGrantedError(row.id, row.email, missing.length ? missing : want);
      }
      if (err instanceof GoogleApiError && err.reason === "invalid_client") {
        throw new GoogleApiError(err.status, "Google rejected the OAuth client ID or secret (invalid_client). Check the client in the setup wizard.", err.reason, err.details);
      }
      throw err;
    }
    // The proof the token is limited: Google's own `scope` for it, within what was asked for. No `scope`, or anything
    // more, and the token is dropped: it may carry the account's whole grant (Gmail included).
    const granted = (res.scope ?? "").split(/\s+/).filter(Boolean);
    if (!granted.length) throw new DownscopeError("Google didn't say which access the downscoped token has, so xaq didn't use it.");
    // Identity scopes Google may add on its own (openid, userinfo.email/profile) can't read mail or files: accepted.
    // Anything else outside the request drops the token.
    const extra = granted.filter((s) => !want.includes(s) && !IDENTITY_TOKEN_SCOPES.includes(s));
    if (extra.length) {
      this.ctx.log.child("google").warn("A downscoped token came back with more access than asked for; dropped", { email: row.email, extra });
      throw new DownscopeError(`Google returned a token with more access than asked for (${extra.join(", ")}), so xaq didn't use it.`);
    }
    if (res.refresh_token) {
      // Google may rotate the refresh token on any refresh: keep the new one, only over the one this refresh used.
      this.ctx.db.run("UPDATE accounts SET refresh_token_enc = ? WHERE id = ? AND refresh_token_enc = ?", this.ctx.crypto.encrypt(res.refresh_token), row.id, row.refresh_token_enc);
    }
    const token: ScopedToken = { accessToken: res.access_token, expiresAt: Date.now() + (res.expires_in ?? 3600) * 1000, scopes: granted };
    const current = getRow(this.ctx, row.id);
    if (current) this.scoped.set(key, { ...token, scopes: [...granted], refreshTokenEnc: current.refresh_token_enc });
    return token;
  }

  private async refresh(row: AccountRow): Promise<string> {
    const { clientId, clientSecret } = clientCredentials(this.ctx);
    let res: TokenResponse;
    try {
      res = await postToken(this.ctx, {
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: this.ctx.crypto.decrypt(row.refresh_token_enc),
      });
    } catch (err) {
      if (err instanceof GoogleApiError && err.reason === "invalid_grant") {
        // A reconnect may have stored a new refresh token while this refresh was in flight.
        const fresh = getRow(this.ctx, row.id);
        if (fresh && fresh.status !== "needs_reauth" && fresh.refresh_token_enc !== row.refresh_token_enc) return this.refresh(fresh);
        this.authFailed(row, err.message, hasReason(err, "invalid_rapt"));
      }
      if (err instanceof GoogleApiError && err.reason === "invalid_client") {
        throw new GoogleApiError(
          err.status,
          "Google rejected the OAuth client ID or secret (invalid_client). Check the client in the setup wizard.",
          err.reason,
          err.details,
        );
      }
      throw err;
    }
    const expiresAt = new Date(Date.now() + (res.expires_in ?? 3600) * 1000).toISOString();
    // Scope backfill: the response says what the account grants right now (Calendar added or revoked
    // elsewhere, a granular consent). No `scope` means unchanged, never "nothing".
    const granted = (res.scope ?? "").split(/\s+/).filter(Boolean);
    const patch: Record<string, string> = {
      access_token_enc: this.ctx.crypto.encrypt(res.access_token),
      access_expires_at: expiresAt,
      // Google may rotate refresh tokens.
      ...(res.refresh_token ? { refresh_token_enc: this.ctx.crypto.encrypt(res.refresh_token) } : {}),
      // Testing-mode tokens report their remaining lifetime on every refresh. A response without it leaves
      // the stored expiry alone: a token issued in Testing keeps expiring even after the app is published.
      ...(refreshExpiry(res) ? { refresh_expires_at: refreshExpiry(res)! } : {}),
      ...(granted.length ? { scopes: JSON.stringify(granted) } : {}),
    };
    // Only if the refresh token used is still the stored one: a consent (e.g. "Add Calendar") may have
    // swapped in a new token while this refresh was in flight, and its access token and scopes win.
    const entries = Object.entries(patch);
    const { changes } = this.ctx.db.run(
      `UPDATE accounts SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ? AND refresh_token_enc = ?`,
      ...entries.map(([, v]) => v),
      row.id,
      row.refresh_token_enc,
    );
    if (!changes) {
      const fresh = getRow(this.ctx, row.id);
      if (fresh?.access_token_enc && fresh.access_expires_at && Date.parse(fresh.access_expires_at) - EARLY_REFRESH_MS > Date.now()) {
        return this.ctx.crypto.decrypt(fresh.access_token_enc);
      }
      // Still valid for whatever the old token covers (Google never revokes it on a new consent).
      return res.access_token;
    }
    if (granted.length && !sameScopes(granted, accountScopes(row))) {
      this.ctx.log.child("google").info("Granted scopes changed", { email: row.email, scopes: granted });
      updateRow(this.ctx, row.id, {}, true);
    }
    return res.access_token;
  }

  private authFailed(row: AccountRow, description: string, rapt: boolean): never {
    const error = rapt
      ? `Google requires ${row.email} to sign in again (invalid_rapt): your Workspace admin requires periodic re-authentication ` +
        "for apps using Google Cloud scopes (Google Cloud session control). Reconnect the account, or ask the admin to exempt this app."
      : `Google rejected the saved sign-in for ${row.email} (${description || "invalid_grant"}). Reconnect the account.` +
        // The 7-day expiry only happens to External apps left in Testing.
        (this.ctx.settings.getState("google.client")?.appType === "external"
          ? " If this keeps happening about every 7 days, your OAuth app is still in Testing: publish it (In production)."
          : "");
    this.ctx.log.child("google").warn("Refresh token rejected; account needs re-auth", { email: row.email });
    this.ctx.accounts.setStatus(row.id, "needs_reauth", error);
    try {
      this.ctx.events.emit({
        type: "account.auth_failed",
        accountId: row.id,
        detail: { email: row.email, error },
        dedupeKey: `${row.id}:auth_failed:${sha256(row.refresh_token_enc).slice(0, 12)}`,
      });
    } catch (err) {
      this.ctx.log.child("google").error("Could not record account.auth_failed", { error: errorMessage(err) });
    }
    this.ctx.audit.record({
      actorType: "system",
      action: "account.auth_failed",
      accountId: row.id,
      outcome: "error",
      detail: { email: row.email, error: description, ...(rapt ? { subtype: "invalid_rapt" } : {}) },
    });
    throw new AccountNeedsReauthError(row.id, row.email);
  }
}
