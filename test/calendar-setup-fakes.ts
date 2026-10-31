/**
 * Minimal Calendar hooks for the setup, consent and push tests (workstream D). Workstream A's fake Calendar
 * API lives in test/fake-google.ts; until it lands this replaces ctx.google.calendar with an in-memory
 * client that authenticates through the real TokenManager (refresh, needs_reauth) and checks the account's
 * granted scopes like Google checks the token's.
 *
 *   const cal = fakeCalendar(ctx);
 *   cal.disableApi(true);             // 403 SERVICE_DISABLED with an activationUrl
 *   cal.scopeInsufficient(1);         // the next call gets 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT whatever accounts.scopes says
 *   cal.channels / cal.stopped        // events.watch / channels.stop calls
 *   cal.onWatch = (ch) => …           // runs before events.watch returns (Google's "sync" can beat the response)
 *   cal.delayMs = 200                 // every call waits this long first (a slow Calendar API)
 */
import type { AppContext } from "../server/context.ts";
import { accountScopes, getRow } from "../server/google/accounts.ts";
import type { CalendarClient, CalendarListEntryRaw, WatchChannel } from "../server/google/calendar.ts";
import { googleErrorFromBody } from "../server/google/http.ts";
import { googleRuntime } from "../server/google/runtime.ts";
import { CALENDAR_SCOPES } from "../shared/google-scopes.ts";
import type { Account, ExtraScopeName } from "../shared/types.ts";
import type { FakeGoogle } from "./fake-google.ts";

export const ACTIVATION_URL = "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123456789";

const serviceDisabled = () =>
  googleErrorFromBody(
    403,
    {
      error: {
        code: 403,
        message: "Google Calendar API has not been used in project 123456789 before or it is disabled.",
        status: "PERMISSION_DENIED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "SERVICE_DISABLED",
            domain: "googleapis.com",
            metadata: { service: "calendar-json.googleapis.com", consumer: "projects/123456789", activationUrl: ACTIVATION_URL },
          },
        ],
      },
    },
    "HTTP 403",
  );

const scopeInsufficient = () =>
  googleErrorFromBody(
    403,
    {
      error: {
        code: 403,
        message: "Request had insufficient authentication scopes.",
        status: "PERMISSION_DENIED",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT", domain: "googleapis.com" }],
      },
    },
    "HTTP 403",
  );

export interface FakeChannel {
  accountId: string;
  calendarId: string;
  id: string;
  resourceId: string;
  address: string;
  token: string;
  ttlSeconds?: number;
}

export function fakeCalendar(ctx: AppContext) {
  let apiDisabled = false;
  let watchError: Error | null = null;
  let insufficient = 0;
  let n = 0;
  const channels: FakeChannel[] = [];
  const stopped: { id: string; resourceId: string }[] = [];
  const calls: { accountId: string; method: string }[] = [];

  const hooks: { onWatch: ((ch: FakeChannel) => void) | null; delayMs: number } = { onWatch: null, delayMs: 0 };

  const auth = async (accountId: string, method: string) => {
    calls.push({ accountId, method });
    if (hooks.delayMs) await new Promise((r) => setTimeout(r, hooks.delayMs));
    await googleRuntime(ctx).tokens.accessToken(accountId);
    const row = getRow(ctx, accountId)!;
    if (insufficient > 0 || !CALENDAR_SCOPES.every((s) => accountScopes(row).includes(s))) {
      insufficient--;
      throw scopeInsufficient();
    }
    if (apiDisabled) throw serviceDisabled();
    return row;
  };
  const notHere = (what: string) => () => Promise.reject(new Error(`fake calendar: ${what} is not part of the setup fake`));

  const client = (accountId: string): CalendarClient => ({
    accountId,
    async listCalendars(): Promise<CalendarListEntryRaw[]> {
      const row = await auth(accountId, "listCalendars");
      return [
        { id: "team@group.calendar.google.com", summary: "Team​\nstandups", accessRole: "writer", timeZone: "Europe/Berlin" },
        { id: row.email, summary: row.email, accessRole: "owner", primary: true, timeZone: "Europe/Berlin", backgroundColor: "#9fe1e7" },
      ];
    },
    async watchEvents(calendarId, p): Promise<WatchChannel> {
      await auth(accountId, "watchEvents");
      if (watchError) throw watchError;
      const ch = { accountId, calendarId, ...p, resourceId: `res_${++n}` };
      channels.push(ch);
      hooks.onWatch?.(ch);
      return { id: p.id, resourceId: ch.resourceId, expiration: String(Date.now() + (p.ttlSeconds ?? 604_800) * 1000) };
    },
    async stopChannel(p) {
      await auth(accountId, "stopChannel");
      stopped.push(p);
    },
    listEvents: notHere("listEvents"),
    getEvent: notHere("getEvent"),
    insertEvent: notHere("insertEvent"),
    patchEvent: notHere("patchEvent"),
    deleteEvent: notHere("deleteEvent"),
    freeBusy: notHere("freeBusy"),
  });
  ctx.google.calendar = client;

  return {
    get onWatch() {
      return hooks.onWatch;
    },
    set onWatch(fn: ((ch: FakeChannel) => void) | null) {
      hooks.onWatch = fn;
    },
    get delayMs() {
      return hooks.delayMs;
    },
    set delayMs(ms: number) {
      hooks.delayMs = ms;
    },
    channels,
    stopped,
    calls,
    disableApi(on: boolean) {
      apiDisabled = on;
    },
    scopeInsufficient(times: number) {
      insufficient = times;
    },
    failWatch(err: Error | null) {
      watchError = err;
    },
  };
}

/** One consent round trip through the fake (adding the mailbox if needed): startConnect → Google's screen (as `email`) → the callback URL. */
export async function consent(
  ctx: AppContext,
  fake: FakeGoogle,
  email: string,
  start: { reauthAccountId?: string; scopes?: ExtraScopeName[] } = {},
  screen: Parameters<FakeGoogle["consentAs"]>[1] = {},
): Promise<{ account?: Account; error?: Error; scope: string[] }> {
  fake.addAccount(email);
  fake.consentAs(email, screen);
  const { authUrl } = ctx.google.startConnect(start);
  const scope = (new URL(authUrl).searchParams.get("scope") ?? "").split(" ");
  const res = await fetch(authUrl, { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) throw new Error(`fake consent failed: HTTP ${res.status}`);
  try {
    return { account: await ctx.google.completeConnectFromUrl(location), scope };
  } catch (error) {
    return { error: error as Error, scope };
  }
}

/** Scopes a fake user grants when they untick Calendar (what Google's token response then says). */
export const MAIL_ONLY = ["https://www.googleapis.com/auth/gmail.modify", "openid", "https://www.googleapis.com/auth/userinfo.email", "profile"];
