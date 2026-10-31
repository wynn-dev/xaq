import type { Account, ConnectAccountResponse, ConnectAttempt, ExtraScopeName, OAuthCallbackMessage } from "@shared/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { CheckCircle2Icon, ExternalLinkIcon, InfoIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CopyField, ErrorAlert } from "@/components/common";
import { Disclosure, Path } from "@/components/setup/wizard-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError } from "@/lib/api";
import { keys, queries } from "@/lib/queries";
import { useStreamListener } from "@/lib/stream";
import { answerApplies, handsBack, offersMailOnly, type AttemptStatus, CHECK_NOTES, type CheckNote, checkAgainStep, listMatch, streamUpdateConcerns } from "./connect-attempt";
import { PasteCallback } from "./paste-callback";
import { GoogleErrorHelp } from "./google-error-help";

interface ConnectRequest {
  /** Reconnect an existing account (needs_reauth) instead of adding a new one. */
  reauthAccountId?: string;
  email?: string;
  /** Extra Google access to request incrementally: ["calendar"] for "Add Google Calendar". */
  scopes?: ExtraScopeName[];
  /**
   * Called once the account is connected (e.g. to retry what needed the extra access).
   * `confirmed`: Google's callback (or the pasted address) reported success. False when the user only
   * clicked "I'm done, check again", so the caller re-checks without assuming anything was granted.
   */
  onDone?: (confirmed: boolean) => void;
  /** Ask Google for mail only (no Calendar), e.g. when a Workspace admin blocks Calendar for this app. */
  mailOnly?: boolean;
  /** The caller shows the outcome itself ("Add Google Calendar"): close as soon as Google reports back, instead of a "connected" screen. */
  handBack?: boolean;
  /**
   * The dialog closed before the sign-in finished (given up on, or a failure). With handBack, a cancel or
   * unticked Calendar (handsBack) closes it at once and arrives here as `error`.
   */
  onCancel?: (error?: ApiError) => void;
}

type Phase =
  | { kind: "starting" }
  | { kind: "waiting"; res: ConnectAccountResponse; popup: Window | null; closed: boolean }
  | { kind: "done"; email: string }
  | { kind: "error"; error: unknown }
  | { kind: "not-configured" };

const isOAuthMessage = (d: unknown): d is Partial<OAuthCallbackMessage> & { type: "agentinbox:oauth" } =>
  !!d && typeof d === "object" && (d as { type?: unknown }).type === "agentinbox:oauth";

// The mounted host registers its starter here so any button can begin the flow synchronously
// inside its click handler (pop-up blockers only allow window.open during a user gesture).
let starter: ((req: ConnectRequest) => void) | null = null;

export function connectAccount(req: ConnectRequest = {}) {
  starter?.(req);
}

function openPopup(): Window | null {
  const w = 520;
  const h = 700;
  const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
  const popup = window.open("", "agentinbox-oauth", `popup,width=${w},height=${h},left=${left},top=${top}`);
  try {
    popup?.document.write(
      '<title>Connecting…</title><body style="font:14px system-ui;display:grid;place-items:center;height:90vh;color:#666">Opening Google sign-in…</body>',
    );
  } catch {
    /* ignore */
  }
  return popup;
}

