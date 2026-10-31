import type { Account, CalendarSetupInput, CalendarSetupState } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertCircleIcon, CalendarPlusIcon, CheckCircle2Icon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { connectAccount } from "@/components/accounts/connect-host";
import { confirm } from "@/components/confirm";
import { CodeBlock, ErrorAlert, linkify, QueryError, ToneBadge } from "@/components/common";
import { CloudLink, Expect, Guide, GuideStep, Path } from "@/components/setup/wizard-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, toastError } from "@/lib/api";
import { cloudUrl } from "@/lib/gcp-project";
import { keys, queries } from "@/lib/queries";
import { cn } from "@/lib/utils";
import {
  accountCalendarView,
  CALENDAR_PAGES,
  type CalendarPage,
  CONSENT_OUTCOME,
  consentDirectly,
  consentOutcome,
  startPage,
} from "./calendar-flow";

const PAGE_LABEL: Record<CalendarPage, string> = {
  api: "Calendar API",
  scopes: "Sign-in screen",
  accounts: "Accounts",
};

type Request = { page?: CalendarPage } | { consent: { id: string; email: string } };

// Like connectAccount: the mounted host registers itself so any button can open the flow, and a
// per-account consent can open Google's pop-up synchronously inside its click handler.
let opener: ((r: Request) => void) | null = null;

/** Opens "Add Google Calendar" where it left off (or at `page`). */
export function openCalendarSetup(page?: CalendarPage) {
  opener?.({ page });
}

/**
 * "Add Calendar" for one account: straight to Google's consent once Calendar is turned on and the API
 * isn't known to be off; otherwise the dialog, from the step still to do.
 */
export function addCalendarTo(account: { id: string; email: string }) {
  opener?.({ consent: account });
}

const patchSetup = (body: CalendarSetupInput) => api<CalendarSetupState>("/api/google/calendar", { method: "PATCH", body });
const checkSetup = () => api<CalendarSetupState>("/api/google/calendar/check", { method: "POST" });

