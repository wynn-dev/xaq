import { type Command, InvalidArgumentError } from "commander";
import { LEGACY_PRODUCT } from "../brand.ts";
import { EVENT_TYPES } from "../../shared/types.ts";
import type { ConnectFlags } from "./connect.ts";
import type { HermesFlags } from "./hermes.ts";
import type { ListenFlags } from "./options.ts";
import { DEFAULT_PROFILE } from "./paths.ts";
import { RECIPE_NAMES, recipesHelp, TOOLS } from "./recipes.ts";
import { NPX } from "./version.ts";

/** `xaq connect`, `xaq setup-mcp` and `xaq listen …`, all lazily loaded. */

/**
 * Options of a `listen` subcommand plus any its ancestors parsed: `listen` declares the same flags
 * (--profile, --exec…), and commander lets the parent claim them wherever they appear.
 */
const all = <T>(cmd: Command): T => cmd.optsWithGlobals() as T;

const collect = (value: string, previous: string[] | undefined) => [...(previous ?? []), value];

const int = (name: string) => (value: string) => {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError(`${name} must be a whole number.`);
  return Number(value);
};

const profileOption = (cmd: Command) => cmd.option("--profile <name>", `profile to use (default "${DEFAULT_PROFILE}")`);

function listenFlags(cmd: Command): Command {
  return profileOption(cmd)
    .option("--exec <command>", "run this command for each event (via /bin/sh; the event arrives on stdin as JSON, never in the command)")
    .option("--recipe <name>", `use a built-in target: ${RECIPE_NAMES.join(", ")} (hermes forwards to your Hermes gateway; see it with --print-recipe)`)
    .option("--forward <url>", "POST each event to this localhost URL, signed per Standard Webhooks")
    .option("--types <list>", `comma-separated event types, or "all" (default: message.received, new mail only; also ${EVENT_TYPES.filter((t) => t !== "message.received").join(", ")}; calendar.* need calendar.read)`)
    .option("--from <glob>", 'only senders (calendar: organizers) matching this glob, e.g. "*@stripe.com" (repeatable)', collect)
    .option("--to <glob>", "only when a to/cc address (calendar: an attendee) matches (repeatable)", collect)
    .option("--label <id>", "only messages with this Gmail label id, e.g. INBOX or Label_123 (repeatable)", collect)
    .option("--subject <regex>", "only subjects (calendar: event titles) matching this case-insensitive regular expression")
    .option("--not-from <glob>", 'skip senders matching this glob, e.g. "*@github.com" (repeatable; --not-from "" --save clears saved exclusions)', collect)
    .option("--not-label <id>", "skip messages with this Gmail label id, e.g. CATEGORY_UPDATES (repeatable)", collect)
    .option("--all-categories", "don't skip Gmail's Promotions, Social and Forums tabs (skipped by default)")
    .option("--include-category <name>", "take one category back from the default skip: promotions, social or forums (repeatable)", collect)
    .option("--default-categories", "back to the default: skip Promotions, Social and Forums (undoes a saved --all-categories / --include-category)")
    .option("--batch <duration>", `collect events this long (e.g. 60s, 2m) and run --exec once for all of them (up to 20); 0 turns it off`)
    .option("--include-body", "include the cleaned message body (calendar: the event description) in each event")
    .option("--no-include-body", "don't include bodies (overrides a saved setting)")
    .option("--concurrency <n>", "events handled at once (default 2)", int("--concurrency"))
    .option("--timeout <seconds>", "per-event time limit; the whole process group is killed after it (default 300)", int("--timeout"))
    .option("--max-attempts <n>", "attempts before an event goes to dead letters (default 5)", int("--max-attempts"))
    .option("--consumer <name>", "server-side cursor name (default <hostname>-<profile>)")
    .option("--cwd <dir>", "directory --exec commands run in (default: a private dir in the state dir; must be yours and not group/world-writable)")
    .option("--insecure", "allow plain http to a non-loopback, non-Tailscale daemon (loud warning)")
    .option("--save", "save these settings to the profile");
}

