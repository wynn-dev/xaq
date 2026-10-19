// Attachment files saved for agents (get_attachment): what can't be shown inline (other file types, files too large,
// files that couldn't be parsed) or what the agent asks for as a file. Saved as `<dir>/<message id>/<cleaned name>`:
//
// - <dir> is Settings.attachmentSaveDir, else `attachments/` in the data directory, created 0700. A directory xaq
//   creates (or finds empty) gets a marker file and is tightened to 0700; one that already held other files isn't
//   ours, so its mode is left alone and nothing in it is ever deleted. A symlinked <dir> or message directory is refused.
// - The name is cleaned like an outgoing attachment's (sanitizeFilename: no path, no control/invisible characters),
//   and may not start with a dot. Files are created exclusively (O_EXCL, never through a symlink, mode 0600); a
//   different file already there keeps its name and the new one becomes "name (2).ext". The same bytes reuse it.
// - At most MAX_SAVED_BYTES per file, and ATTACHMENT_QUOTA_BYTES for all saved files together: over it, the oldest
//   are deleted first (only in a folder that's ours), else the save is refused.
// - Files older than ATTACHMENT_RETENTION_DAYS are deleted by maintenance (hourly), then empty message directories.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { open, readFile, utimes } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { AppContext } from "../context.ts";
import { errorMessage } from "../util/errors.ts";
import { sanitizeFilename } from "./attachments.ts";
import { formatSize } from "./content.ts";

/** Days a saved attachment is kept (by modification time; saving the same file again renews it). */
export const ATTACHMENT_RETENTION_DAYS = 7;
/** Largest file saved (Gmail receives messages up to 50 MB). */
export const MAX_SAVED_BYTES = 50 * 1024 * 1024;
/**
 * Total size of saved files in the folder (1 GiB). A save that would go over deletes the oldest files first, only in
 * a folder xaq created; otherwise it's refused (get_attachment still answers with the file's metadata).
 */
export const ATTACHMENT_QUOTA_BYTES = 1024 * 1024 * 1024;
/** Marks a save directory as xaq's own: only then are old files deleted from it. */
export const SAVE_DIR_MARKER = ".xaq-attachments";
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class SaveError extends Error {}

/** The configured save directory (absolute). */
export function attachmentSaveDir(ctx: AppContext): string {
  return ctx.settings.get().attachmentSaveDir || join(ctx.config.dataDir, "attachments");
}

const isRealDir = (p: string) => {
  const st = lstatSync(p);
  return st.isDirectory() && !st.isSymbolicLink();
};

/** Creates or adopts the save directory; returns whether it's ours (marker present). */
export function ensureSaveDir(dir: string): { ours: boolean } {
  const existed = existsSync(dir);
  if (!existed) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isRealDir(dir)) throw new SaveError("the attachment folder isn't a plain directory (symlinks are refused)");
  const marker = join(dir, SAVE_DIR_MARKER);
  if (existsSync(marker)) {
    if (process.platform !== "win32" && lstatSync(dir).mode & 0o077) chmodSync(dir, 0o700);
    return { ours: true };
  }
  if (existed && readdirSync(dir).length > 0) return { ours: false };
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  writeFileSync(marker, "Files xaq saved for agents (get_attachment). Deleted after a few days; see docs/reference.md.\n", { mode: 0o600, flag: "wx" });
  return { ours: true };
}

/** "x.pdf" → "x (2).pdf". */
const numbered = (name: string, n: number) => {
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${stem} (${n})${ext !== name ? ext : ""}`;
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Saves the bytes and returns the absolute path. Throws SaveError (in words for the agent) when it can't.
 */
export async function saveAttachment(
  ctx: AppContext,
  messageId: string,
  filename: string,
  mimeType: string,
  data: Buffer,
  opts: { quotaBytes?: number } = {},
): Promise<string> {
  if (data.length > MAX_SAVED_BYTES) throw new SaveError(`it's over the ${MAX_SAVED_BYTES / 1024 / 1024} MB limit for saved files`);
  if (!MESSAGE_ID.test(messageId)) throw new SaveError("the message id isn't a plain id");
  const root = resolve(attachmentSaveDir(ctx));
  let name = sanitizeFilename(filename, mimeType).replace(/^\.+/, "_");
  if (!name || name !== basename(name) || name === "." || name === "..") name = sanitizeFilename("", mimeType);
  try {
    const { ours } = ensureSaveDir(root);
    const dir = join(root, messageId);
    const digest = sha256(data);
    if (existsSync(dir)) {
      if (!isRealDir(dir)) throw new SaveError("the message's folder isn't a plain directory");
      // Already saved: no new space needed.
      const same = await findSame(dir, name, data.length, digest);
      if (same) return same;
    }
    makeRoom(ctx, root, ours, data.length, opts.quotaBytes ?? ATTACHMENT_QUOTA_BYTES);
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    if (!isRealDir(dir)) throw new SaveError("the message's folder isn't a plain directory");
    for (let n = 1; n <= 50; n++) {
      const candidate = n === 1 ? name : numbered(name, n);
      const path = join(dir, candidate);
      const rel = relative(root, path);
      if (rel.startsWith("..") || rel.split(sep).length !== 2) throw new SaveError("the file name isn't usable");
      try {
        const fh = await open(path, "wx", 0o600);
        try {
          await fh.writeFile(data);
        } finally {
          await fh.close();
        }
        return path;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const st = lstatSync(path);
        if (st.isFile() && st.size === data.length && sha256(await readFile(path)) === digest) {
          const now = new Date();
          await utimes(path, now, now);
          return path;
        }
      }
    }
    throw new SaveError("too many files with that name were saved for this message");
  } catch (err) {
    if (err instanceof SaveError) throw err;
    ctx.log.warn("Saving an attachment failed", { error: errorMessage(err) });
    throw new SaveError("the file couldn't be written");
  }
}

