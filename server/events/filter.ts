import { z } from "zod";
import { type CalendarEventSummary, type EventType, isConnectionEventType, type WebhookFilter } from "../../shared/types.ts";
import type { StoredEvent } from "./types.ts";
import { matchesAnyGlob } from "../util/glob.ts";
import { RE2_SYNTAX_HINT, subjectMatches, subjectPatternError } from "./regex.ts";

/** Events about the account itself rather than a message: filters only narrow them by account. */
export const ACCOUNT_EVENT_TYPES: readonly EventType[] = ["account.auth_failed", "sync.gap"];

/** Bounds glob backtracking: filters run on attacker-controlled addresses during every emit. */
const MAX_GLOB_STARS = 8;
/** Only this much of the subject is tested against the pattern (bounds matching cost). */
export const MAX_SUBJECT_TESTED = 256;

const list = (max: number, label: string) =>
  z
    .array(z.string().trim().min(1, `${label} entries must not be empty`).max(320))
    .max(max, `At most ${max} ${label} entries`)
    .optional();

const globList = (max: number, label: string) =>
  list(max, label).refine((globs) => !globs?.some((g) => g.split("*").length - 1 > MAX_GLOB_STARS), `${label} patterns may use at most ${MAX_GLOB_STARS} "*"`);

/** Strict, so a misspelled criterion is an error rather than a filter that silently matches everything. */
export const webhookFilterSchema = z
  .object({
    accountIds: list(100, "account"),
    labelIds: list(100, "label"),
    from: globList(100, "from"),
    to: globList(100, "to"),
    subject: z
      .string()
      .max(200, "Subject pattern must be at most 200 characters")
      .optional()
      .superRefine((s, issues) => {
        const error = s === undefined ? null : subjectPatternError(s);
        if (error) issues.addIssue({ code: "custom", message: `Subject pattern is not a valid regular expression (${error}). ${RE2_SYNTAX_HINT}` });
      }),
    hasAttachments: z.boolean().optional(),
    calendarIds: list(100, "calendar"),
  })
  .strict();

/** Drops empty lists and blank values so stored filters stay minimal. */
export function normalizeFilter(f: WebhookFilter): WebhookFilter {
  const out: WebhookFilter = {};
  const lists = ["accountIds", "labelIds", "from", "to", "calendarIds"] as const;
  for (const key of lists) {
    const v = f[key]?.map((s) => s.trim()).filter(Boolean);
    if (v?.length) out[key] = [...new Set(v)];
  }
  if (f.subject?.trim()) out.subject = f.subject;
  if (typeof f.hasAttachments === "boolean") out.hasAttachments = f.hasAttachments;
  return out;
}

/** Whether an event passes a filter. Every set criterion must pass. */
export function matchesFilter(f: WebhookFilter, ev: StoredEvent): boolean {
  if (f.accountIds?.length && !f.accountIds.includes(ev.accountId)) return false;
  if (ACCOUNT_EVENT_TYPES.includes(ev.type)) return true;
  // Connection events have no account (an accountIds filter excludes them, above) and no message.
  if (isConnectionEventType(ev.type)) return true;
  if (ev.calendarEvent) return matchesCalendar(f, ev.calendarEvent, ev.accountEmail);
  const hasMessageCriteria = !!(f.labelIds?.length || f.from?.length || f.to?.length || f.subject || f.hasAttachments !== undefined);
  const m = ev.message;
  if (!m) return !hasMessageCriteria;
  if (f.labelIds?.length) {
    // Label events also match on the labels that changed (a removed label is no longer on the message).
    const labels = new Set([...m.labelIds, ...(ev.labelIds ?? [])]);
    if (!f.labelIds.some((l) => labels.has(l))) return false;
  }
  if (f.from?.length && !(m.from && matchesAnyGlob(m.from.email, f.from))) return false;
  if (f.to?.length && ![...m.to, ...m.cc].some((a) => matchesAnyGlob(a.email, f.to!))) return false;
  if (f.subject && !subjectMatches(f.subject, m.subject.slice(0, MAX_SUBJECT_TESTED))) return false;
  if (f.hasAttachments !== undefined && m.hasAttachments !== f.hasAttachments) return false;
  return true;
}

/**
 * calendar.* events: `calendarIds` picks calendars ("primary" is the account's own), `from` matches the
 * organizer, `to` any attendee and `subject` the summary. labelIds and hasAttachments don't apply.
 */
function matchesCalendar(f: WebhookFilter, e: CalendarEventSummary, accountEmail: string): boolean {
  if (f.calendarIds?.length) {
    const cal = e.calendarId.toLowerCase();
    if (!f.calendarIds.some((id) => (id === "primary" ? accountEmail : id).toLowerCase() === cal)) return false;
  }
  if (f.from?.length && !(e.organizer && matchesAnyGlob(e.organizer.email, f.from))) return false;
  if (f.to?.length && !e.attendees.some((a) => matchesAnyGlob(a.email, f.to!))) return false;
  if (f.subject && !subjectMatches(f.subject, e.summary.slice(0, MAX_SUBJECT_TESTED))) return false;
  return true;
}
