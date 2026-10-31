import type { AgentToolMode as ToolModeView } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { ListIcon, SearchIcon } from "lucide-react";
import { QueryError } from "@/components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { keys, queries } from "@/lib/queries";

type Mode = ToolModeView["mode"];

const MODE_INFO: Record<Mode, { label: string; description: (n: number) => string }> = {
  direct: { label: "Every tool", description: (n) => `The agent sees all ${n} of its tools.` },
  search: {
    label: "Search",
    description: () => "The agent sees a search tool and looks up the others when it needs them. Easier for agents with many tools.",
  },
};

/** Agent page (broker on): whether /mcp lists every tool or search mode, chosen by the user (docs/MCP-BROKER.md). */
export function AgentToolMode({ agentId }: { agentId: string }) {
  const q = useQuery(queries.agentToolMode(agentId));
  const set = useApiMutation({
    mutationFn: (mode: Mode) => api<ToolModeView>(`/api/agents/${encodeURIComponent(agentId)}/tool-mode`, { method: "PUT", body: { mode } }),
    invalidate: [keys.agent(agentId)],
    success: (_, mode) => `Tool list: ${MODE_INFO[mode].label.toLowerCase()}`,
    errorTitle: "Couldn't change the tool list",
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tool list</CardTitle>
        <CardDescription>What the agent sees when it asks xaq for its tools. Calling a tool by name works either way, with the same access.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.isPending ? (
          <Skeleton className="h-9 w-56" />
        ) : q.isError ? (
          <QueryError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={q.data.mode}
              disabled={set.isPending}
              onValueChange={(v) => v && v !== q.data.mode && set.mutate(v as Mode)}
              aria-label="Tool list"
              className="flex-wrap"
            >
              <ToggleGroupItem value="direct">
                <ListIcon /> {MODE_INFO.direct.label}
              </ToggleGroupItem>
              <ToggleGroupItem value="search">
                <SearchIcon /> {MODE_INFO.search.label}
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">{MODE_INFO[q.data.mode].description(q.data.tools)}</p>
            {q.data.setting === "auto" ? (
              <p className="text-xs text-muted-foreground">
                Not chosen yet: xaq picks the first time the agent connects, every tool up to {q.data.threshold} and search above that. It doesn't change by
                itself after that.
              </p>
            ) : (
              q.data.mode === "direct" &&
              q.data.tools > q.data.threshold && (
                <p className="text-xs text-warning">
                  This agent has {q.data.tools} tools. Long tool lists can confuse some agents; if yours picks the wrong tools, try Search.
                </p>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
