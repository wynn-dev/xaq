import { publicUrlProblem } from "@shared/public-url";
import type { GoogleClientView, Settings } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon, LaptopIcon, NetworkIcon, ServerIcon, ShieldIcon, XCircleIcon } from "lucide-react";
import { useState } from "react";
import { ChoiceCards } from "@/components/choice-cards";
import { CodeBlock, ErrorAlert, Wrapped } from "@/components/common";
import { RedirectNotice, useRedirectProblem } from "@/components/google/redirect-notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { NPX } from "@/lib/cli";
import { useApiMutation } from "@/lib/mutations";
import { addressLabel, analyzeUrl, consolePort, isLoopbackOrigin, localConsoleUrl, type Tone, type UrlAnalysis, urlVerdict } from "@/lib/public-url";
import { keys, queries } from "@/lib/queries";
import { tunnelCommand } from "@/lib/tunnel";
import { cn } from "@/lib/utils";
import { STEP_META, type StepId, updateDraft, useSetupProgress } from "./progress";
import { Disclosure, StepCard, StepFooter } from "./wizard-shell";

export interface StepProps {
  index: number;
  onBack?: () => void;
  onNext: () => void;
  /** Set when the user jumped back from a later step: Continue goes back there. */
  returnTo?: StepId;
  /** The short broker path (first-run.ts): its step count and last button. */
  total?: number;
  nextLabel?: string;
}

const TONE_ICON = { good: CheckCircle2Icon, warn: AlertTriangleIcon, bad: XCircleIcon, info: InfoIcon };
const TONE_COLOR = { good: "text-success", warn: "text-warning", bad: "text-critical", info: "text-chart-1" };

