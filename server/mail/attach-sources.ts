// Turns the agent's `attachments` (bytes in the call, a local path, another message's attachment, a Drive file)
// and forward's original files into checked files for the MIME composer, within Gmail's 25 MB per message.
//
// Two passes. First every item is checked and sized without downloading anything: its shape, its name and type
// (Gmail's blocked types), the path rules (server/mail/local-files.ts), the message part or the Drive file's
// metadata. When the sizes known by then (base64 length, fstat, Gmail's part size, Drive's `size`) are already
// over a limit, nothing is fetched. Then each file is fetched with a cap of what still fits, so nothing larger
// is ever buffered: a source larger than it said (or a Drive export, whose size isn't known in advance) is cut
// off at the cap and refused.
//
// Two limits: Gmail's 25 MB of body and attachment bytes (MAX_MESSAGE_BYTES), and the API's 35 MB for the
// encoded message (MAX_ENCODED_BYTES), estimated here and checked exactly once the message is composed (agent.ts).

import { basename } from "node:path";
import type { AttachmentSource } from "../../shared/types.ts";
import type { DriveClient } from "../google/drive.ts";
import { ResponseTooLargeError } from "../google/http.ts";
import {
  AttachmentError,
  type AttachmentInput,
  checkBase64,
  decodeBase64,
  encodedBaseSize,
  encodedPartSize,
  fileType,
  itemLabel,
  MAX_ATTACHMENTS,
  MAX_ENCODED_BYTES,
  MAX_MESSAGE_BYTES,
  type OutgoingAttachment,
  rawCapacity,
  SMALLER_FILES_HINT,
  tooLarge,
} from "./attachments.ts";
import { driveError, planDriveFile } from "./drive-files.ts";
import { type OpenLocalFile, openLocalFile, type PathPolicy, readCapped } from "./local-files.ts";

/** An attachment of a message in the account, as the caller found it (access already checked). */
export interface MessagePart {
  messageId: string;
  /** The stable part id get_message shows. */
  partId: string;
  filename: string;
  mimeType: string;
  /** Gmail's size for the part. */
  size: number;
  /** The bytes, or null when there are more than `maxBytes`. */
  fetch(maxBytes: number): Promise<Buffer | null>;
}

export interface SourceContext {
  accountEmail: string;
  /** The message text: it counts toward the 25 MB. */
  bodyBytes: number;
  /** Looks up `attachmentId` (part id or current Gmail id) on `messageId` in the same account. Throws when it can't. */
  messagePart(messageId: string, attachmentId: string): Promise<MessagePart>;
  /**
   * The account's Drive for this agent, or why it can't use it (no Google Workspace grant, or the account hasn't
   * granted Drive read access): thrown when an item names a Drive file.
   */
  drive: DriveClient | AttachmentError;
  paths: PathPolicy;
  /** Forward's include_attachments: the original's files (not counted toward MAX_ATTACHMENTS, names kept). */
  originals?: MessagePart[];
}

type Kind = "base64" | "path" | "message" | "drive";

const FIELDS: Record<Kind, string[]> = {
  base64: ["content_base64", "filename", "mime_type"],
  path: ["path", "filename", "mime_type"],
  message: ["message_id", "attachment_id"],
  drive: ["drive_file_id", "export_as"],
};

const SOURCES = "content_base64 (with filename), path, message_id with attachment_id, or drive_file_id";

/** Which source an item names; refuses none, several, or fields that don't belong. */
function kindOf(item: unknown, label: string): Kind {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new AttachmentError("invalid_attachment", `${label} must be an object with one source: ${SOURCES}.`);
  const o = item as Record<string, unknown>;
  const has = (k: string) => o[k] !== undefined;
  const kinds = (
    [
      ["base64", has("content_base64")],
      ["path", has("path")],
      ["message", has("message_id") || has("attachment_id")],
      ["drive", has("drive_file_id")],
    ] as const
  )
    .filter(([, on]) => on)
    .map(([k]) => k);
  if (kinds.length !== 1) throw new AttachmentError("invalid_attachment", `${label}: pass exactly one source: ${SOURCES}.`);
  const kind = kinds[0]!;
  const extra = Object.keys(o).filter((k) => has(k) && !FIELDS[kind].includes(k));
  if (extra.length) throw new AttachmentError("invalid_attachment", `${label}: ${extra.join(", ")} can't be used with ${FIELDS[kind][0]} (it takes ${FIELDS[kind].join(", ")}).`);
  const str = (k: string) => typeof o[k] === "string" && (o[k] as string).trim() !== "";
  if (kind === "base64" && typeof o.filename !== "string") throw new AttachmentError("invalid_attachment", `${label}: content_base64 needs a filename, e.g. "report.pdf".`);
  if (kind === "message" && !(str("message_id") && str("attachment_id"))) {
    throw new AttachmentError("invalid_attachment", `${label}: pass both message_id and attachment_id (as get_message lists them).`);
  }
  if (kind === "drive" && !str("drive_file_id")) throw new AttachmentError("invalid_attachment", `${label}: drive_file_id is empty.`);
  return kind;
}

