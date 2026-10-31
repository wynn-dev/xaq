// Attaching a file from a path on xaq's own machine: a security boundary. An agent (or a prompt-injected
// one) must never mail xaq's own secrets (master.key, the database, agent keys), the secrets xaq writes elsewhere
// (service files, MCP configs with agent keys), other credentials or arbitrary files, so:
//
// 1. Off unless the owner lists directories (Settings.attachmentDirs, admin only; no agent tool changes it). A listed
//    directory can't be, contain or sit inside $HOME, /, xaq's own directories or the secret places below
//    (server/settings.ts); the checks here hold even if one does.
// 2. The path must be absolute and, lexically, inside an allowed directory; then its real path (symlinks and
//    ".." resolved) must be inside an allowed directory's real path too.
// 3. Refused even inside an allowed directory (server/util/own-dirs.ts): xaq's own directories (the data directory,
//    ~/.xaq, ~/.agentinbox, the CLI's config, state and data directories at their XDG and default locations); the
//    service files (all of ~/Library/LaunchAgents, systemd unit directories); the agent tools' config directories and
//    the MCP config files `setup-mcp` writes (Codex, Cursor, Claude Code, Hermes) with their *.xaq-backup-* copies;
//    credential stores (~/.ssh, ~/.aws, ~/.config/gh, ~/.gnupg, ~/Library/Keychains, ~/.kube, ~/.docker, ~/.netrc,
//    ~/.npmrc). And names that are secrets wherever they are: master.key, *.db (and SQLite's -wal/-shm/-journal),
//    .env (.env.*), id_* (SSH keys), *.pem, *.key, .netrc, .npmrc, .pgpass, .claude.json, .mcp.json, *.xaq-backup-*.
// 4. Regular files only, and not hard-linked (nlink 1): a hard link would make any file look like it's in an allowed
//    directory. It's opened without following a final symlink and without blocking (a FIFO would hang the open),
//    and the open file is fstat'ed: it must be a regular file and the very file (device and inode) that was
//    checked. On Linux, /proc/self/fd says where the open file really is, and that path must still pass every check
//    (this closes a directory swapped for a symlink between the check and the open); elsewhere the path is resolved
//    again and must still lead to the same file.
// 5. Errors name the path the agent gave and sizes, never contents, and never where a symlink leads: every refusal
//    reached through a symlink (or a missing target behind one) gets the same words, so they say nothing about what
//    exists elsewhere. Nothing more than the caller's limit is ever read.

import { constants, type Stats } from "node:fs";
import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { normPath as norm, ownDirs, protectedPaths, within } from "../util/own-dirs.ts";
import { AttachmentError } from "./attachments.ts";

/** Where the owner turns path attachments on. */
export const ENABLE_HINT =
  "The owner can allow directories in the xaq console (Settings → Attachments from files).";

/** File names that are secrets wherever they are (compared lower-cased). */
const SECRET_NAMES: RegExp[] = [
  /^master\.key$/,
  /\.db$/,
  /\.db-(?:wal|shm|journal)$/,
  /^\.env$/,
  /^\.env\./,
  /^id_/,
  /\.pem$/,
  /\.key$/,
  /^\.netrc$/,
  /^\.npmrc$/,
  /^\.pgpass$/,
  /^\.claude\.json$/,
  /^\.mcp\.json$/,
  // Copies `setup-mcp` makes of the configs it edits (server/listen/fsutil.ts backupFile).
  /\.xaq-backup-/,
];

/** Whether `name` (a file name) is one xaq never attaches. */
export const isSecretName = (name: string): boolean => SECRET_NAMES.some((re) => re.test(name.toLowerCase()));

