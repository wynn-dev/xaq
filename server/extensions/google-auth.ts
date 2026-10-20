// Core's side of code extensions with `"code.auth": { "type": "google" }` (docs/EXTENSIONS.md "Google accounts for
// code extensions"). Official extensions only (validateManifest refuses the rest).
//
// - Binding: a connection works as ONE of xaq's connected Google accounts, picked in setup and kept in
//   connections.google_account_id. Nothing per connection is stored besides that id: the refresh token stays the
//   account's.
// - Connecting: incremental consent (include_granted_scopes) for exactly the manifest's scopes, with the existing OAuth
//   client and callback (server/google/oauth.ts startConnect with `extension`). The account keeps what it had.
// - Tokens: `xaq/credentials/get` from the connection's child gets an access token for ITS bound account (read on
//   every call), downscoped to the manifest's scopes the account granted (server/google/scoped.ts). Never the
//   account's own token, never one that can read Gmail.
// - Status: a connection reads needs_reauth while it has no usable access (no account, the account needs
//   reconnecting, nothing granted) and active otherwise; recomputed when an account changes (bus "account").

import type { Connection, ConnectionGoogleView, StartConnectInput } from "../../shared/types.ts";
import type { ConnectOutcome } from "../broker/service.ts";
import { untilAborted } from "../broker/credentials/refresher.ts";
import { type IntegrationPreset, type NativeSourceDeps, type SetupContext, SourceError } from "../broker/types.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { type AccountRow, accountScopes, allRows, getRow } from "../google/accounts.ts";
import { googleProjectId, probeGoogleApis, type GoogleApiCheck } from "../google/apis.ts";
import { callbackMode } from "../google/client.ts";
import { startConnect as startGoogleConsent } from "../google/oauth.ts";
import { googleAccessToken } from "../google/scoped.ts";
import { IDENTITY_TOKEN_SCOPES, isExtensionScope, scopeGrants, scopeWithout } from "../google/scopes.ts";
import { AccountNeedsReauthError, DownscopeError, ScopesNotGrantedError } from "../google/types.ts";
import { errorMessage, HttpError } from "../util/errors.ts";
import { GOOGLE_ACCOUNT_INPUT, type GoogleAuth } from "./google-setup.ts";
import { rememberHandedToken } from "./handed-tokens.ts";

export { GOOGLE_ACCOUNT_INPUT };

export type GooglePreset = IntegrationPreset & { auth: GoogleAuth };

export const isGooglePreset = (p: IntegrationPreset | null | undefined): p is GooglePreset => p?.auth.type === "google";

/**
 * The manifest's scopes, re-checked at run time (validateManifest refused core's already): never a Gmail, Calendar,
 * Pub/Sub or cloud-platform scope, whatever reached the preset.
 */
export function extensionScopes(auth: GoogleAuth): string[] {
  const out = [...new Set(auth.scopes)];
  const bad = out.filter((s) => !isExtensionScope(s));
  if (!out.length || bad.length) throw new SourceError("unavailable", `This extension asks for Google access xaq never gives an extension${bad.length ? ` (${bad.join(", ")})` : ""}.`);
  return out;
}

/** The account a connection is bound to (connections.google_account_id), or null. */
export function boundAccountId(ctx: Pick<AppContext, "db">, connectionId: string): string | null {
  return ctx.db.get<{ google_account_id: string | null }>("SELECT google_account_id FROM connections WHERE id = ?", connectionId)?.google_account_id ?? null;
}

/** A connected account by id or email (case-insensitive), or null. */
export function resolveAccount(ctx: Pick<AppContext, "db">, idOrEmail: string): AccountRow | null {
  const v = idOrEmail.trim();
  if (!v) return null;
  return getRow(ctx, v) ?? ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE email = ? COLLATE NOCASE", v) ?? null;
}

export interface GoogleConnectionState {
  account: AccountRow | null;
  /** The extension's scopes. */
  scopes: string[];
  /** Of those, what the account granted: the extension's tokens are limited to these. */
  granted: string[];
  missing: string[];
  /** Why the connection can't get a token now (needs_reauth's reason), or null. */
  problem: string | null;
}