/** An existing file under `name` (or "name (n).ext") with exactly these bytes, touched to renew it; null if none. */
async function findSame(dir: string, name: string, size: number, digest: string): Promise<string | null> {
  for (let n = 1; n <= 50; n++) {
    const path = join(dir, n === 1 ? name : numbered(name, n));
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isFile() && st.size === size && sha256(await readFile(path)) === digest) {
      const now = new Date();
      await utimes(path, now, now);
      return path;
    }
  }
  return null;
}

/** Saved files (regular files in message folders), oldest first. Symlinks and other entries don't count. */
function savedFiles(root: string): { path: string; size: number; mtimeMs: number }[] {
  const out: { path: string; size: number; mtimeMs: number }[] = [];
  for (const id of readdirSync(root)) {
    if (!MESSAGE_ID.test(id)) continue;
    const dir = join(root, id);
    try {
      if (!isRealDir(dir)) continue;
      for (const f of readdirSync(dir)) {
        const st = lstatSync(join(dir, f));
        if (st.isFile()) out.push({ path: join(dir, f), size: st.size, mtimeMs: st.mtimeMs });
      }
    } catch {
      // Gone meanwhile, or unreadable: not counted.
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * Keeps the folder within its quota for a new file of `need` bytes: in a folder that's ours, the oldest saved files
 * are deleted first; otherwise (or when even that isn't enough) the save is refused. Two saves at once can overshoot
 * by at most one file each.
 */
function makeRoom(ctx: AppContext, root: string, ours: boolean, need: number, quota: number): void {
  const limit = quota >= 1024 ** 3 ? `${+(quota / 1024 ** 3).toFixed(1)} GB` : formatSize(quota);
  if (need > quota) throw new SaveError(`it's larger than the ${limit} quota for saved attachments`);
  const files = savedFiles(root);
  let used = files.reduce((n, f) => n + f.size, 0);
  if (used + need <= quota) return;
  if (!ours) throw new SaveError(`the attachment folder is over its ${limit} quota, and xaq doesn't delete files from a folder it didn't create`);
  let removed = 0;
  for (const f of files) {
    if (used + need <= quota) break;
    try {
      unlinkSync(f.path);
      used -= f.size;
      removed++;
      const dir = join(f.path, "..");
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch (err) {
      ctx.log.debug("Deleting an old saved attachment failed", { error: errorMessage(err) });
    }
  }
  if (removed) ctx.log.info("Deleted old saved attachments to stay within the quota", { removed, quota });
  if (used + need > quota) throw new SaveError(`the attachment folder is over its ${limit} quota and old files couldn't be deleted`);
}

/** Deletes saved files older than the retention, then empty message folders. Only in a directory that's ours. */
export function pruneSavedAttachments(ctx: AppContext, now = Date.now()): number {
  const root = resolve(attachmentSaveDir(ctx));
  if (!existsSync(join(root, SAVE_DIR_MARKER))) return 0;
  try {
    if (!isRealDir(root)) return 0;
  } catch {
    return 0;
  }
  const before = now - ATTACHMENT_RETENTION_DAYS * 86_400_000;
  let removed = 0;
  for (const id of readdirSync(root)) {
    if (!MESSAGE_ID.test(id)) continue;
    const dir = join(root, id);
    try {
      if (!isRealDir(dir)) continue;
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        const st = lstatSync(p);
        if ((st.isFile() || st.isSymbolicLink()) && st.mtimeMs < before) {
          unlinkSync(p);
          removed++;
        }
      }
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch (err) {
      ctx.log.debug("Pruning a saved-attachment folder failed", { error: errorMessage(err) });
    }
  }
  return removed;
}
