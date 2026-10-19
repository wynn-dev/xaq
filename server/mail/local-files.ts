// Attaching a file from a path on xaq's own machine: a security boundary. An agent (or a prompt-injected
// one) must never mail xaq's own secrets (master.key, the database, agent keys) or arbitrary files, so:
//
// 1. Off unless the owner lists directories (Settings.attachmentDirs, admin only; no agent tool changes it).
// 2. The path must be absolute and, lexically, inside an allowed directory; then its real path (symlinks and
//    ".." resolved) must be inside an allowed directory's real path too.
// 3. xaq's own directories are refused even inside an allowed one: the data directory (and ~/.xaq,
//    ~/.agentinbox), and the CLI's config, state and data directories. So are names that are secrets wherever
//    they are: master.key, *.db (and SQLite's -wal/-shm/-journal), .env (.env.*), id_* (SSH keys), *.pem, *.key.
// 4. Regular files only. It's opened without following a final symlink and without blocking (a FIFO would hang
//    the open), and the open file is fstat'ed: it must be a regular file and the very file (device and inode)
//    that was checked. On Linux, /proc/self/fd says where the open file really is, and that path must still
//    pass every check (this closes a directory swapped for a symlink between the check and the open); elsewhere
//    the path is resolved again and must still lead to the same file. A file with other hard links must not be
//    one of xaq's own files.
// 5. Errors name paths and sizes, never contents. Nothing more than the caller's limit is ever read.

import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { normPath as norm, ownDirs, within } from "../util/own-dirs.ts";
import { AttachmentError } from "./attachments.ts";

/** Where the owner turns path attachments on. */
export const ENABLE_HINT =
  "The owner can allow directories in the xaq console (Settings → Attachments from files) or with `npx xaq-cli settings attachment-dirs add <dir>`.";

/** File names that are secrets wherever they are (compared lower-cased). */
const SECRET_NAMES: RegExp[] = [/^master\.key$/, /\.db$/, /\.db-(?:wal|shm|journal)$/, /^\.env$/, /^\.env\./, /^id_/, /\.pem$/, /\.key$/];

/** Whether `name` (a file name) is one xaq never attaches. */
export const isSecretName = (name: string): boolean => SECRET_NAMES.some((re) => re.test(name.toLowerCase()));

/** A directory and its real path (symlinks resolved), when it exists. */
async function both(dir: string): Promise<string[]> {
  const out = [resolve(dir)];
  try {
    const real = await realpath(dir);
    if (real !== out[0]) out.push(real);
  } catch {
    // Not there (yet): the lexical path still counts.
  }
  return out;
}

export interface PathPolicy {
  /** Settings.attachmentDirs: absolute directories the owner allowed. Empty: path attachments are off. */
  allowedDirs: readonly string[];
  /** xaq's data directory (config.dataDir). */
  dataDir: string;
}

/** A local file, checked and open. Read it with readCapped, then close it. */
export interface OpenLocalFile {
  /** The path the agent gave. */
  requested: string;
  /** Its real path (what was checked and opened). */
  real: string;
  size: number;
  handle: FileHandle;
}

const refuse = (path: string, why: string) => new AttachmentError("path_not_allowed", `Can't attach ${path}: ${why}`);

/** Every check of steps 2 and 3 on a real (resolved) path; throws when it fails. */
function assertAllowedReal(shown: string, real: string, allowedReal: string[], own: string[]): void {
  if (!allowedReal.some((d) => within(d, real) && norm(d) !== norm(real))) {
    throw refuse(shown, `it isn't inside a directory the owner allowed for attachments (it resolves to ${real}). Allowed: ${allowedReal.join(", ")}.`);
  }
  if (own.some((d) => within(d, real))) throw refuse(shown, "xaq's own files (its data, configuration and state directories) can never be attached.");
  if (isSecretName(basename(real))) throw refuse(shown, `files named like ${basename(real)} (keys, databases, .env files) can never be attached.`);
}

/**
 * Checks `path` against the policy and opens it (steps 1 to 4 above). Throws AttachmentError in plain words.
 * The caller reads it with readCapped and must close `handle`.
 */
