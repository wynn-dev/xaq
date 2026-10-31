// Files an agent attaches to a draft, reply, forward or new message (the `attachments` tool argument). Everything
// is checked here, in plain words, before anything reaches Google: base64, type, size against Gmail's
// limits, the file types Gmail refuses, and the filename (cleaned like other untrusted header text).
// Files come from two sources (server/mail/attach-sources.ts): bytes in the call, or another message's attachment.

import { createHash } from "node:crypto";
import { detectExtension, detectMimeType } from "nodemailer/lib/mime-funcs";
import type { AttachmentSource } from "../../shared/types.ts";
import { UPLOAD_MAX_BYTES } from "../google/gmail.ts";
import { decodeMimeWords } from "../google/mime.ts";
import { escapeDelimiters, stripInvisible } from "./content.ts";

/** The bytes, in the call. Today's form. */
export interface Base64AttachmentInput {
  filename: string;
  mime_type?: string;
  content_base64: string;
}
/** An attachment of another message in the same account (ids as get_message / get_thread list them). */
export interface MessageAttachmentInput {
  message_id: string;
  attachment_id: string;
}

/** The tool argument, one item per file: exactly one source each. */
export type AttachmentInput = Base64AttachmentInput | MessageAttachmentInput;

/** A checked attachment, ready for the MIME composer. */
export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  /** Where it came from (audit). Absent: in the call (content_base64). */
  source?: AttachmentSource;
}

/** Audit view: never the content. */
export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  source?: AttachmentSource;
}

/** Files per message. Gmail itself takes far more; this keeps tool calls and the audit log readable. */
export const MAX_ATTACHMENTS = 10;
/**
 * Gmail's sending limit: 25 MB for the message content and attachments together, before encoding
 * (support.google.com/mail/answer/6584, "You can send up to 25 MB in attachments", and the Workspace sending
 * limits). Counted in decimal megabytes, the stricter reading.
 */
export const MAX_MESSAGE_BYTES = 25_000_000;
/**
 * The most the encoded message (RFC 822, base64 / quoted-printable parts and all) may be, for the Gmail API
 * endpoint xaq uses. messages.send and drafts.create take the message either as `raw` in a JSON body or as a media
 * upload on /upload/gmail/v1/…; xaq uses the JSON body only up to 512 KB (gmail.ts JSON_RAW_MAX_CHARS: Google
 * documents no limit there and has refused 1 MB), so large messages always go through the upload endpoint, whose
 * documented maximum is 35 MB: "Maximum file size: 35MB" on
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send and
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/create, and
 * `"maxSize": "36700160"` for both upload methods in Gmail's discovery document
 * (https://gmail.googleapis.com/$discovery/rest?version=v1). 25 MB of files is about 34.2 MB once base64-encoded,
 * so this limit is only reached through the body: quoted-printable can double a text body.
 */
export const MAX_ENCODED_BYTES = UPLOAD_MAX_BYTES;
/** Allowance for the message's own headers (From, To, Subject, threading, MIME boundaries). */
const MESSAGE_HEADER_BYTES = 4096;
/** Allowance for each attached file's MIME headers (type, disposition, an encoded long filename). */
const PART_HEADER_BYTES = 1024;

/**
 * Estimated bytes a part of `raw` bytes takes in the encoded message: base64 in 76-character lines (57 bytes each,
 * plus CRLF) and its headers. A quoted-printable text body can take more; the composed message is checked exactly.
 */
export const encodedPartSize = (raw: number): number => Math.ceil(raw / 3) * 4 + Math.ceil(raw / 57) * 2 + PART_HEADER_BYTES;
/** The estimated encoded size of a message with this body and no files yet. */
export const encodedBaseSize = (bodyBytes: number): number => MESSAGE_HEADER_BYTES + encodedPartSize(bodyBytes);
/** Largest file (raw bytes) whose estimated encoding still fits in `encodedRoom` bytes of message. */
export const rawCapacity = (encodedRoom: number): number => {
  const room = encodedRoom - PART_HEADER_BYTES;
  return room <= 0 ? 0 : Math.max(0, Math.floor((room * 57) / 78));
};
/** Sizes in errors: decimal, like Gmail's 25 MB. */
export const mb = (bytes: number): string => (bytes >= 100_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);
/** Gmail's 25 MB rule, as errors state it. */
export const LIMIT_WORDS = "Gmail sends at most 25 MB per message (body and attachments together)";
/** The API limit on the encoded message, as errors state it. */
export const ENCODED_LIMIT_WORDS = `Gmail's API accepts at most 35 MB (${MAX_ENCODED_BYTES.toLocaleString("en-US")} bytes) per message once it is encoded for email`;
/** Longest filename kept (code points), extension included. */
export const MAX_FILENAME_CHARS = 120;

