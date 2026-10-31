import type { AgentTool } from "@shared/agent-api";
import type { Account, Agent, MailEvent, Page, TestEmailResult } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2Icon, CircleIcon, InfoIcon, MailIcon, PartyPopperIcon, RotateCcwIcon, SendIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useAgentOrigin, useMcpActivity } from "@/components/agents/agent-status";
import { Command } from "@/components/agents/command";
import { ProfileHint, toolName, usePublicUrl } from "@/components/agents/connect-agent-guide";
import { grantInWords } from "@/components/agents/grant-words";
import { CopyButton, ErrorAlert, TimeAgo } from "@/components/common";
import { Visible } from "@/components/hidden-chars";
import { useNow } from "@/hooks/use-now";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, apiGet } from "@/lib/api";
import { connectCommands, LISTEN_TEST_EXEC, shellQuote } from "@/lib/cli";
import { keys, queries } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { lastCallShown } from "@/components/agents/last-call";
import { readDraft, skippedPatch, STEP_IDS, STEP_META, updateDraft, useSetupProgress, verifiedPatch, verifyDoneHeading } from "./progress";
import {
  activeTest,
  checksComplete,
  type DoneLine,
  doneSummary,
  READ_TOOLS,
  TEST_SUBJECT,
  type VerifyTest,
  verifyChecks,
  verifyFooter,
  verifyMode,
} from "./verify-checks";
import type { StepProps } from "./step-url";
import { StepCard, StepFooter } from "./wizard-shell";
import { explainReason } from "@/lib/labels";

// ───────────── State shared with step 6 (per browser and instance) ─────────────

interface VerifyState {
  /** The agent being checked (set when step 6 approves or creates one). */
  agentId?: string;
  /** "I'll use MCP only": no listener expected. */
  skipListen?: boolean;
  test?: VerifyTest;
}

const KEY = `xaq.verify:${typeof window === "undefined" ? "" : window.location.host}`;
const subs = new Set<() => void>();
let cache: VerifyState | null = null;

function readState(): VerifyState {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}") as VerifyState;
  } catch {
    cache = {};
  }
  return cache;
}

