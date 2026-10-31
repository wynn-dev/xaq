import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NPM_PACKAGE as PACKAGE, type SelfUpdateStatus } from "../shared/types.ts";
import { type Config, dataFiles, DEFAULT_PORT } from "./config.ts";
import {
  bootstrapLaunchd,
  installedEntry,
  installedVersion,
  installService,
  launchdTarget,
  readText,
  ROOT,
  type ServiceOps,
  systemOps,
  type UnitId,
  unitEnv,
  unitFile,
  xmlEscape,
} from "./service.ts";
import { errorMessage } from "./util/errors.ts";

/**
 * One-click update from the console. The console asks; the app checks the admin password and starts the update
 * job, a separate transient systemd unit or launchd job (stopping the service mustn't stop it), and the job runs
 * what `service install` does with the new version (staged with the supply-chain checks). It writes
 * `update/status.json` at the start and the end, which the console polls.
 *
 * The job runs this module from the install it replaces, so everything it needs is imported statically here:
 * after the swap, a lazy import would find the files gone. Keep it that way.
 */

export const UPDATE_UNIT: UnitId = { launchd: "sh.xaq.update", systemd: "xaq-update" };
/** A `running` status older than this is a job that died: another one may start. */
export const STALE_MS = 30 * 60_000;

export interface UpdateJobRequest {
  dataDir: string;
  id: string;
  /** The version to install. */
  version: string;
}

export const updateDir = (dataDir: string) => join(dataDir, "update");
export const updateStatusPath = (dataDir: string) => join(updateDir(dataDir), "status.json");
export const newUpdateId = () => randomBytes(6).toString("hex");

export function readUpdateStatus(dataDir: string): SelfUpdateStatus | null {
  try {
    return JSON.parse(readFileSync(updateStatusPath(dataDir), "utf8")) as SelfUpdateStatus;
  } catch {
    return null;
  }
}