/**
 * The cheap checks, before anything is loaded: the count, each item's shape and its base64. Throws AttachmentError.
 */
export function checkAttachmentInputs(input: readonly AttachmentInput[] | undefined): void {
  if (!input?.length) return;
  if (input.length > MAX_ATTACHMENTS) {
    throw new AttachmentError("too_many_attachments", `At most ${MAX_ATTACHMENTS} attachments per message; you passed ${input.length}.`);
  }
  input.forEach((item, i) => {
    const label = itemLabel(i, (item as { filename?: unknown })?.filename);
    if (kindOf(item, label) === "base64") checkBase64(label, (item as { content_base64: unknown }).content_base64);
  });
}

/** What each item asks for, for the audit log of a call that fails before the files are fetched (never content). */
export function requestedSources(input: readonly AttachmentInput[]): Record<string, string>[] {
  const cut = (v: unknown) => (typeof v === "string" ? (v.length > 300 ? `${v.slice(0, 300)}…` : v) : "");
  return input.slice(0, MAX_ATTACHMENTS).map((item): Record<string, string> => {
    const o = (item ?? {}) as unknown as Record<string, unknown>;
    if (o.path !== undefined) return { kind: "path", path: cut(o.path) };
    if (o.drive_file_id !== undefined) return o.export_as ? { kind: "drive", fileId: cut(o.drive_file_id), exportAs: cut(o.export_as) } : { kind: "drive", fileId: cut(o.drive_file_id) };
    if (o.message_id !== undefined) return { kind: "message", messageId: cut(o.message_id), attachmentId: cut(o.attachment_id) };
    return { kind: "upload", filename: cut(o.filename) };
  });
}

/** One file after the first pass: checked, sized when the source says, not fetched yet. */
interface Planned {
  /** How size errors name it. */
  name: string;
  size: number | null;
  /** Drive's page for it: the size error offers it as a link. */
  link?: string;
  original?: boolean;
  filename: string;
  contentType: string;
  source: AttachmentSource;
  fetch(maxBytes: number): Promise<Buffer | null>;
}

/** Checks, fetches and returns every file (originals first), or throws AttachmentError; nothing is sent here. */
export async function resolveAttachments(input: readonly AttachmentInput[] | undefined, sc: SourceContext): Promise<OutgoingAttachment[]> {
  checkAttachmentInputs(input);
  const open: OpenLocalFile[] = [];
  try {
    const planned: Planned[] = (sc.originals ?? []).map((p) => ({
      name: p.filename || "attachment",
      size: p.size,
      original: true,
      filename: p.filename || "attachment",
      contentType: p.mimeType || "application/octet-stream",
      source: { kind: "forward", messageId: p.messageId },
      fetch: (max) => p.fetch(max),
    }));
    for (const [i, item] of (input ?? []).entries()) planned.push(await plan(item, i, sc, open));
    return await fetchAll(planned, sc);
  } finally {
    await Promise.all(open.map((f) => f.handle.close().catch(() => {})));
  }
}

async function plan(item: AttachmentInput, i: number, sc: SourceContext, open: OpenLocalFile[]): Promise<Planned> {
  const o = item as unknown as Record<string, unknown>;
  const label = itemLabel(i, o.filename);
  switch (kindOf(item, label)) {
    case "base64": {
      const { b64, size } = checkBase64(label, o.content_base64);
      const t = fileType(label, o.filename as string, o.mime_type);
      return { name: t.filename, size, ...t, source: { kind: "upload" }, fetch: async () => decodeBase64(label, b64, size) };
    }
    case "path": {
      const path = o.path as string;
      // Name and type first: a blocked type is refused before the file system is touched.
      const t = fileType(label, typeof o.filename === "string" && o.filename.trim() ? o.filename : basename(String(path ?? "")), o.mime_type);
      const file = await openLocalFile(path, sc.paths);
      open.push(file);
      if (!file.size) throw new AttachmentError("invalid_attachment", `${label}: ${file.requested} is empty; an attached file needs at least one byte.`);
      return {
        name: t.filename,
        size: file.size,
        ...t,
        source: { kind: "path", path: file.real, ...(file.real !== file.requested ? { requested: file.requested } : {}) },
        fetch: (max) => readCapped(file, max),
      };
    }
    case "message": {
      const part = await sc.messagePart(o.message_id as string, o.attachment_id as string);
      const t = fileType(label, part.filename, undefined, part.mimeType);
      return {
        name: t.filename,
        size: part.size,
        ...t,
        source: { kind: "message", messageId: part.messageId, attachmentId: part.partId, filename: part.filename },
        fetch: (max) => part.fetch(max),
      };
    }
    case "drive": {
      const drive = sc.drive;
      if (drive instanceof AttachmentError) throw drive;
      const id = (o.drive_file_id as string).trim();
      const exportAs = o.export_as as Parameters<typeof planDriveFile>[2];
      let meta;
      try {
        meta = await drive.getFile(id);
      } catch (err) {
        throw driveError(err, label, id, sc.accountEmail);
      }
      const p = planDriveFile(label, meta, exportAs);
      const t = fileType(label, p.filename, undefined, p.mimeType);
      const capped = async (run: () => Promise<Buffer>) => {
        try {
          return await run();
        } catch (err) {
          if (err instanceof ResponseTooLargeError) return null;
          throw driveError(err, label, id, sc.accountEmail, meta);
        }
      };
      return {
        name: t.filename,
        size: p.kind === "download" ? p.size : null,
        link: meta.webViewLink,
        ...t,
        source: { kind: "drive", fileId: meta.id || id, name: meta.name, ...(p.kind === "export" ? { exportedAs: p.format } : {}) },
        fetch: (max) => capped(() => (p.kind === "export" ? drive.exportFile(id, p.mimeType, max) : drive.download(id, max))),
      };
    }
  }
}

