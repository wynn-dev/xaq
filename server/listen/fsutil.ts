import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Creates a directory (and parents) readable only by this user. Tightens an existing one. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && (statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/**
 * Throws when `path` exists but isn't ours. Another program is also called xaq and may own `~/.config/xaq`
 * (or `~/.local/share/xaq`, `~/.xaq`): there we only create paths, or rewrite ones we wrote ourselves.
 */
export function assertOurs(path: string, ours: (path: string) => boolean, what: string): void {
  try {
    lstatSync(path);
  } catch {
    return; // Not there: ours to create.
  }
  let mine = false;
  try {
    mine = ours(path);
  } catch {
    // Unreadable: not provably ours.
  }
  if (!mine) throw new Error(`${path} already exists and isn't xaq's ${what}, so it was left alone. Move it away, then run this again.`);
}

/**
 * Writes a file with mode 0600 atomically (temp file + rename), so a crash never leaves a
 * half-written profile and the secret is never briefly world-readable. `privateDir`: true (default)
 * creates the directory 0700 and tightens an existing one; "new" only creates it 0700 (an existing
 * directory, which may not be ours, keeps its mode); false creates it with the default mode.
 */
export function writePrivateFile(linkOrPath: string, content: string, opts: { privateDir?: boolean | "new" } = {}): void {
  // A symlinked config (dotfiles repos) is updated at its real location instead of being replaced by a plain file.
  const path = resolveLink(linkOrPath);
  if (opts.privateDir === "new") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  else if (opts.privateDir !== false) ensurePrivateDir(dirname(path));
  else mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function resolveLink(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

/** Copies `path` next to itself as `<path>.xaq-backup-<timestamp>` (0600). Returns the copy, or null if there was nothing to back up. */
export function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const content = readFileSync(path);
  // Created 0600 and exclusively (never through an existing file or symlink), then filled.
  for (let n = 0; ; n++) {
    const backup = `${path}.xaq-backup-${stamp}${n ? `-${n}` : ""}`;
    try {
      writeFileSync(backup, content, { mode: 0o600, flag: "wx" });
      return backup;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 20) throw err;
    }
  }
}

/** Tightens an existing file to 0600 (files created by appendFileSync keep their first mode). */
export function tighten(path: string): void {
  if (process.platform !== "win32" && existsSync(path) && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
}

/** True when group or others can read/write the file. */
export const isTooOpen = (path: string) => process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0;
