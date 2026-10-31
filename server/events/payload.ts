import type { MessageContent, EventPayload } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { toMailEvent } from "./repo.ts";
import type { StoredEvent } from "./types.ts";
import { errorMessage } from "../util/errors.ts";

/** Event payload data; `contentError` explains a missing `content` when the body was requested. */
export type PayloadData = EventPayload["data"] & { contentError?: string };

const CONTENT_TIMEOUT_MS = 20_000;

export interface PayloadOptions {
  /**
   * Checked before fetching the body (e.g. the agent still has a grant on the account).
   * Resolve to an error message to skip the body and report it as `contentError`.
   */
  bodyCheck?: () => Promise<string | null>;
}

/**
 * The payload of an event in `xaq listen` streams. With `includeBody`, message events get cleaned content (or `contentError`), and calendar
 * events other than cancellations get the cleaned description (no `content` when there is none).
 */
export async function buildPayload(ctx: AppContext, event: StoredEvent, includeBody: boolean, opts: PayloadOptions = {}): Promise<EventPayload> {
  const data: PayloadData = toMailEvent(event);
  const m = event.message;
  const e = event.calendarEvent;
  if (includeBody && m) {
    await fetchContent(data, "Message body", opts, () => ctx.mail.messageContent(event.accountId, m.id));
  } else if (includeBody && e && event.type !== "calendar.event_cancelled") {
    await fetchContent(data, "Event description", opts, () => ctx.calendar.eventContent(event.accountId, e.calendarId, e.id));
  }
  return { type: event.type, timestamp: event.createdAt, data };
}

async function fetchContent(data: PayloadData, what: string, opts: PayloadOptions, fetch: () => Promise<MessageContent | null>): Promise<void> {
  try {
    const problem = opts.bodyCheck ? await withTimeout(opts.bodyCheck(), CONTENT_TIMEOUT_MS) : null;
    if (problem) data.contentError = `${what} unavailable: ${problem}`.slice(0, 300);
    else {
      const content = await withTimeout(fetch(), CONTENT_TIMEOUT_MS);
      if (content) data.content = content;
    }
  } catch (err) {
    data.contentError = `${what} unavailable: ${errorMessage(err)}`.slice(0, 300);
  }
}

/** Body access checked as it is now, not when the event was recorded: an agent that lost its grant since gets no body. */
export function scopeBodyCheck(ctx: AppContext, agentId: string, event: StoredEvent): () => Promise<string | null> {
  return async () => (ctx.policy.grant(agentId, event.accountId) ? null : "not accessible");
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}
