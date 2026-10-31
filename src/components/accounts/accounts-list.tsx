import { useQuery } from "@tanstack/react-query";
import { MailPlusIcon } from "lucide-react";
import { QueryError } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { queries } from "@/lib/queries";
import { AccountRow } from "./account-row";
import { connectAccount } from "./connect-host";

export function ConnectAccountButton({ label = "Connect Gmail account", variant = "default" }: { label?: string; variant?: "default" | "outline" }) {
  return (
    <Button variant={variant} onClick={() => connectAccount()}>
      <MailPlusIcon /> {label}
    </Button>
  );
}

export function AccountsList() {
  const accounts = useQuery(queries.accounts());

  if (accounts.isPending) {
    return (
      <Card className="gap-0 divide-y py-0">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-3 p-4">
            <Skeleton className="size-9 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-64" />
            </div>
          </div>
        ))}
      </Card>
    );
  }
  if (accounts.isError) return <QueryError error={accounts.error} onRetry={() => void accounts.refetch()} />;

  if (!accounts.data.length) {
    return (
      <Card>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MailPlusIcon />
            </EmptyMedia>
            <EmptyTitle>No Gmail accounts yet</EmptyTitle>
            <EmptyDescription>
              Connect a mailbox to start syncing mail. xaq holds the credentials; agents only get the access you grant them.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <ConnectAccountButton />
          </EmptyContent>
        </Empty>
      </Card>
    );
  }

  return (
    <Card className="gap-0 divide-y py-0">
      {accounts.data.map((a) => (
        <AccountRow key={a.id} account={a} />
      ))}
    </Card>
  );
}
