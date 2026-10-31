import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircleIcon, CheckCircle2Icon } from "lucide-react";
import { Command } from "@/components/agents/command";
import { CodeBlock, QueryError, StatusDot, TimeAgo } from "@/components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/queries";

export function SystemCard() {
  const system = useQuery(queries.system());
  const latest = useQuery(queries.systemLatest());
  const s = system.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>System</CardTitle>
        <CardDescription>This xaq instance.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {system.isPending ? (
          <Skeleton className="h-32" />
        ) : !s ? (
          <QueryError error={system.error} onRetry={() => void system.refetch()} />
        ) : (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="font-mono text-xs">{s.version}</dd>
            <dt className="text-muted-foreground">Node.js</dt>
            <dd className="font-mono text-xs">{s.nodeVersion}</dd>
            <dt className="text-muted-foreground">Data directory</dt>
            <dd className="font-mono text-xs break-all">{s.dataDir}</dd>
            <dt className="text-muted-foreground">Runs as</dt>
            <dd className="min-w-0 space-y-1.5">
              <span className="block">{s.service ? "System service (starts automatically)" : "Foreground process"}</span>
              {!s.service && (
                <>
                  <span className="block text-xs text-muted-foreground">
                    Closing its terminal stops everything. To keep it running and start it at login, run this on the server:
                  </span>
                  <Command code={s.serviceCommand} label="service install command" />
                  <span className="block text-xs text-muted-foreground">Stop the one in your terminal first (Ctrl-C): the service can't start while it runs.</span>
                </>
              )}
            </dd>
            <dt className="text-muted-foreground">Mail sync</dt>
            <dd className="space-y-0.5">
              <span className="flex items-center gap-1.5">
                <StatusDot tone={s.ingest.lastError ? "bad" : s.ingest.running ? "good" : "idle"} />
                Polling · {s.ingest.running ? "running" : "stopped"}
              </span>
              <span className="block text-xs text-muted-foreground">
                Last check <TimeAgo date={s.ingest.lastPullAt} fallback="never" />
              </span>
              {s.ingest.lastError && <span className="block text-xs break-words text-critical">{s.ingest.lastError}</span>}
            </dd>
            <dt className="text-muted-foreground">Reachable at</dt>
            <dd className="space-y-0.5 font-mono text-xs">
              {s.addresses.map((a) => (
                <div key={a} className="break-all">
                  {a}
                </div>
              ))}
            </dd>
          </dl>
        )}
        {latest.data &&
          (latest.data.updateAvailable && latest.data.latest ? (
            <div className="space-y-2 rounded-lg border border-chart-1/30 bg-chart-1/5 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ArrowUpCircleIcon className="size-4 text-chart-1" /> Version {latest.data.latest} is available
              </div>
              <p className="text-xs text-muted-foreground">
                {s?.service
                  ? "Run this on the server. It reinstalls the service with the latest version; data, accounts and agents are kept."
                  : "Stop xaq, then run this on the server. Your data is kept."}
              </p>
              <CodeBlock code={latest.data.command} />
            </div>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2Icon className="size-3.5 text-success" /> You're on the latest version.
            </p>
          ))}
      </CardContent>
    </Card>
  );
}
