import { closeSync, constants, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensurePrivateDir } from "./fsutil.ts";
import { listenStateDir } from "./paths.ts";
import { pidAlive } from "./state.ts";
import { NPX } from "./version.ts";

/**
 * One listener per machine: two would share a consumer cursor and run every event twice. The lock is
 * a file with the owner's pid and start time, created exclusively; a lock whose process is gone is
 * stale and taken over.
 */

export const lockPath = () => join(listenStateDir(), "listen.lock");

export interface LockInfo {
  pid: number;
  startedAt: string;
}

export class ListenerLockedError extends Error {
  constructor(readonly holder: LockInfo) {
    super(
      `Another listener is already running (pid ${holder.pid}, since ${holder.startedAt}).\n` +
        `  If it's the background service, check it with \`${NPX} listen service status\`; stop it before running one in the foreground.`,
    );
  }
}

function rawLength(path: string): number {
  try {
    return readFileSync(path).length;
  } catch {
    return 0;
  }
}

function readLock(path: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    return typeof info.pid === "number" ? info : null;
  } catch {
    return null;
  }
}

/** Lock files held by this process (a second in-process holder has the same pid). */
const held = new Set<string>();

/**
 * Takes an exclusive lock file (pid + start time, created with O_EXCL) or throws `busy(holder)`. A lock
 * whose process is gone is stale and taken over. Returns a release function (also run on process exit).
 */
export function acquireFileLock(path: string, busy: (holder: LockInfo) => Error, opts: { privateDir?: boolean } = {}): () => void {
  // privateDir false: the directory may be one another program called xaq owns, so it keeps its mode.
  if (opts.privateDir === false) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  else ensurePrivateDir(dirname(path));
  const mine: LockInfo = { pid: process.pid, startedAt: new Date().toISOString() };
  if (held.has(path)) throw busy(readLock(path) ?? mine);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeSync(fd, JSON.stringify(mine));
      closeSync(fd);
      held.add(path);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        held.delete(path);
        process.off("exit", release);
        // Only remove it if it is still ours.
        if (readLock(path)?.pid === process.pid) rmSync(path, { force: true });
      };
      process.on("exit", release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = readLock(path);
    if (holder && holder.pid !== process.pid && pidAlive(holder.pid)) throw busy(holder);
    // Something else under this name (not a lock we wrote, and not the empty file a crash mid-write leaves): leave it.
    if (!holder && rawLength(path) > 0) throw new Error(`${path} already exists and isn't a xaq lock, so it was left alone. Move it away, then run this again.`);
    // Stale (crashed process) or empty: take it over.
    rmSync(path, { force: true });
  }
  throw new Error(`Could not take the lock ${path}.`);
}

/** Takes the listener lock or throws ListenerLockedError. */
export function acquireListenerLock(): () => void {
  return acquireFileLock(lockPath(), (holder) => new ListenerLockedError(holder));
}

/**
 * `listen --backfill` has its own lock: it uses its own cursor, so it runs fine next to the listener (or
 * its service), but two backfills at once would run every stored event twice.
 */
export const backfillLockPath = () => join(listenStateDir(), "backfill.lock");

export function acquireBackfillLock(): () => void {
  return acquireFileLock(backfillLockPath(), (holder) => new Error(`A backfill is already running (pid ${holder.pid}, since ${holder.startedAt}). Let it finish, or stop it first.`));
}
