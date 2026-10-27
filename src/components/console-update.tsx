import type { HealthResponse, SelfUpdateInfo, SelfUpdateStatus } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircleIcon, InboxIcon, Undo2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CodeBlock, ErrorAlert } from "@/components/common";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { api, apiGet } from "@/lib/api";
import { queries } from "@/lib/queries";
import { loadPending, outcomeText, type PendingUpdate, savePending, STEP_TEXT, updateVerdict } from "@/lib/self-update";

const POLL_MS = 2000;

/** Version in the sidebar footer; turns into an update notice (or "go back", after an update from here) when there is one. */
export function ConsoleVersion({ version, service }: { version?: string; service?: boolean }) {
  const { data } = useQuery(queries.systemLatest());
  const { data: self } = useQuery({ ...queries.systemUpdate(), enabled: !!service });
  const update = useUpdateJob();
  const previous = self?.supported ? self.previous : null;
  const offerUpdate = !!data?.updateAvailable && !!data.latest;

  if (!offerUpdate && !previous && !update.pending) {
    return (
      <span className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
        <InboxIcon className="size-3.5" />
        xaq {version ?? data?.current ?? ""}
      </span>
    );
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-chart-1 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none group-data-[collapsible=icon]:hidden">
          {update.pending ? <Spinner className="size-3.5" /> : offerUpdate ? <ArrowUpCircleIcon className="size-3.5" /> : <InboxIcon className="size-3.5" />}
          <span className="flex-1">{update.pending ? "Updating…" : offerUpdate ? "Update available" : `xaq ${version ?? data?.current ?? ""}`}</span>
          <span className="text-muted-foreground">{update.pending ? update.pending.to : offerUpdate ? data!.latest : null}</span>
        </button>
      </DialogTrigger>
      <UpdateDialogContent
        current={data?.current ?? version ?? ""}
        latest={offerUpdate ? data!.latest : null}
        command={data?.command ?? ""}
        service={service}
        self={self}
        update={update}
      />
    </Dialog>
  );
}

type UpdateJob = ReturnType<typeof useUpdateJob>;

/**
 * The update this tab started, followed to its end: polls the job's status and /api/health, reloads once the
 * new version answers (to load its console), then reports the outcome. Survives the reload in sessionStorage.
 */
function useUpdateJob() {
  const [pending, setPending] = useState<PendingUpdate | null>(loadPending);
  const [step, setStep] = useState<SelfUpdateStatus["step"] | null>(null);
  const [failure, setFailure] = useState<SelfUpdateStatus | null>(null);

  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const [info, health] = await Promise.all([
        apiGet<SelfUpdateInfo>("/api/system/update").catch(() => null),
        // Public and outside the session: answers as soon as the restarted service is up.
        fetch("/api/health", { cache: "no-store" })
          .then((res) => res.json() as Promise<HealthResponse>)
          .catch(() => null),
      ]);
      if (stopped) return;
      const status = info?.status?.id === pending.id ? info.status : null;
      if (status) setStep(status.step);
      const verdict = updateVerdict(pending, status, health);
      if (verdict === "wait") {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      if (verdict === "reload") {
        savePending({ ...pending, reloaded: true });
        window.location.reload();
        return;
      }
      const outcome = outcomeText(status ?? { ...pending, state: "succeeded", step: "done", message: null, startedAt: "", finishedAt: null });
      if (outcome.ok) toast.success(outcome.title);
      else toast.error(outcome.title, { description: outcome.description });
      setFailure(outcome.ok ? null : status);
      savePending(null);
      setPending(null);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending]);

  return {
    pending,
    failure,
    step: pending ? step : null,
    start(started: SelfUpdateStatus) {
      const next = { id: started.id, kind: started.kind, from: started.from, to: started.to };
      savePending(next);
      setFailure(null);
      setStep(started.step);
      setPending(next);
    },
  };
}

export function UpdateDialogContent({
  current,
  latest,
  command,
  service,
  self,
  update,
}: {
  current: string;
  latest: string | null;
  command: string;
  service?: boolean;
  self?: SelfUpdateInfo;
  update?: UpdateJob;
}) {
  const oneClick = !!self?.supported && !!update;
  const previous = oneClick ? self!.previous : null;
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Update xaq</DialogTitle>
        <DialogDescription>
          {latest ? `You're on ${current}; the latest release is ${latest}. ` : `You're on ${current}, the latest release. `}
          {oneClick
            ? "Update now installs it beside this one, restarts xaq and goes back by itself if the new version doesn't come up. Your data, accounts and agents are kept."
            : service
              ? "Run this on the server. It reinstalls the service with the latest version and keeps your data, accounts and agents."
              : "Stop xaq, then run this on the server to start the latest version. Your data is kept."}
        </DialogDescription>
      </DialogHeader>
      {oneClick && update!.pending ? (
        <Progress pending={update!.pending} step={update!.step} />
      ) : oneClick ? (
        <>
          {update!.failure && <Outcome status={update!.failure} />}
          <OneClick latest={latest} previous={previous} onStarted={update!.start} />
          {latest && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Or run this on the server:</p>
              <CodeBlock code={command} />
            </div>
          )}
        </>
      ) : (
        latest && <CodeBlock code={command} />
      )}
    </DialogContent>
  );
}

function Progress({ pending, step }: { pending: PendingUpdate; step: SelfUpdateStatus["step"] | null }) {
  return (
    <div className="flex items-start gap-3 rounded-md border p-3 text-sm">
      <Spinner className="mt-0.5" />
      <div className="space-y-1">
        <p className="font-medium">{pending.kind === "rollback" ? `Going back to ${pending.to}` : `Updating to ${pending.to}`}</p>
        <p className="text-muted-foreground">{STEP_TEXT[step ?? "starting"]}</p>
        <p className="text-xs text-muted-foreground">
          This takes a minute or two. The console is unavailable while xaq restarts; this page reloads when the new version answers.
        </p>
      </div>
    </div>
  );
}

function Outcome({ status }: { status: SelfUpdateStatus }) {
  const { title, description } = outcomeText(status);
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      {description && <AlertDescription>{description}</AlertDescription>}
    </Alert>
  );
}

/** "Update now" / "Go back", each confirmed with the admin password. */
function OneClick({ latest, previous, onStarted }: { latest: string | null; previous: string | null; onStarted: (status: SelfUpdateStatus) => void }) {
  const [action, setAction] = useState<"update" | "rollback" | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (!action) {
    return (
      <div className="flex flex-wrap gap-2">
        {latest && (
          <Button onClick={() => setAction("update")}>
            <ArrowUpCircleIcon />
            Update now
          </Button>
        )}
        {previous && (
          <Button variant="outline" onClick={() => setAction("rollback")}>
            <Undo2Icon />
            Go back to {previous}
          </Button>
        )}
      </div>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = action === "update" ? { password, action, version: latest! } : { password, action };
      onStarted(await api<SelfUpdateStatus>("/api/system/update", { body }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (password && !busy) void submit();
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="update-password">{action === "update" ? `Admin password, to update to ${latest}` : `Admin password, to go back to ${previous}`}</FieldLabel>
          <PasswordInput id="update-password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {!!error && <ErrorAlert error={error} />}
        <div className="flex gap-2">
          <Button type="submit" disabled={!password || busy}>
            {busy && <Spinner />}
            {action === "update" ? "Update now" : `Go back to ${previous}`}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setAction(null)}>
            Cancel
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
