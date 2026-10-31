import type { Command } from "commander";
import { NPX } from "../listen/version.ts";
import { LEGACY_PRODUCT } from "../brand.ts";
import { resolveDataDir } from "../config.ts";

/**
 * `connections …` and `import --from …`: run on the daemon's machine, talking to its admin API through the
 * one-time local admin session (admin.ts). Listed in --help since the console (#65) shipped; while the daemon's
 * `brokerUpstreams` setting is off they say so (CONNECTIONS_VISIBLE).
 */
export const CONNECTIONS_VISIBLE = true;
const GROUP = "MCP connections (on xaq's machine):";

const collect = (value: string, previous: string[] | undefined) => [...(previous ?? []), value];
// --data, else XAQ_DATA, else ~/.xaq (config.ts).
const dataDirOf = (o: { data?: string }) => resolveDataDir(o.data);
const dataOption = (cmd: Command) => cmd.option("-d, --data <dir>", `xaq's data directory (default ~/.xaq; env XAQ_DATA)`);

async function withApi<T>(o: { data?: string; yes?: boolean }, run: (deps: { api: import("./api.ts").ConnectionsApi; prompter: import("./prompt.ts").Prompter }) => Promise<T>): Promise<T> {
  const { CLEANUP_SIGNALS, openAdminChannel } = await import("./admin.ts");
  const { ConnectionsApi } = await import("./api.ts");
  const { TerminalPrompter } = await import("./prompt.ts");
  const channel = openAdminChannel({ dataDir: dataDirOf(o) });
  const handlers = CLEANUP_SIGNALS.map((sig) => {
    const h = () => {
      channel.close();
      process.exit(sig === "SIGINT" ? 130 : 128 + (sig === "SIGTERM" ? 15 : 1));
    };
    process.once(sig, h);
    return [sig, h] as const;
  });
  try {
    return await run({ api: new ConnectionsApi(channel), prompter: new TerminalPrompter(!!o.yes) });
  } finally {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
    channel.close();
  }
}

/** This xaq's own MCP origins, so `import` never imports its own entry. */
async function selfOrigins(dataDir: string): Promise<string[]> {
  const { runningInstance } = await import("../instance.ts");
  const { daemonOrigin } = await import("./admin.ts");
  const running = runningInstance(dataDir);
  if (!running) return [];
  return [daemonOrigin(running), `http://localhost:${running.port}`, `http://127.0.0.1:${running.port}`, `http://[::1]:${running.port}`];
}

