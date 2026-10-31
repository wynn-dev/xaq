import { CALENDAR_EVENT_TYPES, EVENT_TYPES, type EventType, isCalendarEventType, type MailEvent } from "@shared/types";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ActivityIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useState } from "react";
import { PageHeader, QueryError, StatusDot } from "@/components/common";
import { EventRow } from "@/components/events/event-row";
import { TestEmailButton } from "@/components/events/test-email-button";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { EVENT_TYPE_INFO } from "@/lib/labels";
import { queries } from "@/lib/queries";
import { useStreamListener, useStreamState } from "@/lib/stream";

const MAX_LIVE = 500;
const TYPE_GROUPS: { label: string; types: readonly EventType[] }[] = [
  { label: "Mail and account", types: EVENT_TYPES.filter((t) => !isCalendarEventType(t)) },
  { label: "Calendar", types: CALENDAR_EVENT_TYPES },
];

export const Route = createFileRoute("/_app/events")({
  validateSearch: (s: Record<string, unknown>): { accountId?: string; type?: EventType } => ({
    accountId: typeof s.accountId === "string" ? s.accountId : undefined,
    type: EVENT_TYPES.find((t) => t === s.type),
  }),
  component: EventsPage,
});

function EventsPage() {
  const { accountId, type } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const accounts = useQuery(queries.accounts());
  // Listener cursors ("Delivered to …" on rows) arrive on the live stream; the slow refetch is a fallback.
  useQuery({ ...queries.agents(), refetchInterval: 30_000 });
  const history = useInfiniteQuery(queries.eventHistory({ accountId, type }));
  const stream = useStreamState();
  const [live, setLive] = useState<MailEvent[]>([]);
  const [queued, setQueued] = useState<MailEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());

  useStreamListener((m) => {
    if (m.kind !== "event") return;
    if (paused) setQueued((q) => [m.data, ...q].slice(0, MAX_LIVE));
    else {
      setLive((l) => [m.data, ...l].slice(0, MAX_LIVE));
      setFreshIds((s) => new Set(s).add(m.data.id));
    }
  });

  const resume = () => {
    setLive((l) => [...queued, ...l].slice(0, MAX_LIVE));
    setFreshIds(new Set(queued.map((e) => e.id)));
    setQueued([]);
    setPaused(false);
  };

  const matches = (e: MailEvent) => (!accountId || e.accountId === accountId) && (!type || e.type === type);
  const seen = new Set<string>();
  const events = [...live.filter(matches), ...(history.data?.pages.flatMap((p) => p.items) ?? [])]
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => b.seq - a.seq);
  const queuedMatching = queued.filter(matches).length;
  const filtered = !!(accountId || type);

  return (
    <>
      <PageHeader
        title="Live events"
        description="Mail and calendar activity across your accounts as xaq sees it: what listeners and wait_for_events deliver to agents."
        actions={
          <>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StatusDot tone={paused ? "idle" : stream === "open" ? "good" : "warn"} pulse={!paused && stream === "open"} />
              {paused ? "Paused" : stream === "open" ? "Streaming" : "Reconnecting…"}
            </span>
            {paused ? (
              <Button variant="outline" onClick={resume}>
                <PlayIcon /> Resume{queuedMatching > 0 && ` (${queuedMatching} new)`}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setPaused(true)}>
                <PauseIcon /> Pause
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-wrap gap-2">
        <Select
          value={accountId ?? "all"}
          onValueChange={(v) => void navigate({ search: (s) => ({ ...s, accountId: v === "all" ? undefined : v }), replace: true })}
        >
          <SelectTrigger className="w-full sm:w-64" aria-label="Account">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All accounts</SelectItem>
            {accounts.data?.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={type ?? "all"}
          onValueChange={(v) => void navigate({ search: (s) => ({ ...s, type: v === "all" ? undefined : (v as EventType) }), replace: true })}
        >
          <SelectTrigger className="w-full sm:w-56" aria-label="Event type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All event types</SelectItem>
            {TYPE_GROUPS.map((g) => (
              <SelectGroup key={g.label}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.types.map((t) => (
                  <SelectItem key={t} value={t}>
                    {EVENT_TYPE_INFO[t]?.label ?? t}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        {filtered && (
          <Button variant="ghost" onClick={() => void navigate({ search: {}, replace: true })}>
            Clear filters
          </Button>
        )}
      </div>

      {history.isPending ? (
        <Card className="gap-0 divide-y py-0">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex gap-3 p-4">
              <Skeleton className="size-8" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            </div>
          ))}
        </Card>
      ) : history.isError ? (
        <QueryError error={history.error} onRetry={() => void history.refetch()} />
      ) : events.length === 0 ? (
        <Card>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ActivityIcon />
              </EmptyMedia>
              <EmptyTitle>{filtered ? "No events match these filters" : "No events yet"}</EmptyTitle>
              <EmptyDescription>
                {filtered
                  ? "Try another account or event type."
                  : "Events appear here live as mail arrives, is sent or relabeled, and as calendar events change."}
              </EmptyDescription>
            </EmptyHeader>
            {!filtered && (
              <EmptyContent>
                <TestEmailButton accounts={accounts.data ?? []} />
              </EmptyContent>
            )}
          </Empty>
        </Card>
      ) : (
        <Card className="gap-0 py-0">
          <ul className="divide-y" aria-live="polite" aria-relevant="additions">
            {events.map((e) => (
              <EventRow key={e.id} event={e} fresh={freshIds.has(e.id)} />
            ))}
          </ul>
        </Card>
      )}
      {history.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
            {history.isFetchingNextPage && <Spinner />} Load older events
          </Button>
        </div>
      )}
    </>
  );
}
