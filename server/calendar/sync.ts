// Calendar sync engine (workstream A). Polls events.list with syncToken per synced
// calendar, turns changes into calendar.* events via ctx.events.emit, keeps calendar_sync and
// calendar_event_state up to date and records account calendar status (accounts.calendar_*).
//
// An account syncs only while it has every CALENDAR_SCOPES scope, isn't paused or needs_reauth, and some
// enabled agent's grant on it has calendar.read: a mail-only install makes no Calendar API calls at all.

import type { CalendarEventSummary, CalendarEventType } from "../../shared/types.ts";
import type { BusEvents } from "../bus.ts";
import type { AppContext } from "../context.ts";
import { json, now } from "../db/index.ts";
import { type AccountRow, accountScopes, getRow, updateRow } from "../google/accounts.ts";
import { type CalendarClient, type CalendarDateTimeRaw, type CalendarEventRaw, classifyCalendarError } from "../google/calendar.ts";
import { sleep } from "../google/http.ts";
import { googleRuntime } from "../google/runtime.ts";
import { CALENDAR_SCOPES, hasScopes } from "../google/scopes.ts";
import { AccountNeedsReauthError, GoogleApiError } from "../google/types.ts";
import { cleanLine } from "../mail/content.ts";
import { errorMessage } from "../util/errors.ts";
import {
  type CalendarSyncRow,
  changesBetween,
  deleteEventState,
  deleteSyncCalendar,
  type EventState,
  eventStates,
  getEventState,
  getSyncRow,
  KEEP_ENDED_MS,
  putEventState,
  replaceEventStates,
  syncRows,
  tracked,
  updateSyncRow,
  upsertSyncCalendar,
} from "./state.ts";
import { noteCalendarApi } from "./setup.ts";
import { isInvitation, summarizeEvent } from "./summary.ts";
import type { CalendarService } from "./types.ts";

export type CalendarSync = Pick<CalendarService, "kick" | "syncAccount" | "start" | "stop">;

export interface CalendarSyncOptions {
  /**
   * The account's set of synced calendars changed (rows added or removed): push channels follow it (D).
   * Runs after the change, outside the pass; a throw or rejection is logged.
   */
  onSyncSetChanged?(accountId: string): void | Promise<void>;
  /** Tests: the poll interval (default Settings.calendarPollSeconds) and how often the loop looks for due accounts. */
  timing?: { pollMs?: number; tickMs?: number };
}

/** The calendar list (which calendars sync) is re-read this often, and on kick. */
export const LIST_REFRESH_MS = 15 * 60_000;
/** Calendars with a verified push channel are still polled this often, in case a notification was lost. */
export const PUSH_SAFETY_NET_MS = 15 * 60_000;
/** Events created this long before the previous sync still count as new (a sync racing the creation, clock skew). */
const NEW_GRACE_MS = 5 * 60_000;
const PAGE_SIZE = 1000;
/** How often the loop looks for accounts that are due. */
const TICK_MS = 1000;
/** Failing accounts back off exponentially between polls, up to this (or the poll interval, if longer). */
export const MAX_POLL_BACKOFF_MS = 30 * 60_000;

/** Delay before the next poll of an account after `failures` failed passes in a row. */
export const pollBackoffMs = (intervalMs: number, failures: number): number =>
  Math.max(intervalMs, Math.min(MAX_POLL_BACKOFF_MS, intervalMs * 2 ** failures));

/**
 * Accounts some enabled agent reads calendars on (calendar.read), with the union of those grants' calendar
 * scopes, lowercased (null = every calendar).
 */
function readers(ctx: Pick<AppContext, "db">): Map<string, Set<string> | null> {
  const rows = ctx.db.all<{ account_id: string; calendar_scope: string | null }>(
    `SELECT g.account_id, g.calendar_scope FROM grants g JOIN agents a ON a.id = g.agent_id
     WHERE a.disabled = 0 AND EXISTS (SELECT 1 FROM json_each(g.capabilities) WHERE value = 'calendar.read')`,
  );
  const out = new Map<string, Set<string> | null>();
  for (const r of rows) {
    const scope = r.calendar_scope === null ? null : json.parse<string[]>(r.calendar_scope, []).map((id) => id.toLowerCase());
    const prev = out.get(r.account_id);
    if (prev === null || scope === null) out.set(r.account_id, null);
    else out.set(r.account_id, new Set([...(prev ?? []), ...scope]));
  }
  return out;
}

