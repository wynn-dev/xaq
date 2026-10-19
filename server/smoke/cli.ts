// `xaq smoke google-workspace --scratch`: run on xaq's machine, through the daemon's admin API over the local admin
// channel (server/connections-cli/admin.ts) and /mcp as a temporary agent. See run.ts for what it does.

import type { Command } from "commander";
import { LEGACY_PRODUCT } from "../brand.ts";
import { resolveDataDir } from "../config.ts";
import { NPX } from "../listen/version.ts";
import type { SmokeFlags } from "./run.ts";

const GROUP = "MCP connections (on xaq's machine):";

/**
 * Ctrl-C (and SIGTERM, SIGHUP): the first one stops the run after the current call and cleanup runs; a second one
 * quits at once, saying what may be left. Returns the remover.
 */
export function installSmokeSignals(controller: AbortController, opts: { print: (line: string) => void; exit: (code: number) => void; leftovers: () => string }): () => void {
  let count = 0;
  const handler = () => {
    count++;
    if (count === 1) {
      opts.print("\nStopping after the current call, then cleaning up. Press Ctrl-C again to quit without cleaning up.");
      controller.abort();
      return;
    }
    opts.print(`\nQuit without cleaning up. ${opts.leftovers()}`);
    opts.exit(130);
  };
  const sigs = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const s of sigs) process.on(s, handler);
  return () => {
    for (const s of sigs) process.removeListener(s, handler);
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
    .option("-d, --data <dir>", `xaq's data directory (default ~/.xaq, or an existing ~/.${LEGACY_PRODUCT}; env XAQ_DATA)`)
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
      const out = (line = "") => (o.json ? process.stderr : process.stdout).write(`${line}\n`);
      if (!o.scratch) {
        throw new Error(
          "smoke google-workspace runs live on the connected Google account: it reads existing files and mail, and writes only into a new scratch folder and ONE draft to the account itself, which it removes again. Pass --scratch to run it.",
        );
      }
      const channel = openAdminChannel({ dataDir: resolveDataDir(o.data, { quiet: true }) });
      const prompter = new TerminalPrompter(!!o.yes, { input: process.stdin, output: o.json ? process.stderr : process.stdout });
      const controller = new AbortController();
      const run = new SmokeRun(o, {
        admin: channel,
        connectMcp: (key) => connectAgentMcp(channel.baseUrl, key),
        print: out,
        confirm: (q) => prompter.confirm(q, false),
        signal: controller.signal,
      });
      const remove = installSmokeSignals(controller, {
        print: (l) => process.stderr.write(`${l}\n`),
        exit: (code) => {
          channel.close();
          process.exit(code);
        },
        leftovers: () => {
          const l = run.ledger;
          const parts = [
            l.agent && `the agent ${l.agent.name}`,
            l.folder && `the Drive folder ${l.folder.name}`,
            ...[...l.drafts].filter(([, d]) => !d.deleted).map(([id]) => `the draft ${id}`),
            l.tempDir && `attachmentDirs may still list ${l.tempDir}`,
          ].filter(Boolean);
          return parts.length ? `These may be left: ${parts.join("; ")}.` : "Nothing was created yet.";
        },
      });
      try {
        const report = await run.run();
        if (o.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        else for (const l of ["", ...renderReport(report)]) out(l);
        process.exitCode = report.ok ? 0 : report.interrupted ? 130 : 1;
      } finally {
        remove();
        prompter.close();
        channel.close();
      }
    });
}