/**
 * File types Gmail refuses to send, as listed on "File types blocked in Gmail"
 * (support.google.com/mail/answer/6590). Gmail also blocks them compressed (.gz, .bz2) and inside archives;
 * archives aren't opened here, so Gmail may still refuse a .zip that contains one.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "ade", "adp", "apk", "appx", "appxbundle", "bat", "cab", "chm", "cmd", "com", "cpl", "diagcab", "diagcfg",
  "diagpkg", "dll", "dmg", "ex", "ex_", "exe", "hta", "img", "ins", "iso", "isp", "jar", "jnlp", "js", "jse",
  "lib", "lnk", "mde", "mjs", "msc", "msi", "msix", "msixbundle", "msp", "mst", "nsh", "pif", "ps1", "scr",
  "sct", "shb", "sys", "vb", "vbe", "vbs", "vhd", "vxd", "wsc", "wsf", "wsh", "xll",
]);
/** Single-file compression Gmail looks through ("x.exe.gz" is blocked like "x.exe"). */
const COMPRESSED = new Set(["gz", "bz2", "xz", "z", "zst", "lz", "lzma"]);

/** RFC 6838 type/subtype (restricted-name), no parameters. */
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
/** Standard or url-safe base64, padding optional. Whitespace (line wrapping) is removed first. */
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;
/** C0/C1 controls and DEL, plus the bidi marks stripInvisible keeps in text (LRM, RLM, ALM). */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point here
const CONTROL_OR_MARK = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u061c]/g;
/** An extension worth keeping when the name is cut: short, letters/digits (and "_" for "ex_"). */
const EXTENSION = /\.([\p{L}\p{N}_]{1,16})$/u;
// Alternation, not a class: U+1160 and U+FE0F would combine with a neighbour inside one.
const TRAILING_JUNK = /(?:[\s.\u115F\u180E\u3164\uFFA0]|\u1160|\uFE0F)+$/u;
const NTFS_STREAM = /(?::[^:/\\]*)?:\$[A-Za-z_]+$/;

export class AttachmentError extends Error {
  constructor(
    readonly code:
      | "invalid_attachment"
      | "too_many_attachments"
      | "too_large"
      | "blocked_file_type",
    message: string,
  ) {
    super(message);
  }
}

/** Gmail's extension for a MIME type, or null when nodemailer doesn't know one. */
function extensionFor(mimeType: string): string | null {
  const ext = detectExtension(mimeType);
  return ext && ext !== "bin" && ext !== "*" && /^[a-z0-9]{1,10}$/i.test(ext) ? ext.toLowerCase() : null;
}

/** An RFC 2047 encoded-word ("=?charset?B|Q?text?="). */
const ENCODED_WORD = /=\?[^?\s]+\?[bq]\?[^?\s]*\?=/i;

/**
 * The filename as it will appear in the message: no path, no control, zero-width, bidi or tag characters,
 * our delimiter tags defused, at most MAX_FILENAME_CHARS with the extension kept. Falls back to
 * "attachment" (plus the extension for `mimeType`, when known).
 */
export function sanitizeFilename(name: string, mimeType = "application/octet-stream"): string {
  // Bounded input: anything past a few times the cap is never shown.
  let s = String(name ?? "").slice(0, MAX_FILENAME_CHARS * 8);
  // Mail clients decode RFC 2047 encoded-words in filenames ("=?UTF-8?B?ZXZpbC5leGU=?=" is evil.exe), so
  // every check below must see the decoded name. Nested encodings are unwrapped too, a few rounds at most.
  for (let round = 0; round < 5; round++) {
    const decoded = decodeMimeWords(s);
    if (decoded === s) break;
    s = decoded.slice(0, MAX_FILENAME_CHARS * 8);
  }
  s = stripInvisible(s).text.replace(CONTROL_OR_MARK, "");
  s = s.split(/[/\\]/).at(-1) ?? "";
  s = trimTail(escapeDelimiters(s).replace(/\s+/g, " ").trim());
  if (s === "." || s === ".." || !s.replace(/\./g, "")) s = "";
  if (!s) {
    const ext = extensionFor(mimeType);
    return ext ? `attachment.${ext}` : "attachment";
  }
  const chars = Array.from(s);
  if (chars.length <= MAX_FILENAME_CHARS) return s;
  const ext = EXTENSION.exec(s)?.[0] ?? "";
  const keep = MAX_FILENAME_CHARS - Array.from(ext).length - 1;
  return `${chars.slice(0, keep).join("").trimEnd()}…${ext}`;
}

