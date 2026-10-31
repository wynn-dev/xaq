// Text formatting of tool results. Compact and scannable: agents read these.

import {
  type Account,
  type CalendarAttendee,
  type CalendarEventSummary,
  type CalendarInfo,
  type GmailLabel,
  type Grant,
  isCalendarEventType,
  type MailEvent,
  type MessageContent,
} from "../../shared/types.ts";
import type { CalendarWriteOutcome } from "../calendar/agent.ts";
import { eventSummarySignals } from "../calendar/content.ts";
import type { FeedResult } from "../events/types.ts";
import type { RenderedMessage, SendOutcome, ThreadSummary } from "../mail/agent.ts";
import { cleanLine, formatAddress, formatAddresses, labelNames, renderMessage, signalLine, wrapUntrusted } from "../mail/content.ts";

const CALENDAR_STATUS_HELP: Record<NonNullable<Account["calendar"]>["status"], string | null> = {
  active: null,
  not_granted: "Google Calendar isn't added to this account yet (ask the operator to add it in the xaq console)",
  api_disabled: "the Google Calendar API is turned off in the Google Cloud project (ask the operator to enable it)",
  error: "calendar sync is failing (calendar tools may still work)",
};

/** Untrusted one-liners (subjects, snippets) go through the same cleaning as bodies. */
const clip = (s: string, n: number) => cleanLine(s, n);

export function formatAccounts(items: { grant: Grant; account: Account }[]): string {
  if (!items.length) return "You don't have access to any account yet. Ask the operator to grant this agent access in the xaq console.";
  const lines = [`You can access ${items.length} account${items.length === 1 ? "" : "s"}:`];
  for (const { grant: g, account: a } of items) {
    lines.push(`- ${a.email} (account id ${a.id})${a.status === "active" ? "" : ` · status: ${a.status}`}`);
    lines.push(
      g.level === "full"
        ? "  access: full (read, organize, trash, draft and send mail; read and change calendars). Sends and calendar changes apply at once"
        : "  access: read only (mail and calendars)",
    );
    if (g.level === "full" && g.allowTo.length) lines.push(`  recipients and attendees limited to ${g.allowTo.join(", ")}`);
    const problem = a.calendar ? CALENDAR_STATUS_HELP[a.calendar.status] : CALENDAR_STATUS_HELP.not_granted;
    if (problem) lines.push(`  calendar: ${problem}`);
  }
  return lines.join("\n");
}

export function formatLabels(account: Account, labels: GmailLabel[]): string {
  const sorted = [...labels].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "system" ? -1 : 1));
  const lines = [`Labels in ${account.email}:`];
  for (const l of sorted) lines.push(`- ${clip(l.name, 200)}${l.name !== l.id ? ` (id ${l.id})` : ""}`);
  return lines.join("\n");
}

export function formatSearch(
  account: Account,
  query: string,
  threads: ThreadSummary[],
  nextPageToken: string | null,
  labels: GmailLabel[] | null,
  hidden = 0,
): string {
  const more = nextPageToken ? `More results: call again with page_token "${nextPageToken}".` : null;
  if (!threads.length) {
    if (more) return `No results you can access on this page${hidden ? ` (${hidden} skipped)` : ""}; more may follow. ${more}`;
    return `No threads found in ${account.email} for ${query.trim() ? `"${clip(query, 200)}"` : "this search"}.`;
  }
  const lines = [`${threads.length} thread${threads.length === 1 ? "" : "s"} in ${account.email}${query.trim() ? ` for "${clip(query, 200)}"` : ""}:`];
  threads.forEach((t, i) => {
    const meta = [
      `thread_id: ${t.id}`,
      t.date,
      `From: ${formatAddress(t.from)}`,
      `${t.messageCount} message${t.messageCount === 1 ? "" : "s"}`,
      t.hasAttachments ? "has attachments" : null,
    ].filter(Boolean);
    lines.push(`${i + 1}. ${clip(t.subject, 200) || "(no subject)"}`);
    lines.push(`   ${meta.join(" · ")}`);
    if (t.labelIds.length) lines.push(`   Labels: ${labelNames(t.labelIds, labels).join(", ")}`);
    if (t.snippet) lines.push(`   Snippet: ${clip(t.snippet, 200)}`);
  });
  if (more) lines.push(more);
  return lines.join("\n");
}