/** The "Add Google Calendar" dialog. Mounted once in the app layout, next to the connect dialog it hands each consent to. */
export function CalendarSetupHost() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<CalendarPage>("api");
  /** The last per-account consent, shown on the accounts page once the probe after it answered. */
  const [result, setResult] = useState<{ accountId: string; email: string; confirmed: boolean } | null>(null);
  const [busy, setBusy] = useState<"check" | "enable" | null>(null);
  const setup = useQuery({ ...queries.calendarSetup(), enabled: open });
  const state = useQuery(queries.setupState());

  const store = (s: CalendarSetupState) => {
    qc.setQueryData(keys.calendarSetup, s);
    for (const k of [keys.setupState, keys.accounts]) void qc.invalidateQueries({ queryKey: k });
  };

  const check = async (): Promise<CalendarSetupState | null> => {
    setBusy("check");
    try {
      const s = await checkSetup();
      store(s);
      return s;
    } catch (err) {
      toastError(err, "Couldn't check Google Calendar");
      void qc.invalidateQueries({ queryKey: keys.calendarSetup });
      return null;
    } finally {
      setBusy(null);
    }
  };

  // Google answered (or the dialog was closed): come back, probe the account, and say how it went.
  const afterConsent = async (account: { id: string; email: string }, confirmed: boolean) => {
    setPage("accounts");
    setOpen(true);
    const s = await check();
    setResult({ accountId: account.id, email: account.email, confirmed });
    if (s && consentOutcome(s.accounts.find((a) => a.accountId === account.id), confirmed) === "api_disabled") setPage("api");
  };

  const consent = (account: { id: string; email: string }) => {
    setResult(null);
    setOpen(false);
    connectAccount({
      reauthAccountId: account.id,
      email: account.email,
      scopes: ["calendar"],
      handBack: true,
      onDone: (confirmed) => void afterConsent(account, confirmed),
      // Unticked Calendar: Google answered, and the probe shows what was granted.
      onCancel: (err) => void afterConsent(account, err?.code === "oauth_calendar_not_granted"),
    });
  };

  const openerRef = useRef<(r: Request) => void>(() => {});
  useEffect(() => {
    openerRef.current = (r) => {
      const cached = qc.getQueryData<CalendarSetupState>(keys.calendarSetup);
      if ("consent" in r && consentDirectly(cached)) return consent(r.consent);
      setResult(null);
      setPage(("page" in r && r.page) || (cached ? startPage(cached) : "api"));
      setOpen(true);
    };
  });
  useEffect(() => {
    opener = (r) => openerRef.current(r);
    return () => {
      opener = null;
    };
  }, []);

  // Step 2 → 3 turns Calendar on: from now on every connect and reconnect asks for it too.
  const toAccounts = async () => {
    if (setup.data && !setup.data.enabled) {
      setBusy("enable");
      try {
        store(await patchSetup({ enabled: true }));
      } catch (err) {
        return toastError(err, "Couldn't turn on Google Calendar");
      } finally {
        setBusy(null);
      }
    }
    setPage("accounts");
  };

  // Once Calendar is on, the API was the hold-up: re-probe and go back to the accounts (step 2 stays a click away).
  const fromApi = async () => {
    if (!setup.data?.enabled) return setPage("scopes");
    if (setup.data.api === "disabled") await check();
    setPage("accounts");
  };

  const s = setup.data;
  const index = CALENDAR_PAGES.indexOf(page);
  const project = state.data?.gcpProjectId ?? null;
  // Google's own enable link from the SERVICE_DISABLED error, when it gave one, else the project's.
  const apiWarning = state.data?.warnings.find((w) => w.code === "calendar_api_disabled");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add Google Calendar</DialogTitle>
          <DialogDescription>
            Three short steps. Mail keeps working throughout, and agents get Calendar only once you add it to their access.
          </DialogDescription>
        </DialogHeader>

        <ol className="grid grid-cols-3 gap-1.5" aria-label="Steps">
          {CALENDAR_PAGES.map((p, i) => (
            <li key={p}>
              <button
                type="button"
                onClick={() => (p === "accounts" ? void toAccounts() : setPage(p))}
                disabled={!s}
                aria-current={p === page ? "step" : undefined}
                className={cn(
                  "w-full space-y-1.5 rounded-sm text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  p === page && "font-medium text-foreground",
                )}
              >
                <span aria-hidden className={cn("block h-1 rounded-full", i <= index ? "bg-primary" : "bg-muted")} />
                <span className="block">
                  <span className="tabular">{i + 1}.</span> {PAGE_LABEL[p]}
                </span>
              </button>
            </li>
          ))}
        </ol>

        {setup.isPending ? (
          <Skeleton className="h-48 rounded-lg" />
        ) : setup.isError ? (
          <QueryError error={setup.error} onRetry={() => void setup.refetch()} />
        ) : page === "api" ? (
          <ApiPage s={setup.data} project={project} warningUrl={apiWarning?.url} result={result} />
        ) : page === "scopes" ? (
          <ScopesPage s={setup.data} appType={state.data?.googleAppType ?? null} project={project} />
        ) : (
          <AccountsPage s={setup.data} result={result} checking={busy === "check"} onConsent={consent} onApi={() => setPage("api")} onDone={() => setOpen(false)} />
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => (index > 0 ? setPage(CALENDAR_PAGES[index - 1]!) : setOpen(false))}>
            {index > 0 ? "Back" : "Close"}
          </Button>
          <div className="flex flex-wrap justify-end gap-2">
            {(page === "accounts" || s?.api === "disabled") && (
              <Button variant="outline" disabled={!s || busy !== null} onClick={() => void check()}>
                {busy === "check" ? <Spinner /> : <RotateCwIcon />} Check again
              </Button>
            )}
            {page === "api" && (
              <Button disabled={!s || busy !== null} onClick={() => void fromApi()}>
                {s?.api === "disabled" ? "It's on now, continue" : "Done, continue"}
              </Button>
            )}
            {page === "scopes" && (
              <Button disabled={!s || busy !== null} onClick={() => void toAccounts()}>
                {busy === "enable" && <Spinner />} Continue
              </Button>
            )}
            {page === "accounts" && <Button onClick={() => setOpen(false)}>{s?.step === "done" ? "Done" : "Finish later"}</Button>}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApiPage({
  s,
  project,
  warningUrl,
  result,
}: {
  s: CalendarSetupState;
  project: string | null;
  warningUrl?: string;
  result: { email: string; confirmed: boolean } | null;
}) {
  const url = warningUrl ?? s.enableApiUrl ?? (project ? cloudUrl.enableCalendar(project) : "https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com");
  const command = s.enableApiCommand ?? "gcloud services enable calendar-json.googleapis.com";
  return (
    <div className="space-y-4">
      {s.api === "disabled" && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>{result ? CONSENT_OUTCOME.api_disabled.title(result.email) : "Google says the Calendar API is off in the project"}</AlertTitle>
          <AlertDescription>
            <p>Turn it on below, wait a minute, then click Check again. Mail works as usual meanwhile.</p>
          </AlertDescription>
        </Alert>
      )}
      <Guide>
        <GuideStep
          title={<>Enable the Google Calendar API{project ? <> in <code className="font-mono">{project}</code></> : null}</>}
          done={s.api === "enabled"}
          expect={
            <>
              “API enabled” on the Google Calendar API page (or a <strong className="text-foreground">Manage</strong> button, if it already was).
            </>
          }
        >
          <p>
            Open the link (it preselects the project), confirm the project, then click <strong className="text-foreground">Next</strong> and{" "}
            <strong className="text-foreground">Enable</strong>.
          </p>
          <CloudLink href={url} variant="default">
            Enable the Calendar API
          </CloudLink>
          <p>Or run this in Cloud Shell:</p>
          <CodeBlock code={command} wrap copyLabel="Copy command" />
          {s.api === "unknown" && (
            <p className="text-xs">xaq can only confirm this once an account has Calendar access (step 3), so continue once it's enabled.</p>
          )}
        </GuideStep>
      </Guide>
    </div>
  );
}

