import type { Approval, McpCallApproval, McpCallApprovalView } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { BotIcon, CheckCircle2Icon, CircleSlashIcon, ClockIcon, XCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Logo } from "@/components/auth-shell";
import { ExpiryCountdown } from "@/components/approvals/approval-parts";
import { doneState, isCallView, type McpDecision } from "@/components/approvals/mcp-call";
import { McpCallBody, McpDecisionButtons, useMcpDecision } from "@/components/approvals/mcp-call-card";
import { QueryError } from "@/components/common";
import { ThemeToggle } from "@/components/theme";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { ApiError, UNAUTHORIZED_EVENT } from "@/lib/api";
import { keys, queries } from "@/lib/queries";
import { cn } from "@/lib/utils";

// The one-tap approve page: the link in approval.requested opens it, e.g. texted by Hermes.
// Outside the app shell, mobile-first; it needs the admin session, and sign-in comes back here.
export const Route = createFileRoute("/approve/$id")({
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.fetchQuery({ ...queries.setupStatus(), staleTime: 60_000 });
    if (!status.claimed) throw redirect({ to: "/setup" });
    if (!status.authenticated) throw redirect({ to: "/login", search: { redirect: location.href } });
  },
  component: ApprovePage,
});

function ApprovePage() {
  const { id } = Route.useParams();
  const approval = useQuery(queries.approval(id));
  const navigate = useNavigate();
  const qc = useQueryClient();
  const href = useRouterState({ select: (s) => s.location.href });

  // Signed out meanwhile (session expired): sign in and come back here.
  useEffect(() => {
    const onUnauthorized = () => {
      qc.setQueryData(keys.setupStatus, { claimed: true, authenticated: false });
      void navigate({ to: "/login", search: { redirect: href } });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [navigate, qc, href]);

  return (
    <div className="min-h-svh bg-muted/40">
      <header className="mx-auto flex max-w-lg items-center justify-between px-4 pt-4">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
          <Logo className="size-7" /> xaq
        </Link>
        <ThemeToggle />
      </header>
      <main className="mx-auto max-w-lg space-y-4 p-4 pb-10">
        {approval.isPending ? (
          <Skeleton className="h-96 rounded-xl" />
        ) : approval.isError ? (
          approval.error instanceof ApiError && approval.error.status === 404 ? (
            <Done icon={CircleSlashIcon} title="This request doesn't exist" description="It may have been removed with its connection. Nothing will run." />
          ) : (
            <QueryError error={approval.error} onRetry={() => void approval.refetch()} />
          )
        ) : (
          <Decide data={approval.data} />
        )}
      </main>
    </div>
  );
}

function Decide({ data }: { data: McpCallApprovalView | Approval }) {
  if (!isCallView(data)) {
    // Mail and calendar approvals have their own cards in the console.
    return (
      <Done icon={ClockIcon} title="Open this in the console" description="This request is a message or calendar change. Review it on the Approvals page.">
        <Button size="lg" className="w-full" asChild>
          <Link to="/approvals">Open Approvals</Link>
        </Button>
      </Done>
    );
  }
  return <DecideCall key={data.approval.id} view={data} />;
}

function DecideCall({ view }: { view: McpCallApprovalView }) {
  const [decided, setDecided] = useState<{ res: McpCallApproval; d: McpDecision } | null>(null);
  const d = useMcpDecision(view, (res, decision) => {
    if (res.kind === "mcp.call") setDecided({ res, d: decision });
  });
  const a = decided?.res ?? view.approval;
  const now = useNow(1000);
  const expired = a.status === "pending" && Date.parse(a.expiresAt) <= now;
  const connection = view.connection?.name ?? "a removed connection";

  if (a.status !== "pending" || expired) {
    const s = doneState(expired ? { ...a, status: "expired" } : a, decided?.d ?? null);
    return (
      <Done
        icon={s.tone === "good" ? CheckCircle2Icon : s.tone === "bad" ? XCircleIcon : CircleSlashIcon}
        tone={s.tone}
        title={decided ? s.title : `Already decided: ${s.title.toLowerCase()}`}
        description={s.description}
      >
        <p className="text-center text-sm text-muted-foreground">
          <span className="font-mono">{a.call.tool}</span> on {connection}, asked by {a.agentName}.
        </p>
        <Button variant="outline" size="lg" className="w-full" asChild>
          <Link to="/approvals">Open the console</Link>
        </Button>
      </Done>
    );
  }

  // Approved, but it provably never ran (re-auth, rate limit): still pending, with the reason.
  const notRun = decided?.res.status === "pending" ? doneState(decided.res, decided.d) : null;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
          <BotIcon className="size-5 text-muted-foreground" /> {a.agentName} wants to use {connection}
        </h1>
        <p className="text-sm text-muted-foreground">
          This action can't be undone, so it waits for you. <ExpiryCountdown expiresAt={a.expiresAt} />.
        </p>
      </div>
      {notRun && (
        <Alert variant="destructive">
          <XCircleIcon />
          <AlertTitle>{notRun.title}</AlertTitle>
          <AlertDescription>{notRun.description}</AlertDescription>
        </Alert>
      )}
      <div className="rounded-xl border bg-card p-4">
        <McpCallBody view={view} uncapped />
      </div>
      <div className="sticky bottom-0 -mx-4 border-t bg-muted/90 px-4 py-4 backdrop-blur">
        <McpDecisionButtons view={view} d={d} large />
      </div>
    </div>
  );
}

function Done({
  icon: Icon,
  tone = "idle",
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone?: "good" | "bad" | "idle";
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-5 rounded-xl border bg-card px-5 py-10 text-center" role="status">
      <Icon className={cn("mx-auto size-14", tone === "good" ? "text-success" : tone === "bad" ? "text-critical" : "text-muted-foreground")} />
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-balance text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}