/** What to do instead of a too-large file: its Drive link, sharing from Drive (when this agent can), smaller files. */
export function largeFileHint(opts: { link?: string; original?: boolean; driveUsable: boolean }): string {
  if (opts.link) return `Put its Drive link in the body instead: ${opts.link}`;
  if (opts.original) return `Forward without include_attachments${opts.driveUsable ? ", or share the files from Google Drive and put the links in the body" : ""}.`;
  return opts.driveUsable ? "Share large files from Google Drive and put the link in the body instead." : SMALLER_FILES_HINT;
}

/** Second pass: refuses what's already known to be too large, then fetches each file with a cap of what still fits. */
async function fetchAll(planned: Planned[], sc: SourceContext): Promise<OutgoingAttachment[]> {
  if (!planned.length) return [];
  const files = planned.map((p) => ({ name: p.name, size: p.size }));
  const driveUsable = !(sc.drive instanceof AttachmentError);
  const hint = (p: Planned) => largeFileHint({ link: p.link, original: p.original, driveUsable });
  const raw = (p: Planned) => p.size ?? 0;
  const enc = (p: Planned) => (p.size === null ? 0 : encodedPartSize(p.size));

  // Known sizes first: nothing is fetched when they're already over either limit.
  let rawUsed = sc.bodyBytes + planned.reduce((n, p) => n + raw(p), 0);
  let encUsed = encodedBaseSize(sc.bodyBytes) + planned.reduce((n, p) => n + enc(p), 0);
  const culprit = (start: number, size: (p: Planned) => number, max: number) => {
    let running = start;
    return planned.find((p) => (running += size(p)) > max) ?? planned.at(-1)!;
  };
  if (rawUsed > MAX_MESSAGE_BYTES) {
    const c = culprit(sc.bodyBytes, raw, MAX_MESSAGE_BYTES);
    throw tooLarge({ file: c.name, size: raw(c), total: rawUsed, files, hint: hint(c) });
  }
  if (encUsed > MAX_ENCODED_BYTES) {
    const c = culprit(encodedBaseSize(sc.bodyBytes), enc, MAX_ENCODED_BYTES);
    throw tooLarge({ file: c.name, size: raw(c), total: encUsed, limit: "encoded", files, hint: hint(c) });
  }

  const out: OutgoingAttachment[] = [];
  for (const p of planned) {
    // What still fits under both limits, counting every other file at its known size.
    const rawRoom = MAX_MESSAGE_BYTES - (rawUsed - raw(p));
    const encCap = rawCapacity(MAX_ENCODED_BYTES - (encUsed - enc(p)));
    const cap = Math.min(rawRoom, encCap);
    const content = cap > 0 ? await p.fetch(cap) : null;
    if (content === null) {
      const encoded = encCap < rawRoom;
      throw tooLarge({
        file: p.name,
        size: cap,
        atLeast: true,
        total: encoded ? MAX_ENCODED_BYTES : MAX_MESSAGE_BYTES,
        limit: encoded ? "encoded" : "raw",
        files,
        hint: hint(p),
      });
    }
    if (!content.length && !p.original) throw new AttachmentError("invalid_attachment", `${p.name} is empty; an attached file needs at least one byte.`);
    rawUsed += content.length - raw(p);
    encUsed += encodedPartSize(content.length) - enc(p);
    out.push({ filename: p.filename, contentType: p.contentType, content, source: p.source, ...(p.link ? { driveLink: p.link } : {}) });
  }
  return out;
}
