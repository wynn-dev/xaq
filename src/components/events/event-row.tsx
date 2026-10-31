import { useQuery } from "@tanstack/react-query";
import type { CalendarEventSummary, EventType, MailEvent } from "@shared/types";
import {
  AlertTriangleIcon,
  BellRingIcon,
  CalendarIcon,
  CalendarPlusIcon,
  CalendarXIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  KeyRoundIcon,
  MailIcon,
  PaperclipIcon,
  SendIcon,
  TagIcon,
} from "lucide-react";
import { useState } from "react";
import { listenerHandled } from "@/components/agents/listener-handled";
import { CodeBlock, ExternalLink, TimeAgo, ToneBadge } from "@/components/common";
import { Visible } from "@/components/hidden-chars";
import { Badge } from "@/components/ui/badge";
import { agentOnHost, fmtAddress, fmtAddressShort, fmtEventWhen, fmtExact } from "@/lib/format";
import { CALENDAR_RESPONSE_LABEL, EVENT_TYPE_INFO } from "@/lib/labels";
import { queries } from "@/lib/queries";
import { prettySystemLabel } from "@/hooks/use-label-names";
import { cn } from "@/lib/utils";
import { calendarEventLines, httpsUrl, organizedHere } from "./calendar-event";

const ICON: Record<EventType, typeof MailIcon> = {
  "message.received": MailIcon,
  "message.sent": SendIcon,
  "thread.reply_received": CornerDownRightIcon,
  "label.added": TagIcon,
  "label.removed": TagIcon,
  "account.auth_failed": KeyRoundIcon,
  "sync.gap": AlertTriangleIcon,
  "calendar.event_created": CalendarPlusIcon,
  "calendar.event_updated": CalendarIcon,
  "calendar.event_cancelled": CalendarXIcon,
  "calendar.invitation_received": CalendarPlusIcon,
  "connection.auth_failed": KeyRoundIcon,
  "connection.expiring": KeyRoundIcon,
};
const ALERT_TYPES: EventType[] = ["account.auth_failed", "sync.gap"];

export function EventIcon({ type, className }: { type: EventType; className?: string }) {
  const Icon = ICON[type] ?? MailIcon;
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted",
        ALERT_TYPES.includes(type) && "bg-warning/15 text-warning",
        className,
      )}
      aria-hidden
    >
      <Icon className="size-4" />
    </span>
  );
}

/** Headline for an event: the subject for message events, a description otherwise. */
function headline(e: MailEvent) {
  if (e.message) return e.message.subject || "(no subject)";
  if (e.type === "account.auth_failed") return "Google rejected the account's token. Reconnect it on the Accounts page.";
  if (e.type === "sync.gap") return "Events may be missing: history was too old, so a bounded resync ran.";
  return EVENT_TYPE_INFO[e.type]?.description ?? e.type;
}

/**
 * `xaq listen` instances that got this event: their agent has a grant on its account,
 * it is of a type the listener asked for, it came after the listener started, and the
 * listener acknowledged it (ran its command, or skipped it by its own --from/--to/--label/--subject
 * filter, which only the listener's machine knows).
 */
function useListenerDelivery(e: MailEvent) {
  const agents = useQuery(queries.agents());
  const out: { name: string; host: string | null }[] = [];
  for (const a of agents.data ?? []) {
    if (!a.grants.some((g) => g.accountId === e.accountId)) continue;
    for (const l of a.listeners) if (listenerHandled(l, e)) out.push({ name: a.name, host: l.client.hostname ?? null });
  }
  return out;
}

