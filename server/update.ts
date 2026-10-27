import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { NPM_PACKAGE as PACKAGE, type SelfUpdateStatus } from "../shared/types.ts";
import { AuditLog } from "./audit.ts";
import { createBus } from "./bus.ts";
import { type Config, dataFiles, DEFAULT_PORT } from "./config.ts";
import { Db } from "./db/index.ts";
import {
  bootstrapLaunchd,
  DAEMON_UNIT,
  installedEntry,
  installedVersion,
  isHealthResponse,
  isOwnInstall,
  LAUNCHD_LABEL,
  readText,
  ROOT,
  SERVICE_NAME,
  type ServiceOps,
  stagePackage,
  stopAndWait,
  swapIn,
  systemctl,
  systemOps,
  type UnitId,
  unitEnv,
  unitPath,
  unitState,
  xmlEscape,
} from "./service.ts";
import { loopbackUrl } from "./urls.ts";
import { errorMessage } from "./util/errors.ts";

/**
 * One-click update from the console (docs/adr/0002-console-self-update.md). The console asks; the app checks
 * the admin password and starts the update job, a separate transient systemd unit or launchd job, and the
 * job does the work: stage the new version with the supply-chain checks, stop the service, snapshot the
 * database, swap `app` for the new install (the current one becomes `app.old`), start, wait for /api/health
 * to answer with the new version, and put everything back when it doesn't. It writes `update/status.json`
 * as it goes, which the console polls.
 *
 * The job runs this module from the install it is about to move aside, so everything it needs is imported
 * statically here: after the swap, a lazy import would load the other version's files. Keep it that way.
 */

export const UPDATE_UNIT: UnitId = { launchd: "sh.xaq.update", systemd: "xaq-update" };
/** A `running` status older than this is a job that died: another one may start. */
const STALE_MS = 30 * 60_000;

