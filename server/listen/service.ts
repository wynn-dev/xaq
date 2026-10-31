import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import pc from "picocolors";
import { PRODUCT } from "../brand.ts";
import {
  assertSupported,
  bootstrapLaunchd,
  commandFailure,
  enableLinger,
  installedEntry,
  launchdTarget,
  preflight,
  readText,
  removeOwnInstall,
  sdQuote,
  serviceMainPid,
  type ServiceOps,
  stagePackage,
  swapIn,
  systemctl,
  systemOps,
  type UnitId,
  unitPath,
  xmlEscape,
} from "../service.ts";
import { ensurePrivateDir } from "./fsutil.ts";
import { EXIT } from "./listen.ts";
import { acquireFileLock } from "./lock.ts";
import { type ListenFlags, resolveListen } from "./options.ts";
import { serviceNode, type ServiceNodeChoice } from "./mcpheader.ts";
import { dataDir, listenAppDir, listenStateDir, logPath, profilePath } from "./paths.ts";
import { loadProfile, saveProfile } from "./profile.ts";
import { pidAlive, readStatus } from "./state.ts";
import { checkTransport } from "./transport.ts";
import { NPX } from "./version.ts";

/**
 * `xaq listen service install|uninstall|status`: one systemd user unit / launchd agent per machine,
 * running from a stable install (not the npx cache). Settings and the key stay in the 0600 profile file.
 * Installation reuses the daemon's machinery (server/service.ts): systemd pre-check, the user manager's
 * unit directory, staging into app.new and swapping in, rollback when the new listener doesn't start.
 */

export const UNIT_NAME = `${PRODUCT}-listen-default`;
export const LAUNCHD_LABEL = "sh.xaq.listen.default";
export const LISTEN_UNIT: UnitId = { launchd: LAUNCHD_LABEL, systemd: UNIT_NAME };

/**
 * PATH for the service: this shell's PATH (so `claude`, `codex`… resolve as they do here) minus
 * transient entries npx, npm scripts and version-manager shells add, plus node's own directory.
 */
export function servicePath(raw = process.env.PATH ?? "", node = process.execPath): string {
  const transient = /\/_npx\/|node_modules\/\.bin|node-gyp-bin|fnm_multishells|\/\.pnpm\//;
  // This shell's node first (global npm tools such as `claude` live next to it), then the service's own.
  const dirs = [dirname(process.execPath), dirname(node), ...raw.split(delimiter)].filter((d) => d && d.startsWith("/") && !transient.test(d));
  if (!dirs.includes("/usr/bin")) dirs.push("/usr/local/bin", "/usr/bin", "/bin");
  return [...new Set(dirs)].join(delimiter);
}

