// Attachment files saved for agents (get_attachment): what can't be shown inline (other file types, files too large,
// files that couldn't be parsed) or what the agent asks for as a file. Saved as `<dir>/<message id>/<cleaned name>`:
//
// - <dir> is Settings.attachmentSaveDir, else `attachments/` in the data directory. It must be a real directory (not a
//   symlink) owned by xaq's user and not writable by every user; otherwise nothing is saved. One xaq creates, or finds
//   empty, is made 0700.
// - The name is cleaned like an outgoing attachment's (sanitizeFilename: no path, no control/invisible characters),
//   and may not start with a dot. Files are created exclusively (O_EXCL, never through a symlink, mode 0600); a
//   different file already there keeps its name and the new one becomes "name (2).ext". The same bytes reuse it.
// - Every file xaq saves is recorded in a manifest, `<dir>/.xaq-attachments` (relative path, size, inode, mtime in
//   nanoseconds, SHA-256, time saved), and ONLY recorded files are ever deleted, and only while they're still the
//   file xaq wrote: same inode, size and mtime, and (checked again right before deleting) the same SHA-256. Inode and
//   size alone aren't enough: ext4 and others hand a freed inode to the next new file, so a file deleted and
//   rewritten by hand with the same size can come back with the same inode.
//   Whatever else is in the folder (a user's own `<id-like>/file`, a file replaced by hand) is never touched.
// - At most MAX_SAVED_BYTES per file, and ATTACHMENT_QUOTA_BYTES for all recorded files together: over it, the oldest
//   recorded files are deleted first; if that isn't enough the save is refused.
// - Recorded files older than ATTACHMENT_RETENTION_DAYS are deleted by maintenance (hourly), then the message folders
//   xaq created, once empty.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { AppContext } from "../context.ts";
import { errorMessage } from "../util/errors.ts";
import { sanitizeFilename } from "./attachments.ts";
import { formatSize } from "./content.ts";

/** Days a saved attachment is kept (from when it was last saved; saving the same file again renews it). */
export const ATTACHMENT_RETENTION_DAYS = 7;
/** Largest file saved (Gmail receives messages up to 50 MB). */
export const MAX_SAVED_BYTES = 50 * 1024 * 1024;
/**
 * Total size of the files xaq saved in the folder (1 GiB). A save that would go over deletes the oldest of them first;
 * if that isn't enough it's refused (get_attachment still answers with the file's metadata).
 */
export const ATTACHMENT_QUOTA_BYTES = 1024 * 1024 * 1024;
/** The manifest of saved files, in the save folder. */
export const SAVE_DIR_MARKER = ".xaq-attachments";
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ENTRIES = 100_000;

export class SaveError extends Error {}

/** The configured save directory (absolute). */
export function attachmentSaveDir(ctx: AppContext): string {
  return ctx.settings.get().attachmentSaveDir || join(ctx.config.dataDir, "attachments");
}

const isRealDir = (p: string) => {
  const st = lstatSync(p);
  return st.isDirectory() && !st.isSymbolicLink();
};

/** Creates the save directory if needed and checks it's safe to write into. */
export function ensureSaveDir(dir: string): void {
  const existed = existsSync(dir);
  if (!existed) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new SaveError("the attachment folder isn't a plain directory (symlinks are refused)");
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new SaveError("the attachment folder belongs to another user");
    if (st.mode & 0o002) throw new SaveError("the attachment folder is writable by every user");
    const empty = !existed || readdirSync(dir).length === 0;
    if ((empty || existsSync(join(dir, SAVE_DIR_MARKER))) && st.mode & 0o077) chmodSync(dir, 0o700);
  }
}

// ───────────── The manifest ─────────────

interface Entry {
  size: number;
  /** Inode and mtime (ns) as decimal strings: both can exceed 2^53. */
  ino: string;
  mtimeNs: string;
  sha256: string;
  savedAt: number;
}
interface Manifest {
  version: 1;
  /** "<message id>/<name>" → what was written. */
  files: Record<string, Entry>;
  /** Message folders xaq created (removed again once empty). */
  dirs: string[];
}