/** One event, expandable to its full metadata. Message content is never rendered as HTML. */
export function EventRow({ event: e, fresh }: { event: MailEvent; fresh?: boolean }) {
  const [open, setOpen] = useState(false);
  const delivered = useListenerDelivery(e);
  const m = e.message;
  const cal = calendarEventLines(e);
  const info = EVENT_TYPE_INFO[e.type];
  const isLabel = e.type === "label.added" || e.type === "label.removed";
  const labels = useQuery({ ...queries.labels(e.accountId), enabled: isLabel && !!e.labelIds?.length });
  const labelNames = isLabel ? (e.labelIds ?? []).map((id) => {
    const l = labels.data?.find((x) => x.id === id);
    return l && l.type === "user" ? l.name : prettySystemLabel(id);
  }) : [];
  return (
    <li className={cn(fresh && "animate-in duration-500 fade-in slide-in-from-top-1")}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <EventIcon type={e.type} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Badge variant="outline" className="font-normal">
              {info?.label ?? e.type}
              {labelNames.length > 0 && <span className="font-medium text-foreground">{labelNames.join(", ")}</span>}
            </Badge>
            <span className="truncate">{e.accountEmail}</span>
            {m?.from && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">from {fmtAddressShort(m.from)}</span>
              </>
            )}
            {m?.hasAttachments && <PaperclipIcon className="size-3.5" aria-label="Has attachments" />}
            {cal?.organizer && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{cal.organizer}</span>
              </>
            )}
            {cal?.needsAnswer && <ToneBadge tone="warn">Needs your answer</ToneBadge>}
            {delivered.length > 0 && (
              <span className="flex items-center gap-1 text-success">
                <BellRingIcon className="size-3.5" aria-hidden />
                {delivered.length === 1 ? (
                  <>
                    Delivered to <Visible text={delivered[0]!.name} />
                  </>
                ) : (
                  `Delivered to ${delivered.length} listeners`
                )}
              </span>
            )}
          </div>
          <div className={cn("truncate text-sm", m || cal ? "font-medium" : "text-muted-foreground", e.type === "calendar.event_cancelled" && "line-through decoration-muted-foreground/60")}>
            {cal ? cal.title : headline(e)}
          </div>
          {m?.snippet && <div className="line-clamp-1 text-xs text-muted-foreground">{m.snippet}</div>}
          {cal && (
            <div className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
              <span>{cal.when}</span>
              {cal.note && (
                <span className="min-w-0 truncate">
                  <span aria-hidden>· </span>
                  <Visible text={cal.note} />
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 pt-0.5 text-xs text-muted-foreground">
          <TimeAgo date={e.createdAt} />
          <ChevronRightIcon className={cn("size-4 transition-transform", open && "rotate-90")} />
        </div>
      </button>
      {open && <EventDetail event={e} delivered={delivered} />}
    </li>
  );
}

function EventDetail({ event: e, delivered }: { event: MailEvent; delivered: { name: string; host: string | null }[] }) {
  const m = e.message;
  const rows: [string, React.ReactNode][] = [
    ["Event", <code key="id" className="font-mono">{e.id} · #{e.seq}</code>],
    ["When", fmtExact(e.createdAt)],
    ["Account", e.accountEmail],
  ];
  if (m) {
    rows.push(
      ["From", fmtAddress(m.from)],
      ["To", m.to.map(fmtAddress).join(", ") || "—"],
      ...(m.cc.length ? ([["Cc", m.cc.map(fmtAddress).join(", ")]] as [string, string][]) : []),
      ["Date", fmtExact(m.date)],
      ["Labels", m.labelIds.join(", ") || "—"],
      ["Message", <code key="msg" className="font-mono break-all">{m.id}</code>],
      ["Thread", <code key="thread" className="font-mono break-all">{m.threadId}</code>],
    );
  }
  if (e.calendarEvent) rows.push(...calendarRows(e.calendarEvent, e.accountEmail));
  if (e.labelIds?.length) rows.push([e.type === "label.removed" ? "Removed" : "Added", e.labelIds.join(", ")]);
  if (delivered.length) rows.push(["Listeners", <Visible key="listeners" text={`Delivered to ${delivered.map((d) => agentOnHost(d.name, d.host)).join(", ")}`} />]);
  return (
    <div className="space-y-3 border-t bg-muted/20 px-4 py-3 sm:pl-15">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {m?.snippet && (
        <p className="rounded-md border bg-background p-2 text-xs whitespace-pre-wrap text-muted-foreground">{m.snippet}</p>
      )}
      {e.detail && Object.keys(e.detail).length > 0 && <CodeBlock code={JSON.stringify(e.detail, null, 2)} />}
    </div>
  );
}

/** The calendar event's metadata. Links are clickable only when https (they can come from the organizer). */
function calendarRows(c: CalendarEventSummary, accountEmail: string): [string, React.ReactNode][] {
  const link = httpsUrl(c.htmlLink);
  const call = httpsUrl(c.conferenceUrl);
  const shown = c.attendees.map((a) => `${fmtAddress(a)}${a.organizer ? " (organizer)" : ""}: ${CALENDAR_RESPONSE_LABEL[a.responseStatus]}`);
  if (c.attendeeCount > c.attendees.length) shown.push(`and ${c.attendeeCount - c.attendees.length} more`);
  const rows: [string, React.ReactNode][] = [
    ["Title", <Visible key="title" text={c.summary || "(no title)"} />],
    ["Scheduled", `${fmtEventWhen(c)}${c.timeZone ? ` (${c.timeZone})` : ""}${c.recurring || c.recurringEventId ? ", repeats" : ""}`],
  ];
  if (c.location) rows.push(["Where", <Visible key="where" text={c.location} />]);
  rows.push(["Organizer", organizedHere(c, accountEmail) ? "This account" : <Visible key="org" text={fmtAddress(c.organizer)} />]);
  if (shown.length) rows.push(["Guests", <Visible key="guests" text={shown.join(", ")} />]);
  if (c.selfResponse) rows.push(["Your answer", CALENDAR_RESPONSE_LABEL[c.selfResponse]]);
  if (c.conferenceUrl) rows.push(["Video call", call ? <ExternalLink key="call" href={call} className="break-all">{call}</ExternalLink> : <code key="call" className="font-mono break-all">{c.conferenceUrl}</code>]);
  rows.push(
    ["Calendar", <code key="cal" className="font-mono break-all">{c.calendarId}</code>],
    ["Event id", link ? <ExternalLink key="ev" href={link} className="font-mono break-all">{c.id}</ExternalLink> : <code key="ev" className="font-mono break-all">{c.id}</code>],
  );
  return rows;
}
