import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import pc from "picocolors";
import { envVar, LEGACY_PRODUCT, PRODUCT } from "../brand.ts";
import {
  assertSupported,
  bootstrapLaunchd,
  commandFailure,
  enableLinger,
  installedEntry,
  launchdTarget,
  LEGACY_PACKAGE,
  preflight,
  readText,
  removeOwnInstall,
  restoreUnit,
  sdQuote,
  serviceMainPid,
  type ServiceOps,
  stagePackage,
  stopAndWait,
  swapIn,
  systemctl,
  systemOps,
  type UnitId,
  unitPath,
  unitState,
  xmlEscape,
} from "../service.ts";
import { ensurePrivateDir } from "./fsutil.ts";
import { EXIT } from "./listen.ts";
import { acquireFileLock } from "./lock.ts";
import { type ListenFlags, resolveListen } from "./options.ts";
import { serviceNode, type ServiceNodeChoice } from "./mcpheader.ts";
import { DEFAULT_PROFILE, dataDir, listenAppDir, logPath, profilePath, profileStateDir, validProfileName } from "./paths.ts";
import { gatewayWarning } from "./hermes.ts";
import { hermesChangeNote, isHermesRoute, RECIPE_NAMES } from "./recipes.ts";
import { loadProfile, saveProfile } from "./profile.ts";
import { pidAlive, readStatus } from "./state.ts";
import { checkTransport } from "./transport.ts";
import { NPX } from "./version.ts";

/**
 * `xaq listen service install|uninstall|status`: one systemd user unit / launchd agent per
 * profile, running from a stable install (not the npx cache). The unit only says which profile to
 * run; settings and the key stay in the 0600 profile file. Installation reuses the daemon's
 * machinery (server/service.ts): systemd pre-check, the user manager's unit directory, staging into
 * app.new and swapping in, rollback when the new listener doesn't start.
 *
 * A listener installed before the rename (agentinbox-listen-<profile> / com.unlaboredlabs.agentinbox.listen.<profile>)
 * is replaced by `install` for its profile: stopped and waited for before the new one starts (one listener
 * per profile, never two), and put back exactly as it was if the new one fails. `status` and
 * `uninstall` find either name.
 */

export const unitName = (profile: string) => `${PRODUCT}-listen-${profile}`;
export const launchdLabel = (profile: string) => `sh.xaq.listen.${profile}`;
/** The names before the rename. */
export const legacyUnitName = (profile: string) => `${LEGACY_PRODUCT}-listen-${profile}`;
export const legacyLaunchdLabel = (profile: string) => `com.unlaboredlabs.agentinbox.listen.${profile}`;

export const listenUnit = (profile: string): UnitId => ({ launchd: launchdLabel(profile), systemd: unitName(profile) });
export const legacyListenUnit = (profile: string): UnitId => ({ launchd: legacyLaunchdLabel(profile), systemd: legacyUnitName(profile) });

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
  // PATH matters most: `claude`, `codex`, `hermes`… usually live in ~/.local/bin, nvm or Homebrew dirs
  // that a service manager's minimal PATH doesn't include.
  env.PATH = servicePath(undefined, node);
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HERMES_HOME", "LANG"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  const debug = envVar("DEBUG");
  if (debug) env.XAQ_DEBUG = debug;
  return env;
}

