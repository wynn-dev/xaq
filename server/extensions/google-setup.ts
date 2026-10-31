// The setup steps core renders for a code extension with `"code.auth": { "type": "google" }` (docs/EXTENSIONS.md
// "Google accounts for code extensions"), before the manifest's own steps. Pure: everything comes from SetupContext,
// so the console (PresetView.setupSteps) shows the same four steps for every such extension:
//   1. pick the Google account (from xaq's connected accounts; a link to add one);
//   2. turn on the APIs in the user's own Cloud project (a link per API, a gcloud command, "Check again");
//   3. allow access on Google's screen (what it will ask, tick every box, the "unverified app" warning);
//   4. done (what was granted, anything missing, and how to take it back).

import type { PresetAuth, SetupContext, SetupStep } from "../broker/types.ts";
import { apiLibraryUrl, enableApisCommand, GOOGLE_PERMISSIONS_URL } from "../google/api-links.ts";
import { hasScopes, scopeGrants } from "../google/scopes.ts";

export type GoogleAuth = Extract<PresetAuth, { type: "google" }>;

/** The setup input that names the Google account (an email or an account id) in StartConnectInput.inputs. */
export const GOOGLE_ACCOUNT_INPUT = "google_account";

/** The ids of core's Google steps (a manifest can't use the google- prefix for its own). */
export const GOOGLE_STEP_IDS = ["google-account", "google-apis", "google-consent", "google-done"] as const;

export function googleSetupSteps(displayName: string, auth: GoogleAuth, ctx: SetupContext): SetupStep[] {
  const g = ctx.google ?? null;
  const project = g?.projectId ?? null;
  const accounts = g?.accounts ?? [];
  const command = enableApisCommand(
    auth.apis.map((a) => a.service),
    project,
  );
  const account: SetupStep = {
    id: "google-account",
    title: "Pick the Google account",
    body: accounts.length
      ? `${displayName} works as one of the Google accounts connected to xaq, with only the access in step 3. It never gets that account's mail, calendar or sign-in: xaq hands it short-lived tokens limited to that access.`
      : `No Google account is connected to xaq yet. Add one first (Accounts → Connect account), then come back to this step.`,
    link: { label: "Add a Google account", url: `${ctx.publicUrl}/accounts` },
    input: {
      key: GOOGLE_ACCOUNT_INPUT,
      label: "Google account",
      placeholder: "you@example.com",
      choices: accounts.map((a) => ({
        value: a.email,
        label: a.email,
        ...(a.needsReauth
          ? { disabled: true, note: "needs reconnecting on the Accounts page first" }
          : hasScopes(a.scopes, auth.scopes)
            ? { note: "already has this access" }
            : {}),
      })),
    },
  };
  const apis: SetupStep = {
    id: "google-apis",
    title: "Turn on the Google APIs in your Cloud project",
    body:
      `${displayName} calls ${auth.apis.length === 1 ? "this Google API" : "these Google APIs"} through your own Google Cloud project${project ? ` (${project})` : ""}, the one xaq's Google sign-in belongs to. ` +
      `Open each link and click Enable${command ? ", or run the command below" : ""}, then Check again. A newly enabled API can take a minute to work.` +
      (project ? "" : "\n\nxaq doesn't know your project ID yet: finish the Google step of xaq's setup first, or pick your project at the top of each page."),
    apis: auth.apis.map((a) => ({ service: a.service, label: a.label, url: apiLibraryUrl(a.service, project) })),
    ...(command ? { copy: { label: "Or run this (Cloud Shell or gcloud)", value: command } } : {}),
    check: "google_apis",
  };
  const unverified = g?.appType !== "internal";
  const consent: SetupStep = {
    id: "google-consent",
    title: "Allow access on Google's screen",
    body:
      `Next, Google asks the account to let xaq ${auth.scopes.map(scopeGrants).join("; ")}. Only these new permissions are asked for: the account's mail and anything else it already allowed stay as they are.\n\n` +
      "Tick every box. Google lets you untick some, and whatever you untick won't work in the extension (xaq says which)." +
      (unverified
        ? `\n\nGoogle may first say "Google hasn't verified this app". It's your own app, from your own Cloud project, so that's expected: click Advanced, then "Go to <your app name> (unsafe)". If your app is in Testing, the account must be one of its test users.`
        : ""),
  };
  const done: SetupStep = {
    id: "google-done",
    title: "Done",
    body:
      `The connection shows the access Google granted, and explains anything missing. Removing ${displayName} or this connection doesn't take that access back from the account (xaq's own features may use it too). ` +
      "To take it back, remove xaq's access on your Google account's permissions page. That removes all of xaq's access at once, mail included, so reconnect the account in xaq afterwards.",
    link: { label: "Google account permissions", url: GOOGLE_PERMISSIONS_URL },
  };
  return [account, apis, consent, done];
}