/** Calendar scopes granted and the account not paused or waiting for a reconnect. */
const syncable = (r: AccountRow) => (r.status === "active" || r.status === "error") && hasScopes(accountScopes(r), CALENDAR_SCOPES);

/** A pass over one account; requests made before it starts merge into it. */
interface Pass {
  /** null = every synced calendar. */
  calendars: Set<string> | null;
  /** Re-read the calendar list first. */
  refresh: boolean;
  /** Sync push-covered calendars too (kicks, "Sync now"). */
  force: boolean;
}

export function createCalendarSync(ctx: AppContext, opts: CalendarSyncOptions = {}): CalendarSync {
  return new Sync(ctx, opts);
}

class Sync implements CalendarSync {
  private readonly log;
  /** Started (polling, kicks honored). syncAccount works either way. */
  private running = false;
  /** stop() was called: passes in progress end after the current request. */
  private stopping = false;
  private loop: { ctrl: AbortController; done: Promise<void> } | null = null;
  /** Tail of the per-account work queue: passes never overlap for one account. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, { pass: Pass; done: Promise<void> }>();
  /** accountId → when its calendar list was last read. */
  private readonly listedAt = new Map<string, number>();
  /** accountId → failed passes in a row and when the loop polls it next. */
  private readonly health = new Map<string, { failures: number; nextAt: number }>();
  /** Accounts with a loop poll queued or running. */
  private readonly polling = new Set<string>();

  constructor(
    private readonly ctx: AppContext,
    private readonly opts: CalendarSyncOptions,
  ) {
    this.log = ctx.log.child("calendar");
  }

  /** A shorter poll interval applies at once to accounts that aren't backing off. */
  private readonly onSettings = () => {
    const next = Date.now() + this.pollMs();
    for (const h of this.health.values()) if (!h.failures) h.nextAt = Math.min(h.nextAt, next);
  };

  /** Grants changed: start (or stop) syncing the accounts they read. */
  private readonly onAgent = (e: BusEvents["agent"][0]) => {
    if (e.reason !== "key_rotated") this.kick();
  };

  start(): void {
    this.running = true;
    this.stopping = false;
    this.ctx.bus.on("settings", this.onSettings);
    this.ctx.bus.on("agent", this.onAgent);
    const ctrl = new AbortController();
    this.loop = { ctrl, done: this.run(ctrl.signal) };
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    this.ctx.bus.off("settings", this.onSettings);
    this.ctx.bus.off("agent", this.onAgent);
    const loop = this.loop;
    this.loop = null;
    loop?.ctrl.abort();
    await loop?.done;
    await Promise.race([Promise.allSettled([...this.chains.values()]), sleep(5000)]);
  }

  kick(accountId?: string, calendarId?: string): void {
    if (!this.running) return;
    const ids = accountId ? [accountId] : [...new Set([...readers(this.ctx).keys(), ...this.syncedAccounts()])];
    for (const id of ids) {
      this.schedule(id, { calendars: calendarId ? new Set([calendarId]) : null, refresh: !calendarId, force: true }).catch((err: unknown) =>
        this.log.debug("Calendar sync failed", { accountId: id, error: errorMessage(err) }),
      );
    }
  }

  syncAccount(accountId: string): Promise<void> {
    return this.schedule(accountId, { calendars: null, refresh: true, force: true });
  }

  // ───────────── Scheduling ─────────────

  private syncedAccounts(): string[] {
    return this.ctx.db.all<{ account_id: string }>("SELECT DISTINCT account_id FROM calendar_sync").map((r) => r.account_id);
  }

  private enqueue(accountId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(accountId) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.catch(() => {});
    this.chains.set(accountId, tail);
    void tail.then(() => {
      if (this.chains.get(accountId) === tail) this.chains.delete(accountId);
    });
    return p;
  }

