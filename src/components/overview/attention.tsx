import type { Account, PairingRequest } from "@shared/types";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, ArrowRightIcon, KeyRoundIcon, UnplugIcon } from "lucide-react";
import { AccountStatusBadge } from "@/components/accounts/account-status";
import { connectAccount } from "@/components/accounts/connect-host";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/** Accounts that need a human: reconnect after token loss, or errors. */
export function AccountsAttention({ accounts }: { accounts: Account[] }) {
  const broken = accounts.filter((a) => a.status === "needs_reauth" || a.status === "error");
  if (!broken.length) return null;
  return (
    <Card className="border-critical/30 bg-critical/[0.03]">
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangleIcon className="size-4 text-critical" />
          {broken.length === 1 ? "An account needs attention" : `${broken.length} accounts need attention`}
        </div>
        <ul className="divide-y">
          {broken.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
              <div className="min-w-56 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{a.email}</span>
                  <AccountStatusBadge status={a.status} />
                </div>
                {a.lastError && <p className="mt-0.5 text-xs break-words text-muted-foreground">{a.lastError}</p>}
              </div>
              {a.status === "needs_reauth" ? (
                <Button size="sm" onClick={() => connectAccount({ reauthAccountId: a.id, email: a.email })}>
                  <UnplugIcon /> Reconnect
                </Button>
              ) : (
                <Button size="sm" variant="outline" asChild>
                  <Link to="/accounts">View</Link>
                </Button>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Agents waiting for access via `npx xaq-cli connect`. */
export function PairingCallout({ pairings }: { pairings: PairingRequest[] }) {
  const waiting = pairings.filter((p) => p.status === "pending");
  if (!waiting.length) return null;
  const first = waiting[0]!;
  return (
    <Card className="border-warning/40 bg-warning/[0.06]">
      <CardContent className="flex flex-wrap items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-warning/20">
          <KeyRoundIcon className="size-4" />
        </span>
        <div className="min-w-48 flex-1">
          <div className="font-medium">
            {waiting.length === 1 ? "An agent is asking for access" : `${waiting.length} agents are asking for access`}
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {first.name}
            {first.ip && ` · from ${first.ip}`}
            {waiting.length > 1 && " and more"}
          </p>
        </div>
        <Button asChild>
          <Link to="/approvals">
            Review <ArrowRightIcon />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