function ScopesPage({ s, appType, project }: { s: CalendarSetupState; appType: "internal" | "external" | null; project: string | null }) {
  const url = s.dataAccessUrl ?? (project ? cloudUrl.authScopes(project) : null);
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="outline">{appType === "external" ? "Recommended" : "Optional"}</Badge>
        {appType === "external"
          ? "Your app is External: listing the scopes makes Google's sign-in screen name them."
          : "Your app is Internal: this only changes what Google Cloud lists. Skip it if you like."}
      </p>
      <Guide>
        <GuideStep title="Add the three Calendar scopes on the Data Access page">
          <p>
            <Path items={["Google Auth Platform", "Data Access", "Add or remove scopes"]} />, paste these under “Manually add scopes”, then{" "}
            <Path items={["Add to table", "Update", "Save"]} />.
          </p>
          <CodeBlock code={s.scopes.join("\n")} wrap copyLabel="Copy scopes" />
          {url ? <CloudLink href={url}>Open Data Access</CloudLink> : <p className="text-xs">Open your project in Google Cloud first.</p>}
          <Expect>the three scopes under “Your sensitive scopes” after Save.</Expect>
        </GuideStep>
      </Guide>
      <p className="text-xs text-muted-foreground">
        Google doesn't tell xaq whether this was done. Continue turns Calendar on: from then on, connecting or reconnecting an account
        asks for Calendar too.
      </p>
    </div>
  );
}

