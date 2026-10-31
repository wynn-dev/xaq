import { existsSync } from "node:fs";
import { hostname } from "node:os";
import pc from "picocolors";
import type { WebhookPayload } from "../../shared/types.ts";
import { underService } from "../brand.ts";
import { ackEvents, ApiError, getSelf } from "./api.ts";
import { Dispatcher, type Job } from "./dispatcher.ts";
import { parsePayload, skipReason } from "./event.ts";
import { killAllRuns, runCommand } from "./exec.ts";
import { ensurePrivateDir } from "./fsutil.ts";
import { describeGrants, grantsKey, hasAccess } from "./grants.ts";
import { acquireBackfillLock, acquireListenerLock } from "./lock.ts";
import { createListenLogger, type ListenLogger } from "./logfile.ts";
import { claudeMcpConfigPath, writeClaudeMcpConfig } from "./mcpheader.ts";
import { describeFilter, type EffectiveConfig, LIMITS, type ListenFlags, resolveListen, THROWAWAY_SUFFIXES, throwawayConsumer, typesNotes } from "./options.ts";
import { logPath, oneOffLogPath } from "./paths.ts";
import { loadProfile, type Profile } from "./profile.ts";
import { isRecipe, SILENT_MARKER } from "./recipes.ts";
import { StatusWriter } from "./state.ts";
import { EventStream } from "./stream.ts";
import { checkTransport, insecureBanner } from "./transport.ts";
import { formatDuration, safeText } from "./ui.ts";
import { NPX, version } from "./version.ts";

/** Exit codes. 78 (EX_CONFIG) means "don't restart me": the service units are told not to. */
export const EXIT = { ok: 0, error: 1, revoked: 78 } as const;

export interface RunListenerOptions {
  flags: ListenFlags;
  /** Stops the listener (tests); the CLI uses SIGINT/SIGTERM. */
  signal?: AbortSignal;
  handleSignals?: boolean;
  log?: ListenLogger;
  /** Test knobs. */
  retryDelayMs?: (attempt: number) => number;
  stallMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  blockedRetryMs?: number;
  /** Time a service waits before exiting after revocation where the supervisor can't be told not to restart (launchd). */
  revokedExitDelayMs?: number;
  /** How often the agent's access (GET /me) is re-read, so the log shows grant changes. Default 5 min. */
  grantsRefreshMs?: number;
  /**
   * --backfill safety net: quiet time (nothing received, nothing running) after which the rest up to the
   * end is taken to be invisible to this listener (types filter, label scope, retention). Default 60 s.
   */
  backfillIdleMs?: number;
  /** --backfill gives up when the daemon stays unreachable this long. Default 10 min. */
  backfillUnreachableMs?: number;
}

/** Acknowledges the finished prefix, coalescing and retrying in the background. */
class Acker {
  private wanted = 0;
  acked = 0;
  private busy: Promise<void> | null = null;
  private retry: NodeJS.Timeout | null = null;
  constructor(
    private readonly post: (seq: number) => Promise<number>,
    private readonly log: ListenLogger,
  ) {}

  request(seq: number): void {
    this.wanted = Math.max(this.wanted, seq);
    this.kick();
  }

  private kick(): void {
    if (this.busy || this.retry || this.wanted <= this.acked) return;
    const seq = this.wanted;
    this.busy = this.post(seq)
      .then((acked) => {
        this.acked = Math.max(this.acked, acked, seq);
      })
      .catch((err: unknown) => {
        this.log.debug(`ack failed, retrying: ${err instanceof Error ? err.message : String(err)}`, { seq });
        this.retry = setTimeout(() => {
          this.retry = null;
          this.kick();
        }, 5000);
        this.retry.unref();
      })
      .finally(() => {
        this.busy = null;
        this.kick();
      });
  }

  /** Best-effort final ack on shutdown. */
  async flush(timeoutMs = 3000): Promise<void> {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.busy) await Promise.race([this.busy, new Promise((r) => setTimeout(r, 100))]);
      else if (this.wanted > this.acked) {
        this.kick();
        if (this.retry) break;
      } else return;
    }
  }
}

