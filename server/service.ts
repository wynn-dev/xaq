import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CLI_NAME, NPM_PACKAGE as PACKAGE } from "../shared/types.ts";
import { readSetupToken } from "./auth/setup-token.ts";
import { type Config, dataFiles } from "./config.ts";
import { Crypto } from "./crypto.ts";
import { assertMasterKeyUsable, cliCommand, type InstanceInfo, runningInstance, serviceInstallCommand } from "./instance.ts";
import { nodeVersionError } from "./node-check.ts";
import { consoleUrls, loopbackUrl } from "./urls.ts";

/** Installs xaq as a background service: systemd on Linux, launchd on macOS. */

export const SERVICE_NAME = "xaq";
export const LAUNCHD_LABEL = "sh.xaq.daemon";
/** The package a pre-rename listener install put into its app directory (server/listen/service.ts). */
export const LEGACY_PACKAGE = "agentinbox-cli";

/** A service's names: the launchd label and the systemd unit (without `.service`). */
export interface UnitId {
  launchd: string;
  systemd: string;
}
export const DAEMON_UNIT: UnitId = { launchd: LAUNCHD_LABEL, systemd: SERVICE_NAME };
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
/** Package root: one level above the running module (dist/cli.js or server/service.ts). */
export const ROOT = resolve(import.meta.dirname, "..");

/**
 * Settings that come from the environment rather than flags. They are kept in `<data>/service.env`
 * (mode 0600) so re-running `service install` from a shell without them (the documented update
 * path) keeps them. Set one to an empty value to drop it.
 */
export const SERVICE_ENV_KEYS = ["XAQ_MASTER_KEY", "TRUST_PROXY", "XAQ_LOG_LEVEL"] as const;

type ServiceConfig = Pick<Config, "dataDir" | "port" | "host" | "dbPath" | "masterKeyPath">;

/** `service install` options: `node` is --node; `version` a release to install (the console's update job). */
export interface InstallOptions {
  launchdPollMs?: number;
  node?: string;
  version?: string;
}

export const serviceEnvPath = (dataDir: string) => join(dataDir, "service.env");

// ───────────── Pure rendering (unit-tested) ─────────────

export interface ServiceSpec {
  /** Node binary. */
  execPath: string;
  /** The installed dist/cli.js. */
  entry: string;
  dataDir: string;
  port: number;
  host: string;
  /** Extra environment from service.env (SERVICE_ENV_KEYS). */
  extraEnv: Record<string, string>;
  /** systemd: system unit (root) rather than a user unit. */
  system?: boolean;
}

/** Plain variables written into the unit/plist. Secrets never go into the systemd unit. */
function plainEnv(spec: ServiceSpec): Record<string, string> {
  return { XAQ_DATA: spec.dataDir, PORT: String(spec.port), HOST: spec.host, XAQ_SERVICE: "1" };
}

/** systemd word quoting for ExecStart/Environment: double quotes, escaped backslashes, quotes and specifiers. */
export const sdQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/**
 * The systemd unit. Everything from service.env (including XAQ_MASTER_KEY) is loaded with
 * EnvironmentFile=, so the world-readable unit holds no secrets. EnvironmentFile takes an
 * unquoted absolute path (systemd ignores quoted ones), which is why data dirs with whitespace are refused.
 */
export function renderSystemdUnit(spec: ServiceSpec): string {
  const vars = Object.entries(plainEnv(spec))
    .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
    .join("\n");
  const envFile = Object.keys(spec.extraEnv).length ? `\nEnvironmentFile=${serviceEnvPath(spec.dataDir).replace(/%/g, "%%")}` : "";
  // network-online.target only exists for system units; a user unit waiting on it never starts it.
  const network = spec.system ? "\nAfter=network-online.target\nWants=network-online.target" : "";
  return `[Unit]
Description=xaq (MCP broker for AI agents)${network}

[Service]
ExecStart=${sdQuote(spec.execPath)} ${sdQuote(spec.entry)} start --no-open
${vars}${envFile}
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
# The kernel OOM-killing one process (an attachment parser child) must not stop the whole service.
OOMPolicy=continue

[Install]
WantedBy=${spec.system ? "multi-user.target" : "default.target"}
`;
}

