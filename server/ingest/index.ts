import type { Account, IngestStatus, Settings } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { type AccountRow, allRows, getRow, updateRow } from "../google/accounts.ts";
import { isAbortError, sleep } from "../google/http.ts";
import { AccountNeedsReauthError, GoogleApiError } from "../google/types.ts";
import { conflict, errorMessage } from "../util/errors.ts";
import { boundedResync, syncHistory } from "./sync.ts";

const syncable = (r: Pick<AccountRow, "status">) => r.status === "active" || r.status === "error";

/** Resolves when `p` settles or the signal aborts, whichever comes first (p keeps running). */
function untilAborted(p: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    p.then(done, done);
  });
}

export function createIngestService(ctx: AppContext): IngestService {
  return new IngestService(ctx);
}

interface Loop {
  interval: number;
  ctrl: AbortController;
  done: Promise<void>;
}

/** Gmail ingest: polling, per-account history syncs, resyncs, pause and resume. */
export class IngestService {
  private readonly log;
  private loop: Loop | null = null;
  private stopped = false;
  private restarting: Promise<void> = Promise.resolve();
  /** Tail of the per-account work queue (syncs and resyncs never overlap for one account). */
  private readonly chains = new Map<string, Promise<void>>();
  /** A queued, not yet started sync per account; further requests coalesce into it. */
  private readonly pendingSync = new Map<string, Promise<void>>();
  /** Aborted by stop(): in-flight syncs end after the current Gmail request. */
  private life = new AbortController();
  private lastPullAt: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly ctx: AppContext) {
    this.log = ctx.log.child("ingest");
  }

  private readonly onSettings = (s: Settings) => {
    if (this.stopped) return;
    if (this.loop?.interval === s.pollIntervalSeconds) return;
    void this.restart();
  };

  start(): void {
    this.stopped = false;
    if (this.life.signal.aborted) this.life = new AbortController();
    this.ctx.bus.on("settings", this.onSettings);
    void this.restart();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.life.abort();
    this.ctx.bus.off("settings", this.onSettings);
    await this.restarting;
    await this.stopLoop();
    const work = Promise.allSettled([...this.chains.values()]);
    await Promise.race([work, sleep(5000)]);
  }

  status(): IngestStatus {
    return {
      running: Boolean(this.loop) && !this.stopped,
      lastPullAt: this.lastPullAt,
      lastError: this.lastError,
    };
  }

  /** Process new history now, e.g. right after an agent sent mail. Never throws. */
  kick(accountId?: string): void {
    if (this.stopped) return;
    const ids = accountId ? [accountId] : allRows(this.ctx).filter(syncable).map((r) => r.id);
    for (const id of ids) {
      this.sync(id).catch((err: unknown) => this.log.warn("Sync failed", { accountId: id, error: errorMessage(err) }));
    }
  }

  /** Records the baseline historyId. Called by google.completeConnect. */
  async onAccountConnected(accountId: string): Promise<void> {
    const row = getRow(this.ctx, accountId);
    if (!row) return;
    const hadCursor = Boolean(row.history_id);
    if (!hadCursor) await this.enqueue(accountId, () => this.baseline(accountId));
    // A paused account stays paused (no sync) until it is resumed.
    if (row.status === "paused") return;
    // A reconnected account continues from its old cursor (or resyncs if that has expired).
    if (hadCursor) this.kick(accountId);
  }

  /** Bounded resync (recent messages), resets the history cursor, emits sync.gap. */
  async resync(accountId: string): Promise<Account> {
    const account = this.ctx.accounts.require(accountId);
    if (account.status === "needs_reauth") {
      throw conflict(`${account.email} needs to be reconnected before it can sync.`, "Reconnect it on the Accounts page.");
    }
    if (account.status === "paused") throw conflict(`${account.email} is paused.`, "Resume it first.");
    await this.enqueue(accountId, async () => {
      const row = getRow(this.ctx, accountId);
      if (row) await this.guard(row, () => boundedResync(this.ctx, row, "manual", this.life.signal), true);
    });
    return this.ctx.accounts.require(accountId);
  }

  async pause(accountId: string): Promise<Account> {
    const account = this.ctx.accounts.require(accountId);
    if (account.status === "needs_reauth") {
      throw conflict(`${account.email} needs to be reconnected; it isn't syncing anyway.`, "Reconnect it on the Accounts page.");
    }
    this.ctx.accounts.setStatus(accountId, "paused", null);
    return this.ctx.accounts.require(accountId);
  }

  async resume(accountId: string): Promise<Account> {
    const account = this.ctx.accounts.require(accountId);
    if (account.status === "needs_reauth") {
      throw conflict(`${account.email} needs to be reconnected.`, "Reconnect it on the Accounts page; that also resumes it.");
    }
    this.ctx.accounts.setStatus(accountId, "active", null);
    this.kick(accountId);
    return this.ctx.accounts.require(accountId);
  }

  // ───────────── Per-account work ─────────────

  private enqueue(accountId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(accountId) ?? Promise.resolve();
    const run = () => fn();
    const p = prev.then(run, run);
    const tail = p.catch(() => {});
    this.chains.set(accountId, tail);
    void tail.then(() => {
      if (this.chains.get(accountId) === tail) this.chains.delete(accountId);
    });
    return p;
  }

  /** Single-flight sync: concurrent requests while one is queued share it; one more runs after an in-progress sync. */
  sync(accountId: string): Promise<void> {
    const pending = this.pendingSync.get(accountId);
    if (pending) return pending;
    const p = this.enqueue(accountId, () => {
      this.pendingSync.delete(accountId);
      return this.syncOnce(accountId);
    });
    this.pendingSync.set(accountId, p);
    return p;
  }

  private async syncOnce(accountId: string): Promise<void> {
    const row = getRow(this.ctx, accountId);
    if (!row || !syncable(row) || this.stopped) return;
    if (!row.history_id) return this.guard(row, () => this.baseline(accountId));
    const signal = this.life.signal;
    await this.guard(row, async () => {
      try {
        await syncHistory(this.ctx, row, signal);
      } catch (err) {
        if (!(err instanceof GoogleApiError && err.status === 404)) throw err;
        this.log.warn("History cursor expired; running a bounded resync", { email: row.email });
        const fresh = getRow(this.ctx, accountId);
        if (fresh) await boundedResync(this.ctx, fresh, "history_expired", signal);
      }
    });
  }

  /**
   * Runs account work, recovering an "error" account on success and recording failures. Auth failures
   * are already handled by the token manager (needs_reauth + event), so they end quietly.
   */
  private async guard(row: AccountRow, fn: () => Promise<unknown>, rethrowAuth = false): Promise<void> {
    try {
      await fn();
      const fresh = getRow(this.ctx, row.id);
      if (fresh?.status === "error") this.ctx.accounts.setStatus(row.id, "active", null);
      else if (fresh?.last_error?.startsWith("Sync failed")) updateRow(this.ctx, row.id, { last_error: null }, true);
    } catch (err) {
      // Stopped mid-sync: the cursor already points at the last fully processed record.
      if (isAbortError(err) && this.stopped) return;
      if (err instanceof AccountNeedsReauthError) {
        if (rethrowAuth) throw conflict(err.message, "Reconnect it on the Accounts page.");
        return;
      }
      const fresh = getRow(this.ctx, row.id);
      if (fresh && syncable(fresh)) this.ctx.accounts.setStatus(row.id, "error", `Sync failed: ${errorMessage(err)}`);
      throw err;
    }
  }

  /** Baseline cursor at the mailbox's current position (no backfill). */
  private async baseline(accountId: string): Promise<void> {
    const profile = await this.ctx.google.gmail(accountId).getProfile();
    updateRow(this.ctx, accountId, { history_id: String(profile.historyId), last_sync_at: now() }, true);
  }

  private async syncAll(): Promise<string | null> {
    const rows = allRows(this.ctx).filter(syncable);
    const results = await Promise.allSettled(rows.map((r) => this.sync(r.id)));
    const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${rows[i]!.email}: ${errorMessage(r.reason)}`] : []));
    return failed.length ? failed.join("; ") : null;
  }

  // ───────────── Loops ─────────────

  private restart(): Promise<void> {
    this.restarting = this.restarting.then(async () => {
      await this.stopLoop();
      if (this.stopped) return;
      const interval = this.ctx.settings.get().pollIntervalSeconds;
      const ctrl = new AbortController();
      const done = this.pollLoop(ctrl.signal, interval).catch((err: unknown) => {
        this.lastError = errorMessage(err);
        this.log.error("Ingest loop crashed", { error: this.lastError });
      });
      this.loop = { interval, ctrl, done };
      // Nothing to report on a fresh install: say it once there is mail to ingest.
      this.log[allRows(this.ctx).length ? "info" : "debug"](`Ingest polling every ${interval} s`);
    });
    return this.restarting;
  }

  private async stopLoop(): Promise<void> {
    const loop = this.loop;
    this.loop = null;
    if (!loop) return;
    loop.ctrl.abort();
    await loop.done;
  }

  private async pollLoop(signal: AbortSignal, intervalSeconds: number): Promise<void> {
    while (!signal.aborted) {
      let err: string | null = null;
      await untilAborted(
        this.syncAll().then((e) => (err = e)),
        signal,
      );
      if (signal.aborted) break;
      this.lastPullAt = now();
      this.lastError = err;
      await sleep(intervalSeconds * 1000, signal);
    }
  }
}
