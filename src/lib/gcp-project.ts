// Google Cloud project IDs: validation, suggestions and the Cloud Shell commands (pure, unit-tested).

import { shellQuote } from "./cli.ts";

/** A project ID as Google accepts it: 6–30 chars, lowercase letters, digits and hyphens, starting with a letter. */
export const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Same as PROJECT_ID_RE, also accepting the legacy domain-scoped form (`example.com:my-project`) the server accepts. */
export const PROJECT_ID_WITH_DOMAIN_RE = /^([a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** A fresh project ID suggestion: "xaq-" + 6 random digits (Google IDs are global, so make a clash unlikely). */
export function generateProjectId(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return `xaq-${String(n).padStart(6, "0")}`;
}

/** Specific, fixable message for a project ID, or null when it's valid. */
export function projectIdProblem(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Enter the project ID.";
  if (/^\d+$/.test(v)) return "That's the project number. Use the project ID: lowercase letters, digits and hyphens, like xaq-123456.";
  if (/[A-Z ]/.test(v)) return "That looks like the project name. Use the project ID: lowercase, no spaces, like xaq-123456.";
  if (v.length < 6 || v.length > 30) return "Project IDs are 6 to 30 characters long.";
  if (!/^[a-z]/.test(v)) return "Project IDs start with a lowercase letter.";
  if (/-$/.test(v)) return "Project IDs can't end with a hyphen.";
  if (!PROJECT_ID_RE.test(v)) return "Use only lowercase letters, digits and hyphens.";
  return null;
}

/** The Google Calendar API's service name (docs/calendar.md, "API id"). */
export const CALENDAR_API = "calendar-json.googleapis.com";

/**
 * The Cloud Shell command: create the project, then enable the Gmail and Calendar APIs in it. Not
 * Pub/Sub: Google may want a billing account before it enables Pub/Sub, which would fail the whole
 * command on the required path. Pub/Sub is enabled in the optional real-time delivery step instead.
 * Returns null for an invalid ID (it goes into a shell, so only ever a validated one).
 */
export function projectCommand(id: string, inOrg: boolean): string | null {
  if (!PROJECT_ID_RE.test(id)) return null;
  const org = inOrg ? ` --organization="$(gcloud organizations list --format='value(name.basename())' --limit=1)"` : "";
  return (
    `gcloud projects create ${id} --name=xaq${org} && ` +
    `gcloud services enable gmail.googleapis.com ${CALENDAR_API} --project=${id} && ` +
    `echo "xaq: project ${id} is ready"`
  );
}

/**
 * Gives `email` the Pub/Sub Admin role on the project (run by the project owner in Cloud Shell).
 * Both values are shell-quoted; null when the project ID isn't valid.
 */
export function iamBindingCommand(projectId: string, email: string): string | null {
  if (!PROJECT_ID_WITH_DOMAIN_RE.test(projectId) || !email.trim()) return null;
  return `gcloud projects add-iam-policy-binding ${shellQuote(projectId)} --member=${shellQuote(`user:${email.trim()}`)} --role=roles/pubsub.admin`;
}

// ───────────── Google Cloud console links ─────────────

const p = (id: string) => encodeURIComponent(id);

/** Console deep links, preselecting the project. */
export const cloudUrl = {
  cloudShell: "https://shell.cloud.google.com/?show=terminal",
  createProject: "https://console.cloud.google.com/projectcreate",
  /** The Gmail API (step 2): enabling Pub/Sub may need billing, so it is enabled in step 6. */
  enableGmail: (id: string) => `https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com&project=${p(id)}`,
  /** The Calendar API (step 2, and "Add Google Calendar" on installs from before Calendar). */
  enableCalendar: (id: string) => `https://console.cloud.google.com/flows/enableapi?apiid=${CALENDAR_API}&project=${p(id)}`,
  enablePubsub: (id: string) => `https://console.cloud.google.com/flows/enableapi?apiid=pubsub.googleapis.com&project=${p(id)}`,
  dashboard: (id: string) => `https://console.cloud.google.com/home/dashboard?project=${p(id)}`,
  authOverview: (id: string) => `https://console.cloud.google.com/auth/overview?project=${p(id)}`,
  authAudience: (id: string) => `https://console.cloud.google.com/auth/audience?project=${p(id)}`,
  authScopes: (id: string) => `https://console.cloud.google.com/auth/scopes?project=${p(id)}`,
  clients: (id: string) => `https://console.cloud.google.com/auth/clients?project=${p(id)}`,
  createClient: (id: string) => `https://console.cloud.google.com/auth/clients/create?project=${p(id)}`,
  iam: (id: string) => `https://console.cloud.google.com/iam-admin/iam?project=${p(id)}`,
  orgPolicies: (id: string) => `https://console.cloud.google.com/iam-admin/orgpolicies?project=${p(id)}`,
  billing: (id: string) => `https://console.cloud.google.com/billing/linkedaccount?project=${p(id)}`,
};