export async function openLocalFile(path: unknown, policy: PathPolicy): Promise<OpenLocalFile> {
  if (!policy.allowedDirs.length) {
    throw new AttachmentError("path_attachments_off", `Attaching files from a path is off: no directories are allowed for attachments. ${ENABLE_HINT}`);
  }
  if (typeof path !== "string" || !path.trim()) throw new AttachmentError("invalid_attachment", "path is empty: pass the file's absolute path.");
  // oxlint-disable-next-line no-control-regex -- refusing control characters is the point here
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new AttachmentError("invalid_attachment", "path contains control characters.");
  if (!isAbsolute(path)) throw new AttachmentError("invalid_attachment", `path must be absolute (start with /), e.g. ${join(policy.allowedDirs[0]!, "report.pdf")}; "~" isn't expanded.`);
  const shown = path.length > 300 ? `${path.slice(0, 300)}…` : path;

  const allowed = (await Promise.all(policy.allowedDirs.map(both))).flat();
  const allowedReal = (await Promise.all(policy.allowedDirs.map(async (d) => realpath(d).catch(() => null)))).filter((d): d is string => !!d);
  const own = (await Promise.all(ownDirs(policy.dataDir).map(both))).flat();
  if (!allowedReal.length) {
    throw new AttachmentError("path_attachments_off", `None of the directories allowed for attachments exists (${policy.allowedDirs.join(", ")}). ${ENABLE_HINT}`);
  }

  // Lexically outside every allowed directory: refused without touching the file system, so the answer
  // says nothing about what exists elsewhere.
  const lexical = resolve(path);
  if (!allowed.some((d) => within(d, lexical) && norm(d) !== norm(lexical))) {
    throw refuse(shown, `it isn't inside a directory the owner allowed for attachments. Allowed: ${policy.allowedDirs.join(", ")}.`);
  }
  if (isSecretName(basename(lexical))) throw refuse(shown, `files named like ${basename(lexical)} (keys, databases, .env files) can never be attached.`);
  if (own.some((d) => within(d, lexical))) throw refuse(shown, "xaq's own files (its data, configuration and state directories) can never be attached.");

  let real: string;
  try {
    real = await realpath(lexical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new AttachmentError("not_found", `There is no file at ${shown}.`);
    throw refuse(shown, `it can't be read (${code ?? "error"}).`);
  }
  assertAllowedReal(shown, real, allowedReal, own);

  let before: Stats;
  try {
    before = await lstat(real);
  } catch (err) {
    throw refuse(shown, `it can't be read (${(err as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  if (!before.isFile()) throw refuse(shown, before.isDirectory() ? "it's a directory; attach the files in it one by one." : "only regular files can be attached (not devices, pipes or sockets).");

  let handle: FileHandle;
  try {
    // O_NOFOLLOW: a final component swapped for a symlink since the check fails (ELOOP) instead of being followed.
    // O_NONBLOCK: a FIFO swapped in doesn't hang the open (the fstat below then refuses it).
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw refuse(shown, code === "ELOOP" ? "it changed into a symlink while being checked." : `it can't be opened (${code ?? "error"}).`);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw refuse(shown, "only regular files can be attached (not devices, pipes or sockets).");
    if (st.dev !== before.dev || st.ino !== before.ino) throw refuse(shown, "it changed while being checked; try again.");
    await assertStillThere(shown, real, handle.fd, st, allowedReal, own);
    if (st.nlink > 1) await assertNotOwnFile(shown, st, policy.dataDir);
    return { requested: path, real, size: st.size, handle };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

/** Step 4's last check: the open file is still the checked file at an allowed place. */
async function assertStillThere(shown: string, real: string, fd: number, st: Stats, allowedReal: string[], own: string[]): Promise<void> {
  if (process.platform === "linux") {
    let actual: string | null = null;
    try {
      actual = await readlink(`/proc/self/fd/${fd}`);
    } catch {
      // No /proc (a restricted container): fall back to resolving again.
    }
    if (actual !== null) {
      if (actual !== real) throw refuse(shown, "it moved while being checked; try again.");
      assertAllowedReal(shown, actual, allowedReal, own);
      return;
    }
  }
  let again: string;
  let now: Stats;
  try {
    again = await realpath(real);
    now = await stat(again);
  } catch {
    throw refuse(shown, "it changed while being checked; try again.");
  }
  if (norm(again) !== norm(real) || now.dev !== st.dev || now.ino !== st.ino) throw refuse(shown, "it changed while being checked; try again.");
}

/** A hard link (inside an allowed directory) to one of xaq's own files is refused like the file itself. */
async function assertNotOwnFile(shown: string, st: Stats, dataDir: string): Promise<void> {
  // Their top level holds the secrets (master.key, the database, setup-token, service.env); profiles/ the agents' keys.
  for (const dir of ownDirs(dataDir).flatMap((d) => [d, join(d, "profiles")])) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const other = await stat(join(dir, name)).catch(() => null);
      if (other && other.dev === st.dev && other.ino === st.ino) {
        throw refuse(shown, "it's a link to one of xaq's own files, which can never be attached.");
      }
    }
  }
}

/** Reads at most `max` bytes of an open file; null when it holds more (it may have grown since the fstat). */
export async function readCapped(file: OpenLocalFile, max: number): Promise<Buffer | null> {
  const limit = Math.max(0, Math.floor(max));
  const buf = Buffer.alloc(Math.min(limit + 1, Math.max(file.size, 0) + 1));
  let total = 0;
  let out = buf;
  for (;;) {
    if (total === out.length) {
      if (out.length > limit) return null;
      // Grew past the fstat size (still under the limit): make room, up to limit + 1.
      const next = Buffer.alloc(Math.min(limit + 1, out.length * 2 + 65_536));
      out.copy(next, 0, 0, total);
      out = next;
    }
    const { bytesRead } = await file.handle.read(out, total, out.length - total, total);
    if (!bytesRead) break;
    total += bytesRead;
  }
  return total > limit ? null : out.subarray(0, total);
}