/** `listen hermes --help`. */
function hermesHelp(): string {
  return `
--recipe hermes forwards each event to your running Hermes gateway (http://127.0.0.1:8644/webhooks/xaq; for
another profile the route is xaq-<profile>; a profile set up before the rename keeps its ${LEGACY_PRODUCT}[-<profile>] route,
toolset and server name). Hermes verifies the Standard Webhooks signature with the
listener's secret, runs the triage, and delivers the result where this route says. Mail that isn't important gets
a [SILENT] reply, which Hermes doesn't deliver.

A Hermes webhook run normally gets web tools (web_search, web_extract, vision_analyze, clarify) and every MCP
server enabled in Hermes: with email as the trigger, an attacker could make it read your mail and send it out.
--run therefore also limits the route to the xaq MCP server ("toolsets": ["mcp-xaq"] in
webhook_subscriptions.json, which \`hermes webhook subscribe\` can't set). That limit only holds when xaq is an
enabled MCP server in Hermes' config.yaml (else Hermes adds every MCP server), so this refuses until
\`${NPX} setup-mcp --tool hermes\` has added it. --run creates the route disabled with the real secret under Hermes'
lock (python3), runs \`hermes webhook subscribe\` without --secret (hermes keeps the secret and the disabled state),
then sets the toolsets and enables it. The secret is never in a command line, the route never runs unconfined, and
any failure removes it again. Re-run it after any \`hermes webhook subscribe\` for this route (that resets the
toolsets). The Hermes home follows HERMES_HOME or Hermes' sticky active_profile.

Without --run it prints both steps for you to do by hand; the toolsets edit is required.

--cron-job hands the email to that job's own tools, so it is accepted only when the job's enabled_toolsets is
exactly ["xaq"] (the bare server name; "mcp-xaq" doesn't narrow MCP servers for cron jobs).

Needs python3, the gateway's webhook platform (hermes gateway setup, or WEBHOOK_ENABLED=true in ~/.hermes/.env) and
a running gateway. Check it: curl http://127.0.0.1:8644/health

Examples:
  ${NPX} listen hermes --deliver telegram --run
  ${NPX} listen hermes --cron-job email-watch --run    # only for a job limited to ["xaq"]
  ${NPX} listen service install --recipe hermes`;
}