export interface UpdateJobRequest {
  dataDir: string;
  id: string;
  kind: SelfUpdateStatus["kind"];
  /** The version to install (`update`); ignored for `rollback`, which goes back to app.old. */
  version?: string;
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

/** The job running now, if any (a `running` status that isn't stale). */
export function activeUpdate(dataDir: string, now = Date.now()): SelfUpdateStatus | null {
  const status = readUpdateStatus(dataDir);
  return status?.state === "running" && now - Date.parse(status.startedAt) < STALE_MS ? status : null;
}

/** The version in `<data>/app.old` when it is our install and not this version: what "go back" returns to. */
export function previousVersion(dataDir: string, current: string): string | null {
  const old = join(dataDir, "app.old");
  if (!isOwnInstall(old) || !existsSync(installedEntry(old))) return null;
  const version = installedVersion(old);
  return version && version !== current ? version : null;
}

/**
 * Whether this process can update itself from the console: a service (systemd or launchd) running from
 * its own install in the data directory. Foreground and source runs (and a service from before the
 * rename) keep the update notice with the command to run.
 */
export function selfUpdateSupport(
  config: Pick<Config, "service" | "dataDir">,
  root: string = ROOT,
  platform: NodeJS.Platform = process.platform,
): { supported: boolean; reason: string | null } {
  if (!config.service) return { supported: false, reason: "xaq runs in a terminal, not as a service, so it can't update itself. Run the command below." };
  if (platform !== "linux" && platform !== "darwin") return { supported: false, reason: "Updating from the console needs systemd or launchd." };
  if (resolve(root) !== resolve(join(config.dataDir, "app", "node_modules", PACKAGE))) {
    return { supported: false, reason: "This service doesn't run from its own install in the data directory (a source checkout, or a service from before the rename). Run the command below." };
  }
  return { supported: true, reason: null };
}

// ───────────── Starting the job (from the app) ─────────────

/** The job's command line: this Node and this install's CLI. */
export function updateJobCommand(req: UpdateJobRequest, execPath: string = process.execPath): string[] {
  const args = [execPath, installedEntry(join(req.dataDir, "app")), "service", "update-run", "--data", req.dataDir, "--id", req.id];
  return req.kind === "rollback" ? [...args, "--back"] : [...args, "--to", req.version!];
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

/**
 * Starts the update job outside the service, so stopping the service doesn't stop it: a transient systemd
 * unit (`systemd-run`, collected when it ends) or a launchd job. Throws when it couldn't be started.
 */
export async function launchUpdateJob(ops: ServiceOps, req: UpdateJobRequest, execPath: string = process.execPath, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const command = updateJobCommand(req, execPath);
  const path = jobPath(execPath, env);
  if (ops.platform === "darwin") {
    const file = join(updateDir(req.dataDir), `${UPDATE_UNIT.launchd}.plist`);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, renderUpdatePlist(command, req.dataDir, path), { mode: 0o600 });
    await bootstrapLaunchd(ops, UPDATE_UNIT.launchd, file);
    return;
  }
  ops.capture("systemd-run", [...(ops.root ? [] : ["--user"]), `--unit=${UPDATE_UNIT.systemd}`, "--collect", "--quiet", `--setenv=PATH=${path}`, "--", ...command]);
}

// ───────────── The job ─────────────

export interface UpdateJobDeps {
  ops: ServiceOps;
  /** Installs `version` into `<data>/app.new` with the supply-chain checks; returns the staging directory. */
  stage(dataDir: string, version: string): string;
  /** Resolves true once `<base>/api/health` answers with this version. */
  waitForVersion(base: string, version: string): Promise<boolean>;
  log(line: string): void;
}

export const jobDeps = (): UpdateJobDeps => ({
  ops: systemOps(),
  stage: (dataDir, version) => stagePackage(join(dataDir, "app.new"), { where: "the data directory", requireWeb: true, version, harden: true }),
  waitForVersion: (base, version) => waitForVersion(base, version),
  log: (line) => console.log(line),
});

/** Polls /api/health until it answers (200, or 503 = up but degraded) with `version`; false after `attempts`. */
export async function waitForVersion(base: string, version: string, opts: { attempts?: number; intervalMs?: number } = {}): Promise<boolean> {
  const { attempts = 120, intervalMs = 500 } = opts;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      const body = (await res.json().catch(() => null)) as { version?: string } | null;
      if ((res.status === 200 || res.status === 503) && isHealthResponse(body) && body!.version === version) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Stops the service and waits until it is gone. Unlike `service install`, it stays enabled. */
async function stopDaemon(ops: ServiceOps): Promise<void> {
  if (ops.platform === "darwin") return stopAndWait(ops, DAEMON_UNIT);
  systemctl(ops, "stop", SERVICE_NAME);
  if (unitState(ops, DAEMON_UNIT).running) throw new Error(`systemd still reports ${SERVICE_NAME} running after stopping it`);
}

async function startDaemon(ops: ServiceOps): Promise<void> {
  if (ops.platform === "darwin") return bootstrapLaunchd(ops, LAUNCHD_LABEL, unitPath(ops, DAEMON_UNIT));
  systemctl(ops, "start", SERVICE_NAME);
}

const DB_SUFFIXES = ["", "-wal", "-shm"];

/** Copies the database (with its WAL) while the service is stopped. Returns what restoreDatabase needs. */
export function snapshotDatabase(dataDir: string): { db: string; dir: string } {
  const db = dataFiles(dataDir).db;
  const dir = join(updateDir(dataDir), "db-snapshot");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const suffix of DB_SUFFIXES) {
    if (existsSync(db + suffix)) copyFileSync(db + suffix, join(dir, basename(db) + suffix));
  }
  return { db, dir };
}

/** Puts the snapshot back exactly: files the snapshot doesn't have (a newer WAL) are removed. */
export function restoreDatabase(snapshot: { db: string; dir: string }): void {
  for (const suffix of DB_SUFFIXES) {
    const saved = join(snapshot.dir, basename(snapshot.db) + suffix);
    rmSync(snapshot.db + suffix, { force: true });
    if (existsSync(saved)) {
      copyFileSync(saved, snapshot.db + suffix);
      chmodSync(snapshot.db + suffix, 0o600);
    }
  }
}

/** Exchanges `app` and `app.old` (going back). `restore()` exchanges them again. */
export function swapBack(app: string, dataDir: string): { restore(): void } {
  const old = `${app}.old`;
  const mid = join(updateDir(dataDir), "app.swap");
  const exchange = () => {
    rmSync(mid, { recursive: true, force: true });
    renameSync(app, mid);
    try {
      renameSync(old, app);
    } catch (err) {
      renameSync(mid, app);
      throw err;
    }
    renameSync(mid, old);
  };
  exchange();
  return { restore: exchange };
}

/** Records the job's outcome in the audit log (the service may be running: SQLite takes turns). */
function auditOutcome(dataDir: string, status: SelfUpdateStatus, log: (line: string) => void): void {
  try {
    const db = new Db(dataFiles(dataDir).db);
    try {
      new AuditLog(db, createBus()).record({
        actorType: "system",
        action: "system.update.result",
        target: status.to,
        outcome: status.state === "succeeded" ? "ok" : "error",
        reason: status.state === "succeeded" ? null : status.state,
        detail: { id: status.id, kind: status.kind, from: status.from, to: status.to, message: status.message },
      });
    } finally {
      db.close();
    }
  } catch (err) {
    log(`Couldn't write the audit entry: ${errorMessage(err)}`);
  }
}

/**
 * The update job (`xaq service update-run`). Never throws: every outcome ends up in the status file and the
 * audit log. A failure before the swap changes nothing; after it, the previous install and the database
 * snapshot are put back and the previous version is started again.
 */
export async function runUpdateJob(req: UpdateJobRequest, deps: UpdateJobDeps = jobDeps()): Promise<SelfUpdateStatus> {
  const { dataDir } = req;
  const { ops, log } = deps;
  const app = join(dataDir, "app");
  const from = installedVersion(app) ?? "unknown";
  const to = (req.kind === "update" ? req.version : installedVersion(`${app}.old`)) ?? "unknown";
  let status: SelfUpdateStatus = { id: req.id, kind: req.kind, from, to, state: "running", step: "starting", message: null, startedAt: new Date().toISOString(), finishedAt: null };
  const set = (patch: Partial<SelfUpdateStatus>) => {
    status = { ...status, ...patch };
    writeUpdateStatus(dataDir, status);
    if (patch.step) log(`[${status.id}] ${status.kind} ${from} → ${to}: ${status.step}`);
  };
  const finish = (state: SelfUpdateStatus["state"], message: string | null) => {
    set({ state, message, finishedAt: new Date().toISOString(), ...(state === "succeeded" ? { step: "done" as const } : {}) });
    log(`[${status.id}] ${state}${message ? `: ${message}` : ""}`);
    auditOutcome(dataDir, status, log);
    return status;
  };
  const quietly = async (fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      log(`  (${errorMessage(err)})`);
    }
  };
  set({});