/** The launchd plist. Written with mode 0600, since it may carry XAQ_MASTER_KEY. */
/** Escapes text for a plist <string>. */
export const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderLaunchdPlist(spec: ServiceSpec): string {
  const esc = xmlEscape;
  const vars = Object.entries({ ...plainEnv(spec), ...spec.extraEnv })
    .map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`)
    .join("\n");
  const log = esc(dataFiles(spec.dataDir).log);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(spec.execPath)}</string>
    <string>${esc(spec.entry)}</string>
    <string>start</string>
    <string>--no-open</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

/** Parses service.env (KEY=value lines). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/**
 * The service's env-derived settings: the current shell wins, previous install fills the gaps,
 * an explicitly empty value removes the setting.
 */
export function mergeServiceEnv(previous: Record<string, string>, current: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SERVICE_ENV_KEYS) {
    const value = key in current ? current[key] : previous[key];
    if (value) out[key] = value;
  }
  return out;
}

/** Fails early (before anything is touched) when the master key can't work. */
export function validateMasterKey(value: string | undefined): void {
  if (!value) return;
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) throw new Error("not base64");
    new Crypto(Buffer.from(value, "base64"));
  } catch {
    throw new Error("XAQ_MASTER_KEY must be 32 random bytes in base64 (e.g. `openssl rand -base64 32`).");
  }
}

// ───────────── Install ─────────────

function readPreviousEnv(dataDir: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(serviceEnvPath(dataDir), "utf8"));
  } catch {
    return {};
  }
}

function writeServiceEnv(dataDir: string, env: Record<string, string>): void {
  const file = serviceEnvPath(dataDir);
  if (!Object.keys(env).length) {
    rmSync(file, { force: true });
    return;
  }
  for (const [k, v] of Object.entries(env)) {
    if (/[\r\n]/.test(v)) throw new Error(`${k} must be a single line.`);
  }
  writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
}

/** A plain release version (no ranges, tags, URLs or paths): what may be passed as stagePackage's `version`. */
export const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Runs npm in `cwd`, throwing on a non-zero exit (with npm's output in the message when it was captured). */
export type NpmRunner = (args: string[], cwd: string, opts?: { capture?: boolean }) => string;

const runNpm: NpmRunner = (args, cwd, opts) =>
  opts?.capture
    ? execFileSync(npm, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    : (execFileSync(npm, args, { cwd, stdio: "inherit" }), "");

export interface StageOptions {
  where: string;
  requireWeb: boolean;
  /** This exact release from npm (RELEASE_VERSION), rather than `latest` or this source checkout's build. */
  version?: string;
  /**
   * Supply-chain checks for an update nobody watches (the console's update job): install with
   * --ignore-scripts, then refuse unless the package's npm-shrinkwrap.json pins what was installed and
   * `npm audit signatures` verifies the registry signatures and provenance.
   */
  harden?: boolean;
  /** Runs npm (tests fake it). */
  npm?: NpmRunner;
}

/**
 * Installs the package into `staging` (a fresh private npm prefix), so a failed npm install leaves the
 * current install untouched. From an installed package that is the latest release (or `version`); from a
 * source checkout without a `version`, the local build. Returns `staging`. The one install path for the
 * daemon, the listeners and the update job.
 */
export function stagePackage(staging: string, opts: StageOptions): string {
  const run = opts.npm ?? runNpm;
  if (opts.version !== undefined && !RELEASE_VERSION.test(opts.version)) throw new Error(`"${opts.version}" is not a release version.`);
  const fromSource = opts.version === undefined && basename(dirname(ROOT)) !== "node_modules";
  let spec = `${PACKAGE}@${opts.version ?? "latest"}`;
  let tmp: string | undefined;
  if (fromSource) {
    if (!existsSync(join(ROOT, "dist/cli.js")) || (opts.requireWeb && !existsSync(join(ROOT, "dist/web/index.html")))) {
      throw new Error("Run `pnpm build` before installing the service from a source checkout.");
    }
    tmp = mkdtempSync(join(tmpdir(), "xaq-pack-"));
    const out = run(["pack", "--ignore-scripts", "--pack-destination", tmp, "--loglevel=error"], ROOT, { capture: true });
    spec = join(tmp, out.trim().split("\n").pop()!);
  }

  const what = fromSource ? "this build" : opts.version ? `xaq ${opts.version}` : "the latest release";
  console.log(`  Installing ${what} into ${opts.where}…`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "package.json"), '{ "private": true }\n');
  try {
    const hardening = opts.harden ? ["--ignore-scripts"] : [];
    run(["install", spec, "--omit=dev", "--prefer-online", "--no-audit", "--no-fund", ...hardening, "--loglevel=error"], staging);
    if (!existsSync(installedEntry(staging))) throw new Error("the installed package has no dist/cli.js");
    if (opts.version && installedVersion(staging) !== opts.version) throw new Error(`npm installed ${installedVersion(staging) ?? "no version"} instead of ${opts.version}`);
    if (opts.harden) {
      const problems = shrinkwrapProblems(staging);
      if (problems.length) throw new Error(`Refused: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ""}.`);
      try {
        run(["audit", "signatures", "--loglevel=error"], staging, { capture: true });
      } catch (err) {
        throw new Error(`Refused: \`npm audit signatures\` failed: ${commandFailure(err)}`);
      }
    }
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`Installing xaq failed, so the existing service was left as it was. ${err instanceof Error ? err.message : ""}`.trim());
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return staging;
}