const describeEvent = (p: WebhookPayload) => {
  const m = p.data.message;
  const e = p.data.calendarEvent;
  const sender = m?.from?.email ?? (e && !e.organizerSelf ? e.organizer?.email : undefined);
  const who = sender ? ` from ${safeText(sender, 80)}` : "";
  const title = m?.subject ?? e?.summary;
  const subject = title ? ` "${safeText(title, 70)}"` : "";
  return `#${p.data.seq} ${p.type}${who}${subject}${e ? ` (${safeText(e.start, 30)})` : ""}`;
};

/** The last few non-empty lines of a command's output, for the log (sanitized: it may echo email content). */
const lastLines = (t: string, n = 3) =>
  t
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n)
    .map((l) => `  │ ${safeText(l, 300)}`)
    .join("\n");

/** The agent's whole reply was the triage prompt's "nothing to do" (anything more is shown). */
export const isSilent = (stdout: string) => stdout.trim() === SILENT_MARKER;

export async function runListener(opts: RunListenerOptions): Promise<number> {
  const profile: Profile = loadProfile();
  const { config } = resolveListen(profile, opts.flags);
  // Under launchd, stdout goes to a file nobody rotates; the rotated listen.log already has everything.
  const quietConsole = underService() && process.platform === "darwin";
  const backfill = !!opts.flags.backfill;
  const dryRun = !!opts.flags.dryRun;
  const oneOff = backfill || dryRun;
  const log = opts.log ?? createListenLogger({ path: oneOff ? oneOffLogPath() : logPath(), debug: process.env.XAQ_LOG_LEVEL === "debug", console: !quietConsole });

  const verdict = await checkTransport(profile.url, { insecure: config.insecure });
  if (verdict.warning) {
    process.stderr.write(`${insecureBanner(verdict.warning)}\n`);
    log.warn(verdict.warning);
  }

  if (!config.exec && !dryRun) {
    throw new Error(`Nothing to run for events. Pass --recipe claude-code or --exec "<command>", or --dry-run to just print matching events. See ${NPX} listen --help`);
  }
  if (config.exec && process.platform === "win32" && !dryRun) throw new Error("--exec needs a POSIX shell (/bin/sh) and isn't supported on Windows.");

  // One listener per machine (two would share the cursor and run every event twice). A backfill has
  // its own throwaway cursor and lock, so it runs next to the listener; a dry run changes nothing.
  const releaseLock = dryRun ? () => {} : backfill ? acquireBackfillLock() : acquireListenerLock();
  try {
    // The daemon creates a consumer's cursor on its first connection, at the head (or at the oldest event for
    // a backfill). Dry runs and backfills use their own throwaway consumers that are never advanced.
    const streamConsumer = backfill
      ? throwawayConsumer(config.consumer, THROWAWAY_SUFFIXES.backfill)
      : dryRun
        ? throwawayConsumer(config.consumer, THROWAWAY_SUFFIXES.dryRun)
        : config.consumer;
    let streamAfter = 0;
    if (dryRun && !backfill) {
      streamAfter = await getSelf(profile.url, profile.apiKey, 8000).then(
        (s) => s.headSeq ?? 0,
        () => 0,
      );
    }
    // --backfill = the mail from before this listener started: it ends where the listener's consumer
    // started on the daemon, so nothing the listener handles (or will handle) runs twice.
    const backfillHead = backfill ? await backfillEnd(profile, config.consumer, streamConsumer) : 0;

    ensurePrivateDir(config.cwd);
    // The Claude Code recipe loads this (keyless) MCP config; recreate it if it's missing.
    if (!existsSync(claudeMcpConfigPath())) writeClaudeMcpConfig(`${profile.url}/mcp`);
    if (!quietConsole) printBanner(log, profile, config, dryRun, backfill);
    // The default narrows what the listener gets without any flag: say so (also in the log file).
    const notes = typesNotes(config);
    for (const m of notes.info) log.info(m);
    for (const m of notes.warn) log.warn(m);
    if (backfill && backfillHead === 0) {
      log.info(`Nothing to backfill: the listener (consumer "${config.consumer}") started with the oldest stored mail, so it handles all of it.`);
      return EXIT.ok;
    }
    if (backfill) {
      log.info(
        `Backfill: handling the mail from before the listener started (events up to #${backfillHead}), oldest first, then exiting${dryRun ? " (dry run: nothing executed)" : ""}. Everything newer is the listener's.`,
      );
    } else if (dryRun) {
      log.info("Dry run: showing new events from now on.");
    }

    const status = new StatusWriter({
      pid: process.pid,
      url: profile.url,
      consumer: streamConsumer,
      version,
      startedAt: new Date().toISOString(),
      connected: false,
      connectedSince: null,
      lastDisconnect: null,
      lastEventAt: null,
      receivedSeq: 0,
      ackedSeq: 0,
      running: 0,
      recent: [],
      stoppedAt: null,
      exitReason: null,
      exec: config.exec,
      filters: describeFilter(config),
      skipped: 0,
    }, !oneOff);
    status.flush();

    // Re-checked before every reconnect and ack: a *.ts.net / *.localhost name could start resolving elsewhere.
    const transportOk = () =>
      checkTransport(profile.url, { insecure: config.insecure }).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message.split("\n")[0]! : String(err)),
      );

    // Who am I, and what may I do? Informational and not awaited: the stream itself decides whether the
    // key is valid. Re-read on reconnects and every few minutes, so a grant changed in the console shows up.
    let grantsSeen: string | null = null;
    let grantsBusy = false;
    const checkGrants = async () => {
      if (grantsBusy || (await transportOk())) return;
      grantsBusy = true;
      try {
        const self = await getSelf(profile.url, profile.apiKey, 8000);
        const key = grantsKey(self.grants, self.connections);
        if (key === grantsSeen) return;
        const first = grantsSeen === null;
        grantsSeen = key;
        const lines = describeGrants(self.grants, self.connections).map((l) => `  ${hasAccess(self) ? l : pc.yellow(l)}`);
        log.info(`${first ? `Signed in as agent "${safeText(self.name)}". Access` : "Access changed in the console. Now"}:\n${lines.join("\n")}`);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return; // The stream reports it.
        log.debug(`identity check failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        grantsBusy = false;
      }
    };
    void checkGrants();
    const grantsTimer = setInterval(() => void checkGrants(), opts.grantsRefreshMs ?? 5 * 60_000);
    grantsTimer.unref();
    const acker = new Acker(async (seq) => {
      const refused = await transportOk();
      if (refused) throw new Error(refused);
      const acked = (await ackEvents(profile.url, profile.apiKey, config.consumer, seq)).ackedSeq;
      // Shown by `listen status` only once the server has confirmed it.
      status.update({ ackedSeq: acked });
      return acked;
    }, log);
    const timeoutMs = LIMITS.timeoutSeconds * 1000;

    const runJob = async (job: Job, signal: AbortSignal): Promise<string | null> => {
      const tag = `#${job.seq}`;
      const r = await runCommand(config.exec!, job.payload, { timeoutMs, signal, cwd: config.cwd });
      const meta = { seq: job.seq, id: job.payload.data.id, attempt: job.attempts, exitCode: r.exitCode, signal: r.signal, durationMs: r.durationMs, stdoutTail: r.stdoutTail, stderrTail: r.stderrTail };
      if (signal.aborted) {
        log.debug(`${tag} command stopped by shutdown`, meta);
        return "stopped";
      }
      if (!r.ok) {
        const tail = lastLines(r.stderrTail) || lastLines(r.stdoutTail);
        log.warn(`${tag} command failed (attempt ${job.attempts}/${LIMITS.maxAttempts}): ${r.error}${tail ? `\n${tail}` : ""}`, meta);
        return `command: ${r.error}`;
      }
      log.debug(`${tag} command finished in ${formatDuration(r.durationMs)}`, meta);
      // What the agent said goes to the log (and the foreground console): the triage's only output channel.
      if (isSilent(r.stdoutTail)) log.info(pc.gray(`  ${tag}: nothing to do`));
      else if (!r.stdoutTail.trim()) log.info(pc.gray(`  ${tag}: no output`));
      else log.info(`  ${tag} output:\n${lastLines(r.stdoutTail, 6)}`);
      return null;
    };

    const dispatcher = new Dispatcher({
      concurrency: LIMITS.concurrency,
      maxAttempts: LIMITS.maxAttempts,
      retryDelayMs: opts.retryDelayMs,
      run: runJob,
      onAdvance: (seq) => {
        // Dry runs and backfills never move a server cursor.
        if (dryRun || backfill) return;
        acker.request(seq);
      },
      onRetry: (job, delay) => {
        log.info(`${describeEvent(job.payload)}: retrying in ${formatDuration(delay)}`);
        status.addRecent({ seq: job.seq, id: job.payload.data.id, type: job.payload.type, outcome: "retrying", attempts: job.attempts, at: new Date().toISOString(), error: job.lastError });
      },
      onFailed: (job) => {
        failed++;
        log.error(`${describeEvent(job.payload)}: gave up after ${job.attempts} attempts (${job.lastError}).`, { seq: job.seq, id: job.payload.data.id });
      },
      onFinished: (job) => {
        if (job.outcome === "succeeded") {
          handled++;
          log.info(`${pc.green("✓")} ${describeEvent(job.payload)} ${pc.gray(`(${formatDuration(Date.now() - job.firstSeenAt)})`)}`, { seq: job.seq, id: job.payload.data.id, attempts: job.attempts });
        }
        status.addRecent({ seq: job.seq, id: job.payload.data.id, type: job.payload.type, outcome: job.outcome === "failed" ? "failed" : "succeeded", attempts: job.attempts, at: new Date().toISOString(), error: job.lastError });
        status.update({ running: dispatcher.inFlight });
      },
    });

    let downSince: number | null = null;
    let connectedNow = false;
    /** --backfill: last time something arrived or ran; and whether an event past the end was seen. */
    let lastActivity = Date.now();
    let pastHead = false;
    /** Reversible refusal currently in effect (logged once per change). */
    let blocked: string | null = null;
    const stream = new EventStream({
      url: profile.url,
      apiKey: profile.apiKey,
      consumer: streamConsumer,
      after: streamAfter,
      types: config.types,
      includeBody: config.includeBody,
      lastEventId: () => dispatcher.lastSeq,
      stallMs: opts.stallMs,
      beforeConnect: transportOk,
      fromStart: backfill,
      blockedRetryMs: opts.blockedRetryMs,
      onBlocked: (code, text) => {
        downSince ??= Date.now();
        if (blocked !== code) log.warn(`${pc.yellow("⏸")} ${text}`, { code });
        blocked = code;
        status.update({ connected: false, lastDisconnect: { at: new Date().toISOString(), reason: text } });
      },
      minBackoffMs: opts.minBackoffMs,
      maxBackoffMs: opts.maxBackoffMs,
      shouldPause: () => dispatcher.backlog >= 200,
      onOpen: () => {
        const after = downSince ? ` after ${formatDuration(Date.now() - downSince)}` : "";
        if (blocked) log.info("Access restored.");
        // A grant may have changed while we were away (or blocked).
        if (blocked || downSince) void checkGrants();
        blocked = null;
        connectedNow = true;
        lastActivity = Date.now();
        log.info(`${pc.green("●")} Connected${after}. ${backfill ? "Receiving stored events…" : "Waiting for events…"}`);
        downSince = null;
        status.update({ connected: true, connectedSince: new Date().toISOString() });
      },
      onDisconnect: (reason, retryInMs, { serious }) => {
        downSince ??= Date.now();
        connectedNow = false;
        const msg = `${pc.yellow("○")} Disconnected: ${reason}. Reconnecting${retryInMs ? ` in ${formatDuration(retryInMs)}` : ""}…`;
        if (serious) log.warn(msg);
        else log.info(msg);
        status.update({ connected: false, lastDisconnect: { at: new Date().toISOString(), reason } });
      },
      onMessage: (m) => {
        if (m.event !== "mail") {
          log.debug(`ignoring unknown stream event "${m.event}"`);
          return;
        }
        let payload: WebhookPayload;
        try {
          payload = parsePayload(m.data);
        } catch (err) {
          log.warn(`Ignoring a malformed event from the stream: ${(err as Error).message}`, { id: m.id });
          return;
        }
        if (backfill && payload.data.seq > backfillHead) {
          // Newer than the backfill's end: the listener handles it. Stop receiving.
          pastHead = true;
          return;
        }
        lastActivity = Date.now();
        const skip = skipReason(payload, config);
        const match = skip === null;
        if (dryRun && match) {
          log.info(`${pc.cyan("→")} ${describeEvent(payload)} ${pc.gray("(dry run: nothing executed, cursor not advanced)")}`);
        } else if (match) {
          log.info(`${pc.cyan("→")} ${describeEvent(payload)}`, { seq: payload.data.seq, id: payload.data.id, type: payload.type });
        } else {
          // Dry runs show what the filters skip, to check them; a real listener keeps that in the debug log.
          const line = `skip ${describeEvent(payload)} (${safeText(skip, 120)})`;
          if (dryRun) log.info(pc.gray(`  ${line}`));
          else log.debug(line, { seq: payload.data.seq, id: payload.data.id });
          if (dispatcher.lastSeq < payload.data.seq) status.update({ skipped: (status.status.skipped ?? 0) + 1 });
        }
        const accepted = dispatcher.push(payload, { skip: !match || dryRun });
        if (!accepted) log.debug(`duplicate #${payload.data.seq} ignored`);
        status.update({ receivedSeq: dispatcher.lastSeq, lastEventAt: new Date().toISOString(), running: dispatcher.inFlight });
      },
    });

    let stopReason: string | null = null;
    const stop = (why: string) => {
      if (stopReason) return;
      stopReason = why;
      stream.stop();
    };
    // An abort that came while we were starting up (before this listener existed) still stops us.
    if (opts.signal?.aborted) stop("stopped");
    else opts.signal?.addEventListener("abort", () => stop("stopped"), { once: true });
    const onSignal = (sig: NodeJS.Signals) => {
      if (stopReason) {
        log.warn("Exiting now.");
        killAllRuns();
        process.exit(130);
      }
      log.info(`${sig === "SIGINT" ? "\n" : ""}Stopping (${sig}). Unfinished events will be delivered again next time. Press Ctrl-C again to force.`);
      stop(sig);
    };
    if (opts.handleSignals) {
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    }

    // --backfill ends once it has reached its end seq (an event at or past it arrived) and everything
    // finished. Safety net: a long quiet spell means the rest isn't visible to this listener. It gives
    // up if the daemon stays unreachable.
    let handled = 0;
    let failed = 0;
    let backfillTimer: NodeJS.Timeout | null = null;
    if (backfill) {
      const idleMs = opts.backfillIdleMs ?? 60_000;
      const unreachableMs = opts.backfillUnreachableMs ?? 10 * 60_000;
      backfillTimer = setInterval(() => {
        const now = Date.now();
        if (!connectedNow) {
          if (downSince !== null && now - downSince >= unreachableMs) stop("backfill unreachable");
          return;
        }
        if (dispatcher.inFlight > 0) {
          lastActivity = now;
          return;
        }
        if (pastHead || dispatcher.lastSeq >= backfillHead) stop("backfill complete");
        else if (now - lastActivity >= idleMs) {
          log.info(`No more stored events arrived for ${formatDuration(idleMs)}; the rest up to #${backfillHead} aren't visible to this listener (event types, label scope, or removed by retention).`);
          stop("backfill complete");
        }
      }, 100);
    }

    const end = await stream.run();
    if (backfillTimer) clearInterval(backfillTimer);
    clearInterval(grantsTimer);
    await dispatcher.stop();
    if (!dryRun) await acker.flush();
    if (opts.handleSignals) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }

    if (end.kind === "revoked") return revokedExit(log, status, profile, end.reason, opts);
    if (end.kind === "fatal") {
      log.error(`The daemon rejected the stream request: ${end.reason}`);
      status.update({ connected: false, stoppedAt: new Date().toISOString(), exitReason: end.reason });
      status.flush();
      return EXIT.revoked;
    }
    status.update({ connected: false, stoppedAt: new Date().toISOString(), exitReason: stopReason ?? "stopped" });
    status.flush();
    if (backfill && stopReason === "backfill unreachable") {
      log.error(
        `Gave up: the daemon was unreachable for ${formatDuration(opts.backfillUnreachableMs ?? 10 * 60_000)}. ${handled} event${handled === 1 ? "" : "s"} handled so far; run the backfill again later (it starts over from the oldest event, so handlers should dedupe on the event id).`,
      );
      return EXIT.error;
    }
    if (backfill && stopReason === "backfill complete") {
      log.info(`${failed ? pc.yellow("Backfill done") : `${pc.green("✔")} Backfill done`}: ${handled} event${handled === 1 ? "" : "s"} handled${failed ? `, ${failed} failed (see the log above)` : ""}.`);
      return failed ? EXIT.error : EXIT.ok;
    }
    log.info("Stopped.");
    return EXIT.ok;
  } finally {
    releaseLock();
  }
}

