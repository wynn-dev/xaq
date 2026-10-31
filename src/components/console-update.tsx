import type { HealthResponse, SelfUpdateInfo, SelfUpdateStatus } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircleIcon, InboxIcon } from "lucide-react";
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
import { loadPending, outcomeText, type PendingUpdate, savePending, updateVerdict } from "@/lib/self-update";

const POLL_MS = 2000;

/** Version in the sidebar footer; turns into an update notice when there is one. */
export function ConsoleVersion({ version, service }: { version?: string; service?: boolean }) {
  const { data } = useQuery(queries.systemLatest());
  const { data: self } = useQuery({ ...queries.systemUpdate(), enabled: !!service });
  const update = useUpdateJob();
  const offerUpdate = !!data?.updateAvailable && !!data.latest;

  if (!offerUpdate && !update.pending) {
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
          {update.pending ? <Spinner className="size-3.5" /> : <ArrowUpCircleIcon className="size-3.5" />}
          <span className="flex-1">{update.pending ? "Updating…" : "Update available"}</span>
          <span className="text-muted-foreground">{update.pending ? update.pending.to : data!.latest}</span>
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
      const outcome = outcomeText(status ?? { ...pending, state: "succeeded", message: null, startedAt: "", finishedAt: null });
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
    start(started: SelfUpdateStatus) {
      const next = { id: started.id, from: started.from, to: started.to };
      savePending(next);
      setFailure(null);
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
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Update xaq</DialogTitle>
        <DialogDescription>
          {latest ? `You're on ${current}; the latest release is ${latest}. ` : `You're on ${current}, the latest release. `}
          {oneClick
            ? "Update now reinstalls the service with it and restarts xaq. Your data, accounts and agents are kept."
            : service
              ? "Run this on the server. It reinstalls the service with the latest version and keeps your data, accounts and agents."
              : "Stop xaq, then run this on the server to start the latest version. Your data is kept."}
        </DialogDescription>
      </DialogHeader>
      {oneClick && update!.pending ? (
        <Progress pending={update!.pending} />
      ) : oneClick ? (
        <>
          {update!.failure && <Outcome status={update!.failure} />}
          {latest && <OneClick latest={latest} onStarted={update!.start} />}
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

function Progress({ pending }: { pending: PendingUpdate }) {
  return (
    <div className="flex items-start gap-3 rounded-md border p-3 text-sm">
      <Spinner className="mt-0.5" />
      <div className="space-y-1">
        <p className="font-medium">Updating to {pending.to}</p>
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

/** "Update now", confirmed with the admin password. */
function OneClick({ latest, onStarted }: { latest: string; onStarted: (status: SelfUpdateStatus) => void }) {
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (!asking) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setAsking(true)}>
          <ArrowUpCircleIcon />
          Update now
        </Button>
      </div>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onStarted(await api<SelfUpdateStatus>("/api/system/update", { body: { password, version: latest } }));
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
          <FieldLabel htmlFor="update-password">Admin password, to update to {latest}</FieldLabel>
          <PasswordInput id="update-password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {!!error && <ErrorAlert error={error} />}
        <div className="flex gap-2">
          <Button type="submit" disabled={!password || busy}>
            {busy && <Spinner />}
            Update now
          </Button>
          <Button type="button" variant="ghost" onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
