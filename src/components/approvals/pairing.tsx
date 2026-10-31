import type { AgentTool } from "@shared/agent-api";
import type { Account, Agent, ConnectionView, PairingRequest } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  CheckIcon,
  ClockIcon,
  GlobeIcon,
  KeyRoundIcon,
  LaptopIcon,
  MessageSquareQuoteIcon,
  SearchIcon,
  ShieldCheckIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AccountAvatar, AccountStatusBadge } from "@/components/accounts/account-status";
import { GrantFieldsForm } from "@/components/agents/grant-editor";
import { ErrorAlert, SectionLabel, StatusDot, TimeAgo, ToneBadge } from "@/components/common";
import { Visible } from "@/components/hidden-chars";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useNow } from "@/hooks/use-now";
import { AGENT_LEVELS, LEVEL_INFO } from "@/components/connections/connection-flow";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AgentLevel } from "@/lib/broker-dto";
import { api, ApiError, toastError } from "@/lib/api";
import { TOOL_LABEL } from "@/lib/cli";
import { fmtDuration } from "@/lib/format";
import { type GrantFields, grantInput } from "@/lib/grants";
import { keys, queries } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useSilencePairingToasts } from "@/components/pairing-notifier";
import { PAIRING_DEFAULT, pairingConnectionDefault } from "./pairing-grant";
import { deniedDescription } from "./pairing-link";

const toolLabel = (t: string | undefined) => (t && t in TOOL_LABEL ? TOOL_LABEL[t as AgentTool] : t) || null;

