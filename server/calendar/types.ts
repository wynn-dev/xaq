// Calendar domain contract (docs/calendar.md). Each member names the workstream that implements it.
// Members marked FROZEN are used across workstreams: do not rename or change them. Adding members is fine.

import type {
  CalendarInfo,
  CalendarSetupInput,
  CalendarSetupState,
  MessageContent,
} from "../../shared/types.ts";
import type { Lifecycle } from "../context.ts";

export interface CalendarService extends Lifecycle {
  // ───── Sync (A: server/calendar/sync.ts) ─────
  /**
   * FROZEN. Sync now (soon, coalesced): one calendar, every synced calendar of an account, or everything.
   * Called by push notifications (D), after direct writes (B) and when a grant gains calendar.read (B).
   * Never throws.
   */
  kick(accountId?: string, calendarId?: string): void;
  /**
   * FROZEN. Runs one sync pass for an account now and resolves when done (tests, console "Sync now").
   * Throws on Google errors after recording them on the account.
   */
  syncAccount(accountId: string): Promise<void>;

  // ───── Setup and status (D: server/calendar/setup.ts) ─────
  /** FROZEN. GET /api/google/calendar. */
  setupState(): CalendarSetupState;
  /** PATCH /api/google/calendar. Turning `enabled` on is step one of "Add Google Calendar" (existing installs). */
  updateSetup(input: CalendarSetupInput): CalendarSetupState;
  /** POST /api/google/calendar/check: probes every account that has the scopes (calendarList, maxResults 1). */
  check(): Promise<CalendarSetupState>;
  /**
   * FROZEN. Live calendar list of an account (for the grant editor and list_calendars), `synced` filled in.
   * Throws HttpError 409 calendar_not_granted | calendar_api_disabled | needs_reauth.
   */
  calendars(accountId: string): Promise<CalendarInfo[]>;

  // ───── Push (D: server/calendar/push.ts) ─────
  /**
   * POST /google/calendar/push (unauthenticated). Verifies X-Goog-Channel-ID + X-Goog-Channel-Token against
   * calendar_sync, marks the channel verified on "sync", kicks the calendar on "exists"/"not_exists".
   * Returns the HTTP status to answer (204; 404 for an unknown channel so Google stops sending).
   */
  handlePush(headers: Headers): number;

  // ───── Content (C: server/calendar/content.ts) ─────
  /**
   * FROZEN. An event's description cleaned like a mail body (HTML → markdown, invisible text removed,
   * signals), for webhook includeBody and get_calendar_event. null when the event has no description.
   */
  eventContent(accountId: string, calendarId: string, eventId: string): Promise<MessageContent | null>;
}
