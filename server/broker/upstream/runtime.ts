import type { CoreContext } from "../../context.ts";
import { callbackMode } from "../../google/client.ts";
import { HttpError } from "../../util/errors.ts";
import { randomToken } from "../../util/ids.ts";
import { type LookupFn, resolveTarget } from "../../util/ssrf.ts";
import { checkExpiries } from "../credentials/expiry.ts";
import { Refresher } from "../credentials/refresher.ts";
import { scrubText } from "../credentials/scrub.ts";
import { type EmitConnectionEvent, type PendingAuth, SqliteCredentialStore } from "../credentials/store.ts";
import { type IntegrationPreset, type RefreshFn, SourceError, type StoredTokens, type ToolSource } from "../types.ts";
import { connectionConsoleUrl, type ConnectionRow, getConnection, requireRemote } from "./connection.ts";
import { discover, parseWwwAuthenticate } from "./discovery.ts";
import { allowFromColumn, canonicalPrivateTarget, checkTarget, type GuardedFetch, type GuardedFetchOptions, guardedFetch, originKey, validateUpstreamUrl } from "./fetch.ts";
import { authorizationUrl, ensureClient, exchangeCode, pkcePair, refreshGrant, requestedScope, type StoredClient } from "./oauth.ts";
import { RemoteToolSource } from "./source.ts";

/** Where upstream sign-ins land. Not Google's /oauth/callback, whose registered redirect URI must never change. */
export const CONNECTION_CALLBACK_PATH = "/oauth/connections/callback";
/** Our client ID metadata document (public https installs only). */
export const CLIENT_METADATA_PATH = "/oauth/connections/client.json";
/** Paste-mode fallback for providers that refuse http://localhost redirects (WHOOP). */
export const HTTPS_LOCALHOST_REDIRECT = `https://localhost${CONNECTION_CALLBACK_PATH}`;
const STATE_TTL_MS = 15 * 60_000;
const CLIENT_NAME = "xaq";

/**
 * A native integration's own OAuth (a `user_app` preset such as WHOOP): its authorize URL and code exchange.
 * Registered by the integration's wiring; `state`, single use and the binding to the connection stay ours.
 */
export interface NativeOAuthFlow {
  /** connections.preset */
  preset: string;
  authorizeUrl(p: { connectionId: string; client: Record<string, unknown> | null; redirectUri: string; state: string }): string;
  /** The tokens, and the client record to store when the exchange learns more (WHOOP: whoop_user_id). Throws to fail the connect. */
  exchange(
    code: string,
    p: { connectionId: string; client: Record<string, unknown> | null; redirectUri: string; signal: AbortSignal },
  ): Promise<{ tokens: StoredTokens; client?: Record<string, unknown> | null }>;
  refreshFn(client: Record<string, unknown> | null): RefreshFn | null;
}

export interface StartConnectOptions {
  /** A client the preset ships or the user pasted (MCP OAuth): first in the registration order. */
  preRegistered?: { client_id: string; client_secret?: string } | null;
  /** The preset's reconnect cap (Notion: 180 days), shown as dated warnings. */
  reconnectPolicy?: IntegrationPreset["reconnectPolicy"];
  /** "https_localhost": paste mode on https://localhost/oauth/connections/callback (providers refusing http://localhost). */
  redirect?: "default" | "https_localhost";
  /**
   * A native preset's candidate client (the user's pasted app): used for this sign-in and stored only with the
   * tokens once the consent completes.
   */
  nativeClient?: Record<string, unknown> | null;
  /**
   * The authorization server and every endpoint the browser or xaq is sent to must be on the connection URL's own
   * origin (a preset's `userServer.sameOriginIssuer`: T3 Code serves its own OAuth, and its approval page takes a
   * pairing code that must never be typed into another host).
   */
  sameOriginIssuer?: boolean;
}

