import { existsSync, rmdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { hostname, userInfo } from "node:os";
import { type ServerType, serve } from "@hono/node-server";
import open from "open";
import pc from "picocolors";
import { createApp, hasMcp } from "./app.ts";
import { currentSetupToken } from "./auth/index.ts";
import { type Config, type ConfigInput, loadConfig, resolveDataDir } from "./config.ts";
import type { AppContext } from "./context.ts";
import { acquireInstanceLock, assertMasterKeyUsable, cliCommand, type InstanceLock, serviceInstallCommand } from "./instance.ts";
import { startMaintenance } from "./maintenance.ts";
import { recommendedNodeWarning } from "./service-node.ts";
import { consoleUrls, isPrivateIPv4, isWildcardHost, loopbackUrl, networkAddresses } from "./urls.ts";
import { errorMessage } from "./util/errors.ts";
import { createAppContext, type ServiceOverrides, startServices, stopServices } from "./wire.ts";

export interface StartOptions {
  config: Config;
  /** Replace services with fakes (tests). */
  overrides?: ServiceOverrides;
  /** Console build directory (defaults to dist/web). */
  webDir?: string;
  /** Called once the port is bound and the app is serving, before services start (prints the banner). */
  onReady?: (ctx: AppContext, info: { mcp: boolean }) => void;
}

export interface RunningServer {
  /** Base URL reachable from this machine, e.g. http://127.0.0.1:54321. */
  url: string;
  ctx: AppContext;
  server: ServerType;
  /** Stops accepting requests, stops services and closes the database. Idempotent. */
  close(): Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

let inspectorSignalIgnored = false;

/**
 * SIGUSR1 makes Node open its inspector on 127.0.0.1:9229, and anything that can signal this process (a code
 * extension's child is the same user; the permission model doesn't cover signals) could then run code in xaq and read
 * master.key. With a listener installed, Node doesn't start the inspector. `--disable-sigusr1` would do it too, but
 * xaq can't choose its own Node flags (it starts as `node dist/cli.js` or through npx) and 22.13 lacks it. The
 * children are also stopped from sending signals at all (server/extensions/host/spawn.ts, CHILD_PRELOAD).
 */
export function ignoreInspectorSignal(): void {
  if (inspectorSignalIgnored) return;
  inspectorSignalIgnored = true;
  process.on("SIGUSR1", () => {});
}

/**
 * Binds the port first (so a busy port leaves nothing behind), then takes the data directory's
 * instance lock, checks the master key against stored secrets, builds the context and the app,
 * and finally starts services (so a second instance never runs ingest against the same data).
 * Use `port: 0` in tests; `config.port` is updated to the bound port.
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  ignoreInspectorSignal();
  const { config } = opts;
  type Fetch = Parameters<typeof serve>[0]["fetch"];
  // Distinguishable from a real HealthResponse, so `service install` keeps waiting.
  let handler: Fetch = () => Response.json({ status: "starting" }, { status: 503, headers: { "retry-after": "1" } });
  let server: ServerType;
  try {
    server = await listen((req, env) => handler(req, env), config.host, config.port);
  } catch (err) {
    throw friendlyListenError(err, config.port);
  }
  config.port = (server.address() as AddressInfo).port;
  const closeServer = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      // SSE streams and long polls would otherwise hold the server open.
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    });

  let lock: InstanceLock;
  let ctx: AppContext;
  let mcp: boolean;
  try {
    lock = acquireInstanceLock(config);
    try {
      assertMasterKeyUsable(config);
      ctx = createAppContext(config, opts.overrides);
    } catch (err) {
      lock.release();
      throw err;
    }
    try {
      const app = createApp(ctx, { webDir: opts.webDir });
      mcp = hasMcp(app);
      handler = (req, env) => app.fetch(req, env);
    } catch (err) {
      ctx.db.close();
      lock.release();
      throw err;
    }
  } catch (err) {
    await closeServer();
    throw err;
  }
  opts.onReady?.(ctx, { mcp });

  let stopMaintenance = () => {};
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stopMaintenance();
      await closeServer();
      await stopServices(ctx);
      lock.release();
    })());

  try {
    await startServices(ctx);
  } catch (err) {
    await close();
    throw err;
  }
  stopMaintenance = startMaintenance(ctx);
  return { url: loopbackUrl(config.host, config.port), ctx, server, close };
}

function listen(fetch: Parameters<typeof serve>[0]["fetch"], hostname: string, port: number): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, hostname, port }, () => {
      server.off("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });
}

function friendlyListenError(err: unknown, port: number): Error {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EADDRINUSE") return new Error(`Port ${port} is already in use (is xaq already running?). Try --port <port>.`);
  if (code === "EACCES") return new Error(`Not allowed to listen on port ${port}. Use a port above 1024, e.g. --port 8425.`);
  if (code === "EADDRNOTAVAIL") return new Error(`Can't bind to that address. Check --host.`);
  return err instanceof Error ? err : new Error(String(err));
}

export interface RunOptions extends ConfigInput {
  /** Open the setup link in a browser on first run. */
  open?: boolean;
  version: string;
}

/** `xaq start`: runs in the foreground until SIGINT/SIGTERM. */
export async function runForeground(opts: RunOptions): Promise<void> {
  const dataDir = resolveDataDir(opts.dataDir, { quiet: true });
  const existed = existsSync(dataDir);
  const config = loadConfig(opts, opts.version);
  let running: RunningServer;
  try {
    running = await startServer({ config, onReady: (ctx, info) => printBanner(ctx, info) });
  } catch (err) {
    // Don't leave an empty data directory behind when we never got going (e.g. the port was busy).
    if (!existed) {
      try {
        rmdirSync(dataDir);
      } catch {
        // Not empty: keep it.
      }
    }
    throw err;
  }

  const nodeWarning = startupNodeWarning(config);
  if (nodeWarning) console.warn(`  Warning: ${nodeWarning}\n`);

  const token = currentSetupToken(running.ctx);
  if (token && opts.open && process.stdout.isTTY && !config.dev && !config.service) {
    openBrowser(`${consoleUrls(config.host, config.port)[0]}/setup?token=${token}`);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.log(pc.dim(`\n  Stopping xaq…`));
      setTimeout(() => {
        console.error(`xaq did not stop within ${SHUTDOWN_TIMEOUT_MS / 1000} s; exiting anyway.`);
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS).unref();
      running.close().then(
        () => process.exit(0),
        (err) => {
          console.error(errorMessage(err));
          process.exit(1);
        },
      );
    });
  }
}

