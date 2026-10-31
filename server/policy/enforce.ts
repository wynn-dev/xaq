// Action-side guardrails as pure functions over a Grant: label scope, query rewriting, recipient
// allowlists and send caps. Callers (server/mail/agent.ts, server/calendar/agent.ts) throw these as PolicyDenied.

import type { Capability, GmailLabel, Grant } from "../../shared/types.ts";
import type { Db } from "../db/index.ts";
import { matchesAnyGlob } from "../util/glob.ts";
import { PolicyDenied } from "../util/errors.ts";

/** MCP tools that send mail. Successful calls (sent, draft created, approval queued) count toward send caps. */
export const SEND_ACTIONS = ["send_message", "reply", "forward"] as const;
/** MCP calendar tools that may email people; their successful calls with detail.emailed count toward send caps. */
export const CALENDAR_WRITE_ACTIONS = ["create_calendar_event", "update_calendar_event", "delete_calendar_event", "respond_to_invitation"] as const;

export const CAPABILITY_HELP: Record<Capability, string> = {
  read: "read and search mail",
  draft: "create drafts",
  send: "send mail",
  organize: "change labels, archive or mark read",
  trash: "move mail to the trash",
  "calendar.read": "read calendars and events",
  "calendar.write": "create, change or delete calendar events and answer invitations",
};

// ───────────── Label scope ─────────────

export function inScope(scope: string[] | null, labelIds: Iterable<string>): boolean {
  if (scope === null) return true;
  for (const id of labelIds) if (scope.includes(id)) return true;
  return false;
}

/** Thread-level label union. */
export function threadLabels(thread: { messages?: { labelIds?: string[] }[] }): string[] {
  const out = new Set<string>();
  for (const m of thread.messages ?? []) for (const id of m.labelIds ?? []) out.add(id);
  return [...out];
}

/** The message shown to the agent for out-of-scope or missing ids: never reveals that something exists. */
export const notAccessible = (what: "Thread" | "Message", id: string) =>
  `${what} ${id} was not found or is not accessible to you. Use search_threads to find mail you can access.`;

const SYSTEM_TERMS: Record<string, string> = {
  INBOX: "in:inbox",
  SENT: "in:sent",
  DRAFT: "in:drafts",
  SPAM: "in:spam",
  TRASH: "in:trash",
  CHAT: "in:chats",
  STARRED: "is:starred",
  UNREAD: "is:unread",
  IMPORTANT: "is:important",
  CATEGORY_PERSONAL: "category:primary",
  CATEGORY_SOCIAL: "category:social",
  CATEGORY_PROMOTIONS: "category:promotions",
  CATEGORY_UPDATES: "category:updates",
  CATEGORY_FORUMS: "category:forums",
};

/**
 * Gmail search term for a label: `in:inbox` etc. for system labels; for user labels Gmail's own form,
 * lower-cased with spaces, slashes and other separators replaced by "-" ("Clients/Big Co" →
 * `label:clients-big-co`). Collisions can only widen the match; results are post-filtered by label id.
 */
export function labelSearchTerm(label: GmailLabel): string {
  const system = SYSTEM_TERMS[label.id];
  if (system) return system;
  if (label.type === "system") return `label:${label.id.toLowerCase()}`;
  return `label:${label.name.toLowerCase().replace(/[^\p{L}\p{N}_.-]/gu, "-")}`;
}

/**
 * Checks that parentheses, braces and double quotes are balanced so a query can't close the wrapping
 * group and OR its way out of the scope. Returns an error message, or null when fine.
 */
export function querySyntaxError(q: string): string | null {
  if (q.length > 2000) return "Query is too long (max 2000 characters).";
  let paren = 0;
  let brace = 0;
  let quoted = false;
  for (const ch of q) {
    if (ch === '"') quoted = !quoted;
    if (quoted) continue;
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "{") brace++;
    else if (ch === "}") brace--;
    if (paren < 0 || brace < 0) return "Query has an unmatched closing parenthesis or brace.";
  }
  if (quoted) return "Query has an unmatched double quote.";
  if (paren || brace) return "Query has an unmatched opening parenthesis or brace.";
  return null;
}

