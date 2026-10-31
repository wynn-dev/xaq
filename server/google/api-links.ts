// Links and commands that turn a Google API on in the user's own Cloud project (pure: no I/O, no AppContext), for
// code extensions' Google setup (server/extensions/google-setup.ts) and the probe (server/google/apis.ts).

import { GOOGLE_SERVICE_RE } from "../../shared/google-scopes.ts";

/** A Google Cloud project ID (6 to 30 lowercase letters, digits and dashes, starting with a letter). */
export const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** The API's page in the project's API Library, with its Enable button. */
export function apiLibraryUrl(service: string, projectId: string | null): string {
  return `https://console.cloud.google.com/apis/library/${encodeURIComponent(service)}${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`;
}

/** `gcloud services enable a b c --project=<id>` (null without a valid project ID or with a bad service name). */
export function enableApisCommand(services: readonly string[], projectId: string | null): string | null {
  if (!projectId || !PROJECT_ID_RE.test(projectId) || !services.length || !services.every((s) => GOOGLE_SERVICE_RE.test(s))) return null;
  return `gcloud services enable ${services.join(" ")} --project=${projectId}`;
}

/** Google Auth Platform → Data Access (the consent screen's scopes) and → Audience (test users) for the project. */
export const dataAccessUrl = (projectId: string) => `https://console.cloud.google.com/auth/scopes?project=${encodeURIComponent(projectId)}`;
export const audienceUrl = (projectId: string) => `https://console.cloud.google.com/auth/audience?project=${encodeURIComponent(projectId)}`;

/** Where a Google user sees and removes what each app may do with their account. */
export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";
