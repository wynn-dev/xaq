import type { ExtensionRegistryEntryView, ExtensionView } from "@shared/extensions";
import type {
  AccessLevel,
  Agent,
  ConnectionGrant,
  ConnectionProbe,
  ConnectionView,
  GoogleApiCheckView,
  PresetView,
  SetupStepView,
  StartConnectInput,
  StartConnectResult,
} from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, ArrowRightIcon, DownloadIcon, GlobeIcon, NetworkIcon, PlugIcon, SearchIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { connectAccount } from "@/components/accounts/connect-host";
import { ChoiceCards } from "@/components/choice-cards";
import { CopyField, ErrorAlert, ExternalLink, QueryError } from "@/components/common";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { keys, queries } from "@/lib/queries";
import { installableExtensions } from "@/components/extensions/extension-logic";
import { connectConnection } from "./connection-auth";
import { startConnect } from "./connection-row";
import {
  ACCESS_LEVELS,
  apiCheckSummary,
  type ConnectionDraft,
  connectInput,
  createInput,
  defaultName,
  draftControl,
  draftProblems,
  draftUrl,
  emptyDraft,
  finishEarlyCreate,
  hostPort,
  inputProblems,
  LEVEL_INFO,
  nameChange,
  needsProbe,
  privateExplanation,
  probeSummary,
  slugProblem,
  suggestDraftSlug,
  duplicateOf,
} from "./connection-flow";

interface Request {
  /** Open straight on this preset ("notion", "whoop"), or on the custom URL form with "custom". */
  start?: string;
  onDone?: (c: ConnectionView) => void;
}

let opener: ((r: Request) => void) | null = null;

/** Opens "Add connection" (from the Connections page, an agent's page, or the first-run wizard). */
export function openAddConnection(r: Request = {}) {
  opener?.(r);
}

type Page = "pick" | "setup" | "access";

const enc = encodeURIComponent;

