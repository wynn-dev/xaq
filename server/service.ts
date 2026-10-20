import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CLI_NAME, NPM_PACKAGE as PACKAGE } from "../shared/types.ts";
import { readSetupToken } from "./auth/setup-token.ts";
import { assertOurs } from "./listen/fsutil.ts";
import { envVar, LEGACY_PRODUCT } from "./brand.ts";
import { type Config, type ConfigInput, dataFiles, hasForeignFiles } from "./config.ts";
import { Crypto } from "./crypto.ts";
import { assertMasterKeyUsable, cliCommand, type InstanceInfo, runningInstance, serviceInstallCommand } from "./instance.ts";
import { consoleUrls, loopbackUrl } from "./urls.ts";

/** Installs xaq as a background service: systemd on Linux, launchd on macOS. */

export const SERVICE_NAME = "xaq";
export const LAUNCHD_LABEL = "sh.xaq.daemon";
/**
 * The service's names before the rename (agentinbox). `service install` stops and replaces a service
 * installed under them (rolling back to it on failure); `status` and `uninstall` find it too.
 */
export const LEGACY_SERVICE_NAME = "agentinbox";
export const LEGACY_LAUNCHD_LABEL = "com.unlaboredlabs.agentinbox";
/** The package a pre-rename service install put into `<data>/app`. */
export const LEGACY_PACKAGE = "agentinbox-cli";

/** A service's names: the launchd label and the systemd unit (without `.service`). */
export interface UnitId {
  launchd: string;
  systemd: string;
}
export const DAEMON_UNIT: UnitId = { launchd: LAUNCHD_LABEL, systemd: SERVICE_NAME };
export const LEGACY_DAEMON_UNIT: UnitId = { launchd: LEGACY_LAUNCHD_LABEL, systemd: LEGACY_SERVICE_NAME };
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
/** Package root: one level above the running module (dist/cli.js or server/service.ts). */
const ROOT = resolve(import.meta.dirname, "..");

/**
 * Settings that come from the environment rather than flags. They are kept in `<data>/service.env`
 * (mode 0600) so re-running `service install` from a shell without them (the documented update
 * path) keeps them. Set one to an empty value to drop it.
 */
export const SERVICE_ENV_KEYS = ["XAQ_MASTER_KEY", "TRUST_PROXY", "TRUST_PROXY_HOPS", "TRUST_PROXY_FROM", "XAQ_LOG_LEVEL"] as const;
/** Their names before the rename: still read from the shell and from a service.env an older install wrote. */
const LEGACY_ENV_KEYS: Partial<Record<(typeof SERVICE_ENV_KEYS)[number], string>> = { XAQ_MASTER_KEY: "AGENTINBOX_MASTER_KEY", XAQ_LOG_LEVEL: "AGENTINBOX_LOG_LEVEL" };

type ServiceConfig = Pick<Config, "dataDir" | "port" | "host" | "dbPath" | "masterKeyPath">;

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
 * an explicitly empty value removes the setting. The pre-rename names (AGENTINBOX_MASTER_KEY…) count
 * where the new one isn't given, and are written back under the new name.
 */
