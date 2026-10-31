// `xaq smoke google-workspace --scratch`: run on xaq's machine, through the daemon's admin API over the local admin
// channel (server/connections-cli/admin.ts) and /mcp as a temporary agent. See run.ts for what it does.

import type { Command } from "commander";
import { resolveDataDir } from "../config.ts";
import { NPX } from "../listen/version.ts";
import type { SmokeFlags } from "./run.ts";

const GROUP = "MCP connections (on xaq's machine):";

/**
 * A line printer that can't kill the run: once the stream fails (EIO or EPIPE from a terminal that went away, e.g.
 * after SIGHUP), later lines are dropped instead of throwing or crashing on an unhandled 'error'.
 */
export function safeWriter(stream: NodeJS.WritableStream): { print: (line?: string) => void; dispose: () => void } {
  let dead = false;
  const onError = () => {
    dead = true;
  };
  stream.on("error", onError);
  return {
    print(line = "") {
      if (dead) return;
      try {
        stream.write(`${line}\n`, (err) => {
          if (err) dead = true;
        });
      } catch {
        dead = true;
      }
    },
    dispose: () => stream.removeListener("error", onError),
  };
}

export interface SmokeSignalOptions {
  print: (line: string) => void;
  exit: (code: number) => void;
  /** The second Ctrl-C: the quick part of cleanup (agent, attachmentDirs), bounded. */
  fastCleanup: () => Promise<void>;
  /** What may still be there, in a sentence. */
  leftovers: () => string;
  /** Upper bound on the second Ctrl-C's cleanup before quitting anyway (default 8 s). */
  quitWithinMs?: number;
}

/**
 * Signals during a run. SIGTERM and SIGHUP (a closed terminal, a stopped service) always act like the first Ctrl-C:
 * no new step starts and the run's full cleanup runs. The first Ctrl-C does the same; a second one runs the quick
 * cleanup (delete the agent, restore attachmentDirs) with a short timeout, says what may be left and quits.
 * Returns the remover.
 */
export function installSmokeSignals(controller: AbortController, opts: SmokeSignalOptions): () => void {
  let interrupts = 0;
  let quitting = false;
  const stop = (why: string) => {
    if (controller.signal.aborted) return;
    opts.print(`\n${why}: stopping after the current call, then cleaning up.${why === "Ctrl-C" ? " Press Ctrl-C again to quit sooner (only the agent and attachmentDirs are cleaned up then)." : ""}`);
    controller.abort();
  };
  const onInt = () => {
    interrupts++;
    if (interrupts === 1) return stop("Ctrl-C");
    if (quitting) return;
    quitting = true;
    opts.print("\nQuitting: deleting the temporary agent and restoring attachmentDirs first…");
    const deadline = new Promise<void>((r) => setTimeout(r, opts.quitWithinMs ?? 8000).unref?.());
    void Promise.race([opts.fastCleanup().catch(() => {}), deadline]).then(() => {
      opts.print(`Quit before the cleanup finished. ${opts.leftovers()}`);
      opts.exit(130);
    });
  };
  const onTerm = () => stop("SIGTERM");
  const onHup = () => stop("SIGHUP");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);
  return () => {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGHUP", onHup);
  };
}

export function registerSmokeCommands(program: Command): void {
  const smoke = program
    .command("smoke")
    .description("live end-to-end checks against the connected accounts, safe by construction")
    .summary("live end-to-end check of a connection")
    .helpGroup(GROUP);

  smoke
    .command("google-workspace")
    .description("check Gmail attachments and the google-workspace extension end to end on the real account: reads anything, writes only into a new scratch folder and ONE draft to itself, cleans up")
    .option("--scratch", "required: confirms the run may create its scratch folder, its draft and its temporary agent (all removed again)")
    .option("--account <email>", "the Gmail account (default: the only one, or the one the Workspace connection is signed in as)")
    .option("--connection <slug>", "the google-workspace connection (default: the only one)")
    .option("--json", "print the result table as JSON on stdout (progress goes to stderr)")
    .option("-y, --yes", "don't ask before running")
    .option("-d, --data <dir>", `xaq's data directory (default ~/.xaq; env XAQ_DATA)`)
    .addHelpText(
      "after",
      `
Prints the plan first and asks (or --yes). Exit code 0 only when every step passes and nothing is left behind.

Example:
  ${NPX} smoke google-workspace --scratch`,
    )
    .action(async (o: SmokeFlags & { data?: string }) => {
      const { openAdminChannel } = await import("../connections-cli/admin.ts");
      const { TerminalPrompter } = await import("../connections-cli/prompt.ts");
      const { connectAgentMcp } = await import("./agent.ts");
      const { SmokeRun } = await import("./run.ts");
      const { renderReport } = await import("./report.ts");
      if (!o.scratch) {
        throw new Error(
          "smoke google-workspace runs live on the connected Google account: it reads existing files and mail, and writes only into a new scratch folder and ONE draft to the account itself, which it removes again. Pass --scratch to run it.",
        );
      }
      const out = safeWriter(o.json ? process.stderr : process.stdout);
      const err = o.json ? out : safeWriter(process.stderr);
      const json = o.json ? safeWriter(process.stdout) : null;
      const channel = openAdminChannel({ dataDir: resolveDataDir(o.data) });
      const prompter = new TerminalPrompter(!!o.yes, { input: process.stdin, output: o.json ? process.stderr : process.stdout });
      const controller = new AbortController();
      const run = new SmokeRun(o, {
        admin: channel,
        connectMcp: (key) => connectAgentMcp(channel.baseUrl, key),
        print: out.print,
        confirm: (q) => prompter.confirm(q, false),
        signal: controller.signal,
      });
      const remove = installSmokeSignals(controller, {
        print: (l) => err.print(l),
        fastCleanup: () => run.fastCleanup(3000),
        exit: (code) => {
          channel.close();
          process.exit(code);
        },
        leftovers: () => {
          const left = run.pendingLeftovers();
          return left.length ? `These may be left: ${left.join("; ")}. The next run removes the agent and the attachmentDirs entry and lists the rest.` : "Nothing was left.";
        },
      });
      try {
        const report = await run.run();
        if (json) json.print(JSON.stringify(report, null, 2));
        else for (const l of ["", ...renderReport(report)]) out.print(l);
        process.exitCode = report.ok ? 0 : report.interrupted ? 130 : 1;
      } finally {
        remove();
        prompter.close();
        channel.close();
        out.dispose();
        if (err !== out) err.dispose();
        json?.dispose();
      }
    });
}