/** A path and its real path (symlinks resolved), when it exists. */
async function both(path: string): Promise<string[]> {
  const out = [resolve(path)];
  try {
    const real = await realpath(path);
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

/** Everything a path is checked against, each as given and as its real path. */
interface Guard {
  allowed: string[];
  allowedReal: string[];
  own: string[];
  dirs: string[];
  files: string[];
}

async function guard(policy: PathPolicy): Promise<Guard> {
  const all = async (paths: readonly string[]) => [...new Set((await Promise.all(paths.map(both))).flat())];
  const p = protectedPaths(policy.dataDir);
  return {
    allowed: await all(policy.allowedDirs),
    allowedReal: (await Promise.all(policy.allowedDirs.map(async (d) => realpath(d).catch(() => null)))).filter((d): d is string => !!d),
    own: await all(ownDirs(policy.dataDir)),
    dirs: await all(p.dirs),
    files: await all(p.files),
  };
}

const refuse = (path: string, why: string) => new AttachmentError("path_not_allowed", `Can't attach ${path}: ${why}`);
/** The one answer for anything refused behind a symlink: it never says where the link leads or what's there. */
const LINK_REFUSAL = "it leads through a symlink to something that can't be attached.";

/** Why `p` (absolute, normalised) can never be attached, wherever the allowed directories are; null when it can. */
function refusedReason(p: string, g: Guard): string | null {
  if (g.own.some((d) => within(d, p))) return "xaq's own files (its data, configuration and state directories) can never be attached.";
  if (g.dirs.some((d) => within(d, p))) return "files there (credentials, service definitions, agent tools' configurations) can never be attached.";
  const name = norm(basename(p));
  const isProtectedFile = (f: string) =>
    norm(f) === norm(p) || (norm(dirname(f)) === norm(dirname(p)) && name.startsWith(`${norm(basename(f))}.xaq-backup-`));
  if (g.files.some(isProtectedFile)) return "it holds credentials or agent keys and can never be attached.";
  if (isSecretName(basename(p))) return `files named like ${basename(p)} (keys, databases, credentials, .env files and backups of agent configurations) can never be attached.`;
  return null;
}

/** Steps 2 and 3 on a real (resolved) path; throws when it fails. `viaLink`: it was reached through a symlink. */
function assertAllowedReal(shown: string, real: string, g: Guard, viaLink: boolean): void {
  if (!g.allowedReal.some((d) => within(d, real) && norm(d) !== norm(real))) {
    throw refuse(shown, viaLink ? LINK_REFUSAL : `it isn't inside a directory the owner allowed for attachments. Allowed: ${g.allowedReal.join(", ")}.`);
  }
  const reason = refusedReason(real, g);
  if (reason) throw refuse(shown, viaLink ? LINK_REFUSAL : reason);
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

  const g = await guard(policy);
  if (!g.allowedReal.length) {
    throw new AttachmentError("path_attachments_off", `None of the directories allowed for attachments exists (${policy.allowedDirs.join(", ")}). ${ENABLE_HINT}`);
  }

  // Lexically outside every allowed directory, or a refused place as written: refused without touching the file
  // system, so the answer says nothing about what exists there.
  const lexical = resolve(path);
  if (!g.allowed.some((d) => within(d, lexical) && norm(d) !== norm(lexical))) {
    throw refuse(shown, `it isn't inside a directory the owner allowed for attachments. Allowed: ${policy.allowedDirs.join(", ")}.`);
  }
  const reason = refusedReason(lexical, g);
  if (reason) throw refuse(shown, reason);

  let real: string;
  try {
    real = await realpath(lexical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw await missing(shown, lexical, g);
    throw refuse(shown, `it can't be read (${code ?? "error"}).`);
  }
  const viaLink = norm(real) !== norm(lexical);
  assertAllowedReal(shown, real, g, viaLink);

  let before: Stats;
  try {
    before = await lstat(real);
  } catch (err) {
    throw refuse(shown, `it can't be read (${(err as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  if (!before.isFile()) throw refuse(shown, before.isDirectory() ? "it's a directory; attach the files in it one by one." : "only regular files can be attached (not devices, pipes or sockets).");
  if (before.nlink > 1) throw refuse(shown, HARD_LINKED);

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
    if (st.nlink > 1) throw refuse(shown, HARD_LINKED);
    await assertStillThere(shown, real, handle.fd, st, g, viaLink);
    return { requested: path, real, size: st.size, handle };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

const HARD_LINKED = "hard-linked files can't be attached (a hard link can make any file look like it's in an allowed directory); attach a copy.";

/**
 * A path that doesn't resolve. "There is no file" only when nothing on the way is a symlink leading out: a dangling
 * link, or a missing file under a linked directory that leads somewhere refused, gets the symlink refusal instead.
 */
async function missing(shown: string, lexical: string, g: Guard): Promise<AttachmentError> {
  const notFound = new AttachmentError("not_found", `There is no file at ${shown}.`);
  if ((await lstat(lexical).catch(() => null))?.isSymbolicLink()) return refuse(shown, LINK_REFUSAL);
  for (let dir = dirname(lexical); ; dir = dirname(dir)) {
    const real = await realpath(dir).catch(() => null);
    if (real !== null) {
      const viaLink = norm(real) !== norm(dir);
      const outside = !g.allowedReal.some((d) => within(d, real)) || refusedReason(real, g) !== null;
      return viaLink && outside ? refuse(shown, LINK_REFUSAL) : notFound;
    }
    if (dirname(dir) === dir) return notFound;
  }
}

/** Step 4's last check: the open file is still the checked file at an allowed place. */
async function assertStillThere(shown: string, real: string, fd: number, st: Stats, g: Guard, viaLink: boolean): Promise<void> {
  if (process.platform === "linux") {
    let actual: string | null = null;
    try {
      actual = await readlink(`/proc/self/fd/${fd}`);
    } catch {
      // No /proc (a restricted container): fall back to resolving again.
    }
    if (actual !== null) {
      if (actual !== real) throw refuse(shown, "it moved while being checked; try again.");
      assertAllowedReal(shown, actual, g, viaLink);
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