export function mergeServiceEnv(previous: Record<string, string>, current: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SERVICE_ENV_KEYS) {
    const old = LEGACY_ENV_KEYS[key];
    const value = key in current ? current[key] : old && old in current ? current[old] : (previous[key] ?? (old ? previous[old] : undefined));
    // A single comma-separated token, so systemd's EnvironmentFile parsing can't split it.
    if (value) out[key] = key === "TRUST_PROXY_FROM" ? value.split(/[\s,]+/).filter(Boolean).join(",") : value;
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

/** A service.env we wrote: only KEY=value lines for our own settings. */
function isOurServiceEnv(file: string): boolean {
  const known = new Set<string>([...SERVICE_ENV_KEYS, ...Object.values(LEGACY_ENV_KEYS)]);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .every((l) => known.has(/^([A-Z_][A-Z0-9_]*)=/.exec(l)?.[1] ?? ""));
}

function writeServiceEnv(dataDir: string, env: Record<string, string>): void {
  const file = serviceEnvPath(dataDir);
  // The data directory may be a ~/.xaq another program called xaq owns: never replace its files.
  assertOurs(file, isOurServiceEnv, "service settings (service.env)");
  if (!Object.keys(env).length) {
    rmSync(file, { force: true });
    return;
  }
  for (const [k, v] of Object.entries(env)) {
    if (/[\r\n]/.test(v)) throw new Error(`${k} must be a single line.`);
  }
  writeFileSync(file, serviceEnvText(env), { mode: 0o600 });
}

/**
 * service.env's content. For one release, XAQ_MASTER_KEY and XAQ_LOG_LEVEL are also written under their
 * pre-rename names, so going back to agentinbox-cli by hand (its `service install` reads only those)
 * still finds the key and starts.
 */
export function serviceEnvText(env: Record<string, string>): string {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}\n`);
  for (const [key, old] of Object.entries(LEGACY_ENV_KEYS)) {
    const value = env[key];
    if (value && old) lines.push(`${old}=${value}\n`);
  }
  return lines.join("");
}

/**
 * Installs the package into `staging` (a fresh private npm prefix), so a failed npm install leaves the
 * current install untouched. From an installed package that is the latest release; from a source
 * checkout, the local build. Returns `staging`. The one install path for the daemon and the listeners.
 */
export function stagePackage(staging: string, opts: { where: string; requireWeb: boolean }): string {
  const fromSource = basename(dirname(ROOT)) !== "node_modules";
  let spec = `${PACKAGE}@latest`;
  let tmp: string | undefined;
  if (fromSource) {
    if (!existsSync(join(ROOT, "dist/cli.js")) || (opts.requireWeb && !existsSync(join(ROOT, "dist/web/index.html")))) {
      throw new Error("Run `pnpm build` before installing the service from a source checkout.");
    }
    tmp = mkdtempSync(join(tmpdir(), "xaq-pack-"));
    const out = execFileSync(npm, ["pack", "--ignore-scripts", "--pack-destination", tmp, "--loglevel=error"], { cwd: ROOT, encoding: "utf8" });
    spec = join(tmp, out.trim().split("\n").pop()!);
  }

  console.log(fromSource ? `  Installing this build into ${opts.where}…` : `  Installing the latest release into ${opts.where}…`);
  clearOwnInstall(staging);
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "package.json"), '{ "private": true }\n');
  try {
    execFileSync(npm, ["install", spec, "--omit=dev", "--prefer-online", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: staging, stdio: "inherit" });
    if (!existsSync(installedEntry(staging))) throw new Error("the installed package has no dist/cli.js");
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`Installing xaq failed, so the existing service was left as it was. ${err instanceof Error ? err.message : ""}`.trim());
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return staging;
}

/** The CLI entry inside an install made by stagePackage. */
export const installedEntry = (app: string) => join(app, "node_modules", PACKAGE, "dist/cli.js");

/** Installs into `<dir>/app.new` (see stagePackage). Returns the staging directory. */
export const stageApp = (dir: string): string => stagePackage(join(dir, "app.new"), { where: "the data directory", requireWeb: true });

/**
 * Moves a staged install into place as `app` (the current one becomes `app.old`). `restore()` puts
 * the previous install back; `commit()` deletes it. If the move itself fails, nothing changes.
 */
export function swapIn(staging: string, app: string): { restore(): void; commit(): void } {
  const old = `${app}.old`;
  clearOwnInstall(old);
  // In a directory that also holds another program's files (it is called xaq too), only our own install is moved aside.
  if (existsSync(app) && hasForeignFiles(dirname(app)) && !isOwnInstall(app)) {
    throw new Error(`${app} already exists and isn't a xaq install, so it was left alone. Move it away, then run this again.`);
  }
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

/** Whether `path` is one of our installs (xaq-cli, or agentinbox-cli from before the rename). */
export const isOwnInstall = (path: string) => [PACKAGE, LEGACY_PACKAGE].some((p) => existsSync(join(path, "node_modules", p)));

