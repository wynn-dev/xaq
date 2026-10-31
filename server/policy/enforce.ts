// Action-side guardrails as pure functions over a Grant: the recipient allowlist. Callers
// (server/mail/agent.ts, server/calendar/agent.ts) throw these as PolicyDenied.

import type { Grant } from "../../shared/types.ts";
import { matchesAnyGlob } from "../util/glob.ts";
import { PolicyDenied } from "../util/errors.ts";

/** Thread-level label union. */
export function threadLabels(thread: { messages?: { labelIds?: string[] }[] }): string[] {
  const out = new Set<string>();
  for (const m of thread.messages ?? []) for (const id of m.labelIds ?? []) out.add(id);
  return [...out];
}

/** The message shown to the agent for missing ids. */
export const notAccessible = (what: "Thread" | "Message", id: string) =>
  `${what} ${id} was not found or is not accessible to you. Use search_threads to find mail you can access.`;

// ───────────── Send rules ─────────────

/** Recipients the grant's allowlist doesn't cover (empty allowlist = anyone). */
export function disallowedRecipients(grant: Grant, emails: string[]): string[] {
  if (!grant.allowTo.length) return [];
  return emails.filter((e) => !matchesAnyGlob(e, grant.allowTo));
}

export function assertRecipientsAllowed(grant: Grant, emails: string[], hint?: string): void {
  const bad = disallowedRecipients(grant, emails);
  if (bad.length) {
    throw new PolicyDenied(
      "allow_to",
      `Not allowed to send to ${bad.join(", ")}. This account only lets you send to: ${grant.allowTo.join(", ")}. ` +
        (hint ?? "Remove those recipients, or ask the operator to extend the allowlist."),
    );
  }
}
