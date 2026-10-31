import type { AuditLog } from "../../audit.ts";
import type { Crypto } from "../../crypto.ts";
import { sha256 } from "../../crypto.ts";
import type { Db } from "../../db/index.ts";
import type { Logger } from "../../util/log.ts";
import { errorMessage } from "../../util/errors.ts";
import type { StoredTokens } from "../types.ts";
import { scrubText } from "./scrub.ts";

/**
 * A connection event for the events outbox (`connection.auth_failed`, `connection.expiring`). The events
 * PR opens EventType to these; until then the wiring passes an emitter that logs (see createCredentialStore).
 */
export interface ConnectionEvent {
  type: "connection.auth_failed" | "connection.expiring";
  connectionId: string;
  detail: Record<string, unknown>;
  dedupeKey: string;
}

export type EmitConnectionEvent = (e: ConnectionEvent) => void;

export interface CredentialStoreDeps {
  db: Db;
  crypto: Crypto;
  audit: AuditLog;
  log: Logger;
  emit: EmitConnectionEvent;
  now?: () => number;
  /** The console page of a connection (`<publicUrl>/connections/<id>`), put in events as the one-click Reconnect link. */
  consoleUrl?: (connectionId: string) => string;
}

interface CredRow {
  connection_id: string;
  header_name_enc: string | null;
  header_value_enc: string | null;
  oauth_issuer_enc: string | null;
  oauth_client_enc: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: string | null;
  issued_at: string | null;
  scope: string | null;
  pkce_verifier_enc: string | null;
  discovery_enc: string | null;
}

/** The discovery result and redirect of an authorization in flight (connection_credentials.discovery_enc). */
export interface PendingAuth {
  issuer: string;
  resource: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scope: string | null;
  /** The authorization server sends RFC 9207 `iss` on the redirect. */
  issParameter: boolean;
  /** A preset reconnect cap in days (Notion: 180), applied when the sign-in completes. */
  capDays?: number;
  /** A preset cap on a credential without a refresh token (T3 Code: 30 days), applied when the sign-in completes. */
  tokenCapDays?: number;
  /** The connection URL's origin when the sign-in started: refused at finish if the URL changed since. */
  origin?: string;
}

/** One authorization in flight (store.addFlow). */
export interface PkceFlow {
  /** Empty for flows without PKCE (a native user_app preset such as WHOOP). */
  verifier: string;
  redirectUri: string;
  /** The discovery result this flow started with. */
  pending: PendingAuth;
  /**
   * The candidate client (MCP OAuth registration, or a native preset's pasted app): stored as the connection's client
   * only once the consent completes.
   */
  client?: Record<string, unknown> | null;
  createdAt: number;
}

/** Same lifetime as Google's oauth_states rows. */
export const FLOW_TTL_MS = 15 * 60_000;
const MAX_FLOWS = 5;

const iso = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const ms = (s: string | null): number | null => (s ? Date.parse(s) : null);

/**
 * Encrypted per-connection credentials in `connection_credentials` (migration 8/9), AES-GCM via
 * server/crypto.ts. Nothing here is ever logged, audited or returned by the API.
 */
export class CredentialStore {
  private readonly now: () => number;

  constructor(private readonly deps: CredentialStoreDeps) {
    this.now = deps.now ?? Date.now;
  }

  private row(connectionId: string): CredRow | undefined {
    return this.deps.db.get<CredRow>("SELECT * FROM connection_credentials WHERE connection_id = ?", connectionId);
  }

  private dec(v: string | null): string | null {
    return v === null ? null : this.deps.crypto.decrypt(v);
  }

  private enc(v: string | null | undefined): string | null {
    return v === null || v === undefined ? null : this.deps.crypto.encrypt(v);
  }

  /** Upserts columns on the connection's row. */
  private patch(connectionId: string, cols: Partial<Record<keyof CredRow, string | null>>): void {
    const ts = new Date(this.now()).toISOString();
    const entries = Object.entries(cols);
    const names = entries.map(([k]) => k);
    this.deps.db.run(
      `INSERT INTO connection_credentials (connection_id, ${names.join(", ")}, created_at, updated_at)
       VALUES (?, ${names.map(() => "?").join(", ")}, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET ${names.map((n) => `${n} = excluded.${n}`).join(", ")}, updated_at = excluded.updated_at`,
      connectionId,
      ...entries.map(([, v]) => v ?? null),
      ts,
      ts,
    );
  }

  header(connectionId: string): { name: string; value: string } | null {
    const r = this.row(connectionId);
    if (!r?.header_name_enc || !r.header_value_enc) return null;
    return { name: this.dec(r.header_name_enc)!, value: this.dec(r.header_value_enc)! };
  }