  const unit = readText(unitPath(ops, DAEMON_UNIT));
  if (unit === null) return finish("failed", "The xaq service isn't installed, so there is nothing to update. Nothing was changed.");
  const port = Number(unitEnv(unit, "PORT"));
  const base = loopbackUrl(unitEnv(unit, "HOST") || "0.0.0.0", Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT);

  let staging: string | null = null;
  if (req.kind === "update") {
    set({ step: "staging" });
    try {
      staging = deps.stage(dataDir, to);
    } catch (err) {
      return finish("failed", errorMessage(err));
    }
  } else if (!isOwnInstall(`${app}.old`)) {
    return finish("failed", "There is no previous install to go back to. Nothing was changed.");
  }
  const unchanged = async (what: string, err: unknown) => {
    await quietly(() => startDaemon(ops));
    if (staging) rmSync(staging, { recursive: true, force: true });
    return finish("failed", `${what}: ${errorMessage(err)}. Nothing was changed.`);
  };

  set({ step: "stopping" });
  try {
    await stopDaemon(ops);
  } catch (err) {
    return unchanged("Couldn't stop the service", err);
  }
  set({ step: "snapshot" });
  let snapshot: ReturnType<typeof snapshotDatabase>;
  try {
    snapshot = snapshotDatabase(dataDir);
  } catch (err) {
    return unchanged("Couldn't snapshot the database", err);
  }
  set({ step: "swapping" });
  let swap: { restore(): void };
  try {
    swap = staging ? swapIn(staging, app) : swapBack(app, dataDir);
  } catch (err) {
    return unchanged("Couldn't move the new install into place", err);
  }

  let failure: string | null = null;
  try {
    set({ step: "restarting" });
    await startDaemon(ops);
    set({ step: "health" });
    if (!(await deps.waitForVersion(base, to))) throw new Error(`xaq ${to} didn't answer on /api/health`);
  } catch (err) {
    failure = errorMessage(err);
  }
  // Success keeps app.old (and the snapshot) for "go back".
  if (!failure) return finish("succeeded", null);

  set({ step: "restoring" });
  try {
    await stopDaemon(ops);
    restoreDatabase(snapshot);
    swap.restore();
    await startDaemon(ops);
    if (!(await deps.waitForVersion(base, from))) throw new Error(`xaq ${from} didn't answer on /api/health either`);
  } catch (err) {
    return finish("rollback_failed", `${failure}. Putting xaq ${from} back failed too: ${errorMessage(err)}`);
  }
  return finish("rolled_back", `${failure}. xaq ${from} and the database from before the update were put back.`);
}
