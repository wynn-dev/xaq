// Calendar sync storage (workstream A, migration 7): calendar_sync holds the per-calendar cursor,
// calendar_event_state the last seen version of each upcoming or recurring event, so
// sync can tell created / updated (and what changed) / cancelled apart and replay a 410 full resync as changes.

import { createHash } from "node:crypto";
import type { CalendarAccessRole, CalendarEventChange, CalendarEventSummary } from "../../shared/types.ts";
import { type Db, json, now } from "../db/index.ts";
import type { CalendarDateTimeRaw, CalendarEventRaw } from "../google/calendar.ts";

/** Ended events stay in state (and keep being reported on) for this long. */
export const KEEP_ENDED_MS = 86_400_000;

// ───────────── calendar_sync ─────────────

export interface CalendarSyncRow {
  account_id: string;
  calendar_id: string;
  name: string | null;
  access_role: CalendarAccessRole | null;
  is_primary: number;
  /** NULL = the next sync is a (baseline) full sync. */
  sync_token: string | null;
  /** When the last full sync finished; NULL before the first one (which reports nothing). */
  baseline_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  updated_at: string;
}

/** The account's synced calendars, primary first. */
export const syncRows = (db: Db, accountId: string): CalendarSyncRow[] =>
  db.all<CalendarSyncRow>("SELECT * FROM calendar_sync WHERE account_id = ? ORDER BY is_primary DESC, calendar_id", accountId);

export const getSyncRow = (db: Db, accountId: string, calendarId: string): CalendarSyncRow | undefined =>
  db.get<CalendarSyncRow>("SELECT * FROM calendar_sync WHERE account_id = ? AND calendar_id = ?", accountId, calendarId);

/** Adds a calendar to the synced set (or refreshes its name and role). True when it is new. */
export function upsertSyncCalendar(db: Db, accountId: string, c: { id: string; name: string; accessRole: CalendarAccessRole; primary: boolean }): boolean {
  const known = getSyncRow(db, accountId, c.id);
  db.run(
    `INSERT INTO calendar_sync (account_id, calendar_id, name, access_role, is_primary, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, calendar_id) DO UPDATE SET name = excluded.name, access_role = excluded.access_role, is_primary = excluded.is_primary,
       updated_at = CASE WHEN calendar_sync.name IS excluded.name AND calendar_sync.access_role IS excluded.access_role THEN calendar_sync.updated_at ELSE excluded.updated_at END`,
    accountId,
    c.id,
    c.name,
    c.accessRole,
    c.primary ? 1 : 0,
    now(),
  );
  return !known;
}

type SyncPatch = Partial<Omit<CalendarSyncRow, "account_id" | "calendar_id" | "updated_at">>;

export function updateSyncRow(db: Db, accountId: string, calendarId: string, patch: SyncPatch): void {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  db.run(
    `UPDATE calendar_sync SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE account_id = ? AND calendar_id = ?`,
    ...entries.map(([, v]) => v as string | number | null),
    now(),
    accountId,
    calendarId,
  );
}

/** Drops a calendar from the synced set, with its event state. */
export function deleteSyncCalendar(db: Db, accountId: string, calendarId: string): void {
  db.tx(() => {
    db.run("DELETE FROM calendar_event_state WHERE account_id = ? AND calendar_id = ?", accountId, calendarId);
    db.run("DELETE FROM calendar_sync WHERE account_id = ? AND calendar_id = ?", accountId, calendarId);
  });
}

// ───────────── Fingerprints ─────────────

/** Short digests of the material fields, per CalendarEventChange (description lives in description_hash). */
export type Fingerprint = Partial<Record<CalendarEventChange, string>>;

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
/** Same instant, whatever offset Google formats it with. */
const instant = (d: CalendarDateTimeRaw | undefined) => (d?.dateTime ? Date.parse(d.dateTime) : (d?.date ?? null));