export function formatThread(account: Account, threadId: string, messages: RenderedMessage[], labels: GmailLabel[] | null, maxChars: number): string {
  const head = `Thread ${threadId} in ${account.email} (${messages.length} message${messages.length === 1 ? "" : "s"}, oldest first)`;
  return [head, ...messages.map((m) => renderMessage(m.summary, m.content, labels, maxChars))].join("\n\n---\n\n");
}

export const formatMessage = (m: RenderedMessage, labels: GmailLabel[] | null, maxChars: number) =>
  renderMessage(m.summary, m.content, labels, maxChars);

export function formatSendOutcome(o: SendOutcome): string {
  return JSON.stringify({ status: "sent", ...o }, null, 2);
}

// ───────────── Calendar ─────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Weekday of the wall-clock date at the start of an RFC 3339 date or date-time ("2026-10-20…" → "Tue"). */
export function weekday(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? WEEKDAYS[new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).getUTCDay()]! : "";
}

/** The day before a YYYY-MM-DD date (all-day ends are exclusive). */
function dayBefore(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? date : new Date(t - 86_400_000).toISOString().slice(0, 10);
}

/** "+02:00" as is; every spelling of a zero offset ("", "Z", "+00:00", "-00:00") as "Z". */
const normalOffset = (o: string) => (/^(z|[+-]00:00)?$/i.test(o) ? "Z" : o);

/** The UTC offset of `zone` at the instant `dateTime` ("+02:00", "Z" for UTC), or null when unknown. */
function zoneOffsetAt(zone: string, dateTime: string): string | null {
  const t = Date.parse(dateTime);
  if (Number.isNaN(t)) return null;
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(t).find((p) => p.type === "timeZoneName")?.value;
    return name ? normalOffset(name.replace(/^GMT/, "")) : null;
  } catch {
    return null;
  }
}

/**
 * The event's time zone as a label for the shown time, only when it matches the offset Google gave: imported
 * (ICS) events often say UTC while their times carry the calendar's offset, and "(UTC)" next to +02:00 misleads.
 */
function zoneLabel(e: Pick<CalendarEventSummary, "start" | "timeZone">): string {
  if (!e.timeZone) return "";
  const shown = /(Z|[+-]\d{2}:\d{2})$/i.exec(e.start)?.[1]?.toUpperCase();
  if (shown) {
    const offset = zoneOffsetAt(e.timeZone, e.start);
    if (offset === null || offset !== normalOffset(shown)) return "";
  }
  return ` (${clip(e.timeZone, 64)})`;
}

/** Events of a subscribed (imported ICS) calendar: Google reports the importing user as their organizer. */
const isImported = (e: Pick<CalendarEventSummary, "calendarId" | "organizer">) =>
  [e.calendarId, e.organizer?.email ?? ""].some((id) => /@import\.calendar\.google\.com$/i.test(id));

/**
 * When an event happens, as agents need it: weekday spelled out (agents are bad at computing it), all-day
 * ranges inclusive, timed events with their UTC offsets as Google gave them, plus the event's time zone when
 * it agrees with those offsets.
 */
export function formatWhen(e: Pick<CalendarEventSummary, "start" | "end" | "allDay" | "timeZone">): string {
  if (!e.start) return "(no time)";
  if (e.allDay) {
    const last = e.end ? dayBefore(e.end) : e.start;
    return last > e.start ? `all day, ${weekday(e.start)} ${e.start} to ${weekday(last)} ${last}` : `all day, ${weekday(e.start)} ${e.start}`;
  }
  const sameDay = e.end.slice(0, 10) === e.start.slice(0, 10);
  const end = e.end ? ` → ${sameDay ? "" : `${weekday(e.end)} `}${e.end}` : "";
  return `${weekday(e.start)} ${e.start}${end}${zoneLabel(e)}`;
}