export function ConnectAccountHost() {
  const qc = useQueryClient();
  const client = useQuery(queries.googleClient());
  // Calendar is part of this install (new installs): a new connection asks for it too.
  const calendarOn = useQuery({ ...queries.calendarSetup(), retry: false }).data?.enabled ?? false;
  const [phase, setPhase] = useState<Phase | null>(null);
  const phaseRef = useRef<Phase | null>(null);
  const [checkNote, setCheckNote] = useState<CheckNote | null>(null);
  const inWizard = useRouterState({ select: (st) => st.location.pathname === "/get-started" });
  const navigate = useNavigate();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [req, setReq] = useState<ConnectRequest>({});
  const known = useRef<Set<string>>(new Set());

  const reqRef = useRef<ConnectRequest>({});
  /** Reconnecting an account that was in needs_reauth: only then does "active again" prove the new sign-in landed. */
  const reauthFromBroken = useRef(false);
  const finish = (email: string, confirmed = true) => {
    const { onDone: done, handBack } = reqRef.current;
    reqRef.current = { ...reqRef.current, onDone: undefined, onCancel: undefined };
    if (done) setTimeout(() => done(confirmed), 0);
    setPhase((p) => {
      if (p?.kind === "waiting") p.popup?.close();
      return handBack ? null : { kind: "done", email };
    });
    void qc.invalidateQueries({ queryKey: keys.accounts });
    void qc.invalidateQueries({ queryKey: keys.setupState });
    void qc.invalidateQueries({ queryKey: keys.overview });
  };
  const finishRef = useRef(finish);
  const fail = (error: ApiError) => {
    const { handBack, onCancel } = reqRef.current;
    if (!handBack || !handsBack(error.code)) return setPhase({ kind: "error", error });
    reqRef.current = { ...reqRef.current, onDone: undefined, onCancel: undefined };
    if (onCancel) setTimeout(() => onCancel(error), 0);
    setPhase((p) => {
      if (p?.kind === "waiting") p.popup?.close();
      return null;
    });
  };
  const failRef = useRef(fail);
  // Only react to OAuth results while a connect flow is running in this tab.
  const activeRef = useRef(false);
  const redirectOrigin = useRef<string | null>(null);
  useEffect(() => {
    finishRef.current = finish;
    failRef.current = fail;
    phaseRef.current = phase;
    activeRef.current = phase?.kind === "starting" || phase?.kind === "waiting";
    try {
      redirectOrigin.current = client.data ? new URL(client.data.redirectUri).origin : null;
    } catch {
      redirectOrigin.current = null;
    }
  });

  const start = async (r: ConnectRequest) => {
    setCheckNote(null);
    setReq(r);
    reqRef.current = r;
    const cached = client.data;
    // Paste mode uses a plain link (the user needs a full address bar); otherwise open the pop-up now.
    const popup = cached?.callbackMode === "paste" ? null : openPopup();
    setPhase({ kind: "starting" });
    const view = cached ?? (await qc.fetchQuery(queries.googleClient()).catch(() => undefined));
    if (view && (!view.clientId || !view.hasSecret)) {
      popup?.close();
      setPhase({ kind: "not-configured" });
      return;
    }
    const accounts = qc.getQueryData<Account[]>(keys.accounts) ?? (await qc.fetchQuery(queries.accounts()).catch(() => []));
    known.current = new Set(accounts.map((a) => a.id));
    // For active, paused or erroring accounts a status change proves nothing (resume, a recovered sync…):
    // those reconnects finish only on the callback page's own result.
    reauthFromBroken.current = !!r.reauthAccountId && accounts.some((a) => a.id === r.reauthAccountId && a.status === "needs_reauth");
    try {
      const res = await api<ConnectAccountResponse>("/api/accounts/connect", {
        body: {
          ...(r.reauthAccountId ? { reauthAccountId: r.reauthAccountId } : {}),
          ...(r.scopes?.length ? { scopes: r.scopes } : {}),
          ...(r.mailOnly ? { mailOnly: true } : {}),
        },
      });
      if (popup && res.callbackMode === "direct") popup.location.href = res.authUrl;
      else popup?.close();
      setPhase({ kind: "waiting", res, popup: res.callbackMode === "direct" ? popup : null, closed: false });
    } catch (err) {
      popup?.close();
      setPhase({ kind: "error", error: err });
    }
  };

  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  });
  useEffect(() => {
    starter = (r) => void startRef.current(r);
    return () => {
      starter = null;
    };
  }, []);

  // The callback page posts back to its opener (direct mode), or via BroadcastChannel when the opener was severed.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!isOAuthMessage(e.data) || !activeRef.current) return;
      // window.postMessage carries an origin (BroadcastChannel is same-origin by construction).
      if (e.origin && e.origin !== window.location.origin && e.origin !== redirectOrigin.current) return;
      if (e.data.ok) finishRef.current(e.data.email ?? "Your account");
      else failRef.current(new ApiError(400, e.data.code ?? "oauth_error", e.data.error ?? "Google sign-in failed", e.data.hint ?? undefined));
    };
    window.addEventListener("message", onMessage);
    const channel = "BroadcastChannel" in window ? new BroadcastChannel("agentinbox-oauth") : undefined;
    if (channel) channel.onmessage = onMessage;
    return () => {
      window.removeEventListener("message", onMessage);
      channel?.close();
    };
  }, []);

  /**
   * Asks the server what became of this dialog's sign-in (its state). The callback page's message can miss
   * this tab: it posts only to the saved public URL's origin (the console may be open on another one, e.g.
   * localhost vs 127.0.0.1), BroadcastChannel is same-origin, and a reconnect of an account that was
   * already working changes nothing the account list would show.
   */
  const inflight = useRef<{ state: string; answer: Promise<AttemptStatus>; followUp?: Promise<AttemptStatus> } | null>(null);
  const askServer = (): Promise<AttemptStatus> => {
    const p = phaseRef.current;
    if (p?.kind !== "waiting") return Promise.resolve(null);
    const state = p.res.state;
    // One request at a time per attempt: focus, popup close and stream updates often arrive together.
    // A trigger during a request may mean news the request predates: ask exactly once more after it
    // (unless it already settled the attempt), so the dialog updates by itself.
    const busy = inflight.current;
    if (busy?.state === state) {
      busy.followUp ??= busy.answer.then((st) => (st === "connected" || st === "failed" ? st : askRef.current()));
      return busy.followUp;
    }
    const answer = (async (): Promise<AttemptStatus> => {
      let r: ConnectAttempt;
      try {
        r = await api<ConnectAttempt>("/api/accounts/connect/status", { body: { state } });
      } catch {
        return null;
      } finally {
        if (inflight.current?.state === state) inflight.current = null;
      }
      // Ignore an answer for an attempt this dialog has since left (closed, retried, finished).
      if (!answerApplies(phaseRef.current, state)) return r.status;
      if (r.status === "connected") finishRef.current(r.email);
      else if (r.status === "failed") failRef.current(new ApiError(400, r.code, r.error, r.hint ?? undefined));
      return r.status;
    })();
    inflight.current = { state, answer };
    return answer;
  };
  const askRef = useRef(askServer);
  useEffect(() => {
    askRef.current = askServer;
  });

  // Fallback signal: the server announces the new or repaired account on the live stream.
  useStreamListener((m) => {
    if (m.kind !== "account" || (phase?.kind !== "waiting" && phase?.kind !== "starting")) return;
    const a = m.data;
    const reauth = req.reauthAccountId;
    if (reauth ? reauthFromBroken.current && a.id === reauth && a.status === "active" : !known.current.has(a.id)) finish(a.email);
    // A reconnect of a working account (or of an address that's already here) looks like any other update.
    else if (streamUpdateConcerns(a.id, { reauthAccountId: reauth, known: known.current })) void askServer();
  });

  // Coming back to this tab after Google's window is a good moment to look.
  const waitingState = phase?.kind === "waiting" ? phase.res.state : null;
  useEffect(() => {
    if (!waitingState) return;
    const onFocus = () => void askRef.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waitingState]);

  // Notice when the popup goes away. Google's pages can sever window.opener, which also makes
  // `closed` read true early, so this only softens the message instead of failing the flow.
  const popup = phase?.kind === "waiting" ? phase.popup : null;
  useEffect(() => {
    if (!popup) return;
    const id = setInterval(() => {
      if (popup.closed) {
        clearInterval(id);
        setPhase((p) => (p?.kind === "waiting" ? { ...p, closed: true } : p));
        void askRef.current();
      }
    }, 600);
    return () => clearInterval(id);
  }, [popup]);

  const checkAgain = async () => {
    setCheckNote(null);
    // The server knows how this sign-in ended (connected or failed) whichever origin the callback page posted to.
    const before = phaseRef.current;
    if (before?.kind !== "waiting") return;
    const status = await askServer();
    if (!answerApplies(phaseRef.current, before.res.state)) return;
    const reauth = req.reauthAccountId;
    const step = checkAgainStep(status, { scopes: !!req.scopes?.length, reauth: !!reauth, reauthFromBroken: reauthFromBroken.current });
    if (step.kind === "stop") return;
    if (step.kind === "note") return setCheckNote(step.note);
    if (step.kind === "finish-unconfirmed") return finish(req.email ?? "Your account", false);
    // The server forgot the attempt (it expired, or xaq restarted): the account list may still show it.
    const state = before.res.state;
    try {
      const accounts = await qc.fetchQuery({ ...queries.accounts(), staleTime: 0 });
      if (!answerApplies(phaseRef.current, state)) return;
      const found = listMatch(accounts, { reauthAccountId: reauth, reauthFromBroken: reauthFromBroken.current, known: known.current });
      if (found) finish(found.email);
      else setCheckNote("expired");
    } catch {
      if (answerApplies(phaseRef.current, state)) setCheckNote("unreachable");
    }
  };

  const close = () => {
    if (phase?.kind === "waiting") phase.popup?.close();
    const cancelled = reqRef.current.onCancel;
    reqRef.current = { ...reqRef.current, onDone: undefined, onCancel: undefined };
    if (cancelled) setTimeout(cancelled, 0);
    setPhase(null);
  };

  const retry = () => void start(req);
  // A Workspace admin may block Calendar for unconfigured apps: Google then refuses the whole sign-in.
  // This one sign-in asks for mail only; Calendar stays on for the install (Settings can turn it off).
  const mailOnly = () => void start({ ...req, mailOnly: true });
  const reauthEmail = req.email;

  const calendar = !!req.scopes?.includes("calendar");
  const continueSetup = () => {
    close();
    void navigate({ to: "/get-started", search: { step: "agent" } });
  };

  // Put focus on the button that moves things forward whenever the dialog changes state (not on X).
  const kind = phase?.kind;
  useEffect(() => {
    if (kind === "done" || kind === "error" || kind === "not-configured") requestAnimationFrame(() => primaryRef.current?.focus());
  }, [kind]);

  const code = phase?.kind === "error" && phase.error instanceof ApiError ? phase.error.code : undefined;
  const calendarBlocked = offersMailOnly(code, req, calendarOn);
  const clientProblem = code === "oauth_invalid_client" || code === "oauth_unauthorized_client" || code === "oauth_redirect_uri_mismatch" || code === "google_client_missing";

  return (
    <Dialog open={!!phase} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {calendar
              ? `Add Google Calendar${req.email ? ` to ${req.email}` : ""}`
              : reauthEmail
                ? `Reconnect ${reauthEmail}`
                : "Connect a Google account"}
          </DialogTitle>
          <DialogDescription>
            {phase?.kind === "waiting" && phase.res.callbackMode === "paste"
              ? "Sign in with Google in a new tab, then paste back the address you land on."
              : calendar
                ? `Sign in as ${req.email ?? "the account"} (another account won't work). Gmail stays connected and keeps working while you do this.`
                : reauthEmail
                  ? `Sign in as ${reauthEmail} and allow access again.`
                  : calendarOn
                    ? "Sign in with Google and allow xaq to manage the mailbox and calendar."
                    : "Sign in with Google and allow xaq to manage the mailbox."}
          </DialogDescription>
        </DialogHeader>

        {phase?.kind === "starting" && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Spinner /> Preparing Google sign-in…
          </div>
        )}

        {phase?.kind === "not-configured" && (
          <Alert variant="warning">
            <InfoIcon />
            <AlertTitle>Set up the Google OAuth client first</AlertTitle>
            <AlertDescription>
              xaq signs in to Gmail through your own Google OAuth client. Import its JSON (step 4 of Get started), then come back here.
            </AlertDescription>
          </Alert>
        )}

        {phase?.kind === "error" && (
          <div className="space-y-3">
            <ErrorAlert
              error={phase.error}
              title={
                code === "oauth_access_denied"
                  ? "Sign-in was cancelled"
                  : code === "oauth_wrong_account"
                    ? "Signed in with a different Google account"
                    : calendar
                      ? "Couldn't add Google Calendar"
                      : "Couldn't connect the account"
              }
            />
            {calendarBlocked && (
              <p className="text-sm text-muted-foreground">
                If the admin blocks only Google Calendar, connect with mail only now and add Calendar once it's allowed.
              </p>
            )}
            {code === "oauth_redirect_uri_mismatch" && client.data && (
              <div className="space-y-1.5 text-sm">
                <p>Add this exact redirect URI to the OAuth client, save, wait a few minutes, then try again:</p>
                <CopyField value={client.data.redirectUri} label="Copy redirect URI" />
              </div>
            )}
          </div>
        )}

        {phase?.kind === "done" && (
          <div className="flex flex-col items-center gap-2 py-6 text-center" role="status">
            <CheckCircle2Icon className="size-10 text-success" />
            <div className="font-medium">{phase.email} is connected</div>
            <p className="text-sm text-muted-foreground">Mail starts syncing now.</p>
          </div>
        )}

        {phase?.kind === "waiting" && calendar && <CalendarConsentSteps email={req.email} external={client.data?.appType !== "internal"} />}

        {phase?.kind === "waiting" && phase.res.callbackMode === "direct" && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3 text-sm" role="status">
              {phase.popup && !phase.closed ? <Spinner className="mt-0.5" /> : <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
              <div className="space-y-1">
                <div className="font-medium">
                  {!phase.popup ? "Your browser blocked the sign-in window" : phase.closed ? "Closed the Google window?" : "Waiting for Google…"}
                </div>
                <p className="text-muted-foreground">
                  {!phase.popup
                    ? "Open it with the button below."
                    : phase.closed
                      ? "Open it again with the button below. If you finished signing in, this updates in a moment."
                      : "Finish signing in in the pop-up window. This updates on its own when you're done."}
                </p>
              </div>
            </div>
            {checkNote && (
              <p className="text-sm text-muted-foreground" role="status">
                {CHECK_NOTES[checkNote]}
              </p>
            )}
            <Disclosure summary="Sign-in ended on an error or a page that can't be reached? Paste its address">
              <PasteCallback res={phase.res} onConnected={finish} compact />
            </Disclosure>
            <GoogleErrorHelp />
          </div>
        )}

        {phase?.kind === "waiting" && phase.res.callbackMode === "paste" && <PasteCallback res={phase.res} onConnected={finish} />}

        <DialogFooter>
          {phase?.kind === "not-configured" && (
            <Button asChild onClick={close}>
              <Link to="/get-started" search={{ step: "client" }} ref={primaryRef as React.Ref<HTMLAnchorElement>}>
                Set up the OAuth client
              </Link>
            </Button>
          )}
          {phase?.kind === "error" && (
            <>
              {clientProblem && (
                <Button variant="outline" asChild onClick={close}>
                  <Link to="/get-started" search={{ step: "client" }}>
                    Check the OAuth client
                  </Link>
                </Button>
              )}
              {calendarBlocked && (
                <Button variant="outline" onClick={mailOnly}>
                  Connect with mail only
                </Button>
              )}
              <Button onClick={retry} ref={primaryRef}>
                <RotateCwIcon /> Try again
              </Button>
            </>
          )}
          {phase?.kind === "waiting" && phase.res.callbackMode === "direct" && (
            <>
              <Button variant="ghost" onClick={checkAgain}>
                I'm done, check again
              </Button>
              {checkNote === "expired" ? (
                // This attempt's link is likely dead: start a fresh one (new state) instead of reopening it.
                <Button onClick={retry}>
                  <ExternalLinkIcon /> Open Google sign-in again
                </Button>
              ) : (
                <Button variant={!phase.popup || phase.closed ? "default" : "outline"} asChild>
                  <a href={phase.res.authUrl} target="agentinbox-oauth" rel="opener">
                    <ExternalLinkIcon /> {!phase.popup ? "Open Google sign-in" : "Open Google sign-in again"}
                  </a>
                </Button>
              )}
            </>
          )}
          {phase?.kind === "done" && (
            <>
              {!reauthEmail && !req.scopes?.length && (
                <Button variant="outline" onClick={() => connectAccount()}>
                  Connect another
                </Button>
              )}
              {inWizard ? (
                <Button onClick={continueSetup} ref={primaryRef}>
                  Continue setup
                </Button>
              ) : (
                <Button onClick={close} ref={primaryRef}>
                  Done
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What Google's screen shows for the incremental Calendar consent (granular consent: a checkbox per permission). */
function CalendarConsentSteps({ email, external }: { email?: string; external: boolean }) {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
      <li>Choose {email ?? "the account"}.</li>
      {external && (
        <li>
          “Google hasn't verified this app”: expected for your own app. Click <Path items={["Advanced", "Go to xaq (unsafe)"]} />.
        </li>
      )}
      <li>
        Google lists only the new Calendar permissions (events, calendar list, free/busy), each with a checkbox. Tick all three, or{" "}
        <strong className="text-foreground">Select all</strong>, then <strong className="text-foreground">Continue</strong>.
      </li>
      <li>The window closes and this dialog shows the result. Unticking or cancelling changes nothing: mail keeps working.</li>
    </ol>
  );
}
