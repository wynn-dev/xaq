import type { CalendarInfo } from "@shared/types";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ApiError } from "@/lib/api";
import { queries } from "@/lib/queries";

/** Why an account's calendar list can't be shown, in words with the fix (GET /accounts/:id/calendars 409s), or null. */
export function calendarListProblem(err: unknown): React.ReactNode {
  if (!(err instanceof ApiError)) return null;
  const accounts = (
    <Link to="/accounts" className="font-medium text-foreground underline underline-offset-4">
      Accounts
    </Link>
  );
  if (err.code === "calendar_not_granted") return <>This account hasn't added Google Calendar yet. Add it on {accounts}, then pick calendars here.</>;
  if (err.code === "calendar_api_disabled") return <>The Google Calendar API is turned off in your Cloud project. Turn it on from {accounts}.</>;
  if (err.code === "needs_reauth") return <>Google no longer accepts this account's sign-in. Reconnect it on {accounts}.</>;
  return null;
}

/** The calendar lists of several accounts (live from Google; accounts that can't list them come back as errors). */
export function useCalendars(accountIds: string[], enabled = true) {
  const results = useQueries({ queries: accountIds.map((id) => ({ ...queries.accountCalendars(id), enabled })) });
  return accountIds.map((accountId, i) => ({ accountId, query: results[i]! }));
}

/** Calendar id → name over several accounts' lists (the id while unknown). */
export function useCalendarNames(accountIds: string[]): (id: string) => string {
  const map = new Map(useCalendars(accountIds).flatMap((l) => (l.query.data ?? []).map((c) => [c.id, c.name] as const)));
  return (id) => map.get(id) ?? id;
}

/**
 * Checkboxes over calendars, primary first. Ids in `value` that aren't listed (removed since) stay visible so
 * they can be unticked, unless `unlisted` is false (the caller shows them once for several lists).
 */
export function CalendarChecklist({
  calendars,
  value,
  onChange,
  unlisted = true,
}: {
  calendars: CalendarInfo[];
  value: string[];
  onChange: (v: string[]) => void;
  unlisted?: boolean;
}) {
  const listed = new Set(calendars.map((c) => c.id));
  const missing = unlisted ? value.filter((id) => !listed.has(id)) : [];
  const toggle = (id: string, on: boolean) => onChange(on ? [...new Set([...value, id])] : value.filter((x) => x !== id));
  const sorted = [...calendars].sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {sorted.map((c) => (
        <label
          key={c.id}
          className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 has-[[data-state=checked]]:bg-muted/40"
        >
          <Checkbox checked={value.includes(c.id)} onCheckedChange={(v) => toggle(c.id, v === true)} />
          <span className="size-2.5 shrink-0 rounded-full border" style={c.color ? { backgroundColor: c.color, borderColor: c.color } : undefined} aria-hidden />
          <span className="min-w-0 flex-1 truncate" title={c.id}>
            {c.name}
          </span>
          {c.primary ? (
            <Badge variant="secondary" className="font-normal">
              Primary
            </Badge>
          ) : (
            (c.accessRole === "reader" || c.accessRole === "freeBusyReader") && (
              <span className="shrink-0 text-xs text-muted-foreground">read-only</span>
            )
          )}
        </label>
      ))}
      {missing.map((id) => (
        <label key={id} className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-dashed px-3 py-2 text-sm">
          <Checkbox checked onCheckedChange={(v) => toggle(id, v === true)} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs" title={id}>
            {id}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">no longer listed</span>
        </label>
      ))}
    </div>
  );
}