  /** Coalesces with a queued, not yet started pass for the account (one more runs after a pass in progress). */
  private schedule(accountId: string, want: Pass): Promise<void> {
    const queued = this.pending.get(accountId);
    if (queued) {
      const p = queued.pass;
      p.calendars = p.calendars === null || want.calendars === null ? null : new Set([...p.calendars, ...want.calendars]);
      p.refresh ||= want.refresh;
      p.force ||= want.force;
      return queued.done;
    }
    const pass: Pass = { ...want, calendars: want.calendars && new Set(want.calendars) };
    const done = this.enqueue(accountId, () => {
      this.pending.delete(accountId);
      return this.pass(accountId, pass);
    });
    this.pending.set(accountId, { pass, done });
    return done;
  }

  private pollMs(): number {
    return this.opts.timing?.pollMs ?? this.ctx.settings.get().calendarPollSeconds * 1000;
  }

  /**
   * Polls each account when it is due, on its own: a slow or failing account never holds up the others.
   * Accounts nobody reads any more get one more pass, which forgets them.
   */
  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const t = Date.now();
      for (const id of new Set([...readers(this.ctx).keys(), ...this.syncedAccounts()])) {
        if (this.polling.has(id) || (this.health.get(id)?.nextAt ?? 0) > t) continue;
        this.polling.add(id);
        void this.schedule(id, { calendars: null, refresh: false, force: false })
          .catch(() => {})
          .finally(() => this.polling.delete(id));
      }
      await sleep(this.opts.timing?.tickMs ?? TICK_MS, signal);
    }
  }

  /** Next poll: one interval after a success; after failures, exponentially later (or when Google says to retry). */
  private noteResult(accountId: string, err: unknown): void {
    const interval = this.pollMs();
    if (!err) {
      this.health.set(accountId, { failures: 0, nextAt: Date.now() + interval });
      return;
    }
    const failures = (this.health.get(accountId)?.failures ?? 0) + 1;
    const retryAfter = err instanceof GoogleApiError ? (err.details.retryAfterMs ?? 0) : 0;
    this.health.set(accountId, { failures, nextAt: Date.now() + Math.max(pollBackoffMs(interval, failures), retryAfter) });
  }

  /** Tells push the synced set changed, outside the pass (its failures are logged, never thrown). */
  private syncSetChanged(accountId: string): void {
    const hook = this.opts.onSyncSetChanged;
    if (!hook) return;
    Promise.resolve()
      .then(() => hook(accountId))
      .catch((err: unknown) => this.log.warn("Updating calendar push channels failed", { accountId, error: errorMessage(err) }));
  }

  // ───────────── One account ─────────────

  private async pass(accountId: string, p: Pass): Promise<void> {
    try {
      await this.passOnce(accountId, p);
      this.noteResult(accountId, null);
    } catch (err) {
      this.noteResult(accountId, err);
      throw err;
    }
  }

  private async passOnce(accountId: string, p: Pass): Promise<void> {
    const row = getRow(this.ctx, accountId);
    if (!row) return;
    const scope = readers(this.ctx).get(accountId);
    if (scope === undefined) return this.forget(accountId);
    if (!syncable(row)) return;
    const client = this.ctx.google.calendar(accountId);
    try {
      const listed = this.listedAt.get(accountId);
      if (p.refresh || listed === undefined || Date.now() - listed > LIST_REFRESH_MS) await this.refreshList(row, client, scope);
      const failures: unknown[] = [];
      for (const { calendar_id: calendarId } of syncRows(this.ctx.db, accountId)) {
        if (this.stopping) return;
        // Re-read: a refresh below may have dropped it.
        const cal = getSyncRow(this.ctx.db, accountId, calendarId);
        if (!cal || (p.calendars && !p.calendars.has(calendarId))) continue;
        if (!p.force && pushCovered(cal)) continue;
        try {
          await this.syncCalendar(row, client, cal);
        } catch (err) {
          if (err instanceof GoogleApiError && err.status === 404) {
            // Deleted or unshared since the list was read: re-read it now, which drops the calendar.
            await this.refreshList(row, client, scope);
            if (!getSyncRow(this.ctx.db, accountId, calendarId)) continue;
          }
          // Account-wide problems end the pass; others are recorded per calendar and the rest still sync.
          if (err instanceof AccountNeedsReauthError || classifyCalendarError(err) === "api_disabled" || classifyCalendarError(err) === "scope_missing") throw err;
          updateSyncRow(this.ctx.db, accountId, cal.calendar_id, { last_error: errorMessage(err) });
          failures.push(err);
        }
      }
      if (failures.length) throw failures[0];
      this.recordSuccess(accountId);
    } catch (err) {
      await this.recordFailure(row, err);
      throw err;
    }
  }

  /** Synced calendars: owner/writer entries of the calendar list that some reading grant's scope covers. */
  private async refreshList(row: AccountRow, client: CalendarClient, scope: Set<string> | null): Promise<void> {
    const entries = await client.listCalendars();
    const wanted = entries.filter((e) => (e.accessRole === "owner" || e.accessRole === "writer") && (scope === null || scope.has(e.id.toLowerCase())));
    let changed = false;
    for (const e of wanted) {
      const name = cleanLine(e.summaryOverride || e.summary || e.id, 200);
      if (upsertSyncCalendar(this.ctx.db, row.id, { id: e.id, name, accessRole: e.accessRole, primary: !!e.primary })) changed = true;
    }
    const keep = new Set(wanted.map((e) => e.id));
    for (const cal of syncRows(this.ctx.db, row.id)) {
      if (keep.has(cal.calendar_id)) continue;
      await this.removeCalendar(cal);
      changed = true;
    }
    this.listedAt.set(row.id, Date.now());
    if (changed) this.syncSetChanged(row.id);
  }

  /** No grant reads the account any more: drop its calendars (a later grant starts from a fresh baseline). */
  private async forget(accountId: string): Promise<void> {
    const rows = syncRows(this.ctx.db, accountId);
    this.listedAt.delete(accountId);
    if (!rows.length) return;
    for (const cal of rows) await this.removeCalendar(cal);
    this.syncSetChanged(accountId);
  }

  private async removeCalendar(cal: CalendarSyncRow): Promise<void> {
    if (cal.channel_id && cal.channel_resource_id) {
      await this.ctx.google
        .calendar(cal.account_id)
        .stopChannel({ id: cal.channel_id, resourceId: cal.channel_resource_id })
        .catch((err: unknown) => this.log.debug("Could not stop a calendar push channel", { calendarId: cal.calendar_id, error: errorMessage(err) }));
    }
    deleteSyncCalendar(this.ctx.db, cal.account_id, cal.calendar_id);
  }

  // ───────────── One calendar ─────────────

  private async syncCalendar(row: AccountRow, client: CalendarClient, cal: CalendarSyncRow): Promise<void> {
    if (cal.sync_token && cal.baseline_at) {
      try {
        const { items, syncToken } = await listAll(client, cal.calendar_id, { syncToken: cal.sync_token });
        const since = cal.last_sync_at ?? cal.baseline_at;
        for (const raw of items) this.apply(row.id, cal, raw, getEventState(this.ctx.db, row.id, cal.calendar_id, raw.id), since);
        updateSyncRow(this.ctx.db, row.id, cal.calendar_id, { sync_token: syncToken, last_sync_at: now(), last_error: null });
        return;
      } catch (err) {
        if (classifyCalendarError(err) !== "sync_token_expired") throw err;
        this.log.info("Calendar sync token expired; running a full resync", { email: row.email, calendarId: cal.calendar_id });
      }
    }
    await this.fullSync(row.id, client, cal);
  }

  /**
   * Lists the calendar from a day ago on and makes that the new baseline. The first one reports nothing
   * (like Gmail's baseline historyId); after a 410 the listing is diffed against the stored state so changes
   * since the last sync are still reported (gone → cancelled, changed → updated, new → created or invitation).
   */
  private async fullSync(accountId: string, client: CalendarClient, cal: CalendarSyncRow): Promise<void> {
    const timeMin = new Date(Date.now() - KEEP_ENDED_MS).toISOString();
    const { items, syncToken } = await listAll(client, cal.calendar_id, { timeMin });
    if (cal.baseline_at) {
      const since = cal.last_sync_at ?? cal.baseline_at;
      const known = eventStates(this.ctx.db, accountId, cal.calendar_id);
      for (const raw of items) {
        const prev = known.get(raw.id) ?? null;
        // Unknown and not kept (or an occurrence cancelled before the last sync): history, not news.
        const stale = raw.status === "cancelled" ? !(Date.parse(raw.updated ?? "") >= Date.parse(since) - NEW_GRACE_MS) : !tracked(raw);
        if (prev || !stale) this.apply(accountId, cal, raw, prev, since);
      }
      const listed = new Set(items.map((e) => e.id));
      for (const [id, prev] of known) {
        // Missing from the listing: deleted, unless it simply ended before the listed window.
        if (listed.has(id) || (prev.endsAt !== null && prev.endsAt < timeMin)) continue;
        // A series' end is only an estimate: ask Google whether it was deleted or just finished.
        if (prev.summary.recurring && !(await seriesDeleted(client, cal.calendar_id, id))) continue;
        this.apply(accountId, cal, { id, status: "cancelled" }, prev, since);
      }
    }
    const at = Date.now();
    const keep = items.filter((e) => e.status !== "cancelled" && tracked(e, at)).map((raw) => ({ raw, summary: summarizeEvent(raw, cal.calendar_id) }));
    replaceEventStates(this.ctx.db, accountId, cal.calendar_id, keep);
    const stamp = now();
    updateSyncRow(this.ctx.db, accountId, cal.calendar_id, { sync_token: syncToken, baseline_at: stamp, last_sync_at: stamp, last_error: null });
  }

  /**
   * One changed event: emit what it means, then store what was seen.
   * `since` is the previous successful sync: unknown events created after it (less the grace) are new.
   */
  private apply(accountId: string, cal: CalendarSyncRow, raw: CalendarEventRaw, prev: EventState | null, since: string | null): void {
    const calendarId = cal.calendar_id;
    const emit = (type: CalendarEventType, summary: CalendarEventSummary, detail?: Record<string, unknown>, version?: string | null) =>
      this.ctx.events.emit({
        type,
        accountId,
        message: null,
        calendarEvent: summary,
        detail,
        dedupeKey:
          type === "calendar.invitation_received"
            ? `${accountId}:${calendarId}:${raw.id}:invitation`
            : `${accountId}:${calendarId}:${raw.id}:${type}:${version ?? raw.updated ?? raw.etag ?? ""}`,
      });

    if (raw.status === "cancelled") {
      // Deleted or cancelled; Google may send only the id, so the stored version is what gets reported.
      if (prev) {
        emit("calendar.event_cancelled", { ...prev.summary, status: "cancelled" }, { wasOrganizer: prev.summary.organizerSelf }, raw.updated ?? raw.etag ?? prev.summary.updated);
        deleteEventState(this.ctx.db, accountId, calendarId, raw.id);
        return;
      }
      // One occurrence of a known series: `<series>_<time>` with recurringEventId and originalStartTime.
      const series = raw.recurringEventId ? getEventState(this.ctx.db, accountId, calendarId, raw.recurringEventId) : null;
      const times = series && raw.originalStartTime ? occurrenceTimes(series.summary, raw.originalStartTime) : null;
      if (!series || !times || Date.parse(times.end) < Date.now() - KEEP_ENDED_MS) return;
      const occurrence: CalendarEventSummary = { ...series.summary, ...times, id: raw.id, recurringEventId: series.eventId, recurring: false, status: "cancelled" };
      emit("calendar.event_cancelled", occurrence, { wasOrganizer: series.summary.organizerSelf }, raw.updated ?? raw.etag);
      return;
    }

    const summary = summarizeEvent(raw, calendarId);
    const keep = tracked(raw);
    if (!prev) {
      const isNew = Date.parse(raw.created ?? "") >= Date.parse(since ?? "") - NEW_GRACE_MS;
      // Invitations first: being added to a meeting created long ago is the usual case.
      if (isInvitation(raw) && (isNew || keep)) emit("calendar.invitation_received", summary);
      // Keyed by creation time: an event is created once, however often it is edited before it's kept.
      else if (isNew) emit("calendar.event_created", summary, undefined, raw.created);
      else if (keep) emit("calendar.event_updated", summary, { changes: null });
    } else {
      const changes = changesBetween(prev, raw);
      if (changes.length) {
        if (prev.summary.selfResponse === null && isInvitation(raw)) emit("calendar.invitation_received", summary);
        else emit("calendar.event_updated", summary, { changes });
      }
    }
    if (keep) putEventState(this.ctx.db, accountId, calendarId, raw, summary);
    else if (prev) deleteEventState(this.ctx.db, accountId, calendarId, raw.id);
  }

  // ───────────── Account status ─────────────

  private setStatus(accountId: string, status: AccountRow["calendar_status"], error: string | null, extra: { calendar_synced_at?: string } = {}): void {
    const row = getRow(this.ctx, accountId);
    if (!row) return;
    const changed = row.calendar_status !== status || row.calendar_error !== error;
    updateRow(this.ctx, accountId, { calendar_status: status, calendar_error: error, ...extra }, changed);
    if (changed && error) this.log.warn("Calendar sync failed", { email: row.email, error });
    else if (changed && row.calendar_error) this.log.info("Calendar sync recovered", { email: row.email });
  }

  private recordSuccess(accountId: string): void {
    this.setStatus(accountId, null, null, { calendar_synced_at: now() });
    this.noteApi("enabled");
  }

  /** Records why the pass failed on the account (Account.calendar). Auth failures are the token manager's. */
  private async recordFailure(row: AccountRow, err: unknown): Promise<void> {
    if (err instanceof AccountNeedsReauthError) return;
    switch (classifyCalendarError(err)) {
      case "api_disabled":
        this.setStatus(row.id, "api_disabled", errorMessage(err));
        this.noteApi("disabled", err as GoogleApiError);
        return;
      case "scope_missing": {
        // A refresh re-reads the granted scopes (the token response's `scope`); the status then derives from them.
        await googleRuntime(this.ctx)
          .tokens.accessToken(row.id, { force: true })
          .catch(() => {});
        const fresh = getRow(this.ctx, row.id);
        if (fresh && hasScopes(accountScopes(fresh), CALENDAR_SCOPES)) {
          this.setStatus(row.id, "error", `Google says the Calendar permissions are missing: ${errorMessage(err)}`);
        } else this.setStatus(row.id, null, null);
        return;
      }
      default:
        this.setStatus(row.id, "error", `Calendar sync failed: ${errorMessage(err)}`);
    }
  }

  /**
   * CalendarSetupState.api as last observed, shared with setup's probes: "enabled" also clears api_disabled
   * on every account (the API is per project), "disabled" keeps Google's activationUrl.
   */
  private noteApi(state: "enabled" | "disabled", err: GoogleApiError | null = null): void {
    noteCalendarApi(this.ctx, state, err);
  }
}