const validRel = (rel: string) => {
  const parts = rel.split("/");
  return parts.length === 2 && MESSAGE_ID.test(parts[0]!) && !!parts[1] && parts[1] === basename(parts[1]) && !parts[1].startsWith(".") && !parts[1].includes("\\");
};

function readManifest(root: string): Manifest {
  const path = join(root, SAVE_DIR_MARKER);
  let raw: string;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new SaveError("the attachment folder's manifest isn't a plain file");
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof SaveError) throw err;
    return { version: 1, files: {}, dirs: [] };
  }
  const m: Manifest = { version: 1, files: {}, dirs: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    for (const [rel, e] of Object.entries(parsed.files ?? {}).slice(0, MAX_ENTRIES)) {
      if (!validRel(rel) || !e || !Number.isFinite(e.size) || !Number.isFinite(e.savedAt)) continue;
      if (!/^\d{1,40}$/.test(String(e.ino)) || !/^\d{1,40}$/.test(String(e.mtimeNs)) || !/^[0-9a-f]{64}$/.test(String(e.sha256))) continue;
      m.files[rel] = { size: e.size, ino: String(e.ino), mtimeNs: String(e.mtimeNs), sha256: String(e.sha256), savedAt: e.savedAt };
    }
    for (const d of Array.isArray(parsed.dirs) ? parsed.dirs.slice(0, MAX_ENTRIES) : []) if (typeof d === "string" && MESSAGE_ID.test(d)) m.dirs.push(d);
  } catch {
    // Unreadable (or the plain-text marker of an earlier build): nothing is recorded, so nothing gets deleted.
  }
  return m;
}