/** `setup-mcp --help`: exactly what it changes, per tool. */
function mcpSetupHelp(): string {
  return `
What it changes (the server is named "xaq", or "xaq-<profile>" for --profile; a profile set up before the
rename keeps the "${LEGACY_PRODUCT}[-<profile>]" name it already has in your tools):
  claude-code  runs \`claude mcp remove xaq --scope user\` then
               \`claude mcp add-json --scope user xaq '{"type":"http","url":"<daemon>/mcp","headersHelper":"…"}'\`.
               The header helper (~/.config/xaq/bin/mcp-header.mjs) reads the key from your profile, so
               the key is in neither the command line nor ~/.claude.json. Backs up ~/.claude.json first
               ($CLAUDE_CONFIG_DIR/.claude.json if set).
  codex        adds or replaces [mcp_servers.xaq] in ~/.codex/config.toml ($CODEX_HOME), with the key in
               http_headers; the file becomes 0600.
  cursor       adds or replaces mcpServers.xaq in ~/.cursor/mcp.json, with the key in headers; 0600.
  hermes       adds or replaces mcp_servers.xaq in ~/.hermes/config.yaml ($HERMES_HOME) and puts the key in
               ~/.hermes/.env as XAQ_API_KEY; both 0600.
Every file is backed up first as <file>.xaq-backup-<timestamp> (0600; backups of files holding the key hold it
too). It also refreshes ~/.config/xaq/mcp/<profile>.claude.json (no key), which the listen recipe uses.

Check it afterwards: claude mcp list · codex mcp list · agent mcp list (Cursor) · hermes mcp test xaq

Example:
  ${NPX} setup-mcp --tool claude-code --dry-run`;
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
    .option("--setup-mcp", "also register the MCP server in the chosen tool (the key is never shown; `setup-mcp --help` lists exactly what changes)")
    .option("--profile <name>", `profile to save the key in (default "${DEFAULT_PROFILE}")`)
    .option("--consumer <name>", "listener cursor name (default <hostname>-<profile>)")
    .option("--log <file>", "also write the output to this file (created 0600; for running connect in the background)")
    .option("--insecure", "allow plain http to a non-loopback, non-Tailscale daemon (loud warning)")
    .option("--force", "re-pair an existing profile (keeps its listener settings)")
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

  profileOption(program.command("setup-mcp").description("register the xaq MCP server in your agent's tool, without showing the key"))
    .option("--tool <tool>", `${TOOLS.filter((t) => t !== "other").join(", ")} (default: the tool given to connect)`)
    .option("--dry-run", "print the exact commands and file changes, and change nothing")
    .addHelpText("after", mcpSetupHelp())
    .action(async (flags: { tool?: string; profile?: string; dryRun?: boolean }) => {
      const { parseTool, printMcpResult } = await import("./connect.ts");
      const { loadProfile } = await import("./profile.ts");
      const { setupMcp, mcpTarget } = await import("./mcpsetup.ts");
      const { profilePath } = await import("./paths.ts");
      const name = flags.profile ?? DEFAULT_PROFILE;
      const profile = loadProfile(name);
      const tool = flags.tool ? parseTool(flags.tool) : (profile.tool ?? "other");
      if (tool === "other") throw new Error(`Which tool? Pass --tool ${TOOLS.filter((t) => t !== "other").join("|")}.`);
      const { claudeMcpConfigPath, writeClaudeMcpConfig } = await import("./mcpheader.ts");
      const r = setupMcp(tool, mcpTarget(name, profile), profilePath(name), { dryRun: flags.dryRun });
      if (flags.dryRun) r.changes = [...(r.changes ?? []), `refresh ${claudeMcpConfigPath(name)} (keyless MCP config the Claude Code listen recipe loads)`];
      else writeClaudeMcpConfig(name, `${profile.url}/mcp`);
      printMcpResult(r);
      if (!r.ok) process.exitCode = 1;
    });

  profileOption(
    program.command("mcp-header").description("print the agent's Authorization header as JSON for an MCP client's header helper (refuses to print to a terminal)"),
  ).action(async (flags: { profile?: string }) => {
    const { printMcpHeader } = await import("./mcpheader.ts");
    process.exitCode = printMcpHeader(flags.profile ?? DEFAULT_PROFILE);
  });

  const listen = listenFlags(
    program
      .command("listen")
      .description("wake a local agent on new mail: hold an outbound stream to the daemon and run a command or POST to localhost per event"),
  )
    .option("--dry-run", "print matching events without running anything (uses a throwaway <consumer>-dry-run cursor)")
    .option("--from-start", "a NEW consumer starts at the oldest stored event (no effect once it exists: use --backfill)")
    .option("--backfill", "run the mail from before this listener started through --exec/--forward once, oldest first, then exit; safe while the listener runs (own cursor)")
    .option("--until <seq>", "with --backfill: replay up to this event number instead of where the listener started", int("--until"))
    .option("--print-recipe <name>", `print what --recipe <name> runs (hermes: its URL), for ${RECIPE_NAMES.join(", ")} (with this machine's paths), and exit`)
    .addHelpText("after", recipesHelp())
    .action(async (flags: ListenFlags & { printRecipe?: string }) => {
      if (flags.printRecipe !== undefined) {
        const { parseRecipeTool, recipe } = await import("./recipes.ts");
        const name = flags.printRecipe.trim().toLowerCase();
        const r = recipe(name === "other" ? "other" : parseRecipeTool(name), flags.profile ?? DEFAULT_PROFILE);
        // Exec recipes print the bare command (to edit and pass back with --exec); hermes its forward URL.
        process.stdout.write(`${r.exec ?? r.forward}\n`);
        return;
      }
      const { runListener } = await import("./listen.ts");
      process.exit(await runListener({ flags, handleSignals: true }));
    });

  profileOption(listen.command("status").description("show the listener's connection, cursor, recent events and dead letters")).action(async (_o: unknown, cmd: Command) => {
    const flags = all<{ profile?: string }>(cmd);
    const { printStatus } = await import("./admin.ts");
    await printStatus(flags.profile ?? DEFAULT_PROFILE);
  });

  profileOption(listen.command("secret").description("print the forward-mode signing secret (whsec_…) for your local receiver"))
    .option("--rotate", "generate a new secret (restart the listener afterwards)")
    .action(async (_o: unknown, cmd: Command) => {
      const flags = all<{ profile?: string; rotate?: boolean }>(cmd);
      const { printSecret } = await import("./admin.ts");
      printSecret(flags.profile ?? DEFAULT_PROFILE, flags);
    });

  profileOption(
    listen
      .command("hermes")
      .description("create the Hermes gateway webhook route that --recipe hermes forwards to, limited to the xaq tools"),
  )
    .option("--deliver <target>", "where Hermes sends its triage: telegram, discord, slack… (a platform connected to your gateway), or log")
    .option("--deliver-chat-id <id>", "with --deliver: a specific chat instead of the platform's home channel")
    .option("--cron-job <job>", "instead of --deliver: fire this existing Hermes cron job (id or name; `hermes cron list`); its prompt, tools and delivery apply, so its enabled_toolsets must be exactly [\"xaq\"]")
    .option("--script <file>", "a Hermes filter script under ~/.hermes/scripts (runs before the agent; can drop events at no LLM cost)")
    .option("--run", "set the route up now: run hermes, then set the real secret and limit the route to the xaq tools (recommended)")
    .addHelpText("after", hermesHelp())
    .action(async (_o: unknown, cmd: Command) => {
      const flags = all<HermesFlags>(cmd);
      const { hermesSubscribe } = await import("./hermes.ts");
      process.exitCode = await hermesSubscribe(flags.profile ?? DEFAULT_PROFILE, flags);
    });

  listenFlags(listen.command("dead").description("list events that failed every attempt; --replay runs them again"))
    .option("--replay", "run dead events again (successes are removed)")
    .option("--id <eventId>", "only this event (with --replay or --clear)")
    .option("--clear", "delete dead events without running them")
    .option("--json", "print raw JSON lines")
    .action(async (_o: unknown, cmd: Command) => {
      const flags = all<ListenFlags & { replay?: boolean; id?: string; clear?: boolean; json?: boolean }>(cmd);
      const admin = await import("./admin.ts");
      const profile = flags.profile ?? DEFAULT_PROFILE;
      if (flags.clear) admin.clearDead(profile, flags.id);
      else if (flags.replay) {
        if ((await admin.replayDead(flags)) > 0) process.exitCode = 1;
      } else admin.printDead(profile, flags);
    });

  const service = listen.command("service").description("run the listener in the background (systemd user service / launchd agent, one per profile)");
  listenFlags(service.command("install").description("install and start the listener service; flags are saved to the profile. Re-run to update")).action(
    async (_o: unknown, cmd: Command) => {
      const flags = all<ListenFlags>(cmd);
      const { installListenService } = await import("./service.ts");
      await installListenService(flags);
    },
  );
  profileOption(service.command("uninstall").description("stop and remove the listener service (keeps the profile)")).action(async (_o: unknown, cmd: Command) => {
    const flags = all<{ profile?: string }>(cmd);
    const { uninstallListenService } = await import("./service.ts");
    uninstallListenService(flags.profile ?? DEFAULT_PROFILE);
  });
  profileOption(service.command("status").description("show the service manager's status for the listener")).action(async (_o: unknown, cmd: Command) => {
    const flags = all<{ profile?: string }>(cmd);
    const { listenServiceStatus } = await import("./service.ts");
    listenServiceStatus(flags.profile ?? DEFAULT_PROFILE);
  });
}