/** Deletes `<dir>/app`, `app.new` and `app.old`, but only where they really are our own installs (xaq-cli, or agentinbox-cli from before the rename). */
export function removeOwnInstall(dir: string): void {
  for (const name of ["app", "app.new", "app.old"]) {
    const path = join(dir, name);
    if (isOwnInstall(path)) rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Makes room for a staging or backup install. In a directory that also holds another program's files (it is
 * called xaq too), only our own install (or an empty leftover) is removed; anything else there is refused.
 */
function clearOwnInstall(path: string): void {
  let there = true;
  try {
    lstatSync(path);
  } catch {
    there = false;
  }
  if (!there) return;
  // An empty leftover (an install that failed before npm wrote anything) is ours too.
  const empty = (() => {
    try {
      return readdirSync(path).filter((n) => n !== "package.json" && n !== "package-lock.json").length === 0;
    } catch {
      return false;
    }
  })();
  if (hasForeignFiles(dirname(path)) && !isOwnInstall(path) && !empty) throw new Error(`${path} already exists and isn't a xaq install, so it was left alone. Move it away, then run this again.`);
  rmSync(path, { recursive: true, force: true });
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
  /** Installs the package into a staging directory and returns it (see stageApp). */
  stage(dataDir: string): string;
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
const unitFile = (ops: ServiceOps) => unitPath(ops, DAEMON_UNIT);
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
    return [`launchctl print ${launchdTarget(ops)}/${id.launchd}`, "and the log file xaq.log (agentinbox.log from before the rename) in the data directory"];
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
 * when, with a unit installed, it is the service manager's main process. `units` are the installed
 * services (the new one and/or one from before the rename).
 */
export async function assertNothingElseRunning(
  config: Pick<ServiceConfig, "dataDir" | "host" | "port">,
  ops: ServiceOps,
  unitInstalled: boolean,
  units: UnitId[] = [DAEMON_UNIT],
): Promise<void> {
  const other = ops.instance(config.dataDir);
  const pids = unitInstalled ? units.map((id) => serviceMainPid(ops, id)).filter((p): p is number => p !== null) : [];
  if (other && !other.service && !pids.includes(other.pid)) {
    throw new Error(
      `xaq is already running in a terminal (pid ${other.pid}${other.port ? `, port ${other.port}` : ""}): stop it with Ctrl-C, then run this again. ` +
        `The service uses the same data directory (${config.dataDir}), and only one xaq can use it at a time. Nothing was changed.`,
    );
  }
  // A running service (on whatever data directory) may hold the port; reinstalling stops it first.
  if (!other && !pids.length && (await ops.portInUse(config.host, config.port))) {
    throw new Error(
      `Port ${config.port} is already in use: by xaq (or agentinbox) running in a terminal with another --data directory, or by another program. ` +
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

/**
 * A daemon service installed under the names from before the rename (agentinbox), if any: its unit file,
 * the file's content, and the data directory it runs on.
 */
export function legacyDaemonUnit(
  ops: Pick<ServiceOps, "platform" | "unitDir">,
): { file: string; text: string; dataDir: string | null; port: number | null; host: string | null } | null {
  if (ops.platform !== "linux" && ops.platform !== "darwin") return null;
  const file = unitPath(ops, LEGACY_DAEMON_UNIT);
  const text = readText(file);
  if (text === null) return null;
  const rawPort = unitEnv(text, "PORT");
  const port = rawPort && /^\d+$/.test(rawPort) && Number(rawPort) <= 65535 ? Number(rawPort) : null;
  return { file, text, dataDir: unitDataDir(text), port, host: unitEnv(text, "HOST") || null };
}

/**
 * Where `service install` puts the service when the command line and environment don't say: replacing a
 * service from before the rename keeps its data directory, port and host (a bind to 127.0.0.1 must not
 * widen to 0.0.0.0 on upgrade). An installed xaq service keeps the data directory its unit names (say
 * ~/.agentinbox, or the ~/.xaq nightly.71/72 used), even if the default has changed since. `given` is what
 * the flags (and PORT / HOST / XAQ_DATA) said.
 */
export function serviceInstallInput(
  given: { dataDir?: string; port?: number; host?: string },
  ops: Pick<ServiceOps, "platform" | "unitDir">,
  env: NodeJS.ProcessEnv = process.env,
): Pick<ConfigInput, "dataDir" | "port" | "host"> {
  const legacy = legacyDaemonUnit(ops);
  const installed = installedDaemonDataDir(ops);
  return {
    dataDir: given.dataDir ?? (envVar("DATA", env) || undefined) ?? legacy?.dataDir ?? installed ?? undefined,
    port: given.port ?? (env.PORT?.trim() ? undefined : (legacy?.port ?? undefined)),
    host: given.host ?? (env.HOST ? undefined : (legacy?.host ?? undefined)),
  };
}

/** The data directory the installed (xaq) daemon service runs on, if one is installed and says. */
export function installedDaemonDataDir(ops: Pick<ServiceOps, "platform" | "unitDir">): string | null {
  if (ops.platform !== "linux" && ops.platform !== "darwin") return null;
  const text = readText(unitPath(ops, DAEMON_UNIT));
  return text === null ? null : unitDataDir(text);
}

export async function installService(config: ServiceConfig, ops: ServiceOps = systemOps(), opts: { launchdPollMs?: number } = {}): Promise<void> {
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
  const previousUnit = readText(file);
  // A service from before the rename is replaced: stopped (and waited for) before the new one starts,
  // so the two never run at once, and put back exactly as it was if the new one fails.
  const legacy = legacyDaemonUnit(ops);
  const legacyState = legacy ? unitState(ops, LEGACY_DAEMON_UNIT) : null;
  await assertNothingElseRunning(config, ops, previousUnit !== null || legacy !== null, [DAEMON_UNIT, ...(legacy ? [LEGACY_DAEMON_UNIT] : [])]);
  const before = ops.instance(config.dataDir);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

  const staging = ops.stage(config.dataDir);
  const previousEnv = readText(serviceEnvPath(config.dataDir));
  const app = join(config.dataDir, "app");
  const entry = installedEntry(app);
  const spec: ServiceSpec = { execPath: process.execPath, entry, dataDir: config.dataDir, port: config.port, host: config.host, extraEnv, system: ops.root };
  let swap: ReturnType<typeof swapIn> | null = null;

  try {
    if (legacy) {
      console.log(`  Replacing the ${LEGACY_PRODUCT} service (${unitLabel(ops, LEGACY_DAEMON_UNIT)}) with ${unitLabel(ops, DAEMON_UNIT)}…`);
      await stopAndWait(ops, LEGACY_DAEMON_UNIT, { pollMs: opts.launchdPollMs });
      rmSync(legacy.file, { force: true });
      if (ops.platform === "linux") systemctl(ops, "daemon-reload");
    }
    uninstallService(config, ops, { quiet: true, keepApp: true });
    swap = swapIn(staging, app);
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
    await rollback();
    const hints = serviceHints(ops, process.env, legacy && previousUnit === null ? LEGACY_DAEMON_UNIT : DAEMON_UNIT)
      .map((h) => `    ${h}`)
      .join("\n");
    const restored = legacy ? `the ${LEGACY_PRODUCT} service as it was` : previousUnit ? "the previous install" : "no service";
    throw new Error(`Starting the service failed (${firstLine(err)}). Rolled back to ${restored}.\n  To find out why:\n${hints}`);
  }
  swap!.commit();

  async function rollback(): Promise<void> {
    const quietly = async (fn: () => void | Promise<void>) => {
      try {
        await fn();
      } catch {
        // Best effort: report the original failure.
      }
    };
    // Before the old service comes back, the new one must be gone (launchd tears it down asynchronously).
    if (legacy) await quietly(() => stopAndWait(ops, DAEMON_UNIT, { pollMs: opts.launchdPollMs }));
    await quietly(() => uninstallService(config, ops, { quiet: true, keepApp: true }));
    await quietly(() => rmSync(file, { force: true }));
    if (ops.platform === "linux") await quietly(() => systemctl(ops, "daemon-reload"));
    await quietly(() => rmSync(staging, { recursive: true, force: true }));
    if (swap) await quietly(() => swap!.restore());
    await quietly(() => (previousEnv === null ? rmSync(serviceEnvPath(config.dataDir), { force: true }) : writeFileSync(serviceEnvPath(config.dataDir), previousEnv, { mode: 0o600 })));
    if (previousUnit !== null) {
      await quietly(async () => {
        writeFileSync(file, previousUnit, { mode: ops.platform === "darwin" ? 0o600 : 0o644 });
        if (ops.platform === "linux") {
          systemctl(ops, "daemon-reload");
          systemctl(ops, "enable", "--now", SERVICE_NAME);
        } else {
          await bootstrapLaunchd(ops, LAUNCHD_LABEL, file, { pollMs: opts.launchdPollMs });
        }
      });
    }
    // The pre-rename service comes back under its own name (even when stopping it is what failed),
    // running and enabled only if it was before.
    if (legacy) await quietly(() => restoreUnit(ops, LEGACY_DAEMON_UNIT, legacy.file, legacy.text, legacyState!, opts.launchdPollMs));
  }

  enableLinger(ops);

  const fromShell = (k: string) => k in process.env || (LEGACY_ENV_KEYS[k as keyof typeof LEGACY_ENV_KEYS] ?? k) in process.env;
  const kept = Object.keys(extraEnv).filter((k) => !fromShell(k));
  console.log(`\n  Installed ${SERVICE_NAME} as a ${ops.platform === "linux" ? "systemd" : "launchd"} service (${unitLabel(ops, DAEMON_UNIT)}).`);
  if (legacy) console.log(`  It replaces the ${LEGACY_PRODUCT} service (${unitLabel(ops, LEGACY_DAEMON_UNIT)}), which was removed. Your data stays in ${config.dataDir}.`);
  console.log(
    `  It runs the Node.js at ${process.execPath} (v${process.versions.node}). If you remove or replace that Node, run \`${serviceInstallCommand(config)}\` again.`,
  );
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

/** XAQ_DATA (AGENTINBOX_DATA in a unit from before the rename) from an installed unit or plist. */
export function unitDataDir(text: string): string | null {
  return unitEnv(text, "XAQ_DATA") ?? unitEnv(text, "AGENTINBOX_DATA");
}

/** An environment variable a unit (`Environment="K=v"`) or plist (`<key>K</key><string>v</string>`) sets. */
export function unitEnv(text: string, name: string): string | null {
  const systemd = new RegExp(`^Environment="${name}=((?:[^"\\\\]|\\\\.)*)"`, "m").exec(text);
  if (systemd) return systemd[1]!.replace(/\\(.)/g, "$1").replace(/%%/g, "%");
  const plist = new RegExp(`<key>${name}</key><string>([^<]*)</string>`).exec(text);
  if (plist) return plist[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return null;
}

/**
 * Stops and removes the service, under its own name or the one from before the rename. The data
 * directory is the one the installed unit uses (falling back to `config.dataDir`), and only directories
 * that really are the service's own install are deleted; nothing is created.
 */
export function uninstallService(
  config: Pick<ServiceConfig, "dataDir">,
  ops: ServiceOps = systemOps(),
  opts: { quiet?: boolean; keepApp?: boolean } = {},
): void {
  assertSupported(ops);
  const units = [DAEMON_UNIT, LEGACY_DAEMON_UNIT]
    .map((id) => ({ id, file: unitPath(ops, id), text: readText(unitPath(ops, id)) }))
    .filter((u): u is { id: UnitId; file: string; text: string } => u.text !== null);
  const dataDir = units.map((u) => unitDataDir(u.text)).find(Boolean) || config.dataDir;
  if (!units.length && !opts.quiet) console.log("The xaq service is not installed.");
  for (const u of units) {
    if (ops.platform === "linux") {
      try {
        systemctl(ops, "disable", "--now", u.id.systemd);
      } catch {
        // Already stopped.
      }
      rmSync(u.file);
      systemctl(ops, "daemon-reload");
    } else {
      try {
        ops.exec("launchctl", ["bootout", `${launchdTarget(ops)}/${u.id.launchd}`], { quiet: true });
      } catch {
        // Not loaded.
      }
      rmSync(u.file);
    }
    if (!opts.quiet) console.log(`Removed the ${unitLabel(ops, u.id)} service. Your data in ${dataDir} was kept.`);
  }
  // The service's own install; the data (database, keys) stays.
  if (!opts.keepApp) removeOwnInstall(dataDir);
}

export function serviceStatus(ops: ServiceOps = systemOps()): void {
  assertSupported(ops);
  const id = existsSync(unitFile(ops)) ? DAEMON_UNIT : existsSync(unitPath(ops, LEGACY_DAEMON_UNIT)) ? LEGACY_DAEMON_UNIT : null;
  if (!id) {
    console.log(`The xaq service is not installed. Install it with \`${cliCommand("service install")}\`.`);
    process.exitCode = 1;
    return;
  }
  if (id === LEGACY_DAEMON_UNIT) {
    console.log(`This is the service from before the rename to xaq (${unitLabel(ops, id)}). \`${cliCommand("service install")}\` moves it to ${unitLabel(ops, DAEMON_UNIT)}, keeping your data.\n`);
  }
  try {
    if (ops.platform === "linux") systemctl(ops, "status", id.systemd, "--no-pager");
    else ops.exec("launchctl", ["print", `${launchdTarget(ops)}/${id.launchd}`]);
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
