// Google APIs a code extension's account access needs on in the user's own Google Cloud project (docs/EXTENSIONS.md
// "Google accounts for code extensions"): the console deep links, the gcloud command, and a cheap probe per API that
// recognises Google's "API not enabled" answer (SERVICE_DISABLED / accessNotConfigured), as pubsub.ts does.
//
// A probe never uses the account's own token (it can read Gmail): only a downscoped one, for the extension's granted
// scopes when there are any, else for the identity scopes alone. Before consent, an identity-only token can't prove
// an API is on (Google may check the scopes first): that API reads "unchecked" until access is allowed.

import type { AppContext } from "../context.ts";
import { errorMessage } from "../util/errors.ts";
import { safeActivationUrl } from "../calendar/setup.ts";
import { apiLibraryUrl, enableApisCommand, PROJECT_ID_RE } from "./api-links.ts";
import { errorFromResponse, hasReason, isAbortError } from "./http.ts";
import { accountScopes, getRow } from "./accounts.ts";
import { googleAccessToken } from "./scoped.ts";
import { GOOGLE_SERVICE_RE, IDENTITY_TOKEN_SCOPES } from "../../shared/google-scopes.ts";
import { AccountNeedsReauthError, GoogleApiError, ScopesNotGrantedError } from "./types.ts";

export { GOOGLE_SERVICE_RE };
export { apiLibraryUrl, enableApisCommand, PROJECT_ID_RE };

/** One API, as a manifest's `code.auth.apis` names it: `docs.googleapis.com`, "Google Docs API". */
export interface GoogleApiRef {
  service: string;
  label: string;
}

/**
 * enabled: Google answered past its API check. disabled: Google said the API is off in the project. unchecked: xaq
 * couldn't tell yet (no access allowed, or an API xaq has no probe for). error: anything else, with Google's message.
 */
export type GoogleApiState = "enabled" | "disabled" | "unchecked" | "error";

export interface GoogleApiCheck extends GoogleApiRef {
  state: GoogleApiState;
  /** The console page that turns it on in the project (Google's own activationUrl when it sent one). */
  enableUrl: string;
  message: string | null;
}

/** The project ID from the Google step of the setup wizard, when it is one. */
export function googleProjectId(ctx: Pick<AppContext, "settings">): string | null {
  const id = ctx.settings.getState("google.client")?.projectId?.trim() ?? "";
  return PROJECT_ID_RE.test(id) ? id : null;
}

/** A cheap read per known API: 2xx, or a 404 for the made-up id, means Google let the request past its API check. */
const PROBES: Record<string, string> = {
  "drive.googleapis.com": "/drive/v3/about?fields=kind",
  "docs.googleapis.com": "/v1/documents/xaq-api-check",
  "sheets.googleapis.com": "/v4/spreadsheets/xaq-api-check?fields=spreadsheetId",
  "slides.googleapis.com": "/v1/presentations/xaq-api-check?fields=presentationId",
};

const apiBase = (ctx: Pick<AppContext, "config">, service: string) => ctx.config.google.apisBase ?? `https://${service}`;

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Checks each API in the account's project. `scopes`: the extension's scopes the account granted (the probe token is
 * limited to them); empty before consent, when only the identity scopes are used. Never throws for one API's answer.
 */
export async function probeGoogleApis(ctx: AppContext, accountId: string, apis: readonly GoogleApiRef[], scopes: readonly string[]): Promise<GoogleApiCheck[]> {
  const project = googleProjectId(ctx);
  const row = getRow(ctx, accountId);
  const identity = row ? accountScopes(row).filter((s) => IDENTITY_TOKEN_SCOPES.includes(s)) : [];
  const tokenScopes = scopes.length ? [...scopes] : identity;
  let token: string | null = null;
  let tokenProblem: string | null = null;
  if (!row) tokenProblem = "That Google account isn't connected to xaq.";
  else if (!tokenScopes.length) tokenProblem = "xaq can check this once you've allowed access (the next step).";
  else {
    try {
      token = (await googleAccessToken(ctx, accountId, tokenScopes)).accessToken;
    } catch (err) {
      tokenProblem =
        err instanceof AccountNeedsReauthError
          ? `${err.email} needs to be reconnected on the Accounts page first.`
          : err instanceof ScopesNotGrantedError
            ? "xaq can check this once you've allowed access (the next step)."
            : `xaq couldn't get a token to check with: ${errorMessage(err)}`;
    }
  }
  return Promise.all(
    apis.map(async (api): Promise<GoogleApiCheck> => {
      const base = { service: api.service, label: api.label, enableUrl: apiLibraryUrl(api.service, project) };
      const path = PROBES[api.service];
      if (!path) return { ...base, state: "unchecked", message: "xaq can't check this API itself: make sure it's turned on." };
      if (!token) return { ...base, state: "unchecked", message: tokenProblem };
      return { ...base, ...(await probeOne(ctx, api, path, token, !scopes.length)) };
    }),
  );
}

async function probeOne(ctx: AppContext, api: GoogleApiRef, path: string, token: string, identityOnly: boolean): Promise<Pick<GoogleApiCheck, "state" | "message"> & { enableUrl?: string }> {
  let err: GoogleApiError;
  try {
    const res = await fetch(`${apiBase(ctx, api.service).replace(/\/+$/, "")}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok || res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return { state: "enabled", message: null };
    }
    err = await errorFromResponse(res);
  } catch (e) {
    return { state: "error", message: isAbortError(e) ? `Google didn't answer within ${PROBE_TIMEOUT_MS / 1000} s.` : `Couldn't reach Google: ${errorMessage(e)}` };
  }
  if (hasReason(err, "SERVICE_DISABLED", "accessNotConfigured") || /has not been used in project|is disabled/i.test(err.message)) {
    const activation = safeActivationUrl(err.details.metadata?.activationUrl);
    return { state: "disabled", message: `The ${api.label} is turned off in your Google Cloud project.`, ...(activation ? { enableUrl: activation } : {}) };
  }
  if (err.status === 403 && (hasReason(err, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions") || /insufficient authentication scopes/i.test(err.message))) {
    return {
      state: "unchecked",
      message: identityOnly ? "xaq can check this once you've allowed access (the next step)." : "This access wasn't granted, so xaq can't check this API with it.",
    };
  }
  return { state: "error", message: `Google answered HTTP ${err.status}: ${err.message.slice(0, 200)}` };
}
