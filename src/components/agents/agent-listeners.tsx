import type { AgentTool } from "@shared/agent-api";
import type { Agent } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { BellRingIcon } from "lucide-react";
import { useState } from "react";
import { StatusDot, TimeAgo } from "@/components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { connectCommands } from "@/lib/cli";
import { fmtNumber } from "@/lib/format";
import { queries } from "@/lib/queries";
import { useAgentOrigin } from "./agent-status";
import { InsecureTransportAlert, ListenCommands, ToolTabs } from "./connect-agent-guide";

/** `xaq listen` instances for this agent, and how to add one. */
export function AgentListeners({ agent }: { agent: Agent }) {
  const settings = useQuery(queries.settings());
  const origin = useAgentOrigin(agent);
  const [picked, setTool] = useState<AgentTool | null>(null);
  const tool = picked ?? origin.tool ?? "claude-code";
  const [acceptInsecure, setAcceptInsecure] = useState(false);
  const publicUrl = settings.data?.publicUrl ?? window.location.origin;
  const c = connectCommands(publicUrl, tool, acceptInsecure);
  const listeners = [...agent.listeners].sort((a, b) => Number(b.connected) - Number(a.connected));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRingIcon className="size-4 text-muted-foreground" /> Listeners
        </CardTitle>
        <CardDescription>
          A listener keeps an outbound connection open from the agent's machine and wakes the agent when new mail arrives. No
          open ports or public URL needed on that machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {listeners.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Machine</th>
                  <th className="px-3 py-2 font-medium">Consumer</th>
                  <th className="px-3 py-2 font-medium">Last seen</th>
                  <th className="px-3 py-2 text-right font-medium">Handled up to</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {listeners.map((l) => (
                  <tr key={l.consumer}>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className="flex items-center gap-2">
                        <StatusDot tone={l.connected ? "good" : "idle"} pulse={l.connected} />
                        {l.connected ? "Connected" : "Offline"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium">{l.client.hostname ?? "Unknown host"}</div>
                      <div className="text-xs text-muted-foreground">
                        {[l.client.platform, l.client.version && `CLI ${l.client.version}`].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{l.consumer}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      {l.connected ? <span className="text-muted-foreground">now</span> : <TimeAgo date={l.lastSeenAt} fallback="never" />}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap text-muted-foreground tabular">
                      {l.ackedSeq ? `event #${fmtNumber(l.ackedSeq)}` : "nothing yet"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
            No listener has connected for this agent yet.
          </p>
        )}

        <div className="space-y-3">
          <div className="text-sm font-medium">{listeners.length ? "Add or update a listener" : "Start a listener"}</div>
          <p className="text-sm text-muted-foreground">
            Run these on the machine where this agent was connected with <code className="font-mono text-foreground">npx xaq-cli connect</code>:
            the listener uses the key connect saved there.
          </p>
          <ToolTabs value={tool} onChange={setTool} />
          <InsecureTransportAlert publicUrl={publicUrl} accepted={acceptInsecure} onAcceptedChange={setAcceptInsecure} />
          <ListenCommands c={c} tool={tool} />
        </div>
      </CardContent>
    </Card>
  );
}
