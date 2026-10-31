// Must stay the first import: exits with a clear message on a too-old Node.
import "./node-check.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { Command as CommandType } from "commander";
import { envVar } from "./brand.ts";

// Loaded after the Node check (static imports are hoisted above it in the bundle).
const { Command, InvalidArgumentError } = await import("commander");
const { default: pc } = await import("picocolors");

process.title = "xaq";

// node:sqlite is stable enough for us but still warns on Node 22. This runs before any server
// module loads: everything that touches node:sqlite is imported dynamically below.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if ((type === "ExperimentalWarning" || (warning as Error).name === "ExperimentalWarning") && /SQLite/i.test(message)) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

/** package.json sits one level above both dist/cli.js and server/cli.ts. */
function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

const version = packageVersion();

interface ServerFlags {
  port?: number;
  host?: string;
  data?: string;
}

const validPort = (value: string) => /^\d+$/.test(value) && Number(value) <= 65535;

function parsePort(value: string): number {
  if (!validPort(value)) throw new InvalidArgumentError("Port must be a number from 0 to 65535.");
  return Number(value);
}

/** --port, else a validated PORT env (a typo there would otherwise become NaN deep inside). */
function portOption(flag: number | undefined): number | undefined {
  if (flag !== undefined) return flag;
  const env = process.env.PORT?.trim();
  if (!env) return undefined;
  if (!validPort(env)) throw new Error(`PORT="${process.env.PORT}" is not a valid port. Use a number from 0 to 65535.`);
  return Number(env);
}

const withServerOptions = (cmd: CommandType) =>
  cmd
    .option("-p, --port <port>", "port to listen on (default 8425, env PORT)", parsePort)
    .option("--host <host>", "bind address (default 0.0.0.0, env HOST)")
    .option("-d, --data <dir>", "data directory (default ~/.xaq; env XAQ_DATA)");

const configInput = (o: ServerFlags) => ({ port: portOption(o.port), host: o.host, dataDir: o.data });

const program = new Command("xaq")
  .description(
    "Self-hosted MCP broker for AI agents (Notion, WHOOP, any MCP server, Gmail and Calendar). Start it, open the " +
      "link it prints, and the web console walks you through the rest (what to connect, your first agent).",
  )
  .version(version, "-v, --version", "print the version")
  .helpOption("-h, --help", "show help")
  .addHelpText(
    "after",
    `
Examples:
  npx xaq-cli                     start the server and print the setup link
  npx xaq-cli service install     keep it running in the background, also after a reboot
  npx xaq-cli reset-password      print a new setup link (forgot the console password)
  npx xaq-cli connect https://mail.example.com --tool claude-code --setup-mcp
                                  on an agent's machine: pair it (you approve in the console)
  npx xaq-cli listen --recipe claude-code
                                  on an agent's machine: wake Claude Code on new mail

Run any command with --help for details. Install it with npm i -g xaq-cli to type xaq instead.
Docs: https://github.com/wynn-dev/xaq/blob/main/docs/reference.md`,
  )
  .showSuggestionAfterError();

const SERVER_GROUP = "Run xaq:";
const AGENT_GROUP = "On an agent's machine:";

withServerOptions(
  program
    .command("start", { isDefault: true })
    .description("run xaq in this terminal and print the setup link (the default command)")
    .summary("run it in this terminal (the default command)")
    .helpGroup(SERVER_GROUP),
)
  .option("--no-open", "don't open a browser on first run")
  .option("--dev", "development: API only, the console runs on Vite (:5173)")
  // `xaq typo` lands here as an extra argument: report it as the unknown command it is.
  .allowExcessArguments()
  .action(async (o: ServerFlags & { open: boolean; dev?: boolean }, cmd: CommandType) => {
    if (cmd.args.length) throw new Error(unknownCommand(cmd.args[0]!));
    const { runForeground } = await import("./server.ts");
    await runForeground({ ...configInput(o), dev: !!o.dev, open: o.open, version });
  });

const service = program
  .command("service")
  .description("run xaq in the background as a systemd / launchd service, started at boot")
  .summary("run it in the background (systemd / launchd)")
  .helpGroup(SERVER_GROUP);

withServerOptions(
  service.command("install").description("install and start the service; re-run it to change the port or update"),
)
  .option("--node <path>", "the Node.js binary the service runs (default: this one)")
  .action(async (o: ServerFlags & { node?: string }) => {
    const { loadConfig } = await import("./config.ts");
    const { installService } = await import("./service.ts");
    await installService(loadConfig(configInput(o), version), undefined, { node: o.node });
  });

