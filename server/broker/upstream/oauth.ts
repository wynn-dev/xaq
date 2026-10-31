import { createHash, randomBytes } from "node:crypto";
import { SourceError, type StoredTokens } from "../types.ts";
import type { AuthServerMetadata } from "./discovery.ts";
import { scrubText } from "../credentials/scrub.ts";

/**
 * MCP OAuth for upstream connections: client registration
 * (pre-registered → client ID metadata document → DCR), PKCE S256 with our own `state`, `resource` on
 * both requests, `offline_access` when advertised, and the token/refresh exchanges. Every request goes
 * through the connection's guarded fetch.
 */

type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 256 * 1024;

/** A registration as stored (CredentialStore.client): bound to the issuer that issued it. */
export interface StoredClient {
  issuer: string;
  client_id: string;
  client_secret?: string;
  token_endpoint_auth_method: string;
  /** How it was obtained: never re-registered casually (Notion: re-registering orphans grants). */
  source: "pre_registered" | "metadata_document" | "dcr";
  /** The redirect URI it was registered with (DCR/metadata document must match it exactly). */
  redirect_uri?: string;
  token_endpoint?: string;
  revocation_endpoint?: string;
  /** The RFC 8707 resource sent on every request. */
  resource?: string;
  [key: string]: unknown;
}

export const b64url = (buf: Buffer): string => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/** Reads a JSON object body (bounded). */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  if (text.length > MAX_JSON_BYTES) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const signalFor = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));

/** The scopes to ask for: the resource's (or the 401's), plus offline_access when the server advertises it. */
export function requestedScope(md: AuthServerMetadata, resourceScopes: string[] | undefined, challengeScope: string | undefined): string | null {
  const base = challengeScope ? challengeScope.split(/\s+/).filter(Boolean) : (resourceScopes ?? []);
  const scopes = new Set(base);
  if (md.scopes_supported?.includes("offline_access")) scopes.add("offline_access");
  return scopes.size ? [...scopes].join(" ") : null;
}

export interface RegisterOptions {
  redirectUri: string;
  /** A client the preset ships or the user pasted. */
  preRegistered?: { client_id: string; client_secret?: string } | null;
  /** Our hosted client ID metadata document URL (public https installs only), or null. */
  metadataDocumentUrl?: string | null;
  clientName: string;
  scope?: string | null;
}

/**
 * Picks or creates the client for this authorization server. `existing` is reused when it was issued by
 * the same issuer (and, for a registration, for the same redirect URI): re-registering is never casual.
 */
export async function ensureClient(fetch: Fetch, md: AuthServerMetadata, existing: StoredClient | null, o: RegisterOptions, signal?: AbortSignal): Promise<StoredClient> {
  const ends = { token_endpoint: md.token_endpoint, ...(md.revocation_endpoint ? { revocation_endpoint: md.revocation_endpoint } : {}) };
  if (o.preRegistered?.client_id) {
    return {
      issuer: md.issuer,
      client_id: o.preRegistered.client_id,
      ...(o.preRegistered.client_secret ? { client_secret: o.preRegistered.client_secret } : {}),
      token_endpoint_auth_method: o.preRegistered.client_secret ? pickSecretMethod(md) : "none",
      source: "pre_registered",
      ...ends,
    };
  }
  if (existing && existing.issuer === md.issuer && (existing.source === "pre_registered" || existing.redirect_uri === o.redirectUri)) {
    return { ...existing, ...ends };
  }
  if (o.metadataDocumentUrl && md.client_id_metadata_document_supported === true) {
    return { issuer: md.issuer, client_id: o.metadataDocumentUrl, token_endpoint_auth_method: "none", source: "metadata_document", redirect_uri: o.redirectUri, ...ends };
  }
  if (!md.registration_endpoint) {
    throw new SourceError(
      "protocol",
      `${md.issuer} supports neither automatic registration nor client ID metadata documents. Register a client there and paste its client ID.`,
    );
  }
  const local = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(o.redirectUri);
  const res = await fetch(md.registration_endpoint, {
    method: "POST",
    // Never re-send the registration (or a secret in a body) to wherever a 307/308 points.
    redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: o.clientName,
      redirect_uris: [o.redirectUri],
      // refresh_token only when advertised: a strict server may refuse to register a grant it doesn't support.
      grant_types: md.grant_types_supported?.includes("refresh_token") ? ["authorization_code", "refresh_token"] : ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      // SEP-837: a loopback redirect is a native app's.
      application_type: local ? "native" : "web",
      ...(o.scope ? { scope: o.scope } : {}),
    }),
    signal: signalFor(signal),
  });
  const body = await readJson(res);
  if (!res.ok || typeof body?.client_id !== "string") {
    const err = scrubText(typeof body?.error === "string" ? `${body.error}${typeof body.error_description === "string" ? `: ${body.error_description}` : ""}` : `HTTP ${res.status}`, [], 200);
    throw new SourceError("protocol", `Automatic client registration at ${md.issuer} failed (${err})`);
  }
  const method = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : body.client_secret ? "client_secret_basic" : "none";
  return {
    ...body,
    issuer: md.issuer,
    client_id: body.client_id,
    ...(typeof body.client_secret === "string" ? { client_secret: body.client_secret } : {}),
    token_endpoint_auth_method: method,
    source: "dcr",
    redirect_uri: o.redirectUri,
    ...ends,
  };
}

