import type { Agent, AgentWithKey } from "@shared/types";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, KeyRoundIcon, MoreHorizontalIcon, PencilIcon, RotateCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { TimeAgo, ToneBadge } from "@/components/common";
import { confirm } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys } from "@/lib/queries";
import { forgetKey, rememberKey } from "@/lib/revealed-keys";
import { AgentCreated } from "./agent-created";

type Patch = { name?: string; description?: string | null; disabled?: boolean };

export function AgentHeader({ agent }: { agent: Agent }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [rotated, setRotated] = useState<AgentWithKey>();
  const path = `/api/agents/${encodeURIComponent(agent.id)}`;

  const patch = useApiMutation({
    mutationFn: (p: Patch) => api<Agent>(path, { method: "PATCH", body: p }),
    invalidate: [keys.agents],
    success: (a, p) => (p.disabled === undefined ? "Agent updated" : p.disabled ? `${a.name} disabled` : `${a.name} enabled`),
    errorTitle: "Couldn't update the agent",
  });
  const rotate = useApiMutation({
    mutationFn: () => api<AgentWithKey>(`${path}/rotate-key`, { method: "POST" }),
    invalidate: [keys.agents],
    success: "New key created. The old key no longer works.",
    errorTitle: false,
    onSuccess: (res) => {
      rememberKey(agent.id, res.apiKey);
      setRotated(res);
    },
  });
  const remove = useApiMutation({
    mutationFn: () => api(path, { method: "DELETE" }),
    invalidate: [keys.agents, keys.webhooks, keys.setupState, keys.overview],
    success: `Agent "${agent.name}" deleted`,
    errorTitle: false,
    onSuccess: () => {
      forgetKey(agent.id);
      void navigate({ to: "/agents" });
    },
  });

  const askRotate = () =>
    confirm({
      title: "Rotate this agent's API key?",
      description: "A new key is created and the current one stops working immediately. Update the agent's MCP configuration with the new key.",
      confirmLabel: "Rotate key",
      onConfirm: () => rotate.mutateAsync(),
    });
  const askDelete = () =>
    confirm({
      title: `Delete ${agent.name}?`,
      description: (
        <>
          <p>Its API key stops working, and its grants and webhooks are deleted.</p>
          <p>Audit log entries are kept.</p>
        </>
      ),
      confirmLabel: "Delete agent",
      destructive: true,
      onConfirm: () => remove.mutateAsync(),
    });

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" asChild className="-ml-2 text-muted-foreground">
        <Link to="/agents">
          <ArrowLeftIcon /> Agents
        </Link>
      </Button>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{agent.name}</h1>
            {agent.disabled && <ToneBadge tone="idle">Disabled</ToneBadge>}
          </div>
          {agent.description && <p className="max-w-2xl text-sm text-muted-foreground">{agent.description}</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5 font-mono">
              <KeyRoundIcon className="size-3.5" /> {agent.keyPrefix}…
            </span>
            <span>
              Last used <TimeAgo date={agent.lastUsedAt} fallback="never" />
            </span>
            <span>
              Created <TimeAgo date={agent.createdAt} />
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              id="agent-enabled"
              checked={!agent.disabled}
              disabled={patch.isPending}
              onCheckedChange={(on) => patch.mutate({ disabled: !on })}
            />
            <Label htmlFor="agent-enabled" className="text-sm">
              {agent.disabled ? "Disabled" : "Enabled"}
            </Label>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Agent actions">
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <PencilIcon /> Edit name & description
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={askRotate}>
                <RotateCwIcon /> Rotate API key…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={askDelete}>
                <Trash2Icon /> Delete agent…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {agent.disabled && (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          This agent is disabled: its key is refused and its webhooks don't fire. Its permissions are kept for when you enable it again.
        </p>
      )}

      {editing && (
        <EditDialog agent={agent} onOpenChange={setEditing} onSave={(p) => patch.mutateAsync(p).then(() => setEditing(false))} pending={patch.isPending} />
      )}

      {/* One-time key: only the explicit button closes it (no Escape, outside click or X). */}
      <Dialog open={!!rotated}>
        <DialogContent
          className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
          showCloseButton={false}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>New API key for {agent.name}</DialogTitle>
            <DialogDescription>The previous key has stopped working. Update your agent's configuration with this one.</DialogDescription>
          </DialogHeader>
          {rotated && <AgentCreated res={rotated} />}
          <DialogFooter>
            <Button onClick={() => setRotated(undefined)}>I've saved the key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Mounted only while open, so it always starts from the agent's current values. */
function EditDialog({
  agent,
  onOpenChange,
  onSave,
  pending,
}: {
  agent: Agent;
  onOpenChange: (o: boolean) => void;
  onSave: (p: Patch) => Promise<unknown>;
  pending: boolean;
}) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void onSave({ name: name.trim(), description: description.trim() || null }).catch(() => {});
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>Edit agent</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="edit-name">Name</FieldLabel>
              <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!name.trim()} />
            </Field>
            <Field>
              <FieldLabel htmlFor="edit-desc">Description</FieldLabel>
              <Textarea id="edit-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || pending}>
              {pending && <Spinner />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
