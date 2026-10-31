import { useEffect, useState } from "react";
import { type Account, CALENDAR_EVENT_TYPES, EVENT_TYPES, type EventType, isCalendarEventType, type WebhookFilter } from "@shared/types";
import { ShieldAlertIcon } from "lucide-react";
import { CalendarChecklist, useCalendars } from "@/components/webhooks/calendar-list";
import { ChipsInput } from "@/components/chips-input";
import { LabelMultiSelect } from "@/components/label-multi-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EVENT_TYPE_INFO } from "@/lib/labels";
import { regexError } from "@/lib/webhook-filter";

const TYPE_GROUPS: { label: string; hint?: string; types: readonly EventType[] }[] = [
  { label: "Mail and account", types: EVENT_TYPES.filter((t) => !isCalendarEventType(t)) },
  { label: "Calendar", hint: "Needs the agent to have Calendar: read on the account, and the event's calendar in its scope.", types: CALENDAR_EVENT_TYPES },
];

export function EventTypePicker({ value, onChange, invalid }: { value: EventType[]; onChange: (v: EventType[]) => void; invalid?: boolean }) {
  const toggle = (t: EventType, on: boolean) => onChange(EVENT_TYPES.filter((x) => (x === t ? on : value.includes(x))));
  return (
    <FieldSet data-invalid={invalid}>
      <FieldLegend variant="label">Events</FieldLegend>
      {TYPE_GROUPS.map((g) => (
        <div key={g.label} className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">{g.label}</div>
          {g.hint && <p className="text-xs text-muted-foreground">{g.hint}</p>}
          <div className="grid gap-1.5">
            {g.types.map((t) => (
              <label
                key={t}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 has-[[data-state=checked]]:bg-muted/40"
              >
                <Checkbox className="mt-0.5" checked={value.includes(t)} onCheckedChange={(v) => toggle(t, v === true)} />
                <span className="min-w-0 space-y-0.5">
                  <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                    {EVENT_TYPE_INFO[t]?.label ?? t}
                    <code className="font-mono text-xs font-normal text-muted-foreground">{t}</code>
                  </span>
                  <span className="block text-xs text-muted-foreground">{EVENT_TYPE_INFO[t]?.description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
      {invalid && <FieldError>Pick at least one event type.</FieldError>}
    </FieldSet>
  );
}

const globError = (v: string) => (/\s/.test(v) ? "no spaces allowed" : v.length > 254 ? "too long" : null);

/**
 * Which events a webhook fires for. Every set condition must match; within a list, any entry matches. On
 * calendar events from/to/subject match the organizer, a guest and the title; labels and attachments
 * apply to mail only.
 */
export function FilterBuilder({
  value,
  onChange,
  accounts,
  eventTypes,
  onPendingChange,
}: {
  value: WebhookFilter;
  onChange: (f: WebhookFilter) => void;
  accounts: Account[];
  /** The webhook's event types: calendar types add the calendar picker and calendar wording. */
  eventTypes: EventType[];
  /** Sender/recipient text typed but not added yet. */
  onPendingChange?: (pending: boolean) => void;
}) {
  const calendar = eventTypes.some(isCalendarEventType);
  const mail = eventTypes.some((t) => !isCalendarEventType(t));
  const [typing, setTyping] = useState({ from: false, to: false });
  const pending = typing.from || typing.to;
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);
  const set = (patch: Partial<WebhookFilter>) => onChange({ ...value, ...patch });
  const accountIds = value.accountIds ?? [];
  const subjectError = regexError(value.subject);
  const toggleAccount = (id: string, on: boolean) =>
    set({ accountIds: on ? [...new Set([...accountIds, id])] : accountIds.filter((x) => x !== id) });

  return (
    <div className="space-y-5">
      <FieldSet>
        <FieldLegend variant="label">Accounts</FieldLegend>
        <FieldDescription>Leave all unchecked for every account the agent can read. Accounts it has no read grant for are never sent.</FieldDescription>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {accounts.map((a) => (
            <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50">
              <Checkbox checked={accountIds.includes(a.id)} onCheckedChange={(v) => toggleAccount(a.id, v === true)} />
              <span className="truncate">{a.email}</span>
            </label>
          ))}
        </div>
      </FieldSet>

      {calendar && (
        <FieldSet>
          <FieldLegend variant="label">Calendars</FieldLegend>
          <FieldDescription>Leave all unchecked for every calendar the agent can read. Applies to calendar events only.</FieldDescription>
          <WebhookCalendarPicker
            accountIds={accountIds.length ? accountIds : accounts.map((a) => a.id)}
            emailOf={(id) => accounts.find((a) => a.id === id)?.email ?? id}
            value={value.calendarIds ?? []}
            onChange={(calendarIds) => set({ calendarIds })}
          />
        </FieldSet>
      )}

      {mail && (
      <Field>
        <FieldLabel htmlFor="wf-labels">Labels</FieldLabel>
        <LabelMultiSelect
          id="wf-labels"
          accountIds={accountIds.length ? accountIds : accounts.map((a) => a.id)}
          value={value.labelIds ?? []}
          onChange={(labelIds) => set({ labelIds })}
          placeholder="Any label"
        />
        <FieldDescription>Fire only for messages carrying any of these labels.{calendar && " Calendar events ignore it."}</FieldDescription>
      </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="wf-from">{calendar && !mail ? "Organizer" : calendar ? "From (or organizer)" : "From"}</FieldLabel>
          <ChipsInput id="wf-from" value={value.from ?? []} onChange={(from) => set({ from })} placeholder="Any sender" validate={globError} onPendingChange={(v) => setTyping((t) => ({ ...t, from: v }))} />
          <FieldDescription>
            Globs like <code className="font-mono">*@stripe.com</code>
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="wf-to">{calendar && !mail ? "Guest" : calendar ? "To or Cc (or guest)" : "To or Cc"}</FieldLabel>
          <ChipsInput id="wf-to" value={value.to ?? []} onChange={(to) => set({ to })} placeholder="Any recipient" validate={globError} onPendingChange={(v) => setTyping((t) => ({ ...t, to: v }))} />
          <FieldDescription>
            e.g. <code className="font-mono">support@yourco.com</code>
          </FieldDescription>
        </Field>
      </div>

      <Field data-invalid={!!subjectError}>
        <FieldLabel htmlFor="wf-subject">
          {calendar && !mail ? "Event title" : calendar ? "Subject or event title" : "Subject"} pattern (RE2 regular expression)
        </FieldLabel>
        <Input
          id="wf-subject"
          className="font-mono"
          placeholder="e.g. invoice|receipt"
          spellCheck={false}
          value={value.subject ?? ""}
          onChange={(e) => set({ subject: e.target.value })}
          aria-invalid={!!subjectError}
        />
        {subjectError ? (
          <FieldError>Not a valid pattern: {subjectError}</FieldError>
        ) : (
          <FieldDescription>
            Case-insensitive, checked against the first 256 characters of the subject{calendar && " (the title on calendar events)"}. RE2 syntax: no lookarounds or backreferences. Leave empty for any
            subject.
          </FieldDescription>
        )}
      </Field>

      {mail && (
      <Field>
        <FieldLabel>Attachments{calendar && " (mail only)"}</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={value.hasAttachments === undefined ? "any" : value.hasAttachments ? "with" : "without"}
          onValueChange={(v) => v && set({ hasAttachments: v === "any" ? undefined : v === "with" })}
          aria-label="Attachments"
        >
          <ToggleGroupItem value="any">Any</ToggleGroupItem>
          <ToggleGroupItem value="with">With attachments</ToggleGroupItem>
          <ToggleGroupItem value="without">Without</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      )}
    </div>
  );
}

/** Calendar ids across the accounts' calendar lists; accounts without Google Calendar are left out. */
function WebhookCalendarPicker({
  accountIds,
  emailOf,
  value,
  onChange,
}: {
  accountIds: string[];
  emailOf: (accountId: string) => string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const lists = useCalendars(accountIds);
  if (lists.some((l) => l.query.isPending)) return <Skeleton className="h-10" />;
  const loaded = lists.filter((l) => l.query.data?.length);
  const listed = new Set(loaded.flatMap((l) => l.query.data!.map((c) => c.id)));
  const unlisted = value.filter((id) => !listed.has(id));
  return (
    <div className="space-y-3">
      {loaded.length === 0 && (
        <p className="text-xs text-muted-foreground">None of these accounts can list its calendars yet (add Google Calendar to them on Accounts).</p>
      )}
      {loaded.map((l) => (
        <div key={l.accountId} className="space-y-1.5">
          {accountIds.length > 1 && <div className="truncate text-xs text-muted-foreground">{emailOf(l.accountId)}</div>}
          <CalendarChecklist calendars={l.query.data!} value={value} onChange={onChange} unlisted={false} />
        </div>
      ))}
      {unlisted.length > 0 && <CalendarChecklist calendars={[]} value={unlisted} onChange={(kept) => onChange(value.filter((id) => listed.has(id) || kept.includes(id)))} />}
    </div>
  );
}

export function IncludeBodyField({ value, onChange, calendar }: { value: boolean; onChange: (v: boolean) => void; calendar?: boolean }) {
  return (
    <div className="space-y-2">
      <Field orientation="horizontal">
        <Switch id="wf-body" checked={value} onCheckedChange={onChange} />
        <div className="space-y-0.5">
          <FieldLabel htmlFor="wf-body">Include message body{calendar && " or event description"}</FieldLabel>
          <FieldDescription>
            Adds the message as clean Markdown, plus attachment info and safety signals, so the agent can act without a fetch.
            {calendar && " Calendar events get the event's cleaned description instead."}
          </FieldDescription>
        </div>
      </Field>
      {value && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          <ShieldAlertIcon className="mt-px size-3.5 shrink-0 text-warning" />
          <span>
            Bodies are cleaned (hidden text and invisible characters removed) but are still <strong>untrusted input</strong>: anyone can
            email you{calendar && " or invite you to an event"}. Your receiver should treat the content as data, never as instructions.
          </span>
        </p>
      )}
    </div>
  );
}
