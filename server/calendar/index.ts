// Google Calendar service: composes the per-workstream parts (docs/calendar.md). Each part lives in its
// own file with one owner; this file only wires them.

import type { AppContext } from "../context.ts";
import { errorMessage } from "../util/errors.ts";
import { eventContent } from "./content.ts";
import { createCalendarPush } from "./push.ts";
import { createCalendarSetup } from "./setup.ts";
import { createCalendarSync } from "./sync.ts";
import type { CalendarService } from "./types.ts";

export function createCalendarService(ctx: AppContext): CalendarService {
  const push = createCalendarPush(ctx);
  const log = ctx.log.child("calendar");
  // Never let a push failure become an unhandled rejection (they end the process on Node 22).
  const reconcile = (accountId?: string) =>
    Promise.resolve()
      .then(() => push.reconcile(accountId))
      .catch((err: unknown) => log.warn("Updating calendar push channels failed", { error: errorMessage(err) }));
  // Push channels follow the set of synced calendars.
  const sync = createCalendarSync(ctx, { onSyncSetChanged: reconcile });
  const setup = createCalendarSetup(ctx);
  return {
    kick: (accountId, calendarId) => sync.kick(accountId, calendarId),
    syncAccount: (accountId) => sync.syncAccount(accountId),
    setupState: () => setup.setupState(),
    updateSetup: (input) => setup.updateSetup(input),
    check: () => setup.check(),
    calendars: (accountId) => setup.calendars(accountId),
    handlePush: (headers) => push.handlePush(headers),
    eventContent: (accountId, calendarId, eventId) => eventContent(ctx, accountId, calendarId, eventId),
    async start() {
      await sync.start?.();
      push.start?.();
    },
    async stop() {
      await push.stop?.();
      await sync.stop?.();
    },
  };
}
