import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, NetworkIcon, PauseIcon, PencilIcon, RefreshCwIcon, Trash2Icon, UnplugIcon } from "lucide-react";
import { useState } from "react";
import { PageHeader, QueryError, TimeAgo, ToneBadge } from "@/components/common";
import { connectionStatusView, googleAccessView, grantedScopesView, hostPort } from "@/components/connections/connection-flow";
import { useConnectionActions, useReconnect } from "@/components/connections/connection-row";
import { RenameSlugDialog } from "@/components/connections/rename-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useNow } from "@/hooks/use-now";
import { toast } from "sonner";
import { api, toastError } from "@/lib/api";
import { keys, queries } from "@/lib/queries";

export const Route = createFileRoute("/_app/connections/$connectionId")({
  component: ConnectionPage,
});

function ConnectionPage() {
  const { connectionId } = Route.useParams();
  const navigate = useNavigate();
  const conn = useQuery(queries.connection(connectionId));
  const now = useNow(60_000);
  const { askDisable, askRemove } = useConnectionActions();
  const { reconnect, dialog } = useReconnect();
  const [renaming, setRenaming] = useState(false);
  const qc = useQueryClient();
  // "Refresh tools": list the server's tools again now (a changed or new tool is used at once; the audit log notes it).
  const refresh = useMutation({
    mutationFn: () => api<{ ok: boolean; error: string | null }>(`/api/connections/${encodeURIComponent(connectionId)}/refresh`, { method: "POST" }),
    onSuccess: (r) => {
      if (r.ok) toast.success("Tools refreshed");
      else toast.error("Couldn't list the tools", { description: r.error ?? undefined });
      void qc.invalidateQueries({ queryKey: keys.connection(connectionId) });
      void qc.invalidateQueries({ queryKey: keys.connections });
    },
    onError: (err) => toastError(err, "Couldn't refresh the tools"),
  });

  if (conn.isPending) return <Skeleton className="h-64 rounded-xl" />;
  if (conn.isError) return <QueryError error={conn.error} onRetry={() => void conn.refetch()} />;
  const c = conn.data;
  const view = connectionStatusView(c, now);
  const scopes = grantedScopesView(c);
  const google = googleAccessView(c);

  return (
    <>
      <Button variant="ghost" size="sm" className="-ml-2 self-start" asChild>
        <Link to="/connections">
          <ArrowLeftIcon /> Connections
        </Link>
      </Button>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {c.name} <ToneBadge tone={view.tone}>{view.label}</ToneBadge>
            {c.privateTarget && (
              <Badge variant="outline">
                <NetworkIcon /> Private network: {hostPort(c.privateTarget)}
              </Badge>
            )}
          </span>
        }
        description={view.description}
        actions={
          <>
            <Button variant={view.action === "reconnect" ? "default" : "outline"} onClick={() => reconnect(c)}>
              <UnplugIcon /> Reconnect
            </Button>
            {c.status !== "disabled" && (
              <Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
                {refresh.isPending ? <Spinner /> : <RefreshCwIcon />} Refresh tools
              </Button>
            )}
            {c.status !== "disabled" && (
              <Button variant="outline" onClick={() => askDisable(c)}>
                <PauseIcon /> Disable
              </Button>
            )}
            <Button variant="outline" className="text-critical" onClick={() => askRemove(c, () => void navigate({ to: "/connections" }))}>
              <Trash2Icon /> Remove
            </Button>
          </>
        }
      />
      {dialog}
      <RenameSlugDialog connection={c} open={renaming} onOpenChange={setRenaming} />

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          Tools as <code className="font-mono text-foreground">{c.slug}__…</code>
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setRenaming(true)}>
            <PencilIcon /> Change short name
          </Button>
        </span>
        <span>
          {c.tools.total} tool{c.tools.total === 1 ? "" : "s"}
        </span>
        <span>
          {c.agents} agent{c.agents === 1 ? "" : "s"}
        </span>
        {c.url && <span className="break-all">{c.url}</span>}
        <span>
          Connected <TimeAgo date={c.createdAt} />
        </span>
      </div>
      {scopes && (
        <div className="space-y-1 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">Access {c.name} granted:</span>
            {scopes.scopes.length ? (
              scopes.scopes.map((s) => (
                <Badge key={s} variant="outline" className="font-mono">
                  {s}
                </Badge>
              ))
            ) : (
              <span className="text-muted-foreground">no scopes named</span>
            )}
          </div>
          {scopes.note && <p className="text-muted-foreground">{scopes.note}</p>}
        </div>
      )}
      {google && (
        <div className="space-y-1 text-sm">
          <p>
            <span className="text-muted-foreground">Works as the Google account </span>
            {google.account}
            <span className="text-muted-foreground">, with tokens limited to the access above: never its mail.</span>
          </p>
          {google.note && <p className="text-muted-foreground">{google.note}</p>}
          <p className="text-muted-foreground">
            Removing this connection keeps that access on the account. To take it back, use your{" "}
            <a className="underline underline-offset-4" href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer noopener">
              Google account permissions
            </a>{" "}
            (that removes all of xaq's access, mail included: reconnect the account afterwards).
          </p>
        </div>
      )}
    </>
  );
}
