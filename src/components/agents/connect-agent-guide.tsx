import type { AgentTool } from "@shared/agent-api";
import type { Agent } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BellRingIcon, BookOpenIcon, ShieldAlertIcon, ShieldCheckIcon, SparklesIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/common";
import { PendingPairings } from "@/components/approvals/pairing";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type ConnectCommands, connectCommands, RECIPES, TOOL_LABEL, TOOLS, transportOf } from "@/lib/cli";
import { queries } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { Command } from "./command";

/**
 * Loud warning for plain-http public URLs that aren't loopback or Tailscale. The CLI refuses them
 * without --insecure; the flag is only added to copied commands after an explicit opt-in.
 */
export function InsecureTransportAlert({
  publicUrl,
  accepted,
  onAcceptedChange,
  className,
}: {
  publicUrl: string;
  accepted: boolean;
  onAcceptedChange: (v: boolean) => void;
  className?: string;
}) {
  if (transportOf(publicUrl) !== "insecure") return null;
  return (
    <Alert variant="destructive" className={className}>
      <ShieldAlertIcon />
      <AlertTitle>{new URL(publicUrl).host} is plain http: agent traffic would be unencrypted</AlertTitle>
      <AlertDescription>
        <p>
          The agent's API key, the skill it reads and every email event would cross the network in the clear, readable and changeable by anyone
          in between. <code className="font-mono">connect</code> and <code className="font-mono">listen</code> refuse this address unless you add{" "}
          <code className="font-mono">--insecure</code>.
        </p>
        <p className="text-foreground/80">
          Put xaq behind https (a reverse proxy or tunnel), or reach it over Tailscale, then update the{" "}
          <Link to="/settings" hash="public-url" className="font-medium underline underline-offset-4">
            public URL
          </Link>
          .
        </p>
        <label className="mt-1 flex cursor-pointer items-center gap-2 text-foreground">
          <Checkbox checked={accepted} onCheckedChange={(v) => onAcceptedChange(v === true)} />
          I understand the risk: include <code className="font-mono">--insecure</code> in the commands
        </label>
      </AlertDescription>
    </Alert>
  );
}

function Step({ n, icon: Icon, title, children }: { n: number; icon: typeof TerminalIcon; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="relative grid grid-cols-[2rem_1fr] gap-x-3 pb-6 last:pb-0">
      <span className="absolute top-8 bottom-1 left-4 w-px bg-border [li:last-child>&]:hidden" aria-hidden />
      <span className="relative flex size-8 items-center justify-center rounded-full border bg-background text-muted-foreground">
        <Icon className="size-4" />
        <span className="sr-only">Step {n}</span>
      </span>
      <div className="min-w-0 space-y-2 pt-1">
        <div className="text-sm font-medium">{title}</div>
        {children}
      </div>
    </li>
  );
}

export function ToolTabs({ value, onChange, className }: { value: AgentTool; onChange: (t: AgentTool) => void; className?: string }) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as AgentTool)} className={className}>
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <TabsList aria-label="Your agent's tool" className="max-w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto">
          {TOOLS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {TOOL_LABEL[t]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </Tabs>
  );
}

export const toolName = (tool: AgentTool) => (tool === "other" ? "your agent" : TOOL_LABEL[tool]);

/** The public URL agents connect to (the browser's origin until settings load). */
export function usePublicUrl() {
  const settings = useQuery(queries.settings());
  return { publicUrl: settings.data?.publicUrl ?? window.location.origin, settings: settings.data };
}