function pickSecretMethod(md: AuthServerMetadata): string {
  const m = md.token_endpoint_auth_methods_supported;
  if (!m || m.includes("client_secret_basic")) return "client_secret_basic";
  return m.includes("client_secret_post") ? "client_secret_post" : "client_secret_basic";
}

export function authorizationUrl(
  md: AuthServerMetadata,
  client: StoredClient,
  p: { redirectUri: string; state: string; challenge: string; resource: string; scope: string | null },
): string {
  const u = new URL(md.authorization_endpoint);
  const q = u.searchParams;
  q.set("response_type", "code");
  q.set("client_id", client.client_id);
  q.set("redirect_uri", p.redirectUri);
  q.set("state", p.state);
  q.set("code_challenge", p.challenge);
  q.set("code_challenge_method", "S256");
  q.set("resource", p.resource);
  if (p.scope) q.set("scope", p.scope);
  return u.toString();
}

/** Errors from the token endpoint that mean the grant or client is gone: needs a human. */
const REAUTH_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

async function tokenRequest(fetch: Fetch, client: StoredClient, params: Record<string, string>, signal?: AbortSignal, clock: () => number = Date.now): Promise<StoredTokens> {
  if (!client.token_endpoint) throw new SourceError("needs_reauth", "The connection's token endpoint is unknown; reconnect it");
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const form = new URLSearchParams({ ...params, client_id: client.client_id });
  if (client.client_secret) {
    if (client.token_endpoint_auth_method === "client_secret_post") form.set("client_secret", client.client_secret);
    else {
      form.delete("client_id");
      const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
      headers.authorization = `Basic ${Buffer.from(`${enc(client.client_id)}:${enc(client.client_secret)}`).toString("base64")}`;
    }
  }
  let res: Response;
  try {
    // redirect "error": a 307/308 would re-send the code, verifier, refresh token or secret elsewhere.
    res = await fetch(client.token_endpoint, { method: "POST", headers, body: form.toString(), redirect: "error", signal: signalFor(signal) });
  } catch (err) {
    if (err instanceof SourceError) throw err;
    if ((err as Error).name === "TimeoutError" || (err as Error).name === "AbortError") throw new SourceError("timeout", "The token endpoint didn't answer in time");
    throw new SourceError("unavailable", `The token endpoint is unreachable: ${(err as Error).message}`);
  }
  const body = await readJson(res);
  if (!res.ok || typeof body?.access_token !== "string") {
    const code = typeof body?.error === "string" ? body.error : null;
    const desc = typeof body?.error_description === "string" ? `: ${scrubText(body.error_description, Object.values(params).concat(client.client_secret ?? []), 200)}` : "";
    if (code && REAUTH_ERRORS.has(code)) throw new SourceError("needs_reauth", `The authorization server rejected the sign-in (${code}${desc})`);
    if (res.status === 429) throw new SourceError("rate_limited", "The token endpoint is rate limiting");
    throw new SourceError(res.status >= 500 ? "unavailable" : "protocol", `The token endpoint answered ${code ?? `HTTP ${res.status}`}${desc}`);
  }
  const type = typeof body.token_type === "string" ? body.token_type.toLowerCase() : "bearer";
  if (type !== "bearer") throw new SourceError("protocol", `Unsupported token type ${String(body.token_type)}`);
  const now = clock();
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : typeof body.expires_in === "string" ? Number(body.expires_in) : NaN;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    scope: typeof body.scope === "string" ? body.scope : null,
    issuer: client.issuer,
    issuedAt: now,
  };
}

export function exchangeCode(
  fetch: Fetch,
  client: StoredClient,
  p: { code: string; verifier: string; redirectUri: string; resource: string },
  signal?: AbortSignal,
  clock: () => number = Date.now,
): Promise<StoredTokens> {
  return tokenRequest(fetch, client, { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier, resource: p.resource }, signal, clock);
}

export function refreshGrant(fetch: Fetch, client: StoredClient, current: StoredTokens, signal?: AbortSignal, clock: () => number = Date.now): Promise<StoredTokens> {
  if (!current.refreshToken) return Promise.reject(new SourceError("needs_reauth", "No refresh token"));
  return tokenRequest(
    fetch,
    client,
    { grant_type: "refresh_token", refresh_token: current.refreshToken, ...(client.resource ? { resource: client.resource } : {}) },
    signal,
    clock,
  );
}