/** The "Add connection" dialog. Mounted once in the app layout; hands the sign-in to ConnectionAuthHost. */
export function AddConnectionHost() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page>("pick");
  const [draft, setDraft] = useState<ConnectionDraft>(emptyDraft());
  const [startWith, setStartWith] = useState<string | undefined>();
  /** The connection created early for the private-target allow (kept by the PATCH/grants on Connect). */
  const [created, setCreated] = useState<ConnectionView | null>(null);
  const onDone = useRef<Request["onDone"]>(undefined);
  const presets = useQuery({ ...queries.presets(), enabled: open });
  // The official extensions not installed yet: the picker offers to install them (pre-made connections are extensions).
  const registry = useQuery({ ...queries.extensionRegistry(), enabled: open });
  /** Opened on a preset that isn't installed (first run's "Notion"): the picker leads with installing it. */
  const [offer, setOffer] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<unknown>();
  const connections = useQuery({ ...queries.connections(), enabled: open });
  const taken = (connections.data ?? []).map((c) => c.slug);

  const openerRef = useRef<(r: Request) => void>(() => {});
  useEffect(() => {
    openerRef.current = (r) => {
      onDone.current = r.onDone;
      setOffer(null);
      setInstallError(undefined);
      setDraft(emptyDraft());
      setCreated(null);
      setPage(r.start ? "setup" : "pick");
      setOpen(true);
      if (!r.start || r.start === "custom") return;
      // Opened on a preset id: pick it once the presets are known (the picker if it isn't one).
      setStartWith(r.start);
      void qc
        .fetchQuery(queries.presets())
        .then((list) => {
          const p = list.find((x) => x.id === r.start);
          setDraft(emptyDraft(p ?? null));
          if (!p) {
            setOffer(r.start ?? null);
            setPage("pick");
          }
        })
        .catch(() => setPage("pick"))
        .finally(() => setStartWith(undefined));
    };
  });
  useEffect(() => {
    opener = (r) => openerRef.current(r);
    return () => {
      opener = null;
    };
  }, []);

  /** Leaving before Connect: the connection created for the allow has no sign-in yet, so it goes. */
  const dropEarly = (c: ConnectionView | null) => {
    if (!c) return;
    void api(`/api/connections/${enc(c.id)}`, { method: "DELETE" })
      .catch(() => undefined)
      .finally(() => void qc.invalidateQueries({ queryKey: keys.connections }));
  };
  const discardEarly = () => {
    dropEarly(created);
    setCreated(null);
  };
  /** Every close: drops the early connection and forgets what was typed (keys, client secrets). */
  const onOpenChange = (o: boolean) => {
    if (!o) {
      discardEarly();
      setDraft(emptyDraft());
    }
    setOpen(o);
  };

  const choose = (p: PresetView | null) => {
    discardEarly();
    // Gmail & Calendar is the native Google integration: its own connect flow (and setup, when Google isn't set up yet).
    if (p?.id === "google") {
      onOpenChange(false);
      return connectAccount();
    }
    setDraft(emptyDraft(p));
    setPage("setup");
  };

  /** Installs an official extension from the registry, then continues to its setup as if it had been there. */
  const installAndContinue = async (e: ExtensionRegistryEntryView) => {
    setInstalling(e.name);
    setInstallError(undefined);
    try {
      await api<ExtensionView>("/api/extensions", { body: { source: e.name, expectIntegrity: e.integrity } });
      void qc.invalidateQueries({ queryKey: keys.extensions });
      void qc.invalidateQueries({ queryKey: keys.extensionRegistry });
      const list = await qc.fetchQuery({ ...queries.presets(), staleTime: 0 });
      const p = list.find((x) => x.id === e.name);
      if (!p) throw new Error(`${e.displayName} was installed, but it doesn't offer a connection. Check it on the Extensions page.`);
      setOffer(null);
      choose(p);
    } catch (err) {
      setInstallError(err);
    } finally {
      setInstalling(null);
    }
  };

  const set = (patch: Partial<ConnectionDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const problems = draftProblems(draft, taken);
  const setupProblems = problems.filter((p) => !p.startsWith("Pick at least one agent"));
  const name = draft.name.trim() || draft.preset?.displayName || draft.slug || "the server";

  const connect = () => {
    const d = draft;
    const early = created;
    const done = onDone.current;
    // The early connection is this one now: closing must not delete it. What was typed is forgotten here.
    setCreated(null);
    setDraft(emptyDraft());
    setOpen(false);
    const create = createInput(d);
    // Secrets go out once: "Try again" doesn't keep the key or client secret (a header connection asks again on Reconnect).
    let secrets: StartConnectInput | null = connectInput(d);
    // Kept across "Try again": a retry reuses the connection instead of creating a second one.
    let id = early?.id ?? null;
    let finishEarly = !!early;
    connectConnection({
      name,
      onDone: done,
      run: async () => {
        if (!id) {
          id = (await api<ConnectionView>("/api/connections", { body: create })).id;
        } else if (finishEarly && early) {
          const agents = await qc.fetchQuery(queries.agents());
          const f = finishEarlyCreate(d, early, agents.map((a: Agent) => a.id));
          if (f.patch) await api<ConnectionView>(`/api/connections/${enc(id)}`, { method: "PATCH", body: f.patch });
          await api<ConnectionGrant[]>(`/api/connections/${enc(id)}/grants`, { method: "PUT", body: f.grants });
          finishEarly = false;
        }
        const body = secrets ?? {};
        secrets = null;
        const result = await api<StartConnectResult>(`/api/connections/${enc(id)}/connect`, { body });
        return { connectionId: id, result };
      },
    });
  };

  const title = page === "pick" ? "Add a connection" : page === "access" ? `What can agents do with ${name}?` : draft.preset ? `Connect ${draft.preset.displayName}` : "Connect an MCP server";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {page === "pick"
              ? "xaq keeps the sign-in. Agents get its tools through their one xaq connection, never the credentials."
              : page === "access"
                ? "You can change this later, for all agents or one at a time on an agent's page."
                : draft.preset
                  ? `Gives your agents ${draft.preset.displayName}'s tools.`
                  : "Paste the server's address. xaq checks how it signs in."}
          </DialogDescription>
        </DialogHeader>

        {page === "pick" &&
          (presets.isPending ? (
            <Skeleton className="h-48" />
          ) : presets.isError ? (
            <QueryError error={presets.error} onRetry={() => void presets.refetch()} />
          ) : (
            <PresetPicker
              presets={presets.data}
              onPick={choose}
              installable={installableExtensions(registry.data, presets.data.map((p) => p.id))}
              registryDown={registry.isError}
              offer={offer}
              installing={installing}
              installError={installError}
              onInstall={(e) => void installAndContinue(e)}
            />
          ))}

        {page === "setup" &&
          (startWith ? (
            <Skeleton className="h-48" />
          ) : (
            <SetupPage
              draft={draft}
              set={set}
              taken={taken}
              existing={duplicateOf(draft, connections.data ?? [])}
              onReuse={(c) => {
                onOpenChange(false);
                startConnect(c);
              }}
              created={created}
              onCreated={setCreated}
              onDropCreated={() => {
                dropEarly(created);
                setCreated(null);
              }}
            />
          ))}

        {page === "access" && <AccessPage draft={draft} set={set} />}

        <DialogFooter className="gap-2">
          {page !== "pick" && (
            <Button
              variant="ghost"
              onClick={() => {
                if (page === "setup") discardEarly();
                setPage(page === "access" ? "setup" : "pick");
              }}
              className="sm:mr-auto"
            >
              <ArrowLeftIcon /> Back
            </Button>
          )}
          {page === "setup" && (
            <Button disabled={setupProblems.length > 0} onClick={() => setPage("access")} title={setupProblems[0]}>
              Continue <ArrowRightIcon />
            </Button>
          )}
          {page === "access" && (
            <Button disabled={problems.length > 0} onClick={connect} title={problems[0]}>
              <PlugIcon /> Connect {name}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PresetPicker({
  presets,
  onPick,
  installable,
  registryDown,
  offer,
  installing,
  installError,
  onInstall,
}: {
  presets: PresetView[];
  onPick: (p: PresetView | null) => void;
  /** Official extensions not installed yet (installableExtensions). */
  installable: ExtensionRegistryEntryView[];
  /** The registry couldn't be fetched (offline): installing waits for the Extensions page. */
  registryDown: boolean;
  /** The preset asked for (first run) that isn't installed. */
  offer: string | null;
  installing: string | null;
  installError: unknown;
  onInstall: (e: ExtensionRegistryEntryView) => void;
}) {
  const item = "flex w-full items-start gap-3 rounded-lg border bg-card p-3 text-left text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring";
  const offered = offer ? installable.find((e) => e.name === offer) : undefined;
  const rest = installable.filter((e) => e !== offered);
  return (
    <ul className="space-y-2">
      {installError !== undefined && (
        <li>
          <ErrorAlert error={installError} />
        </li>
      )}
      {offer && !offered && !presets.some((p) => p.id === offer) && (
        <li>
          <Alert variant="info">
            <DownloadIcon />
            <AlertTitle>The {offer} extension isn't installed</AlertTitle>
            <AlertDescription>
              {registryDown
                ? "xaq couldn't reach the official extensions list. Install it from the Extensions page once it can."
                : "Install it from the Extensions page, then add the connection."}
            </AlertDescription>
          </Alert>
        </li>
      )}
      {offered && (
        <li>
          <Alert variant="info">
            <DownloadIcon />
            <AlertTitle>{offered.displayName} is an extension</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{offered.description} It comes from the official xaq extensions and is installed once; then you connect it.</p>
              <Button size="sm" disabled={installing !== null} onClick={() => onInstall(offered)}>
                {installing === offered.name ? <Spinner /> : <DownloadIcon />} Install the {offered.displayName} extension
              </Button>
            </AlertDescription>
          </Alert>
        </li>
      )}
      {presets.map((p) => (
        <li key={p.id}>
          <button type="button" className={item} onClick={() => onPick(p)}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted font-semibold">{p.displayName.slice(0, 1)}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 font-medium">
                {p.displayName}
                {!p.official && (
                  <Badge variant="outline" title="Not from the official xaq extensions: its risk map can only make tools stricter.">
                    third-party
                  </Badge>
                )}
              </span>
              {p.url && <span className="block truncate text-xs text-muted-foreground">{p.url}</span>}
              {p.userServer && <span className="block text-xs text-muted-foreground">Your own server, by its address. One connection per server.</span>}
            </span>
            <ArrowRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
      {rest.map((e) => (
        <li key={`install-${e.name}`} className="flex w-full items-start gap-3 rounded-lg border border-dashed p-3 text-sm">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted font-semibold">{e.displayName.slice(0, 1)}</span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 font-medium">
              {e.displayName}
              <Badge variant="outline">not installed</Badge>
            </span>
            <span className="block text-xs text-muted-foreground">{e.description}</span>
          </span>
          <Button size="sm" variant="outline" disabled={installing !== null} onClick={() => onInstall(e)}>
            {installing === e.name ? <Spinner /> : <DownloadIcon />} Install
          </Button>
        </li>
      ))}
      <li>
        <button type="button" className={item} onClick={() => onPick(null)}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <GlobeIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Another MCP server</span>
            <span className="block text-xs text-muted-foreground">Any remote MCP server, by its address. On this computer or your network works too.</span>
          </span>
          <ArrowRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground" />
        </button>
      </li>
    </ul>
  );
}

function SetupPage({
  draft,
  set,
  taken,
  created,
  onCreated,
  onDropCreated,
  existing,
  onReuse,
}: {
  draft: ConnectionDraft;
  set: (p: Partial<ConnectionDraft>) => void;
  taken: string[];
  created: ConnectionView | null;
  onCreated: (c: ConnectionView) => void;
  onDropCreated: () => void;
  /** A connection of this preset with the same slug already exists: offer it instead of a failing duplicate. */
  existing: ConnectionView | null;
  onReuse: (c: ConnectionView) => void;
}) {
  const control = draftControl(draft);
  const slugIssue = draft.slug && !existing ? slugProblem(draft.slug, created ? taken.filter((s) => s !== created.slug) : taken) : null;
  const stepIssues = draft.preset ? inputProblems(draft.preset.setupSteps, draft.inputs) : {};
  const probed = needsProbe(draft);
  const ready = !probed || (!!draft.probe && control?.kind !== "private");
  const probeForm = <ProbeForm draft={draft} set={set} taken={taken} created={created} onCreated={onCreated} onDropCreated={onDropCreated} />;
  // A user-named server (T3 Code): the address field sits in the step that explains it.
  const inStep = !!draft.preset?.userServer && !!draft.preset.setupSteps.some((s) => s.id === "server");
  return (
    <FieldGroup>
      {existing && (
        <Alert variant="info">
          <PlugIcon />
          <AlertTitle>You already have {existing.name}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {draft.preset?.userServer
                ? `${existing.name} is this same server (${hostPort(existing.url ?? "")}). Reconnecting signs in anew and keeps its access settings. For another server, enter its address instead.`
                : "Use it again: reconnecting signs in anew and keeps its access settings. To add a second one, give it another short name below."}
            </p>
            <Button size="sm" onClick={() => onReuse(existing)}>
              Reconnect {existing.name}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {probed && !inStep && probeForm}

      {draft.preset?.setupSteps.length ? (
        <ol className="space-y-4">
          {draft.preset.setupSteps.map((s, i) => (
            <SetupStepItem
              key={s.id}
              n={i + 1}
              step={s}
              value={s.input ? (draft.inputs[s.input.key] ?? "") : ""}
              problem={s.input && draft.inputs[s.input.key] ? stepIssues[s.input.key] : undefined}
              onChange={(v) => s.input && set({ inputs: { ...draft.inputs, [s.input.key]: v } })}
            >
              {inStep && s.id === "server" ? probeForm : null}
              {s.check === "google_apis" && draft.preset ? <GoogleApiCheck presetId={draft.preset.id} account={(draft.inputs.google_account ?? "").trim()} /> : null}
            </SetupStepItem>
          ))}
        </ol>
      ) : null}

      {control?.kind === "header" && (
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <Field>
            <FieldLabel htmlFor="conn-header-name">Header</FieldLabel>
            <Input id="conn-header-name" autoComplete="off" className="font-mono" value={draft.headerName} onChange={(e) => set({ headerName: e.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="conn-header">API key or token</FieldLabel>
            <PasswordInput id="conn-header" autoComplete="off" value={draft.headerValue} onChange={(e) => set({ headerValue: e.target.value })} />
          </Field>
          <FieldDescription className="sm:col-span-2">
            Stored encrypted and sent with every request; agents never see it. For <code className="font-mono">Authorization</code>, a bare token gets “Bearer ” in
            front.
          </FieldDescription>
        </div>
      )}
      {control?.kind === "oauth" && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
          After the next page, a window opens to sign in{draft.preset ? ` to ${draft.preset.displayName}` : ""} and approve access.
        </p>
      )}

      {ready && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="conn-name">Name</FieldLabel>
            <Input id="conn-name" value={draft.name} maxLength={100} placeholder={defaultName(draft)} onChange={(e) => set(nameChange(draft, e.target.value))} />
          </Field>
          <Field>
            <FieldLabel htmlFor="conn-slug">Short name</FieldLabel>
            <Input
              id="conn-slug"
              value={draft.slug}
              maxLength={24}
              onChange={(e) => set({ slug: e.target.value.toLowerCase(), slugEdited: true })}
              aria-invalid={!!slugIssue}
              className="font-mono"
            />
            {slugIssue ? (
              <FieldError>{slugIssue}</FieldError>
            ) : (
              <FieldDescription>
                Agents see its tools as <code className="font-mono">{draft.slug || "name"}__search</code> and so on.
              </FieldDescription>
            )}
          </Field>
        </div>
      )}
    </FieldGroup>
  );
}

function ProbeForm({
  draft,
  set,
  taken,
  created,
  onCreated,
  onDropCreated,
}: {
  draft: ConnectionDraft;
  set: (p: Partial<ConnectionDraft>) => void;
  /** Slugs in use: the suggestion skips them (a second server on the same IP gets -2). */
  taken: readonly string[];
  created: ConnectionView | null;
  onCreated: (c: ConnectionView) => void;
  onDropCreated: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const probe = async (connectionId?: string, slug?: string) => {
    setPending(true);
    setError(undefined);
    try {
      const url = draftUrl(draft);
      const r = await api<ConnectionProbe>("/api/connections/probe", { body: { url, ...(connectionId ? { connectionId } : {}) } });
      set({ probe: r, slug: slug ?? (draft.slug || suggestDraftSlug(draft, taken)) });
    } catch (err) {
      setError(err);
      set({ probe: null });
    } finally {
      setPending(false);
    }
  };
  // The allow belongs to a connection: create it now (no sign-in yet), allow its exact origin, then look again.
  const allow = async () => {
    setPending(true);
    setError(undefined);
    try {
      const slug = draft.slug || suggestDraftSlug(draft, taken) || "local";
      // No grants until the user picks access (Connect sets them): nothing can reach an allowed private host before.
      const c = created ?? (await api<ConnectionView>("/api/connections", { body: { ...createInput({ ...draft, slug }), agentIds: [] } }));
      onCreated(await api<ConnectionView>(`/api/connections/${enc(c.id)}/private-target`, { method: "PUT", body: { allow: true } }));
      set({ createdId: c.id, privateAllowed: true, slug });
      setPending(false);
      await probe(c.id, slug);
    } catch (err) {
      setError(err);
      setPending(false);
    }
  };
  const p = draft.probe;
  const control = draftControl(draft);
  return (
    <div className="space-y-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.url.trim()) void probe(created?.id);
        }}
      >
        <Field>
          <FieldLabel htmlFor="conn-url">Server address</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="conn-url"
              inputMode="url"
              autoComplete="off"
              placeholder={draft.preset?.userServer ? "http://100.101.102.103:3773" : "https://mcp.example.com/mcp"}
              value={draft.url}
              disabled={!!created}
              // A user-named server's suggested slug follows its address (until typed by hand).
              onChange={(e) => set({ url: e.target.value, probe: null, ...(draft.preset?.userServer && !draft.slugEdited ? { slug: "" } : {}) })}
            />
            <Button type="submit" variant="outline" disabled={!draft.url.trim() || pending}>
              {pending ? <Spinner /> : <SearchIcon />} Check
            </Button>
          </div>
          {created ? (
            <FieldDescription>
              Allowed on your private network: {hostPort(draft.url)}.{" "}
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-4"
                onClick={() => {
                  onDropCreated();
                  set({ createdId: null, privateAllowed: false, probe: null });
                }}
              >
                Use another address
              </button>
            </FieldDescription>
          ) : (
            <FieldDescription>
              {draft.preset?.userServer
                ? `The address you open ${draft.preset.displayName} at. xaq adds ${draft.preset.userServer.defaultPath} and checks how it signs in.`
                : "The address you'd give an MCP client, usually ending in /mcp."}
            </FieldDescription>
          )}
        </Field>
      </form>
      {error !== undefined && <ErrorAlert error={error} />}
      {p && control?.kind !== "private" && (
        <Alert variant={p.reachable && !p.blocked ? "success" : "destructive"}>
          <ShieldCheckIcon />
          <AlertTitle>{p.reachable && !p.blocked ? "Found it" : "Couldn't use this address"}</AlertTitle>
          <AlertDescription>
            <p>{probeSummary(p)}</p>
          </AlertDescription>
        </Alert>
      )}
      {p && control?.kind === "private" && (
        <Alert variant="warning">
          <NetworkIcon />
          <AlertTitle>This is on your private network</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{probeSummary(p)}</p>
            <p>{privateExplanation(draft.url)}</p>
            <Button size="sm" disabled={pending} onClick={() => void allow()}>
              {pending && <Spinner />} Allow {hostPort(draft.url)}
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

const API_BADGE: Record<GoogleApiCheckView["state"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  enabled: { label: "on", variant: "secondary" },
  disabled: { label: "off", variant: "destructive" },
  unchecked: { label: "not checked yet", variant: "outline" },
  error: { label: "couldn't check", variant: "outline" },
};

/** A Google extension's "Check again": asks Google, as the picked account, whether each API is on in the project. */
function GoogleApiCheck({ presetId, account }: { presetId: string; account: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [checks, setChecks] = useState<GoogleApiCheckView[] | null>(null);
  const check = async () => {
    setPending(true);
    setError(undefined);
    try {
      setChecks(await api<GoogleApiCheckView[]>(`/api/connections/presets/${enc(presetId)}/google-apis`, { body: { account } }));
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  const summary = checks ? apiCheckSummary(checks) : null;
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" disabled={!account || pending} onClick={() => void check()} title={account ? undefined : "Pick the Google account first"}>
        {pending ? <Spinner /> : <SearchIcon />} Check again
      </Button>
      {error !== undefined && <ErrorAlert error={error} />}
      {checks && (
        <ul className="space-y-1">
          {checks.map((c) => (
            <li key={c.service} className="flex items-center gap-2">
              <Badge variant={API_BADGE[c.state].variant}>{API_BADGE[c.state].label}</Badge>
              <span>{c.label}</span>
              {c.state === "disabled" && <ExternalLink href={c.enableUrl}>Turn it on</ExternalLink>}
            </li>
          ))}
        </ul>
      )}
      {summary && <p className={summary.tone === "bad" ? "text-destructive" : "text-muted-foreground"}>{summary.text}</p>}
    </div>
  );
}

/** Renders `code` spans; the rest stays plain text. */
function StepBody({ text }: { text: string }) {
  return text.split(/(`[^`]+`)/).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={i} className="rounded bg-muted px-1 font-mono text-[0.85em]">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

/** One preset setup step, rendered generically: title, body, link, copy, input. */
function SetupStepItem({
  n,
  step,
  value,
  problem,
  onChange,
  children,
}: {
  n: number;
  step: SetupStepView;
  value: string;
  problem?: string;
  onChange: (v: string) => void;
  /** Extra controls under the step's text (a user-named server's address field). */
  children?: React.ReactNode;
}) {
  const id = `setup-${step.id}`;
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular" aria-hidden>
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2 text-sm">
        <div className="font-medium">{step.title}</div>
        {step.body && (
          <p className="text-muted-foreground">
            <StepBody text={step.body} />
          </p>
        )}
        {step.apis?.length ? (
          <ul className="space-y-1">
            {step.apis.map((a) => (
              <li key={a.service}>
                <ExternalLink href={a.url}>Enable the {a.label}</ExternalLink>
              </li>
            ))}
          </ul>
        ) : null}
        {children}
        {step.link && <ExternalLink href={step.link.url}>{step.link.label}</ExternalLink>}
        {step.copy && (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">{step.copy.label}</div>
            <CopyField value={step.copy.value} label={`Copy ${step.copy.label.toLowerCase()}`} />
          </div>
        )}
        {step.input && (
          <Field>
            <FieldLabel htmlFor={id}>{step.input.label}</FieldLabel>
            {step.input.choices ? (
              step.input.choices.length ? (
                <select
                  id={id}
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={value}
                  onChange={(e) => onChange(e.target.value)}
                  aria-invalid={!!problem}
                >
                  <option value="">Pick one…</option>
                  {step.input.choices.map((c) => (
                    <option key={c.value} value={c.value} disabled={c.disabled}>
                      {c.label}
                      {c.note ? ` (${c.note})` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <FieldDescription>None yet: add one with the link below.</FieldDescription>
              )
            ) : step.input.secret ? (
              <PasswordInput id={id} autoComplete="off" placeholder={step.input.placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!problem} />
            ) : (
              <Input id={id} autoComplete="off" placeholder={step.input.placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!problem} />
            )}
            {problem && <FieldError>{problem}</FieldError>}
          </Field>
        )}
      </div>
    </li>
  );
}

function AccessPage({ draft, set }: { draft: ConnectionDraft; set: (p: Partial<ConnectionDraft>) => void }) {
  return (
    <div className="space-y-5">
      <LevelChoice value={draft.level} onChange={(level) => set({ level })} />
      <AgentPicker value={draft.agents} onChange={(agents) => set({ agents })} />
    </div>
  );
}

/** The one access choice: Full / Ask before risky actions (the default) / Read only. */
export function LevelChoice({ value, onChange }: { value: AccessLevel; onChange: (v: AccessLevel) => void }) {
  return (
    <ChoiceCards
      aria-label="Access level"
      value={value}
      onChange={onChange}
      choices={ACCESS_LEVELS.map((l) => ({
        value: l,
        title: LEVEL_INFO[l].label,
        description: LEVEL_INFO[l].description,
        badge: l === "ask" ? <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">Recommended</span> : undefined,
      }))}
    />
  );
}

/** Which agents get the connection: all of them (the default) or some. */
function AgentPicker({ value, onChange }: { value: "all" | string[]; onChange: (v: "all" | string[]) => void }) {
  const agents = useQuery(queries.agents());
  const list = agents.data ?? [];
  const all = value === "all";
  const picked = all ? [] : value;
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">Which agents get it</legend>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={all} onCheckedChange={(c) => onChange(c ? "all" : list.map((a) => a.id))} />
        All agents
      </label>
      {!all && (
        <ul className="space-y-1.5 pl-6">
          {list.map((a) => (
            <li key={a.id}>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={picked.includes(a.id)} onCheckedChange={(c) => onChange(c ? [...picked, a.id] : picked.filter((x) => x !== a.id))} />
                {a.name}
              </label>
            </li>
          ))}
          {list.length === 0 && <li className="text-sm text-muted-foreground">No agents yet. You can give it to agents later on their pages.</li>}
        </ul>
      )}
    </fieldset>
  );
}
