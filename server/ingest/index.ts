import { type Account, GMAIL_WATCH_ERROR, type IngestMode, type IngestStatus, type Settings } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { type AccountRow, allRows, getRow, updateRow } from "../google/accounts.ts";
import { isAbortError, sleep } from "../google/http.ts";
import { ackPubsub, explainPubsubError, type PulledMessage, pubsubPrincipal, pullPubsub, readPubsub, writePubsub } from "../google/pubsub.ts";
import { AccountNeedsReauthError, GoogleApiError } from "../google/types.ts";
import { conflict, errorMessage } from "../util/errors.ts";
import { boundedResync, syncHistory } from "./sync.ts";
import { ensureWatches, startWatch, stopAllWatches, stopWatch } from "./watch.ts";

/** Pub/Sub mode still syncs every account this often, in case a notification was lost. */
const SAFETY_NET_MS = 5 * 60_000;
const WATCH_CHECK_MS = 3600_000;
const MAX_PULL_BACKOFF_MS = 60_000;

const syncable = (r: Pick<AccountRow, "status">) => r.status === "active" || r.status === "error";

function historyGte(a: string | null, b: string): boolean {
  if (!a) return false;
  try {
    return BigInt(a) >= BigInt(b);
  } catch {
    return false;
  }
}

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
  mode: IngestMode;
  interval: number;
  /** Pub/Sub mode selected but not provisioned: polling until it is. */
  fallback: boolean;
  ctrl: AbortController;
  done: Promise<void>;
}

