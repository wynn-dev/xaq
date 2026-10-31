import type { AccessLevel, AgentWithKey, CreateAgentInput } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChoiceCards } from "@/components/choice-cards";
import { ErrorAlert } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { grantInput } from "@/lib/grants";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";
import { rememberKey } from "@/lib/revealed-keys";

/**
 * Name + mailbox access in one step. Grants start from a preset; everything is fine-tunable on the
 * agent's page afterwards.
 */
export function AgentCreateForm({
  onCreated,
  defaultName = "",
  submitLabel = "Create agent",
  onCancel,
}: {
  onCreated: (res: AgentWithKey) => void;
  defaultName?: string;
  submitLabel?: string;
  onCancel?: () => void;
}) {
  const accounts = useQuery(queries.accounts());
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [level, setLevel] = useState<AccessLevel>("read");
  const [touched, setTouched] = useState(false);
  // Default to every connected account until the user changes the selection.
  const selected = picked ?? (accounts.data ?? []).map((a) => a.id);

  const create = useApiMutation({
    mutationFn: (input: CreateAgentInput) => api<AgentWithKey>("/api/agents", { body: input }),
    invalidate: [keys.agents, keys.setupState, keys.overview],
    success: (res) => `Agent "${res.agent.name}" created`,
    errorTitle: false,
    onSuccess: (res) => {
      rememberKey(res.agent.id, res.apiKey);
      onCreated(res);
    },
  });

  const nameError = !name.trim() ? "Give the agent a name." : name.trim().length > 80 ? "Keep it under 80 characters." : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (nameError) return;
    create.mutate({
      name: name.trim(),
      description: description.trim() || null,
      grants: selected.map((accountId) => grantInput(accountId, { level, allowTo: [] })),
    });
  };

  const toggle = (id: string, on: boolean) => setPicked(on ? [...new Set([...selected, id])] : selected.filter((x) => x !== id));

  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <Field data-invalid={touched && !!nameError}>
          <FieldLabel htmlFor="agent-name">Name</FieldLabel>
          <Input
            id="agent-name"
            autoFocus
            placeholder="e.g. Support triage, Claude Code on laptop"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={touched && !!nameError}
          />
          {touched && nameError ? <FieldError>{nameError}</FieldError> : <FieldDescription>Shown in the audit log.</FieldDescription>}
        </Field>
        <Field>
          <FieldLabel htmlFor="agent-desc">
            Description <span className="font-normal text-muted-foreground">(optional)</span>
          </FieldLabel>
          <Textarea id="agent-desc" rows={2} placeholder="What does this agent do?" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <FieldSet>
          <FieldLegend variant="label">Mailboxes it can use</FieldLegend>
          {accounts.data?.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {accounts.data.map((a) => (
                <label key={a.id} className="flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50">
                  <Checkbox checked={selected.includes(a.id)} onCheckedChange={(v) => toggle(a.id, v === true)} />
                  <span className="truncate">{a.email}</span>
                </label>
              ))}
            </div>
          ) : (
            <FieldDescription>No Gmail accounts connected yet. You can create the agent now and grant access later.</FieldDescription>
          )}
        </FieldSet>
        {selected.length > 0 && (
          <FieldSet>
            <FieldLegend variant="label">Access</FieldLegend>
            <FieldDescription>Change it, or limit who it can send to, per mailbox afterwards.</FieldDescription>
            <ChoiceCards
              aria-label="Access"
              value={level}
              onChange={setLevel}
              columns={2}
              choices={[
                { value: "read", title: "Read only", description: "Search and read mail and calendars, and receive events. Can't change or send anything." },
                { value: "full", title: "Full access", description: "Also organizes, drafts and sends mail and changes calendars, at once. Only for agents you trust." },
              ]}
            />
          </FieldSet>
        )}
        {create.isError && <ErrorAlert error={create.error} title="Couldn't create the agent" />}
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={create.isPending}>
            {create.isPending && <Spinner />}
            {submitLabel}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