export function systemdListenUnit(profile: string, entry: string, cwd: string, system = false, node = process.execPath): string {
  const vars = Object.entries(serviceEnvironment(node))
    .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=xaq listener (profile ${profile})${system ? "\nAfter=network-online.target\nWants=network-online.target" : ""}
StartLimitIntervalSec=0

[Service]
ExecStart=${sdQuote(node)} ${sdQuote(entry)} listen --profile ${profile}
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

export function launchdListenPlist(profile: string, entry: string, cwd: string, node = process.execPath): string {
  const esc = xmlEscape;
  const vars = Object.entries(serviceEnvironment(node))
    .map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`)
    .join("\n");
  // The listener logs to the rotated listen.log and stays quiet on the console under launchd; only
  // crashes reach stderr, so this file stays small.
  const errLog = esc(join(profileStateDir(profile), "service-stderr.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(launchdLabel(profile))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(entry)}</string>
    <string>listen</string>
    <string>--profile</string>
    <string>${esc(profile)}</string>
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

const unitFile = (ops: ServiceOps, profile: string) => unitPath(ops, listenUnit(profile));
const label = (ops: Pick<ServiceOps, "platform">, id: UnitId) => (ops.platform === "linux" ? id.systemd : id.launchd);

/** Listener profiles with a unit file under the new names, or (`legacy`) under the names from before the rename. */
function profilesWithUnits(ops: ServiceOps, legacy: boolean): string[] {
  const dir = ops.unitDir();
  if (!existsSync(dir)) return [];
  const re =
    ops.platform === "darwin"
      ? legacy
        ? /^com\.unlaboredlabs\.agentinbox\.listen\.(.+)\.plist$/
        : /^sh\.xaq\.listen\.(.+)\.plist$/
      : legacy
        ? /^agentinbox-listen-(.+)\.service$/
        : /^xaq-listen-(.+)\.service$/;
  return readdirSync(dir)
    .map((f) => re.exec(f)?.[1])
    .filter((p): p is string => !!p);
}

/** Installed listener profiles (from the unit directory), under either name. */
function installedProfiles(ops: ServiceOps): string[] {
  return [...new Set([...profilesWithUnits(ops, false), ...profilesWithUnits(ops, true)])];
}

/** The profile's installed listener service: the new one, else one from before the rename; null when neither. */
export function installedListenUnit(profile: string, ops: ServiceOps = systemOps()): { id: UnitId; file: string; legacy: boolean } | null {
  if (ops.platform !== "linux" && ops.platform !== "darwin") return null;
  try {
    for (const [id, legacy] of [
      [listenUnit(profile), false],
      [legacyListenUnit(profile), true],
    ] as const) {
      const file = unitPath(ops, id);
      if (existsSync(file)) return { id, file, legacy };
    }
  } catch {
    // No unit directory to look in.
  }
  return null;
}

export function isServiceInstalled(profile: string, ops: ServiceOps = systemOps()): boolean {
  return installedListenUnit(profile, ops) !== null;
}

/** The service's name as the platform knows it (for status lines), under whichever name it is installed. */
export const installedServiceLabel = (profile: string, ops: ServiceOps = systemOps()): string | null => {
  const u = installedListenUnit(profile, ops);
  return u ? label(ops, u.id) : null;
};

function listenerHints(ops: ServiceOps, profile: string, id: UnitId = listenUnit(profile)): string[] {
  if (ops.platform === "darwin") return [`launchctl print ${launchdTarget(ops)}/${id.launchd}`, `the log ${logPath(profile)}`];
  const scope = ops.root ? "" : " --user";
  return [`systemctl${scope} status ${id.systemd}`, `journalctl${scope} -u ${id.systemd} -e`, `the log ${logPath(profile)}`];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The pid of a listener started after `since` for the profile (it writes status.json on start), once it
 * has stayed up for a moment; null if none did within the timeout, or it stopped again.
 */
export async function waitListenerStarted(profile: string, since: number, timeoutMs = 20_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = readStatus(profile);
    if (st && Date.parse(st.startedAt) >= since - 1000) {
      if (st.stoppedAt) return null;
      if (pidAlive(st.pid)) {
        // A listener that exits at once (bad settings, revoked key) must not count as started.
        await sleep(1000);
        const again = readStatus(profile);
        return again?.pid === st.pid && !again.stoppedAt && pidAlive(st.pid) ? st.pid : null;
      }
    }
    await sleep(250);
  }
  return null;
}

const why = commandFailure;

/** What the service manager says about the profile's listener (under `id`'s names): running (with its pid), or why not. */
export function managerState(ops: ServiceOps, profile: string, id: UnitId = listenUnit(profile)): { running: boolean; pid: number | null; detail: string } {
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

/** (Re)starts the profile's unit with the file just written (launchd: see bootstrapLaunchd). */
async function startUnit(ops: ServiceOps, profile: string, file: string, pollMs = 250): Promise<void> {
  if (ops.platform === "linux") {
    systemctl(ops, "daemon-reload");
    systemctl(ops, "enable", unitName(profile));
    // restart, not start: a re-install must pick up the new install and settings.
    systemctl(ops, "restart", unitName(profile));
    return;
  }
  await bootstrapLaunchd(ops, launchdLabel(profile), file, { pollMs });
}

/** Stops and removes one unit (no waiting: for uninstall and for undoing a new unit that never ran). */
function removeUnit(ops: ServiceOps, id: UnitId, file: string): void {
  if (ops.platform === "linux") {
    try {
      systemctl(ops, "disable", "--now", id.systemd);
    } catch {
      // Already stopped.
    }
    rmSync(file);
    systemctl(ops, "daemon-reload");
  } else {
    try {
      ops.exec("launchctl", ["bootout", `${launchdTarget(ops)}/${id.launchd}`], { quiet: true });
    } catch {
      // Not loaded.
    }
    rmSync(file);
  }
}

/**
 * Listener units from before the rename start `<app>/node_modules/agentinbox-cli/dist/cli.js`. While some
 * still run from this shared install (other profiles not moved yet), it keeps that path working: a tiny
 * module there runs xaq-cli, so those listeners run the new version under their old names until
 * `listen service install --profile <name>` moves them too.
 */
export function writeLegacyEntry(app: string): void {
  const dir = join(app, "node_modules", LEGACY_PACKAGE);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: LEGACY_PACKAGE, private: true, type: "module", description: "Runs xaq-cli for listener services installed before the rename." }, null, 2)}\n`);
  writeFileSync(join(dir, "dist", "cli.js"), `// Listener services installed as agentinbox still start this path: run xaq-cli.\nimport "../../xaq-cli/dist/cli.js";\n`);
}