/**
 * With `sameOriginIssuer`: the issuer, the authorization, token and registration endpoints and the resource must all
 * be on the MCP URL's exact `scheme://host:port`. Throws SourceError("blocked_target").
 */
export function requireSameOrigin(
  serverUrl: URL,
  d: { issuer: string; resource: string; metadata: { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string } },
): void {
  const origin = originKey(serverUrl);
  const named: [string, string | undefined][] = [
    ["authorization server", d.issuer],
    ["authorization endpoint", d.metadata.authorization_endpoint],
    ["token endpoint", d.metadata.token_endpoint],
    ["registration endpoint", d.metadata.registration_endpoint],
    ["resource", d.resource],
  ];
  for (const [what, value] of named) {
    if (value === undefined) continue;
    let o: string;
    try {
      o = originKey(value);
    } catch {
      throw new SourceError("protocol", `The server's ${what} isn't a valid URL`);
    }
    if (o !== origin) {
      throw new SourceError("blocked_target", `The server's ${what} is on ${o}, not on ${origin}. Its sign-in has to be on the server you named.`);
    }
  }
}

export interface StartConnectResult {
  authUrl: string;
  state: string;
  callbackMode: "direct" | "paste";
  redirectUri: string;
}

export interface FinishConnectResult {
  connectionId: string;
  slug: string;
  name: string;
}

/** What `probe(url)` found: drives the Add connection dialog's next step. */
export type ProbeResult =
  | { auth: "none" }
  | { auth: "header" }
  | {
      auth: "oauth";
      issuer: string;
      /** How the broker would register: metadata document, DCR, or a client ID the user must paste. */
      registration: "metadata_document" | "dcr" | "pre_registered_required";
      /** The authorization server issues refresh tokens (false: T3, dated expiry warnings). */
      refresh: boolean;
      scopes: string[];
    }
  /** The SSRF guard refused it. `privateTarget` is the exact origin an admin could allow, when an allow would help. */
  | { auth: "blocked"; message: string; privateTarget: string | null }
  | { auth: "unreachable"; message: string };

export interface UpstreamRuntimeOptions {
  /** Events outbox hook for connection.auth_failed / connection.expiring (the events PR wires the real one). */
  emit?: EmitConnectionEvent;
  lookup?: LookupFn;
  now?: () => number;
  /** Tests: see GuardedFetchOptions.dial. */
  dial?: GuardedFetchOptions["dial"];
  callTimeoutMs?: number;
  sweepIntervalMs?: number;
}

type Ctx = Pick<CoreContext, "db" | "crypto" | "audit" | "log" | "settings" | "config">;

/**
 * The upstream manager: per-connection guarded fetches and pooled ToolSources, the credential store and
 * refresher, the connect flow (start/finish/probe) and the background sweep. Inert while the
 * `brokerUpstreams` setting is off.
 */
export class UpstreamRuntime {
  readonly store: SqliteCredentialStore;
  readonly refresher: Refresher;
  private readonly sources = new Map<string, RemoteToolSource>();
  private readonly fetches = new Map<string, { allow: string | null; fetch: GuardedFetch }>();
  private readonly native = new Map<string, NativeOAuthFlow>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly emit: EmitConnectionEvent;

  constructor(
    private readonly ctx: Ctx,
    private readonly opts: UpstreamRuntimeOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    const log = ctx.log.child("broker");
    this.emit =
      opts.emit ??
      ((e) => {
        // Until the events PR opens EventType to connection.* events: logged, and audited by the caller.
        log.warn(`Connection event ${e.type} (events outbox not wired yet)`, { connectionId: e.connectionId });
      });
    this.store = new SqliteCredentialStore({
      db: ctx.db,
      crypto: ctx.crypto,
      audit: ctx.audit,
      log: ctx.log,
      emit: this.emit,
      now: this.now,
      consoleUrl: (id) => this.consoleUrl(id),
    });
    this.refresher = new Refresher(this.store, { log: ctx.log, now: this.now, sweepIntervalMs: opts.sweepIntervalMs });
  }