function formatAttendee(a: CalendarAttendee): string {
  const tags = [a.self ? "you" : null, a.organizer ? "organizer" : null, a.resource ? "room" : null, a.optional ? "optional" : null, a.responseStatus];
  return `${formatAddress({ name: a.name, email: a.email })} (${tags.filter(Boolean).join(", ")})`;
}

const RESPONSE_HELP: Record<string, string> = {
  needsAction: "not answered yet",
  accepted: "accepted",
  tentative: "maybe (tentative)",
  declined: "declined",
};

export function formatCalendars(account: Account, calendars: CalendarInfo[]): string {
  if (!calendars.length) return `No calendars of ${account.email} are available to you.`;
  const lines = [`${calendars.length} calendar${calendars.length === 1 ? "" : "s"} in ${account.email} you can use:`];
  for (const c of calendars) {
    const meta = [`calendar_id: ${clip(c.id, 320)}`, c.primary ? "primary" : null, `access: ${c.accessRole}`, c.timeZone ? `time zone ${clip(c.timeZone, 64)}` : null];
    lines.push(`- ${clip(c.name, 200) || "(unnamed)"}`, `  ${meta.filter(Boolean).join(" · ")}`);
  }
  lines.push('Pass calendar_id to the other calendar tools; "primary" (the default) is the account\'s main calendar.');
  return lines.join("\n");
}

/** Flags worth a glance on a one-line event (lists and the feed): instruction-like text, external organizer. */
function eventFlags(e: CalendarEventSummary, accountEmail: string): string[] {
  const s = eventSummarySignals(e, accountEmail);
  return [s.external && e.selfResponse === "needsAction" ? "external organizer" : null, s.suspiciousInstructions.length ? "contains instruction-like text" : null].filter(
    (x): x is string => !!x,
  );
}

function eventLines(e: CalendarEventSummary, accountEmail: string, indent: string): string[] {
  const lines = [`${indent}${formatWhen(e)} · event_id: ${clip(e.id, 1024)}`];
  const meta = [
    e.location ? `Where: ${clip(e.location, 160)}` : null,
    isImported(e) ? "imported calendar" : e.organizer && !e.organizerSelf ? `Organizer: ${formatAddress(e.organizer)}` : e.organizerSelf ? "You organize it" : null,
    e.attendeeCount ? `${e.attendeeCount} attendee${e.attendeeCount === 1 ? "" : "s"}` : null,
    e.selfResponse ? `your response: ${RESPONSE_HELP[e.selfResponse]}` : null,
    e.conferenceUrl ? "video call" : null,
    e.recurringEventId ? `recurring, series: ${clip(e.recurringEventId, 1024)}` : e.recurring ? "recurring series" : null,
    e.status !== "confirmed" ? `status: ${e.status}` : null,
    e.eventType !== "default" ? `type: ${clip(e.eventType, 40)}` : null,
    ...eventFlags(e, accountEmail),
  ].filter(Boolean);
  if (meta.length) lines.push(`${indent}${meta.join(" · ")}`);
  return lines;
}

export function formatCalendarEvents(
  account: Account,
  r: { calendarId: string; events: CalendarEventSummary[]; nextPageToken: string | null; timeZone: string | null },
  range: { timeMin: string; timeMax: string; query?: string },
): string {
  const where = `calendar ${clip(r.calendarId, 320)} (${account.email})`;
  const span = `${range.timeMin} → ${range.timeMax}${range.query?.trim() ? ` matching "${clip(range.query, 200)}"` : ""}`;
  const more = r.nextPageToken ? `More events: call again with page_token "${r.nextPageToken}".` : null;
  if (!r.events.length) return [`No events in ${where} for ${span}.`, more].filter(Boolean).join(" ");
  const lines = [
    `${r.events.length} event${r.events.length === 1 ? "" : "s"} in ${where}, ${span}, by start time${r.timeZone ? `; the calendar's time zone is ${clip(r.timeZone, 64)}` : ""}:`,
  ];
  r.events.forEach((e, i) => {
    lines.push(`${i + 1}. ${clip(e.summary, 200) || "(no title)"}`, ...eventLines(e, account.email, "   "));
  });
  lines.push("Titles, locations and names are written by whoever created each event; read one with get_calendar_event.");
  if (more) lines.push(more);
  return lines.join("\n");
}

