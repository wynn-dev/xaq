// Event text as untrusted content (workstream C). An invitation is an
// injection vector: anyone can put an event on the account's calendar, with whatever title, location, names
// and description they like. The description (HTML from the Calendar UI, plain text from the API) gets the
// same cleaning as a mail body (server/mail/content.ts) and is wrapped in <calendar_content … untrusted> when
// shown to agents; the one-line fields are cleaned by summarizeEvent and scanned here for the signals.

import type { CalendarEventSummary, ContentSignals, MessageContent } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import type { CalendarEventRaw } from "../google/calendar.ts";
import {
  cleanPlainText,
  ContentTooComplexError,
  escapeDelimiters,
  htmlToMarkdown,
  isExternal,
  stripInvisible,
  suspiciousPhrases,
  truncateText,
} from "../mail/content.ts";
import { contentPool, type Lane } from "../mail/pool.ts";

/**
 * Longer descriptions are cut before cleaning (bounded work in-process; the Calendar UI itself stops at a
 * few thousand characters). The agent sees a note saying so.
 */
export const MAX_DESCRIPTION_CHARS = 32_000;

const HTML_TAGS =
  "a|abbr|article|b|big|blockquote|body|br|button|center|code|del|div|em|embed|font|form|h[1-6]|head|hr|html|i|iframe|img|input|ins|label|li|link|meta|noscript|object|ol|p|pre|s|script|section|small|span|strike|strong|style|sub|sup|svg|table|tbody|td|template|tfoot|th|thead|title|tr|tt|u|ul";
/**
 * Descriptions written in the Calendar UI are HTML; ones set through the API are usually plain text, where
 * "<ask Bob>" or "Bob <bob@x.test>" must stay text. HTML: a known tag, any tag with attributes (hiding needs
 * them), or a character reference.
 */
const HTML_HINT = new RegExp(`<\\/?(?:${HTML_TAGS})\\b[^<>]*>|<[a-z][\\w:-]*\\s[^<>]*=[^<>]*>|&(?:#\\d+|#x[0-9a-f]+|[a-z]+\\d*);`, "i");
const looksLikeHtml = (s: string) => HTML_HINT.test(s);

type Converted = { markdown: string; removed: number } | "too_complex";

/** The one-line free text of an event (title, location, organizer and attendee names), raw. */
function oneLiners(e: CalendarEventRaw): string[] {
  return [e.summary, e.location, e.organizer?.displayName, e.creator?.displayName, ...(e.attendees ?? []).map((a) => a.displayName)].filter(
    (s): s is string => !!s,
  );
}

function build(e: CalendarEventRaw, desc: string, converted: Converted, clipped: boolean, opts: { accountEmail: string; maxChars: number }): MessageContent {
  let body: string;
  let removed = 0;
  if (converted === "too_complex") {
    body = "[This description is too complex to display safely. Ask a human to read it in Google Calendar.]";
  } else {
    body = converted.markdown;
    removed = converted.removed;
  }
  if (clipped) body += `\n\n[Description cut at ${MAX_DESCRIPTION_CHARS} of ${desc.length} characters.]`;
  body = escapeDelimiters(body);
  // Invisible characters in the one-liners count as hidden content too (summarizeEvent strips them).
  const lines = oneLiners(e).map((s) => stripInvisible(s));
  removed += lines.reduce((n, l) => n + l.removed, 0);
  const t = truncateText(body, opts.maxChars);
  return {
    body: t.text,
    truncated: t.truncated || clipped,
    attachments: [],
    signals: {
      hiddenContentRemoved: removed > 0,
      suspiciousInstructions: suspiciousPhrases(`${lines.map((l) => l.text).join("\n")}\n${body}`),
      auth: null,
      external: isExternal(e.organizer?.email, opts.accountEmail),
    },
  };
}

function plain(text: string): Converted {
  const r = cleanPlainText(text);
  return { markdown: r.text, removed: r.removed };
}

function convert(text: string): Converted {
  if (!looksLikeHtml(text)) return plain(text);
  try {
    return htmlToMarkdown(text);
  } catch (err) {
    if (err instanceof ContentTooComplexError) return "too_complex";
    throw err;
  }
}

/**
 * The cleaned description as MessageContent: body markdown (HTML converted, hidden text and invisible
 * characters removed, delimiters escaped), attachments [], signals.external = organizer outside the
 * account's domain, signals.auth null. Signals also cover the title, location and names. null without a
 * description. Cleans in-process (input capped at MAX_DESCRIPTION_CHARS); see cleanEventDescription for the
 * worker-pool version.
 */
export function eventDescriptionContent(e: CalendarEventRaw, opts: { accountEmail: string; maxChars: number }): MessageContent | null {
  const desc = e.description;
  if (!desc?.trim()) return null;
  const input = desc.slice(0, MAX_DESCRIPTION_CHARS);
  return build(e, desc, convert(input), desc.length > MAX_DESCRIPTION_CHARS, opts);
}

/** eventDescriptionContent with HTML conversion in the content worker pool (deadline, never blocks the event loop). */
export async function cleanEventDescription(
  ctx: AppContext,
  e: CalendarEventRaw,
  opts: { accountEmail: string; maxChars: number },
  lane: Lane = "interactive",
): Promise<MessageContent | null> {
  const desc = e.description;
  if (!desc?.trim()) return null;
  const input = desc.slice(0, MAX_DESCRIPTION_CHARS);
  const converted = looksLikeHtml(input) ? await contentPool(ctx).html(input, lane) : plain(input);
  return build(e, desc, converted, desc.length > MAX_DESCRIPTION_CHARS, opts);
}

/**
 * Signals for an event shown without its description (event lists, the feed, or an event that has none):
 * instruction-like text in the title, location and names, and an external organizer. Hidden characters
 * were already stripped from these fields by summarizeEvent, so hiddenContentRemoved is false here.
 */
export function eventSummarySignals(e: CalendarEventSummary, accountEmail: string): ContentSignals {
  const text = [e.summary, e.location, e.organizer?.name, ...e.attendees.map((a) => a.name)].filter(Boolean).join("\n");
  return {
    hiddenContentRemoved: false,
    suspiciousInstructions: suspiciousPhrases(text),
    auth: null,
    external: !e.organizerSelf && isExternal(e.organizer?.email, accountEmail),
  };
}

/** Fetches the event and returns its cleaned description (listener bodies; the background lane). */
export async function eventContent(ctx: AppContext, accountId: string, calendarId: string, eventId: string): Promise<MessageContent | null> {
  const account = ctx.accounts.require(accountId);
  const raw = await ctx.google.calendar(accountId).getEvent(calendarId, eventId);
  return cleanEventDescription(ctx, raw, { accountEmail: account.email, maxChars: ctx.settings.get().maxBodyChars }, "background");
}