function AccountsPage({
  s,
  result,
  checking,
  onConsent,
  onApi,
  onDone,
}: {
  s: CalendarSetupState;
  result: { accountId: string; email: string; confirmed: boolean } | null;
  checking: boolean;
  onConsent: (a: { id: string; email: string }) => void;
  onApi: () => void;
  onDone: () => void;
}) {
  const accounts = useQuery(queries.accounts());
  const statusOf = (id: string): Account | undefined => accounts.data?.find((a) => a.id === id);

  if (!s.accounts.length)
    return <p className="text-sm text-muted-foreground">No accounts are connected yet. Accounts you connect from now on get Calendar with the same sign-in.</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        One short Google sign-in per account. Google asks only for the Calendar permissions; Gmail and real-time delivery stay as they are, and
        mail keeps arriving while you do it.
      </p>
      <ul className="divide-y rounded-lg border">
        {s.accounts.map((a) => {
          const view = accountCalendarView({ ...a, error: statusOf(a.accountId)?.calendar?.error }, s.enabled);
          const mine = result?.accountId === a.accountId;
          const outcome = mine ? consentOutcome(a, result.confirmed) : null;
          const o = outcome ? CONSENT_OUTCOME[outcome] : null;
          const reauth = statusOf(a.accountId)?.status === "needs_reauth";
          return (
            <li key={a.accountId} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.email}</span>
                {mine && checking ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
                    <Spinner /> Checking with Google…
                  </span>
                ) : a.status === "active" ? (
                  <span className="flex items-center gap-1.5 text-xs text-success">
                    <CheckCircle2Icon className="size-4" /> Calendar added
                  </span>
                ) : (
                  <ToneBadge tone={view.tone}>{view.label}</ToneBadge>
                )}
                {view.fix === "consent" && (
                  <Button size="sm" variant={mine ? "outline" : "default"} disabled={checking} onClick={() => onConsent({ id: a.accountId, email: a.email })}>
                    <CalendarPlusIcon /> {mine ? "Try again" : "Add Calendar"}
                  </Button>
                )}
                {view.fix === "enable_api" && (
                  <Button size="sm" variant="outline" onClick={onApi}>
                    Turn on the API
                  </Button>
                )}
              </div>
              {o && !checking ? (
                <p className={cn("text-xs", o.tone === "good" ? "text-success" : o.tone === "bad" ? "text-critical" : "text-muted-foreground")} role="status">
                  <span className="font-medium">{o.title(a.email)}.</span> {o.body}
                </p>
              ) : a.status !== "active" ? (
                <p className="text-xs text-muted-foreground">
                  {view.description}
                  {reauth && " Its Google sign-in also needs renewing: this sign-in does both."}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {s.step === "done" && (
        <Alert variant="success">
          <CheckCircle2Icon />
          <AlertTitle>Google Calendar is added</AlertTitle>
          <AlertDescription>
            <p>
              Agents with access to an account use its calendars too: read only, or full access to change them.
            </p>
            <div className="pt-1">
              <Button size="sm" variant="outline" asChild onClick={onDone}>
                <Link to="/agents">Go to Agents</Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Where Settings shows Calendar: one status line and the button that opens the flow. */
export function CalendarSetupSummary() {
  const qc = useQueryClient();
  const setup = useQuery(queries.calendarSetup());
  // E.g. a Workspace admin blocks Calendar for unconfigured apps, which makes Google refuse whole sign-ins.
  const turnOff = () =>
    confirm({
      title: "Turn off Google Calendar?",
      confirmLabel: "Turn off",
      description: (
        <p>
          Connecting and reconnecting accounts asks for Gmail only again. Calendar access accounts already granted stays with them. Turn it back on
          any time with Add Google Calendar.
        </p>
      ),
      onConfirm: async () => {
        qc.setQueryData(keys.calendarSetup, await patchSetup({ enabled: false }));
        void qc.invalidateQueries({ queryKey: keys.setupState });
      },
    });
  if (setup.isPending) return <Skeleton className="h-10 rounded-lg" />;
  if (setup.isError) return <ErrorAlert error={setup.error} title="Couldn't load the Google Calendar setup" />;
  const s = setup.data;
  const added = s.accounts.filter((a) => a.status === "active").length;
  const line = !s.enabled
    ? "Not added. Agents use Gmail only."
    : s.step === "enable_api"
      ? "Google says the Calendar API is off in the project."
      : s.accounts.length
        ? `Added to ${added} of ${s.accounts.length} account${s.accounts.length === 1 ? "" : "s"}.`
        : "On: accounts you connect get Calendar too.";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm">{linkify(line)}</p>
      <div className="flex flex-wrap gap-2">
        {s.enabled && (
          <Button type="button" variant="ghost" onClick={turnOff}>
            Turn off
          </Button>
        )}
        <Button type="button" variant={s.step === "done" ? "outline" : "default"} onClick={() => openCalendarSetup()}>
          <CalendarPlusIcon /> {!s.enabled ? "Add Google Calendar" : s.step === "done" ? "Review" : "Continue setup"}
        </Button>
      </div>
    </div>
  );
}