  setHeader(connectionId: string, name: string, value: string): void {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error("Invalid header name");
    if (/[\r\n\0]/.test(value)) throw new Error("Invalid header value");
    this.patch(connectionId, { header_name_enc: this.enc(name), header_value_enc: this.enc(value) });
  }

  tokens(connectionId: string): StoredTokens | null {
    const r = this.row(connectionId);
    if (!r?.access_token_enc) return null;
    return {
      accessToken: this.dec(r.access_token_enc)!,
      refreshToken: this.dec(r.refresh_token_enc),
      expiresAt: ms(r.expires_at),
      scope: r.scope,
      issuer: this.dec(r.oauth_issuer_enc),
      issuedAt: ms(r.issued_at),
    };
  }

  /**
   * Compare-and-swap on the refresh token. `expectedRefreshToken` undefined saves unconditionally (a new
   * consent); null expects none stored; a string must equal the stored one. Ciphertexts are randomised, so
   * the comparison decrypts inside one transaction (node:sqlite is synchronous: nothing interleaves).
   */
  saveTokens(connectionId: string, tokens: StoredTokens, expectedRefreshToken?: string | null): boolean {
    return this.deps.db.tx(() => {
      if (expectedRefreshToken !== undefined) {
        const r = this.row(connectionId);
        const current = r ? this.dec(r.refresh_token_enc) : null;
        if (current !== expectedRefreshToken) return false;
      }
      this.patch(connectionId, {
        access_token_enc: this.enc(tokens.accessToken),
        refresh_token_enc: this.enc(tokens.refreshToken),
        expires_at: iso(tokens.expiresAt),
        issued_at: iso(tokens.issuedAt ?? this.now()),
        scope: tokens.scope,
        ...(tokens.issuer ? { oauth_issuer_enc: this.enc(tokens.issuer) } : {}),
      });
      // Without a refresh token the credential dies with the access token: that drives the dated warnings.
      if (!tokens.refreshToken) {
        this.deps.db.run("UPDATE connections SET expires_at = ?, updated_at = ? WHERE id = ?", iso(tokens.expiresAt), new Date(this.now()).toISOString(), connectionId);
      }
      return true;
    });
  }

