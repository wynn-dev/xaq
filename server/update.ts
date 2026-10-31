import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  launchdTarget,
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
import { compareVersions } from "./util/semver.ts";

/**
 * One-click update from the console. The console asks; the app checks
 * the admin password and starts the update job, a separate transient systemd unit or launchd job, and the
 * job does the work: stage the new version with the supply-chain checks, stop the service, snapshot the
 * database, swap `app` for the new install (the current one becomes `app.old`), start, wait for /api/health
 * to answer with the new version, and put everything back when it doesn't. It writes `update/status.json`
 * as it goes, which the console polls. One job at a time: the app takes `update/lock` for it and the job holds it
 * until it ends.
 *
 * The job runs this module from the install it is about to move aside, so everything it needs is imported
 * statically here: after the swap, a lazy import would load the other version's files. Keep it that way.
 */

export const UPDATE_UNIT: UnitId = { launchd: "sh.xaq.update", systemd: "xaq-update" };
/** A lock older than this is a job that died (or hung): another one may start. */
const STALE_MS = 30 * 60_000;
/** Database snapshots kept in `update/snapshots/`, newest first: enough that an update's survives a go-back. */
export const KEEP_SNAPSHOTS = 3;

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

// ───────────── One job at a time ─────────────

/** Who holds `update/lock`: the job's id, and the process to check (the app's until the job takes it over). */
export interface UpdateLock {
  id: string;
  pid: number;
  at: string;
}

export const updateLockPath = (dataDir: string) => join(updateDir(dataDir), "lock");