  /** The connection's page in the console: where the owner reconnects it (events and agents' errors link here). */
  consoleUrl(connectionId: string): string {
    return connectionConsoleUrl(this.ctx.settings.publicUrl(), connectionId);
  }

  enabled(): boolean {
    return this.ctx.settings.get().brokerUpstreams === true;
  }

  private requireEnabled(): void {
    if (!this.enabled()) throw new SourceError("unavailable", "Upstream connections are turned off (Settings → brokerUpstreams)");
  }

  registerNativeFlow(flow: NativeOAuthFlow): void {
    this.native.set(flow.preset, flow);
  }

  /**
   * Native flows for presets not registered up front (a code extension's `user_app` auth, built from its manifest):
   * asked for each preset id that has no registered flow.
   */
  setNativeFlowResolver(resolve: (preset: string) => NativeOAuthFlow | null): void {
    this.resolveNative = resolve;
  }

  private resolveNative: ((preset: string) => NativeOAuthFlow | null) | null = null;

  private nativeFlow(preset: string | null): NativeOAuthFlow | undefined {
    if (!preset) return undefined;
    return this.native.get(preset) ?? this.resolveNative?.(preset) ?? undefined;
  }

  /** The connection's guarded fetch, rebuilt when its private-target allow changes. */
  fetchFor(conn: Pick<ConnectionRow, "id" | "private_target" | "url">): GuardedFetch {
    const key = `${conn.private_target ?? ""}|${conn.url ?? ""}`;
    const hit = this.fetches.get(conn.id);
    if (hit && hit.allow === key) return hit.fetch;
    if (hit) void hit.fetch.close();
    const fetch = guardedFetch({ allow: allowFromColumn(conn.private_target, conn.url), lookup: this.opts.lookup, dial: this.opts.dial });
    this.fetches.set(conn.id, { allow: key, fetch });
    return fetch;
  }

  /** The refresh exchange for a connection's credential, or null when it has none (header/none auth). */
  refreshFnFor(conn: ConnectionRow): RefreshFn | null {
    if (conn.kind === "remote_http" && conn.auth_type === "oauth") {
      return (current, signal) => {
        const client = this.store.client(conn.id) as StoredClient | null;
        if (!client?.client_id) return Promise.reject(new SourceError("needs_reauth", "The OAuth client registration is missing"));
        // The registration is bound to its issuer: a token from another issuer never goes to this endpoint.
        if (current.issuer && current.issuer !== client.issuer) return Promise.reject(new SourceError("needs_reauth", "The authorization server changed"));
        return refreshGrant(this.fetchFor(getConnection(this.ctx.db, conn.id) ?? conn), client, current, signal, this.now);
      };
    }
    const flow = this.nativeFlow(conn.preset);
    return flow ? flow.refreshFn(this.store.client(conn.id)) : null;
  }

  /** The pooled ToolSource of a remote_http connection. */
  source(connectionId: string): ToolSource {
    this.requireEnabled();
    let s = this.sources.get(connectionId);
    if (!s) {
      const conn = getConnection(this.ctx.db, connectionId);
      if (!conn || conn.kind !== "remote_http" || !conn.url) throw new SourceError("unavailable", "Not a remote MCP connection");
      s = new RemoteToolSource({
        connectionId,
        connection: () => requireRemote(this.ctx.db, connectionId),
        fetch: (url, init) => this.fetchFor(requireRemote(this.ctx.db, connectionId))(url, init),
        store: this.store,
        refresher: this.refresher,
        refresh: this.refreshFnFor(conn),
        saveVerdict: (v) => this.ctx.db.run("UPDATE connections SET protocol = ?, protocol_checked_at = ? WHERE id = ?", v, v ? new Date(this.now()).toISOString() : null, connectionId),
        log: this.ctx.log.child("broker"),
        clientInfo: { name: CLIENT_NAME, version: this.ctx.config.version },
        callTimeoutMs: this.opts.callTimeoutMs,
      });
      this.sources.set(connectionId, s);
    }
    return s;
  }