/**
 * What the daemon logs once at start when its Node is below RECOMMENDED_NODE (see recommendedNodeWarning), or null.
 * Under the service the fix is to run `service install` again (it records the Node); otherwise to restart xaq.
 */
export function startupNodeWarning(config: Pick<Config, "dataDir" | "host" | "port" | "service">, version = process.versions.node): string | null {
  return recommendedNodeWarning(version, config.service ? serviceInstallCommand(config) : undefined);
}

function printBanner(ctx: AppContext, info: { mcp: boolean }): void {
  console.log(bannerLines(ctx, info).join("\n") + "\n");
}

/** What the banner needs to know about the machine; injectable for tests. */
export interface BannerEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Non-internal IPv4 addresses (see networkAddresses). */
  addresses: string[];
  hostname: string;
  username: string;
}

function currentBannerEnv(): BannerEnv {
  // Under sudo, USER is root; the person at the keyboard is SUDO_USER.
  let username = process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || "";
  try {
    username ||= userInfo().username;
  } catch {
    // No passwd entry (some containers): leave it out of the ssh command.
  }
  return { env: process.env, platform: process.platform, addresses: networkAddresses(), hostname: hostname(), username };
}

const overSsh = (e: Pick<BannerEnv, "env">) => !!(e.env.SSH_CONNECTION || e.env.SSH_CLIENT || e.env.SSH_TTY);

/** True over SSH, or on Linux without a graphical session: a browser here won't reach the user. */
export function isHeadless(e: Pick<BannerEnv, "env" | "platform">): boolean {
  return overSsh(e) || (e.platform === "linux" && !e.env.DISPLAY && !e.env.WAYLAND_DISPLAY);
}

/**
 * True for addresses the user's laptop probably can't dial directly: loopback, RFC 1918, link-local,
 * IPv6 ULA (behind NAT, a jump host or a cloud load balancer the session's server IP is often one of
 * these). Tailscale's 100.64.0.0/10 is reachable from the tailnet, so it counts as usable.
 */
function isUnroutableIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^::ffff:(?=\d+\.)/, "");
  if (v.includes(":")) return v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  const [a = -1, b = -1] = v.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * The `ssh -L` command that makes this server's port reachable as localhost on the user's own
 * machine, built from SSH_CONNECTION ("client_ip client_port server_ip server_port"). The server IP is
 * only shown when the laptop can plausibly reach it; otherwise a placeholder stands in.
 */