/** Stages the listeners' install (no web console needed). */
export const stageListenerApp = (staging: string): string => stagePackage(staging, { where: dirname(staging), requireWeb: false });

export interface ListenServiceDeps {
  ops?: ServiceOps;
  /** Installs the package into the given staging dir (tests). */
  stage?: (staging: string) => string;
  /** Readiness check after (re)starting the unit: the new listener's pid (tests). */
  waitStarted?: (profile: string, since: number) => Promise<number | null>;
  /** The node the unit runs (tests). */
  node?: ServiceNodeChoice;
  /** launchd polling interval (tests). */
  pollMs?: number;
  /** Probes the Hermes gateway (tests). */
  gatewayCheck?: (url: string) => Promise<string | null>;
}

export async function installListenService(flags: ListenFlags, deps: ListenServiceDeps = {}): Promise<void> {
  const ops = deps.ops ?? systemOps();
  assertSupported(ops);
  const profileName = validProfileName(flags.profile ?? DEFAULT_PROFILE);
  const profile = loadProfile(profileName);
  // Service settings live in the profile: save whatever was passed with this command.
  const { config, next } = resolveListen(profileName, profile, { ...flags, save: true });
  if (!config.exec && !config.forward) {
    throw new Error(`Nothing for the service to run. Pass --recipe <name> (${RECIPE_NAMES.join(", ")}), --exec "<command>" and/or --forward <url> (they are saved to profile "${profileName}").`);
  }
  await checkTransport(next.url, { insecure: config.insecure });
  preflight(ops);
  const shared = dataDir();
  // A daemon started with --data pointing here would share (and lose) its app/ install with us.
  const daemonDb = [`${PRODUCT}.db`, `${LEGACY_PRODUCT}.db`].find((f) => existsSync(join(shared, f)));
  if (daemonDb) {
    throw new Error(`${shared} holds a xaq daemon's data (${daemonDb}), so the listener can't install there. Run the daemon with another --data directory, or set XDG_DATA_HOME for the listener.`);
  }

  const p = profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`;
  const node = deps.node ?? serviceNode();
  let runningPid = 0;
  let replacedLegacy = false;
  // Commands run in config.cwd (a private dir unless --cwd was given); the unit uses it too.
  const cwd = config.cwd;
  mkdirSync(profileStateDir(profileName), { recursive: true, mode: 0o700 });
  if (config.cwdIsDefault) ensurePrivateDir(cwd);

  // The same install path as the daemon (stage into app.new, swap into app), under a lock: all
  // profiles share this install, so two installs at once would trip over app.new / app.old.
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
    saveProfile(profileName, next);
    const app = listenAppDir();
    const entry = installedEntry(app);
    const file = unitFile(ops, profileName);
    const previousUnit = readText(file);
    // This profile's listener from before the rename, if any: replaced, or put back on failure.
    const legacyId = legacyListenUnit(profileName);
    const legacyFile = unitPath(ops, legacyId);
    const legacyText = readText(legacyFile);
    const legacyState = legacyText !== null ? unitState(ops, legacyId) : null;
    let legacyStopped = false;
    // Other profiles' pre-rename units that run from this same install must keep a working entry point.
    const legacyEntry = join(app, "node_modules", LEGACY_PACKAGE);
    const othersOnLegacy = profilesWithUnits(ops, true).filter((o) => o !== profileName && (readText(unitPath(ops, legacyListenUnit(o))) ?? "").includes(legacyEntry));
    if (othersOnLegacy.length) writeLegacyEntry(staging);
    const since = Date.now();
    let swap: ReturnType<typeof swapIn> | null = null;
    try {
      swap = swapIn(staging, app);
      mkdirSync(ops.unitDir(), { recursive: true });
      if (ops.platform === "linux") writeFileSync(file, systemdListenUnit(profileName, entry, cwd, ops.root, node.path));
      else writeFileSync(file, launchdListenPlist(profileName, entry, cwd, node.path), { mode: 0o600 });
      if (legacyText !== null) {
        // One listener per profile: the old one is gone (launchd: unloaded) before the new one starts.
        legacyStopped = true;
        await stopAndWait(ops, legacyId, { pollMs: deps.pollMs });
        rmSync(legacyFile, { force: true });
      }
      await startUnit(ops, profileName, file, deps.pollMs);
      const pid = await (deps.waitStarted ?? waitListenerStarted)(profileName, since);
      if (!pid) throw new Error("the listener did not start");
      // Only a listener the service manager itself runs counts: not an older job still loaded, nor a
      // foreground one (the profile lock keeps those apart, so a pid match means it is ours).
      const svc = managerState(ops, profileName);
      if (!svc.running) throw new Error(`the service manager doesn't report it running (${svc.detail})`);
      if (svc.pid !== pid) throw new Error(`the listener that started (pid ${pid}) isn't the service's process (${svc.detail})`);
      runningPid = pid;
      replacedLegacy = legacyText !== null;
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
      step("restoring the profile's settings", () => saveProfile(profileName, profile));
      step("removing the staged install", () => rmSync(staging, { recursive: true, force: true }));
      let outcome: string;
      if (previousUnit !== null) {
        step("restoring the previous unit file", () => writeFileSync(file, previousUnit, { mode: ops.platform === "darwin" ? 0o600 : 0o644 }));
        const restarted = await startUnit(ops, profileName, file, deps.pollMs).then(
          () => null,
          (e: unknown) => why(e),
        );
        const svc = restarted ? null : managerState(ops, profileName);
        outcome = restarted
          ? `Put the previous install back, but restarting it failed (${restarted}), so no listener service is running now`
          : svc!.running
            ? `Put the previous install back; it is running again (${svc!.detail})`
            : `Put the previous install back and started it, but the service manager doesn't report it running (${svc!.detail})`;
      } else {
        // Before the old listener comes back, the new one must be gone (launchd tears it down asynchronously).
        if (legacyStopped) await stopAndWait(ops, listenUnit(profileName), { pollMs: deps.pollMs }).catch((e: unknown) => failed.push(`stopping the new service: ${why(e)}`));
        step("removing the new service", () => {
          if (existsSync(file)) removeUnit(ops, listenUnit(profileName), file);
        });
        outcome = legacyText !== null ? "Removed the new service again" : "Removed the new service again (no listener service is installed)";
      }
      if (legacyText !== null && legacyStopped) {
        // The pre-rename listener comes back under its own name, running (and enabled) only if it was before.
        const restored = await restoreUnit(ops, legacyId, legacyFile, legacyText, legacyState!, deps.pollMs).then(
          () => null,
          (e: unknown) => why(e),
        );
        const svc = restored || !legacyState!.running ? null : managerState(ops, profileName, legacyId);
        outcome += restored
          ? `. Putting the ${LEGACY_PRODUCT} listener (${label(ops, legacyId)}) back failed (${restored})`
          : svc
            ? `. Put the ${LEGACY_PRODUCT} listener (${label(ops, legacyId)}) back${svc.running ? `; it is running again (${svc.detail})` : `, but the service manager doesn't report it running (${svc.detail})`}`
            : `. Put the ${LEGACY_PRODUCT} listener (${label(ops, legacyId)}) back, stopped as it was`;
      } else if (legacyText !== null) {
        outcome += `. The ${LEGACY_PRODUCT} listener (${label(ops, legacyId)}) was left as it was`;
      }
      if (failed.length) outcome += `. These rollback steps failed too: ${failed.join("; ")}`;
      const hints = listenerHints(ops, profileName, legacyText !== null && previousUnit === null ? legacyId : listenUnit(profileName))
        .map((h) => `    ${h}`)
        .join("\n");
      throw new Error(`Starting the listener service failed (${why(err)}). ${outcome}.\n  To find out why:\n${hints}`);
    }
    swap.commit();
    enableLinger(ops);
    // The other profiles' listeners share the install: move them onto the new one (whichever name they run under).
    for (const other of profilesWithUnits(ops, false).filter((o) => o !== profileName)) restartOther(listenUnit(other));
    for (const other of othersOnLegacy) restartOther(legacyListenUnit(other));
    if (othersOnLegacy.length) {
      const list = othersOnLegacy.map((o) => `${o} (\`${NPX} listen service install --profile ${o}\`)`).join(", ");
      console.log(`\n  ${pc.yellow("!")} Still under their ${LEGACY_PRODUCT} service names (running this version): ${list}. Run those to move them to xaq too.`);
    }
  }

  function restartOther(id: UnitId): void {
    try {
      if (ops.platform === "linux") systemctl(ops, "try-restart", id.systemd);
      else ops.exec("launchctl", ["kickstart", "-k", `${launchdTarget(ops)}/${id.launchd}`], { quiet: true });
    } catch {
      // Not running: nothing to restart.
    }
  }

  const kind = ops.platform === "linux" ? (ops.root ? "systemd system service" : "systemd user service") : "launchd agent";
  console.log(
    `\n  ${pc.green("✔")} Installed the listener for profile "${profileName}" as a ${kind} (${label(ops, listenUnit(profileName))}); it is running as pid ${runningPid}.`,
  );
  if (replacedLegacy) console.log(`    Replaced:  the ${LEGACY_PRODUCT} listener service ${label(ops, legacyListenUnit(profileName))} (removed; the profile, its key and its cursor are unchanged)`);
  console.log(`    Runs:      ${config.exec ? `--exec ${config.exec}` : ""}${config.exec && config.forward ? "  and  " : ""}${config.forward ? `--forward ${config.forward.url}` : ""}`);
  console.log(`    Directory: ${cwd}${config.cwdIsDefault ? " (private; pass --cwd to run in a project)" : ""}`);
  console.log(`    Node.js:   ${node.path} (v${node.version}): ${node.why}. If you remove it, run \`${NPX} listen service install${p}\` again.`);
  console.log(`    Settings:  ${profilePath(profileName)} (change them with \`${NPX} listen${p} … --save\`, then reinstall)`);
  console.log(`    Log:       ${logPath(profileName)}`);
  const change = hermesChangeNote(flags.recipe, config.exec);
  if (change) console.log(`    Note:      ${change}`);
  if (config.forward && isHermesRoute(config.forward.url)) {
    const w = await (deps.gatewayCheck ?? gatewayWarning)(config.forward.url);
    if (w) console.log(pc.yellow(`    Warning:   ${w}`));
  }
  console.log(`    Status:    ${NPX} listen status${p}`);
  if (ops.platform === "linux") console.log(`    Follow:    journalctl ${ops.root ? "" : "--user "}-u ${unitName(profileName)} -f`);
  console.log();
}