/** Environment the service needs to behave like the shell `service install` ran in. Never contains the key. */
export function serviceEnvironment(node = process.execPath): Record<string, string> {
  const env: Record<string, string> = { XAQ_SERVICE: "1" };
  // PATH matters most: `claude` and the like usually live in ~/.local/bin, nvm or Homebrew dirs
  // that a service manager's minimal PATH doesn't include.
  env.PATH = servicePath(undefined, node);
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR", "LANG", "XAQ_LOG_LEVEL"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

export function systemdListenUnit(entry: string, cwd: string, system = false, node = process.execPath): string {
  const vars = Object.entries(serviceEnvironment(node))
    .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=xaq listener${system ? "\nAfter=network-online.target\nWants=network-online.target" : ""}
StartLimitIntervalSec=0

[Service]
ExecStart=${sdQuote(node)} ${sdQuote(entry)} listen
WorkingDirectory=${cwd.replace(/%/g, "%%")}
${vars}
Restart=on-failure
RestartSec=10
RestartSteps=6
RestartMaxDelaySec=600
# ${EXIT.revoked}: the key was revoked or the config is invalid. Restarting can't fix that.
RestartPreventExitStatus=${EXIT.revoked}
TimeoutStopSec=20
# An OOM kill of one child (a hook command) must not stop the listener.
OOMPolicy=continue

[Install]
WantedBy=${system ? "multi-user.target" : "default.target"}
`;
}

export function launchdListenPlist(entry: string, cwd: string, node = process.execPath): string {
  const esc = xmlEscape;
  const vars = Object.entries(serviceEnvironment(node))
    .map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`)
    .join("\n");
  // The listener logs to the rotated listen.log and stays quiet on the console under launchd; only
  // crashes reach stderr, so this file stays small.
  const errLog = esc(join(listenStateDir(), "service-stderr.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(entry)}</string>
    <string>listen</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${errLog}</string>
</dict>
</plist>
`;
}

const label = (ops: Pick<ServiceOps, "platform">) => (ops.platform === "linux" ? UNIT_NAME : LAUNCHD_LABEL);

/** The listener service's unit file, or null when none is installed (or the platform has none). */
function installedUnitFile(ops: ServiceOps): string | null {
  if (ops.platform !== "linux" && ops.platform !== "darwin") return null;
  try {
    const file = unitPath(ops, LISTEN_UNIT);
    return existsSync(file) ? file : null;
  } catch {
    return null; // No unit directory to look in.
  }
}

export const isServiceInstalled = (ops: ServiceOps = systemOps()): boolean => installedUnitFile(ops) !== null;

/** The service's name as the platform knows it (for status lines), or null when it isn't installed. */
export const installedServiceLabel = (ops: ServiceOps = systemOps()): string | null => (installedUnitFile(ops) ? label(ops) : null);

function listenerHints(ops: ServiceOps): string[] {
  if (ops.platform === "darwin") return [`launchctl print ${launchdTarget(ops)}/${LAUNCHD_LABEL}`, `the log ${logPath()}`];
  const scope = ops.root ? "" : " --user";
  return [`systemctl${scope} status ${UNIT_NAME}`, `journalctl${scope} -u ${UNIT_NAME} -e`, `the log ${logPath()}`];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The pid of a listener started after `since` (it writes status.json on start), once it
 * has stayed up for a moment; null if none did within the timeout, or it stopped again.
 */
export async function waitListenerStarted(since: number, timeoutMs = 20_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = readStatus();
    if (st && Date.parse(st.startedAt) >= since - 1000) {
      if (st.stoppedAt) return null;
      if (pidAlive(st.pid)) {
        // A listener that exits at once (bad settings, revoked key) must not count as started.
        await sleep(1000);
        const again = readStatus();
        return again?.pid === st.pid && !again.stoppedAt && pidAlive(st.pid) ? st.pid : null;
      }
    }
    await sleep(250);
  }
  return null;
}

const why = commandFailure;

/** What the service manager says about the listener: running (with its pid), or why not. */
export function managerState(ops: ServiceOps, id: UnitId = LISTEN_UNIT): { running: boolean; pid: number | null; detail: string } {
  const pid = serviceMainPid(ops, id);
  if (ops.platform === "darwin") {
    let text: string;
    try {
      text = ops.capture("launchctl", ["print", `${launchdTarget(ops)}/${id.launchd}`]);
    } catch (err) {
      return { running: false, pid: null, detail: `launchctl print: ${why(err)}` };
    }
    const state = /^\s*state = (\S+)/m.exec(text)?.[1] ?? "unknown";
    return { running: state === "running" && pid !== null, pid, detail: `launchd state ${state}${pid ? `, pid ${pid}` : ""}` };
  }
  let active: string;
  try {
    active = ops.capture("systemctl", [...(ops.root ? [] : ["--user"]), "is-active", id.systemd]).trim();
  } catch (err) {
    active = String((err as { stdout?: unknown })?.stdout ?? "").trim() || why(err);
  }
  return { running: active === "active" && pid !== null, pid, detail: `systemd ${active || "unknown"}${pid ? `, MainPID ${pid}` : ""}` };
}

/** (Re)starts the unit with the file just written (launchd: see bootstrapLaunchd). */
async function startUnit(ops: ServiceOps, file: string, pollMs = 250): Promise<void> {
  if (ops.platform === "linux") {
    systemctl(ops, "daemon-reload");
    systemctl(ops, "enable", UNIT_NAME);
    // restart, not start: a re-install must pick up the new install and settings.
    systemctl(ops, "restart", UNIT_NAME);
    return;
  }
  await bootstrapLaunchd(ops, LAUNCHD_LABEL, file, { pollMs });
}

/** Stops and removes the unit (no waiting: for uninstall and for undoing a new unit that never ran). */
function removeUnit(ops: ServiceOps, file: string): void {
  if (ops.platform === "linux") {
    try {
      systemctl(ops, "disable", "--now", UNIT_NAME);
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
}

/** Stages the listener's install (no web console needed). */
export const stageListenerApp = (staging: string): string => stagePackage(staging, { where: dirname(staging), requireWeb: false });

export interface ListenServiceDeps {
  ops?: ServiceOps;
  /** Installs the package into the given staging dir (tests). */
  stage?: (staging: string) => string;
  /** Readiness check after (re)starting the unit: the new listener's pid (tests). */
  waitStarted?: (since: number) => Promise<number | null>;
  /** The node the unit runs (tests). */
  node?: ServiceNodeChoice;
  /** launchd polling interval (tests). */
  pollMs?: number;
}

export async function installListenService(flags: ListenFlags, deps: ListenServiceDeps = {}): Promise<void> {
  const ops = deps.ops ?? systemOps();
  assertSupported(ops);
  const profile = loadProfile();
  // Service settings live in the profile: the flags given here, else what is saved already.
  const { config, settings } = resolveListen(profile, flags);
  if (!config.exec) throw new Error(`Nothing for the service to run. Pass --recipe claude-code or --exec "<command>" (they are saved).`);
  await checkTransport(profile.url, { insecure: config.insecure });
  preflight(ops);
  const shared = dataDir();
  // A daemon started with --data pointing here would share (and lose) its app/ install with us.
  if (existsSync(join(shared, `${PRODUCT}.db`))) {
    throw new Error(`${shared} holds a xaq daemon's data (${PRODUCT}.db), so the listener can't install there. Run the daemon with another --data directory, or set XDG_DATA_HOME for the listener.`);
  }

  const node = deps.node ?? serviceNode();
  let runningPid = 0;
  // Commands run in the private work dir; the unit uses it too.
  const cwd = config.cwd;
  mkdirSync(listenStateDir(), { recursive: true, mode: 0o700 });
  ensurePrivateDir(cwd);

  // The same install path as the daemon (stage into app.new, swap into app), under a lock: two installs at
  // once would trip over app.new / app.old.
  mkdirSync(shared, { recursive: true, mode: 0o700 });
  const releaseInstallLock = acquireFileLock(
    join(shared, "install.lock"),
    (holder) => new Error(`Another listener service install is running (pid ${holder.pid}, since ${holder.startedAt}). Try again when it has finished.`),
    { privateDir: false },
  );
  try {
    await installLocked();
  } finally {
    releaseInstallLock();
  }

  async function installLocked(): Promise<void> {
    const staging = (deps.stage ?? stageListenerApp)(join(shared, "app.new"));
    // Saved only once the new version is staged: a failed npm install changes nothing.
    saveProfile({ ...profile, ...settings });
    const app = listenAppDir();
    const entry = installedEntry(app);
    const file = unitPath(ops, LISTEN_UNIT);
    const previousUnit = readText(file);
    const since = Date.now();
    let swap: ReturnType<typeof swapIn> | null = null;
    try {
      swap = swapIn(staging, app);
      mkdirSync(ops.unitDir(), { recursive: true });
      if (ops.platform === "linux") writeFileSync(file, systemdListenUnit(entry, cwd, ops.root, node.path));
      else writeFileSync(file, launchdListenPlist(entry, cwd, node.path), { mode: 0o600 });
      await startUnit(ops, file, deps.pollMs);
      const pid = await (deps.waitStarted ?? waitListenerStarted)(since);
      if (!pid) throw new Error("the listener did not start");
      // Only a listener the service manager itself runs counts: not an older job still loaded, nor a
      // foreground one (the listener lock keeps those apart, so a pid match means it is ours).
      const svc = managerState(ops);
      if (!svc.running) throw new Error(`the service manager doesn't report it running (${svc.detail})`);
      if (svc.pid !== pid) throw new Error(`the listener that started (pid ${pid}) isn't the service's process (${svc.detail})`);
      runningPid = pid;
    } catch (err) {
      // Best effort, but reported as it went: never claim a rollback that didn't happen.
      const failed: string[] = [];
      const step = (what: string, fn: () => void) => {
        try {
          fn();
        } catch (e) {
          failed.push(`${what}: ${why(e)}`);
        }
      };
      if (swap) step("restoring the previous install", () => swap!.restore());
      // The settings this install saved go back too, so the restored listener runs as before.
      step("restoring the saved settings", () => saveProfile(profile));
      step("removing the staged install", () => rmSync(staging, { recursive: true, force: true }));
      let outcome: string;
      if (previousUnit !== null) {
        step("restoring the previous unit file", () => writeFileSync(file, previousUnit, { mode: ops.platform === "darwin" ? 0o600 : 0o644 }));
        const restarted = await startUnit(ops, file, deps.pollMs).then(
          () => null,
          (e: unknown) => why(e),
        );
        const svc = restarted ? null : managerState(ops);
        outcome = restarted
          ? `Put the previous install back, but restarting it failed (${restarted}), so no listener service is running now`
          : svc!.running
            ? `Put the previous install back; it is running again (${svc!.detail})`
            : `Put the previous install back and started it, but the service manager doesn't report it running (${svc!.detail})`;
      } else {
        step("removing the new service", () => {
          if (existsSync(file)) removeUnit(ops, file);
        });
        outcome = "Removed the new service again (no listener service is installed)";
      }
      if (failed.length) outcome += `. These rollback steps failed too: ${failed.join("; ")}`;
      const hints = listenerHints(ops)
        .map((h) => `    ${h}`)
        .join("\n");
      throw new Error(`Starting the listener service failed (${why(err)}). ${outcome}.\n  To find out why:\n${hints}`);
    }
    swap.commit();
    enableLinger(ops);
  }

  const kind = ops.platform === "linux" ? (ops.root ? "systemd system service" : "systemd user service") : "launchd agent";
  console.log(`\n  ${pc.green("✔")} Installed the listener as a ${kind} (${label(ops)}); it is running as pid ${runningPid}.`);
  console.log(`    Runs:      --exec ${config.exec}`);
  console.log(`    Directory: ${cwd} (private)`);
  console.log(`    Node.js:   ${node.path} (v${node.version}): ${node.why}. If you remove it, run \`${NPX} listen service install\` again.`);
  console.log(`    Settings:  ${profilePath()} (change them with \`${NPX} listen service install <flags>\`)`);
  console.log(`    Log:       ${logPath()}`);
  console.log(`    Status:    ${NPX} listen status`);
  if (ops.platform === "linux") console.log(`    Follow:    journalctl ${ops.root ? "" : "--user "}-u ${UNIT_NAME} -f`);
  console.log();
}

export function uninstallListenService(quiet = false, deps: ListenServiceDeps = {}): void {
  const ops = deps.ops ?? systemOps();
  assertSupported(ops);
  const file = installedUnitFile(ops);
  if (!file) {
    if (!quiet) console.log("No listener service is installed.");
    return;
  }
  removeUnit(ops, file);
  // Remove the install too (only if it really is ours).
  removeOwnInstall(dataDir());
  if (!quiet) console.log(`Removed the listener service. The pairing (and its key) was kept: ${profilePath()}`);
}

export function listenServiceStatus(deps: ListenServiceDeps = {}): void {
  const ops = deps.ops ?? systemOps();
  assertSupported(ops);
  if (!installedUnitFile(ops)) {
    console.log(`No listener service is installed. Install one with \`${NPX} listen service install --recipe claude-code\`.`);
    process.exitCode = 1;
    return;
  }
  try {
    if (ops.platform === "linux") systemctl(ops, "status", UNIT_NAME, "--no-pager");
    else ops.exec("launchctl", ["print", `${launchdTarget(ops)}/${LAUNCHD_LABEL}`]);
  } catch {
    process.exitCode = 1;
  }
}
