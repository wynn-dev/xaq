import { sweepPairings } from "./agentapi/index.ts";
import { adminAuth } from "./auth/index.ts";
import { KEEP_ENDED_MS, pruneEventStates } from "./calendar/state.ts";
import type { AppContext } from "./context.ts";
import { errorMessage } from "./util/errors.ts";

const INTERVAL_MS = 3600_000;
const FIRST_RUN_MS = 60_000;
/** Pairing codes live 10 minutes: expire them (and wipe uncollected keys) promptly. */
const PAIRING_SWEEP_MS = 30_000;

export interface MaintenanceResult {
  events: number;
  audit: number;
  sessions: number;
}

/** Prunes data older than Settings.retentionDays, expired admin sessions and ended calendar events' sync state. Never throws. */
export function runMaintenance(ctx: AppContext): MaintenanceResult {
  const log = ctx.log.child("maintenance");
  const before = new Date(Date.now() - ctx.settings.get().retentionDays * 86_400_000).toISOString();
  const step = (name: string, fn: () => number) => {
    try {
      return fn();
    } catch (err) {
      log.warn(`Pruning ${name} failed`, { error: errorMessage(err) });
      return 0;
    }
  };
  const result: MaintenanceResult = {
    events: step("events", () => ctx.events.prune(before)),
    audit: step("audit log", () => ctx.audit.prune(before)),
    sessions: step("sessions", () => adminAuth(ctx).sessions.pruneExpired()),
  };
  // Decided approvals keep full message bodies; they follow the same retention.
  const approvals = step("approvals", () => ctx.mail.prune(before));
  // Calendar sync state is only needed until an event has been over for a day (not a retention setting).
  const calendarEvents = step("calendar sync state", () => pruneEventStates(ctx.db, new Date(Date.now() - KEEP_ENDED_MS).toISOString()));
  if (approvals > 0 || calendarEvents > 0 || Object.values(result).some((n) => n > 0)) log.info("Pruned old data", { ...result, approvals, calendarEvents });
  return result;
}

/** Runs maintenance shortly after start, then hourly. Timers are unref'd. Returns a stop function. */
export function startMaintenance(ctx: AppContext): () => void {
  const run = () => {
    try {
      runMaintenance(ctx);
    } catch (err) {
      ctx.log.warn("Maintenance failed", { error: errorMessage(err) });
    }
  };
  const first = setTimeout(run, FIRST_RUN_MS).unref();
  const timer = setInterval(run, INTERVAL_MS).unref();
  const pairings = setInterval(() => sweepPairings(ctx), PAIRING_SWEEP_MS).unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    clearInterval(pairings);
  };
}
