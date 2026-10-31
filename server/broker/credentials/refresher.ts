import { errorMessage } from "../../util/errors.ts";
import type { Logger } from "../../util/log.ts";
import { type RefreshFn, SourceError, type StoredTokens } from "../types.ts";
import type { CredentialStore } from "./store.ts";

/** Refresh at expiresAt − max(60 s, 10 % of the lifetime). */
export function refreshDueAt(t: Pick<StoredTokens, "expiresAt" | "issuedAt">): number | null {
  if (t.expiresAt === null) return null;
  const lifetime = t.issuedAt ? Math.max(0, t.expiresAt - t.issuedAt) : 0;
  return t.expiresAt - Math.max(60_000, lifetime * 0.1);
}

const REFRESH_TIMEOUT_MS = 30_000;
export const SWEEP_INTERVAL_MS = 60_000;

export interface RefresherOptions {
  log: Logger;
  now?: () => number;
  sweepIntervalMs?: number;
}

export interface AccessTokenOptions {
  /** A 401 rejected this access token: refresh unless another caller already replaced it. */
  rejected?: string;
  /** Refresh now (joins one already in flight). Prefer `rejected`, which skips a refresh someone else already did. */
  force?: boolean;
}

/**
 * Single-flight access tokens per connection (as server/google/tokens.ts TokenManager):
 * - proactive refresh at refreshDueAt; a background sweep does the same for tracked idle connections so
 *   rotating refresh tokens don't lapse;
 * - the rotated refresh token is saved with a compare-and-swap before the new access token is used; losing
 *   the swap means another refresh (or a reconnect) won, and its tokens are used;
 * - `invalid_grant`/`invalid_client` (RefreshFn throws SourceError("needs_reauth")) marks the connection
 *   needs_reauth once, unless a reconnect stored a new refresh token meanwhile;
 * - no refresh token: the access token is used until it expires, then needs_reauth (never a 401 mid-task).
 */
export class Refresher {
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly tracked = new Map<string, RefreshFn>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(
    private readonly store: CredentialStore,
    private readonly opts: RefresherOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  async accessToken(connectionId: string, refresh: RefreshFn, signal: AbortSignal, o: AccessTokenOptions = {}): Promise<string> {
    signal.throwIfAborted();
    const t = this.store.tokens(connectionId);
    if (!t) throw new SourceError("needs_reauth", "This connection isn't signed in");
    const forced = o.force === true || (o.rejected !== undefined && o.rejected === t.accessToken);
    if (o.rejected !== undefined && !forced) return t.accessToken; // someone already refreshed past the rejected token
    const due = refreshDueAt(t);
    if (!forced && (due === null || this.now() < due)) return t.accessToken;
    if (!t.refreshToken) {
      if (!forced && t.expiresAt !== null && this.now() < t.expiresAt) return t.accessToken;
      const reason = forced ? "The server rejected the access token and there's no refresh token" : "The access token expired and the server issues no refresh token";
      // No refresh token (T3): the access token was the whole credential, so it has expired.
      this.store.markNeedsReauth(connectionId, reason, { expired: true });
      throw new SourceError("needs_reauth", reason);
    }
    let p = this.inflight.get(connectionId);
    if (!p) {
      p = this.refresh(connectionId, refresh).finally(() => this.inflight.delete(connectionId));
      this.inflight.set(connectionId, p);
    }
    return untilAborted(p, signal);
  }

  private async refresh(connectionId: string, refresh: RefreshFn, attempt = 0): Promise<string> {
    const current = this.store.tokens(connectionId);
    if (!current?.refreshToken) throw new SourceError("needs_reauth", "This connection isn't signed in");
    let next: StoredTokens;
    try {
      // Not the caller's signal: other callers wait on this refresh.
      next = await refresh(current, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
    } catch (err) {
      if (err instanceof SourceError && err.code === "needs_reauth") {
        const fresh = this.store.tokens(connectionId);
        // A reconnect stored a new refresh token while this one was in flight: use that instead.
        if (fresh?.refreshToken && fresh.refreshToken !== current.refreshToken && attempt < 2) return this.refresh(connectionId, refresh, attempt + 1);
        this.store.markNeedsReauth(connectionId, err.message);
      }
      throw err;
    }
    const merged: StoredTokens = {
      ...next,
      // No new refresh token in the answer: the current one stays valid (RFC 6749 §6).
      refreshToken: next.refreshToken ?? current.refreshToken,
      issuer: next.issuer ?? current.issuer,
      scope: next.scope ?? current.scope,
      issuedAt: next.issuedAt ?? this.now(),
    };
    if (this.store.saveTokens(connectionId, merged, current.refreshToken)) return merged.accessToken;
    // Lost the swap: whoever won stored newer tokens.
    const fresh = this.store.tokens(connectionId);
    return fresh?.accessToken ?? merged.accessToken;
  }

  track(connectionId: string, refresh: RefreshFn): void {
    this.tracked.set(connectionId, refresh);
  }

  untrack(connectionId: string): void {
    this.tracked.delete(connectionId);
  }

  /** One sweep: refreshes every tracked connection that is due. Errors are logged (needs_reauth is already recorded). */
  async sweep(): Promise<void> {
    for (const [id, fn] of [...this.tracked]) {
      const t = this.store.tokens(id);
      const due = t ? refreshDueAt(t) : null;
      if (!t?.refreshToken || due === null || this.now() < due) continue;
      try {
        await this.accessToken(id, fn, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
      } catch (err) {
        if (err instanceof SourceError && err.code === "needs_reauth") this.untrack(id);
        else this.opts.log.child("broker").warn("Background token refresh failed", { connectionId: id, error: errorMessage(err) });
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Waits for `p`, rejecting early when `signal` aborts (the work itself goes on for other waiters). */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e as Error);
      },
    );
  });
}