service
  .command("uninstall")
  .description("stop and remove the service (keeps your data)")
  .option("-d, --data <dir>", "data directory, if the installed service doesn't say (default ~/.xaq; env XAQ_DATA)")
  .action(async (o: ServerFlags) => {
    const { uninstallService } = await import("./service.ts");
    const { resolveDataDir } = await import("./config.ts");
    // No loadConfig: uninstalling must not create a data directory.
    uninstallService({ dataDir: resolveDataDir(o.data) });
  });

// The console's update job (server/update.ts), started by the service as its own systemd unit or launchd job.
service
  .command("update-run", { hidden: true })
  .requiredOption("-d, --data <dir>", "the service's data directory")
  .requiredOption("--id <id>", "the update's id (the status file carries it)")
  .requiredOption("--to <version>", "the version to install")
  .action(async (o: { data: string; id: string; to: string }) => {
    const { runUpdateJob } = await import("./update.ts");
    const status = await runUpdateJob({ dataDir: o.data, id: o.id, version: o.to });
    if (status.state !== "succeeded") process.exitCode = 1;
  });

service
  .command("status")
  .description("show service status")
  .action(async () => {
    const { serviceStatus } = await import("./service.ts");
    serviceStatus();
  });

const skill = program
  .command("skill")
  .description("the xaq agent skill (SKILL.md): teaches an agent how to use xaq's tools")
  .summary("install the agent skill (SKILL.md)")
  .helpGroup(AGENT_GROUP);

skill
  .command("print")
  .description("print SKILL.md to stdout")
  .option("--url <url>", "xaq server URL to fill in (env XAQ_URL)")
  .action(async (o: { url?: string }) => {
    const { renderSkill } = await import("./skill/index.ts");
    process.stdout.write(renderSkill(await serverUrl(o.url)));
  });

skill
  .command("install")
  .description("install SKILL.md for an agent (no running server needed)")
  .option("-t, --target <target>", "claude, codex, agents, or a skills directory path", "claude")
  .option("--url <url>", "xaq server URL agents connect to (env XAQ_URL)")
  .action(async (o: { target: string; url?: string }) => {
    const { renderSkill, SKILL_TARGETS, skillPath, writeSkill } = await import("./skill/index.ts");
    checkSkillTarget(o.target, Object.keys(SKILL_TARGETS));
    const url = await serverUrl(o.url);
    const path = skillPath(o.target);
    writeSkill(path, renderSkill(url));
    console.log(`Installed the xaq skill to ${pc.cyan(path)} (server ${url}).`);
    if (!o.url && !envVar("URL")) {
      console.log(pc.dim("Agents on other machines need the server's address: re-run with --url https://your-server."));
    }
  });

program
  .command("reset-password")
  .description("forgot the console password? Removes it and prints a new setup link (or the first-run link)")
  .summary("print a new setup link (forgot the password?)")
  .helpGroup(SERVER_GROUP)
  .option("-d, --data <dir>", "data directory (default ~/.xaq; env XAQ_DATA)")
  .option("-p, --port <port>", "port of the running instance, used for the printed link", parsePort)
  .option("--host <host>", "host of the running instance, used for the printed link")
  .action(
  async (o: ServerFlags) => {
    // Never create a data directory or master key here: a wrong --data (or a service running as
    // another user) must not silently produce a fresh instance.
    const { dataFiles, resolveDataDir } = await import("./config.ts");
    const dataDir = resolveDataDir(o.data);
    const dbPath = dataFiles(dataDir).db;
    if (!existsSync(dbPath)) {
      throw new Error(
        `No xaq data in ${dataDir}. If xaq runs as a system service, run this with sudo; ` +
          "otherwise pass the data directory it uses with --data.",
      );
    }
    const { loadConfig } = await import("./config.ts");
    const { Db } = await import("./db/index.ts");
    const { createBus } = await import("./bus.ts");
    const { SettingsStore } = await import("./settings.ts");
    const { AuditLog } = await import("./audit.ts");
    const { currentSetupToken, isClaimed, resetAdminPassword } = await import("./auth/index.ts");
    const { runningInstance } = await import("./instance.ts");
    const { consoleUrls } = await import("./urls.ts");

    const running = runningInstance(dataDir);
    const config = loadConfig(
      { dataDir, port: portOption(o.port) ?? running?.port, host: o.host ?? (process.env.HOST || running?.host) },
      version,
    );
    const db = new Db(dbPath);
    try {
      const bus = createBus();
      const core = { config, db, settings: new SettingsStore(db, bus, config), audit: new AuditLog(db, bus) };
      const claimed = isClaimed(core);
      const token = claimed ? resetAdminPassword(core) : currentSetupToken(core)!;
      console.log(
        claimed
          ? "\n  The admin password was removed and all console sessions were signed out.\n  Open this link to set a new password:\n"
          : "\n  This instance hasn't been claimed yet, so there is no password to reset.\n  Open this link to claim it:\n",
      );
      const urls = consoleUrls(config.host, config.port);
      const publicUrl = core.settings.publicUrl();
      if (!urls.includes(publicUrl)) urls.push(publicUrl);
      for (const url of urls) console.log(`  ${pc.cyan(`${url}/setup?token=${token}`)}`);
      console.log(pc.dim(`\n  ${running ? "The running xaq picks this up immediately; no restart needed." : "Start xaq to use it."}\n`));
    } finally {
      db.close();
    }
  },
);