/** The version of our package in an install made by stagePackage (`<data>/app`, app.old…), if any. */
export const installedVersion = (app: string): string | null => installedPackageVersion(join(app, "node_modules", PACKAGE));

/**
 * What doesn't match between the installed package's npm-shrinkwrap.json and the tree npm installed next to it:
 * no shrinkwrap at all, or a runtime dependency that is missing, at another version, or pinned without an
 * integrity hash. Empty when the install is exactly what the release pinned. Dev and optional entries are
 * skipped (--omit=dev leaves the first out; the second depend on the platform).
 */
export function shrinkwrapProblems(staging: string): string[] {
  const pkg = join(staging, "node_modules", PACKAGE);
  let wrap: { lockfileVersion?: unknown; packages?: Record<string, { version?: string; integrity?: string; dev?: boolean; optional?: boolean; devOptional?: boolean; link?: boolean }> };
  try {
    wrap = JSON.parse(readFileSync(join(pkg, "npm-shrinkwrap.json"), "utf8"));
  } catch {
    return ["the release has no npm-shrinkwrap.json, so its dependencies aren't pinned"];
  }
  if (typeof wrap.lockfileVersion !== "number" || wrap.lockfileVersion < 2 || !wrap.packages) return ["the release's npm-shrinkwrap.json has no package list (lockfileVersion 2 or later)"];
  const problems: string[] = [];
  for (const [path, meta] of Object.entries(wrap.packages)) {
    if (!path || meta.dev || meta.optional || meta.devOptional || meta.link) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!meta.integrity) problems.push(`${name} is pinned without an integrity hash`);
    // npm installs a shrinkwrapped tree under the package; a dependency hoisted to the top is found there.
    const installed = installedPackageVersion(join(pkg, path)) ?? installedPackageVersion(join(staging, path));
    if (installed === null) problems.push(`${name} ${meta.version ?? ""} wasn't installed`.replace("  ", " "));
    else if (installed !== meta.version) problems.push(`${name} is ${installed}, the shrinkwrap pins ${meta.version}`);
  }
  return problems;
}

function installedPackageVersion(dir: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** The CLI entry inside an install made by stagePackage. */
export const installedEntry = (app: string) => join(app, "node_modules", PACKAGE, "dist/cli.js");

/** Installs into `<dir>/app.new` (see stagePackage). A given `version` (the console's update) gets the supply-chain checks. */
export const stageApp = (dir: string, version?: string): string =>
  stagePackage(join(dir, "app.new"), { where: "the data directory", requireWeb: true, version, harden: version !== undefined });

/**
 * Moves a staged install into place as `app` (the current one becomes `app.old`). `restore()` puts
 * the previous install back; `commit()` deletes it. If the move itself fails, nothing changes.
 */
export function swapIn(staging: string, app: string): { restore(): void; commit(): void } {
  const old = `${app}.old`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(app)) renameSync(app, old);
  try {
    renameSync(staging, app);
  } catch (err) {
    if (existsSync(old)) renameSync(old, app);
    throw err;
  }
  return {
    restore() {
      rmSync(app, { recursive: true, force: true });
      if (existsSync(old)) renameSync(old, app);
    },
    commit() {
      rmSync(old, { recursive: true, force: true });
    },
  };
}

/** Whether `path` is one of our installs (xaq-cli, or the listener's agentinbox-cli from before the rename). */
export const isOwnInstall = (path: string) => [PACKAGE, LEGACY_PACKAGE].some((p) => existsSync(join(path, "node_modules", p)));

/** Deletes `<dir>/app`, `app.new` and `app.old`, but only where they really are our own installs. */
export function removeOwnInstall(dir: string): void {
  for (const name of ["app", "app.new", "app.old"]) {
    const path = join(dir, name);
    if (isOwnInstall(path)) rmSync(path, { recursive: true, force: true });
  }
}


