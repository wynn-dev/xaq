import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { QueryError, ToneBadge } from "@/components/common";
import { openAddConnection } from "@/components/connections/add-connection";
import { AGENT_LEVELS, connectionStatusView, grantsWith, LEVEL_INFO } from "@/components/connections/connection-flow";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import type { ConnectionGrant } from "@shared/types";
import type { AgentConnection, AgentLevel } from "@/lib/broker-dto";
import { keys, queries } from "@/lib/queries";

/** The agent's level on each connection (Full / Read only / No access). */
export function AgentConnections({ agentId }: { agentId: string }) {
  const list = useQuery(queries.agentConnections(agentId));
  return (
    <section className="space-y-3" aria-labelledby="connections-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="connections-heading" className="text-lg font-semibold tracking-tight">
            Connections
          </h2>
          <p className="text-sm text-muted-foreground">What this agent may do with each connection. xaq enforces it on every call.</p>
        </div>
      </div>
      {list.isPending ? (
        <Skeleton className="h-20 rounded-xl" />
      ) : list.isError ? (
        <QueryError error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">No connections yet. Install an extension (Notion, T3 Code, WHOOP…) and connect it, or add any MCP server, for your agents.</p>
            <Button variant="outline" onClick={() => openAddConnection()}>
              <PlusIcon /> Add connection
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="gap-0 py-0">
          <ul className="divide-y">
            {list.data.map((c) => (
              <ConnectionLevelRow key={c.connectionId} agentId={agentId} c={c} />
            ))}
          </ul>
        </Card>
      )}

    </section>
  );
}

function ConnectionLevelRow({ agentId, c }: { agentId: string; c: AgentConnection }) {
  const now = useNow(60_000);
  const status = connectionStatusView({ ...c, statusReason: null, expiresAt: null }, now);
  const set = useApiMutation({
    // The API takes a connection's full grant list: read it fresh, change this agent's entry, put it back.
    mutationFn: async (level: AgentLevel) => {
      const base = `/api/connections/${encodeURIComponent(c.connectionId)}/grants`;
      const grants = await api<ConnectionGrant[]>(base);
      return api<ConnectionGrant[]>(base, { method: "PUT", body: grantsWith(grants, agentId, level) });
    },
    invalidate: [keys.agentConnections(agentId), keys.connections],
    success: (_, level) => `${c.name}: ${LEVEL_INFO[level].label.toLowerCase()}`,
    errorTitle: "Couldn't change the access",
  });
  return (
    <li className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/connections/$connectionId" params={{ connectionId: c.connectionId }} className="font-medium hover:underline">
            {c.name}
          </Link>
          {c.status !== "active" && <ToneBadge tone={status.tone}>{status.label}</ToneBadge>}
        </div>
        <p className="text-xs text-muted-foreground">{LEVEL_INFO[c.level].description}</p>
      </div>
      <Select value={c.level} onValueChange={(v) => set.mutate(v as AgentLevel)} disabled={set.isPending}>
        <SelectTrigger className="w-full sm:w-60" aria-label={`Access to ${c.name}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AGENT_LEVELS.map((l) => (
            <SelectItem key={l} value={l}>
              {LEVEL_INFO[l].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </li>
  );
}
