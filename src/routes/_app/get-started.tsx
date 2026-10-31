import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { PageHeader, QueryError } from "@/components/common";
import { useEffect } from "react";
import { StepChoose, StepFirstConnection } from "@/components/setup/broker-path";
import { BROKER_STEP_IDS, type BrokerStepId, shownWizard } from "@/components/setup/first-run";
import { queries } from "@/lib/queries";
import { STEP_IDS, type StepId, startsVerify, updateDraft, useSetupProgress, verifyDoneHeading, wizardStep } from "@/components/setup/progress";
import { StepAccounts } from "@/components/setup/step-accounts";
import { StepAgent } from "@/components/setup/step-agent";
import { StepClient } from "@/components/setup/step-client";
import { StepConsent } from "@/components/setup/step-consent";
import { StepProject } from "@/components/setup/step-project";
import { type StepProps, StepUrl } from "@/components/setup/step-url";
import { StepVerify } from "@/components/setup/step-verify";
import { WizardNav } from "@/components/setup/wizard-shell";
import { Skeleton } from "@/components/ui/skeleton";

interface Search {
  step?: StepId;
  /** The step the user jumped back from: Continue returns there instead of walking forward one by one. */
  from?: StepId;
  /** The short broker path's step (first run without Google). */
  path?: BrokerStepId;
}

export const Route = createFileRoute("/_app/get-started")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    step: STEP_IDS.find((id) => id === s.step),
    from: STEP_IDS.find((id) => id === s.from),
    path: BROKER_STEP_IDS.find((id) => id === s.path),
  }),
  component: GetStartedPage,
});

/** First run with Google optional: ask what to connect, then the Google wizard or the short path. */
function GetStartedPage() {
  const settings = useQuery(queries.settings());
  const progress = useSetupProgress();
  const { step } = Route.useSearch();
  if (settings.isPending || progress.query.isPending) return <WizardSkeleton />;
  const view = shownWizard(progress.view, step);
  if (view === "google") return <GetStarted />;
  return <ShortPath view={view} />;
}

function WizardSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-14 w-72" />
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <Skeleton className="hidden h-80 lg:block" />
        <Skeleton className="h-96" />
      </div>
    </div>
  );
}

function ShortPath({ view }: { view: "choose" | "broker" }) {
  const { path } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const progress = useSetupProgress();
  const choice = progress.draft.firstConnect;
  const go = (p: BrokerStepId) => {
    toast.dismiss();
    void navigate({ search: { path: p } });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const shown: BrokerStepId = path ?? progress.brokerTodo ?? "agent";
  const finish = () => {
    toast.success("Setup complete", { description: "Your agent can use its connections now. The overview shows what it's up to." });
    void navigate({ to: "/" });
  };
  return (
    <>
      <PageHeader title="Get started" description="A few minutes. Progress is saved." />
      <div className="mx-auto w-full max-w-3xl min-w-0">
        {view === "choose" || !choice || choice === "google" ? (
          <StepChoose onChosen={(c) => (c === "google" ? void navigate({ search: {} }) : go("connect"))} />
        ) : shown === "connect" ? (
          <StepFirstConnection choice={choice} onNext={() => go("agent")} />
        ) : (
          <StepAgent index={1} total={BROKER_STEP_IDS.length} onBack={() => go("connect")} onNext={finish} nextLabel="Finish setup" />
        )}
      </div>
    </>
  );
}

const STEPS: Record<StepId, (p: StepProps) => React.ReactNode> = {
  url: StepUrl,
  project: StepProject,
  consent: StepConsent,
  client: StepClient,
  accounts: StepAccounts,
  agent: StepAgent,
  verify: StepVerify,
};

/** Resumable setup wizard: opens at the first unfinished step (pinned in the URL); any step can be revisited. */
function GetStarted() {
  const { step, from } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const progress = useSetupProgress();
  const { shown, pin } = wizardStep(step, { loaded: progress.query.isSuccess, firstTodo: progress.firstTodo });
  // Opened without ?step= (e.g. from the sidebar): keep showing this step even once it's finished.
  useEffect(() => {
    if (pin) void navigate({ search: (s) => ({ ...s, step: pin }), replace: true });
  }, [pin, navigate]);
  const startVerify = progress.state !== undefined && startsVerify(shown, progress.statuses, progress.draft);
  useEffect(() => {
    if (startVerify) updateDraft({ verifyStarted: true });
  }, [startVerify]);

  if (progress.query.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-14 w-72" />
        <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
          <Skeleton className="hidden h-80 lg:block" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }
  if (progress.query.isError) return <QueryError error={progress.query.error} onRetry={() => void progress.query.refetch()} />;

  const current = shown;
  const index = STEP_IDS.indexOf(current);
  const go = (id: StepId, returnTo?: StepId) => {
    // Toasts belong to the step that raised them; don't let them cover the next one's buttons.
    toast.dismiss();
    void navigate({ search: { step: id, ...(returnTo ? { from: returnTo } : {}) } });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  // Jumping back to an earlier step remembers where you were, so Continue brings you back there.
  const select = (id: StepId) => {
    const back = STEP_IDS.indexOf(id) < index ? (from && STEP_IDS.indexOf(from) > index ? from : current) : undefined;
    go(id, back);
  };
  const returnTo = from && STEP_IDS.indexOf(from) > index ? from : undefined;
  const onNext = () => {
    const nextId = returnTo ?? STEP_IDS[index + 1];
    // Leaving the last step with a required one still to do: go there, not to a "Setup complete" toast.
    const todo = verifyDoneHeading({ ...progress.statuses, [current]: "done" }).nextStep;
    if (nextId) go(nextId);
    else if (todo) go(todo);
    else {
      toast.success("Setup complete", { description: "Your agents can use Gmail now. The overview shows what they're up to." });
      void navigate({ to: "/" });
    }
  };
  const onBack = index > 0 ? () => go(STEP_IDS[index - 1]!, returnTo) : undefined;
  const Step = STEPS[current];

  return (
    <>
      <PageHeader title="Get started" description="About 10 minutes, mostly in Google Cloud (opens in new tabs). Progress is saved." />
      <div className="grid items-start gap-6 lg:grid-cols-[14rem_1fr]">
        <div className="lg:sticky lg:top-20">
          <WizardNav current={current} statuses={progress.statuses} onSelect={select} />
        </div>
        <div className="min-w-0">
          <Step key={current} index={index} onBack={onBack} onNext={onNext} returnTo={returnTo} />
        </div>
      </div>
    </>
  );
}