export function fingerprint(e: CalendarEventRaw): Fingerprint {
  const people = (e.attendees ?? [])
    .filter((a) => a.email)
    .map((a) => ({ email: a.email!.toLowerCase(), optional: !!a.optional, response: a.responseStatus ?? "needsAction" }))
    .sort((a, b) => a.email.localeCompare(b.email));
  return {
    summary: digest(e.summary ?? ""),
    time: digest([instant(e.start), instant(e.end), e.start?.timeZone ?? null, e.end?.timeZone ?? null]),
    location: digest(e.location ?? ""),
    attendees: digest(people.map((p) => [p.email, p.optional])),
    responses: digest(people.map((p) => [p.email, p.response])),
    status: digest(e.status ?? "confirmed"),
    recurrence: digest(e.recurrence ?? []),
    conference: digest([e.hangoutLink ?? null, ...(e.conferenceData?.entryPoints ?? []).map((p) => p.uri ?? null)]),
  };
}

export const descriptionHash = (e: CalendarEventRaw): string | null => (e.description ? digest(e.description) : null);

// ───────────── calendar_event_state ─────────────

export interface EventState {
  eventId: string;
  fingerprint: Fingerprint;
  /** As last seen (reported on cancellation, when Google only sends the id). */
  summary: CalendarEventSummary;
  descriptionHash: string | null;
  /** null for an open-ended series (kept while the series lives). */
  endsAt: string | null;
}

interface StateRow {
  event_id: string;
  fingerprint: string;
  summary: string;
  description_hash: string | null;
  ends_at: string | null;
}

const toState = (r: StateRow): EventState => ({
  eventId: r.event_id,
  fingerprint: json.parse<Fingerprint>(r.fingerprint, {}),
  summary: json.parse<CalendarEventSummary>(r.summary, {} as CalendarEventSummary),
  descriptionHash: r.description_hash,
  endsAt: r.ends_at,
});

/** What changed since the stored version (empty when nothing material did). */
export function changesBetween(prev: EventState, e: CalendarEventRaw): CalendarEventChange[] {
  const next = fingerprint(e);
  const changed = (Object.keys(next) as CalendarEventChange[]).filter((k) => prev.fingerprint[k] !== next[k]);
  if (prev.descriptionHash !== descriptionHash(e)) changed.push("description");
  return changed;
}

const DAY = 86_400_000;
/** Upper bound of one RRULE period; units we don't bound (HOURLY, …) leave the series open-ended. */
const PERIOD_MS: Record<string, number> = { DAILY: DAY, WEEKLY: 7 * DAY, MONTHLY: 31 * DAY, YEARLY: 366 * DAY };

function icalTime(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(s.trim());
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : NaN;
}

const timeOf = (d: CalendarDateTimeRaw | undefined) => Date.parse(d?.dateTime ?? (d?.date ? `${d.date}T00:00:00Z` : ""));

/**
 * When a series' last occurrence ends at the latest (UNTIL or COUNT), or null when it never ends or can't be
 * bounded. An estimate: callers that act on a series having ended confirm it with Google.
 */
function seriesEnd(e: CalendarEventRaw): number | null {
  const rule = e.recurrence?.find((r) => /^RRULE:/i.test(r));
  if (!rule) return null;
  const p = Object.fromEntries(rule.slice(6).split(";").map((kv) => [kv.split("=")[0]!.toUpperCase(), kv.split("=")[1] ?? ""]));
  const start = timeOf(e.start);
  const length = Math.max(0, timeOf(e.end) - start) || 0;
  // A date-only UNTIL includes that whole day.
  if (p.UNTIL) return icalTime(p.UNTIL) + DAY + length;
  const period = PERIOD_MS[p.FREQ ?? ""];
  const count = Number(p.COUNT);
  if (!count || !period || Number.isNaN(start)) return null;
  const weekdays = p.FREQ === "WEEKLY" && p.BYDAY ? p.BYDAY.split(",").length : 0;
  // Other BY* parts (BYMONTHDAY, BYSETPOS, a monthly BYDAY, …) and starts on days some months or years lack
  // (Google skips those dates) can put occurrences arbitrarily late: no bound.
  if (Object.keys(p).some((k) => k.startsWith("BY") && !(k === "BYDAY" && weekdays))) return null;
  const at = new Date(start);
  if ((p.FREQ === "MONTHLY" && at.getUTCDate() > 28) || (p.FREQ === "YEARLY" && at.getUTCMonth() === 1 && at.getUTCDate() === 29)) return null;
  // The start is the first occurrence; weekday lists may need part of one more week.
  const periods = weekdays ? Math.ceil((count - 1) / weekdays) + 1 : count - 1;
  return start + periods * (Number(p.INTERVAL) || 1) * period + length;
}