async function revokedExit(log: ListenLogger, status: StatusWriter, profile: Profile, reason: string, opts: RunListenerOptions): Promise<number> {
  log.error(
    `Access revoked: ${safeText(reason, 300)}\n` +
      `This key won't work again. Pair again with: ${NPX} connect ${profile.url} --force\n` +
      `(your listener settings are kept; restart the listener or its service afterwards)`,
  );
  status.update({ connected: false, stoppedAt: new Date().toISOString(), exitReason: `revoked: ${safeText(reason, 300)}` });
  status.flush();
  // launchd can't be told "don't restart on this exit code": wait a long time first so it doesn't spin.
  if (underService() && process.platform === "darwin") {
    await new Promise((r) => setTimeout(r, opts.revokedExitDelayMs ?? 15 * 60_000));
  }
  return EXIT.revoked;
}

/**
 * Where `--backfill` ends: the seq the listener's consumer started at on the daemon (recorded when the
 * consumer was created). Refuses when that can't be known, rather than replaying mail the listener already handled.
 */
async function backfillEnd(profile: Profile, consumer: string, replay: string): Promise<number> {
  let self;
  try {
    self = await getSelf(profile.url, profile.apiKey, 8000);
  } catch (err) {
    throw new Error(`Couldn't ask the daemon where the listener started: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  // The replay cursor must still be at 0 (it is never acknowledged): one that moved would skip the start of the range.
  const replayCursor = self.consumers?.find((c) => c.consumer === replay);
  if (replayCursor && replayCursor.ackedSeq > 0) {
    throw new Error(`The backfill cursor "${replay}" on the daemon has been moved to #${replayCursor.ackedSeq} (something acknowledged it), so a backfill would skip the oldest mail. Remove that consumer in the console, then try again.`);
  }
  const mine = self.consumers?.find((c) => c.consumer === consumer);
  if (!mine) {
    throw new Error(`The listener (consumer "${consumer}") hasn't connected yet, so no mail predates it. Start it first (\`${NPX} listen\`); a backfill then handles the mail from before it.`);
  }
  if (mine.startSeq == null) throw new Error(`The daemon doesn't know where consumer "${consumer}" started (it was created by an older xaq), so a backfill could re-run mail the listener already handled.`);
  return mine.startSeq;
}

/** Where the agent's output ends up, said plainly at start (and in `listen status`). */
export function outputLine(exec: string | null, log: string): string {
  if (!exec) return "nothing runs";
  return isRecipe(exec)
    ? `Claude Code's reply only goes to the listener's log (${log}, and the console when run in the foreground); it can't notify you by itself`
    : `your command's last output lines go to the listener's log (${log}, and the console when run in the foreground)`;
}

function printBanner(log: ListenLogger, profile: Profile, c: EffectiveConfig, dryRun: boolean, backfill: boolean): void {
  const logFile = backfill || dryRun ? oneOffLogPath() : logPath();
  const lines = [
    `${pc.bold("xaq listen")} ${pc.gray(`v${version}`)} · agent ${pc.cyan(safeText(profile.agentName))}`,
    `  daemon    ${profile.url}  ${pc.gray(`(consumer ${c.consumer} on ${hostname()})`)}`,
  ];
  if (dryRun) lines.push(`  mode      ${pc.yellow("dry run")}: matching events are printed; nothing runs and the cursor is not advanced`);
  if (backfill) lines.push(`  mode      ${pc.yellow("backfill")}: mail from before the listener started, then exit (own cursor; the listener is not affected)`);
  if (c.exec) lines.push(`  exec      ${safeText(c.exec, 300)}`, `  cwd       ${c.cwd} ${pc.gray("(private)")}`);
  lines.push(`  events    ${describeFilter(c)}${c.includeBody ? " · with bodies" : ""}`);
  lines.push(`  output    ${outputLine(c.exec, logFile)}`);
  lines.push(pc.gray(`  log       ${logFile}`));
  for (const l of lines) process.stdout.write(`${l}\n`);
  log.debug("listener starting", { url: profile.url, consumer: c.consumer, exec: c.exec, types: c.types });
}
