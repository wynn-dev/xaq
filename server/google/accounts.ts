import type { Account, AccountCalendar, AccountStatus } from "../../shared/types.ts";
import { ADMIN_ACTOR } from "../api/util.ts";
import type { AppContext } from "../context.ts";
import { json } from "../db/index.ts";
import { errorMessage, notFound } from "../util/errors.ts";
import { CALENDAR_SCOPES, missingScopes } from "./scopes.ts";
import type { AccountsService } from "./types.ts";

/** Raw `accounts` row. Token and cursor columns are private to server/google and server/ingest. */
export interface AccountRow {
  id: string;
  email: string;
  display_name: string | null;
  status: AccountStatus;
  last_error: string | null;
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_expires_at: string | null;
  scopes: string;
  history_id: string | null;
  last_sync_at: string | null;
  created_at: string;
  refresh_expires_at: string | null;
  /** 'testing' | 'time_based' | NULL (unknown, e.g. only seen on a refresh). */
  refresh_expiry_kind: "testing" | "time_based" | null;
  /** '' = personal (non-Workspace) account (detected), NULL = unknown (connected before migration 3). */
  workspace_domain: string | null;
  /** Migration 7. NULL = derive from scopes; 'api_disabled' | 'error' as last observed by a probe or sync. */
  calendar_status: "api_disabled" | "error" | null;
  calendar_error: string | null;
  calendar_synced_at: string | null;
}

/** Account.calendar from the row (see AccountCalendar). Recorded problems win over the scope check only once scopes are complete. */
export function accountCalendar(r: AccountRow): AccountCalendar | null {
  const granted = accountScopes(r);
  const missing = missingScopes(granted, CALENDAR_SCOPES);
  if (missing.length === CALENDAR_SCOPES.length && r.calendar_status === null) return null;
  const status = missing.length ? "not_granted" : (r.calendar_status ?? "active");
  return {
    status,
    missingScopes: missing,
    lastSyncAt: r.calendar_synced_at,
    error: status === "api_disabled" || status === "error" ? r.calendar_error : null,
  };
}

export const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  status: r.status,
  lastError: r.last_error,
  historyId: r.history_id,
  lastSyncAt: r.last_sync_at,
  createdAt: r.created_at,
  refreshTokenExpiresAt: r.refresh_expires_at,
  refreshTokenExpiryKind: r.refresh_expires_at ? r.refresh_expiry_kind : null,
  workspaceDomain: r.workspace_domain || null,
  grantedScopes: accountScopes(r).length ? accountScopes(r) : null,
  calendar: accountCalendar(r),
});

export const accountScopes = (r: AccountRow): string[] => json.parse<string[]>(r.scopes, []);

export function getRow(ctx: Pick<AppContext, "db">, id: string): AccountRow | undefined {
  return ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
}

export function allRows(ctx: Pick<AppContext, "db">): AccountRow[] {
  return ctx.db.all<AccountRow>("SELECT * FROM accounts ORDER BY created_at, email");
}

type Patch = Partial<Omit<AccountRow, "id" | "created_at">>;

/** Updates columns of an account row; with `emit`, broadcasts bus "account" afterwards. */
export function updateRow(ctx: Pick<AppContext, "db" | "bus">, id: string, patch: Patch, emit = false): Account | null {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length) {
    ctx.db.run(
      `UPDATE accounts SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ...entries.map(([, v]) => v as string | null),
      id,
    );
  }
  const row = getRow(ctx, id);
  if (!row) return null;
  const account = toAccount(row);
  if (emit) ctx.bus.emit("account", account);
  return account;
}

export function createAccountsService(ctx: AppContext): AccountsService {
  const log = ctx.log.child("accounts");

  const get = (id: string) => {
    const row = getRow(ctx, id);
    return row ? toAccount(row) : null;
  };

  return {
    list: () => allRows(ctx).map(toAccount),
    get,
    require(id) {
      const a = get(id);
      if (!a) throw notFound("Account");
      return a;
    },
    getByEmail(email) {
      const row = ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE email = ? COLLATE NOCASE", email.trim());
      return row ? toAccount(row) : null;
    },
    setStatus(id, status, lastError) {
      if (!getRow(ctx, id)) throw notFound("Account");
      const patch: Patch = { status };
      if (lastError !== undefined) patch.last_error = lastError;
      else if (status === "active") patch.last_error = null;
      return updateRow(ctx, id, patch, true)!;
    },
    async remove(id) {
      const row = getRow(ctx, id);
      if (!row) throw notFound("Account");
      try {
        await ctx.google.revoke(id);
      } catch (err) {
        log.warn("Could not revoke the Google token", { email: row.email, error: errorMessage(err) });
      }
      // Their grants go with the account: live listener streams must re-check access.
      const agents = ctx.db.all<{ agent_id: string }>("SELECT DISTINCT agent_id FROM grants WHERE account_id = ?", id);
      ctx.db.tx(() => {
        ctx.db.run("DELETE FROM sent_threads WHERE account_id = ?", id);
        ctx.db.run("DELETE FROM accounts WHERE id = ?", id);
      });
      ctx.audit.record({
        ...ADMIN_ACTOR,
        action: "account.remove",
        accountId: id,
        outcome: "ok",
        detail: { email: row.email },
      });
      log.info("Account removed", { email: row.email });
      for (const { agent_id } of agents) {
        try {
          ctx.bus.emit("agent", { agentId: agent_id, reason: "grant_changed" });
        } catch (err) {
          log.error("Bus listener failed", { error: errorMessage(err) });
        }
      }
    },
  };
}
