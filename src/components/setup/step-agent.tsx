import type { Agent, AgentWithKey } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BotIcon, ChevronDownIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import { AgentCreateForm } from "@/components/agents/agent-create-form";
import { AgentCreated } from "@/components/agents/agent-created";
import { ConnectAgentGuide } from "@/components/agents/connect-agent-guide";
import { Button } from "@/components/ui/button";
import { queries } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { setVerifyAgent } from "./step-verify";
import type { StepProps } from "./step-url";
import { StepCard, StepFooter } from "./wizard-shell";

/**
 * Step 6: pair the first agent from its terminal and approve it inline by typing its code. Approval
 * moves straight on to the Verify step, which checks MCP, the listener and a test email live.
 * Creating an agent here with a copied key stays available as an advanced alternative.
 */
export function StepAgent({ index, onBack, onNext, total, nextLabel }: StepProps) {
  const agents = useQuery(queries.agents());
  const existing = agents.data ?? [];
  const [created, setCreated] = useState<AgentWithKey>();
  const [another, setAnother] = useState(false);
  const [withKey, setWithKey] = useState(false);
  const connecting = !created && (existing.length === 0 || another);
  const hasAgent = existing.length > 0 || !!created;

  const approved = (a: Agent) => {
    setVerifyAgent(a.id);
    onNext();
  };

  return (
    <StepCard
      index={index}
      total={total}
      title={created ? `${created.agent.name} is ready` : "Connect your first agent"}
      description={
        created
          ? "Save its key and add xaq to your agent with a snippet below. The next step checks that it works."
          : "Your agent is the AI tool that will read your mail, like Claude Code or Codex. It asks for access from its own terminal and you approve it here. It only gets the access you choose."
      }
      footer={
        <StepFooter
          onBack={onBack}
          onNext={onNext}
          nextLabel={nextLabel ?? "Check that it works"}
          nextDisabled={!hasAgent}
          hint={created ? "Make sure you've saved the key" : !hasAgent ? "Approve a request to continue" : undefined}
          extra={
            !hasAgent && (
              <Button variant="ghost" onClick={onNext}>
                Skip for now
              </Button>
            )
          }
        />
      }
    >
      {created ? (
        <AgentCreated res={created} />
      ) : connecting ? (
        <div className="space-y-6">
          <ConnectAgentGuide variant="wizard" onApproved={approved} />
          <div className="border-t pt-4">
            <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" aria-expanded={withKey} onClick={() => setWithKey(!withKey)}>
              <KeyRoundIcon /> Advanced: create it here and copy a key instead
              <ChevronDownIcon className={cn("transition-transform", withKey && "rotate-180")} />
            </Button>
            {withKey && (
              <div className="mt-3 space-y-3">
                <p className="text-sm text-muted-foreground">
                  For agents that can't run <code className="font-mono">npx</code>, like a hosted app. You paste the key into its MCP settings yourself, and it
                  can't use a listener.
                </p>
                <AgentCreateForm
                  defaultName={existing.length ? "" : "My first agent"}
                  onCreated={(res) => {
                    setVerifyAgent(res.agent.id);
                    setCreated(res);
                  }}
                  onCancel={() => setWithKey(false)}
                />
              </div>
            )}
          </div>
          {another && (
            <Button variant="ghost" size="sm" onClick={() => setAnother(false)}>
              Cancel
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm">
            You have {existing.length} agent{existing.length === 1 ? "" : "s"} already. Continue to check that{" "}
            {existing.length === 1 ? "it works" : "one works"}, or connect another.
          </p>
          <div className="flex flex-wrap gap-2">
            {existing.slice(0, 4).map((a) => (
              <Button key={a.id} variant="outline" size="sm" asChild>
                <Link to="/agents/$agentId" params={{ agentId: a.id }}>
                  <BotIcon /> {a.name}
                </Link>
              </Button>
            ))}
            <Button variant="ghost" size="sm" onClick={() => setAnother(true)}>
              Connect another
            </Button>
          </div>
        </div>
      )}
    </StepCard>
  );
}