function writeState(patch: Partial<VerifyState>) {
  cache = { ...readState(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* private mode: keep in memory */
  }
  for (const s of subs) s();
}

/** Step 6 calls this when an agent is approved (or created with a key), so this step checks that one. */
export function setVerifyAgent(agentId: string) {
  writeState({ agentId, skipListen: undefined, test: undefined });
}

function useVerifyState() {
  return useSyncExternalStore((l) => (subs.add(l), () => subs.delete(l)), readState);
}

/** True once `on` has been true (a tick never goes back while the step is open). */
function useLatch(on: boolean) {
  const [latched, setLatched] = useState(on);
  if (on && !latched) setLatched(true);
  return latched || on;
}

// ───────────── Step ─────────────


export function StepVerify({ index, onBack, onNext }: StepProps) {
  // Listener connect/ack and MCP use arrive on the console stream (`agent` messages); the slow refetch is a fallback.
  const agents = useQuery({ ...queries.agents(), refetchInterval: 30_000 });
  const state = useVerifyState();
  const list = agents.data ?? [];
  const agent = list.find((a) => a.id === state.agentId) ?? [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const progress = useSetupProgress();
  const stepDone = progress.statuses.verify === "done";
  // Done when opened: show it done (the test email this browser remembers may be gone), not checks at "waiting".
  const [doneWhenOpened] = useState(stepDone);
  const [recheck, setRecheck] = useState(false);
  const mode = verifyMode(doneWhenOpened, recheck);

  const heading = verifyDoneHeading(progress.statuses);
  const finish = () => {
    if (!readDraft().verified) updateDraft({ verified: true });
    onNext();
  };
  const skip = () => {
    updateDraft(skippedPatch(readDraft()));
    onNext();
  };
  // A fresh check: forget the last test email. The step stays done (nothing here un-verifies it).
  const runAgain = () => {
    writeState({ test: undefined });
    setRecheck(true);
  };

  return (
    <StepCard
      index={index}
      title="Check that it works"
      description={
        mode === "complete"
          ? heading.nextStep
            ? "This check is done. Here's what was checked."
            : "Setup is complete. Here's what was checked and what to do next."
          : "Each line turns green on its own as your agent connects. Then send a test email and watch it arrive."
      }
      footer={<VerifyFooter agent={agent} stepDone={stepDone} onBack={onBack} onFinish={finish} onSkip={skip} />}
    >
      {agents.isPending ? (
        <Skeleton className="h-72 rounded-xl" />
      ) : agents.isError ? (
        <ErrorAlert error={agents.error} title="Couldn't load your agents" />
      ) : mode === "complete" && agent ? (
        <CompletedView
          key={agent.id}
          agent={agent}
          state={state}
          serverVerified={!!progress.state?.verified}
          verifiedBy={progress.draft.verifiedBy}
          onRunAgain={runAgain}
        />
      ) : !agent ? (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          No agent yet. Go back one step, run <code className="font-mono text-foreground">connect</code> and approve the request.
        </div>
      ) : (
        <>
          {list.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label htmlFor="verify-agent" className="text-muted-foreground">
                Checking
              </label>
              <Select value={agent.id} onValueChange={(id) => setVerifyAgent(id)}>
                <SelectTrigger id="verify-agent" className="w-auto min-w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {list.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {recheck && (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <InfoIcon className="mt-0.5 size-4 shrink-0" />
              This step stays done whatever these checks show.
            </p>
          )}
          <Checklist key={agent.id} agent={agent} state={state} severalAgents={list.length > 1} />
        </>
      )}
    </StepCard>
  );
}

// The footer needs the same "complete" answer as the checklist; the checklist reports it here.
const completeSubs = new Set<() => void>();
let completeFor: string | null = null;
function setComplete(agentId: string | null) {
  if (completeFor === agentId) return;
  completeFor = agentId;
  for (const s of completeSubs) s();
}
const useComplete = () => useSyncExternalStore((l) => (completeSubs.add(l), () => completeSubs.delete(l)), () => completeFor);

function VerifyFooter({
  agent,
  stepDone,
  onBack,
  onFinish,
  onSkip,
}: {
  agent: Agent | undefined;
  stepDone: boolean;
  onBack?: () => void;
  onFinish: () => void;
  onSkip: () => void;
}) {
  const complete = useComplete() === agent?.id && !!agent;
  const f = verifyFooter(stepDone, complete);
  return (
    <StepFooter
      onBack={onBack}
      onNext={onFinish}
      nextLabel="Finish setup"
      nextDisabled={f.nextDisabled}
      hint={f.hint ?? undefined}
      extra={
        f.skip && (
          <Button variant="ghost" onClick={onSkip}>
            Finish without checking
          </Button>
        )
      }
    />
  );
}

type ItemState = "done" | "current" | "todo" | "skipped";

function Item({
  state,
  title,
  detail,
  children,
  optional,
}: {
  state: ItemState;
  title: React.ReactNode;
  detail?: React.ReactNode;
  children?: React.ReactNode;
  optional?: boolean;
}) {
  return (
    <li className="relative grid grid-cols-[1.5rem_1fr] gap-x-3 pb-5 last:pb-0">
      <span className="absolute top-7 bottom-0 left-3 w-px bg-border [li:last-child>&]:hidden" aria-hidden />
      <span className="relative flex size-6 items-center justify-center bg-card">
        {state === "done" ? (
          <CheckCircle2Icon className="size-5 text-success" />
        ) : state === "current" ? (
          <Spinner className="size-5 text-chart-1" aria-hidden />
        ) : (
          <CircleIcon className={cn("size-5", state === "skipped" ? "text-muted-foreground/40" : "text-muted-foreground")} />
        )}
      </span>
      <div className="min-w-0 space-y-2 pt-0.5">
        <div className="text-sm">
          <span className={cn("font-medium", (state === "todo" || state === "skipped") && "text-muted-foreground")}>{title}</span>
          <span className="sr-only"> ({state === "current" ? "waiting" : state === "todo" ? "not yet" : state})</span>
          {optional && state !== "done" && <span className="text-muted-foreground"> (optional)</span>}
        </div>
        {detail && <div className="text-sm text-muted-foreground">{detail}</div>}
        {children && <div className="space-y-2">{children}</div>}
      </div>
    </li>
  );
}

function Prompt({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-center gap-1 rounded-md border bg-background py-1 pr-1 pl-3">
      <p className="min-w-0 flex-1 text-sm break-words text-foreground">“{text}”</p>
      <CopyButton value={text} label={`Copy ${label}`} />
    </div>
  );
}

function Checklist({ agent, state, severalAgents }: { agent: Agent; state: VerifyState; severalAgents: boolean }) {
  const origin = useAgentOrigin(agent);
  const { publicUrl } = usePublicUrl();
  const tool: AgentTool = origin.tool ?? "other";
  const label = origin.tool ? toolName(origin.tool) : agent.name;
  const Label = label[0]!.toUpperCase() + label.slice(1);
  const c = connectCommands(publicUrl, tool);
  const mcp = useMcpActivity(agent, { since: agent.createdAt });
  const lastCall = lastCallShown(mcp.calls, explainReason);
  const now = useNow(60_000);
  const test = activeTest(state.test, now);

  // Paired agents keep their key in a profile on their machine; only those can run `listen`.
  const canListen = origin.paired;
  const skipListen = !!state.skipListen || (origin.known && !canListen);

  const events = useQuery({
    queryKey: [...keys.events, "verify", test?.accountId ?? ""],
    queryFn: () => apiGet<Page<MailEvent>>("/api/events", { accountId: test!.accountId }),
    enabled: !!test,
    // New events arrive on the console stream (which invalidates this); the slow refetch is a fallback.
    refetchInterval: 30_000,
  });
  const listener = agent.listeners.find((l) => l.connected) ?? agent.listeners[0];

  const mcpDone = useLatch(!!mcp.seenAt);
  const listenDone = useLatch(agent.listeners.some((l) => l.connected));
  const { sent, received, delivered, resendForListener, readIt, typesExcludeIt } = verifyChecks({
    test,
    events: events.data?.items ?? [],
    listeners: agent.listeners,
    calls: mcp.calls,
    skipListen,
  });
  const receivedDone = !!received;
  const complete = checksComplete({ mcpDone, listenDone, skipListen, sent, received: receivedDone, delivered });

  useEffect(() => {
    setComplete(complete ? agent.id : null);
    return () => setComplete(null);
  }, [complete, agent.id]);
  // Every check green means step 7 is done now (verifiedBy "checks"); "Finish setup" just leaves the page.
  useEffect(() => {
    const patch = verifiedPatch(complete, readDraft());
    if (patch) updateDraft(patch);
  }, [complete]);

  // Announce each tick once, politely; move focus to the success heading when everything is green.
  const [announcement, setAnnouncement] = useState("");
  const prev = useRef({ mcpDone, listenDone, receivedDone, delivered, readIt });
  useEffect(() => {
    const p = prev.current;
    const msg = [
      !p.mcpDone && mcpDone && `${Label} called xaq.`,
      !p.listenDone && listenDone && "The listener is connected.",
      !p.receivedDone && receivedDone && "The test email arrived.",
      !p.delivered && delivered && "The listener handled the test email.",
      !p.readIt && readIt && `${Label} read your mail.`,
    ]
      .filter(Boolean)
      .join(" ");
    prev.current = { mcpDone, listenDone, receivedDone, delivered, readIt };
    if (msg) setAnnouncement(msg);
  }, [mcpDone, listenDone, receivedDone, delivered, readIt, Label]);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const wasComplete = useRef(complete);
  useEffect(() => {
    if (complete && !wasComplete.current) doneRef.current?.focus();
    wasComplete.current = complete;
  }, [complete]);

  // The first unfinished item is the one we're waiting on.
  const order: [string, boolean][] = [
    ["mcp", mcpDone],
    ["listen", listenDone || skipListen],
    ["send", sent],
    ["received", receivedDone],
    ["delivered", delivered || skipListen],
  ];
  const current = order.find(([, d]) => !d)?.[0];
  const st = (id: string, done: boolean, skipped = false): ItemState => (done ? "done" : skipped ? "skipped" : id === current ? "current" : "todo");

  return (
    <div className="space-y-6">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {complete && <SuccessPanel agent={agent} label={label} tool={tool} listening={!skipListen} readIt={readIt} headingRef={doneRef} serviceCmd={c.listenService} />}

      <ol aria-label="Setup checks">
        <Item
          state="done"
          title={
            <>
              <Visible text={agent.name} /> is approved
            </>
          }
          detail={
            <>
              {agent.grants.length ? agent.grants.map((g) => grantInWords(g)).join(" · ") : "It has no mailbox access yet: add some on its page."}
              {severalAgents && origin.paired && (
                <span className="mt-1 block">
                  <ProfileHint /> The commands below act on the default profile.
                </span>
              )}
            </>
          }
        />

        <Item
          state={st("mcp", mcpDone)}
          title={mcpDone ? `${Label} is connected to xaq` : `Waiting for ${label} to call xaq`}
          detail={
            mcpDone ? (
              lastCall ? (
                <>
                  Last tool call <TimeAgo date={lastCall.call.ts} /> ({lastCall.call.action}
                  {lastCall.note && <span className="text-warning">, {lastCall.note}</span>}).
                </>
              ) : (
                <>
                  Connected <TimeAgo date={mcp.connectedAt} />.
                </>
              )
            ) : undefined
          }
        >
          {!mcpDone && <McpHelp tool={tool} label={label} paired={origin.paired} c={c} agentId={agent.id} publicUrl={publicUrl} />}
        </Item>

        <Item
          state={st("listen", listenDone, skipListen)}
          title={
            listenDone
              ? (
                  <>
                    Listener connected
                    {listener?.client.hostname && (
                      <>
                        {" "}
                        on <Visible text={listener.client.hostname} />
                      </>
                    )}
                  </>
                )
              : skipListen
                ? "No listener: MCP only"
                : "Start the listener so new mail wakes your agent"
          }
          detail={
            skipListen && !listenDone ? (
              canListen ? (
                <>
                  Your agent checks mail when you ask it.{" "}
                  <button type="button" className="font-medium text-foreground underline underline-offset-4" onClick={() => writeState({ skipListen: false })}>
                    Use a listener after all
                  </button>
                </>
              ) : (
                "Agents created with a copied key can't run a listener."
              )
            ) : listenDone ? (
              "It keeps a connection open and runs your command for each new email you receive."
            ) : undefined
          }
        >
          {!listenDone && !skipListen && (
            <>
              {c.hermesRoute && (
                <>
                  <p className="text-sm text-muted-foreground">On the machine where you ran connect, create the Hermes route once (use the platform Hermes should tell you on):</p>
                  <Command code={c.hermesRoute} label="hermes route command" />
                </>
              )}
              <p className="text-sm text-muted-foreground">On the machine where you ran connect (Ctrl-C stops it):</p>
              <Command code={c.listenTry} label="listen command" />
              <p className="text-xs text-muted-foreground">
                {tool === "other"
                  ? "This test command only confirms each email (a ✓ line per email); it starts nothing."
                  : (
                    <>
                      {tool === "hermes"
                        ? `Forwards each new email you receive (not mail you send) to ${label}, which triages it.`
                        : `Starts ${label} for each new email you receive (not mail you send), with only the xaq tools.`}{" "}
                      Add{" "}
                      <code className="font-mono whitespace-nowrap text-foreground">--types</code> to wake it for other events too. Just testing delivery?{" "}
                      <code className="font-mono whitespace-nowrap text-foreground">--exec {shellQuote(LISTEN_TEST_EXEC)}</code> only confirms each email.
                    </>
                  )}
              </p>
              <Button variant="outline" size="sm" onClick={() => writeState({ skipListen: true })}>
                I'll use MCP only
              </Button>
            </>
          )}
        </Item>

        <Item
          state={st("send", sent)}
          title={sent ? "Test email sent" : "Send a test email"}
          detail={
            test ? (
              <>
                From <AccountEmail id={test.accountId} /> to itself, <TimeAgo date={test.sentAt} />.
              </>
            ) : (
              <>
                xaq sends <span className="text-foreground">“{TEST_SUBJECT}”</span> from your Gmail account to itself. Nobody else gets it.
              </>
            )
          }
        >
          <SendTest agent={agent} sent={sent} blocked={!listenDone && !skipListen} />
        </Item>

        <Item
          state={st("received", receivedDone)}
          title={receivedDone ? "xaq saw it arrive" : current === "received" ? "Waiting for the test email to arrive" : "xaq sees it arrive"}
          detail={
            receivedDone ? (
              <>
                New mail event <TimeAgo date={received.createdAt} />.{" "}
                <Link to="/events" className="font-medium text-foreground underline underline-offset-4">
                  See it in Live events
                </Link>
              </>
            ) : sent ? (
              "Usually within the poll interval."
            ) : undefined
          }
        />

        <Item
          state={st("delivered", delivered, skipListen)}
          title={
            delivered
              ? "Your listener handled it"
              : skipListen
                ? "Delivery to a listener: skipped"
                : current === "delivered"
                  ? "Waiting for your listener to handle it"
                  : "Your listener handles it"
          }
          detail={
            delivered
              ? "Its terminal shows one ✓ line for the email."
              : !skipListen && receivedDone
                ? typesExcludeIt
                  ? (
                    <>
                      Your listener only runs its command for {typesExcludeIt.join(", ")}, so it skipped this email. Stop it and start it again
                      with the default types (no <code className="font-mono text-foreground">--types</code>) or with{" "}
                      <code className="font-mono text-foreground">--types message.received</code>, then send another test email.
                    </>
                  )
                  : resendForListener
                  ? "The listener wasn't running when this email was sent, so it starts after it. Send another test email now that the listener is running."
                  : "Look for one ✓ line in the listener's terminal. If it shows an error, the command failed and is retried."
                : undefined
          }
        />

        <Item state={readIt ? "done" : "todo"} optional title={readIt ? `${Label} read your mail` : `Ask ${label} to read it`}>
          {!readIt && receivedDone && <Prompt text="Use xaq to summarize my latest email." label="prompt" />}
        </Item>
      </ol>
    </div>
  );
}

function AccountEmail({ id }: { id: string }) {
  const accounts = useQuery(queries.accounts());
  return <span className="text-foreground">{accounts.data?.find((a) => a.id === id)?.email ?? "your account"}</span>;
}

function McpHelp({
  tool,
  label,
  paired,
  c,
  agentId,
  publicUrl,
}: {
  tool: AgentTool;
  label: string;
  paired: boolean;
  c: ReturnType<typeof connectCommands>;
  agentId: string;
  publicUrl: string;
}) {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      {paired && tool !== "other" ? (
        <>
          <p>
            If you ran connect with <span className="font-mono">--setup-mcp</span>, restart {label}. If not, run this on the same machine, then restart{" "}
            {label}:
          </p>
          <Command code={c.setupMcp} label="setup-mcp command" />
          {c.mcpCheck && (
            <p>
              To check: <code className="font-mono text-foreground">{c.mcpCheck}</code> should list xaq.
            </p>
          )}
        </>
      ) : paired ? (
        <p>
          Point your agent's MCP client at <code className="font-mono break-all text-foreground">{publicUrl}/mcp</code> with the header{" "}
          <code className="font-mono text-foreground">Authorization: Bearer &lt;key&gt;</code>. The key is the "apiKey" field in{" "}
          <code className="font-mono break-all text-foreground">~/.config/xaq/profiles/default.json</code> on the machine where you ran connect.
        </p>
      ) : (
        <p>
          Add xaq to your agent with the snippet from the previous step, or from{" "}
          <Link to="/agents/$agentId" params={{ agentId }} className="font-medium text-foreground underline underline-offset-4">
            the agent's page
          </Link>
          .
        </p>
      )}
      <p>Then ask {label}:</p>
      <Prompt text="Use xaq to list my email accounts." label="prompt" />
      <p>Also teach it the rules once, with the xaq skill:</p>
      <Command code={c.skillInstall} label="skill install command" />
    </div>
  );
}