export function tunnelCommand(config: Pick<Config, "host" | "port">, e: BannerEnv): string {
  const [, , serverIp, sshPort] = e.env.SSH_CONNECTION?.trim().split(/\s+/) ?? [];
  const host = serverIp && !isUnroutableIp(serverIp) ? `${e.username ? `${e.username}@` : ""}${serverIp}` : "<the host you ssh to>";
  const bound = config.host.trim().toLowerCase();
  const target = isWildcardHost(bound) || bound === "localhost" || bound === "::1" || bound.startsWith("127.") ? "localhost" : bound;
  const forward = `${config.port}:${target.includes(":") ? `[${target}]` : target}:${config.port}`;
  const port = sshPort && sshPort !== "22" && /^\d+$/.test(sshPort) ? ` -p ${sshPort}` : "";
  return `ssh${port} -L ${forward} ${host}`;
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Two loopback spellings of the same server: same scheme and port, and the same host or one of them
 * localhost (which reaches either family). 127.0.0.1 and [::1] are different IP families, so a server
 * bound to one isn't reachable at the other: never the same.
 */
export function sameLoopbackServer(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    const hosts = LOOPBACK_NAMES.has(x.hostname) && LOOPBACK_NAMES.has(y.hostname) && (x.hostname === y.hostname || x.hostname === "localhost" || y.hostname === "localhost");
    return hosts && x.protocol === y.protocol && x.port === y.port && (y.pathname === "/" || y.pathname === "");
  } catch {
    return false;
  }
}

/** The startup banner: what is running, and the one thing to do next. */
export function bannerLines(ctx: AppContext, info: { mcp: boolean }, e: BannerEnv = currentBannerEnv()): string[] {
  const { config } = ctx;
  const local = config.dev ? "http://localhost:5173" : null;
  const urls = local ? [local] : isWildcardHost(config.host) ? [`http://localhost:${config.port}`, ...e.addresses.map((a) => `http://${a}:${config.port}`)] : consoleUrls(config.host, config.port);
  const token = currentSetupToken(ctx);
  const out: string[] = ["", `  ${pc.bold("xaq is running.")} ${pc.dim(`v${config.version} · data in ${config.dataDir}`)}`, ""];

  if (token && config.service) {
    // Service logs are often readable by others (journal, log files): never print the token there.
    out.push(
      `  ${pc.yellow("Not set up yet.")} Get the setup link with: ${pc.bold(cliCommand(`reset-password --data ${shellQuote(config.dataDir)}`))}`,
    );
  } else if (token) {
    const link = (url: string) => `${url}/setup?token=${token}`;
    out.push(`  Open this link to finish setup (the console walks you through what to connect and your first agent):`, "");
    out.push(`    ${pc.cyan(link(urls[0]!))}`, "");
    if (urls.length > 1) {
      out.push(`  ${pc.dim("Or, from another machine:")}`);
      for (const url of urls.slice(1)) out.push(`    ${pc.dim(link(url))}`);
      out.push("");
    }
    const exposed = isWildcardHost(config.host) ? e.addresses.filter((a) => !isPrivateIPv4(a)) : [];
    if (exposed.length) {
      out.push(
        `  ${pc.yellow("Heads up:")} anyone reaching ${exposed.join(", ")}:${config.port} could claim this first. Open the link now, or restart with --host 127.0.0.1.`,
      );
    }
    const headless = !config.dev && isHeadless(e);
    if (headless && overSsh(e)) {
      // The tunnel makes the port local on the laptop, so a loopback link above works there as is.
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(urls[0]!).hostname);
      const where = loopback ? "the link above" : pc.cyan(link(`http://localhost:${config.port}`));
      out.push(
        `  ${pc.yellow("No browser here?")} On your laptop run ${pc.bold(tunnelCommand(config, e))} (your usual ssh host or alias works), then open ${where} in its browser.`,
      );
    } else if (headless) {
      out.push(`  ${pc.yellow("No browser here?")} Open the link from a machine with a browser that can reach this one.`);
    }
    if (exposed.length || headless) out.push("");
  } else {
    const publicUrl = ctx.settings.publicUrl();
    // One loopback host: bound to 127.0.0.1 with the address saved as localhost (or the other way round),
    // show the saved one. Its links (and the session cookie of the console opened there) are what the CLI uses.
    const consoleUrl = !config.dev && sameLoopbackServer(urls[0]!, publicUrl) ? publicUrl : urls[0]!;
    out.push(`  ${pc.dim("Console")}  ${pc.cyan(consoleUrl)}`);
    if (!config.dev && consoleUrl !== publicUrl && !urls.includes(publicUrl)) out.push(`           ${pc.cyan(publicUrl)}`);
    if (info.mcp) out.push(`  Agents connect to ${pc.cyan(`${publicUrl}/mcp`)}`);
    out.push("");
  }

  if (config.dev) out.push(pc.dim(`  Dev mode: API on :${config.port}, console via Vite on :5173.`), "");
  else if (!config.service) {
    out.push(pc.dim(`  Keep this terminal open; Ctrl-C stops it. Run it in the background later with: ${serviceInstallCommand(config)}`));
  }
  return out;
}

function openBrowser(url: string): void {
  if (isHeadless({ env: process.env, platform: process.platform })) return;
  try {
    open(url).then(
      (child) => child.on("error", () => {}),
      () => {},
    );
  } catch {
    // No browser available: the link is printed above.
  }
}
