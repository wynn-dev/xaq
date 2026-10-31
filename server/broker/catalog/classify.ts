// Risk classification. The word lists below are the single source:
// the doc quotes them, keep the two in sync.

import type { IntegrationPreset, ToolClass, ToolDef } from "../types.ts";

export const CLASSIFICATION_WORDS = {
  /** Name check (always runs): a name token that is one of these verbs makes the tool risky. Nouns don't count. */
  riskyVerbs: [
    "delete", "remove", "destroy", "drop", "purge", "trash", "erase", "wipe",
    "send", "reply", "forward", "publish", "share", "post", "invite",
    "pay", "charge", "transfer", "refund", "purchase", "merge",
  ],
  /**
   * Description check (only without annotations): a sentence containing one of these base/imperative forms, or one
   * of `descriptionVerbForms`, makes the tool risky. post, reply and drop are left out: too ambiguous as nouns.
   */
  descriptionVerbs: [
    "delete", "remove", "destroy", "purge", "erase", "wipe", "trash", "send", "forward", "publish", "share", "invite",
    "charge", "transfer", "refund", "purchase", "pay",
  ],
  descriptionVerbForms: [
    "deletes", "deleted", "deleting", "removes", "removed", "removing", "destroys", "destroyed", "destroying",
    "purges", "purged", "purging", "erases", "erased", "erasing", "wipes", "wiped", "wiping",
    "trashes", "trashed", "trashing", "sends", "sent", "sending", "forwards", "forwarded", "forwarding",
    "publishes", "published", "publishing", "shares", "shared", "sharing", "invites", "invited", "inviting",
    "charges", "charged", "charging", "transfers", "transferred", "transferring", "refunds", "refunded", "refunding",
    "purchases", "purchased", "purchasing", "pays", "paid", "paying",
  ],
  /** Description sentences starting with one of these report rather than act: the description check skips them. */
  reportingStarts: ["returns", "lists", "gets"],
  /**
   * A name whose first token is one of these is a read: the risky verb IMMEDIATELY after it doesn't count
   * (get_post, list_shares), any later one does (get_and_delete_messages). Unannotated and not risky: a read tool.
   */
  readPrefixes: ["get", "list", "search", "find", "read", "fetch", "query", "describe", "count", "lookup", "view"],
  /** `schedule` + one of these nouns is a deferred send (slack_schedule_message): risky. */
  scheduleNouns: ["message", "mail", "email", "dm", "sms"],
  /**
   * A first token that is one of these (or a risky or read verb) is an action, never a server prefix. Otherwise a
   * first token followed by a read verb is a server prefix (notion-get-page, slack_list_channels) and is skipped.
   */
  nonPrefixVerbs: [
    "add", "append", "apply", "approve", "archive", "assign", "cancel", "clear", "close", "copy", "create", "disable",
    "edit", "enable", "execute", "export", "import", "insert", "make", "mark", "modify", "move", "open", "patch", "put",
    "rename", "replace", "reset", "restore", "run", "save", "schedule", "set", "start", "stop", "submit", "sync",
    "toggle", "update", "upload", "upsert", "write",
  ],
} as const;

/** Splits on `_`, `-`, `.`, any other non-alphanumeric, and camelCase (`HTTPSendMail` → http, send, mail). Lowercase. */
export function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const W = CLASSIFICATION_WORDS;
const RISKY_VERBS: ReadonlySet<string> = new Set(W.riskyVerbs);
const DESCRIPTION_WORDS: ReadonlySet<string> = new Set([...W.descriptionVerbs, ...W.descriptionVerbForms]);
const READ_PREFIXES: ReadonlySet<string> = new Set(W.readPrefixes);
const REPORTING: ReadonlySet<string> = new Set(W.reportingStarts);
const SCHEDULE_NOUNS: ReadonlySet<string> = new Set(W.scheduleNouns);
const ACTIONS: ReadonlySet<string> = new Set([...W.nonPrefixVerbs, ...W.riskyVerbs, ...W.readPrefixes]);

/** The name's tokens without a server prefix (`notion-get-page` → get, page). */
export function nameCore(name: string): string[] {
  const words = splitWords(name);
  if (words.length >= 2 && !ACTIONS.has(words[0]!) && READ_PREFIXES.has(words[1]!)) return words.slice(1);
  return words;
}

const isDraft = (w: string) => w === "draft" || w === "drafts";

/**
 * Risky by name:
 * - a risky verb token, except the one immediately after a leading read verb (get_post);
 * - `schedule` plus a messaging noun (slack_schedule_message);
 * - a `draft` token AFTER a `send` or `schedule` token cancels that token's risk (slack_send_message_draft,
 *   schedule_draft_message), except directly after `send` (send_draft sends the draft). A draft before it doesn't
 *   (drafts_send, draft_and_send_email send).
 */
function riskyName(core: string[]): boolean {
  const draftAfter = (i: number, gap: number) => core.some((w, j) => j >= i + gap && isDraft(w));
  const readFirst = READ_PREFIXES.has(core[0] ?? "");
  const verb = core.some((w, i) => RISKY_VERBS.has(w) && !(readFirst && i === 1) && !(w === "send" && draftAfter(i, 2)));
  const scheduled = core.some((w, i) => w === "schedule" && !draftAfter(i, 1)) && core.some((w) => SCHEDULE_NOUNS.has(w));
  return verb || scheduled;
}

/** A description is risky when a sentence that doesn't start with Returns/Lists/Gets has a risky verb form. */
function riskyDescription(text: string): boolean {
  for (const sentence of text.split(/[.!?;\n]+/)) {
    const words = splitWords(sentence);
    if (!words.length || REPORTING.has(words[0]!)) continue;
    if (words.some((w) => DESCRIPTION_WORDS.has(w))) return true;
  }
  return false;
}

/** Classifies one cleaned definition. `preset` is the connection's preset, if any. */
export function classifyTool(def: ToolDef, preset?: Pick<IntegrationPreset, "classify" | "nameCheckExempt"> | null): ToolClass {
  const core = nameCore(def.name);
  const riskyByName = riskyName(core);

  // 1. The preset says so itself. The name check still applies (a renamed upstream tool can't escape it), except for
  //    the exact names the preset lists as reviewed false positives (T3's t3_thread_send stays inside T3).
  const fromPreset = preset?.classify(def) ?? null;
  if (fromPreset) {
    const exempt = preset?.nameCheckExempt?.includes(def.name) === true;
    const risky = fromPreset.risky || (riskyByName && !exempt);
    return { ...fromPreset, risky, read: fromPreset.read && !risky, source: "preset" };
  }

  // 2. Annotations: destructiveHint → risky, readOnlyHint → read (unless the name says otherwise).
  const a = def.annotations;
  const annotated = typeof a?.readOnlyHint === "boolean" || typeof a?.destructiveHint === "boolean";
  if (annotated) {
    const risky = a?.destructiveHint === true || riskyByName;
    const read = !risky && a?.readOnlyHint === true;
    const source = riskyByName && a?.destructiveHint !== true ? "heuristic" : "annotation";
    return { risky, read, source };
  }

  // 3. No annotations: the name and the description. Read-only: a leading read verb (after any server prefix).
  const risky = riskyByName || riskyDescription(def.description ?? "");
  const read = !risky && READ_PREFIXES.has(core[0] ?? "");
  return { risky, read, source: "heuristic" };
}