/** One event with its description wrapped as untrusted, like a mail message. Every free-text field is cleaned. */
export function formatCalendarEvent(account: Account, e: CalendarEventSummary, content: MessageContent | null, maxChars: number): string {
  const lines = [`Event ${clip(e.id, 1024)} in calendar ${clip(e.calendarId, 320)} (${account.email})`, `Title: ${clip(e.summary, 300) || "(no title)"}`];
  lines.push(`When: ${formatWhen(e)}`);
  if (e.recurring) lines.push("Repeats: this is a recurring series (changes apply to every occurrence)");
  else if (e.recurringEventId) lines.push(`Repeats: one occurrence of the series ${clip(e.recurringEventId, 1024)}`);
  if (e.location) lines.push(`Where: ${clip(e.location, 300)}`);
  if (e.conferenceUrl) lines.push(`Video call: ${clip(e.conferenceUrl, 300)}`);
  if (isImported(e)) lines.push("Organizer: none shown (an imported calendar: Google lists the subscriber as organizer)");
  else if (e.organizer) lines.push(`Organizer: ${formatAddress(e.organizer)}${e.organizerSelf ? " (you)" : ""}`);
  if (e.attendeeCount) {
    const extra = e.attendeeCount - e.attendees.length;
    lines.push(`Attendees (${e.attendeeCount}): ${e.attendees.map(formatAttendee).join("; ")}${extra > 0 ? `; and ${extra} more` : ""}`);
  }
  if (e.selfResponse) {
    const hint = e.selfResponse === "needsAction" && !e.organizerSelf ? " (answer with respond_to_invitation if your user wants to)" : "";
    lines.push(`Your response: ${RESPONSE_HELP[e.selfResponse]}${hint}`);
  }
  if (e.status !== "confirmed") lines.push(`Status: ${e.status}`);
  if (e.eventType !== "default") lines.push(`Type: ${clip(e.eventType, 40)}`);
  if (e.htmlLink) lines.push(`Link: ${clip(e.htmlLink, 500)}`);
  const signals = signalLine(content?.signals ?? eventSummarySignals(e, account.email));
  if (signals) lines.push(signals);
  const from = e.organizer?.email ?? null;
  lines.push(wrapUntrusted(from, content?.body || "(no description)", "calendar_content"));
  if (content?.truncated) lines.push(`[Description truncated${maxChars ? ` at ${maxChars} characters (operator setting maxBodyChars)` : ""}.]`);
  return lines.join("\n");
}

export function formatFreeBusy(
  account: Account,
  calendars: { id: string; busy: { start: string; end: string }[]; error: string | null }[],
  range: { timeMin: string; timeMax: string },
): string {
  const lines = [`Busy times (${account.email}) between ${range.timeMin} and ${range.timeMax}, in UTC unless an offset is shown:`];
  for (const c of calendars) {
    const id = clip(c.id, 320);
    if (c.error) lines.push(`- ${id}: unavailable (${clip(c.error, 100)}); Google doesn't share this calendar's availability with the account`);
    else if (!c.busy.length) lines.push(`- ${id}: free the whole time`);
    else {
      lines.push(`- ${id}: busy ${c.busy.length} time${c.busy.length === 1 ? "" : "s"}`);
      for (const b of c.busy) lines.push(`  - ${weekday(b.start)} ${b.start} → ${b.end}`);
    }
  }
  return lines.join("\n");
}

