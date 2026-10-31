// The smoke run's guards, in code: every write the run makes goes through ScratchGuard.checkWrite first, and the
// draft through checkDraft. They work from the ledger (what this run created) and from drive_get (where a file
// really is), so a bug elsewhere in the run, or an extension that answers with the wrong id, can't turn into a
// write on an existing file or a mail to anyone but the account itself.

import { resolve, sep } from "node:path";

export class GuardError extends Error {
  constructor(message: string) {
    super(`guard refused: ${message}`);
    this.name = "GuardError";
  }
}

/** What the run created, so cleanup and the leftover check work from facts, not from the step list. */
export interface Ledger {
  /** The run's marker (xaq-smoke-<ts>): the folder's and the agent's name, the draft subject's prefix. */
  marker: string;
  folder: { id: string; name: string } | null;
  /** Files created in the scratch folder (checked with drive_get before they were recorded). */
  files: Map<string, { kind: string; name: string }>;
  /** Files a create call reported that turned out NOT to be in the scratch folder: never written to again, reported. */
  strays: Map<string, { kind: string; name: string }>;
  drafts: Map<string, { deleted: boolean }>;
  agent: { id: string; name: string } | null;
  tempDir: string | null;
}

export function newLedger(marker: string): Ledger {
  return { marker, folder: null, files: new Map(), strays: new Map(), drafts: new Map(), agent: null, tempDir: null };
}

/**
 * Every Workspace write the run makes (upstream tool names), and where its target ids are:
 * - `folder`: the argument must be the scratch folder itself (create-in-folder calls, and the final drive_trash);
 * - `file`: the argument, when given, must be a file this run created whose parents include the scratch folder.
 * drive_create_folder is special: once, named after the marker, at the top of My Drive (it makes the folder).
 */
export const WRITE_TARGETS: Readonly<Record<string, { folder?: readonly string[]; file?: readonly string[] }>> = {
  drive_create_folder: {},
  drive_upload: { folder: ["folderId"] },
  drive_trash: { folder: ["fileId"] },
  docs_create: { folder: ["folderId"] },
  docs_append: { file: ["documentId"] },
  docs_replace_text: { file: ["documentId"] },
  docs_comment_add: { file: ["documentId"] },
  sheets_create: { folder: ["folderId"] },
  sheets_write: { file: ["spreadsheetId"] },
  sheets_append_rows: { file: ["spreadsheetId"] },
  slides_create: { folder: ["folderId"] },
  slides_add_slide: { file: ["presentationId"] },
  slides_replace_text: { file: ["presentationId"] },
  slides_insert_image: { file: ["presentationId", "driveFileId"] },
  slides_delete_slide: { file: ["presentationId"] },
};

/** The Workspace reads the run makes. Anything in neither list is refused. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  "drive_search",
  "drive_list_folder",
  "drive_get",
  "drive_export",
  "docs_read",
  "docs_comments_list",
  "sheets_read",
  "slides_read",
]);

/** drive_get's answer, as far as the guards need it. */
export interface DriveFacts {
  id: string;
  name: string;
  parents: string[];
  trashed: boolean;
}

export type DriveGet = (fileId: string) => Promise<DriveFacts>;

/** File arguments that may be left out (the tool takes another source instead). */
const OPTIONAL_FILE_ARGS: ReadonlySet<string> = new Set(["driveFileId"]);
/** create_draft attachment sources (writer A1): an item has exactly one. */
const SOURCE_KEYS = ["path", "drive_file_id", "content_base64", "message_id"] as const;
/** Other keys an attachment item may carry (attachment_id goes with message_id). */
const ITEM_KEYS: ReadonlySet<string> = new Set(["export_as", "filename", "mime_type", "attachment_id"]);

export class ScratchGuard {
  constructor(
    private readonly ledger: Ledger,
    private readonly driveGet: DriveGet,
  ) {}

