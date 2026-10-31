import { closeSync, constants, fchmodSync, lstatSync, openSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import pc from "picocolors";
import type { AgentSelf, AgentTool, PairingPoll, PairingStart, PairingStartInput } from "../../shared/agent-api.ts";
import { ApiError, clientInfo, getSelf, pollPairing, startPairing } from "./api.ts";
import { describeGrants, hasAccess } from "./grants.ts";
import { writeClaudeMcpConfig } from "./mcpheader.ts";
import { isServiceInstalled } from "./service.ts";
import { manualSteps, setupMcp, type McpSetupResult } from "./mcpsetup.ts";
import { defaultConsumer } from "./options.ts";
import { profilePath } from "./paths.ts";
import { loadProfile, type Profile, profileExists, saveProfile } from "./profile.ts";
import { recipe, shellQuote, TOOL_LABELS, TOOLS } from "./recipes.ts";
import { checkTransport, insecureBanner, normalizeDaemonUrl } from "./transport.ts";
import { box, formatDuration, safeText, StatusLine } from "./ui.ts";
import { NPX } from "./version.ts";

export interface ConnectFlags {
  name?: string;
  tool?: string;
  account?: string[];
  reason?: string;
  insecure?: boolean;
  force?: boolean;
  setupMcp?: boolean;
  /** Also write the output (plain text) to this file: created 0600, never through a symlink or someone else's file. */
  log?: string;
}

/** Exit codes, so scripts (and agents setting themselves up) can tell outcomes apart. */
export const CONNECT_EXIT = { approved: 0, error: 1, denied: 2, expired: 3, consumed: 4, cancelled: 130 } as const;

export interface ConnectOptions {
  /** Tests: poll faster than the server's interval. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
  handleSignals?: boolean;
}

export function parseTool(value: string | undefined): AgentTool {
  if (value === undefined) return "other";
  const v = value.trim().toLowerCase().replace(/^claude$/, "claude-code");
  if (!(TOOLS as readonly string[]).includes(v)) throw new Error(`Unknown --tool "${value}". Choose one of: ${TOOLS.join(", ")}.`);
  return v as AgentTool;
}

const shortHost = () => hostname().replace(/\.(local|lan|home)$/i, "");

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** --log target (fd), written in parallel with the console. */
let logFd: number | null = null;
const toLog = (s: string) => {
  if (logFd !== null) writeSync(logFd, stripAnsi(s) + "\n");
};
const out = (s = "") => {
  process.stdout.write(`${s}\n`);
  toLog(s);
};
const err = (s = "") => {
  process.stderr.write(`${s}\n`);
  toLog(s);
};

/**
 * Opens --log safely: a new file is created 0600 with O_EXCL; an existing one (e.g. from `mktemp`) is
 * only reused if it is a regular file owned by us, opened without following symlinks. This is what
 * keeps another local user from pre-creating the log and reading the pairing as it happens.
 */
export function openConnectLog(path: string): number {
  try {
    return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = lstatSync(path);
  const uid = process.getuid?.();
  if (!st.isFile() || (uid !== undefined && st.uid !== uid)) throw new Error(`Refusing --log ${path}: it exists and is not a regular file owned by you.`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  fchmodSync(fd, 0o600);
  return fd;
}

export async function runConnect(rawUrl: string, flags: ConnectFlags, opts: ConnectOptions = {}): Promise<number> {
  if (flags.log) logFd = openConnectLog(flags.log);
  try {
    return await connect(rawUrl, flags, opts);
  } finally {
    if (logFd !== null) closeSync(logFd);
    logFd = null;
  }
}

async function connect(rawUrl: string, flags: ConnectFlags, opts: ConnectOptions): Promise<number> {
  const url = normalizeDaemonUrl(rawUrl);
  const verdict = await checkTransport(url, { insecure: flags.insecure });
  if (verdict.warning) err(insecureBanner(verdict.warning));

  let replacing: Profile | null = null;
  if (profileExists() && flags.force) {
    try {
      replacing = loadProfile();
    } catch {
      // Unreadable: it's being replaced anyway.
    }
  }
  if (profileExists() && !flags.force) {
    let who = "";
    try {
      const p = loadProfile();
      who = ` (agent "${safeText(p.agentName)}" on ${p.url})`;
    } catch {
      // Unreadable: still don't overwrite silently.
    }
    throw new Error(`This machine is already paired${who}. Replace the pairing with --force.`);
  }
  const tool = parseTool(flags.tool);
  // --force keeps the listener's consumer, so the server-side cursor carries on (no replay, no gap).
  const consumer = replacing?.consumer ?? defaultConsumer();
  const name = (flags.name?.trim() || `${tool === "other" ? "Agent" : TOOL_LABELS[tool]} on ${shortHost()}`).slice(0, 80);

  const input: PairingStartInput = {
    name,
    requested: {
      ...(flags.account?.length ? { accounts: flags.account } : {}),
      ...(flags.reason ? { reason: flags.reason } : {}),
    },
    client: { ...clientInfo(), tool },
  };

  let start: PairingStart;
  try {
    start = await startPairing(url, input);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      throw new Error(`${url} doesn't support pairing (no /agent/v1/pairings). Is this a xaq daemon, and is it up to date?`);
    }
    if (e instanceof ApiError) throw new Error(`${e.message}${e.hint ? `\n  ${e.hint}` : ""}`);
    throw e;
  }

  const links = approveLinks(url, start);
  out();
  out(
    box([
      pc.bold("Approve this agent in the xaq console"),
      "",
      `Code:   ${pc.bold(pc.yellow(safeText(start.userCode, 40)))}`,
      `Open:   ${pc.cyan(safeText(links.primary, 300))}`,
      ...(links.publicUrl
        ? [`  or:   ${pc.cyan(safeText(links.publicUrl, 300))}`, pc.gray(`        (first: the address this CLI used; second: the console's public URL setting)`)]
        : []),
      `Agent:  ${safeText(name)}`,
      "",
      pc.gray("Only approve if the console shows this exact code."),
    ]),
  );
  out();

  // Ctrl-C: stop cleanly. Nothing was approved; the request just expires.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const onSigint = () => ac.abort();
  if (opts.handleSignals) process.on("SIGINT", onSigint);

  const started = Date.now();
  const expiresAt = Date.parse(start.expiresAt) || started + 10 * 60_000;
  let interval = Math.max(1, start.interval || 5) * 1000;
  let note = "";
  const status = new StatusLine(process.stderr);
  status.start(
    () =>
      `Waiting for approval · ${formatDuration(Date.now() - started)} elapsed · code expires in ${formatDuration(expiresAt - Date.now())}${note ? pc.yellow(` · ${note}`) : ""}`,
  );

  let result: PairingPoll | null = null;
  try {
    while (!ac.signal.aborted) {
      await sleep(opts.pollIntervalMs ?? interval, ac.signal);
      if (ac.signal.aborted) break;
      try {
        const r = await pollPairing(url, start.deviceCode);
        note = "";
        if (r.status === "pending") continue;
        if (r.status === "slow_down") {
          // The server asks for more room between polls.
          interval = Math.max(interval + 1000, (r.interval || 0) * 1000);
          continue;
        }
        result = r;
        break;
      } catch (e) {
        if (e instanceof ApiError && e.status === 429) {
          interval += 5000;
          note = "rate limited, slowing down";
          continue;
        }
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408) {
          throw new Error(`${e.message}${e.hint ? `\n  ${e.hint}` : ""}`);
        }
        // Network trouble or a 5xx: keep trying until the code expires.
        note = "can't reach the daemon, retrying";
        if (Date.now() > expiresAt + 30_000) {
          result = { status: "expired" };
          break;
        }
      }
    }
  } finally {
    status.stop();
    if (opts.handleSignals) process.off("SIGINT", onSigint);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  if (!result) {
    err(pc.yellow("Cancelled. Nothing was approved; the code expires on its own."));
    return CONNECT_EXIT.cancelled;
  }

  switch (result.status) {
    case "denied":
      err(pc.red(`✖ The request was denied in the console${result.note ? `: ${safeText(result.note, 300)}` : "."}`));
      return CONNECT_EXIT.denied;
    case "expired":
      err(pc.red("✖ The code expired before it was approved."));
      err(`  Run the same command again for a fresh code, and approve it within ${formatDuration(Date.parse(start.expiresAt) - started)}.`);
      return CONNECT_EXIT.expired;
    case "consumed":
      err(pc.red("✖ This pairing was already completed and its key handed out once (perhaps by an earlier run of this command)."));
      err(`  For safety the key is never delivered twice. Start over with \`${NPX} connect\`, or rotate the agent's key in the console.`);
      return CONNECT_EXIT.consumed;
    case "approved":
      break;
    default:
      throw new Error(`Unexpected pairing status ${JSON.stringify((result as { status: unknown }).status)}`);
  }

  // --force keeps the listener settings; only the pairing (daemon, key, agent) is replaced.
  const kept: Partial<Profile> = replacing
    ? { exec: replacing.exec, types: replacing.types, notFrom: replacing.notFrom, allCategories: replacing.allCategories, includeBody: replacing.includeBody }
    : {};
  const profile: Profile = {
    ...kept,
    url,
    apiKey: result.apiKey,
    agentId: result.agent.id,
    agentName: result.agent.name,
    consumer,
    ...(verdict.kind === "insecure" ? { insecure: true } : {}),
    tool,
    // Derived from the URL the user chose and transport-checked; the daemon's advertised URLs come
    // from its publicUrl setting and are never trusted with the key.
    mcpUrl: `${url}/mcp`,
    skillUrl: `${url}/skill.md`,
    createdAt: new Date().toISOString(),
  };
  const path = saveProfile(profile);
  writeClaudeMcpConfig(profile.mcpUrl!);
  if (typeof result.mcpUrl === "string" && result.mcpUrl !== profile.mcpUrl) {
    err(
      pc.yellow(
        `! The daemon advertises its MCP endpoint as ${safeText(result.mcpUrl, 200)} (its "public URL" setting); using ${profile.mcpUrl}, the address you connected to. Set the public URL in the console if agents should use another address.`,
      ),
    );
  }

  out(`${pc.green("✔")} Approved. Agent ${pc.bold(safeText(result.agent.name))} ${pc.gray(`(${result.agent.id})`)} is connected.`);
  out(`  Key saved to ${pc.cyan(path)} ${pc.gray("(mode 0600; never displayed. Rotate it in the console if it leaks.)")}`);
  if (replacing?.exec) out(`  Kept the listener settings. Restart the listener to use the new key${isServiceInstalled() ? `: ${NPX} listen service install` : "."}`);
  if (replacing && replacing.agentId !== profile.agentId) {
    err(
      pc.yellow(
        `! Replaced the pairing with agent "${safeText(replacing.agentName)}" (${replacing.agentId}). Its key still works until you rotate it or delete that agent in the console.`,
      ),
    );
  }

  const access = await printGrants(url, profile.apiKey);

  let mcp: McpSetupResult | null = null;
  if (flags.setupMcp) {
    mcp = setupMcp(tool, profile, path);
    printMcpResult(mcp);
  }
  // Mail-only steps (the listener's mail wording, the test email) only when it has a mailbox; unknown = as before.
  printNextSteps(profile, tool, mcp, { mail: access ? access.grants.length > 0 : true });
  return CONNECT_EXIT.approved;
}

/**
 * The approve link. The daemon builds it from its public URL setting (default http://localhost:<port>),
 * which may not be the address this CLI reached it at (127.0.0.1, a LAN IP, an SSH tunnel's port): then
 * the link on the address we used comes first, and the public-URL one is shown as well.
 */
export function approveLinks(url: string, start: Pick<PairingStart, "verificationUrl" | "userCode">): { primary: string; publicUrl: string | null } {
  let advertised: URL;
  try {
    advertised = new URL(start.verificationUrl);
  } catch {
    return { primary: start.verificationUrl, publicUrl: null };
  }
  const ours = new URL(url);
  if (advertised.origin === ours.origin) return { primary: start.verificationUrl, publicUrl: null };
  // Same page on our address: keep a path prefix we connected through (reverse proxy), else swap the origin.
  const rest = `${advertised.search}${advertised.hash}`;
  const primary = advertised.pathname.endsWith("/approvals") ? `${url}/approvals${rest}` : `${ours.origin}${advertised.pathname}${rest}`;
  return { primary, publicUrl: start.verificationUrl };
}

/** What the approver actually granted, in plain words (the console's choice decides, not the request). Null when unreadable. */
async function printGrants(url: string, key: string): Promise<AgentSelf | null> {
  try {
    const self = await getSelf(url, key, 8000);
    out(`  ${pc.bold("Access granted")} ${pc.gray("(chosen by whoever approved it; change it in the console under Agents):")}`);
    for (const line of describeGrants(self.grants, self.connections)) out(`    ${hasAccess(self) ? line : pc.yellow(line)}`);
    return self;
  } catch (e) {
    err(pc.yellow(`! Couldn't read this agent's access yet (${e instanceof Error ? e.message.split("\n")[0] : String(e)}). Check it with: ${NPX} listen status`));
    return null;
  }
}

export function printMcpResult(r: McpSetupResult): void {
  if (r.ok) out(`${r.dryRun ? pc.cyan("○") : pc.green("✔")} ${r.message}`);
  else err(`${pc.yellow("!")} ${r.message}`);
  if (r.ok && r.changes?.length) {
    // Indented lines are file contents; the rest are steps.
    for (const l of r.changes) out(l.startsWith(" ") ? pc.gray(`  ${l}`) : `  - ${l}`);
  }
  if (r.backup) out(pc.gray(`  Backup: ${r.backup}`));
  if (!r.ok && r.manual?.length) {
    out("  Do it by hand:");
    for (const l of r.manual) out(`    ${l}`);
  }
  if (r.ok && r.verify?.length) out(`  ${r.dryRun ? "Afterwards, check it with" : "Check it with"}: ${r.verify.map((v) => pc.cyan(v)).join("; ")}`);
  if (r.ok) for (const n of r.notes ?? []) out(`  ${n}`);
}

function skillCommand(tool: AgentTool, url: string): string {
  switch (tool) {
    case "claude-code":
      return `${NPX} skill install --target claude --url ${url}`;
    case "codex":
      return `${NPX} skill install --target codex --url ${url}`;
    case "hermes":
      return `${NPX} skill install --target ~/.hermes/skills/email --url ${url}`;
    case "cursor":
      return `${NPX} skill install --target agents --url ${url}`;
    default:
      // install, not `skill print > SKILL.md`: a redirect would capture npx's "Ok to proceed?" prompt into the file.
      return `${NPX} skill install --target ./skills --url ${url}`;
  }
}

export function printNextSteps(profile: Profile, tool: AgentTool, mcp: McpSetupResult | null, o: { mail?: boolean } = {}): void {
  const mail = o.mail !== false;
  const claude = tool === "claude-code";
  const label = tool === "other" ? "your agent" : TOOL_LABELS[tool];
  const r = recipe(tool);
  // Claude Code uses --recipe: no `$(…)` for npx's install prompt to hide in, and the command stays the CLI's own.
  const target = claude ? "--recipe claude-code" : `--exec ${shellQuote(r.exec)}`;
  out();
  out(pc.bold("Next steps"));
  let n = 1;
  if (mcp?.ok) {
    out(`  ${n++}. ${label} has the xaq MCP tools ${pc.gray(`(restart it if it's running)`)}.`);
  } else if (claude) {
    out(`  ${n++}. Give ${label} the xaq MCP tools without ever seeing the key:`);
    out(`       ${pc.cyan(`${NPX} setup-mcp`)}  ${pc.gray("(add --dry-run to see exactly what it changes first)")}`);
  } else {
    out(`  ${n++}. Point ${label}'s MCP client at the xaq tools:`);
    for (const l of manualSteps(profile.mcpUrl ?? `${profile.url}/mcp`, profilePath())) out(pc.gray(`     ${l}`));
  }
  out(`  ${n++}. Install the xaq skill so ${label} knows the rules:`);
  out(`       ${pc.cyan(skillCommand(tool, profile.url))}`);
  if (mail) {
    out(`  ${n++}. Wake ${label} when mail arrives. First try it in the foreground (Ctrl-C stops it):`);
    out(`       ${pc.cyan(`${NPX} listen ${target}`)}`);
    out(pc.gray(`     Only new mail wakes it (message.received), not mail you send. Change it with --types, e.g. --types thread.reply_received (only replies to threads you sent) or --types all.`));
    out(pc.gray(`     Gmail's Promotions, Social and Forums tabs are skipped (--all-categories to include them); skip more with --not-from '*@github.com'.`));
  } else {
    // No mailbox: its connections' events (a connection that needs reconnecting).
    out(`  ${n++}. Wake ${label} when one of its connections needs it. First try it in the foreground (Ctrl-C stops it):`);
    out(`       ${pc.cyan(`${NPX} listen ${target} --types connection.auth_failed,connection.expiring`)}`);
    out(pc.gray(`     Add an integration's own events too (<extension>.<event>, if it emits any).`));
  }
  out(pc.gray(`     What the woken agent can use: ${r.confinement}.`));
  out(pc.gray(`     Where its output goes: ${r.output}`));
  for (const note of r.notes) out(pc.gray(`     ${note}`));
  if (mail) {
    out(`  ${n++}. Check that it works: in the console's setup, the "Check that it works" step sends a test email.`);
    out(`     Watch it arrive in the foreground listener as ${pc.cyan("→ #… message.received")} followed by one ${pc.green("✓")} line once ${label} handled it.`);
  }
  out(`  ${n++}. Then keep it running in the background (systemd / launchd, starts at login; stop the foreground one first; saves the flags):`);
  out(`       ${pc.cyan(`${NPX} listen service install ${target}`)}`);
  out(`       ${pc.cyan(`${NPX} listen status`)}  ${pc.gray("(connection, cursor, recent events and the access granted)")}`);
  out();
}
