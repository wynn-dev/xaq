import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ActivityIcon, BotIcon, MailIcon, ShieldAlertIcon, StampIcon, WrenchIcon } from "lucide-react";
import { PageHeader, QueryError, StatCard } from "@/components/common";
import { ConnectionsNotice } from "@/components/connections/connections-notice";
import { CalendarNotice } from "@/components/google/calendar-notice";
import { ActivityChart } from "@/components/overview/activity-chart";
import { AccountsAttention, PairingCallout } from "@/components/overview/attention";
import { RecentEvents } from "@/components/overview/recent-events";
import { SetupChecklist } from "@/components/overview/setup-checklist";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { accountsStat, fmtNumber, plural } from "@/lib/format";
import { queries } from "@/lib/queries";

export const Route = createFileRoute("/_app/")({
  component: Overview,
});

/** "3 active today · 1 listening": wraps between parts, never inside one ("1" / "listening"). */
function Parts({ items }: { items: (string | false | null | undefined | 0)[] }) {
  return items
    .filter((x): x is string => !!x)
    .map((x, i) => (
      <span key={x}>
        {i > 0 && " · "}
        <span className="whitespace-nowrap">{x}</span>
      </span>
    ));
}

function Overview() {
  const stats = useQuery(queries.overview());
  const accounts = useQuery(queries.accounts());
  const pairings = useQuery(queries.pairings("pending"));
  const agents = useQuery(queries.agents());
  const listening = agents.data?.filter((a) => a.listeners.some((l) => l.connected)).length ?? 0;
  const s = stats.data;
  const pairingCount = pairings.data?.length ?? 0;
  const waiting = pairingCount;
  const loading = stats.isPending;
  const acc = s && accountsStat(s.accounts);

  return (
    <>
      <PageHeader title="Overview" description="What your agents and mailboxes have been up to in the last 24 hours." />
      <SetupChecklist />
      <AccountsAttention accounts={accounts.data ?? []} />
      <ConnectionsNotice />
      <CalendarNotice />
      <PairingCallout pairings={pairings.data ?? []} />

      {stats.isError ? (
        <QueryError error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <StatCard
            label="Accounts"
            icon={MailIcon}
            loading={loading}
            value={acc?.value ?? null}
            hint={
              acc &&
              (acc.connect ? (
                <Link to="/accounts" className="font-medium whitespace-nowrap text-foreground underline underline-offset-4">
                  {acc.hint}
                </Link>
              ) : (
                <span className={acc.tone === "critical" ? "text-critical" : undefined}>{acc.hint}</span>
              ))
            }
          />
          <StatCard
            label="Agents"
            icon={BotIcon}
            loading={loading}
            value={fmtNumber(s?.agents.total)}
            hint={s && <Parts items={[`${s.agents.activeLast24h} active today`, listening && `${listening} listening`]} />}
          />
          <StatCard label="Mail events" icon={ActivityIcon} loading={loading} value={fmtNumber(s?.events24h)} hint="last 24h" />
          <StatCard
            label="Tool calls"
            icon={WrenchIcon}
            loading={loading}
            value={fmtNumber(s?.toolCalls24h)}
            hint={s && (s.denied24h ? <span className="text-warning">{s.denied24h} blocked by guardrails</span> : "none blocked")}
          />
          <StatCard
            label="Approvals"
            icon={waiting ? StampIcon : ShieldAlertIcon}
            tone={waiting ? "warn" : undefined}
            loading={loading}
            value={fmtNumber(waiting)}
            hint={waiting ? plural(pairingCount, "agent") : "nothing waiting"}
          />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
            <CardDescription>Mail events and agent tool calls per hour, last 24 hours.</CardDescription>
          </CardHeader>
          <CardContent>{s ? <ActivityChart activity={s.activity} /> : <Skeleton className="h-56" />}</CardContent>
        </Card>
        <RecentEvents />
      </div>
    </>
  );
}