  client(connectionId: string): Record<string, unknown> | null {
    const r = this.row(connectionId);
    if (!r?.oauth_client_enc) return null;
    try {
      return JSON.parse(this.dec(r.oauth_client_enc)!) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** The registration, keyed by issuer inside the record (`issuer`): reused only with that issuer. */
  setClient(connectionId: string, client: Record<string, unknown>): void {
    // Never the issuer: only saveTokens ties a credential to an issuer (with the tokens it issued).
    this.patch(connectionId, { oauth_client_enc: this.enc(JSON.stringify(client)) });
  }

  /**
   * A completed consent: the client it used and the tokens it issued (with their issuer), in one transaction.
   * Nothing about a sign-in is stored before this (startConnect keeps its candidate client in the flow record).
   */
  saveConsent(connectionId: string, client: Record<string, unknown> | null, tokens: StoredTokens): void {
    this.deps.db.tx(() => {
      if (client) this.setClient(connectionId, client);
      this.saveTokens(connectionId, tokens);
    });
  }

  /**
   * Authorizations in flight, keyed by sha256(state), in `pkce_verifier_enc` (encrypted JSON): never in the
   * plaintext oauth_states.code_verifier. Two concurrent Reconnects keep separate verifiers.
   */
  private flows(r: CredRow | undefined): Record<string, PkceFlow> {
    if (!r?.pkce_verifier_enc) return {};
    try {
      return JSON.parse(this.dec(r.pkce_verifier_enc)!) as Record<string, PkceFlow>;
    } catch {
      return {};
    }
  }

  addFlow(connectionId: string, state: string, flow: Omit<PkceFlow, "createdAt">): void {
    this.deps.db.tx(() => {
      const now = this.now();
      const kept = Object.entries(this.flows(this.row(connectionId)))
        .filter(([, f]) => f.createdAt + FLOW_TTL_MS >= now)
        .sort(([, a], [, b]) => b.createdAt - a.createdAt)
        .slice(0, MAX_FLOWS - 1);
      const next = Object.fromEntries([...kept, [sha256(state), { ...flow, createdAt: now }]]);
      this.patch(connectionId, { pkce_verifier_enc: this.enc(JSON.stringify(next)) });
    });
  }

  /** Consumes the flow for `state` (single use); null when unknown or older than FLOW_TTL_MS. */
  takeFlow(connectionId: string, state: string): PkceFlow | null {
    return this.deps.db.tx(() => {
      const all = this.flows(this.row(connectionId));
      const key = sha256(state);
      const flow = all[key] ?? null;
      if (!flow) return null;
      delete all[key];
      this.patch(connectionId, { pkce_verifier_enc: Object.keys(all).length ? this.enc(JSON.stringify(all)) : null });
      return flow.createdAt + FLOW_TTL_MS >= this.now() ? flow : null;
    });
  }

  /** The discovery result of the latest authorization (shared by concurrent flows of one connection). */
  pending(connectionId: string): PendingAuth | null {
    const r = this.row(connectionId);
    if (!r?.discovery_enc) return null;
    try {
      return JSON.parse(this.dec(r.discovery_enc)!) as PendingAuth;
    } catch {
      return null;
    }
  }

  setPending(connectionId: string, p: PendingAuth | null): void {
    this.patch(connectionId, { discovery_enc: p ? this.enc(JSON.stringify(p)) : null });
  }

  /** Every secret held for the connection, for scrubbing text that could echo one back. */
  secrets(connectionId: string): string[] {
    const r = this.row(connectionId);
    if (!r) return [];
    const client = this.client(connectionId);
    return [r.header_value_enc, r.access_token_enc, r.refresh_token_enc].map((v) => this.dec(v) ?? "").concat(typeof client?.client_secret === "string" ? [client.client_secret] : []).filter(Boolean);
  }

  /**
   * Sets status `needs_reauth` with the reason; the first transition emits `connection.auth_failed` and audits.
   * `expired`: the credential's lifetime is over (no refresh token: past its expiry, or rejected with a 401). The
   * connection's `expires_at` moves to now if it was later, so it reads as expired everywhere (console, agents' errors).
   */
  markNeedsReauth(connectionId: string, rawReason: string, opts: { expired?: boolean } = {}): void {
    const ts = new Date(this.now()).toISOString();
    // The reason may quote upstream text: scrub it before it's stored, emitted or audited.
    const reason = scrubText(rawReason, this.secrets(connectionId), 300);
    const { changes } = this.deps.db.run(
      `UPDATE connections SET status = 'needs_reauth', status_reason = ?, updated_at = ?${
        opts.expired ? ", expires_at = CASE WHEN expires_at IS NULL OR expires_at > ? THEN ? ELSE expires_at END" : ""
      } WHERE id = ? AND status IN ('active', 'error')`,
      reason,
      ts,
      ...(opts.expired ? [ts, ts] : []),
      connectionId,
    );
    if (!changes) return;
    const conn = this.deps.db.get<{ slug: string; name: string }>("SELECT slug, name FROM connections WHERE id = ?", connectionId);
    const r = this.row(connectionId);
    this.deps.log.child("broker").warn("Upstream connection needs re-auth", { connectionId, slug: conn?.slug, reason });
    try {
      this.deps.emit({
        type: "connection.auth_failed",
        connectionId,
        detail: {
          slug: conn?.slug ?? null,
          name: conn?.name ?? null,
          error: reason,
          ...(opts.expired ? { expired: true } : {}),
          ...(this.deps.consoleUrl ? { reconnectUrl: this.deps.consoleUrl(connectionId) } : {}),
        },
        // Once per credential: a reconnect stores new tokens, and their next failure is a new event.
        dedupeKey: `${connectionId}:auth_failed:${sha256(r?.refresh_token_enc ?? r?.access_token_enc ?? ts).slice(0, 12)}`,
      });
    } catch (err) {
      this.deps.log.child("broker").error("Could not record connection.auth_failed", { error: errorMessage(err) });
    }
    this.deps.audit.record({
      actorType: "system",
      action: "connection.auth_failed",
      target: connectionId,
      outcome: "error",
      detail: { slug: conn?.slug ?? null, error: reason, ...(opts.expired ? { expired: true } : {}) },
    });
  }

  /** Back to active after a successful consent. */
  markActive(connectionId: string): void {
    this.deps.db.run(
      "UPDATE connections SET status = 'active', status_reason = NULL, updated_at = ? WHERE id = ? AND status IN ('active', 'needs_reauth', 'error')",
      new Date(this.now()).toISOString(),
      connectionId,
    );
  }

  clear(connectionId: string): void {
    this.deps.db.run("DELETE FROM connection_credentials WHERE connection_id = ?", connectionId);
    this.deps.db.run("DELETE FROM oauth_states WHERE connection_id = ?", connectionId);
  }
}