export function UrlVerdict({ analysis, browserRemote, className }: { analysis: UrlAnalysis; browserRemote: boolean; className?: string }) {
  const v = urlVerdict(analysis, browserRemote);
  const rows: [string, [Tone, string]][] = [
    ["Google sign-in", v.google],
    ["Agents", v.agents],
  ];
  return (
    <dl className={cn("divide-y rounded-lg border text-sm", className)}>
      {rows.map(([label, [tone, text]]) => {
        const Icon = TONE_ICON[tone];
        return (
          <div key={label} className="flex items-start gap-2.5 px-3 py-2">
            <Icon className={cn("mt-0.5 size-4 shrink-0", TONE_COLOR[tone])} aria-hidden />
            <dt className="w-28 shrink-0 font-medium">{label}</dt>
            <dd className="min-w-0 flex-1 text-muted-foreground">{text}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function StepUrl(props: StepProps) {
  const settings = useQuery(queries.settings());
  const system = useQuery(queries.system());
  if (settings.isPending) return <Skeleton className="h-96 rounded-xl" />;
  if (settings.isError) return <ErrorAlert error={settings.error} title="Couldn't load settings" />;
  return <UrlForm {...props} settings={settings.data} addresses={system.data?.addresses ?? []} />;
}

type Situation = "local" | "remote" | "tailscale" | "public";

function UrlForm({ index, onNext, returnTo, settings, addresses }: StepProps & { settings: Settings; addresses: string[] }) {
  const qc = useQueryClient();
  const { statuses } = useSetupProgress();
  const origin = window.location.origin;
  const browserRemote = !isLoopbackOrigin(origin);
  // First visit (nothing confirmed, no client, no account): the address in the browser's bar is the best
  // guess. Once the step is done, a new browser shows the saved address and never changes it silently.
  const firstVisit = statuses.url !== "done";
  const [url, setUrl] = useState(firstVisit && analyzeUrl(origin) ? origin : settings.publicUrl);
  const [changedRedirect, setChangedRedirect] = useState(false);
  const error = publicUrlProblem(url);
  const clean = url.trim().replace(/\/+$/, "");
  const analysis = error ? null : analyzeUrl(clean);
  const port = consolePort(addresses, settings.publicUrl);
  const chips = [...new Set([origin, ...addresses])];
  const redirectProblem = useRedirectProblem();
  const [situation, setSituation] = useState<Situation | undefined>(
    browserRemote ? (analyzeUrl(origin)?.transport === "tailscale" ? "tailscale" : analyzeUrl(origin)?.transport === "https" ? "public" : "remote") : undefined,
  );

  const save = useApiMutation({
    mutationFn: (publicUrl: string) => api<Settings>("/api/settings", { method: "PATCH", body: { publicUrl } }),
    errorTitle: false,
    onSuccess: async (s) => {
      qc.setQueryData(keys.settings, s);
      void qc.invalidateQueries({ queryKey: keys.system });
      updateDraft({ urlConfirmed: true });
      const before = qc.getQueryData<GoogleClientView>(keys.googleClient);
      const after = await qc.fetchQuery({ ...queries.googleClient(), staleTime: 0 });
      // The server compares the new redirect URI with the one the client was saved with (redirect_uri_changed).
      await qc.fetchQuery({ ...queries.setupState(), staleTime: 0 });
      // A saved OAuth client was registered with the old redirect URI: say what to add before moving on.
      if (before?.clientId && before.redirectUri !== after.redirectUri) setChangedRedirect(true);
      else onNext();
    },
  });

  const next = () => {
    if (error) return;
    if (clean === settings.publicUrl) {
      updateDraft({ urlConfirmed: true });
      onNext();
    } else {
      save.mutate(clean);
    }
  };

  const tunnel = tunnelCommand({ port, addresses, browserHost: window.location.hostname });
  // On a loopback origin already (e.g. the CLI's http://127.0.0.1 link): keep it, don't switch hostnames.
  const { url: localUrl, fromBrowser: localIsOrigin } = localConsoleUrl(origin, port);

  return (
    <StepCard
      index={index}
      title={STEP_META.url.title}
      description="Google sends you back to this address after you sign in, and your agents use it to reach xaq."
      footer={
        changedRedirect ? (
          <StepFooter onNext={onNext} nextLabel={redirectProblem ? "I'll add it, continue" : "Continue"} />
        ) : (
          <StepFooter
            onNext={next}
            nextDisabled={!!error}
            pending={save.isPending}
            nextLabel={returnTo ? `Looks right, back to ${STEP_META[returnTo].short}` : "Looks right"}
          />
        )
      }
    >
      {changedRedirect ? (
        <div className="space-y-3" role="status">
          <p className="text-sm">
            Saved: xaq is now at <code className="font-mono">{settings.publicUrl}</code>.
          </p>
          <RedirectNotice showStatus />
        </div>
      ) : (
        <>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="setup-url">Address of xaq</FieldLabel>
            <Input
              id="setup-url"
              className="font-mono"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && next()}
              aria-invalid={!!error}
              aria-describedby="setup-url-hint"
            />
            <div id="setup-url-hint">
              {error ? (
                <FieldError>{error}</FieldError>
              ) : (
                <FieldDescription>
                  {firstVisit && clean === origin && settings.publicUrl !== origin
                    ? "Filled in from your browser's address bar. "
                    : ""}
                  Agents will connect to{" "}
                  <span className="font-mono">
                    <Wrapped text={`${clean}/mcp`} />
                  </span>
                </FieldDescription>
              )}
            </div>
            {chips.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1" role="group" aria-label="Addresses this server is reachable at">
                {chips.map((a) => (
                  <Button
                    key={a}
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn("h-auto flex-col items-start gap-0 py-1 text-left", a === clean && "border-primary")}
                    aria-pressed={a === clean}
                    onClick={() => setUrl(a)}
                  >
                    <span className="text-[11px] font-normal text-muted-foreground">{addressLabel(a, origin)}</span>
                    <span className="font-mono text-xs">{a}</span>
                  </Button>
                ))}
              </div>
            )}
          </Field>

          {save.isError && <ErrorAlert error={save.error} title="Couldn't save the address" />}

          {analysis && <UrlVerdict analysis={analysis} browserRemote={browserRemote} />}

          {analysis?.host === "loopback" && browserRemote && (
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertTitle>You're browsing from another computer</AlertTitle>
              <AlertDescription>
                <p>
                  This console is open at <span className="font-mono">{origin}</span>, so localhost here means your own computer, not the server.
                  Use an SSH tunnel (below) to make localhost work, or pick another option.
                </p>
              </AlertDescription>
            </Alert>
          )}

          <Disclosure summary="Not sure which address to use? Pick your situation" defaultOpen={browserRemote}>
            <ChoiceCards<Situation>
              aria-label="Where xaq runs"
              value={situation}
              onChange={setSituation}
              columns={2}
              choices={[
                { value: "local", icon: LaptopIcon, title: "All on this computer", description: "Your browser, xaq and your agents run on one machine." },
                { value: "remote", icon: ServerIcon, title: "On a server or VM", description: "xaq runs on another machine you reach over SSH (a server, VM, Raspberry Pi)." },
                { value: "tailscale", icon: NetworkIcon, title: "I use Tailscale", description: "The machines are on the same tailnet." },
                { value: "public", icon: ShieldIcon, title: "Public, with a domain", description: "A server reachable from the internet, e.g. mail.example.com." },
              ]}
            />
            {situation && (
              <div className="space-y-2.5 pt-1 text-foreground" role="region" aria-label="What to do">
                {situation === "local" && (
                  <>
                    <p>
                      {localIsOrigin ? (
                        <>
                          Use <span className="font-mono">{localUrl}</span>, the address this console is open at.
                        </>
                      ) : (
                        "Use localhost."
                      )}{" "}
                      Google sign-in works directly, and agents on this computer connect without extra flags.
                    </p>
                    <Button size="sm" variant="outline" onClick={() => setUrl(localUrl)} disabled={clean === localUrl}>
                      {clean === localUrl ? `Using ${localUrl}` : `Use ${localUrl}`}
                    </Button>
                  </>
                )}
                {situation === "remote" && (
                  <>
                    <p>
                      Easiest: an SSH tunnel. Run this on the computer with your browser (replace <code className="font-mono">you</code> with your SSH
                      user) and keep it open:
                    </p>
                    <CodeBlock code={tunnel} wrap copyLabel="Copy SSH tunnel command" />
                    <p>
                      Then open <span className="font-mono">{localUrl}</span> in your browser, sign in to this console again, and use{" "}
                      <span className="font-mono">{localUrl}</span> as the address. Agents on the server connect directly; agents on your computer
                      connect through the tunnel while it's open.
                    </p>
                    <Button size="sm" variant="outline" onClick={() => setUrl(localUrl)}>
                      Use {localUrl}
                    </Button>
                    <p className="text-muted-foreground">Agents on several machines? Use Tailscale or https instead (see the other options).</p>
                  </>
                )}
                {situation === "tailscale" && (
                  <>
                    <p>On the machine running xaq, give it an https address on your tailnet:</p>
                    <CodeBlock code={`tailscale serve --bg ${port}`} wrap copyLabel="Copy Tailscale command" />
                    <p>
                      It prints an address like <span className="font-mono">https://your-machine.your-tailnet.ts.net</span>. Open that in your
                      browser and use it here: Google sign-in works directly and every device on your tailnet can connect. (If Tailscale asks you to
                      enable HTTPS certificates, follow its link.)
                    </p>
                    <p className="text-muted-foreground">
                      The plain <span className="font-mono">http://100.x.y.z:{port}</span> address also works for agents, but sign-in then needs the
                      paste step.
                    </p>
                  </>
                )}
                {situation === "public" && (
                  <>
                    <p>
                      Put an https reverse proxy in front of xaq and keep xaq itself private. For example with Caddy (it gets the
                      certificate for you):
                    </p>
                    <CodeBlock code={`caddy reverse-proxy --from mail.example.com --to localhost:${port}`} wrap copyLabel="Copy Caddy command" />
                    <p>Start xaq so only the proxy can reach it, and trust the proxy's headers:</p>
                    <CodeBlock code={`TRUST_PROXY=1 ${NPX} --host 127.0.0.1 --port ${port}`} wrap copyLabel="Copy start command" />
                    <p>
                      Then use <span className="font-mono">https://mail.example.com</span> (your domain) here.
                    </p>
                  </>
                )}
              </div>
            )}
          </Disclosure>

          <p className="text-xs text-muted-foreground">You can change this later in Settings; xaq then shows the new redirect URI to add in Google Cloud.</p>
        </>
      )}
    </StepCard>
  );
}