/** "jxgr xd93" → "JXGR-XD93". Codes are 8 characters from an alphabet without 0/O/1/I/L. */
export function normalizeCode(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

export function ExpiresIn({ at }: { at: string }) {
  const now = useNow(1000);
  const left = Date.parse(at) - now;
  if (left <= 0) return <span className="text-critical">Expired</span>;
  return <span className={cn("tabular", left < 120_000 && "font-medium text-warning")}>Expires in {fmtDuration(left)}</span>;
}

function ClientFacts({ p }: { p: PairingRequest }) {
  const tool = toolLabel(p.client.tool);
  const facts = [
    { icon: LaptopIcon, label: "Host", value: [p.client.hostname, p.client.platform].filter(Boolean).join(" · ") || null },
    { icon: TerminalIcon, label: "Tool", value: [tool, p.client.version && `CLI ${p.client.version}`].filter(Boolean).join(" · ") || null },
  ];
  const rows = [
    ...facts.map((f) => ({ ...f, node: f.value ? (
        <span className="font-mono text-[13px] break-all">
          <Visible text={f.value} />
        </span>
      ) : null })),
    {
      icon: GlobeIcon,
      label: "From",
      node: (
        <span className="text-[13px]">
          <span className="font-mono">{p.ip ?? "unknown address"}</span>
          <span className="text-muted-foreground">
            {" "}
            · requested <TimeAgo date={p.createdAt} />
          </span>
        </span>
      ),
    },
  ];
  return (
    <dl className="space-y-2 text-sm">
      {rows.map((f) => (
        <div key={f.label} className="flex items-baseline gap-3">
          <dt className="flex w-16 shrink-0 items-center gap-1.5 self-center text-muted-foreground">
            <f.icon className="size-3.5" /> {f.label}
          </dt>
          <dd className="min-w-0">{f.node ?? <span className="text-muted-foreground">not given</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

function AskedFor({ p, accounts }: { p: PairingRequest; accounts: Account[] }) {
  const r = p.requested;
  const known = new Set(accounts.map((a) => a.email.toLowerCase()));
  const rows: [string, React.ReactNode][] = [];
  if (r.accounts?.length)
    rows.push([
      "Accounts",
      r.accounts.map((e, i) => (
        <span key={e}>
          {i > 0 && ", "}
          {e}
          {!known.has(e.toLowerCase()) && <span className="text-muted-foreground"> (not connected)</span>}
        </span>
      )),
    ]);
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <SectionLabel>Asked for</SectionLabel>
      {rows.length ? (
        <dl className="grid grid-cols-[6.5rem_1fr] gap-y-1 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing specific. You decide what it gets.</p>
      )}
      {r.reason && (
        <div className="flex gap-2 border-t pt-2 text-sm">
          <MessageSquareQuoteIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="whitespace-pre-wrap break-words">
            <Visible text={r.reason} />
          </p>
        </div>
      )}
    </div>
  );
}

/** A pending pairing request: who is asking, from where, and for what. */
export function PairingCard({
  p,
  accounts,
  highlighted,
  onApprove,
}: {
  p: PairingRequest;
  accounts: Account[];
  /** "link": opened from a ?pairing= link; "found": looked up by code on this page. */
  highlighted?: "link" | "found";
  onApprove: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);

  const deny = async () => {
    setBusy(true);
    try {
      await api(`/api/pairings/${encodeURIComponent(p.id)}/deny`, { body: note.trim() ? { note: note.trim() } : {} });
      toast.success(`Denied ${p.name}`, { description: deniedDescription(note) });
      void qc.invalidateQueries({ queryKey: keys.pairings });
    } catch (err) {
      toastError(err, "Couldn't deny the request");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card ref={ref} className={cn("scroll-mt-24 transition-shadow", highlighted && "ring-2 ring-chart-1/60")}>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold break-words">
                <Visible text={p.name} />
              </span>
              <Badge variant="outline" className="font-normal text-muted-foreground">
                self-reported by the agent
              </Badge>
              {highlighted && <Badge className="bg-chart-1 font-normal text-white">{highlighted === "found" ? "Matches the code you entered" : "Opened from a link"}</Badge>}
            </div>
            {p.description && (
              <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
                <Visible text={p.description} />
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ClockIcon className="size-3.5" />
            <ExpiresIn at={p.expiresAt} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <ClientFacts p={p} />
        <AskedFor p={p} accounts={accounts} />
      </CardContent>
      {denying && (
        <CardContent className="pt-4">
          <Field>
            <FieldLabel htmlFor={`deny-${p.id}`}>Note for the agent (optional)</FieldLabel>
            <Textarea
              id={`deny-${p.id}`}
              autoFocus
              rows={2}
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Ask in #ops first, or use the shared triage agent."
            />
          </Field>
        </CardContent>
      )}
      <CardFooter className="flex-wrap justify-between gap-3 border-t">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <KeyRoundIcon className="size-3.5 shrink-0" />
          To approve, you'll type the code shown in the agent's terminal. If you didn't just run <code className="font-mono">connect</code> yourself,
          deny this request.
        </p>
        <div className="flex gap-2">
          {denying ? (
            <>
              <Button variant="ghost" onClick={() => setDenying(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void deny()} disabled={busy}>
                {busy ? <Spinner /> : <XIcon />} Deny request
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setDenying(true)}>
                <XIcon /> Deny
              </Button>
              <Button onClick={onApprove}>
                <ShieldCheckIcon /> Review and approve
              </Button>
            </>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}

/** Find a pending request by the code shown in the agent's terminal. */
/** Find a pending request by its code. Only highlights it: the code is typed again in the approve dialog. */
export function FindByCode({ pending, onFound }: { pending: PairingRequest[]; onFound: (p: PairingRequest) => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const c = normalizeCode(code);
    if (c.length < 9) return setError("Codes have 8 characters, like K7QM-2XPD.");
    const match = pending.find((p) => p.userCode === c);
    if (!match) return setError("No waiting request has this code. Codes last 10 minutes; if it expired, run connect again.");
    setError(null);
    setCode("");
    onFound(match);
  };
  return (
    <form onSubmit={submit} className="space-y-1.5">
      <label htmlFor="find-code" className="text-sm font-medium">
        Have a code from your agent's terminal?
      </label>
      <div className="flex max-w-md gap-2">
        <Input
          id="find-code"
          value={code}
          onChange={(e) => {
            setCode(normalizeCode(e.target.value));
            setError(null);
          }}
          placeholder="XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          className="font-mono tracking-widest uppercase"
          aria-invalid={!!error}
          aria-describedby="find-code-error"
        />
        <Button type="submit" variant="outline">
          <SearchIcon /> Find request
        </Button>
      </div>
      {error && (
        <p id="find-code-error" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

interface AccountChoice {
  on: boolean;
  fields: GrantFields;
}

const NEW_CHOICE: AccountChoice = { on: false, fields: PAIRING_DEFAULT };

/**
 * Approve a pairing: the human types the code from the agent's terminal (never pre-filled from the
 * link), names the agent, and builds its grants starting from read only.
 */
export function PairingApproveDialog({
  p,
  accounts,
  onOpenChange,
  onApproved,
}: {
  p: PairingRequest | null;
  accounts: Account[];
  onOpenChange: (open: boolean) => void;
  onApproved?: (agent: Agent) => void;
}) {
  const [approved, setApproved] = useState<{ agent: Agent; request: PairingRequest } | null>(null);
  const open = !!p || !!approved;
  const close = () => {
    setApproved(null);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl" onInteractOutside={(e) => e.preventDefault()}>
        {approved ? (
          <ApprovedState agent={approved.agent} onClose={close} />
        ) : p ? (
          <ApproveForm
            key={p.id}
            p={p}
            accounts={accounts}
            onApproved={(agent) => {
              setApproved({ agent, request: p });
              onApproved?.(agent);
            }}
            onCancel={close}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ApprovedState({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  return (
    <>
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-success/15 text-success">
          <CheckCircle2Icon className="size-6" />
        </span>
        <DialogTitle className="text-lg">{agent.name} is approved</DialogTitle>
        <DialogDescription className="max-w-md">
          The agent's terminal will receive its key automatically. The key is never shown here. If the terminal was closed, the key expires unused
          and the agent is removed.
        </DialogDescription>
      </div>
      <DialogFooter>
        <Button variant="outline" asChild>
          <Link to="/agents/$agentId" params={{ agentId: agent.id }} onClick={onClose}>
            Open agent
          </Link>
        </Button>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}

/** Why the code is typed rather than taken from the link, and when to deny. */
export function CodeWhy() {
  return (
    <>
      Typing it proves the request comes from a terminal you can see, so nobody can get access by sending you a link. If you didn't just run{" "}
      <code className="font-mono">connect</code> yourself, deny it.
    </>
  );
}

function ApproveForm({
  p,
  accounts,
  onApproved,
  onCancel,
  onDeny,
  denying,
  inline,
}: {
  p: PairingRequest;
  accounts: Account[];
  onApproved: (a: Agent) => void;
  onCancel?: () => void;
  /** Inline (in the setup wizard): no dialog chrome, and Deny instead of Cancel. */
  onDeny?: () => void;
  /** The Deny request is in flight. */
  denying?: boolean;
  inline?: boolean;
}) {
  const qc = useQueryClient();
  // Never pre-filled: the human types what the agent's terminal shows.
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (codeError) codeRef.current?.focus();
  }, [codeError]);
  const [name, setName] = useState(p.name);
  const usable = accounts.filter((a) => a.status !== "paused");
  const [choices, setChoices] = useState<Record<string, AccountChoice>>(() =>
    // Pre-select only when there's a single working account; never from what the agent asked for.
    Object.fromEntries(usable.map((a) => [a.id, { on: usable.filter((x) => x.status === "active").length === 1 && a.status === "active", fields: { ...PAIRING_DEFAULT } }])),
  );
  const [error, setError] = useState<unknown>(null);
  /** The request was decided or expired meanwhile: nothing left to approve. */
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  // MCP broker connections: every one is listed (the card's choices are all the agent gets). "All agents" ones
  // start at their default level, the rest at No access.
  const connectionsQuery = useQuery(queries.connections());
  const connections: ConnectionView[] = connectionsQuery.data ?? [];
  const [levels, setLevels] = useState<Record<string, AgentLevel>>({});
  const levelOf = (c: ConnectionView): AgentLevel => levels[c.id] ?? pairingConnectionDefault(c);
  const anyConnection = connections.some((c) => levelOf(c) !== "none");
  const selected = usable.filter((a) => choices[a.id]?.on);
  const problem = !selected.length && !anyConnection
    ? connections.length
      ? "Choose at least one account or connection."
      : "Choose at least one account."
    : selected.some((a) => typing[a.id])
      ? "Add or clear the recipient you're typing first."
      : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const typed = normalizeCode(code);
    if (typed.length < 9) return setCodeError("Type the full 8-character code from the agent's terminal.");
    if (typed !== p.userCode) {
      return setCodeError("That's not this request's code. If your terminal shows a different code, this request isn't from your agent: deny it.");
    }
    if (problem) return setError(new Error(problem));
    setBusy(true);
    setError(null);
    try {
      const agent = await api<Agent>(`/api/pairings/${encodeURIComponent(p.id)}/approve`, {
        body: {
          userCode: typed,
          name: name.trim() || p.name,
          grants: selected.map((a) => grantInput(a.id, choices[a.id]!.fields)),
          ...(connections.length ? { connections: connections.map((c) => ({ connectionId: c.id, level: levelOf(c) })) } : {}),
        },
      });
      for (const key of [keys.pairings, keys.agents, keys.setupState, keys.overview, keys.connections]) void qc.invalidateQueries({ queryKey: key });
      onApproved(agent);
    } catch (err) {
      if (err instanceof ApiError && err.code === "user_code_mismatch") setCodeError(err.message);
      else {
        setError(err);
        if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
          setGone(true);
          void qc.invalidateQueries({ queryKey: keys.pairings });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const Footer = inline ? "div" : DialogFooter;
  return (
    <form onSubmit={(e) => void submit(e)} className={inline ? "space-y-5" : "contents"} noValidate>
      {!inline && (
        <DialogHeader>
          <DialogTitle>Approve agent access</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">
              <Visible text={p.name} />
            </span>{" "}
            <span className="rounded border px-1 text-xs">self-reported</span> from <span className="font-mono">{p.ip ?? "an unknown address"}</span>{" "}
            wants access. Nothing is granted until you confirm the code. <ExpiresIn at={p.expiresAt} />.
          </DialogDescription>
        </DialogHeader>
      )}

      <Field data-invalid={!!codeError}>
        <FieldLabel htmlFor={`pairing-code-${p.id}`}>Code from your agent's terminal</FieldLabel>
        <Input
          id={`pairing-code-${p.id}`}
          ref={codeRef}
          autoFocus={!inline}
          autoComplete="off"
          spellCheck={false}
          value={code}
          onChange={(e) => {
            setCode(normalizeCode(e.target.value));
            setCodeError(null);
          }}
          placeholder="XXXX-XXXX"
          className="h-12 max-w-64 text-center font-mono text-2xl tracking-[0.2em] uppercase md:text-2xl"
          aria-invalid={!!codeError}
        />
        {codeError ? (
          <FieldError>{codeError}</FieldError>
        ) : (
          <FieldDescription>
            <CodeWhy />
          </FieldDescription>
        )}
      </Field>

      <Field>
        <FieldLabel htmlFor={`pairing-name-${p.id}`}>Agent name</FieldLabel>
        <Input id={`pairing-name-${p.id}`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>

      <AskedFor p={p} accounts={accounts} />
      <div className="space-y-2">
        <SectionLabel>What it gets</SectionLabel>
        {usable.length === 0 ? (
          connections.length ? (
            <p className="text-sm text-muted-foreground">No Gmail account is connected. That's fine: choose its connections below.</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No Gmail account is connected yet. <Link to="/accounts" className="font-medium text-foreground underline">Connect one</Link> first.
            </p>
          )
        ) : (
          usable.map((a) => {
            // An account that appeared after the form opened starts unticked.
            const c = choices[a.id] ?? NEW_CHOICE;
            const set = (patch: Partial<AccountChoice>) => setChoices((all) => ({ ...all, [a.id]: { ...(all[a.id] ?? NEW_CHOICE), ...patch } }));
            return (
              <div key={a.id} className={cn("rounded-lg border", c.on && "bg-card")}>
                <label className="flex cursor-pointer items-center gap-3 p-3">
                  <Checkbox checked={c.on} onCheckedChange={(v) => set({ on: v === true })} />
                  <AccountAvatar email={a.email} className="size-7" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{a.email}</span>
                  {a.status !== "active" && <AccountStatusBadge status={a.status} />}
                </label>
                {c.on && (
                  <div className="space-y-4 border-t p-3">
                    <GrantFieldsForm
                      idPrefix={`pair-${a.id}`}
                      accountId={a.id}
                      value={c.fields}
                      onChange={(patch) => set({ fields: { ...c.fields, ...patch } })}
                      onPendingChange={(v) => setTyping((t) => ({ ...t, [a.id]: v }))}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {connections.length > 0 && (
        <div className="space-y-2">
          <SectionLabel>Connections</SectionLabel>
          {connections.map((c) => (
            <div key={c.id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {c.name}
                  {c.status === "disabled" && <Badge variant="outline">Turned off</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">{LEVEL_INFO[levelOf(c)].description}</p>
              </div>
              <Select value={levelOf(c)} onValueChange={(v) => setLevels((all) => ({ ...all, [c.id]: v as AgentLevel }))}>
                <SelectTrigger className="w-full sm:w-60" aria-label={`Access to ${c.name}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGENT_LEVELS.map((l) => (
                    <SelectItem key={l} value={l}>
                      {LEVEL_INFO[l].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}

      {error != null && <ErrorAlert error={error} title="Couldn't approve" />}

      <Footer className={inline ? "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end" : undefined}>
        {onDeny ? (
          <Button type="button" variant="outline" onClick={onDeny} disabled={busy || denying}>
            {denying ? <Spinner /> : <XIcon />} Deny
          </Button>
        ) : (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {problem && !gone && <span className="mr-auto self-center text-xs text-muted-foreground">{problem}</span>}
        <Button type="submit" disabled={busy || denying || gone || !!problem} className={inline ? "h-auto min-h-9 whitespace-normal" : undefined}>
          {busy ? <Spinner /> : <CheckIcon />} Approve and send key to terminal
        </Button>
      </Footer>
    </form>
  );
}

const STATUS_TONE = { approved: "good", denied: "idle", expired: "idle", pending: "warn" } as const;

/** The last few decided requests, so "what happened to it?" has an answer. */
export function RecentPairings({ items }: { items: PairingRequest[] }) {
  const agents = useQuery(queries.agents());
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      <SectionLabel>Recent requests</SectionLabel>
      <Card className="gap-0 py-0">
        <ul className="divide-y">
          {items.map((p) => {
            const agentExists = p.agentId && agents.data?.some((a) => a.id === p.agentId);
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                <ToneBadge tone={STATUS_TONE[p.status]}>{p.status[0]!.toUpperCase() + p.status.slice(1)}</ToneBadge>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {agentExists ? (
                    <Link to="/agents/$agentId" params={{ agentId: p.agentId! }} className="hover:underline">
                      <Visible text={p.name} />
                    </Link>
                  ) : (
                    <Visible text={p.name} />
                  )}
                </span>
                {p.decisionNote && (
                  <span className="max-w-xs truncate text-muted-foreground">
                    “<Visible text={p.decisionNote} />”
                  </span>
                )}
                <span className="font-mono text-xs text-muted-foreground">{p.ip}</span>
                <TimeAgo date={p.decidedAt ?? p.expiresAt} className="text-xs text-muted-foreground" />
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

/**
 * Pending pairing requests with the approve form inline (setup wizard, Connect dialog), so the code
 * from the terminal can be typed right where the command was copied. A new request is announced
 * politely without moving focus (the user is usually in their terminal at that moment).
 */
export function PendingPairings({ onApproved, className }: { onApproved?: (agent: Agent) => void; className?: string }) {
  const pairings = useQuery({ ...queries.pairings("pending"), refetchInterval: 5000 });
  const accounts = useQuery(queries.accounts());
  const now = useNow(5000);
  const [approved, setApproved] = useState<Agent | null>(null);
  useSilencePairingToasts();
  const pending = (pairings.data ?? []).filter((p) => Date.parse(p.expiresAt) > now);

  return (
    <div className={cn("space-y-3", className)}>
      <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm">
        {approved && !pending.length ? (
          <>
            <CheckCircle2Icon className="size-4 text-success" />
            <span>
              {approved.name} is approved. Its key went to the terminal.{" "}
              <Link to="/agents/$agentId" params={{ agentId: approved.id }} className="font-medium underline underline-offset-4">
                Open agent
              </Link>
            </span>
          </>
        ) : pending.length ? (
          <>
            <StatusDot tone="warn" pulse />
            <span className="font-medium">{pending.length === 1 ? "A request is waiting for you" : `${pending.length} requests are waiting for you`}</span>
          </>
        ) : (
          <>
            <StatusDot tone="idle" pulse />
            <span className="text-muted-foreground">Waiting for a request. It shows up here as soon as you run the command.</span>
          </>
        )}
      </p>
      {/* The form's account choices are set up on mount, so wait for the accounts. */}
      {accounts.data &&
        pending.map((p) => (
          <PairingInline
            key={p.id}
            p={p}
            accounts={accounts.data}
            onApproved={(a) => {
              setApproved(a);
              onApproved?.(a);
            }}
          />
        ))}
    </div>
  );
}

function PairingInline({ p, accounts, onApproved }: { p: PairingRequest; accounts: Account[]; onApproved: (a: Agent) => void }) {
  const qc = useQueryClient();
  const [denying, setDenying] = useState(false);
  const deny = async () => {
    setDenying(true);
    try {
      await api(`/api/pairings/${encodeURIComponent(p.id)}/deny`, { body: {} });
      await qc.invalidateQueries({ queryKey: keys.pairings });
    } catch (err) {
      toastError(err, "Couldn't deny the request");
    } finally {
      setDenying(false);
    }
  };
  return (
    <section aria-labelledby={`pairing-${p.id}`} className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0 space-y-3">
          <h3 id={`pairing-${p.id}`} className="flex flex-wrap items-center gap-2 font-semibold break-words">
            <Visible text={p.name} />
            <Badge variant="outline" className="font-normal text-muted-foreground">
              self-reported by the agent
            </Badge>
          </h3>
          <ClientFacts p={p} />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ClockIcon className="size-3.5" />
          <ExpiresIn at={p.expiresAt} />
        </div>
      </div>
      <div className="p-4">
        <ApproveForm p={p} accounts={accounts} inline onApproved={onApproved} onDeny={() => void deny()} denying={denying} />
      </div>
    </section>
  );
}