/**
 * Trailing characters that hide the real extension: whitespace, dots, invisible fillers (variation selector
 * U+FE0F, Hangul fillers U+115F/U+1160/U+3164/U+FFA0, Mongolian vowel separator U+180E) and an NTFS stream
 * suffix ("::$DATA", ":name:$DATA"). Removed until none is left.
 */
function trimTail(s: string): string {
  for (;;) {
    const next = s.replace(TRAILING_JUNK, "").replace(NTFS_STREAM, "");
    if (next === s) return s;
    s = next;
  }
}

/** The extension Gmail would block this file for, or null. Looks through one layer of compression. */
export function blockedExtension(filename: string): string | null {
  const parts = trimTail(filename).toLowerCase().split(".").slice(1);
  let ext = parts.at(-1);
  if (ext && COMPRESSED.has(ext) && parts.length >= 2) {
    const inner = parts.at(-2)!;
    if (BLOCKED_EXTENSIONS.has(inner)) return `${inner}.${ext}`;
  }
  return ext && BLOCKED_EXTENSIONS.has(ext) ? ext : null;
}

/** Decoded size of a (whitespace-free) base64 string, without decoding it. */
function decodedSize(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor(((b64.length - pad) * 3) / 4);
}

/** "Attachment 2 (report.pdf)": how errors name an item before its file is checked. */
export const itemLabel = (i: number, name?: unknown): string =>
  `Attachment ${i + 1}${typeof name === "string" && name.trim() ? ` (${sanitizeFilename(name)})` : ""}`;

/** content_base64, whitespace removed and checked; its decoded size. Nothing is decoded yet. */
export function checkBase64(label: string, value: unknown): { b64: string; size: number } {
  const b64 = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  if (!b64) throw new AttachmentError("invalid_attachment", `${label} is empty: put the file's bytes, base64-encoded, in content_base64.`);
  if (!BASE64.test(b64) || b64.length % 4 === 1 || (b64.includes("=") && b64.length % 4 !== 0)) {
    throw new AttachmentError(
      "invalid_attachment",
      `${label}: content_base64 is not valid base64. Encode the file's bytes with standard or url-safe base64 (no "data:" prefix).`,
    );
  }
  return { b64, size: decodedSize(b64) };
}

/** Decodes checked base64 (checkBase64); refuses an empty or inconsistent result. */
export function decodeBase64(label: string, b64: string, size: number): Buffer {
  const content = Buffer.from(b64, "base64");
  if (!content.length || content.length !== size) {
    throw new AttachmentError("invalid_attachment", content.length ? `${label}: content_base64 is not valid base64.` : `${label} is empty: an attached file needs at least one byte.`);
  }
  return content;
}

/**
 * The name and type a file goes out with: `mime_type` checked (or inferred from the extension, else
 * application/octet-stream), the filename cleaned, Gmail's blocked types refused. `fallbackType` is used
 * instead of inferring when there is no `given` type (a source that knows the type, such as another message's attachment).
 */
