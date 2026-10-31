// Extension integrity: sha256 over a canonical listing of
// the extension directory. For each regular file, sorted by POSIX path relative to the extension root (byte order of
// the UTF-8 path), the line is `<path>\0<mode 644|755>\0<hex sha256 of content>\n`. Symlinks, devices and anything
// that isn't a regular file or a directory are refused. Encoded as `sha256-<base64>`.
//
// xaq-extensions' scripts/integrity.mjs is the same algorithm in plain Node; both are checked against
// test/fixtures/extension-integrity/ (the repo carries the same vectors). Keep them in step.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface IntegrityEntry {
  /** POSIX path relative to the extension root. */
  path: string;
  mode: "644" | "755";
  sha256: string;
}

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

export const INTEGRITY_RE = /^sha256-[A-Za-z0-9+/]{43}=$/;

/** Every regular file under `root`, in canonical order. Throws IntegrityError on a symlink, device, socket or FIFO. */
export function listExtensionFiles(root: string): IntegrityEntry[] {
  const out: IntegrityEntry[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) throw new IntegrityError(`${path} is a symlink; extensions can't contain symlinks.`);
      if (st.isDirectory()) walk(abs, path);
      else if (st.isFile()) out.push({ path, mode: st.mode & 0o111 ? "755" : "644", sha256: createHash("sha256").update(readFileSync(abs)).digest("hex") });
      else throw new IntegrityError(`${path} isn't a regular file or a directory; extensions can only contain files.`);
    }
  };
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new IntegrityError(`${root} isn't a directory.`);
  walk(root, "");
  return out.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
}

/** The canonical listing the digest is taken over. */
export function canonicalListing(entries: IntegrityEntry[]): string {
  return entries.map((e) => `${e.path}\0${e.mode}\0${e.sha256}\n`).join("");
}

export function integrityOfListing(entries: IntegrityEntry[]): string {
  return `sha256-${createHash("sha256").update(canonicalListing(entries), "utf8").digest("base64")}`;
}

/** `sha256-<base64>` of the directory. */
export function computeIntegrity(root: string): string {
  return integrityOfListing(listExtensionFiles(root));
}

/** The digest in hex (the install directory's name uses a prefix of it). */
export function integrityHex(integrity: string): string {
  if (!INTEGRITY_RE.test(integrity)) throw new IntegrityError(`"${integrity}" isn't a sha256-<base64> integrity.`);
  return Buffer.from(integrity.slice("sha256-".length), "base64").toString("hex");
}

/** The install directory's name for an integrity: the first 16 hex characters of the digest. */
export const integrityDirName = (integrity: string) => integrityHex(integrity).slice(0, 16);