  /** Throws GuardError unless `tool(args)` writes only inside the scratch folder. Call before EVERY write. */
  async checkWrite(tool: string, args: Record<string, unknown>): Promise<void> {
    const spec = WRITE_TARGETS[tool];
    if (!spec) throw new GuardError(`${tool} isn't one of the writes the smoke run makes`);
    if (tool === "drive_create_folder") {
      if (this.ledger.folder) throw new GuardError("the scratch folder already exists; the run makes exactly one");
      if (args.name !== this.ledger.marker) throw new GuardError(`the scratch folder must be named ${this.ledger.marker}`);
      if (args.parentId !== undefined) throw new GuardError("the scratch folder goes at the top of My Drive");
      return;
    }
    const folder = this.ledger.folder;
    if (!folder) throw new GuardError(`${tool}: there is no scratch folder, so nothing may be written`);
    for (const key of spec.folder ?? []) {
      const value = args[key];
      if (value !== folder.id) throw new GuardError(`${tool}: ${key} must be the scratch folder ${folder.id}`);
      const f = await this.driveGet(folder.id);
      if (f.id !== folder.id || f.name !== folder.name) throw new GuardError(`${tool}: ${folder.id} isn't the scratch folder ${folder.name} any more`);
    }
    for (const key of spec.file ?? []) {
      const value = args[key];
      // Every file argument is required, except slides_insert_image's driveFileId (it may take imageUrl instead).
      if (value === undefined && OPTIONAL_FILE_ARGS.has(key)) continue;
      await this.checkFile(tool, key, value);
    }
  }

  /** A file argument: one this run created, and drive_get says it's in the scratch folder. */
  async checkFile(tool: string, key: string, value: unknown): Promise<void> {
    const folder = this.ledger.folder;
    if (!folder) throw new GuardError(`${tool}: there is no scratch folder`);
    if (typeof value !== "string" || !value) throw new GuardError(`${tool}: ${key} must be a file id`);
    if (!this.ledger.files.has(value)) throw new GuardError(`${tool}: ${key} ${value} isn't a file this run created`);
    const f = await this.driveGet(value);
    if (f.id !== value || !f.parents.includes(folder.id)) throw new GuardError(`${tool}: ${key} ${value} isn't in the scratch folder ${folder.name}`);
    if (f.trashed) throw new GuardError(`${tool}: ${key} ${value} is in the trash`);
  }

  /**
   * The draft: addressed to exactly the account's own address (no Cc, no Bcc, not a reply), its attachments only a
   * file in the run's temp dir or a file in the scratch folder.
   */
  async checkDraft(args: Record<string, unknown>, own: string): Promise<void> {
    const me = own.trim().toLowerCase();
    const to = args.to;
    if (!Array.isArray(to) || to.length !== 1 || typeof to[0] !== "string" || to[0].trim().toLowerCase() !== me) {
      throw new GuardError(`create_draft: the draft must be addressed to exactly ${own}, the account's own address`);
    }
    for (const key of ["cc", "bcc", "thread_id"]) if (args[key] !== undefined) throw new GuardError(`create_draft: no ${key}`);
    const atts = args.attachments;
    if (!Array.isArray(atts)) return;
    for (const a of atts as Record<string, unknown>[]) {
      if (!a || typeof a !== "object" || Array.isArray(a)) throw new GuardError("create_draft: an attachment must be an object");
      // Exactly one source per item (message_id + attachment_id together count as one), and no keys beyond it.
      const sources = SOURCE_KEYS.filter((k) => a[k] !== undefined);
      if (sources.length !== 1) throw new GuardError(`create_draft: each attachment needs exactly one source, not ${sources.length ? sources.join(" + ") : "none"}`);
      const extra = Object.keys(a).filter((k) => !(SOURCE_KEYS as readonly string[]).includes(k) && !ITEM_KEYS.has(k));
      if (extra.length) throw new GuardError(`create_draft: unexpected attachment keys ${extra.join(", ")}`);
      if (typeof a.path === "string") {
        const dir = this.ledger.tempDir;
        const abs = resolve(a.path);
        if (!dir || !abs.startsWith(resolve(dir) + sep)) throw new GuardError("create_draft: a local attachment must be in the run's temp dir");
      } else if (typeof a.drive_file_id === "string") {
        await this.checkFile("create_draft", "drive_file_id", a.drive_file_id);
      } else {
        throw new GuardError("create_draft: attachments are a temp-dir file or a scratch-folder file only");
      }
    }
  }
}
