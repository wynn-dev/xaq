import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, UnplugIcon } from "lucide-react";
import { ToneBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useNow } from "@/hooks/use-now";
import { queries } from "@/lib/queries";
import { connectionStatusView } from "./connection-flow";
import { useReconnect } from "./connection-row";

/** Overview: connections that need a reconnect soon. (A changed upstream tool needs nothing: it's only audited.) */
export function ConnectionsNotice() {
  const list = useQuery(queries.connections());
  const now = useNow(60_000);
  const { reconnect, dialog } = useReconnect();
  if (!list.data) return null;
  const fix = list.data
    .map((c) => ({ c, view: connectionStatusView(c, now) }))
    .filter(({ view }) => view.action === "reconnect");
  if (!fix.length) return null;
  return (
    <Card className="border-warning/40 bg-warning/[0.06]">
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangleIcon className="size-4 text-warning" />
          {fix.length === 1 ? "A connection needs you" : "Connections need you"}
        </div>
        <ul className="divide-y">
          {fix.map(({ c, view }) => (
            <li key={`fix-${c.id}`} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-48 flex-1 text-sm">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {c.name} <ToneBadge tone={view.tone}>{view.label}</ToneBadge>
                </div>
                <p className="text-xs text-muted-foreground">{view.description}</p>
              </div>
              <Button size="sm" onClick={() => reconnect(c)}>
                <UnplugIcon /> Reconnect
              </Button>
            </li>
          ))}
        </ul>
        {dialog}
      </CardContent>
    </Card>
  );
}