  /** Drops the pooled session and fetch (URL or allow edited, reconnect, kill switch, delete). */
  async invalidate(connectionId: string): Promise<void> {
    const s = this.sources.get(connectionId);
    this.sources.delete(connectionId);
    const f = this.fetches.get(connectionId);
    this.fetches.delete(connectionId);
    await Promise.all([s?.close(), f?.fetch.close()]);
  }

  /** Disconnect / kill switch: closes the session, stops refreshing and deletes every credential. */
  async disconnect(connectionId: string): Promise<void> {
    this.refresher.untrack(connectionId);
    await this.invalidate(connectionId);
    this.store.clear(connectionId);
  }

  // ── Connect flow ──

  /** The callback URL: direct on an https or loopback public URL, else paste mode (as Google's callbackMode). */
  callback(redirect: StartConnectOptions["redirect"] = "default"): { mode: "direct" | "paste"; redirectUri: string } {
    if (redirect === "https_localhost") return { mode: "paste", redirectUri: HTTPS_LOCALHOST_REDIRECT };
    const { mode, redirectUri } = callbackMode(this.ctx);
    return { mode, redirectUri: redirectUri.replace(/\/oauth\/callback$/, CONNECTION_CALLBACK_PATH) };
  }

  /** Our client ID metadata document URL, when this install has a public https URL that resolves publicly. */
  async metadataDocumentUrl(): Promise<string | null> {
    const base = this.ctx.settings.publicUrl();
    let u: URL;
    try {
      u = new URL(base);
    } catch {
      return null;
    }
    if (u.protocol !== "https:") return null;
    try {
      await resolveTarget(u, [], this.opts.lookup);
    } catch {
      return null;
    }
    return `${base}${CLIENT_METADATA_PATH}`;
  }