/** Gmail ingest: polling or Pub/Sub, per-account history syncs, resyncs, pause and resume. */
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
  /** Consecutive Pub/Sub pull failures (reset when an account becomes active). */
  private pullFailures = 0;
  /** Ends the current pull-retry wait early. */
  private wakePull: (() => void) | null = null;
  private readonly statuses = new Map<string, string>();
  private lastError: string | null = null;

  constructor(private readonly ctx: AppContext) {
    this.log = ctx.log.child("ingest");
  }

  private readonly onSettings = (s: Settings) => {
    if (this.stopped) return;
    const l = this.loop;
    const unchanged = l && l.mode === s.ingestMode && l.interval === s.pollIntervalSeconds;
    if (unchanged && !(l.fallback && readPubsub(this.ctx).subscription)) return;
    void this.restart();
  };

  /** A (re)activated account may be the Pub/Sub principal: retry the pull right away. */
  private readonly onAccount = (a: Account) => {
    const prev = this.statuses.get(a.id);
    this.statuses.set(a.id, a.status);
    if (a.status === "active" && prev !== "active") {
      this.pullFailures = 0;
      this.wakePull?.();
    }
  };

  start(): void {
    this.stopped = false;
    if (this.life.signal.aborted) this.life = new AbortController();
    for (const r of allRows(this.ctx)) this.statuses.set(r.id, r.status);
    this.ctx.bus.on("settings", this.onSettings);
    this.ctx.bus.on("account", this.onAccount);
    void this.restart();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.life.abort();
    this.ctx.bus.off("settings", this.onSettings);
    this.ctx.bus.off("account", this.onAccount);
    await this.restarting;
    await this.stopLoop();
    const work = Promise.allSettled([...this.chains.values()]);
    await Promise.race([work, sleep(5000)]);
  }

  status(): IngestStatus {
    return {
      mode: this.ctx.settings.get().ingestMode,
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

  /** Records the baseline historyId and (in pubsub mode) starts the watch. Called by google.completeConnect. */
  async onAccountConnected(accountId: string): Promise<void> {
    const row = getRow(this.ctx, accountId);
    if (!row) return;
    const hadCursor = Boolean(row.history_id);
    if (!hadCursor) await this.enqueue(accountId, () => this.baseline(accountId));
    // A paused account stays paused (no watch, no sync) until it is resumed.
    if (row.status === "paused") return;
    const topic = readPubsub(this.ctx).topic;
    if (this.ctx.settings.get().ingestMode === "pubsub" && topic) await startWatch(this.ctx, accountId, topic);
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
    await stopWatch(this.ctx, accountId);
    return this.ctx.accounts.require(accountId);
  }

  async resume(accountId: string): Promise<Account> {
    const account = this.ctx.accounts.require(accountId);
    if (account.status === "needs_reauth") {
      throw conflict(`${account.email} needs to be reconnected.`, "Reconnect it on the Accounts page; that also resumes it.");
    }
    this.ctx.accounts.setStatus(accountId, "active", null);
    const topic = readPubsub(this.ctx).topic;
    if (this.ctx.settings.get().ingestMode === "pubsub" && topic) {
      await startWatch(this.ctx, accountId, topic).catch((err: unknown) => {
        updateRow(this.ctx, accountId, { last_error: `${GMAIL_WATCH_ERROR}: ${errorMessage(err)}` }, true);
      });
    }
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
      const s = this.ctx.settings.get();
      const fallback = s.ingestMode === "pubsub" && !readPubsub(this.ctx).subscription;
      const ctrl = new AbortController();
      const run = s.ingestMode === "pubsub" ? this.pubsubLoop(ctrl.signal) : this.pollLoop(ctrl.signal, s.pollIntervalSeconds);
      const done = run.catch((err: unknown) => {
        this.lastError = errorMessage(err);
        this.log.error("Ingest loop crashed", { error: this.lastError });
      });
      this.loop = { mode: s.ingestMode, interval: s.pollIntervalSeconds, fallback, ctrl, done };
      // Nothing to report on a fresh install: say it once there is mail to ingest.
      this.log[allRows(this.ctx).length ? "info" : "debug"](`Ingest running in ${s.ingestMode} mode`);
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

  private async pollLoop(signal: AbortSignal, intervalSeconds: number, note: string | null = null): Promise<void> {
    if (!note && allRows(this.ctx).some((r) => r.watch_expires_at)) await stopAllWatches(this.ctx);
    while (!signal.aborted) {
      let err: string | null = null;
      await untilAborted(
        this.syncAll().then((e) => (err = e)),
        signal,
      );
      if (signal.aborted) break;
      this.lastPullAt = now();
      this.lastError = note ?? err;
      await sleep(intervalSeconds * 1000, signal);
    }
  }

  private async pubsubLoop(signal: AbortSignal): Promise<void> {
    if (!readPubsub(this.ctx).subscription) {
      const interval = this.ctx.settings.get().pollIntervalSeconds;
      return this.pollLoop(signal, interval, "Pub/Sub isn't provisioned yet, so ingest is polling instead.");
    }
    const background = [
      // Also re-arms watches that expired while the daemon was offline.
      this.every(signal, WATCH_CHECK_MS, () => ensureWatches(this.ctx, { signal }), true),
      this.every(signal, SAFETY_NET_MS, () => this.syncAll(), true),
    ];
    this.pullFailures = 0;
    while (!signal.aborted) {
      try {
        const msgs = await pullPubsub(this.ctx, { signal });
        this.lastPullAt = now();
        this.lastError = null;
        this.pullFailures = 0;
        if (msgs.length) await this.handleNotifications(msgs);
      } catch (err) {
        if (signal.aborted) break;
        if (isAbortError(err)) continue; // long-poll timeout
        const failures = ++this.pullFailures;
        const { message, hint } = explainPubsubError(err, this.ctx.settings.getState("google.client")?.projectId ?? null, pubsubPrincipal(this.ctx)?.email);
        this.lastError = `Pub/Sub pull failed: ${message} ${hint}`.trim();
        writePubsub(this.ctx, { lastError: this.lastError });
        if (failures === 1) this.log.warn("Pub/Sub pull failed; polling until it recovers", { error: errorMessage(err) });
        // Keep mail flowing while the pull is broken: poll history at the poll interval, retrying the
        // pull with backoff (or immediately once an account is reconnected).
        await untilAborted(this.syncAll(), signal);
        const pollMs = this.ctx.settings.get().pollIntervalSeconds * 1000;
        const wake = new AbortController();
        this.wakePull = () => wake.abort();
        if (this.pullFailures > 0) await sleep(Math.min(MAX_PULL_BACKOFF_MS, pollMs, 1000 * 2 ** failures), AbortSignal.any([signal, wake.signal]));
        this.wakePull = null;
      }
    }
    await Promise.all(background);
  }

  /** Runs fn every `ms` until aborted (optionally once right away). Errors are logged. */
  private async every(signal: AbortSignal, ms: number, fn: () => Promise<unknown>, immediately = false): Promise<void> {
    if (!immediately) await sleep(ms, signal);
    while (!signal.aborted) {
      await untilAborted(
        fn().catch((err: unknown) => this.log.warn("Background ingest task failed", { error: errorMessage(err) })),
        signal,
      );
      await sleep(ms, signal);
    }
  }

  /** Syncs each notified account, then acks its messages (unacked ones are redelivered after a failure). */
  private async handleNotifications(msgs: PulledMessage[]): Promise<void> {
    const byAccount = new Map<string, { row: AccountRow | null; ackIds: string[]; historyId: string }>();
    const ackNow: string[] = [];
    for (const m of msgs) {
      const account = m.notification ? this.ctx.accounts.getByEmail(m.notification.emailAddress) : null;
      const row = account ? getRow(this.ctx, account.id) : undefined;
      if (!row || !syncable(row)) {
        ackNow.push(m.ackId);
        continue;
      }
      const entry = byAccount.get(row.id) ?? { row, ackIds: [], historyId: "0" };
      entry.ackIds.push(m.ackId);
      if (!historyGte(entry.historyId, m.notification!.historyId)) entry.historyId = m.notification!.historyId;
      byAccount.set(row.id, entry);
    }
    await Promise.all(
      [...byAccount.entries()].map(async ([id, { row, ackIds, historyId }]) => {
        try {
          if (!historyGte(row!.history_id, historyId)) await this.sync(id);
          ackNow.push(...ackIds);
        } catch (err) {
          this.log.warn("Sync after notification failed; Pub/Sub will redeliver", { email: row!.email, error: errorMessage(err) });
        }
      }),
    );
    await ackPubsub(this.ctx, ackNow).catch((err: unknown) => this.log.warn("Pub/Sub ack failed", { error: errorMessage(err) }));
  }
}