export function registerConnectionsCommands(program: Command): void {
  const connections = program
    .command("connections", { hidden: !CONNECTIONS_VISIBLE })
    .description("the MCP servers xaq connects agents to (Notion, T3 Code, any MCP URL, installed extensions); run on xaq's machine")
    .summary("add, list, reconnect or remove connected MCP servers")
    .helpGroup(GROUP);

  dataOption(
    connections
      .command("add")
      .description("connect an installed extension (install it first: `ext add notion`) or any MCP server URL, interactively")
      .argument("<integration-or-url>", "an installed extension (`ext add notion|t3code|whoop|brightspace` first), or an MCP server URL such as https://mcp.example.com/mcp"),
  )
    .option("--url <address>", "t3code: your T3 Code server's address, e.g. http://100.101.102.103:3773 (asked when omitted)")
    .option("--slug <name>", "its short name: agents see its tools as <name>__<tool>")
    .option("--name <name>", "its display name (unique; default: the server's host, or the integration's name)")
    .option("--access <level>", "full, ask (ask before risky actions; the default) or read")
    .option("--agent <name>", 'an agent that gets it (repeatable; default: all agents; "all")', collect)
    .option("--header <name>", "header for a server that wants a static key (default Authorization)")
    .option("--account <email>", "a Google extension (google-workspace): the connected Google account it works as (asked when omitted)")
    .option("--paste", "paste the address the browser lands on after signing in, instead of waiting for the redirect (automatic over SSH)")
    .option("--allow-private <origin>", "allow this exact scheme://host:port on this machine or a private network without asking (--yes never does)")
    .option("-y, --yes", "answer yes to confirmations and take the defaults (never to a private-network allow)")
    .addHelpText(
      "after",
      `
Examples:
  ${NPX} connections add notion
  ${NPX} connections add google-workspace --account you@example.com   # turn on its Google APIs, then allow access
  ${NPX} connections add t3code --url http://100.101.102.103:3773   # one per T3 server; have a T3 pairing code ready
  ${NPX} connections add https://mcp.example.com/mcp --access read
  ${NPX} connections add http://127.0.0.1:8787/mcp      # asks before allowing a server on this machine`,
    )
    .action(async (target: string, o: import("./manage.ts").AddFlags & { data?: string }) => {
      const { addConnection } = await import("./manage.ts");
      process.exitCode = await withApi(o, (deps) => addConnection(target, o, deps));
    });

  dataOption(connections.command("list").description("list connections with their status and access")).action(async (o: { data?: string }) => {
    const { listConnections } = await import("./manage.ts");
    process.exitCode = await withApi(o, (deps) => listConnections(deps));
  });

  dataOption(connections.command("reconnect").description("sign in again (OAuth) or replace the key (header)").argument("<name>", "the connection's name"))
    .option("--paste", "paste the address the browser lands on (automatic over SSH)")
    .option("--header <name>", "header connections: the header's name (default: asks, Authorization)")
    .action(async (slug: string, o: { data?: string; paste?: boolean; header?: string }) => {
      const { reconnectConnection } = await import("./manage.ts");
      process.exitCode = await withApi(o, (deps) => reconnectConnection(slug, o, deps));
    });

  dataOption(connections.command("disable").description("turn a connection off at once (the kill switch); turn it back on in the console").argument("<name>", "the connection's name"))
    .option("-y, --yes", "don't ask")
    .action(async (slug: string, o: { data?: string; yes?: boolean }) => {
      const { disableConnection } = await import("./manage.ts");
      process.exitCode = await withApi(o, (deps) => disableConnection(slug, deps));
    });

  dataOption(
    connections
      .command("rename")
      .description("change a connection's short name (agents see its tools as <name>__<tool>) or its display name")
      .argument("<name>", "the connection's current short name (or its id)"),
  )
    .option("--slug <new>", "the new short name: 1-24 lowercase letters, digits and dashes (calls by the old tool names stop working)")
    .option("--name <display-name>", "a new display name")
    .option("-y, --yes", "don't ask")
    .action(async (target: string, o: { data?: string; yes?: boolean; slug?: string; name?: string }) => {
      const { renameConnection } = await import("./manage.ts");
      process.exitCode = await withApi(o, (deps) => renameConnection(target, o, deps));
    });

  dataOption(connections.command("remove").description("remove a connection and delete its credentials").argument("<name>", "the connection's name"))
    .option("-y, --yes", "don't ask")
    .action(async (slug: string, o: { data?: string; yes?: boolean }) => {
      const { removeConnection } = await import("./manage.ts");
      process.exitCode = await withApi(o, (deps) => removeConnection(slug, deps));
    });

  dataOption(
    program
      .command("import", { hidden: !CONNECTIONS_VISIBLE })
      .description("move an agent tool's MCP servers into xaq: one connection each, credentials moved into xaq")
      .summary("import MCP servers from Hermes, Claude Code, Cursor or Codex")
      .helpGroup(GROUP)
      .requiredOption("--from <client>", "hermes, claude-code, cursor or codex"),
  )
    .option("--dry-run", "print exactly what would be created and changed, and change nothing")
    .option("--access <level>", "for every imported connection: full, ask (the default) or read")
    .option("--agent <name>", 'an agent that gets them (repeatable; default: all agents; "all")', collect)
    .option("--profile <name>", "the agent profile setup-mcp uses for the single xaq entry (default \"default\")")
    .option("--allow-private <origin>", "allow this exact scheme://host:port on this machine or a private network without asking (repeatable; --yes never does)", collect)
    .option("-y, --yes", "answer yes to the confirmations (scripts); never to a private-network allow or a project's .mcp.json servers")
    .addHelpText(
      "after",
      `
Reads: hermes ~/.hermes/config.yaml mcp_servers (+ ~/.hermes/.env) · claude-code ~/.claude.json and ./.mcp.json ·
cursor ~/.cursor/mcp.json · codex ~/.codex/config.toml. Static headers move into xaq (encrypted); OAuth
servers are created needing Connect (their tokens stay in the client); local (stdio) servers aren't supported yet
and stay where they are. Servers on this machine or a private network are created only after you confirm the exact
host:port. Then it offers setup-mcp --tool <client>, which replaces the entries that now work through xaq
with the single xaq entry, after a timestamped backup. The entry keeps the name the profile already uses ("xaq", or
"${LEGACY_PRODUCT}" for a profile set up before the rename), so Hermes routes and cron jobs confined to it keep working.

Examples:
  ${NPX} import --from hermes --dry-run
  ${NPX} import --from hermes`,
    )
    .action(async (o: import("./import.ts").ImportFlags & { data?: string }) => {
      const { runImport } = await import("./import.ts");
      const self = await selfOrigins(dataDirOf(o));
      if (o.dryRun) {
        // Read-only: the admin channel (when the daemon runs) only lists existing connections.
        const { TerminalPrompter } = await import("./prompt.ts");
        const { openAdminChannel } = await import("./admin.ts");
        const { ConnectionsApi } = await import("./api.ts");
        let channel: import("./admin.ts").AdminChannel | null = null;
        try {
          process.exitCode = await runImport(o, {
            prompter: new TerminalPrompter(!!o.yes),
            openApi: () => new ConnectionsApi((channel = openAdminChannel({ dataDir: dataDirOf(o) }))),
            selfOrigins: self,
          });
        } finally {
          (channel as import("./admin.ts").AdminChannel | null)?.close();
        }
        return;
      }
      process.exitCode = await withApi(o, (deps) => runImport(o, { prompter: deps.prompter, openApi: () => deps.api, selfOrigins: self }));
    });
}
