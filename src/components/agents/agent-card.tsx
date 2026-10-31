import type { Account, Agent } from "@shared/types";
import { Link } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon, KeyRoundIcon, MailIcon } from "lucide-react";
import { StatusDot, TimeAgo, ToneBadge } from "@/components/common";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { grantInWords } from "@/lib/grants";

export function AgentCard({ agent: a, accounts }: { agent: Agent; accounts: Account[] }) {
  const emailOf = (id: string) => accounts.find((x) => x.id === id)?.email ?? "Removed account";
  const live = a.listeners.filter((l) => l.connected);
  return (
    <Card className={cn("gap-0 py-0 transition-colors hover:bg-muted/30", a.disabled && "bg-muted/20")}>
      <Link
        to="/agents/$agentId"
        params={{ agentId: a.id }}
        className="flex h-full flex-col gap-3 rounded-xl p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <BotIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("truncate font-medium", a.disabled && "text-muted-foreground")} title={a.name}>
                {a.name}
              </span>
              {a.disabled && <ToneBadge tone="idle">Disabled</ToneBadge>}
            </div>
            <p className="line-clamp-2 text-xs text-muted-foreground" title={a.description ?? undefined}>
              {a.description || "No description"}
            </p>
          </div>
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
        </div>
        <div className="space-y-1.5 text-xs">
          {a.grants.length ? (
            a.grants.map((g) => (
              <div key={g.id} className="flex min-w-0 items-start gap-2 text-muted-foreground">
                <MailIcon className="mt-px size-3.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate text-foreground" title={emailOf(g.accountId)}>
                    {emailOf(g.accountId)}
                  </span>
                  {/* The grant summary wraps: it's what the card is for. */}
                  <span className="block break-words">
                    {grantInWords(g)}
                  </span>
                </span>
              </div>
            ))
          ) : (
            <div className="text-warning">No mailbox access yet</div>
          )}
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 font-mono">
            <KeyRoundIcon className="size-3.5" />
            {a.keyPrefix}…
          </span>
          <span>
            Last used <TimeAgo date={a.lastUsedAt} fallback="never" />
          </span>
          {live.length > 0 && (
            <span className="flex min-w-0 items-center gap-1.5 text-foreground">
              <StatusDot tone="good" />
              <span className="break-words">Listening on {live.map((l) => l.client.hostname ?? l.consumer).join(", ")}</span>
            </span>
          )}
        </div>
      </Link>
    </Card>
  );
}
