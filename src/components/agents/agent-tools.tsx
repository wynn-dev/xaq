import type { AgentTool } from "@shared/agent-api";
import type { Agent } from "@shared/types";
import { CheckCircle2Icon, CircleDashedIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { TimeAgo } from "@/components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { connectCommands } from "@/lib/cli";
import { useAgentOrigin, useMcpActivity } from "./agent-status";
import { lastCallShown } from "./last-call";
import { Command } from "./command";
import { ConnectSnippets } from "./connect-snippets";
import { ToolTabs, toolName, usePublicUrl } from "./connect-agent-guide";
import { TestConnection } from "./test-connection";
import { explainReason } from "@/lib/labels";

/** "Not called yet" / "Last tool call 2 minutes ago": whether the agent's own tool reaches xaq. */
export function McpStatus({ agent, label }: { agent: Agent; label: string }) {
  const { calls, connectedAt } = useMcpActivity(agent);
  // The last successful call; without one, the last call marked with what went wrong (no tick).
  const last = lastCallShown(calls, explainReason);
  return (
    <p role="status" className="flex items-center gap-2 text-sm">
      {last ? (
        <>
          {last.ok ? <CheckCircle2Icon className="size-4 shrink-0 text-success" /> : <TriangleAlertIcon className="size-4 shrink-0 text-warning" />}
          <span>
            Last tool call <TimeAgo date={last.call.ts} /> <span className="font-mono text-xs text-muted-foreground">({last.call.action})</span>
            {last.note && <span className="text-warning">, {last.note}</span>}
          </span>
        </>
      ) : connectedAt ? (
        <>
          <CheckCircle2Icon className="size-4 shrink-0 text-success" />
          <span>
            Connected <TimeAgo date={connectedAt} />, no tool calls yet
          </span>
        </>
      ) : (
        <>
          <CircleDashedIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">Not called yet: {label} hasn't used xaq's tools with this agent's key.</span>
        </>
      )}
    </p>
  );
}

/** Agent page: how this agent gets the MCP tools, depending on whether it was paired or created with a key. */
export function AgentTools({ agent, apiKey }: { agent: Agent; apiKey?: string }) {
  const origin = useAgentOrigin(agent);
  if (!origin.known) return null;
  return origin.paired && !apiKey ? <PairedTools agent={agent} initialTool={origin.tool} /> : <KeyTools agent={agent} apiKey={apiKey} />;
}

function PairedTools({ agent, initialTool }: { agent: Agent; initialTool: AgentTool | null }) {
  const { publicUrl } = usePublicUrl();
  const [picked, setTool] = useState<AgentTool | null>(null);
  const tool = picked ?? initialTool ?? "claude-code";
  const c = connectCommands(publicUrl, tool);
  const label = toolName(tool);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Give it the tools</CardTitle>
        <CardDescription>
          This agent was connected from its terminal, so its key is saved on that machine. Register xaq in its tool from there; the key is
          never shown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <McpStatus agent={agent} label={initialTool ? toolName(initialTool) : "the agent"} />
        <div className="space-y-3">
          <ToolTabs value={tool} onChange={setTool} />
          {!c.setupMcp ? (
            <p className="text-sm text-muted-foreground">
              Point your agent's MCP client at <code className="font-mono break-all text-foreground">{publicUrl}/mcp</code> with the header{" "}
              <code className="font-mono text-foreground">Authorization: Bearer &lt;key&gt;</code>. The key is the "apiKey" field in{" "}
              <code className="font-mono break-all text-foreground">~/.config/xaq/profiles/default.json</code> on that machine.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Run on the machine where you ran <code className="font-mono text-foreground">connect</code> (skip it if you used --setup-mcp), then
                restart {label}:
              </p>
              <Command code={c.setupMcp} label="setup-mcp command" />
              {c.mcpCheck && (
                <p className="text-sm text-muted-foreground">
                  Check that {label} has it: <code className="font-mono text-foreground">{c.mcpCheck}</code> lists{" "}
                  <span className="font-mono text-foreground">xaq</span>.
                </p>
              )}
            </>
          )}
          <p className="text-sm text-muted-foreground">Teach it the rules with the xaq skill:</p>
          <Command code={c.skillInstall} label="skill install command" />
        </div>
        <TestConnection agentId={agent.id} />
      </CardContent>
    </Card>
  );
}

function KeyTools({ agent, apiKey }: { agent: Agent; apiKey?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Give it the tools</CardTitle>
        <CardDescription>Add xaq as an MCP server in your agent with this agent's key.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <McpStatus agent={agent} label="your agent" />
        <ConnectSnippets apiKey={apiKey} />
        <TestConnection agentId={agent.id} />
      </CardContent>
    </Card>
  );
}
