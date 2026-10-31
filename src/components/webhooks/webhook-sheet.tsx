import { isCalendarEventType, type Webhook, type WebhookInput, type WebhookWithSecret } from "@shared/types";
import { useLabelNames } from "@/hooks/use-label-names";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { InfoIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { useCalendarNames } from "@/components/webhooks/calendar-list";
import { ErrorAlert, SectionLabel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { cleanFilter, describeWebhook, regexError } from "@/lib/webhook-filter";
import { EventTypePicker, FilterBuilder, IncludeBodyField } from "./filter-builder";

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.(local|internal|lan|home)$)/i;

function urlProblem(url: string): { error?: string; note?: string } {
  if (!url.trim()) return { error: "Enter the URL xaq should POST events to." };
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return { error: "Enter a full URL, including https://" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "Only http and https URLs are supported." };
  if (PRIVATE_HOST.test(u.hostname)) return { note: "private" };
  if (u.protocol === "http:") return { note: "http" };
  return {};
}

/** Create or edit a webhook. Mount with a `key` so it starts fresh each time it opens. */
export function WebhookSheet({
  open,
  onOpenChange,
  webhook,
  defaultAgentId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  webhook?: Webhook;
  defaultAgentId?: string;
  onCreated?: (res: WebhookWithSecret) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        {open && <WebhookForm webhook={webhook} defaultAgentId={defaultAgentId} onDone={() => onOpenChange(false)} onCreated={onCreated} />}
      </SheetContent>
    </Sheet>
  );
}

function WebhookForm({
  webhook,
  defaultAgentId,
  onDone,
  onCreated,
}: {
  webhook?: Webhook;
  defaultAgentId?: string;
  onDone: () => void;
  onCreated?: (res: WebhookWithSecret) => void;
}) {
  const agents = useQuery(queries.agents());
  const accounts = useQuery(queries.accounts());
  const labelName = useLabelNames(accounts.data ?? []);
  const [draft, setDraft] = useState<WebhookInput>(() =>
    webhook
      ? {
          agentId: webhook.agentId,
          name: webhook.name,
          url: webhook.url,
          eventTypes: webhook.eventTypes,
          filter: webhook.filter,
          includeBody: webhook.includeBody,
          enabled: webhook.enabled,
        }
      : {
          agentId: defaultAgentId ?? "",
          name: "",
          url: "",
          eventTypes: ["message.received"],
          filter: {},
          includeBody: false,
          enabled: true,
        },
  );
  const [touched, setTouched] = useState(false);
  const set = (patch: Partial<WebhookInput>) => setDraft((d) => ({ ...d, ...patch }));
  const agentId = draft.agentId || (agents.data?.length === 1 ? agents.data[0]!.id : "");

  const save = useApiMutation({
    mutationFn: (input: WebhookInput): Promise<Webhook | WebhookWithSecret> =>
      webhook
        ? api<Webhook>(`/api/webhooks/${encodeURIComponent(webhook.id)}`, { method: "PATCH", body: input })
        : api<WebhookWithSecret>("/api/webhooks", { body: input }),
    invalidate: [keys.webhooks],
    success: webhook ? "Webhook saved" : undefined,
    errorTitle: false,
    onSuccess: (res) => {
      onDone();
      if ("secret" in res) onCreated?.(res);
    },
  });

  const url = urlProblem(draft.url);
  const errors = {
    agent: !agentId ? "Choose the agent this webhook delivers to." : null,
    name: !draft.name.trim() ? "Give it a name, e.g. “Support inbox → n8n”." : null,
    url: url.error ?? null,
    events: draft.eventTypes.length === 0,
    subject: regexError(draft.filter.subject),
  };
  const [filterTyping, setFilterTyping] = useState(false);
  const calendar = draft.eventTypes.some(isCalendarEventType);
  const agent = agents.data?.find((a) => a.id === agentId);
  const calendarNames = useCalendarNames(calendar ? (draft.filter.accountIds?.length ? draft.filter.accountIds : (accounts.data ?? []).map((a) => a.id)) : []);
  const valid = !errors.agent && !errors.name && !errors.url && !errors.events && !errors.subject && !filterTyping;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    // Calendar ids only mean something with calendar event types.
    const filter = cleanFilter(calendar ? draft.filter : { ...draft.filter, calendarIds: undefined });
    save.mutate({ ...draft, agentId, name: draft.name.trim(), url: draft.url.trim(), filter });
  };

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <SheetHeader className="border-b">
        <SheetTitle>{webhook ? `Edit ${webhook.name}` : "New webhook"}</SheetTitle>
        <SheetDescription>xaq POSTs a signed JSON payload to your URL for each matching event, retrying failures.</SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <FieldGroup>
          <Field data-invalid={touched && !!errors.agent}>
            <FieldLabel htmlFor="wh-agent">Agent</FieldLabel>
            <Select value={agentId} onValueChange={(v) => set({ agentId: v })}>
              <SelectTrigger id="wh-agent" className="w-full" aria-invalid={touched && !!errors.agent}>
                <SelectValue placeholder={agents.data?.length === 0 ? "Create an agent first" : "Choose an agent"} />
              </SelectTrigger>
              <SelectContent>
                {agents.data?.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {touched && errors.agent ? (
              <FieldError>{errors.agent}</FieldError>
            ) : (
              <FieldDescription>Events are limited to what this agent's grants let it read.</FieldDescription>
            )}
          </Field>
          <Field data-invalid={touched && !!errors.name}>
            <FieldLabel htmlFor="wh-name">Name</FieldLabel>
            <Input id="wh-name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Support inbox → n8n" aria-invalid={touched && !!errors.name} />
            {touched && errors.name && <FieldError>{errors.name}</FieldError>}
          </Field>
          <Field data-invalid={touched && !!errors.url}>
            <FieldLabel htmlFor="wh-url">Endpoint URL</FieldLabel>
            <Input
              id="wh-url"
              type="url"
              inputMode="url"
              spellCheck={false}
              className="font-mono"
              placeholder="https://example.com/hooks/xaq"
              value={draft.url}
              onChange={(e) => set({ url: e.target.value })}
              aria-invalid={touched && !!errors.url}
            />
            {touched && errors.url ? (
              <FieldError>{errors.url}</FieldError>
            ) : url.note === "private" ? (
              <FieldDescription className="flex items-start gap-1.5">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Private and loopback addresses are blocked unless they're on the{" "}
                  <Link to="/settings" hash="webhook-allowlist" className="underline underline-offset-4">
                    webhook allowlist
                  </Link>{" "}
                  (protects your network from forged targets).
                </span>
              </FieldDescription>
            ) : url.note === "http" ? (
              <FieldDescription>Plain http sends mail metadata unencrypted. Prefer https for anything off this machine.</FieldDescription>
            ) : null}
          </Field>

          <Separator />
          <EventTypePicker value={draft.eventTypes} onChange={(eventTypes) => set({ eventTypes })} invalid={touched && errors.events} />
          {calendar && agent && !agent.grants.length && (
            <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              <InfoIcon className="mt-px size-3.5 shrink-0 text-warning" />
              <span>
                {agent.name} has no account, so calendar events never reach this webhook. Give it access on its{" "}
                <Link to="/agents/$agentId" params={{ agentId: agent.id }} className="underline underline-offset-4">
                  agent page
                </Link>
                .
              </span>
            </p>
          )}
          <Separator />
          <div className="space-y-1">
            <SectionLabel>{calendar ? "Only when the event matches" : "Only when the message matches"}</SectionLabel>
            <p className="text-xs text-muted-foreground">All conditions you set must match. Leave everything empty to get every event.</p>
          </div>
          <FilterBuilder
            value={draft.filter}
            onChange={(filter) => set({ filter })}
            accounts={accounts.data ?? []}
            eventTypes={draft.eventTypes}
            onPendingChange={setFilterTyping}
          />
          <Separator />
          <IncludeBodyField value={draft.includeBody} onChange={(includeBody) => set({ includeBody })} calendar={calendar} />

          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <SparklesIcon className="size-3.5" /> In plain words
            </div>
            <p>{describeWebhook(draft, accounts.data ?? [], labelName, calendarNames).join(", ")}.</p>
          </div>
          {save.isError && <ErrorAlert error={save.error} title="Couldn't save the webhook" />}
        </FieldGroup>
      </div>
      <SheetFooter className="flex-row justify-end border-t">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending || (touched && !valid) || filterTyping}>
          {save.isPending && <Spinner />}
          {webhook ? "Save changes" : "Create webhook"}
        </Button>
      </SheetFooter>
    </form>
  );
}
