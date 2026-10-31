// The calendar policy test harness, on the in-process Calendar fake (test/fake-google.ts).

import { AgentCalendar } from "../server/calendar/agent.ts";
import { createCalendarService } from "../server/calendar/index.ts";
import type { CalendarService } from "../server/calendar/types.ts";
import type { AppContext } from "../server/context.ts";
import { CALENDAR_SCOPES, MAIL_SCOPES } from "../shared/google-scopes.ts";
import type { GoogleService } from "../server/google/types.ts";
import type { IngestService } from "../server/ingest/index.ts";
import { AgentMail, ToolError, type ToolTrace } from "../server/mail/agent.ts";
import { PolicyDenied } from "../server/util/errors.ts";
import { testContext } from "./helpers.ts";
import { calendarInfoOf, FakeCalendarClient, FakeGoogleService } from "./fake-google.ts";

/**
 * A wired context with fake Gmail and Calendar, the real accounts repo and policy, and the real calendar
 * service with sync stubbed out (kicks recorded) and `calendars` answered from the fake's list.
 */
export function calendarTestContext() {
  const google = new FakeGoogleService();
  const fakes = new Map<string, FakeCalendarClient>();
  const kicks: [string | undefined, string | undefined][] = [];
  const t = testContext({
    google: () => {
      const base = google.service();
      return new Proxy(base, {
        get: (target, prop) => (prop === "calendar" ? (id: string) => fakes.get(id)! : Reflect.get(target, prop)),
      }) as GoogleService;
    },
    ingest: () => ({ kick: () => {} }) as unknown as IngestService,
    calendar: (ctx): CalendarService => ({
      ...createCalendarService(ctx),
      kick: (accountId, calendarId) => void kicks.push([accountId, calendarId]),
      calendars: async (accountId) => (await fakes.get(accountId)!.listCalendars()).map(calendarInfoOf),
    }),
  });
  const { ctx } = t;

  /** An account; `calendar: false` leaves it mail-only (no calendar scopes granted). */
  const addAccount = (id: string, email: string, opts: { calendar?: boolean } = {}) => {
    const scopes = opts.calendar === false ? MAIL_SCOPES : [...MAIL_SCOPES, ...CALENDAR_SCOPES];
    ctx.db.run(
      "INSERT INTO accounts (id, email, display_name, status, refresh_token_enc, scopes, created_at) VALUES (?, ?, 'Me', 'active', 'x', ?, ?)",
      id,
      email,
      JSON.stringify(scopes),
      new Date().toISOString(),
    );
    const fake = new FakeCalendarClient(id, email);
    fakes.set(id, fake);
    google.gmail(id);
    return fake;
  };

  return { ...t, google, fakes, kicks, addAccount };
}

export interface ToolCall<T> {
  value?: T;
  error?: unknown;
  outcome: "ok" | "denied" | "error";
  reason: string | null;
  detail: Record<string, unknown>;
}

/**
 * Runs an action the way an MCP tool handler does (server/mcp/server.ts register): one trace, the audit
 * entry recorded under `action`, then the send-cap reservation released.
 */
export async function tool<T>(
  ctx: AppContext,
  agentId: string,
  action: string,
  fn: (cal: AgentCalendar, mail: AgentMail) => Promise<T>,
): Promise<ToolCall<T>> {
  const trace: ToolTrace = { detail: {} };
  const principal = { agentId, name: "agent" };
  let r: ToolCall<T>;
  try {
    const value = await fn(new AgentCalendar(ctx, principal, trace), new AgentMail(ctx, principal, trace));
    r = { value, outcome: "ok", reason: null, detail: trace.detail };
  } catch (error) {
    const outcome = error instanceof PolicyDenied ? "denied" : "error";
    const reason = error instanceof PolicyDenied ? error.reason : error instanceof ToolError ? error.code : "internal";
    r = { error, outcome, reason, detail: trace.detail };
  }
  ctx.audit.record({
    actorType: "agent",
    actorId: agentId,
    action,
    accountId: trace.accountId ?? null,
    target: trace.target ?? null,
    outcome: r.outcome,
    reason: r.reason,
    detail: Object.keys(trace.detail).length ? trace.detail : null,
  });
  return r;
}

/** The error message of a failed call (for asserting plain-words denials). */
export const messageOf = (r: ToolCall<unknown>): string => (r.error instanceof Error ? r.error.message : "");