export function readUpdateLock(dataDir: string, file = updateLockPath(dataDir)): UpdateLock | null {
  try {
    const lock = JSON.parse(readFileSync(file, "utf8")) as UpdateLock;
    return typeof lock?.id === "string" && Number.isInteger(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

/** Whether a process is there (EPERM: it is, as another user). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A lock left by a job that died: its process is gone, or it is older than STALE_MS (a reused pid, a hung job). */
export function staleLock(lock: UpdateLock, now = Date.now()): boolean {
  const age = now - Date.parse(lock.at);
  return !alive(lock.pid) || !(age < STALE_MS);
}

/** Writes the lock whole and links it into place: fails with EEXIST when there is one, so of two claims one wins. */
function linkLock(file: string, lock: UpdateLock): boolean {
  const tmp = `${file}.${lock.id}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(lock), { mode: 0o600 });
  try {
    linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Takes the update lock for job `id`, or returns who holds it. A stale lock is moved aside and checked to
 * still be the one found stale before it is dropped; a fresh one moved aside by a concurrent claim is put back.
 */
export function claimUpdateLock(dataDir: string, id: string, pid = process.pid, now = Date.now()): { ok: true } | { ok: false; holder: UpdateLock } {
  mkdirSync(updateDir(dataDir), { recursive: true, mode: 0o700 });
  const file = updateLockPath(dataDir);
  const mine: UpdateLock = { id, pid, at: new Date(now).toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (linkLock(file, mine)) return { ok: true };
    const holder = readUpdateLock(dataDir);
    if (holder && !staleLock(holder, now)) return { ok: false, holder };
    if (!existsSync(file)) continue; // Released since.
    // Stale, or not a lock at all.
    const aside = `${file}.stale.${randomBytes(4).toString("hex")}`;
    try {
      renameSync(file, aside);
    } catch {
      continue; // Someone else moved it first.
    }
    const moved = readUpdateLock(dataDir, aside);
    if (moved && (moved.id !== holder?.id || moved.at !== holder?.at)) {
      // Not the stale one: another claim replaced it in between. Put it back and let it run.
      try {
        linkSync(aside, file);
      } catch {
        // A third claim got in; it holds the lock now.
      }
      rmSync(aside, { force: true });
      return { ok: false, holder: moved };
    }
    rmSync(aside, { force: true });
  }
  const holder = readUpdateLock(dataDir);
  return { ok: false, holder: holder ?? { id: "unknown", pid: 0, at: mine.at } };
}

/**
 * The job takes over the lock the app took for it (same id), so the lock follows the job's own process once
 * the app stops; a job started by hand claims it. Anyone else's lock that isn't stale wins.
 */
export function adoptUpdateLock(dataDir: string, id: string, pid = process.pid): { ok: true } | { ok: false; holder: UpdateLock } {
  const file = updateLockPath(dataDir);
  if (readUpdateLock(dataDir)?.id !== id) return claimUpdateLock(dataDir, id, pid);
  const tmp = `${file}.${id}.tmp`;
  writeFileSync(tmp, JSON.stringify({ id, pid, at: new Date().toISOString() } satisfies UpdateLock), { mode: 0o600 });
  renameSync(tmp, file);
  return { ok: true };
}

/** Drops the lock if job `id` still holds it. */
export function releaseUpdateLock(dataDir: string, id: string): void {
  if (readUpdateLock(dataDir)?.id === id) rmSync(updateLockPath(dataDir), { force: true });
}

/** The version in `<data>/app.old` when it is our install and older than this one: what "go back" returns to. */
export function previousVersion(dataDir: string, current: string): string | null {
  const old = join(dataDir, "app.old");
  if (!isOwnInstall(old) || !existsSync(installedEntry(old))) return null;
  const version = installedVersion(old);
  return version && compareVersions(version, current) < 0 ? version : null;
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
 * unit (`systemd-run`, collected when it ends) or a launchd job. Throws when it couldn't be started. The
 * caller holds the update lock; on top of it, a launchd job still running is never replaced (bootstrapping
 * the label again would tear it down mid-update), and systemd-run refuses a unit name that is still active.
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

export const snapshotsDir = (dataDir: string) => join(updateDir(dataDir), "snapshots");

/** A job's snapshot folder: when it started (UTC), then what it did, e.g. `2026-10-27T101500.123Z-update-1.0.0-to-2.0.0`. */
export function snapshotName(status: Pick<SelfUpdateStatus, "startedAt" | "kind" | "from" | "to">): string {
  const safe = (v: string) => v.replace(/[^\w.+-]/g, "_");
  return `${status.startedAt.replace(/:/g, "")}-${status.kind}-${safe(status.from)}-to-${safe(status.to)}`;
}

/**
 * Copies the database (with its WAL) while the service is stopped, into `update/snapshots/<name>/`, then
 * drops all but the newest KEEP_SNAPSHOTS, so the one from before an update outlives a go-back. Returns what
 * restoreDatabase needs.
 */
export function snapshotDatabase(dataDir: string, name: string): { db: string; dir: string } {
  const db = dataFiles(dataDir).db;
  const root = snapshotsDir(dataDir);
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const suffix of DB_SUFFIXES) {
    if (existsSync(db + suffix)) copyFileSync(db + suffix, join(dir, basename(db) + suffix));
  }
  // Names start with the time, so they sort oldest first.
  const older = readdirSync(root).filter((n) => n !== name).sort();
  for (const old of older.slice(0, Math.max(0, older.length - (KEEP_SNAPSHOTS - 1)))) rmSync(join(root, old), { recursive: true, force: true });
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
function auditOutcome(dataDir: string, status: SelfUpdateStatus, log: (line: string) => void, reason: string | null = status.state === "succeeded" ? null : status.state): void {
  try {
    const db = new Db(dataFiles(dataDir).db);
    try {
      new AuditLog(db, createBus()).record({
        actorType: "system",
        action: "system.update.result",
        target: status.to,
        outcome: status.state === "succeeded" ? "ok" : "error",
        reason,
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
 * audit log, except a job refused because another one holds the lock, which leaves that one's status alone. A failure before the swap changes nothing; after it, the previous install and the database
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
    releaseUpdateLock(dataDir, req.id);
    return status;
  };
  const quietly = async (fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      log(`  (${errorMessage(err)})`);
    }
  };
  const lock = adoptUpdateLock(dataDir, req.id);
  if (!lock.ok) {
    // Another job runs: its status file and lock stay as they are.
    status = { ...status, state: "failed", message: `Another update (${lock.holder.id}) is already running. Nothing was changed.`, finishedAt: new Date().toISOString() };
    log(`[${status.id}] failed: ${status.message}`);
    auditOutcome(dataDir, status, log, "in_progress");
    return status;
  }
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
    snapshot = snapshotDatabase(dataDir, snapshotName(status));
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
  // Success keeps app.old for "go back", and the snapshot (snapshotDatabase keeps the last few).
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
