import type { Account, Grant } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpenIcon, ChevronDownIcon, ShieldCheckIcon, ShieldOffIcon, ShieldPlusIcon } from "lucide-react";
import { useState } from "react";
import { AccountAvatar, AccountStatusBadge } from "@/components/accounts/account-status";
import { ChipsInput } from "@/components/chips-input";
import { confirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";
import { DEFAULT_GRANT, type GrantFields, grantInput, grantInWords, sameGrant, toGrantFields, validateAddressGlob } from "@/lib/grants";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { cn } from "@/lib/utils";

const LEVELS = {
  read: { label: "Read only", icon: BookOpenIcon, description: "Search and read mail and calendars, and receive events. Can't change, draft or send anything." },
  full: {
    label: "Full access",
    icon: ShieldCheckIcon,
    description: "Also organizes, trashes, drafts and sends mail, and changes calendar events. Sends and changes go out at once.",
  },
} as const;

/** One agent's access to one mailbox: collapsed summary, expandable editor, save/remove. */
export function GrantEditor({
  agentId,
  account,
  grant,
  defaultOpen,
}: {
  agentId: string;
  account: Account;
  grant: Grant | undefined;
  defaultOpen?: boolean;
}) {
  const saved = grant ? toGrantFields(grant) : null;
  const [draft, setDraft] = useState<GrantFields | null>(saved);
  const [open, setOpen] = useState(!!defaultOpen && !!grant);
  // Pick up server changes (e.g. after save) when there are no local edits.
  const [lastSaved, setLastSaved] = useState(saved);
  if (JSON.stringify(saved) !== JSON.stringify(lastSaved)) {
    setLastSaved(saved);
    if (!draft || (lastSaved && sameGrant(draft, lastSaved))) setDraft(saved);
  }

  const path = `/api/agents/${encodeURIComponent(agentId)}/grants/${encodeURIComponent(account.id)}`;
  const save = useApiMutation({
    mutationFn: (g: GrantFields) => api<Grant>(path, { method: "PUT", body: grantInput(account.id, g) }),
    invalidate: [keys.agents],
    success: grant ? `Permissions for ${account.email} saved` : `${account.email} access granted`,
    errorTitle: "Couldn't save permissions",
    onSuccess: (g) => setDraft(toGrantFields(g)),
  });
  const remove = useApiMutation({
    mutationFn: () => api(path, { method: "DELETE" }),
    invalidate: [keys.agents],
    success: `Access to ${account.email} removed`,
    errorTitle: false,
    onSuccess: () => {
      setDraft(null);
      setOpen(false);
    },
  });

  const dirty = !!draft && (!saved || !sameGrant(draft, saved));
  const set = (patch: Partial<GrantFields>) => setDraft((d) => ({ ...(d ?? DEFAULT_GRANT), ...patch }));
  const [typing, setTyping] = useState(false);
  const problem = draft && typing ? "Add or clear the recipient you're typing first." : null;

  const askRemove = () =>
    confirm({
      title: `Remove access to ${account.email}?`,
      description: "The agent immediately loses access to this mailbox and its calendars, and stops receiving their events.",
      confirmLabel: "Remove access",
      destructive: true,
      onConfirm: () => remove.mutateAsync(),
    });


  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <AccountAvatar email={account.email} className="size-8" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{account.email}</span>
            {account.status !== "active" && <AccountStatusBadge status={account.status} />}
            {dirty && saved && <Badge variant="outline" className="border-warning/50 text-xs font-normal">Unsaved changes</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {saved ? grantInWords(saved) : draft ? "New access, not saved yet" : "No access"}
          </div>
        </div>
        {draft ? (
          <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Collapse" : "Edit"}
            <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft({ ...DEFAULT_GRANT });
              setOpen(true);
            }}
          >
            <ShieldPlusIcon /> Grant access
          </Button>
        )}
      </div>

      {draft && open && (
        <div className="border-t p-4">
          <FieldGroup>
            <GrantFieldsForm idPrefix={account.id} accountId={account.id} value={draft} onChange={set} onPendingChange={setTyping} />

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              {saved ? (
                <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={askRemove}>
                  <ShieldOffIcon /> Remove access
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                {(dirty || !saved) && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDraft(saved);
                      if (!saved) setOpen(false);
                    }}
                  >
                    {saved ? "Discard changes" : "Cancel"}
                  </Button>
                )}
                {problem && dirty && <span className="self-center text-xs text-warning">{problem}</span>}
                <Button disabled={!dirty || save.isPending || !!problem} onClick={() => save.mutate(draft)}>
                  {save.isPending && <Spinner />}
                  {saved ? "Save permissions" : "Grant access"}
                </Button>
              </div>
            </div>
          </FieldGroup>
        </div>
      )}
    </Card>
  );
}

/** The editable fields of a grant (full or read, allowed recipients), without saving. */
export function GrantFieldsForm({
  idPrefix,
  accountId,
  value,
  onChange,
  onPendingChange,
}: {
  idPrefix: string;
  accountId: string;
  value: GrantFields;
  onChange: (patch: Partial<GrantFields>) => void;
  /** Recipient text typed but not added yet. */
  onPendingChange?: (pending: boolean) => void;
}) {
  const id = (s: string) => `${idPrefix}-${s}`;
  const full = value.level === "full";
  return (
    <>
      <FieldSet>
        <FieldLegend variant="label">Access to mail and calendars</FieldLegend>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={value.level}
          onValueChange={(v) => v && onChange({ level: v as GrantFields["level"] })}
          aria-label="Access"
          className="flex-wrap"
        >
          {(["read", "full"] as const).map((l) => {
            const Icon = LEVELS[l].icon;
            return (
              <ToggleGroupItem key={l} value={l}>
                <Icon /> {LEVELS[l].label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <FieldDescription>{LEVELS[value.level].description}</FieldDescription>
        <AccountCalendarNotice accountId={accountId} />
      </FieldSet>

      <FieldSet disabled={!full} className={cn(!full && "opacity-60")}>
        <Field>
          <FieldLabel htmlFor={id("allow")}>Allowed recipients</FieldLabel>
          <ChipsInput
            id={id("allow")}
            value={value.allowTo}
            onChange={(allowTo) => onChange({ allowTo })}
            placeholder="Anyone. Add addresses or *@company.com"
            validate={validateAddressGlob}
            onPendingChange={onPendingChange}
            aria-describedby={id("allow-hint")}
          />
          <FieldDescription id={id("allow-hint")}>
            Leave empty to allow any recipient. Use exact addresses or globs like <code className="font-mono">*@yourcompany.com</code>. Every to,
            cc and bcc address must match, and so must every guest of a calendar change.
          </FieldDescription>
        </Field>
      </FieldSet>
    </>
  );
}

/** An account that can't serve calendar calls yet: say so, with where to fix it. */
function AccountCalendarNotice({ accountId }: { accountId: string }) {
  const accounts = useQuery(queries.accounts());
  const account = accounts.data?.find((a) => a.id === accountId);
  const status = account ? (account.calendar?.status ?? "not_granted") : null;
  if (status !== "not_granted" && status !== "api_disabled") return null;
  return (
    <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
      {status === "not_granted"
        ? `${account!.email} hasn't added Google Calendar yet, so calendar tools stay off for it until you add it on `
        : "The Google Calendar API is turned off in your Cloud project, so calendar tools fail until you turn it on from "}
      <Link to="/accounts" className="font-medium underline underline-offset-4">
        Accounts
      </Link>
      .
    </p>
  );
}
