import type { Account } from "@shared/types";
import { AlertTriangleIcon, BotIcon, CalendarPlusIcon, MoreHorizontalIcon, PauseIcon, PlayIcon, RefreshCwIcon, Trash2Icon, UnplugIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TimeAgo } from "@/components/common";
import { SCOPES } from "@/lib/gcp-project";
import { queries } from "@/lib/queries";
import { confirm } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type AccountCalendarView, accountCalendarView } from "@/components/google/calendar-flow";
import { addCalendarTo, openCalendarSetup } from "@/components/google/calendar-setup";
import { AccountAvatar, AccountStatusBadge, CalendarBadge } from "./account-status";
import { connectAccount } from "./connect-host";
import { useAccountActions } from "./use-account-actions";

export function AccountRow({ account: a }: { account: Account }) {
  const { resync, pause, resume, remove } = useAccountActions();
  const reconnect = () => connectAccount({ reauthAccountId: a.id, email: a.email });
  const agents = useQuery(queries.agents());
  const users = (agents.data ?? []).filter((ag) => ag.grants.some((g) => g.accountId === a.id));
  const calendar = useCalendarView(a);
  const addCalendar = () => addCalendarTo(a);

  const askRemove = () =>
    confirm({
      title: `Remove ${a.email}?`,
      destructive: true,
      confirmLabel: "Remove account",
      description: (
        <>
          <p>xaq stops syncing this mailbox, revokes its Google token and deletes every agent grant for it. Agents lose access immediately.</p>
          <p>Mail in Gmail isn't touched. You can connect the account again later, but you'll need to recreate its grants.</p>
        </>
      ),
      onConfirm: () => remove.mutateAsync(a),
    });

  return (
    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <AccountAvatar email={a.email} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{a.email}</span>
            <AccountStatusBadge status={a.status} />
            {calendar && <CalendarBadge view={calendar} />}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            {a.displayName && <span className="truncate">{a.displayName}</span>}
            <span>
              Last sync <TimeAgo date={a.lastSyncAt} fallback="never" />
            </span>
            <span>
              Connected <TimeAgo date={a.createdAt} />
            </span>
          </div>
          {agents.isSuccess && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <BotIcon className="size-3.5 shrink-0" />
              {users.length ? (
                <span className="truncate">
                  {users.map((ag, i) => (
                    <span key={ag.id}>
                      {i > 0 && ", "}
                      <Link to="/agents/$agentId" params={{ agentId: ag.id }} className="text-foreground hover:underline">
                        {ag.name}
                      </Link>
                    </span>
                  ))}
                </span>
              ) : (
                <span>No agent has access yet</span>
              )}
            </div>
          )}
          {calendar?.tone === "bad" && (
            <p className="mt-2 flex max-w-3xl items-start gap-1.5 rounded-md bg-critical/[0.06] px-2.5 py-1.5 text-xs text-foreground/90">
              <AlertTriangleIcon className="mt-px size-3.5 shrink-0 text-critical" />
              <span className="break-words">{calendar.description}</span>
            </p>
          )}
          {a.lastError && (
            <p className="mt-2 flex max-w-3xl items-start gap-1.5 rounded-md bg-critical/[0.06] px-2.5 py-1.5 text-xs text-foreground/90">
              <AlertTriangleIcon className="mt-px size-3.5 shrink-0 text-critical" />
              <span className="break-words">{a.lastError}</span>
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
        {a.status === "needs_reauth" && (
          <Button size="sm" onClick={reconnect}>
            <UnplugIcon /> Reconnect
          </Button>
        )}
        {calendar?.fix === "consent" && calendar.tone === "warn" && a.status !== "needs_reauth" && (
          <Button size="sm" variant="outline" onClick={addCalendar}>
            <CalendarPlusIcon /> Add Calendar
          </Button>
        )}
        {calendar?.fix === "enable_api" && (
          <Button size="sm" variant="outline" onClick={() => openCalendarSetup("api")}>
            Turn on Calendar API
          </Button>
        )}
        {a.status === "paused" && (
          <Button size="sm" variant="outline" disabled={resume.isPending} onClick={() => resume.mutate(a)}>
            <PlayIcon /> Resume
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${a.email}`}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={reconnect}>
              <UnplugIcon /> Reconnect
            </DropdownMenuItem>
            {calendar?.fix === "consent" && (
              <DropdownMenuItem onSelect={addCalendar}>
                <CalendarPlusIcon /> Add Google Calendar
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={a.status === "paused"} onSelect={() => resync.mutate(a)}>
              <RefreshCwIcon /> Resync now
            </DropdownMenuItem>
            {a.status === "paused" ? (
              <DropdownMenuItem onSelect={() => resume.mutate(a)}>
                <PlayIcon /> Resume
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => pause.mutate(a)}>
                <PauseIcon /> Pause
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={askRemove}>
              <Trash2Icon /> Remove…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/**
 * The account's Calendar state: from the install's Calendar setup (which knows whether Calendar is
 * wanted), else from the account alone. null while neither is known.
 */
function useCalendarView(a: Account): AccountCalendarView | null {
  const setup = useQuery(queries.calendarSetup());
  const entry = setup.data?.accounts.find((c) => c.accountId === a.id);
  const enabled = setup.data?.enabled ?? false;
  if (entry) return accountCalendarView({ ...entry, error: a.calendar?.error }, enabled);
  if (!setup.isSuccess && !a.calendar) return null;
  const c = a.calendar ?? { status: "not_granted" as const, missingScopes: [...SCOPES.calendar], error: null };
  return accountCalendarView({ ...c, syncedCalendars: 0 }, enabled);
}