function SendTest({ agent, sent, blocked }: { agent: Agent; sent: boolean; /** The listener step isn't done or skipped yet. */ blocked: boolean }) {
  const accounts = useQuery(queries.accounts());
  // Paused, needs_reauth and error accounts don't pick up new mail: the test would never arrive.
  const all = (accounts.data ?? []).filter((a) => a.status === "active");
  // Prefer mailboxes this agent can read: only those events reach it.
  const readable = all.filter((a) => agent.grants.some((g) => g.accountId === a.id && g.capabilities.includes("read")));
  const choices = readable.length ? readable : all;
  const [picked, setPicked] = useState<string>();
  const accountId = picked && choices.some((a) => a.id === picked) ? picked : choices[0]?.id;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const selectId = useId();
  const verifyTodo = useSetupProgress().statuses.verify === "todo";

  const send = async () => {
    if (!accountId) return;
    setPending(true);
    setError(null);
    try {
      const res = await api<TestEmailResult>(`/api/accounts/${encodeURIComponent(accountId)}/test-email`, { method: "POST" });
      // Only listeners known now can be credited with delivering it (see VerifyTest.listenersAtSend). A briefly
      // disconnected one keeps its cursor and handles the mail when it reconnects, so it counts too.
      writeState({ test: { ...res, accountId, listenersAtSend: agent.listeners.map((l) => l.consumer) } });
      // Only while the step is unfinished: on an install already verified, a test changes nothing.
      if (verifyTodo && !readDraft().verifyStarted) updateDraft({ verifyStarted: true });
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };

  if (accounts.isPending) return <Skeleton className="h-9 w-48" />;
  if (!all.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No active Gmail account.{" "}
        <Link to="/accounts" className="font-medium text-foreground underline underline-offset-4">
          Connect or resume one
        </Link>{" "}
        first.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {choices.length > 1 && (
          <>
            <label htmlFor={selectId} className="sr-only">
              Account to send from
            </label>
            <Select value={accountId} onValueChange={setPicked}>
              <SelectTrigger id={selectId} className="w-auto min-w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((a: Account) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        <Button variant={sent ? "outline" : "default"} onClick={() => void send()} disabled={pending || !accountId || blocked}>
          {pending ? <Spinner /> : sent ? <MailIcon /> : <SendIcon />}
          {sent ? "Send another" : "Send a test email"}
        </Button>
      </div>
      {blocked && <p className="text-xs text-muted-foreground">Start the listener first, or choose MCP only above.</p>}
      {!readable.length && (
        <p className="text-xs text-warning">This agent can't read any connected account yet, so the email won't reach it. Add access on its page.</p>
      )}
      {error != null && <ErrorAlert error={error} title="Couldn't send the test email" />}
    </div>
  );
}

/** Step 7 revisited once done: what was verified, the same next steps, and a way to check again. */
function CompletedView({
  agent,
  state,
  serverVerified,
  verifiedBy,
  onRunAgain,
}: {
  agent: Agent;
  state: VerifyState;
  serverVerified: boolean;
  verifiedBy: "checks" | "skip" | undefined;
  onRunAgain: () => void;
}) {
  const origin = useAgentOrigin(agent);
  const { publicUrl } = usePublicUrl();
  const tool: AgentTool = origin.tool ?? "other";
  const label = origin.tool ? toolName(origin.tool) : agent.name;
  const Label = label[0]!.toUpperCase() + label.slice(1);
  const c = connectCommands(publicUrl, tool);
  const mcp = useMcpActivity(agent);
  const skipListen = !!state.skipListen || (origin.known && !origin.paired);
  const lines = doneSummary({
    serverVerified,
    test: state.test,
    calls: mcp.calls,
    connectedAt: agent.lastMcpAt,
    listeners: agent.listeners,
    skipListen,
    verifiedBy,
  });
  const readIt = mcp.calls.some((e) => e.outcome === "ok" && READ_TOOLS.has(e.action));
  const headingRef = useRef<HTMLHeadingElement>(null);
  return (
    <div className="space-y-4">
      <SuccessPanel
        agent={agent}
        label={label}
        tool={tool}
        listening={!skipListen && agent.listeners.length > 0}
        readIt={readIt}
        headingRef={headingRef}
        serviceCmd={c.listenService}
        summary={
          <ul aria-label="What was checked" className="space-y-1.5 text-sm">
            <DoneItem ok>
              <Visible text={agent.name} /> is approved{" "}
              <span className="text-muted-foreground">
                ({agent.grants.length ? agent.grants.map((g) => grantInWords(g)).join(" · ") : "no mailbox access yet"})
              </span>
            </DoneItem>
            {lines.map((l) => (
              <DoneSummaryLine key={l.id} line={l} Label={Label} />
            ))}
          </ul>
        }
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button variant="outline" size="sm" onClick={onRunAgain}>
          <RotateCcwIcon />
          Run the checks again
        </Button>
        <span className="text-xs text-muted-foreground">Optional: sends a new test email. This step stays done.</span>
      </div>
    </div>
  );
}

function DoneItem({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      {ok ? <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" /> : <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function DoneSummaryLine({ line: l, Label }: { line: DoneLine; Label: string }) {
  switch (l.id) {
    case "mcp":
      return (
        <DoneItem ok>
          {Label} reached xaq{" "}
          <span className="text-muted-foreground">
            ({l.action ? <>last tool call {l.action}, </> : <>connected </>}
            <TimeAgo date={l.at} />)
          </span>
        </DoneItem>
      );
    case "listener":
      return (
        <DoneItem ok={l.connected}>
          {l.connected ? "Listener connected" : "Listener not connected now"}
          {l.hostname && (
            <>
              {" "}
              on <Visible text={l.hostname} />
            </>
          )}
          {!l.connected && l.at && (
            <span className="text-muted-foreground">
              {" "}
              (last seen <TimeAgo date={l.at} />)
            </span>
          )}
        </DoneItem>
      );
    case "checked":
      return <DoneItem ok>Every check passed in this browser</DoneItem>;
    case "skipped":
      return (
        <DoneItem ok={false}>
          <span className="text-muted-foreground">You finished without running every check. Run them again below to make sure.</span>
        </DoneItem>
      );
    case "mcpOnly":
      return <DoneItem ok>No listener: MCP only</DoneItem>;
    case "test":
      return (
        <DoneItem ok>
          Test email sent <TimeAgo date={l.at} />
        </DoneItem>
      );
    case "unchecked":
      return (
        <DoneItem ok={false}>
          <span className="text-muted-foreground">Finished without every check: xaq hasn't seen a successful tool call yet.</span>
        </DoneItem>
      );
  }
}

/** Keep the daemon itself running: it's in a terminal now. serviceCommand carries this instance's flags. */
function DaemonServiceItem({ command }: { command: string }) {
  return (
    <li className="space-y-1.5">
      <p>
        <span className="font-medium">Keep xaq itself running.</span>{" "}
        <span className="text-muted-foreground">It runs in a terminal now: closing that stops everything. On the computer running xaq, run:</span>
      </p>
      <Command code={command} label="xaq service command" />
      <p className="text-xs text-muted-foreground">
        Stop the one in your terminal first (Ctrl-C): the service can't start while it runs. This page reconnects once the service is up.
      </p>
    </li>
  );
}

function SuccessPanel({
  agent,
  label,
  tool,
  listening,
  readIt,
  headingRef,
  serviceCmd,
  summary,
}: {
  agent: Agent;
  label: string;
  tool: AgentTool;
  listening: boolean;
  readIt: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  serviceCmd: string;
  /** What was verified (the completed step, revisited). */
  summary?: React.ReactNode;
}) {
  const system = useQuery(queries.system());
  const heading = verifyDoneHeading(useSetupProgress().statuses);
  const Icon = heading.nextStep ? CheckCircle2Icon : PartyPopperIcon;
  return (
    <section aria-labelledby="verify-done" className="space-y-4 rounded-xl border border-success/40 bg-success/5 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0 text-success" />
        <div className="space-y-1">
          <h3 id="verify-done" ref={headingRef} tabIndex={-1} className="font-semibold outline-none">
            {heading.title}
          </h3>
          {heading.nextStep && (
            <p className="text-sm">
              Setup isn't finished yet:{" "}
              <Link to="/get-started" search={{ step: heading.nextStep }} className="font-medium underline underline-offset-4">
                step {STEP_IDS.indexOf(heading.nextStep) + 1}, {STEP_META[heading.nextStep].short}
              </Link>{" "}
              is still to do.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            New mail reaches <Visible text={agent.name} />
            {listening ? " when it arrives" : " whenever you ask it"}
            .
          </p>
        </div>
      </div>
      {summary}
      <ul className="space-y-3 text-sm">
        {listening && (
          <li className="space-y-1.5">
            <p>
              <span className="font-medium">Keep the listener running</span>{" "}
              <span className="text-muted-foreground">after you close its terminal (starts at login):</span>
            </p>
            <Command code={serviceCmd} label="listener service command" />
            <p className="text-xs text-muted-foreground">
              {tool === "other" ? "Replace /path/to/handle-email.sh with your script. " : ""}Stop the one in your terminal first (Ctrl-C).
            </p>
          </li>
        )}
        {system.data?.service === false && <DaemonServiceItem command={system.data.serviceCommand} />}
        {!readIt && (
          <li className="text-muted-foreground">
            Try it: ask {label} to <span className="text-foreground">“use xaq to summarize my latest email.”</span>
          </li>
        )}
        <li className="text-muted-foreground">
          Change what it may do on{" "}
          <Link to="/agents/$agentId" params={{ agentId: agent.id }} className="font-medium text-foreground underline underline-offset-4">
            its page
          </Link>
          ; sends that need your OK and new agents asking for access wait in{" "}
          <Link to="/approvals" className="font-medium text-foreground underline underline-offset-4">
            Approvals
          </Link>
          .
        </li>
      </ul>
    </section>
  );
}
