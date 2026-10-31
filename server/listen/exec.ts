import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebhookPayload } from "../../shared/types.ts";
import { commandInput, eventEnv } from "./event.ts";

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  error: string | null;
}

const TAIL = 4000;
const KILL_GRACE_MS = 5000;

class Tail {
  private buf = "";
  push(chunk: Buffer): void {
    this.buf = (this.buf + chunk.toString("utf8")).slice(-TAIL);
  }
  toString(): string {
    return this.buf;
  }
}

/**
 * The child's environment: ours minus anything xaq-specific (XAQ_*: service flags, a master key that happened
 * to be exported…), plus the safe event ids and the event file path.
 */
export function childEnv(payload: WebhookPayload, eventFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("XAQ_")) env[k] = v;
  return { ...env, ...eventEnv(payload), XAQ_EVENT_FILE: eventFile };
}

/** stdin for one event: { notice, event }. */
export const commandStdin = (payload: WebhookPayload): string => JSON.stringify(commandInput(payload), null, 2) + "\n";

/** Running commands, so a forced exit (second Ctrl-C) can still kill their process groups and remove temp files. */
const active = new Map<number, string>();

/** Synchronous last-resort cleanup before process.exit. */
export function killAllRuns(): void {
  for (const [pid, dir] of active) {
    killGroup(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
  active.clear();
}

function groupAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    // Negative pid: the whole process group (the child is its leader thanks to `detached`).
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Runs the configured command for one event. The command string is fixed configuration and goes to
 * `/bin/sh -c` verbatim; it is never built from event data. The event reaches
 * the command only as JSON on stdin, as a 0600 file named by XAQ_EVENT_FILE, and as a few
 * validated ids in env. On timeout the whole process group gets SIGTERM, then SIGKILL after a grace period.
 */
export function runCommand(command: string, payload: WebhookPayload, opts: { timeoutMs: number; cwd?: string; signal?: AbortSignal }): Promise<CommandResult> {
  const started = performance.now();
  const input = commandStdin(payload);
  // mkdtemp creates the directory 0700; the file inside is 0600 on top.
  const dir = mkdtempSync(join(tmpdir(), "xaq-event-"));
  const eventFile = join(dir, "event.json");
  writeFileSync(eventFile, input, { mode: 0o600, flag: "wx" });

  return new Promise<CommandResult>((resolve) => {
    const stdout = new Tail();
    const stderr = new Tail();
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      env: childEnv(payload, eventFile),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    if (child.pid) active.set(child.pid, dir);

    let terminatedAt: number | null = null;

    const finish = (r: Omit<CommandResult, "durationMs" | "stdoutTail" | "stderrTail" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      void (async () => {
        if (terminatedAt !== null) {
          // sh is gone, but what it started may not be: wait out the grace period for the group to
          // exit on SIGTERM, then SIGKILL whatever is left.
          while (groupAlive(child.pid) && Date.now() - terminatedAt < KILL_GRACE_MS) await new Promise((res) => setTimeout(res, 100));
          killGroup(child.pid, "SIGKILL");
        }
        if (child.pid) active.delete(child.pid);
        // Background processes that inherited the pipes must not keep us waiting.
        await new Promise((res) => setTimeout(res, 50));
        child.stdout?.destroy();
        child.stderr?.destroy();
        rmSync(dir, { recursive: true, force: true });
        resolve({ ...r, ok: r.ok && !timedOut, timedOut, durationMs: Math.round(performance.now() - started), stdoutTail: stdout.toString(), stderrTail: stderr.toString() });
      })();
    };

    const terminate = () => {
      if (terminatedAt !== null) return;
      terminatedAt = Date.now();
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);
    const onAbort = () => terminate();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    // A command that doesn't read stdin closes the pipe early: that's fine.
    child.stdin.on("error", () => {});
    child.stdin.end(input);

    child.on("error", (err) => finish({ ok: false, exitCode: null, signal: null, error: `Could not start /bin/sh: ${err.message}` }));
    child.on("exit", (code, signal) => {
      const error = timedOut
        ? `Timed out after ${Math.round(opts.timeoutMs / 1000)} s; the process group was killed`
        : signal
          ? `Killed by ${signal}`
          : code !== 0
            ? `Exited with code ${code}`
            : null;
      finish({ ok: code === 0 && !signal, exitCode: code, signal: signal ?? null, error });
    });
  });
}