function writeManifest(root: string, m: Manifest): void {
  const tmp = join(root, `${SAVE_DIR_MARKER}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(m), { mode: 0o600, flag: "wx" });
  // rename replaces the name itself, never a file a symlink there points to.
  renameSync(tmp, join(root, SAVE_DIR_MARKER));
}

/** Whether `rel` still looks like the file xaq wrote: a regular file with the recorded inode, size and mtime. */
function stillOurs(root: string, rel: string, e: Entry): boolean {
  try {
    const st = lstatSync(join(root, ...rel.split("/")), { bigint: true });
    return st.isFile() && String(st.ino) === e.ino && Number(st.size) === e.size && String(st.mtimeNs) === e.mtimeNs;
  } catch {
    return false;
  }
}

/** stillOurs, plus the content hash: checked right before anything is deleted. */
function provablyOurs(root: string, rel: string, e: Entry): boolean {
  if (!stillOurs(root, rel, e)) return false;
  try {
    return sha256(readFileSync(join(root, ...rel.split("/")))) === e.sha256 && stillOurs(root, rel, e);
  } catch {
    return false;
  }
}

/** Deletes one recorded file (if still ours) and forgets it; then its folder, if xaq created it and it's empty. */
function forget(ctx: AppContext, root: string, m: Manifest, rel: string): number {
  const e = m.files[rel]!;
  delete m.files[rel];
  if (!provablyOurs(root, rel, e)) return 0;
  try {
    unlinkSync(join(root, ...rel.split("/")));
  } catch (err) {
    ctx.log.debug("Deleting a saved attachment failed", { error: errorMessage(err) });
    return 0;
  }
  return e.size;
}

function removeEmptyDirs(root: string, m: Manifest): void {
  m.dirs = m.dirs.filter((id) => {
    const dir = join(root, id);
    try {
      if (!isRealDir(dir)) return false;
      if (readdirSync(dir).length) return true;
      rmdirSync(dir);
      return false;
    } catch {
      return false;
    }
  });
}

// ───────────── Saving ─────────────

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
    ensureSaveDir(root);
    const dir = join(root, messageId);
    const digest = sha256(data);
    if (existsSync(dir)) {
      if (!isRealDir(dir)) throw new SaveError("the message's folder isn't a plain directory");
      // Already saved: no new space needed.
      const same = await findSame(root, messageId, name, data.length, digest);
      if (same) return same;
    }
    makeRoom(ctx, root, data.length, opts.quotaBytes ?? ATTACHMENT_QUOTA_BYTES);
    if (!existsSync(dir)) {
      mkdirSync(dir, { mode: 0o700 });
      const m = readManifest(root);
      if (!m.dirs.includes(messageId)) m.dirs.push(messageId);
      writeManifest(root, m);
    }
    if (!isRealDir(dir)) throw new SaveError("the message's folder isn't a plain directory");
    for (let n = 1; n <= 50; n++) {
      const candidate = n === 1 ? name : numbered(name, n);
      const path = join(dir, candidate);
      const rel = relative(root, path);
      if (rel.startsWith("..") || rel.split(sep).length !== 2) throw new SaveError("the file name isn't usable");
      let fh;
      try {
        fh = await open(path, "wx", 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
      try {
        await fh.writeFile(data);
        const st = await fh.stat({ bigint: true });
        const m = readManifest(root);
        m.files[`${messageId}/${candidate}`] = { size: Number(st.size), ino: String(st.ino), mtimeNs: String(st.mtimeNs), sha256: digest, savedAt: Date.now() };
        writeManifest(root, m);
      } finally {
        await fh.close();
      }
      return path;
    }
    throw new SaveError("too many files with that name were saved for this message");
  } catch (err) {
    if (err instanceof SaveError) throw err;
    ctx.log.warn("Saving an attachment failed", { error: errorMessage(err) });
    throw new SaveError("the file couldn't be written");
  }
}

/** An existing file under `name` (or "name (n).ext") with exactly these bytes; renewed when it's one xaq saved. */
async function findSame(root: string, messageId: string, name: string, size: number, digest: string): Promise<string | null> {
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? name : numbered(name, n);
    const path = join(root, messageId, candidate);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isFile() && st.size === size && sha256(await readFile(path)) === digest) {
      const m = readManifest(root);
      const rel = `${messageId}/${candidate}`;
      const e = m.files[rel];
      if (e && stillOurs(root, rel, e)) {
        e.savedAt = Date.now();
        writeManifest(root, m);
      }
      return path;
    }
  }
  return null;
}

/**
 * Keeps the recorded files within the quota for a new file of `need` bytes: the oldest recorded files are deleted
 * first; when that isn't enough the save is refused. Two saves at once can overshoot by at most one file each.
 */
function makeRoom(ctx: AppContext, root: string, need: number, quota: number): void {
  const limit = quota >= 1024 ** 3 ? `${+(quota / 1024 ** 3).toFixed(1)} GB` : formatSize(quota);
  if (need > quota) throw new SaveError(`it's larger than the ${limit} quota for saved attachments`);
  const m = readManifest(root);
  // Forget entries that are gone or no longer the file xaq wrote: they don't count, and are never deleted.
  for (const [rel, e] of Object.entries(m.files)) if (!stillOurs(root, rel, e)) delete m.files[rel];
  let used = Object.values(m.files).reduce((n, e) => n + e.size, 0);
  let removed = 0;
  if (used + need > quota) {
    for (const [rel] of Object.entries(m.files).sort((a, b) => a[1].savedAt - b[1].savedAt)) {
      if (used + need <= quota) break;
      const freed = forget(ctx, root, m, rel);
      used -= freed;
      if (freed) removed++;
    }
    removeEmptyDirs(root, m);
  }
  writeManifest(root, m);
  if (removed) ctx.log.info("Deleted old saved attachments to stay within the quota", { removed, quota });
  if (used + need > quota) throw new SaveError(`the attachment folder is over its ${limit} quota and older saved files couldn't be deleted`);
}

/** Deletes recorded files saved longer ago than the retention, then empty message folders xaq created. */
export function pruneSavedAttachments(ctx: AppContext, now = Date.now()): number {
  const root = resolve(attachmentSaveDir(ctx));
  try {
    if (!isRealDir(root) || !existsSync(join(root, SAVE_DIR_MARKER))) return 0;
    const m = readManifest(root);
    const before = now - ATTACHMENT_RETENTION_DAYS * 86_400_000;
    let removed = 0;
    for (const [rel, e] of Object.entries(m.files)) {
      if (e.savedAt < before && forget(ctx, root, m, rel) > 0) removed++;
      else if (!stillOurs(root, rel, e)) delete m.files[rel];
    }
    removeEmptyDirs(root, m);
    writeManifest(root, m);
    return removed;
  } catch (err) {
    ctx.log.debug("Pruning saved attachments failed", { error: errorMessage(err) });
    return 0;
  }
}