// Agent side: `connect` (device-flow pairing), `setup-mcp`, `mcp-header` and `listen …` (see
// docs/listen.md). Imported after the Node check, like everything else.
const { registerListenCommands } = await import("./listen/commands.ts");
registerListenCommands(program);
// Daemon side, behind the brokerUpstreams setting: `connections …` and `import --from …` (server/connections-cli).
const { registerConnectionsCommands } = await import("./connections-cli/commands.ts");
registerConnectionsCommands(program);
// `ext add | list | update | remove` (docs/EXTENSIONS.md), through the daemon's /api/extensions.
const { registerExtensionCommands } = await import("./extensions/cli.ts");
registerExtensionCommands(program);
// `smoke google-workspace --scratch`: the live end-to-end check (server/smoke), through the daemon's admin API and /mcp.
const { registerSmokeCommands } = await import("./smoke/cli.ts");
registerSmokeCommands(program);
// `settings attachment-dirs list | add | remove`, through the daemon's /api/settings.
const { registerSettingsCommands } = await import("./settings-cli.ts");
registerSettingsCommands(program);
// Short one-liners for the command list; each command's own --help keeps its full description.
const AGENT_SUMMARIES: Record<string, string> = {
  connect: "pair an agent; you approve it in the console",
  "setup-mcp": "add xaq to the agent's MCP config",
  "mcp-header": "print the agent's auth header (MCP clients)",
  listen: "wake the agent when new mail arrives",
};
for (const cmd of program.commands) {
  const summary = AGENT_SUMMARIES[cmd.name()];
  if (summary) cmd.summary(summary).helpGroup(AGENT_GROUP);
}
program.commandsGroup(SERVER_GROUP).helpCommand("help [command]", "show help for a command").helpCommand(true);

/**
 * The URL written into SKILL.md: --url, XAQ_URL, else the xaq running on this
 * machine (its lock file), else http://localhost:8425.
 */
async function serverUrl(flag: string | undefined): Promise<string> {
  let raw = flag ?? envVar("URL");
  if (!raw) {
    const { runningInstance } = await import("./instance.ts");
    const { resolveDataDir } = await import("./config.ts");
    const running = runningInstance(resolveDataDir(undefined));
    const host = running && !["0.0.0.0", "::", ""].includes(running.host) ? running.host : "localhost";
    raw = `http://${host.includes(":") ? `[${host}]` : host}:${running?.port || process.env.PORT || 8425}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid --url "${raw}". Use a full URL such as https://mail.example.com.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--url must start with http:// or https://");
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/** A known agent name, or something that is clearly a path; typos like "claud" are refused. */
function checkSkillTarget(target: string, known: string[]): void {
  if (known.includes(target) || target.includes("/") || target.includes(sep) || target.startsWith(".") || isDir(target)) return;
  const near = closest(target, known);
  throw new Error(
    `Unknown skill target "${target}".${near ? ` Did you mean ${near}?` : ""} Use ${known.join(", ")}, or a directory path such as ./skills.`,
  );
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function unknownCommand(name: string): string {
  const near = closest(name, [...program.commands.map((c) => c.name()), "help"]);
  return `unknown command '${name}'${near ? `\n(Did you mean ${near}?)` : ""}\nRun xaq --help for the list of commands.`;
}

/** The candidate within edit distance 2 (or a prefix match), if any. */
function closest(word: string, candidates: string[]): string | null {
  const distance = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cur = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
    }
    return row[b.length]!;
  };
  let best: { name: string; d: number } | null = null;
  for (const c of candidates) {
    const d = c.startsWith(word) && word.length >= 3 ? 0 : distance(word.toLowerCase(), c);
    if (d <= 2 && (!best || d < best.d)) best = { name: c, d };
  }
  return best?.name ?? null;
}

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  if (envVar("LOG_LEVEL") === "debug" && err instanceof Error) console.error(err.stack);
  process.exit(1);
}