export function formatCalendarWrite(o: CalendarWriteOutcome): string {
  const emailed = (n: string[]) => (n.length ? `Google emailed ${n.length} attendee${n.length === 1 ? "" : "s"}.` : "Nobody was emailed.");
  if (o.status === "applied") {
    const e = o.event;
    return JSON.stringify(
      {
        status: "applied",
        calendarId: e.calendarId,
        eventId: e.id,
        summary: e.summary,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        timeZone: e.timeZone,
        conferenceUrl: e.conferenceUrl,
        htmlLink: e.htmlLink,
        notified: o.notified,
        message: `Saved in Google Calendar (${formatWhen(e)}). ${emailed(o.notified)}`,
      },
      null,
      2,
    );
  }
  return JSON.stringify({ ...o, message: `Deleted from Google Calendar. ${emailed(o.notified)}` }, null, 2);
}

function formatCalendarFeedEvent(e: MailEvent, c: CalendarEventSummary): string {
  const lines = [`#${e.seq} ${e.type} · ${e.accountEmail} · ${e.createdAt}`, `  ${clip(c.summary, 160) || "(no title)"} · calendar_id: ${clip(c.calendarId, 320)}`];
  lines.push(...eventLines(c, e.accountEmail, "  "));
  const { changes, wasOrganizer, ...rest } = e.detail ?? {};
  if (Array.isArray(changes)) lines.push(`  Changed: ${changes.map((x) => clip(String(x), 40)).join(", ")}`);
  else if (e.type === "calendar.event_updated") lines.push("  Changed: unknown (the previous version wasn't seen)");
  if (wasOrganizer === true) lines.push("  You organized it.");
  if (Object.keys(rest).length) lines.push(`  Detail: ${clip(JSON.stringify(rest), 300)}`);
  return lines.join("\n");
}

function formatEvent(e: MailEvent, labels: Map<string, GmailLabel[] | null>): string {
  if (e.calendarEvent && isCalendarEventType(e.type)) return formatCalendarFeedEvent(e, e.calendarEvent);
  const lines = [`#${e.seq} ${e.type} · ${e.connectionId ? `connection ${e.connectionId}` : e.accountEmail} · ${e.createdAt}`];
  const m = e.message;
  if (m) {
    lines.push(`  From: ${formatAddress(m.from)} · To: ${clip(formatAddresses(m.to), 120)} · Subject: ${clip(m.subject, 160) || "(no subject)"}`);
    const ids = [`thread_id: ${m.threadId}`, `message_id: ${m.id}`];
    if (m.labelIds.length) ids.push(`labels: ${labelNames(m.labelIds, labels.get(e.accountId) ?? null).join(", ")}`);
    if (m.hasAttachments) ids.push("has attachments");
    lines.push(`  ${ids.join(" · ")}`);
    if (m.snippet) lines.push(`  Snippet: ${clip(m.snippet, 200)}`);
  }
  if (e.labelIds?.length) lines.push(`  ${e.type === "label.removed" ? "Removed" : "Added"}: ${labelNames(e.labelIds, labels.get(e.accountId) ?? null).join(", ")}`);
  if (e.detail && Object.keys(e.detail).length) lines.push(`  Detail: ${clip(JSON.stringify(e.detail), 300)}`);
  return lines.join("\n");
}

export function formatFeed(r: FeedResult & { hasMore?: boolean }, labels: Map<string, GmailLabel[] | null>, waited?: number): string {
  // `hasMore` is additive in the events contract; undefined means false.
  const more = r.hasMore ? ` More events may be available; call again with after=${r.cursor}.` : "";
  if (!r.events.length) {
    const quiet = waited ? `No new events in the last ${waited} s.` : "No new events.";
    return `${quiet} Cursor: ${r.cursor} (acknowledged up to ${r.ackedSeq}).${more}`;
  }
  const last = r.events.at(-1)!.seq;
  return [
    `${r.events.length} event${r.events.length === 1 ? "" : "s"}:`,
    ...r.events.map((e) => formatEvent(e, labels)),
    "",
    `Next: pass after=${r.cursor} to continue. Once you've handled these, call ack_events with seq=${last}.${more}`,
  ].join("\n");
}