export function fileType(label: string, rawName: string, given: unknown, fallbackType?: string): { filename: string; contentType: string } {
  const type = typeof given === "string" ? given.trim() : "";
  if (type && !MIME_TYPE.test(type)) {
    throw new AttachmentError("invalid_attachment", `${label}: mime_type "${escapeDelimiters(type.slice(0, 80))}" isn't a type/subtype such as application/pdf (leave out parameters like "; charset").`);
  }
  if (/^(multipart|message)\//i.test(type)) {
    throw new AttachmentError("invalid_attachment", `${label}: ${type} can't be the type of an attached file; use application/octet-stream for a saved email.`);
  }
  // Without mime_type: the source's own type, else from the extension, else application/octet-stream.
  const known = fallbackType && MIME_TYPE.test(fallbackType) ? fallbackType : "";
  const inferred = known || detectMimeType(sanitizeFilename(rawName));
  // An inferred message/* or multipart/* type (x.eml, x.mht) would be embedded raw; attach those as plain bytes.
  const contentType = (type || (inferred && !/^(multipart|message)\//i.test(inferred) ? inferred : "") || "application/octet-stream").toLowerCase();
  const filename = sanitizeFilename(rawName, contentType);
  // Still an encoded-word after the bounded unwrapping: a mail client would decode it once more, into a name
  // nothing here has checked. Refuse rather than send a name the audit log can't show.
  if (ENCODED_WORD.test(filename)) {
    throw new AttachmentError("invalid_attachment", `${label}: the filename is MIME-encoded (=?…?=); pass the plain file name.`);
  }
  const blocked = blockedExtension(filename);
  if (blocked) {
    throw new AttachmentError(
      "blocked_file_type",
      `${filename}: Gmail doesn't allow sending .${blocked} files (it blocks executables and similar types). Share it as a link instead.`,
    );
  }
  return { filename, contentType };
}

/** The usual advice after a size refusal, when nothing more specific applies. */
export const SMALLER_FILES_HINT = "Send fewer or smaller files, or share large ones as a link.";

/**
 * The size refusal: names the file, its size and the message's, and says what to do instead (`hint`). `atLeast`:
 * the file's size isn't known exactly (it was cut off there).
 * `limit`: Gmail's 25 MB of body and attachments (`total` is that sum), or the API's 35 MB for the encoded message
 * (`total` is its estimated encoded size).
 */
export function tooLarge(opts: {
  file: string;
  size: number;
  atLeast?: boolean;
  total: number;
  limit?: "raw" | "encoded";
  /** Every file with its size, when there are several. */
  files?: { name: string; size: number | null }[];
  hint: string;
}): AttachmentError {
  const over = opts.atLeast ? "over " : "";
  const list =
    opts.files && opts.files.length > 1 ? ` Files: ${opts.files.map((f) => `${f.name} ${f.size === null ? "(size unknown)" : mb(f.size)}`).join(", ")}.` : "";
  const why =
    opts.limit === "encoded"
      ? `once encoded for email the message would be ${over}${mb(opts.total)}, and ${ENCODED_LIMIT_WORDS}.`
      : `the message would be ${over}${mb(opts.total)}, and ${LIMIT_WORDS}.`;
  return new AttachmentError("too_large", `${opts.file} (${over}${mb(opts.size)}) doesn't fit: ${why}${list} ${opts.hint}`);
}

/**
 * Checks and decodes attachments given as bytes in the call (content_base64), synchronously. `bodyBytes`
 * (the message text) counts toward Gmail's 25 MB. Throws AttachmentError with a message the agent can act on.
 * Other sources go through resolveAttachments (server/mail/attach-sources.ts).
 */
export function prepareAttachments(input: Base64AttachmentInput[] | undefined, bodyBytes = 0): OutgoingAttachment[] {
  if (!input?.length) return [];
  if (input.length > MAX_ATTACHMENTS) {
    throw new AttachmentError("too_many_attachments", `At most ${MAX_ATTACHMENTS} attachments per message; you passed ${input.length}.`);
  }
  // Sizes first, from the base64 length: nothing is decoded when the total is over the limit.
  const items = input.map((a, i) => {
    const label = itemLabel(i, a.filename);
    return { a, label, ...checkBase64(label, a.content_base64) };
  });
  const total = bodyBytes + items.reduce((n, x) => n + x.size, 0);
  if (total > MAX_MESSAGE_BYTES) {
    let running = bodyBytes;
    const culprit = items.find((x) => (running += x.size) > MAX_MESSAGE_BYTES)!;
    throw tooLarge({ file: culprit.label, size: culprit.size, total, files: items.map((y) => ({ name: y.label, size: y.size })), hint: SMALLER_FILES_HINT });
  }
  return items.map(({ a, label, b64, size }) => {
    const { filename, contentType } = fileType(label, typeof a.filename === "string" ? a.filename : "", a.mime_type);
    return { filename, contentType, content: decodeBase64(label, b64, size), source: { kind: "upload" as const } };
  });
}

/** What the audit log records about each file: name, type, size, source and sha256, never content. */
export function attachmentMeta(list: { filename: string; contentType?: string; content: Buffer; source?: AttachmentSource }[]): AttachmentMeta[] {
  return list.map((x) => ({
    filename: x.filename,
    mimeType: x.contentType ?? "application/octet-stream",
    size: x.content.length,
    ...(x.source ? { source: x.source } : {}),
    sha256: createHash("sha256").update(x.content).digest("hex"),
  }));
}