export function googleConnectionState(ctx: Pick<AppContext, "db">, connectionId: string, preset: GooglePreset): GoogleConnectionState {
  const scopes = [...new Set(preset.auth.scopes)];
  const accountId = boundAccountId(ctx, connectionId);
  const account = accountId ? (getRow(ctx, accountId) ?? null) : null;
  const have = account ? accountScopes(account) : [];
  const granted = scopes.filter((s) => have.includes(s) && isExtensionScope(s));
  const missing = scopes.filter((s) => !granted.includes(s));
  const name = preset.displayName;
  const problem = !account
    ? `Pick the Google account ${name} works as: Reconnect.`
    : account.status === "needs_reauth"
      ? `${account.email} needs to be reconnected on the Accounts page before ${name} can use it.`
      : !granted.length
        ? `${name} doesn't have access to ${account.email} yet: Reconnect and allow it on Google's screen.`
        : null;
  return { account, scopes, granted, missing, problem };
}

export function googleConnectionView(state: GoogleConnectionState): ConnectionGoogleView {
  return {
    accountId: state.account?.id ?? null,
    email: state.account?.email ?? null,
    scopes: [...state.scopes],
    granted: [...state.granted],
    missing: state.missing.map((scope) => ({ scope, grants: scopeGrants(scope), without: scopeWithout(scope) })),
  };
}

/**
 * Brings the stored status of Google extensions' connections in line with their accounts: needs_reauth (with the
 * reason) while there's no usable access, active once there is. Only active and needs_reauth connections change (a
 * disabled one stays off, an `error` from the code host stays). `touch`: bump that connection's updated_at even when
 * nothing else changed (a consent just finished: the console and CLI wait for a change).
 */
export function syncGoogleConnections(ctx: Pick<AppContext, "db">, presetFor: (id: string | null) => IntegrationPreset | null, opts: { touch?: string } = {}): void {
  const rows = ctx.db.all<{ id: string; preset: string; status: Connection["status"]; status_reason: string | null }>(
    "SELECT id, preset, status, status_reason FROM connections WHERE preset IS NOT NULL AND status IN ('active', 'needs_reauth')",
  );
  for (const r of rows) {
    const p = presetFor(r.preset);
    if (!isGooglePreset(p)) continue;
    const st = googleConnectionState(ctx, r.id, p);
    const status = st.problem ? "needs_reauth" : "active";
    if (status === r.status && st.problem === r.status_reason && opts.touch !== r.id) continue;
    ctx.db.run("UPDATE connections SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?", status, st.problem, now(), r.id);
  }
}

// ───────────── Tokens for the connection's child ─────────────

/**
 * What a Google extension connection's source uses for `xaq/credentials/get`: a token for the account bound to THIS
 * connection (re-read on every call, so a re-bind or a removed account takes effect at once), downscoped to the
 * manifest's scopes it granted. Every failure is needs_reauth with plain words; the child never sees anything else.
 */
export function googleTokenDeps(ctx: AppContext, connectionId: string, preset: GooglePreset): Pick<NativeSourceDeps, "accessToken" | "tokenExpiresAt"> {
  let expiresAt: number | null = null;
  return {
    accessToken: async (signal) => {
      const want = extensionScopes(preset.auth);
      const st = googleConnectionState(ctx, connectionId, preset);
      if (st.problem || !st.account) throw new SourceError("needs_reauth", st.problem ?? `Pick the Google account ${preset.displayName} works as: Reconnect.`);
      try {
        const t = await untilAborted(googleAccessToken(ctx, st.account.id, st.granted), signal);
        // Second lock: whatever the token manager says, nothing outside the manifest's scopes reaches the child, except
        // the identity scopes Google may add (they can't read mail or files). Core scopes are refused even if listed.
        const outside = t.scopes.filter((s) => !IDENTITY_TOKEN_SCOPES.includes(s) && (!want.includes(s) || !isExtensionScope(s)));
        if (outside.length) throw new DownscopeError(`The token had access outside ${preset.displayName}'s (${outside.join(", ")}), so xaq didn't hand it over.`);
        expiresAt = t.expiresAt;
        // Tool output that echoes it is scrubbed like a stored credential.
        rememberHandedToken(connectionId, t.accessToken);
        return t.accessToken;
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof AccountNeedsReauthError) throw new SourceError("needs_reauth", `${err.email} needs to be reconnected on the Accounts page.`);
        if (err instanceof ScopesNotGrantedError) throw new SourceError("needs_reauth", `${err.email} hasn't given ${preset.displayName} this access: Reconnect and allow it on Google's screen.`);
        if (err instanceof DownscopeError) throw new SourceError("needs_reauth", err.message);
        throw new SourceError("unavailable", `Couldn't get a Google token: ${errorMessage(err).slice(0, 200)}`);
      }
    },
    tokenExpiresAt: () => expiresAt,
  };
}

// ───────────── Connecting ─────────────

