// Generic `user_app` OAuth: a provider
// whose user registers their own app and pastes its client id and secret (WHOOP was the first). Everything comes from
// the preset's auth (a code extension's manifest `code.auth`): the authorize and token URLs, the scopes and the input
// keys holding the client id and secret. Authorization code with the client secret in the body
// (client_secret_post), no PKCE, `state` from the runtime. Refresh tokens may rotate and be single-use: the
// TokenRefresher's compare-and-swap saves each new one before it's used. The refresh request carries `scope` only
// when the auth sets `refreshScope` (WHOOP: "offline", which renews its refresh token); otherwise none (RFC 6749 §6:
// the originally granted scope).
// Code extensions only ever get access tokens (xaq/credentials/get); the client secret and the refresh token never
// leave core.

import { HttpError } from "../../util/errors.ts";
import { type PresetAuth, type RefreshFn, SourceError, type StoredTokens } from "../types.ts";
import type { NativeOAuthFlow } from "./runtime.ts";

export type UserAppAuth = Extract<PresetAuth, { type: "user_app" }>;

export interface UserAppClient {
  clientId: string;
  clientSecret: string;
}

/** The pasted app from the stored client record (`{ [clientIdInput], [clientSecretInput] }`); null when incomplete. */
export function userAppClientFrom(auth: UserAppAuth, record: Record<string, unknown> | null | undefined): UserAppClient | null {
  const clientId = record?.[auth.clientIdInput];
  const clientSecret = record?.[auth.clientSecretInput];
  if (typeof clientId !== "string" || !clientId.trim() || typeof clientSecret !== "string" || !clientSecret) return null;
  return { clientId: clientId.trim(), clientSecret };
}

/** Both endpoints must be https (no token or code over plain http). Throws a SourceError("protocol"). */
function httpsUrl(raw: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceError("protocol", `The ${what} isn't a valid URL`);
  }
  if (u.protocol !== "https:" || u.username || u.password) throw new SourceError("protocol", `The ${what} must be an https URL`);
  return u;
}

/** The URL to send the user to. The caller generates and checks `state` (oauth_states). */
export function userAppAuthorizeUrl(auth: UserAppAuth, opts: { clientId: string; redirectUri: string; state: string }): string {
  if (opts.state.length < 8) throw new Error("The OAuth state must be at least 8 characters");
  const url = httpsUrl(auth.authorizeUrl, "authorize URL");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  if (auth.scopes.length) url.searchParams.set("scope", auth.scopes.join(" "));
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export interface UserAppOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  /** For messages: "WHOOP". */
  displayName?: string;
}

/** Exchanges the callback's code for tokens. */
export async function userAppExchange(auth: UserAppAuth, code: string, p: { client: UserAppClient; redirectUri: string }, opts: UserAppOptions = {}): Promise<StoredTokens> {
  return tokenRequest(
    auth,
    { grant_type: "authorization_code", code, redirect_uri: p.redirectUri, client_id: p.client.clientId, client_secret: p.client.clientSecret },
    opts,
  );
}

/** The provider exchange for TokenRefresher. A rotated refresh token replaces the old one; none in the answer keeps it. */
export function userAppRefreshFn(auth: UserAppAuth, client: UserAppClient, opts: Omit<UserAppOptions, "signal"> = {}): RefreshFn {
  return async (current, signal) => {
    if (!current.refreshToken) throw new SourceError("needs_reauth", `${opts.displayName ?? "The provider"} has no refresh token for this connection`);
    const next = await tokenRequest(
      auth,
      {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        ...(auth.refreshScope ? { scope: auth.refreshScope } : {}),
      },
      { ...opts, signal },
    );
    return { ...next, refreshToken: next.refreshToken ?? current.refreshToken, scope: next.scope ?? current.scope };
  };
}

const REAUTH_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

/** A token endpoint error; a SourceError so callers that don't care about `error` still get the right code. */
export class TokenEndpointError extends SourceError {
  constructor(
    readonly error: string,
    description: string,
    who: string,
  ) {
    super(REAUTH_ERRORS.has(error) ? "needs_reauth" : "protocol", `${who} refused the token request (${error})${description ? `: ${description}` : ""}`);
  }
}

function retryAfterMs(headers: Headers): number | undefined {
  const v = headers.get("retry-after");
  return v && /^\d+(\.\d+)?$/.test(v.trim()) ? Math.max(1000, Math.ceil(Number(v) * 1000)) : undefined;
}

async function tokenRequest(auth: UserAppAuth, params: Record<string, string>, opts: UserAppOptions): Promise<StoredTokens> {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const url = httpsUrl(auth.tokenUrl, "token URL");
  const who = opts.displayName ?? url.host;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      redirect: "error",
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new SourceError("unavailable", `${who} is unreachable: ${(err as Error).message}`);
  }
  if (res.status === 429) {
    await res.body?.cancel();
    throw new SourceError("rate_limited", `${who}'s rate limit was reached`, retryAfterMs(res.headers));
  }
  if (res.status >= 500) {
    await res.body?.cancel();
    throw new SourceError("unavailable", `${who}'s token endpoint answered ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body || typeof body.access_token !== "string" || !body.access_token) {
    const error = typeof body?.error === "string" ? body.error.slice(0, 64) : res.ok ? "invalid_response" : `http_${res.status}`;
    const description = typeof body?.error_description === "string" ? body.error_description.slice(0, 300) : "";
    throw new TokenEndpointError(error, description, who);
  }
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : null;
  const t = now();
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    expiresAt: expiresIn === null ? null : t + expiresIn * 1000,
    scope: typeof body.scope === "string" ? body.scope : null,
    issuer: null,
    issuedAt: t,
  };
}

/** The runtime's NativeOAuthFlow for a `user_app` preset (connect, callback and refresh). */
export function userAppFlow(preset: { id: string; displayName: string; auth: UserAppAuth }, opts: Omit<UserAppOptions, "signal" | "displayName"> = {}): NativeOAuthFlow {
  const { auth, displayName } = preset;
  return {
    preset: preset.id,
    authorizeUrl: ({ client, redirectUri, state }) => {
      const app = userAppClientFrom(auth, client);
      if (!app) throw new HttpError(400, "user_app_client", `Enter the ${displayName} app's client ID and secret first`, `They're on your app's page at ${displayName}.`);
      return userAppAuthorizeUrl(auth, { clientId: app.clientId, redirectUri, state });
    },
    exchange: async (code, p) => {
      const app = userAppClientFrom(auth, p.client);
      if (!app) throw new SourceError("needs_reauth", `The ${displayName} app's client ID and secret are missing: enter them again`);
      const tokens = await userAppExchange(auth, code, { client: app, redirectUri: p.redirectUri }, { ...opts, signal: p.signal, displayName });
      return { tokens };
    },
    refreshFn: (client) => {
      const app = userAppClientFrom(auth, client);
      return app ? userAppRefreshFn(auth, app, { ...opts, displayName }) : null;
    },
  };
}
