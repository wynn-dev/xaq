// Downscoped Google access for core code and for code extensions (docs/EXTENSIONS.md "Google accounts for code
// extensions"). A connected account's refresh token covers everything it granted xaq (Gmail at least); a caller that
// needs only Drive gets a token for Drive only, minted with the refresh grant's `scope` (TokenManager.scopedAccessToken).
//
// For core code (Gmail's attach-from-Drive):
//   if (accountHasScopes(ctx, accountId, [DRIVE_READONLY_SCOPE])) {
//     const { accessToken } = await googleAccessToken(ctx, accountId, [DRIVE_READONLY_SCOPE]);
//   }

import type { AppContext } from "../context.ts";
import { accountScopes, getRow } from "./accounts.ts";
import { googleRuntime } from "./runtime.ts";
import { hasScopes, missingScopes } from "../../shared/google-scopes.ts";
import type { ScopedToken } from "./tokens.ts";

export type { ScopedToken };

/** The scopes the account has granted xaq, as last recorded (every token response backfills them); [] when unknown. */
export function grantedScopes(ctx: Pick<AppContext, "db">, accountId: string): string[] {
  const row = getRow(ctx, accountId);
  return row ? accountScopes(row) : [];
}

/** Whether the account has granted xaq every one of `scopes` (as last recorded). False for an unknown account. */
export function accountHasScopes(ctx: Pick<AppContext, "db">, accountId: string, scopes: readonly string[]): boolean {
  const row = getRow(ctx, accountId);
  return !!row && hasScopes(accountScopes(row), scopes);
}

/** The ones of `scopes` the account hasn't granted (all of them for an unknown account). */
export function accountMissingScopes(ctx: Pick<AppContext, "db">, accountId: string, scopes: readonly string[]): string[] {
  const row = getRow(ctx, accountId);
  return row ? missingScopes(accountScopes(row), scopes) : [...scopes];
}

/**
 * An access token for the account limited to `scopes` (a subset of what it granted), with its expiry in epoch ms and
 * the scopes Google says it has. Cached per account and scope set until it nearly expires; one refresh in flight.
 * Throws ScopesNotGrantedError (not granted: ask for consent), AccountNeedsReauthError (the sign-in is gone) or
 * DownscopeError (Google's answer didn't prove the limit; never returned).
 */
export function googleAccessToken(ctx: AppContext, accountId: string, scopes: readonly string[], opts: { force?: boolean } = {}): Promise<ScopedToken> {
  return googleRuntime(ctx).tokens.scopedAccessToken(accountId, scopes, opts);
}