async function seriesDeleted(client: CalendarClient, calendarId: string, eventId: string): Promise<boolean> {
  try {
    return (await client.getEvent(calendarId, eventId)).status === "cancelled";
  } catch (err) {
    if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) return true;
    throw err;
  }
}

/** Start and end of one occurrence of a series (all-day stays YYYY-MM-DD), from its original start. */
function occurrenceTimes(series: CalendarEventSummary, original: CalendarDateTimeRaw): { start: string; end: string } | null {
  const start = original.dateTime ?? original.date;
  const at = Date.parse(original.dateTime ?? `${original.date}T00:00:00Z`);
  const length = Date.parse(series.end) - Date.parse(series.start);
  if (!start || Number.isNaN(at) || Number.isNaN(length)) return null;
  const end = new Date(at + length).toISOString();
  return { start, end: original.date ? end.slice(0, 10) : end };
}

/** A verified, unexpired push channel that synced recently: polling can wait (PUSH_SAFETY_NET_MS). */
function pushCovered(cal: CalendarSyncRow): boolean {
  if (!cal.channel_verified_at || !cal.channel_expires_at || Date.parse(cal.channel_expires_at) <= Date.now()) return false;
  return !!cal.last_sync_at && Date.now() - Date.parse(cal.last_sync_at) < PUSH_SAFETY_NET_MS;
}

/** Every page of events.list (singleEvents=false, as the sync token requires). */
async function listAll(client: CalendarClient, calendarId: string, p: { syncToken?: string; timeMin?: string }): Promise<{ items: CalendarEventRaw[]; syncToken: string }> {
  const items: CalendarEventRaw[] = [];
  let pageToken: string | undefined;
  let syncToken: string | null = null;
  do {
    const r = await client.listEvents(calendarId, { ...p, pageToken, maxResults: PAGE_SIZE });
    items.push(...r.items);
    pageToken = r.nextPageToken ?? undefined;
    syncToken = r.nextSyncToken;
  } while (pageToken);
  if (!syncToken) throw new GoogleApiError(502, "Google Calendar returned no sync token", "invalid_response");
  return { items, syncToken };
}
