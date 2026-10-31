import type { GmailLabel } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { createAccountsService } from "./accounts.ts";
import { checkClient } from "./check.ts";
import { clientView, callbackMode, importClient, setClient } from "./client.ts";
import { type CalendarClient, createCalendarClient } from "./calendar.ts";
import { createGmailClient } from "./gmail.ts";
import { mimeTools } from "./mime.ts";
import { completeConnect, completeConnectFromUrl, connectAttempt, revokeAccount, startConnect } from "./oauth.ts";
import { googleRuntime } from "./runtime.ts";
import { sendTestEmail } from "./testmail.ts";
import { setupWarnings } from "./warnings.ts";
import type { GmailClient, GoogleService } from "./types.ts";

export { createAccountsService };

const LABEL_TTL_MS = 60_000;

const SYSTEM_ORDER = ["INBOX", "STARRED", "IMPORTANT", "SENT", "DRAFT", "UNREAD", "SPAM", "TRASH"];

export function createGoogleService(ctx: AppContext): GoogleService {
  const clients = new Map<string, GmailClient>();
  const gmail = (accountId: string) => {
    let c = clients.get(accountId);
    if (!c) clients.set(accountId, (c = createGmailClient(ctx, accountId)));
    return c;
  };

  const calendars = new Map<string, CalendarClient>();
  const calendar = (accountId: string) => {
    let c = calendars.get(accountId);
    if (!c) calendars.set(accountId, (c = createCalendarClient(ctx, accountId)));
    return c;
  };

  return {
    clientView: () => clientView(ctx),
    setClient: (input) => setClient(ctx, input),
    importClient: (input) => importClient(ctx, input),
    checkClient: () => checkClient(ctx),
    redirectUri: () => callbackMode(ctx).redirectUri,
    setupWarnings: () => setupWarnings(ctx),

    startConnect: (opts) => startConnect(ctx, opts),
    completeConnect: (code, state) => completeConnect(ctx, code, state),
    completeConnectFromUrl: (url) => completeConnectFromUrl(ctx, url),
    connectAttempt: (state) => connectAttempt(ctx, state),

    gmail,
    calendar,
    mime: mimeTools,
    async labels(accountId, opts = {}) {
      const cache = googleRuntime(ctx).labelCache;
      const hit = cache.get(accountId);
      if (hit && !opts.fresh && Date.now() - hit.at < LABEL_TTL_MS) return hit.labels;
      const raw = await gmail(accountId).listLabels();
      const rank = (l: GmailLabel) => (l.type === "system" ? (SYSTEM_ORDER.indexOf(l.id) + 1 || SYSTEM_ORDER.length + 1) : 100);
      const labels: GmailLabel[] = raw
        .map((l) => ({ id: l.id, name: l.name, type: l.type === "user" ? ("user" as const) : ("system" as const) }))
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      cache.set(accountId, { at: Date.now(), labels });
      return labels;
    },
    revoke: (accountId) => revokeAccount(ctx, accountId),
    sendTestEmail: (accountId) => sendTestEmail(ctx, accountId),
  };
}
