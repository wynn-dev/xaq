import type { ConnectionView, StartConnectResult } from "@shared/types";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, MoreHorizontalIcon, NetworkIcon, PauseIcon, Trash2Icon, UnplugIcon, WrenchIcon } from "lucide-react";
import { useState } from "react";
import { ToneBadge } from "@/components/common";
import { confirm } from "@/components/confirm";
import { PasswordInput } from "@/components/password-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useNow } from "@/hooks/use-now";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys } from "@/lib/queries";
import { connectConnection } from "./connection-auth";
import { connectionStatusView, hostPort } from "./connection-flow";

const path = (c: Pick<ConnectionView, "id">, rest = "") => `/api/connections/${encodeURIComponent(c.id)}${rest}`;
/** POST /connect (Reconnect). A typed header goes out once: "Try again" retries without it. */
export function startConnect(c: Pick<ConnectionView, "id" | "name">, body: { header?: { name: string; value: string } } = {}) {
  let once: typeof body | null = body;
  connectConnection({
    name: c.name,
    run: async () => {
      const b = once ?? {};
      once = null;
      return { connectionId: c.id, result: await api<StartConnectResult>(path(c, "/connect"), { body: b }) };
    },
  });
}

/** Reconnect (POST /connect again): OAuth runs a fresh sign-in; a header connection asks for the new key; an open one just retries. */
export function useReconnect() {
  const [askingKey, setAskingKey] = useState<ConnectionView | null>(null);
  const reconnect = (c: ConnectionView) => (c.authType === "header" ? setAskingKey(c) : startConnect(c));
  const dialog = <HeaderReconnectDialog connection={askingKey} onClose={() => setAskingKey(null)} />;
  return { reconnect, dialog };
}

function HeaderReconnectDialog({ connection: c, onClose }: { connection: ConnectionView | null; onClose: () => void }) {
  const [name, setName] = useState("Authorization");
  const [value, setValue] = useState("");
  // The typed key never outlives the dialog.
  const cancel = () => {
    setValue("");
    onClose();
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!c || !value.trim()) return;
    const n = name.trim() || "Authorization";
    const v = value.trim();
    onClose();
    setValue("");
    startConnect(c, { header: { name: n, value: n.toLowerCase() === "authorization" && !/^\w+\s/.test(v) ? `Bearer ${v}` : v } });
  };
  return (
    <Dialog open={!!c} onOpenChange={(o) => !o && cancel()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Reconnect {c?.name}</DialogTitle>
            <DialogDescription>Paste the new API key or token. The old one is replaced.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
            <Field>
              <FieldLabel htmlFor="reconnect-name">Header</FieldLabel>
              <Input id="reconnect-name" className="font-mono" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="reconnect-key">API key or token</FieldLabel>
              <PasswordInput id="reconnect-key" autoFocus autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <FieldDescription className="sm:col-span-2">Stored encrypted; agents never see it.</FieldDescription>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              Reconnect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function useConnectionActions() {
  const invalidate = [keys.connections, ["agent-connections"], keys.overview] as const;
  // The kill switch (POST /kill, the policy's): disabled, credentials deleted. Reconnect brings it back.
  const kill = useApiMutation({
    mutationFn: (c: ConnectionView) => api(path(c, "/kill"), { body: {} }),
    invalidate,
    success: (_, c) => `${c.name} is disabled and signed out`,
    errorTitle: "Couldn't disable it",
  });
  // DELETE runs the kill switch, then removes the connection.
  const remove = useApiMutation({
    mutationFn: (c: ConnectionView) => api(path(c), { method: "DELETE" }),
    invalidate,
    success: (_, c) => `${c.name} is removed`,
    errorTitle: "Couldn't remove it",
  });
  const killList = (c: ConnectionView) => (
    <ul className="list-disc space-y-1 pl-5">
      <li>stops every agent from using its tools,</li>
      <li>signs out of {c.name} and deletes the stored credentials.</li>
    </ul>
  );
  const askDisable = (c: ConnectionView) =>
    confirm({
      title: `Disable ${c.name}?`,
      destructive: true,
      confirmLabel: "Disable now",
      description: (
        <>
          <p>This is the kill switch. Right away, xaq:</p>
          {killList(c)}
          <p>The connection, its access settings and the audit log stay. Reconnect to use it again.</p>
        </>
      ),
      onConfirm: () => kill.mutateAsync(c),
    });
  const askRemove = (c: ConnectionView, after?: () => void) =>
    confirm({
      title: `Remove ${c.name}?`,
      destructive: true,
      confirmLabel: "Remove now",
      description: (
        <>
          <p>Right away, xaq:</p>
          {killList(c)}
          <p>Then the connection and its access settings are deleted. The audit log keeps what happened.</p>
        </>
      ),
      onConfirm: async () => {
        await remove.mutateAsync(c);
        after?.();
      },
    });
  return { askDisable, askRemove };
}

/** One row of the Connections page: status, private-network badge, tool count, and the fixes. */
export function ConnectionRow({ connection: c }: { connection: ConnectionView }) {
  const now = useNow(60_000);
  const view = connectionStatusView(c, now);
  const { askDisable, askRemove } = useConnectionActions();
  const { reconnect, dialog } = useReconnect();
  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to="/connections/$connectionId" params={{ connectionId: c.id }} className="truncate font-medium hover:underline">
            {c.name}
          </Link>
          <ToneBadge tone={view.tone}>{view.label}</ToneBadge>
          {c.privateTarget && (
            <Badge variant="outline" title={`Allowed on your private network: ${hostPort(c.privateTarget)}`}>
              <NetworkIcon /> Private network
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
          <span className="font-mono">{c.slug}</span>
          <span className="flex items-center gap-1">
            <WrenchIcon className="size-3" /> {c.tools.total} tool{c.tools.total === 1 ? "" : "s"}
          </span>
          <span>
            {c.agents} agent{c.agents === 1 ? "" : "s"}
          </span>
          {c.url && <span className="max-w-64 truncate">{c.url}</span>}
        </div>
        {view.tone === "bad" && (
          <p className="mt-2 flex max-w-3xl items-start gap-1.5 rounded-md bg-critical/[0.06] px-2.5 py-1.5 text-xs text-foreground/90">
            <AlertTriangleIcon className="mt-px size-3.5 shrink-0 text-critical" />
            <span className="break-words">{view.description}</span>
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
        {view.action === "reconnect" && (
          <Button size="sm" variant={c.status === "disabled" ? "outline" : "default"} onClick={() => reconnect(c)}>
            <UnplugIcon /> Reconnect
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.name}`}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => reconnect(c)}>
              <UnplugIcon /> Reconnect
            </DropdownMenuItem>
            {c.status !== "disabled" && (
              <DropdownMenuItem onSelect={() => askDisable(c)}>
                <PauseIcon /> Disable…
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => askRemove(c)}>
              <Trash2Icon /> Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {dialog}
    </div>
  );
}