import type { Command } from "commander";
import { EVENT_TYPES } from "../../shared/types.ts";
import type { ConnectFlags } from "./connect.ts";
import type { ListenFlags } from "./options.ts";
import { recipesHelp, TOOLS } from "./recipes.ts";
import { NPX } from "./version.ts";

/** `xaq connect`, `xaq setup-mcp` and `xaq listen …`, all lazily loaded. */

const collect = (value: string, previous: string[] | undefined) => [...(previous ?? []), value];

/** The settings flags: `listen` and `listen service install` (which saves them). */
function listenFlags(cmd: Command): Command {
  return cmd
    .option("--recipe <name>", "run Claude Code for each event, confined to the xaq tools (claude-code)")
    .option("--exec <command>", "run this command for each event (via /bin/sh; the event arrives on stdin as JSON, never in the command)")
    .option("--types <list>", `comma-separated event types, or "all" (default: message.received, new mail only; also ${EVENT_TYPES.filter((t) => t !== "message.received").join(", ")}; calendar.* need calendar.read)`)
    .option("--not-from <glob>", 'skip senders matching this glob, e.g. "*@github.com" (repeatable)', collect)
    .option("--all-categories", "don't skip Gmail's Promotions, Social and Forums tabs (skipped by default)")
    .option("--include-body", "include the cleaned message body (calendar: the event description) in each event");
}

/** `setup-mcp --help`: exactly what it changes. */
function mcpSetupHelp(): string {
  return `
What it changes: runs \`claude mcp remove xaq --scope user\` then
\`claude mcp add-json --scope user xaq '{"type":"http","url":"<daemon>/mcp","headersHelper":"…"}'\`. The header helper
(~/.config/xaq/bin/mcp-header.mjs) reads the key from your pairing, so the key is in neither the command line nor
~/.claude.json, which is backed up first as ~/.claude.json.xaq-backup-<timestamp> ($CLAUDE_CONFIG_DIR/.claude.json if
set). It also refreshes ~/.config/xaq/mcp/default.claude.json (no key), which the listen recipe uses.

Check it afterwards: claude mcp list

Example:
  ${NPX} setup-mcp --dry-run`;
}

export function registerListenCommands(program: Command): void {
  program
    .command("connect")
    .description("pair this machine's agent with a xaq daemon (approve the code in the console)")
    .argument("<daemon-url>", "the xaq daemon, e.g. https://mail.example.com or http://100.101.102.103:8425")
    .option("--name <name>", 'how the agent appears in the console (default "<Tool> on <hostname>")')
    .option("--tool <tool>", `the agent's tool: ${TOOLS.join(", ")}; tailors the next steps`)
    .option("--account <email>", "mailbox to request access to (repeatable; the approver decides)", collect)
    .option("--reason <text>", "why the agent needs access (shown to the approver)")
    .option("--setup-mcp", "also register the MCP server in Claude Code (the key is never shown; `setup-mcp --help` lists exactly what changes)")
    .option("--log <file>", "also write the output to this file (created 0600; for running connect in the background)")
    .option("--insecure", "allow plain http to a non-loopback, non-Tailscale daemon (loud warning)")
    .option("--force", "replace this machine's pairing (keeps the listener settings)")
    .addHelpText(
      "after",
      `
Exit codes: 0 approved, 2 denied, 3 expired, 4 already consumed, 130 cancelled, 1 error.

Example:
  ${NPX} connect https://mail.example.com --tool claude-code --setup-mcp`,
    )
    .action(async (url: string, flags: ConnectFlags) => {
      const { runConnect } = await import("./connect.ts");
      process.exit(await runConnect(url, flags, { handleSignals: true }));
    });

  program
    .command("setup-mcp")
    .description("register the xaq MCP server in Claude Code, without showing the key")
    .option("--dry-run", "print the exact commands and file changes, and change nothing")
    .addHelpText("after", mcpSetupHelp())
    .action(async (flags: { dryRun?: boolean }) => {
      const { printMcpResult } = await import("./connect.ts");
      const { loadProfile } = await import("./profile.ts");
      const { setupMcp } = await import("./mcpsetup.ts");
      const { profilePath } = await import("./paths.ts");
      const { claudeMcpConfigPath, writeClaudeMcpConfig } = await import("./mcpheader.ts");
      const profile = loadProfile();
      const r = setupMcp("claude-code", profile, profilePath(), { dryRun: flags.dryRun });
      if (flags.dryRun) r.changes = [...(r.changes ?? []), `refresh ${claudeMcpConfigPath()} (keyless MCP config the Claude Code listen recipe loads)`];
      else writeClaudeMcpConfig(`${profile.url}/mcp`);
      printMcpResult(r);
      if (!r.ok) process.exitCode = 1;
    });

  const listen = listenFlags(
    program
      .command("listen")
      .description("wake a local agent on new mail: hold an outbound stream to the daemon and run a command per event"),
  )
    .option("--dry-run", "print matching events without running anything (uses a throwaway <consumer>-dry-run cursor)")
    .option("--backfill", "run the mail from before this listener started through the command once, oldest first, then exit; safe while the listener runs (own cursor)")
    .addHelpText("after", recipesHelp())
    .action(async (flags: ListenFlags) => {
      const { runListener } = await import("./listen.ts");
      process.exit(await runListener({ flags, handleSignals: true }));
    });

  listen
    .command("status")
    .description("show the pairing, the listener's settings, connection, cursor and recent events")
    .action(async () => {
      const { printStatus } = await import("./admin.ts");
      await printStatus();
    });

  const service = listen.command("service").description("run the listener in the background (systemd user service / launchd agent)");
  listenFlags(service.command("install").description("install and start the listener service; the flags are saved (none: the saved ones). Re-run to update")).action(
    async (_o: unknown, cmd: Command) => {
      const { installListenService } = await import("./service.ts");
      // `listen` declares the same flags, and commander lets the parent claim them wherever they appear.
      await installListenService(cmd.optsWithGlobals() as ListenFlags);
    },
  );
  service
    .command("uninstall")
    .description("stop and remove the listener service (keeps the pairing)")
    .action(async () => {
      const { uninstallListenService } = await import("./service.ts");
      uninstallListenService();
    });
  service
    .command("status")
    .description("show the service manager's status for the listener")
    .action(async () => {
      const { listenServiceStatus } = await import("./service.ts");
      listenServiceStatus();
    });
}