// ───────────── System integration (injectable for tests) ─────────────

export interface ServiceOps {
  platform: NodeJS.Platform;
  /** systemd: install a system unit (running as root) rather than a user unit. */
  root: boolean;
  /** Runs a command, throwing on a non-zero exit. */
  exec(cmd: string, args: string[], opts?: { quiet?: boolean }): void;
  /** Runs a command and returns its stdout, throwing on a non-zero exit. */
  capture(cmd: string, args: string[]): string;
  /** Installs the package (or that `version`) into a staging directory and returns it (see stageApp). */
  stage(dataDir: string, version?: string): string;
  /** Directory for the systemd unit or the launchd plist. */
  unitDir(): string;
  /** Resolves true once /api/health returns a real HealthResponse, false if it never does. */
  waitReady(config: ServiceConfig): Promise<boolean>;
  /** The live process holding the data directory's instance lock (runningInstance), if any. */
  instance(dataDir: string): InstanceInfo | null;
  /** Whether something already listens on host:port (port 0 never is). */
  portInUse(host: string, port: number): Promise<boolean>;
  uid: number;
  user: string;
}

export const systemOps = (): ServiceOps => {
  const root = process.getuid?.() === 0;
  const ops: ServiceOps = {
    platform: process.platform,
    root,
    exec: (cmd, args, opts) => void execFileSync(cmd, args, { stdio: opts?.quiet ? "ignore" : "inherit" }),
    capture: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    stage: stageApp,
    unitDir: () => {
      if (process.platform === "darwin") return join(homedir(), "Library/LaunchAgents");
      if (root) return "/etc/systemd/system";
      unitDirCache ??= join(userManagerConfigHome(ops) ?? join(homedir(), ".config"), "systemd/user");
      return unitDirCache;
    },
    waitReady: waitForHealth,
    instance: runningInstance,
    portInUse,
    uid: process.getuid?.() ?? 0,
    user: userInfo().username,
  };
  let unitDirCache: string | undefined;
  return ops;
};

/**
 * XDG_CONFIG_HOME as the systemd user manager sees it (where `systemctl --user` looks for units),
 * which can differ from this shell's. Null when unset there or the manager can't be asked.
 */