/**
 * Gmail search for a scoped grant. One scope label: the exact `labelIds` filter (thread-level, like the
 * scope). Several: the query is ANDed with `(label:a OR label:b)`; Gmail matches q per message, so a
 * thread whose scope label and query terms sit on different messages can be missed (never leaked).
 * Returns null when none of the scope labels exist any more. Callers must still post-filter results.
 */
export function scopedSearch(q: string, scope: string[] | null, labels: GmailLabel[]): { q: string; labelIds?: string[] } | null {
  const userQ = q.trim();
  if (scope === null) return { q: userQ };
  const present = scope.map((id) => labels.find((l) => l.id === id)).filter((l) => l !== undefined);
  if (!present.length) return null;
  if (present.length === 1) return { q: userQ, labelIds: [present[0]!.id] };
  const clause = `(${present.map(labelSearchTerm).join(" OR ")})`;
  return { q: userQ ? `(${userQ}) ${clause}` : clause };
}

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

/**
 * Sends by this agent on this account since `sinceIso` (from the audit log): send/reply/forward calls, and
 * calendar writes that emailed someone or put the event on new attendees' calendars (detail.emailed,
 * detail.invited). Successful ones, plus failures that may still have gone
 * out (detail.maybeSent).
 */
export function sendsSince(db: Db, agentId: string, accountId: string, sinceIso: string): number {
  const list = (xs: readonly string[]) => xs.map(() => "?").join(", ");
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_log
     WHERE actor_type = 'agent' AND actor_id = ? AND ts >= ? AND account_id = ?
       AND (action IN (${list(SEND_ACTIONS)}) OR (action IN (${list(CALENDAR_WRITE_ACTIONS)}) AND (json_extract(detail, '$.emailed') = 1 OR json_extract(detail, '$.invited') > 0)))
       AND (outcome = 'ok' OR (outcome = 'error' AND json_extract(detail, '$.maybeSent') = 1))`,
    agentId,
    sinceIso,
    accountId,
    ...SEND_ACTIONS,
    ...CALENDAR_WRITE_ACTIONS,
  );
  return row?.n ?? 0;
}

/** Sends in flight (checked but not yet audited), per database (= app context), per agent × account. */
const inFlightByDb = new WeakMap<Db, Map<string, number>>();

/**
 * Checks the grant's send caps and reserves a slot, synchronously, so concurrent calls can't all pass the
 * check before any of them is recorded. Call the returned release once the outcome is in the audit log
 * (or the send failed). Caps count messages, not recipients. `hint` replaces the default way out.
 */
export function reserveSend(db: Db, grant: Grant, at = Date.now(), hint?: string): () => void {
  let inFlight = inFlightByDb.get(db);
  if (!inFlight) inFlightByDb.set(db, (inFlight = new Map()));
  const counts = inFlight;
  const key = `${grant.agentId}:${grant.accountId}`;
  const pending = counts.get(key) ?? 0;
  const windows = [
    { cap: grant.maxSendsPerHour, ms: 3_600_000, label: "hour" },
    { cap: grant.maxSendsPerDay, ms: 86_400_000, label: "24 hours" },
  ];
  for (const w of windows) {
    if (w.cap === null) continue;
    const used = sendsSince(db, grant.agentId, grant.accountId, new Date(at - w.ms).toISOString()) + pending;
    if (used >= w.cap) {
      throw new PolicyDenied(
        "rate_limit",
        `Send limit reached: ${used} of ${w.cap} sends in the last ${w.label} for this account. ` +
          (hint ?? "Try again later, or save it as a draft (create_draft, if available) for a human to send."),
      );
    }
  }
  counts.set(key, pending + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (counts.get(key) ?? 1) - 1;
    if (n > 0) counts.set(key, n);
    else counts.delete(key);
  };
}