export function uninstallListenService(profileName: string, quiet = false, deps: ListenServiceDeps = {}): void {
  const ops = deps.ops ?? systemOps();
  assertSupported(ops);
  const name = validProfileName(profileName);
  const units = [listenUnit(name), legacyListenUnit(name)].map((id) => ({ id, file: unitPath(ops, id) })).filter((u) => existsSync(u.file));
  if (!units.length) {
    if (!quiet) console.log(`No listener service is installed for profile "${name}".`);
    return;
  }
  for (const u of units) removeUnit(ops, u.id, u.file);
  // The last listener gone: remove the shared install too (only if it really is ours).
  if (!installedProfiles(ops).length) removeOwnInstall(dataDir());
  if (!quiet) console.log(`Removed the listener service for profile "${name}". The profile (and its key) was kept: ${profilePath(name)}`);
}

export function listenServiceStatus(profileName: string, deps: ListenServiceDeps = {}): void {
  const ops = deps.ops ?? systemOps();
  assertSupported(ops);
  const name = validProfileName(profileName);
  const p = name === DEFAULT_PROFILE ? "" : ` --profile ${name}`;
  const installed = installedListenUnit(name, ops);
  if (!installed) {
    console.log(`No listener service is installed for profile "${name}". Install one with \`${NPX} listen service install${p}\`.`);
    process.exitCode = 1;
    return;
  }
  if (installed.legacy) {
    console.log(`This listener runs under its name from before the rename to xaq (${label(ops, installed.id)}). \`${NPX} listen service install${p}\` moves it to ${label(ops, listenUnit(name))}.\n`);
  }
  try {
    if (ops.platform === "linux") systemctl(ops, "status", installed.id.systemd, "--no-pager");
    else ops.exec("launchctl", ["print", `${launchdTarget(ops)}/${installed.id.launchd}`]);
  } catch {
    process.exitCode = 1;
  }
}
