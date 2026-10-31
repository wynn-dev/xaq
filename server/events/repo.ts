import type { CalendarEventSummary, EventType, MailEvent, MessageSummary } from "../../shared/types.ts";
import { type Db, json } from "../db/index.ts";
import { badRequest } from "../util/errors.ts";
import type { StoredEvent } from "./types.ts";

export interface EventRow {
  seq: number;
  id: string;
  type: EventType;
  /** '' on connection events. */
  account_id: string;
  /** Connection events only (migration 8). */
  connection_id: string | null;
  account_email: string | null;
  label_ids: string;
  message: string | null;
  changed_label_ids: string | null;
  detail: string | null;
  /** JSON CalendarEventSummary (migration 7). */
  calendar_event: string | null;
  created_at: string;
}

/** Joins the account email live; deleted accounts fall back to detail.email. */
export const EVENT_SELECT = `SELECT e.seq, e.id, e.type, e.account_id, a.email AS account_email, e.label_ids, e.message,
  e.changed_label_ids, e.detail, e.calendar_event, e.connection_id, e.created_at FROM events e LEFT JOIN accounts a ON a.id = e.account_id`;

export function toStoredEvent(r: EventRow): StoredEvent {
  const detail = json.parse<Record<string, unknown> | null>(r.detail, null);
  const changed = json.parse<string[] | null>(r.changed_label_ids, null);
  const calendarEvent = json.parse<CalendarEventSummary | null>(r.calendar_event, null);
  const fallbackEmail = typeof detail?.email === "string" ? detail.email : "";
  return {
    id: r.id,
    seq: r.seq,
    type: r.type,
    accountId: r.account_id,
    accountEmail: r.connection_id ? "" : (r.account_email ?? fallbackEmail),
    ...(r.connection_id ? { connectionId: r.connection_id } : {}),
    message: json.parse<MessageSummary | null>(r.message, null),
    ...(calendarEvent ? { calendarEvent } : {}),
    ...(changed ? { labelIds: changed } : {}),
    ...(detail ? { detail } : {}),
    createdAt: r.created_at,
    threadLabelIds: json.parse<string[]>(r.label_ids, []),
  };
}

/** The public shape: drops the scope labels. */
export function toMailEvent(e: StoredEvent): MailEvent {
  const { threadLabelIds: _scope, ...pub } = e;
  return pub;
}

export function eventBySeq(db: Db, seq: number): StoredEvent | null {
  const row = db.get<EventRow>(`${EVENT_SELECT} WHERE e.seq = ?`, seq);
  return row ? toStoredEvent(row) : null;
}

/** Console list cursors are positive integers (a seq or row id). Throws HttpError(400) otherwise. */
export function cursorParam(value: string | undefined): string | null {
  if (!value) return null;
  if (!/^\d{1,15}$/.test(value)) throw badRequest("Invalid cursor", "Pass the nextCursor value from the previous page.");
  return value;
}
