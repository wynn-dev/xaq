import type { PairingRequest } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2Icon, InfoIcon, KeyRoundIcon, XCircleIcon } from "lucide-react";
import { useState } from "react";
import { FindByCode, PairingApproveDialog, PairingCard, RecentPairings } from "@/components/approvals/pairing";
import { deniedDescription, linkedPairing } from "@/components/approvals/pairing-link";
import { Visible } from "@/components/hidden-chars";
import { PageHeader, QueryError } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { queries } from "@/lib/queries";

interface Search {
  /** User code from the terminal's verification link: highlights that request. */
  pairing?: string;
}

export const Route = createFileRoute("/_app/approvals")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    pairing: typeof s.pairing === "string" && s.pairing ? s.pairing.toUpperCase().slice(0, 12) : undefined,
  }),
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const pairings = useQuery(queries.pairings());
  const accounts = useQuery(queries.accounts());
  const pendingPairings = (pairings.data ?? []).filter((p) => p.status === "pending");
  const decidedPairings = (pairings.data ?? []).filter((p) => p.status !== "pending").slice(0, 8);
  const [approving, setApproving] = useState<{ p: PairingRequest } | null>(null);
  const link = search.pairing && pairings.data ? linkedPairing(search.pairing, pairings.data) : undefined;
  const linked = link?.kind === "pending" ? link.p : undefined;
  // Only the Find form on this page can mark a request as looked up by code: it lives in page state,
  // never in the URL, so a crafted link can't borrow the reassuring "matches the code" label.
  const [foundCode, setFoundCode] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Approvals"
        description={
          <>
            Agents that ran <code className="font-mono text-foreground">npx xaq-cli connect</code> and are waiting for you. Names, hosts and reasons
            come from the agent itself. Approve only requests you started, after checking the code in your terminal.
          </>
        }
      />
      <div className="space-y-4">
      {link?.kind === "denied" ? (
        <Alert>
          <XCircleIcon />
          <AlertTitle>
            You denied <Visible text={link.p.name} />
          </AlertTitle>
          <AlertDescription>
            {deniedDescription(link.p.decisionNote)} Changed your mind? Run connect again for a new request.
          </AlertDescription>
        </Alert>
      ) : link?.kind === "approved" ? (
        <Alert variant="success">
          <CheckCircle2Icon />
          <AlertTitle>
            You approved <Visible text={link.p.name} />
          </AlertTitle>
          <AlertDescription>
            <p>
              Its key is ready for the agent's terminal.{" "}
              {link.p.agentId && (
                <Link to="/agents/$agentId" params={{ agentId: link.p.agentId }} className="font-medium text-foreground underline underline-offset-4">
                  Open agent
                </Link>
              )}
            </p>
          </AlertDescription>
        </Alert>
      ) : link?.kind === "gone" ? (
        <Alert>
          <InfoIcon />
          <AlertTitle>That request isn't waiting anymore</AlertTitle>
          <AlertDescription>
            It expired (codes last 10 minutes) or doesn't exist. If your terminal is still waiting, check the code it shows; otherwise run
            connect again.
          </AlertDescription>
        </Alert>
      ) : null}
      {pairings.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : pairings.isError ? (
        <QueryError error={pairings.error} onRetry={() => void pairings.refetch()} />
      ) : (
        <>
          {pendingPairings.length > 0 && <FindByCode pending={pendingPairings} onFound={(p) => {
                setFoundCode(p.userCode);
                void navigate({ search: { pairing: p.userCode }, replace: true });
              }} />}
          {pendingPairings.length === 0 ? (
            <Card>
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <KeyRoundIcon />
                  </EmptyMedia>
                  <EmptyTitle>No agents waiting for access</EmptyTitle>
                  <EmptyDescription>
                    Run <code className="font-mono">npx xaq-cli connect</code> on the agent's machine. Its request shows up here
                    instantly.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" asChild>
                    <Link to="/agents" search={{ connect: true }}>
                      How to connect an agent
                    </Link>
                  </Button>
                </EmptyContent>
              </Empty>
            </Card>
          ) : (
            pendingPairings.map((p) => (
              <PairingCard
                key={p.id}
                p={p}
                accounts={accounts.data ?? []}
                highlighted={p.id === linked?.id ? (foundCode === p.userCode ? "found" : "link") : undefined}
                onApprove={() => setApproving({ p })}
              />
            ))
          )}
          <RecentPairings items={decidedPairings} />
        </>
      )}
      </div>

      <PairingApproveDialog
        p={approving?.p ?? null}
        accounts={accounts.data ?? []}
        onOpenChange={(o) => !o && setApproving(null)}
      />
    </>
  );
}