export function userManagerConfigHome(ops: Pick<ServiceOps, "capture">): string | null {
  try {
    const env = ops.capture("systemctl", ["--user", "show-environment"]);
    return /^XDG_CONFIG_HOME=(.+)$/m.exec(env)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/** The unit file (systemd) or plist (launchd) for a service's names. */
export const unitPath = (ops: Pick<ServiceOps, "platform" | "unitDir">, id: UnitId) =>
  join(ops.unitDir(), ops.platform === "darwin" ? `${id.launchd}.plist` : `${id.systemd}.service`);
export const unitFile = (ops: Pick<ServiceOps, "platform" | "unitDir">) => unitPath(ops, DAEMON_UNIT);
const unitLabel = (ops: Pick<ServiceOps, "platform">, id: UnitId) => (ops.platform === "darwin" ? id.launchd : id.systemd);
export const systemctl = (ops: ServiceOps, ...args: string[]) => ops.exec("systemctl", ops.root ? args : ["--user", ...args]);
export const launchdTarget = (ops: Pick<ServiceOps, "uid">) => `gui/${ops.uid}`;

export function assertSupported(ops: ServiceOps): void {
  if (ops.platform !== "linux" && ops.platform !== "darwin") {
    throw new Error(
      `Service install supports Linux (systemd) and macOS (launchd). Elsewhere, install the command (\`npm i -g ${PACKAGE}\`) and run \`${CLI_NAME} start\` under your own supervisor.`,
    );
  }
}

export const readText = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/** Where to look when the service doesn't start. */
export function serviceHints(ops: ServiceOps, env: NodeJS.ProcessEnv = process.env, id: UnitId = DAEMON_UNIT): string[] {
  if (ops.platform === "darwin") {
    return [`launchctl print ${launchdTarget(ops)}/${id.launchd}`, "and the log file xaq.log in the data directory"];
  }
  const scope = ops.root ? "" : " --user";
  const hints = [`systemctl${scope} status ${id.systemd}`, `journalctl${scope} -u ${id.systemd} -e`];
  if (!ops.root && !env.XDG_RUNTIME_DIR) {
    hints.push(
      "XDG_RUNTIME_DIR is not set, so there may be no systemd user session (common over `su` or `sudo -u`). " +
        `Log in as ${ops.user} directly (e.g. over ssh), or run \`sudo loginctl enable-linger ${ops.user}\` and then ` +
        `\`export XDG_RUNTIME_DIR=/run/user/${ops.uid}\` before installing.`,
    );
  }
  return hints;
}

const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

/** First line of a failed command's stderr (what launchctl / systemctl said), else of the error. */
export const commandFailure = (err: unknown) => {
  const stderr = String((err as { stderr?: unknown })?.stderr ?? "").trim();
  return (stderr || (err instanceof Error ? err.message : String(err))).split("\n")[0]!;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether launchd has a job with this label loaded (any `launchctl print` failure counts as not loaded). */
export function launchdLoaded(ops: Pick<ServiceOps, "capture" | "uid">, label: string): boolean {
  try {
    ops.capture("launchctl", ["print", `${launchdTarget(ops)}/${label}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads the launchd job in `file`, replacing a loaded job with the same label. `launchctl bootout` returns
 * before the old job is torn down (launchd gives it up to 20 s to exit), and `bootstrap` of that label fails
 * with "5: Input/output error" until it is. So: boot it out, wait until `launchctl print` no longer finds it,
 * then bootstrap; on failure, retry with growing delays. Throws launchd's reason when every attempt failed.
 */
export async function bootstrapLaunchd(
  ops: Pick<ServiceOps, "exec" | "capture" | "uid">,
  label: string,
  file: string,
  opts: { attempts?: number; pollMs?: number; unloadTimeoutMs?: number } = {},
): Promise<void> {
  const { attempts = 5, pollMs = 250, unloadTimeoutMs = 30_000 } = opts;
  let last: unknown = null;
  // One unload budget for all attempts: a job that never unloads costs 30 s, not 30 s per attempt.
  const deadline = Date.now() + unloadTimeoutMs;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      ops.exec("launchctl", ["bootout", `${launchdTarget(ops)}/${label}`], { quiet: true });
    } catch {
      // Not loaded.
    }
    await waitUnloaded(ops, label, deadline, pollMs);
    try {
      ops.capture("launchctl", ["bootstrap", launchdTarget(ops), file]);
      return;
    } catch (err) {
      last = err;
      if (attempt < attempts) await sleep(pollMs * 4 * Math.min(2 ** (attempt - 1), 4));
    }
  }
  const stillLoaded = launchdLoaded(ops, label);
  throw new Error(`launchctl bootstrap failed: ${commandFailure(last)}${stillLoaded ? ` (a job labelled ${label} is still loaded and wouldn't unload)` : ""}`);
}

/** Polls `launchctl print` until launchd no longer lists the label, or the deadline passes. */
async function waitUnloaded(ops: Pick<ServiceOps, "capture" | "uid">, label: string, deadline: number, pollMs: number): Promise<void> {
  while (launchdLoaded(ops, label) && Date.now() < deadline) await sleep(pollMs);
}

/** What a service was doing before it was stopped, so a rollback can put it back exactly so. */
export interface UnitState {
  /** launchd: the job was loaded; systemd: the unit was active. */
  running: boolean;
  /** systemd only: the unit was enabled (started at boot). */
  enabled: boolean;
}

export function unitState(ops: Pick<ServiceOps, "platform" | "root" | "capture" | "uid">, id: UnitId): UnitState {
  if (ops.platform === "darwin") return { running: launchdLoaded(ops, id.launchd), enabled: false };
  const ask = (verb: string) => {
    try {
      return ops.capture("systemctl", [...(ops.root ? [] : ["--user"]), verb, id.systemd]).trim();
    } catch (err) {
      // is-active / is-enabled exit non-zero for "inactive" / "disabled"; the word is still on stdout.
      return String((err as { stdout?: unknown })?.stdout ?? "").trim();
    }
  };
  const active = ask("is-active");
  return { running: active === "active" || active === "activating" || active === "reloading", enabled: ask("is-enabled") === "enabled" };
}

/**
 * Stops a service and waits until it is really gone, so a replacement never runs next to it (they would
 * fight over the port and the data directory). systemd's stop waits by itself; launchd's bootout returns
 * at once and tears the job down asynchronously. Throws when it is still running afterwards.
 */
export async function stopAndWait(ops: ServiceOps, id: UnitId, opts: { pollMs?: number; unloadTimeoutMs?: number } = {}): Promise<void> {
  const { pollMs = 250, unloadTimeoutMs = 30_000 } = opts;
  if (ops.platform === "darwin") {
    try {
      ops.exec("launchctl", ["bootout", `${launchdTarget(ops)}/${id.launchd}`], { quiet: true });
    } catch {
      // Not loaded.
    }
    await waitUnloaded(ops, id.launchd, Date.now() + unloadTimeoutMs, pollMs);
    if (launchdLoaded(ops, id.launchd)) throw new Error(`launchd still has ${id.launchd} loaded after booting it out`);
    return;
  }
  try {
    systemctl(ops, "disable", "--now", id.systemd);
  } catch {
    // Not loaded or already stopped: checked below.
  }
  if (unitState(ops, id).running) throw new Error(`systemd still reports ${id.systemd} running after stopping it`);
}

/** Puts a stopped service's unit file back and returns it to the state it was in (see unitState). */
export async function restoreUnit(ops: ServiceOps, id: UnitId, file: string, text: string, state: UnitState, pollMs?: number): Promise<void> {
  writeFileSync(file, text, { mode: ops.platform === "darwin" ? 0o600 : 0o644 });
  if (ops.platform === "linux") {
    systemctl(ops, "daemon-reload");
    if (state.enabled) systemctl(ops, "enable", id.systemd);
    if (state.running) systemctl(ops, "start", id.systemd);
  } else if (state.running) {
    await bootstrapLaunchd(ops, id.launchd, file, { pollMs });
  }
}

/** Fails before anything is touched when systemd can't be reached (e.g. no user bus over su). */
export function preflight(ops: ServiceOps): void {
  if (ops.platform !== "linux") return;
  try {
    systemctl(ops, "daemon-reload");
  } catch (err) {
    const hints = serviceHints(ops).map((h) => `    ${h}`).join("\n");
    throw new Error(`Can't talk to systemd${ops.root ? "" : " (user session)"}: ${firstLine(err)}. Nothing was changed.\n${hints}`);
  }
}

/** Whether host:port can't be bound because something already listens there. */
function portInUse(host: string, port: number): Promise<boolean> {
  if (!port) return Promise.resolve(false);
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => done(err.code === "EADDRINUSE"));
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => done(false)));
  });
}