/** Replaces the status file in one rename, so a reader never sees half of it. */
export function writeUpdateStatus(dataDir: string, status: SelfUpdateStatus): void {
  mkdirSync(updateDir(dataDir), { recursive: true, mode: 0o700 });
  const file = updateStatusPath(dataDir);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Whether an update job is running (its status says so and isn't stale). */
export const updateRunning = (status: SelfUpdateStatus | null, now = Date.now()) => status?.state === "running" && now - Date.parse(status.startedAt) < STALE_MS;

/**
 * Whether this process can update itself from the console: a service (systemd or launchd) running from
 * its own install in the data directory. Foreground and source runs keep the update notice with the command to run.
 */
export function selfUpdateSupport(
  config: Pick<Config, "service" | "dataDir">,
  root: string = ROOT,
  platform: NodeJS.Platform = process.platform,
): { supported: boolean; reason: string | null } {
  if (!config.service) return { supported: false, reason: "xaq runs in a terminal, not as a service, so it can't update itself. Run the command below." };
  if (platform !== "linux" && platform !== "darwin") return { supported: false, reason: "Updating from the console needs systemd or launchd." };
  if (resolve(root) !== resolve(join(config.dataDir, "app", "node_modules", PACKAGE))) {
    return { supported: false, reason: "This service doesn't run from its own install in the data directory (a source checkout). Run the command below." };
  }
  return { supported: true, reason: null };
}

// ───────────── Starting the job (from the app) ─────────────

/** The job's command line: this Node and this install's CLI. */
export function updateJobCommand(req: UpdateJobRequest, execPath: string = process.execPath): string[] {
  return [execPath, installedEntry(join(req.dataDir, "app")), "service", "update-run", "--data", req.dataDir, "--id", req.id, "--to", req.version];
}

/** The job's PATH: npm next to this Node first (a Node from fnm or nvm isn't on a service's PATH). */
const jobPath = (execPath: string, env: NodeJS.ProcessEnv) => [dirname(execPath), env.PATH || "/usr/local/bin:/usr/bin:/bin"].join(":");

/** The launchd job: runs once (no KeepAlive), logging next to the status file. Lives in the data directory, never LaunchAgents, so nothing runs it again at login. */
export function renderUpdatePlist(command: string[], dataDir: string, path: string): string {
  const esc = xmlEscape;
  const log = esc(join(updateDir(dataDir), "update.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${UPDATE_UNIT.launchd}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(path)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

/** Whether launchd runs the update job now. One that ended stays loaded (`state = not running`) until the next is bootstrapped. */
export function launchdJobRunning(ops: Pick<ServiceOps, "capture" | "uid">): boolean {
  try {
    return /^\s*state = running\s*$/m.test(ops.capture("launchctl", ["print", `${launchdTarget(ops)}/${UPDATE_UNIT.launchd}`]));
  } catch {
    return false;
  }
}

/**
 * Starts the update job outside the service, so stopping the service doesn't stop it: a transient systemd
 * unit (`systemd-run`, collected when it ends) or a launchd job. Throws when it couldn't be started: a launchd
 * job still running is never replaced (bootstrapping the label again would tear it down mid-update), and
 * systemd-run refuses a unit name that is still active.
 */
export async function launchUpdateJob(ops: ServiceOps, req: UpdateJobRequest, execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const command = updateJobCommand(req, execPath);
  const path = jobPath(execPath, env);
  if (ops.platform === "darwin") {
    if (launchdJobRunning(ops)) throw new Error(`launchd is still running the previous update job (${UPDATE_UNIT.launchd})`);
    const file = join(updateDir(req.dataDir), `${UPDATE_UNIT.launchd}.plist`);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, renderUpdatePlist(command, req.dataDir, path), { mode: 0o600 });
    await bootstrapLaunchd(ops, UPDATE_UNIT.launchd, file);
    return;
  }
  ops.capture("systemd-run", [...(ops.root ? [] : ["--user"]), `--unit=${UPDATE_UNIT.systemd}`, "--collect", "--quiet", `--setenv=PATH=${path}`, "--", ...command]);
}

// ───────────── The job ─────────────

/** What the job needs from the machine; tests fake it. */
export type UpdateJobDeps = { ops: ServiceOps; install?: typeof installService };

/**
 * The update job (`xaq service update-run`): `service install` of `version`, for the installed service's data
 * directory, port and host, on the Node the job runs on (the service's). Never throws: the outcome ends up in the
 * status file.
 */
export async function runUpdateJob(req: UpdateJobRequest, deps: UpdateJobDeps = { ops: systemOps() }): Promise<SelfUpdateStatus> {
  const { dataDir } = req;
  const from = installedVersion(join(dataDir, "app")) ?? "unknown";
  let status: SelfUpdateStatus = { id: req.id, from, to: req.version, state: "running", message: null, startedAt: new Date().toISOString(), finishedAt: null };
  writeUpdateStatus(dataDir, status);
  try {
    const unit = readText(unitFile(deps.ops));
    if (unit === null) throw new Error("The xaq service isn't installed, so there is nothing to update.");
    const port = Number(unitEnv(unit, "PORT"));
    const config = {
      dataDir,
      dbPath: dataFiles(dataDir).db,
      masterKeyPath: join(dataDir, "master.key"),
      port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT,
      host: unitEnv(unit, "HOST") || "0.0.0.0",
    };
    await (deps.install ?? installService)(config, deps.ops, { version: req.version });
    status = { ...status, state: "succeeded" };
  } catch (err) {
    status = { ...status, state: "failed", message: errorMessage(err) };
  }
  status = { ...status, finishedAt: new Date().toISOString() };
  writeUpdateStatus(dataDir, status);
  console.log(`[${status.id}] ${from} → ${req.version}: ${status.state}${status.message ? `: ${status.message}` : ""}`);
  return status;
}