export function PairingOffAlert() {
  const { settings } = usePublicUrl();
  if (!settings || settings.pairingEnabled) return null;
  return (
    <Alert>
      <ShieldAlertIcon />
      <AlertTitle>Pairing is turned off</AlertTitle>
      <AlertDescription>
        <p>
          <code className="font-mono">connect</code> will be refused until you turn on{" "}
          <Link to="/settings" hash="pairing" className="font-medium text-foreground underline underline-offset-4">
            Accept pairing requests
          </Link>{" "}
          in Settings. You can still create an agent and copy its key yourself.
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** `listen`: try it in the foreground first, then install it as a service (the order `connect` prints). */
export function ListenCommands({ c, tool }: { c: ConnectCommands; tool: AgentTool }) {
  const label = toolName(tool);
  return (
    <ol className="space-y-3 text-sm">
      <li className="space-y-1.5">
        <p>
          <span className="font-medium">1. Try it.</span> <span className="text-muted-foreground">Runs in this terminal until you press Ctrl-C.</span>
        </p>
        <Command code={c.listenTry} label="listen command" />
        <p className="text-xs text-muted-foreground">
          {tool !== "claude-code"
            ? "This test command only confirms each email (a ✓ line per email). Swap in your own script for the service."
            : `Starts ${label} for each new email you receive (not mail you send; Promotions, Social and Forums are skipped). ${RECIPES[tool].note}`}
        </p>
      </li>
      <li className="space-y-1.5">
        <p>
          <span className="font-medium">2. Keep it running.</span>{" "}
          <span className="text-muted-foreground">Installs a background service that starts at login and survives closing the terminal.</span>
        </p>
        <Command code={c.listenService} label="service install command" />
        {tool !== "claude-code" && <p className="text-xs text-muted-foreground">Replace /path/to/handle-email.sh with your script. {RECIPES[tool].note}</p>}
      </li>
    </ol>
  );
}

/** "Tell your agent to set itself up": hidden on plain http, where the commands need an explicit opt-in. */
function SelfSetup({ c }: { c: ConnectCommands }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <SparklesIcon className="size-4 text-chart-1" /> Or let the agent set itself up
      </div>
      <p className="mb-2 text-sm text-muted-foreground">Tell your agent:</p>
      <div className="flex flex-col items-start gap-2 rounded-md border bg-background py-1.5 pr-1.5 pl-3 sm:flex-row">
        <p className="min-w-0 flex-1 py-1 text-sm break-words">“{c.selfSetup}”</p>
        <CopyButton value={c.selfSetup} label="Copy prompt" withText variant="outline" className="self-end sm:self-auto" />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">It reads the skill, runs connect for you, and its request shows up here to approve.</p>
    </div>
  );
}

/**
 * Device-flow pairing, step by step: run `connect` on the agent's machine, approve the request
 * inline by typing its code, then (full variant) install the skill and keep a listener running.
 * The wizard variant stops after approval: its next step checks MCP and the listener live.
 */
export function ConnectAgentGuide({
  className,
  variant = "full",
  onApproved,
}: {
  className?: string;
  variant?: "full" | "wizard";
  onApproved?: (agent: Agent) => void;
}) {
  const { publicUrl } = usePublicUrl();
  const [tool, setTool] = useState<AgentTool>("claude-code");
  const [acceptInsecure, setAcceptInsecure] = useState(false);
  const insecure = transportOf(publicUrl) === "insecure";
  const c = connectCommands(publicUrl, tool, acceptInsecure);
  const label = toolName(tool);

  return (
    <div className={cn("space-y-5", className)}>
      <PairingOffAlert />
      <InsecureTransportAlert publicUrl={publicUrl} accepted={acceptInsecure} onAcceptedChange={setAcceptInsecure} />

      <div className="space-y-3">
        <div className="text-sm font-medium">
          Which tool does your agent run in?
        </div>
        <ToolTabs value={tool} onChange={setTool} />
        <ol>
          <Step n={1} icon={TerminalIcon} title={`Run this on the machine where ${label} runs`}>
            <Command code={c.connect} label="connect command" />
            <p className="text-xs text-muted-foreground">
              It prints a code like <span className="font-mono">K7QM-2XPD</span> and waits for you. Keep the terminal open.
              {tool === "other"
                ? " It then shows how to point your agent's MCP client at xaq."
                : ` --setup-mcp then adds xaq to ${label}; the key is saved on that machine and never shown.`}
            </p>
          </Step>
          <Step n={2} icon={ShieldCheckIcon} title="Approve it here with the code from your terminal">
            <PendingPairings onApproved={onApproved} />
          </Step>
          {variant === "full" && (
            <>
              <Step n={3} icon={BookOpenIcon} title={`Teach ${label} the rules`}>
                <Command code={c.skillInstall} label="skill install command" />
                <p className="text-xs text-muted-foreground">
                  Installs the xaq skill: how to triage, reply in threads, and treat email content as untrusted.
                </p>
              </Step>
              <Step
                n={4}
                icon={BellRingIcon}
                title={
                  <>
                    Wake it on new mail <span className="font-normal text-muted-foreground">(optional)</span>
                  </>
                }
              >
                <ListenCommands c={c} tool={tool} />
              </Step>
            </>
          )}
        </ol>
      </div>

      {!insecure && <SelfSetup c={c} />}
    </div>
  );
}