  clientMetadataDocument(): Record<string, unknown> {
    const base = this.ctx.settings.publicUrl();
    return {
      client_id: `${base}${CLIENT_METADATA_PATH}`,
      client_name: CLIENT_NAME,
      client_uri: base,
      redirect_uris: [this.callback().redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    };
  }

  /** POSTs an unauthenticated `initialize` to read the 401 challenge. */
  private async challenge(fetch: GuardedFetch, url: URL, signal?: AbortSignal): Promise<{ status: number; www: string | null }> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: CLIENT_NAME, version: this.ctx.config.version } },
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    await res.body?.cancel().catch(() => {});
    return { status: res.status, www: res.headers.get("www-authenticate") };
  }

  /**
   * Starts a sign-in for a connection: MCP OAuth (discovery, registration, PKCE, `state`, `resource`) for a
   * remote_http/oauth connection, or the preset's own flow for a native user_app connection. Returns the URL
   * to open (popup, or paste mode).
   */
  async startConnect(connectionId: string, o: StartConnectOptions = {}): Promise<StartConnectResult> {
    this.requireEnabled();
    const conn = getConnection(this.ctx.db, connectionId);
    if (!conn) throw new HttpError(404, "not_found", "Connection not found");
    if (conn.status === "disabled") throw new HttpError(409, "connection_disabled", `${conn.name} is disabled`, "Enable it first.");
    const { mode, redirectUri } = this.callback(o.redirect);
    const state = randomToken(32);
    let authUrl: string;
    let pending: PendingAuth;
    let verifier = "";
    let client: StoredClient | null = null;

    const native = conn.kind !== "remote_http" ? this.nativeFlow(conn.preset) : undefined;
    let nativeCandidate: Record<string, unknown> | null = null;
    if (native) {
      nativeCandidate = o.nativeClient ?? null;
      authUrl = native.authorizeUrl({ connectionId, client: nativeCandidate ?? this.store.client(connectionId), redirectUri, state });
      pending = { issuer: new URL(authUrl).origin, resource: "", redirectUri, authorizationEndpoint: authUrl, tokenEndpoint: "", scope: null, issParameter: false };
    } else {
      if (conn.kind !== "remote_http" || !conn.url) throw new HttpError(400, "connection_kind", `${conn.name} has no sign-in flow`);
      if (conn.auth_type !== "oauth") throw new HttpError(400, "connection_auth", `${conn.name} doesn't use OAuth`, "It uses a static header or no auth.");
      const fetch = this.fetchFor(conn);
      const url = validateUpstreamUrl(conn.url);
      const ch = await this.challenge(fetch, url);
      const w = parseWwwAuthenticate(ch.www);
      const allow = allowFromColumn(conn.private_target, conn.url);
      const d = await discover(fetch, url, w.resourceMetadata, allow);
      if (o.sameOriginIssuer) requireSameOrigin(url, d);
      // Step-up: ask for the union of what the 401 wants and what this issuer already granted.
      const stored = this.store.tokens(connectionId);
      const granted = stored?.issuer === d.issuer ? (stored.scope ?? "") : "";
      const union = [...new Set(`${w.scope ?? ""} ${granted}`.split(/\s+/).filter(Boolean))].join(" ");
      const scope = requestedScope(d.metadata, d.resourceMetadata?.scopes_supported, union || undefined);
      // The candidate client lives in this flow's encrypted record only: nothing about the connection's
      // credential changes before the consent completes (an abandoned sign-in elsewhere changes nothing).
      client = {
        ...(await ensureClient(fetch, d.metadata, this.store.client(connectionId) as StoredClient | null, {
          redirectUri,
          preRegistered: o.preRegistered,
          metadataDocumentUrl: await this.metadataDocumentUrl(),
          clientName: CLIENT_NAME,
          scope,
        })),
        resource: d.resource,
      };
      const pkce = pkcePair();
      verifier = pkce.verifier;
      authUrl = authorizationUrl(d.metadata, client, { redirectUri, state, challenge: pkce.challenge, resource: d.resource, scope });
      pending = {
        issuer: d.issuer,
        resource: d.resource,
        redirectUri,
        authorizationEndpoint: d.metadata.authorization_endpoint,
        tokenEndpoint: d.metadata.token_endpoint,
        scope,
        issParameter: d.metadata.authorization_response_iss_parameter_supported === true,
      };
    }
    const full: PendingAuth = {
      ...pending,
      ...(o.reconnectPolicy?.maxLifetimeDays ? { capDays: o.reconnectPolicy.maxLifetimeDays } : {}),
      ...(o.reconnectPolicy?.tokenLifetimeCapDays ? { tokenCapDays: o.reconnectPolicy.tokenLifetimeCapDays } : {}),
      // The server this sign-in is for: a URL edit before the callback makes it void.
      ...(conn.url ? { origin: originKey(conn.url) } : {}),
    };
    // Each flow keeps its own verifier and discovery result: concurrent Reconnects don't overwrite each other.
    this.store.addFlow(connectionId, state, { verifier, redirectUri, pending: full, client: native ? nativeCandidate : client });
    this.ctx.db.run("DELETE FROM oauth_states WHERE created_at < ?", new Date(this.now() - STATE_TTL_MS).toISOString());
    this.ctx.db.run(
      "INSERT INTO oauth_states (state, code_verifier, redirect_uri, reauth_account_id, created_at, connection_id) VALUES (?, '', ?, NULL, ?, ?)",
      state,
      redirectUri,
      new Date(this.now()).toISOString(),
      connectionId,
    );
    return { authUrl, state, callbackMode: mode, redirectUri };
  }

  /** Consumes a connection's pending state (single use, bound to its connection). */
  private takeState(state: string | null): { connectionId: string; createdAt: number } {
    const row = state
      ? this.ctx.db.get<{ connection_id: string; created_at: string }>("SELECT connection_id, created_at FROM oauth_states WHERE state = ? AND connection_id IS NOT NULL", state)
      : undefined;
    if (row) this.ctx.db.run("DELETE FROM oauth_states WHERE state = ?", state);
    if (!row || Date.parse(row.created_at) + STATE_TTL_MS < this.now()) {
      throw new HttpError(400, "oauth_state", "This sign-in link has expired or was already used.", "Start the connection again from Connections in the console.");
    }
    return { connectionId: row.connection_id, createdAt: Date.parse(row.created_at) };
  }

  /**
   * Completes a sign-in from the callback's query: checks `state` (ours, single use, bound to the connection),
   * `iss` (RFC 9207) and exchanges the code over the guarded fetch. A failure on a first connect leaves the
   * connection's status alone (the callback page shows it).
   */
  async finishConnect(q: { code?: string | null; state?: string | null; iss?: string | null; error?: string | null; errorDescription?: string | null }): Promise<FinishConnectResult> {
    this.requireEnabled();
    // The state comes first, even for an error response: an unknown state gets no upstream text echoed back.
    let taken: { connectionId: string };
    try {
      taken = this.takeState(q.state ?? null);
    } catch (err) {
      if (q.error) throw new HttpError(400, "oauth_error", "The sign-in didn't complete.", "Start the connection again from Connections in the console.");
      throw err;
    }
    const { connectionId } = taken;
    const conn = getConnection(this.ctx.db, connectionId);
    if (!conn) throw new HttpError(404, "not_found", "Connection not found");
    const flow = this.store.takeFlow(connectionId, q.state!);
    const pending = flow?.pending ?? null;
    if (!flow || !pending) throw new HttpError(400, "oauth_state", "This sign-in link has expired or was already used.", "Start the connection again.");
    const native = conn.kind !== "remote_http" ? this.nativeFlow(conn.preset) : undefined;
    if (pending.origin !== undefined && (!conn.url || originKey(conn.url) !== pending.origin)) {
      throw new HttpError(409, "connection_changed", "The connection's URL changed after this sign-in started.", "Connect again from Connections in the console.");
    }

    // RFC 9207, before acting on (or showing) anything in the response, errors included: a present `iss` must be
    // the issuer we started with, and a server that promises it must send it.
    if (!native && (q.iss ? q.iss !== pending.issuer : pending.issParameter)) {
      throw new HttpError(400, "oauth_issuer", "The sign-in came back from a different authorization server than the one it started at.", "Start the connection again.");
    }
    if (q.error) {
      const denied = q.error === "access_denied";
      throw new HttpError(
        400,
        denied ? "oauth_access_denied" : "oauth_error",
        denied ? "The sign-in was cancelled." : `The server refused the sign-in (${scrubText(q.error, [], 80)}).`,
        q.errorDescription ? scrubText(q.errorDescription, [], 200) : "Try connecting again from Connections in the console.",
      );
    }
    if (!q.code) throw new HttpError(400, "oauth_no_code", "The sign-in didn't return an authorization code.", "Start the connection again.");

    let tokens: StoredTokens;
    let client: Record<string, unknown> | null;
    let registration: string | null = null;
    const signal = AbortSignal.timeout(30_000);
    if (native) {
      // The candidate client this sign-in started with (a pasted app), else the stored one.
      const nativeClient = (flow.client as Record<string, unknown> | null | undefined) ?? this.store.client(connectionId);
      const out = await native.exchange(q.code, { connectionId, client: nativeClient, redirectUri: flow.redirectUri, signal });
      tokens = out.tokens;
      client = out.client ?? (flow.client ? nativeClient : null);
    } else {
      const candidate = flow.client as StoredClient | null | undefined;
      if (!candidate?.client_id || candidate.issuer !== pending.issuer) {
        throw new HttpError(400, "oauth_client", "The OAuth client registration for this sign-in is missing.", "Start the connection again.");
      }
      registration = candidate.source;
      client = candidate;
      tokens = await exchangeCode(this.fetchFor(conn), candidate, { code: q.code, verifier: flow.verifier, redirectUri: flow.redirectUri, resource: pending.resource }, signal, this.now);
    }

    // Client, tokens and the issuer they're tied to, together, only now. No `scope` in the answer means what we asked for.
    this.store.saveConsent(connectionId, client, { ...tokens, issuer: native ? (tokens.issuer ?? null) : pending.issuer, scope: tokens.scope ?? pending.scope });
    // Credential lifetime for the dated warnings: no refresh token = the access token's expiry (saveTokens);
    // a preset's cap (Notion: 180 days) runs from this consent.
    if (tokens.refreshToken) {
      const cap = pending.capDays ? new Date(this.now() + pending.capDays * 86_400_000).toISOString() : null;
      this.ctx.db.run("UPDATE connections SET expires_at = ? WHERE id = ?", cap, connectionId);
    } else if (pending.tokenCapDays) {
      // No refresh: the credential dies with the access token (saveTokens), and never later than the preset's cap.
      const cap = this.now() + pending.tokenCapDays * 86_400_000;
      const at = tokens.expiresAt === null ? cap : Math.min(tokens.expiresAt, cap);
      this.ctx.db.run("UPDATE connections SET expires_at = ? WHERE id = ?", new Date(at).toISOString(), connectionId);
    }

    this.store.markActive(connectionId);
    await this.invalidate(connectionId);
    const fresh = getConnection(this.ctx.db, connectionId)!;
    const refresh = this.refreshFnFor(fresh);
    if (refresh && tokens.refreshToken) this.refresher.track(connectionId, refresh);
    this.ctx.audit.record({
      actorType: "admin",
      action: "connection.connect",
      target: connectionId,
      outcome: "ok",
      detail: {
        slug: conn.slug,
        ...(conn.url ? { origin: originKey(conn.url) } : {}),
        registration,
        refresh: !!tokens.refreshToken,
        expiresAt: fresh.expires_at,
        // What the server granted, which may be more (T3's Full access) or less than asked for. Never a secret.
        scope: tokens.scope ?? pending.scope,
      },
    });
    return { connectionId, slug: conn.slug, name: conn.name };
  }

  /** Paste mode: the full landing URL (or its query) the user copied after approving. */
  finishConnectFromUrl(raw: string): Promise<FinishConnectResult> {
    let url: URL;
    try {
      const text = raw.trim();
      url = new URL(text.startsWith("?") ? `http://localhost${CONNECTION_CALLBACK_PATH}${text}` : text);
    } catch {
      return Promise.reject(new HttpError(400, "oauth_url_invalid", "That isn't a valid URL.", "Copy the whole address from the browser's address bar after approving access."));
    }
    const q = url.searchParams;
    return this.finishConnect({ code: q.get("code"), state: q.get("state"), iss: q.get("iss"), error: q.get("error"), errorDescription: q.get("error_description") });
  }

  /**
   * What a URL needs before it can be added: no auth, a header, OAuth (with or without automatic
   * registration), or a blocked private target (with the exact origin an admin could allow).
   */
  async probe(rawUrl: string, o: { privateTarget?: string | null; signal?: AbortSignal } = {}): Promise<ProbeResult> {
    let url: URL;
    try {
      url = validateUpstreamUrl(rawUrl);
    } catch (err) {
      return { auth: "blocked", message: (err as Error).message, privateTarget: null };
    }
    const allow = o.privateTarget ? { origin: canonicalPrivateTarget(o.privateTarget) } : null;
    // An allow only ever covers the probed URL's own origin.
    if (allow && allow.origin !== originKey(url)) {
      return { auth: "blocked", message: `The private-target allow ${allow.origin} isn't this URL's origin (${originKey(url)})`, privateTarget: null };
    }
    const fetch = guardedFetch({ allow, lookup: this.opts.lookup, dial: this.opts.dial });
    try {
      let ch: { status: number; www: string | null };
      try {
        ch = await this.challenge(fetch, url, o.signal);
      } catch (err) {
        if (err instanceof SourceError && err.code === "blocked_target") {
          // Would the admin's allow for exactly this origin help? Only for allowable private ranges.
          let privateTarget: string | null = null;
          if (!allow) {
            try {
              const origin = canonicalPrivateTarget(originKey(url));
              await checkTarget(url, { allow: { origin }, lookup: this.opts.lookup });
              privateTarget = origin;
            } catch {
              privateTarget = null;
            }
          }
          return { auth: "blocked", message: err.message, privateTarget };
        }
        return { auth: "unreachable", message: err instanceof SourceError ? err.message : `Couldn't reach ${originKey(url)}: ${scrubText((err as Error).message, [], 200)}` };
      }
      if (ch.status === 403) return { auth: "header" };
      if (ch.status !== 401) return { auth: "none" };
      const w = parseWwwAuthenticate(ch.www);
      try {
        const d = await discover(fetch, url, w.resourceMetadata, allow, o.signal);
        const md = d.metadata;
        const registration = md.client_id_metadata_document_supported === true && (await this.metadataDocumentUrl()) ? "metadata_document" : md.registration_endpoint ? "dcr" : "pre_registered_required";
        return {
          auth: "oauth",
          issuer: d.issuer,
          registration,
          refresh: !md.grant_types_supported || md.grant_types_supported.includes("refresh_token"),
          scopes: d.resourceMetadata?.scopes_supported ?? md.scopes_supported ?? [],
        };
      } catch (err) {
        // A bare 401 without usable OAuth metadata: a static key or token.
        if (!w.resourceMetadata) return { auth: "header" };
        if (err instanceof SourceError && err.code === "blocked_target") return { auth: "blocked", message: err.message, privateTarget: null };
        return { auth: "unreachable", message: err instanceof SourceError ? err.message : scrubText(String(err), [], 200) };
      }
    } finally {
      await fetch.close();
    }
  }

  // ── Lifecycle ──

  /** One background pass: proactive refreshes and the dated expiry warnings. */
  async sweep(): Promise<void> {
    if (!this.enabled()) return;
    await this.refresher.sweep();
    checkExpiries({
      db: this.ctx.db,
      audit: this.ctx.audit,
      log: this.ctx.log,
      emit: this.emit,
      store: this.store,
      now: this.now,
      consoleUrl: (id) => this.consoleUrl(id),
    });
  }

  /** Tracks every refreshable connection and starts the sweep timer. */
  start(): void {
    const rows = this.ctx.db.all<{ id: string }>("SELECT c.id FROM connections c JOIN connection_credentials k ON k.connection_id = c.id WHERE c.status = 'active' AND k.refresh_token_enc IS NOT NULL");
    for (const { id } of rows) {
      const conn = getConnection(this.ctx.db, id);
      const fn = conn ? this.refreshFnFor(conn) : null;
      if (fn) this.refresher.track(id, fn);
    }
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep().catch(() => {}), this.opts.sweepIntervalMs ?? 60_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.sources.keys()].map((id) => this.invalidate(id)));
    await Promise.all([...this.fetches.values()].map((f) => f.fetch.close()));
    this.fetches.clear();
  }
}

const runtimes = new WeakMap<object, UpstreamRuntime>();

/** The process's upstream runtime for this context (created on first use; the API and callback routes share it). */
export function upstreams(ctx: Ctx, opts?: UpstreamRuntimeOptions): UpstreamRuntime {
  let rt = runtimes.get(ctx);
  if (!rt) {
    rt = new UpstreamRuntime(ctx, opts);
    runtimes.set(ctx, rt);
  }
  return rt;
}