/**
 * POST /api/connections/:id/connect for a Google extension: binds the account named by the `google_account` input (an
 * email or id; else the one already bound), then either it already granted every scope (connected at once) or the
 * incremental consent starts (authorize). The account's existing access is never touched.
 */
export function startGoogleConnect(
  ctx: AppContext,
  conn: Pick<Connection, "id" | "name">,
  preset: GooglePreset,
  input: StartConnectInput,
  presetFor: (id: string | null) => IntegrationPreset | null,
): ConnectOutcome {
  const scopes = extensionScopes(preset.auth);
  const raw = input.inputs?.[GOOGLE_ACCOUNT_INPUT]?.trim() ?? "";
  const account = raw ? resolveAccount(ctx, raw) : (getRow(ctx, boundAccountId(ctx, conn.id) ?? "") ?? null);
  if (raw && !account) return { status: "error", message: `${raw.slice(0, 100)} isn't connected to xaq. Add it on the Accounts page first, then pick it here.` };
  if (!account) return { status: "error", message: `Pick the Google account ${preset.displayName} works as (one connected to xaq).` };
  if (account.status === "needs_reauth") return { status: "error", message: `${account.email} needs to be reconnected on the Accounts page first.` };
  const have = accountScopes(account);
  if (scopes.every((s) => have.includes(s))) {
    // Nothing to ask Google: the account already allowed all of it (another connection, or core's own use). Bound now.
    bindAccount(ctx, conn.id, account.id, presetFor);
    return { status: "connected" };
  }
  // The account is bound only once Google's consent comes back with some of the access (onDone, keyed by the pending
  // attempt's state): an abandoned or refused re-pick leaves the connection on the account it had.
  try {
    const r = startGoogleConsent(ctx, {
      reauthAccountId: account.id,
      extension: {
        connectionId: conn.id,
        displayName: preset.displayName,
        connectionName: conn.name,
        scopes,
        onDone: (accountId, granted) => {
          if (accountId !== account.id || !scopes.some((s) => granted.includes(s))) return syncGoogleConnections(ctx, presetFor);
          bindAccount(ctx, conn.id, accountId, presetFor);
          // The connect call closed the starting child: list the tools again now, as a callback does for OAuth.
          ctx.broker.invalidate({ connectionId: conn.id });
          ctx.broker.attach(conn.id);
        },
      },
    });
    return { status: "authorize", authorizeUrl: r.authUrl, callbackMode: r.callbackMode, redirectUri: callbackMode(ctx).redirectUri };
  } catch (err) {
    if (err instanceof HttpError) return { status: "error", message: err.hint ? `${err.message} ${err.hint}` : err.message };
    throw err;
  }
}

/**
 * Binds the connection to the account and brings it back on: a reconnect re-enables a disabled (killed) connection, as
 * for any connection kind; its status then follows its access (syncGoogleConnections), and updated_at changes so the
 * console and CLI see the sign-in landed.
 */
function bindAccount(ctx: AppContext, connectionId: string, accountId: string, presetFor: (id: string | null) => IntegrationPreset | null): void {
  ctx.db.run(
    "UPDATE connections SET google_account_id = ?, auth_type = 'oauth', status = CASE WHEN status IN ('disabled', 'error') THEN 'needs_reauth' ELSE status END, updated_at = ? WHERE id = ?",
    accountId,
    now(),
    connectionId,
  );
  syncGoogleConnections(ctx, presetFor, { touch: connectionId });
}

/** "Check again": is each of the extension's APIs on in the project, checked as `account` (an email or id)? */
export async function checkGoogleApis(ctx: AppContext, preset: GooglePreset, idOrEmail: string): Promise<GoogleApiCheck[]> {
  const account = resolveAccount(ctx, idOrEmail);
  if (!account) throw new HttpError(400, "google_account_unknown", `${idOrEmail.slice(0, 100)} isn't connected to xaq.`, "Add it on the Accounts page first.");
  const scopes = extensionScopes(preset.auth);
  const have = accountScopes(account);
  return probeGoogleApis(
    ctx,
    account.id,
    preset.auth.apis,
    scopes.filter((s) => have.includes(s)),
  );
}

/** SetupContext.google for this install: the project ID, the OAuth app type and the connected accounts. */
export function googleSetupContext(ctx: Pick<AppContext, "db" | "settings">): NonNullable<SetupContext["google"]> {
  return {
    projectId: googleProjectId(ctx),
    appType: ctx.settings.getState("google.client")?.appType ?? null,
    accounts: allRows(ctx).map((r) => ({ id: r.id, email: r.email, needsReauth: r.status === "needs_reauth", scopes: accountScopes(r) })),
  };
}
