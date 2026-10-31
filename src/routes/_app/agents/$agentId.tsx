import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { EyeOffIcon } from "lucide-react";
import { useState } from "react";
import { ConnectAccountButton } from "@/components/accounts/accounts-list";
import { AgentActivity } from "@/components/agents/agent-activity";
import { AgentConnections } from "@/components/agents/agent-connections";
import { AgentHeader } from "@/components/agents/agent-header";
import { AgentListeners } from "@/components/agents/agent-listeners";
import { AgentTools } from "@/components/agents/agent-tools";
import { AgentWebhooks } from "@/components/agents/agent-webhooks";
import { GrantEditor } from "@/components/agents/grant-editor";
import { KeyReveal } from "@/components/agents/key-reveal";
import { QueryError } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/queries";
import { useRevealedKey } from "@/lib/revealed-keys";

export const Route = createFileRoute("/_app/agents/$agentId")({
  component: AgentPage,
});

function AgentPage() {
  const { agentId } = Route.useParams();
  const agent = useQuery(queries.agent(agentId));
  const accounts = useQuery(queries.accounts());
  const apiKey = useRevealedKey(agentId);
  const [keyHidden, setKeyHidden] = useState(false);

  if (agent.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 w-80" />
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (agent.isError) return <QueryError error={agent.error} onRetry={() => void agent.refetch()} />;
  const a = agent.data;

  return (
    <>
      <AgentHeader agent={a} />

      {apiKey && !keyHidden && (
        <Card>
          <CardHeader>
            <CardTitle>API key</CardTitle>
            <CardDescription>Visible until you leave or reload this page.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" onClick={() => setKeyHidden(true)}>
                <EyeOffIcon /> Hide
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <KeyReveal apiKey={apiKey} />
          </CardContent>
        </Card>
      )}

      <section className="space-y-3" aria-labelledby="access-heading">
        <div>
          <h2 id="access-heading" className="text-lg font-semibold tracking-tight">
            Mailbox access
          </h2>
          <p className="text-sm text-muted-foreground">
            What this agent may do in each Gmail account. Guardrails are enforced by xaq; the agent can't bypass them.
          </p>
        </div>
        {accounts.isPending ? (
          <Skeleton className="h-20 rounded-xl" />
        ) : accounts.isError ? (
          <QueryError error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : accounts.data.length === 0 ? (
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">Connect a Gmail account to give this agent something to work with.</p>
              <ConnectAccountButton variant="outline" />
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {accounts.data.map((acc) => (
              <GrantEditor
                key={acc.id}
                agentId={a.id}
                account={acc}
                grant={a.grants.find((g) => g.accountId === acc.id)}
                defaultOpen={accounts.data.length === 1}
              />
            ))}
          </div>
        )}
      </section>

      <AgentConnections agentId={a.id} />

      <AgentTools agent={a} apiKey={apiKey} />

      <AgentListeners agent={a} />

      <div className="grid gap-6 lg:grid-cols-2">
        <AgentWebhooks agentId={a.id} />
        <AgentActivity agentId={a.id} />
      </div>
    </>
  );
}