/**
 * The service manager's main pid for a service (default: the xaq daemon; the listener passes its
 * own label and unit); null when it isn't running or can't be asked.
 */
export function serviceMainPid(ops: ServiceOps, id: UnitId = DAEMON_UNIT): number | null {
  try {
    const out =
      ops.platform === "darwin"
        ? (/^\s*pid = (\d+)/m.exec(ops.capture("launchctl", ["print", `${launchdTarget(ops)}/${id.launchd}`]))?.[1] ?? "")
        : ops.capture("systemctl", [...(ops.root ? [] : ["--user"]), "show", "-p", "MainPID", "--value", id.systemd]).trim();
    const pid = Number(out);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Refuses (before anything is touched) while xaq already runs outside the service: in a
 * terminal on this data directory (its instance lock), or anything on the port while the service
 * isn't running. The service could only fail to start, and the health check would hear the other one.
 * A lock holder is the service when its lock says so, or (early nightlies didn't write that flag)
 * when, with a unit installed, it is the service manager's main process.
 */
export async function assertNothingElseRunning(config: Pick<ServiceConfig, "dataDir" | "host" | "port">, ops: ServiceOps, unitInstalled: boolean): Promise<void> {
  const other = ops.instance(config.dataDir);
  const pid = unitInstalled ? serviceMainPid(ops) : null;
  if (other && !other.service && other.pid !== pid) {
    throw new Error(
      `xaq is already running in a terminal (pid ${other.pid}${other.port ? `, port ${other.port}` : ""}): stop it with Ctrl-C, then run this again. ` +
        `The service uses the same data directory (${config.dataDir}), and only one xaq can use it at a time. Nothing was changed.`,
    );
  }
  // A running service (on whatever data directory) may hold the port; reinstalling stops it first.
  if (!other && pid === null && (await ops.portInUse(config.host, config.port))) {
    throw new Error(
      `Port ${config.port} is already in use: by xaq running in a terminal with another --data directory, or by another program. ` +
        `Stop it (Ctrl-C in its terminal), or choose another port with --port. Nothing was changed.`,
    );
  }
}

/**
 * After the health check answered: whether the data directory's lock holder is the new service's own
 * process. It must be the service manager's main process (or, when that pid is unknown, say in its lock
 * that it is the service), and not the process that held the lock before the install. This checks the
 * lock holder, not who answered: xaq binds its port before taking the lock and exits when the
 * port is taken, so a service that holds the lock is the one listening. Null when it is; else why not.
 */
export function notTheService(owner: InstanceInfo | null, before: InstanceInfo | null, mainPid: number | null): string | null {
  if (!owner) return "no xaq holds the data directory";
  const same = before && owner.pid === before.pid && owner.startedAt === before.startedAt;
  const isService = mainPid !== null ? owner.pid === mainPid : !!owner.service;
  if (same || !isService) return `the xaq holding the data directory (pid ${owner.pid}) is not the service${mainPid ? ` (pid ${mainPid})` : ""}`;
  return null;
}

/** The Node the service runs: --node, else the one running `service install`. Either must be MIN_NODE or newer. */
export function serviceNode(flag?: string): { path: string; version: string } {
  if (flag === undefined) return { path: process.execPath, version: process.versions.node };
  const path = resolve(flag);
  const version = nodeVersionOf(path);
  const problem = version ? nodeVersionError(version) : `--node ${path} doesn't run as Node.js.`;
  if (problem) throw new Error(`${problem} Nothing was changed.`);
  return { path, version: version! };
}

/** `<node> -p process.versions.node`, or null. Run without the caller's environment (no XAQ_MASTER_KEY, no NODE_OPTIONS). */
export function nodeVersionOf(path: string): string | null {
  try {
    const v = execFileSync(path, ["-p", "process.versions.node"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, killSignal: "SIGKILL", env: { PATH: process.env.PATH } }).trim();
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Installs (or reinstalls) and starts the service: stages the package, stops the old service, moves the new
 * install into place, writes the unit and waits for /api/health. A failure before the old service is stopped
 * changes nothing; after it, the error says where to look and running this again retries.
 */
export async function installService(config: ServiceConfig, ops: ServiceOps = systemOps(), opts: InstallOptions = {}): Promise<void> {
  assertSupported(ops);
  if (ops.platform === "linux" && /\s/.test(config.dataDir)) {
    throw new Error(`The data directory "${config.dataDir}" contains whitespace, which systemd can't load settings from. Choose another one with --data.`);
  }
  const extraEnv = mergeServiceEnv(readPreviousEnv(config.dataDir), process.env);
  validateMasterKey(extraEnv.XAQ_MASTER_KEY);
  // The service must be able to read what's already stored, with exactly the key it will get.
  assertMasterKeyUsable(config, extraEnv.XAQ_MASTER_KEY ?? "");
  preflight(ops);
  const file = unitFile(ops);
  const node = serviceNode(opts.node);
  await assertNothingElseRunning(config, ops, existsSync(file));
  const before = ops.instance(config.dataDir);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  const staging = ops.stage(config.dataDir, opts.version);
  const app = join(config.dataDir, "app");
  const spec: ServiceSpec = { execPath: node.path, entry: installedEntry(app), dataDir: config.dataDir, port: config.port, host: config.host, extraEnv, system: ops.root };
  try {
    uninstallService(config, ops, { quiet: true, keepApp: true });
    swapIn(staging, app).commit();
    writeServiceEnv(config.dataDir, extraEnv);
    mkdirSync(ops.unitDir(), { recursive: true });
    if (ops.platform === "linux") {
      writeFileSync(file, renderSystemdUnit(spec));
      systemctl(ops, "daemon-reload");
      systemctl(ops, "enable", "--now", SERVICE_NAME);
    } else {
      // 0600: the plist may carry XAQ_MASTER_KEY.
      writeFileSync(file, renderLaunchdPlist(spec), { mode: 0o600 });
      await bootstrapLaunchd(ops, LAUNCHD_LABEL, file, { pollMs: opts.launchdPollMs });
    }
    if (!(await ops.waitReady(config))) throw new Error(`it did not answer on port ${config.port}`);
    // Something else (a foreground xaq started meanwhile) may have answered instead.
    const wrong = notTheService(ops.instance(config.dataDir), before, serviceMainPid(ops));
    if (wrong) throw new Error(wrong);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    const hints = serviceHints(ops).map((h) => `    ${h}`).join("\n");
    throw new Error(`Starting the service failed (${firstLine(err)}).\n  To find out why:\n${hints}`);
  }

  enableLinger(ops);

  const kept = Object.keys(extraEnv).filter((k) => !(k in process.env));
  console.log(`\n  Installed ${SERVICE_NAME} as a ${ops.platform === "linux" ? "systemd" : "launchd"} service (${unitLabel(ops, DAEMON_UNIT)}).`);
  console.log(`  It runs Node.js ${node.version} at ${node.path}. If you remove or replace that Node, run \`${serviceInstallCommand(config)}\` again.`);
  if (kept.length) console.log(`  Kept ${kept.join(", ")} from the previous install.`);
  printLinks(config);
}

/** Keeps user services running after logout and starts them at boot (systemd user units only). */
export function enableLinger(ops: ServiceOps): void {
  if (ops.platform !== "linux" || ops.root) return;
  try {
    ops.exec("loginctl", ["enable-linger", ops.user], { quiet: true });
  } catch {
    console.warn(`  Could not enable lingering. Run \`sudo loginctl enable-linger ${ops.user}\` so the service starts at boot.`);
  }
}

/** XAQ_DATA from an installed unit or plist. */
export const unitDataDir = (text: string): string | null => unitEnv(text, "XAQ_DATA");

/** An environment variable a unit (`Environment="K=v"`) or plist (`<key>K</key><string>v</string>`) sets. */
export function unitEnv(text: string, name: string): string | null {
  const systemd = new RegExp(`^Environment="${name}=((?:[^"\\\\]|\\\\.)*)"`, "m").exec(text);
  if (systemd) return systemd[1]!.replace(/\\(.)/g, "$1").replace(/%%/g, "%");
  const plist = new RegExp(`<key>${name}</key><string>([^<]*)</string>`).exec(text);
  if (plist) return plist[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return null;
}

/**
 * Stops and removes the service. The data directory is the one the installed unit uses (falling back to
 * `config.dataDir`), and only directories that really are the service's own install are deleted; nothing is created.
 */
export function uninstallService(
  config: Pick<ServiceConfig, "dataDir">,
  ops: ServiceOps = systemOps(),
  opts: { quiet?: boolean; keepApp?: boolean } = {},
): void {
  assertSupported(ops);
  const file = unitFile(ops);
  const text = readText(file);
  const dataDir = (text && unitDataDir(text)) || config.dataDir;
  if (text === null) {
    if (!opts.quiet) console.log("The xaq service is not installed.");
  } else {
    if (ops.platform === "linux") {
      try {
        systemctl(ops, "disable", "--now", SERVICE_NAME);
      } catch {
        // Already stopped.
      }
      rmSync(file);
      systemctl(ops, "daemon-reload");
    } else {
      try {
        ops.exec("launchctl", ["bootout", `${launchdTarget(ops)}/${LAUNCHD_LABEL}`], { quiet: true });
      } catch {
        // Not loaded.
      }
      rmSync(file);
    }
    if (!opts.quiet) console.log(`Removed the ${unitLabel(ops, DAEMON_UNIT)} service. Your data in ${dataDir} was kept.`);
  }
  // The service's own install; the data (database, keys) stays.
  if (!opts.keepApp) removeOwnInstall(dataDir);
}

export function serviceStatus(ops: ServiceOps = systemOps()): void {
  assertSupported(ops);
  if (!existsSync(unitFile(ops))) {
    console.log(`The xaq service is not installed. Install it with \`${cliCommand("service install")}\`.`);
    process.exitCode = 1;
    return;
  }
  try {
    if (ops.platform === "linux") systemctl(ops, "status", SERVICE_NAME, "--no-pager");
    else ops.exec("launchctl", ["print", `${launchdTarget(ops)}/${LAUNCHD_LABEL}`]);
  } catch {
    process.exitCode = 1;
  }
}

/** A real HealthResponse (not the "starting" placeholder or something else on the port). */
export function isHealthResponse(body: unknown): boolean {
  const b = body as { status?: unknown; version?: unknown } | null;
  return !!b && (b.status === "ok" || b.status === "degraded") && typeof b.version === "string";
}

/** Polls /api/health for up to ~45 s. 503 with a HealthResponse means "up but degraded", which is up. */
async function waitForHealth(config: ServiceConfig): Promise<boolean> {
  const base = loopbackUrl(config.host, config.port);
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      if ((res.status === 200 || res.status === 503) && isHealthResponse(await res.json().catch(() => null))) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function printLinks(config: ServiceConfig): void {
  const token = readSetupToken(config.dataDir);
  console.log(`  Running at:\n`);
  for (const url of consoleUrls(config.host, config.port)) console.log(`    ${url}${token ? `/setup?token=${token}` : ""}`);
  if (token) console.log(`\n  Open the link above to claim the instance and finish setup.`);
  console.log();
}
