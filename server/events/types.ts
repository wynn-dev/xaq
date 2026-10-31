// Events domain contract. Owned by the events + webhooks work area.
// Members marked FROZEN are used by other domains: do not rename or change them. Adding members is fine.

import type { CalendarEventSummary, EventType, MailEvent, MessageSummary, Page } from "../../shared/types.ts";
import type { Lifecycle } from "../context.ts";

/** FROZEN. What ingest (and google, for account.auth_failed) hand to events.emit. */
export interface NewEvent {
  type: EventType;
  /** Account events. Connection events (isConnectionEventType) pass connectionId instead. */
  accountId?: string;
  /** Connection events (`connection.*`, `<preset>.*`): events.connection_id (account_id ''). */
  connectionId?: string;
  message?: MessageSummary | null;
  /**
   * Union of label ids across the message's whole thread at event time (label filters match them).
   * Defaults to message.labelIds. Stored in events.label_ids.
   */
  threadLabelIds?: string[];
  /** For label.added / label.removed: the labels that changed. */
  labelIds?: string[];
  /** calendar.* events: the event (its calendarId drives webhook calendarIds filters). */
  calendarEvent?: CalendarEventSummary | null;
  detail?: Record<string, unknown>;
  /**
   * Unique per logical event, e.g. `${accountId}:${messageId}:message.received`. Pub/Sub is at-least-once.
   * Calendar: `${accountId}:${calendarId}:${eventId}:${type}:${updated}` (invitation: without `updated`).
   */
  dedupeKey: string;
}

/** An event as stored, with the scope labels needed for visibility checks. */
export interface StoredEvent extends MailEvent {
  threadLabelIds: string[];
}

export interface FeedOptions {
  /** Return events with seq > after. Defaults to the agent's acked cursor. */
  after?: number;
  limit?: number;
  types?: EventType[];
  accountIds?: string[];
}

export interface FeedResult {
  events: MailEvent[];
  /**
   * Pass as `after` to continue (or to `ack`): the highest seq examined, so events the agent can't
   * see are skipped past. Equals `after` when nothing new exists.
   */
  cursor: number;
  /** The agent's acknowledged position. */
  ackedSeq: number;
  /**
   * More matching events exist after `cursor`: either `limit` was reached or the scan stopped at its
   * per-call bound while skipping events the agent can't see. Call again with `after: cursor`.
   */
  hasMore: boolean;
}

export interface EventsService extends Lifecycle {
  /**
   * FROZEN. Outbox write: inserts the event and its webhook deliveries in one transaction, then emits
   * bus "event". Returns null when dedupeKey was already seen. Must not be called inside an open
   * `db.tx` (it throws): listeners and the delivery worker would see the event before it commits.
   */
  emit(e: NewEvent): MailEvent | null;
  get(id: string): StoredEvent | null;
  /** Console listing, newest first (with threadLabelIds: never hand these items to agents or webhooks). */
  list(q: { accountId?: string; type?: EventType; cursor?: string | null; limit?: number }): Page<MailEvent>;

  // Agent feed (MCP list_events / wait_for_events / ack_events). Only events the agent may see
  // (policy.canSeeEvent) are returned. FROZEN.
  feed(agentId: string, opts?: FeedOptions): FeedResult;
  /** Long poll: resolves as soon as ≥1 visible event exists after the cursor, or with none at timeout/abort. */
  wait(agentId: string, opts: FeedOptions & { timeoutMs: number; signal?: AbortSignal }): Promise<FeedResult>;
  ack(agentId: string, seq: number): { ackedSeq: number };

  /** Deletes events older than `beforeIso`. */
  prune(beforeIso: string): number;
}
