// A small, strict reader for the zip packages behind DOCX, XLSX and PPTX. Runs in the parser child only.
//
// - The central directory is the only index: at most PARSE_LIMITS.zipEntries entries, no duplicate names, no names
//   that leave the archive (absolute, "..", backslashes, drive letters, NUL). A package with one is refused whole.
// - Entries are inflated on demand, one at a time, with zlib's maxOutputLength: an entry never grows past
//   zipEntryBytes, and all reads together never past zipTotalBytes. A ratio above zipRatio (on entries past 1 MB)
//   is refused as a zip bomb before inflating.
// - Stored and deflated entries only. Encrypted, ZIP64 and multi-disk archives are refused.

import { inflateRawSync } from "node:zlib";
import { PARSE_LIMITS, UnsafeDocumentError } from "./types.ts";

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD = 0x06054b50;
const CDH = 0x02014b50;
const LFH = 0x04034b50;

/** Whether a zip entry name stays inside the archive. */
export function safeEntryName(name: string): boolean {
  if (!name || name.length > 1024 || /[\\\0]/.test(name) || name.startsWith("/") || /^[a-z]:/i.test(name)) return false;
  return !name.split("/").some((seg) => seg === "..");
}

export class ZipPackage {
  private readonly entries = new Map<string, Entry>();
  private inflated = 0;

  constructor(private readonly buf: Buffer) {
    if (buf.length < 22) throw new UnsafeDocumentError("corrupt", "This isn't a valid zip package.");
    // End of central directory: the last 22 bytes, or up to 64 KB earlier with a comment.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
      if (buf.readUInt32LE(i) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new UnsafeDocumentError("corrupt", "This isn't a valid zip package (no central directory).");
    const disk = buf.readUInt16LE(eocd + 4);
    const cdDisk = buf.readUInt16LE(eocd + 6);
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (disk !== 0 || cdDisk !== 0) throw new UnsafeDocumentError("unsupported", "Multi-part zip archives aren't supported.");
    if (count === 0xffff || cdOffset === 0xffffffff) throw new UnsafeDocumentError("unsupported", "ZIP64 archives aren't supported.");
    if (count > PARSE_LIMITS.zipEntries) throw new UnsafeDocumentError("too_complex", `The package has ${count} entries; at most ${PARSE_LIMITS.zipEntries} are read.`);
    if (cdOffset + cdSize > eocd) throw new UnsafeDocumentError("corrupt", "This zip package is corrupt (central directory out of range).");
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > eocd || buf.readUInt32LE(p) !== CDH) throw new UnsafeDocumentError("corrupt", "This zip package is corrupt (bad central directory).");
      const flags = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      const compressedSize = buf.readUInt32LE(p + 20);
      const size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localOffset = buf.readUInt32LE(p + 42);
      const name = buf.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (flags & 0x1) throw new UnsafeDocumentError("encrypted", "Encrypted documents can't be read.");
      if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new UnsafeDocumentError("unsupported", "ZIP64 archives aren't supported.");
      if (!safeEntryName(name)) throw new UnsafeDocumentError("hostile", "The package has an entry with a path outside the archive; it wasn't read.");
      if (this.entries.has(name)) throw new UnsafeDocumentError("hostile", "The package lists the same entry twice; it wasn't read.");
      if (name.endsWith("/")) continue;
      this.entries.set(name, { name, method, compressedSize, size, localOffset });
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  /** The entry's bytes, or null when there is no such entry. Throws UnsafeDocumentError past a cap. */
  read(name: string): Buffer | null {
    const e = this.entries.get(name);
    if (!e) return null;
    const b = this.buf;
    if (e.localOffset + 30 > b.length || b.readUInt32LE(e.localOffset) !== LFH) throw new UnsafeDocumentError("corrupt", "This zip package is corrupt (bad entry header).");
    const start = e.localOffset + 30 + b.readUInt16LE(e.localOffset + 26) + b.readUInt16LE(e.localOffset + 28);
    if (start + e.compressedSize > b.length) throw new UnsafeDocumentError("corrupt", "This zip package is corrupt (entry out of range).");
    const data = b.subarray(start, start + e.compressedSize);
    const budget = Math.min(PARSE_LIMITS.zipEntryBytes, PARSE_LIMITS.zipTotalBytes - this.inflated);
    if (e.size > 1024 * 1024 && e.size / Math.max(1, e.compressedSize) > PARSE_LIMITS.zipRatio) {
      throw new UnsafeDocumentError("hostile", "The document looks like a zip bomb (it decompresses to far more than its size); it wasn't read.");
    }
    if (e.size > budget) throw new UnsafeDocumentError("too_complex", "The document is too large to read once decompressed.");
    let out: Buffer;
    if (e.method === 0) {
      out = data;
    } else if (e.method === 8) {
      try {
        // The declared size can lie: zlib stops at the cap whatever the entry really holds.
        out = inflateRawSync(data, { maxOutputLength: Math.max(1, budget) });
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
          throw new UnsafeDocumentError("hostile", "The document looks like a zip bomb (it decompresses to far more than its size); it wasn't read.");
        }
        throw new UnsafeDocumentError("corrupt", "This zip package is corrupt (an entry doesn't decompress).");
      }
    } else {
      throw new UnsafeDocumentError("unsupported", "The package uses a compression method that isn't supported.");
    }
    if (out.length > budget) throw new UnsafeDocumentError("too_complex", "The document is too large to read once decompressed.");
    this.inflated += out.length;
    return out;
  }

  /** The entry as UTF-8 text (BOM dropped), or null. */
  text(name: string): string | null {
    const b = this.read(name);
    if (!b) return null;
    const s = b.toString("utf8");
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
  }
}

/** A relationship target resolved against the part that names it ("word/document.xml" + "media/x.png"); null if it leaves the package. */
export function resolvePart(from: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const base = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const seg of target.replace(/^\/+/, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!base.length) return null;
      base.pop();
    } else {
      base.push(seg);
    }
  }
  const out = base.join("/");
  return out && safeEntryName(out) ? out : null;
}
