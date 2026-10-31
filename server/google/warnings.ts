import type { SetupWarning } from "../../shared/types.ts";
import { setupState } from "../calendar/setup.ts";
import type { AppContext } from "../context.ts";
import { type AccountRow, accountScopes, allRows } from "./accounts.ts";
import { clientWarnings, redirectWarning } from "./client.ts";
import { CALENDAR_SCOPES, describeScopes, missingScopes } from "../../shared/google-scopes.ts";

type Ctx = Pick<AppContext, "db" | "settings" | "config" | "crypto">;

const SEVERITY_ORDER: Record<SetupWarning["severity"], number> = { error: 0, warning: 1, info: 2 };

/** "2026-10-22 17:05 UTC" */
const formatDate = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Personal (non-Workspace) Google account? workspace_domain is '' when the id_token said so; accounts connected before
 * it was recorded (NULL) fall back to the address (only @gmail.com/@googlemail.com are certain).
 */
function isPersonal(row: AccountRow): boolean | null {
  if (row.workspace_domain !== null) return row.workspace_domain === "";
  return CONSUMER_DOMAINS.has(row.email.split("@")[1]?.toLowerCase() ?? "") ? true : null;
}

/** Everything that looks wrong or risky about the setup; see SetupWarning in shared/types.ts. */
export function setupWarnings(ctx: Ctx): SetupWarning[] {
  const out: SetupWarning[] = [];
  const client = ctx.settings.getState("google.client");
  const project = client?.projectId ? `?project=${encodeURIComponent(client.projectId)}` : "";
  const audienceUrl = `https://console.cloud.google.com/auth/audience${project}`;
  const rows = allRows(ctx);

  out.push(...clientWarnings(ctx));
  const redirect = redirectWarning(ctx);
  if (redirect) out.push(redirect);

  for (const row of rows) {
    if (row.status === "needs_reauth") {
      out.push({
        code: "needs_reauth",
        severity: "error",
        message: `${row.email} is disconnected: Google rejected its saved sign-in, so xaq can't read or send its mail.`,
        hint:
          `Accounts → ${row.email} → Reconnect, and sign in as ${row.email}.` +
          (row.refresh_expiry_kind === "testing" && row.refresh_expires_at
            ? " Publish the OAuth app first (see the Testing warning), or the new sign-in expires again in 7 days."
            : ""),
        accountId: row.id,
      });
    }
  }

  for (const row of rows) {
    if (!row.refresh_expires_at) continue;
    const expired = Date.parse(row.refresh_expires_at) <= Date.now();
    const severity = expired || Date.parse(row.refresh_expires_at) - Date.now() < 24 * 3_600_000 ? "error" : "warning";
    const when = `${expired ? "expired" : "will expire"} the sign-in for ${row.email} on ${formatDate(row.refresh_expires_at)}`;
    // Only a ~7-day initial lifetime means Testing; other lifetimes (e.g. time-based access the user
    // picked on the consent screen) get a neutral reminder.
    if (row.refresh_expiry_kind === "testing") {
      out.push({
        code: "testing_mode",
        severity,
        message: `Your OAuth app is in Testing, so Google ${when} (7 days after it connected).`,
        hint: "Google Cloud → Google Auth Platform → Audience → Publish app → Push to production? → Confirm. Then reconnect the account so it gets a long-lived token.",
        url: audienceUrl,
        accountId: row.id,
      });
    } else {
      out.push({
        code: "sign_in_expires",
        severity,
        message: `Google ${when}.`,
        hint:
          `Reconnect ${row.email} before then (Accounts → ${row.email} → Reconnect). If Google offers time-based access on the consent screen, ` +
          "choose to keep access until you remove it.",
        accountId: row.id,
      });
    }
  }

  if (client?.appType === "internal") {
    for (const row of rows) {
      if (isPersonal(row) !== true) continue;
      out.push({
        code: "app_type_mismatch",
        severity: "warning",
        message:
          `${row.email} is a personal (non-Workspace) Google account, but the app type is set to Internal here. ` +
          "Internal apps only accept accounts from their own Workspace organization, so your app in Google Cloud is actually External.",
        hint:
          "Set the app type to External in the setup wizard's Google step, and make sure the app is published " +
          "(Google Cloud → Google Auth Platform → Audience → Publish app) so sign-ins don't expire after 7 days.",
        url: audienceUrl,
        accountId: row.id,
      });
    }
  } else if (client?.appType === "external" && rows.length) {
    const domains = new Set(rows.map((r) => r.workspace_domain));
    const [domain] = domains;
    if (domains.size === 1 && domain) {
      out.push({
        code: "app_type_mismatch",
        severity: "info",
        message: `Every connected account is in the ${domain} Google Workspace, but the OAuth app is External.`,
        hint:
          `That works. If you'll only ever connect ${domain} accounts, an Internal app is simpler: no 7-day Testing expiry and no Google verification. ` +
          "Google Cloud → Google Auth Platform → Audience → Make internal, then set the app type to Internal in the setup wizard.",
        url: audienceUrl,
      });
    }
  }

  out.push(...calendarWarnings(ctx, rows));

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Accounts some agent has a grant on (their calendar problems are errors, not warnings). */
function calendarInUse(ctx: Ctx): Set<string> {
  return new Set(ctx.db.all<{ account_id: string }>("SELECT DISTINCT account_id FROM grants").map((g) => g.account_id));
}

/** calendar_* codes (see SetupWarning). Mail-only installs that haven't added Calendar see only the info notice. */
function calendarWarnings(ctx: Ctx, rows: AccountRow[]): SetupWarning[] {
  const out: SetupWarning[] = [];
  const setup = setupState(ctx);
  const enableSteps =
    (setup.enableApiCommand ? `run ${setup.enableApiCommand}, or ` : "") +
    `open ${setup.enableApiUrl ?? "Google Cloud → APIs & Services → Library → Google Calendar API"} and click Enable`;
  const inUse = calendarInUse(ctx);

  if (!setup.enabled && !setup.dismissed && rows.length) {
    out.push({
      code: "calendar_not_added",
      severity: "info",
      message: "xaq can now give your agents Google Calendar too: reading events, scheduling and answering invitations.",
      hint:
        `Click Add Google Calendar. It walks you through it: turn on the Calendar API (${enableSteps}), then approve Calendar access for each account. ` +
        "Mail keeps working throughout, and no agent gets calendar access until you grant it.",
    });
  }

  if (setup.api === "disabled") {
    out.push({
      code: "calendar_api_disabled",
      severity: rows.some((r) => inUse.has(r.id)) ? "error" : "warning",
      message: "The Google Calendar API is turned off in your Google Cloud project, so agents can't use any calendar.",
      hint: `To turn it on, ${enableSteps}. Wait a minute, then click Check again on the Google Calendar card. Mail is unaffected.`,
      ...(setup.enableApiUrl ? { url: setup.enableApiUrl } : {}),
    });
  }

  for (const row of rows) {
    if (row.status === "needs_reauth") continue;
    const missing = missingScopes(accountScopes(row), CALENDAR_SCOPES);
    if (setup.enabled && missing.length) {
      const none = missing.length === CALENDAR_SCOPES.length;
      out.push({
        code: "calendar_scope_missing",
        severity: inUse.has(row.id) ? "error" : "info",
        message: none
          ? `Google Calendar isn't added to ${row.email} yet, so agents can't use its calendar. Its mail is unaffected.`
          : `${row.email} granted only part of Google Calendar access (not granted: ${describeScopes(missing)}). Its mail is unaffected.`,
        hint: `Accounts → ${row.email} → Add Calendar, and keep every Calendar permission ticked on Google's screen.`,
        accountId: row.id,
      });
    }
    if (row.calendar_status === "error" && !missing.length) {
      out.push({
        code: "calendar_sync_failing",
        severity: "error",
        message: `Google Calendar sync for ${row.email} is failing${row.calendar_error ? `: ${row.calendar_error}` : "."}`,
        hint: "xaq retries on every poll, and calendar events arrive late until it works again. If it keeps failing, check the xaq log. Mail is unaffected.",
        accountId: row.id,
      });
    }
  }
  return out;
}