/** When the event ends (ISO); for a series, when its last occurrence ends (null when it never ends). */
export function endsAt(e: CalendarEventRaw): string | null {
  if (e.recurrence?.length) {
    const end = seriesEnd(e);
    return end === null || Number.isNaN(end) ? null : new Date(end).toISOString();
  }
  const end = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : e.start?.dateTime ?? e.start?.date);
  const t = end ? Date.parse(end) : NaN;
  return new Date(Number.isNaN(t) ? Date.now() : t).toISOString();
}

/** Kept in state: open-ended series, and events (or finite series) that haven't ended more than KEEP_ENDED_MS ago. */
export function tracked(e: CalendarEventRaw, at = Date.now()): boolean {
  const end = endsAt(e);
  return end === null || Date.parse(end) >= at - KEEP_ENDED_MS;
}

export function eventStates(db: Db, accountId: string, calendarId: string): Map<string, EventState> {
  const rows = db.all<StateRow>("SELECT * FROM calendar_event_state WHERE account_id = ? AND calendar_id = ?", accountId, calendarId);
  return new Map(rows.map((r) => [r.event_id, toState(r)]));
}

export function getEventState(db: Db, accountId: string, calendarId: string, eventId: string): EventState | null {
  const r = db.get<StateRow>("SELECT * FROM calendar_event_state WHERE account_id = ? AND calendar_id = ? AND event_id = ?", accountId, calendarId, eventId);
  return r ? toState(r) : null;
}

export function putEventState(db: Db, accountId: string, calendarId: string, e: CalendarEventRaw, summary: CalendarEventSummary): void {
  db.run(
    `INSERT INTO calendar_event_state (account_id, calendar_id, event_id, fingerprint, summary, description_hash, ends_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, calendar_id, event_id) DO UPDATE SET fingerprint = excluded.fingerprint, summary = excluded.summary,
       description_hash = excluded.description_hash, ends_at = excluded.ends_at, updated_at = excluded.updated_at`,
    accountId,
    calendarId,
    e.id,
    json.str(fingerprint(e)),
    json.str(summary),
    descriptionHash(e),
    endsAt(e),
    now(),
  );
}

export function deleteEventState(db: Db, accountId: string, calendarId: string, eventId: string): void {
  db.run("DELETE FROM calendar_event_state WHERE account_id = ? AND calendar_id = ? AND event_id = ?", accountId, calendarId, eventId);
}

/** A new baseline: the calendar's state becomes exactly `events` (already filtered to tracked ones). */
export function replaceEventStates(db: Db, accountId: string, calendarId: string, events: { raw: CalendarEventRaw; summary: CalendarEventSummary }[]): void {
  db.tx(() => {
    db.run("DELETE FROM calendar_event_state WHERE account_id = ? AND calendar_id = ?", accountId, calendarId);
    for (const e of events) putEventState(db, accountId, calendarId, e.raw, e.summary);
  });
}

/** Maintenance: forgets events (and finite series) that ended before `before`; open-ended series are kept. */
export function pruneEventStates(db: Db, before: string): number {
  return db.run("DELETE FROM calendar_event_state WHERE ends_at IS NOT NULL AND ends_at < ?", before).changes;
}
