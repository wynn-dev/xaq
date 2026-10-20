// A fake google-workspace extension for the smoke command's tests: the extension's tool names and argument shapes
// (xaq-extensions ws/scaffold-drive-docs and ws/sheets-slides) over an in-memory Drive, served as an MCP upstream by
// test/fake-mcp-upstream.ts. Risk follows the manifest: reads are readOnlyHint, drive_trash and slides_delete_slide
// are destructiveHint (so "ask" holds them for approval). Every write is logged, so a test can prove existing files
// were never touched. Faults are injected per tool.

import type { FakeTool, FakeToolResult } from "./fake-mcp-upstream.ts";

type Json = Record<string, unknown>;
type Kind = "folder" | "doc" | "sheet" | "slides" | "image";

const MIME: Record<Kind, string> = {
  folder: "application/vnd.google-apps.folder",
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
  image: "image/png",
};

export interface FakeSlide {
  slideId: string;
  title: string;
  body: string[];
  images: number;
}

export interface FakeFile {
  id: string;
  name: string;
  kind: Kind;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  modifiedTime: string;
  text: string;
  rows: string[][];
  slides: FakeSlide[];
  comments: { id: string; text: string }[];
  bytes: Buffer | null;
  /** "Anyone with the link" (never set by the fake's tools). */
  shared: boolean;
}

export interface FakeWorkspace {
  tools: FakeTool[];
  files: Map<string, FakeFile>;
  /** Every write call: the tool and the file id it targeted (the folder for creates). */
  writes: { tool: string; target: string }[];
  /** Every call, in order. */
  calls: { tool: string; args: Json }[];
  /** Makes `tool` fail (or run `fn` first, e.g. to abort the run) on its next calls. */
  fault(tool: string, fn: (args: Json) => void): void;
  /** docs_create answers with this id instead of the new doc's (an extension bug the guards must catch). */
  wrongDocId: string | null;
  /** onCreate: called for every file added after it's set (a test mirrors new docs into the fake Google's Drive). */
  hooks: { onCreate: ((f: FakeFile) => void) | null };
  /** In the trash, itself or through a parent. */
  isTrashed(id: string): boolean;
  /** A doc exported as PDF (the A1 shim uses it for drive_file_id). */
  exportPdf(id: string): { filename: string; bytes: Buffer };
  /** Adds a file directly (a test's "earlier run" folder, a create whose answer got lost). */
  addFile(f: { id?: string; name: string; kind: Kind; parents?: string[] }): FakeFile;
}

const READ = { readOnlyHint: true, destructiveHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false };
const RISKY = { readOnlyHint: false, destructiveHint: true };

const obj = (props: Record<string, Json>, required: string[] = []): Json => ({ type: "object", properties: props, required });
const str: Json = { type: "string" };
const num: Json = { type: "number" };
const bool: Json = { type: "boolean" };
const rows: Json = { type: "array", items: { type: "array" } };
const any: Json = {};

function colIndex(letters: string): number {
  let n = 0;
  for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** "A1:C4" / "A:C" / "Sheet1!A1:C2" → zero-based bounds (rows open-ended when missing). */
function parseRange(range: string): { r0: number; c0: number; r1: number; c1: number } {
  const a1 = range.includes("!") ? range.split("!")[1]! : range;
  const m = /^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/i.exec(a1);
  if (!m) throw new Error(`bad range ${range}`);
  const c0 = colIndex(m[1]!);
  const r0 = m[2] ? Number(m[2]) - 1 : 0;
  const c1 = m[3] ? colIndex(m[3]) : c0;
  const r1 = m[4] ? Number(m[4]) - 1 : Number.MAX_SAFE_INTEGER;
  return { r0, c0, r1, c1 };
}

export function fakeWorkspace(): FakeWorkspace {
  const files = new Map<string, FakeFile>();
  const writes: FakeWorkspace["writes"] = [];
  const calls: FakeWorkspace["calls"] = [];
  const faults = new Map<string, (args: Json) => void>();
  const hooks: FakeWorkspace["hooks"] = { onCreate: null };
  let seq = 0;
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const nextId = (p: string) => `${p}${(++seq).toString(36).padStart(4, "0")}`;
  const tick = () => new Date((clock += 60_000)).toISOString();

  const add = (f: Partial<FakeFile> & { name: string; kind: Kind }): FakeFile => {
    const file: FakeFile = {
      id: f.id ?? nextId(f.kind),
      name: f.name,
      kind: f.kind,
      mimeType: f.mimeType ?? MIME[f.kind],
      parents: f.parents ?? ["root"],
      trashed: false,
      modifiedTime: f.modifiedTime ?? tick(),
      text: f.text ?? "",
      rows: f.rows ?? [],
      slides: f.slides ?? [],
      comments: [],
      bytes: f.bytes ?? null,
      shared: f.shared ?? false,
    };
    files.set(file.id, file);
    hooks.onCreate?.(file);
    return file;
  };

  // Existing files: their content must never show up in the run's output, and they must never be written.
  add({ id: "doc-existing", name: "Quarterly plan", kind: "doc", text: "# Plan\n\nTOP-SECRET-DOC-CONTENT", modifiedTime: "2026-09-30T10:00:00Z" });
  add({ id: "doc-older", name: "Old notes", kind: "doc", text: "older", modifiedTime: "2026-01-01T10:00:00Z" });
  add({ id: "sheet-existing", name: "Budget", kind: "sheet", rows: [["item", "cost"], ["TOP-SECRET-SHEET-CONTENT", "1"]] });
  add({ id: "slides-existing", name: "Pitch", kind: "slides", slides: [{ slideId: "p1", title: "TOP-SECRET-SLIDE-CONTENT", body: [], images: 0 }] });

  const isTrashed = (id: string): boolean => {
    const f = files.get(id);
    if (!f) return false;
    return f.trashed || f.parents.some((p) => p !== "root" && isTrashed(p));
  };
  const get = (id: unknown, kind?: Kind): FakeFile => {
    const f = files.get(String(id));
    if (!f || (kind && f.kind !== kind)) throw new Error(`File not found: ${String(id)}`);
    return f;
  };
  const inFolder = (folderId: unknown): string[] => {
    if (folderId === undefined) return ["root"];
    const folder = get(folderId, "folder");
    return [folder.id];
  };
  const ok = (text: string, structured: Json): FakeToolResult => ({ content: [{ type: "text", text }], structuredContent: structured });
  const summary = (f: FakeFile) => ({ id: f.id, name: f.name, type: f.kind, mimeType: f.mimeType, modifiedTime: f.modifiedTime, owner: "me", webViewLink: `https://drive.example/${f.id}` });
  const slideText = (f: FakeFile) => f.slides.map((s, i) => [`## Slide ${i + 1}: ${s.title} [id ${s.slideId}]`, ...s.body, s.images ? `(${s.images} images)` : ""].join("\n")).join("\n");

  const tool = (name: string, annotations: Json, inputSchema: Json, run: (a: Json) => FakeToolResult, write?: (a: Json) => string): FakeTool => ({
    name,
    description: `Fake ${name}.`,
    inputSchema,
    annotations,
    handler: (args) => {
      calls.push({ tool: name, args });
      faults.get(name)?.(args);
      if (write) writes.push({ tool: name, target: write(args) });
      return run(args);
    },
  });

  const ws: FakeWorkspace = {
    files,
    writes,
    calls,
    wrongDocId: null,
    hooks,
    fault: (t, fn) => faults.set(t, fn),
    isTrashed,
    addFile: (f) => add(f),
    exportPdf(id) {
      const f = get(id, "doc");
      return { filename: `${f.name}.pdf`, bytes: Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(f.text)]) };
    },
    tools: [],
  };

  ws.tools = [
    // ── Drive ──
    tool("drive_search", READ, obj({ name: str, text: str, type: str, folderId: str, pageSize: num, pageToken: str }), (a) => {
      const found = [...files.values()]
        .filter((f) => !isTrashed(f.id) && (!a.type || a.type === "any" || f.kind === a.type) && (!a.name || f.name.includes(String(a.name))))
        .sort((x, y) => y.modifiedTime.localeCompare(x.modifiedTime))
        .slice(0, Number(a.pageSize ?? 25));
      return ok(found.map((f) => f.name).join("\n"), { files: found.map(summary), nextPageToken: null });
    }),
    tool("drive_list_folder", READ, obj({ folderId: str, type: str, pageSize: num }), (a) => {
      const id = String(a.folderId ?? "root");
      const found = [...files.values()].filter((f) => f.parents.includes(id) && !isTrashed(f.id));
      return ok(found.map((f) => f.name).join("\n"), { files: found.map(summary), nextPageToken: null });
    }),
    tool("drive_get", READ, obj({ fileId: str }, ["fileId"]), (a) => {
      const f = get(a.fileId);
      return ok(`${f.name} [${f.kind}] id ${f.id}`, { ...summary(f), parents: f.parents, trashed: isTrashed(f.id) });
    }),
    tool("drive_export", READ, obj({ fileId: str, format: str, offset: num, maxChars: num, includeBase64: bool }, ["fileId", "format"]), (a) => {
      const f = get(a.fileId);
      const text = f.kind === "doc" ? f.text : f.kind === "sheet" ? f.rows.map((r) => r.join(",")).join("\n") : slideText(f);
      return ok(text, { fileId: f.id, format: a.format, offset: 0, nextOffset: null, totalChars: text.length });
    }),
    tool(
      "drive_create_folder",
      WRITE,
      obj({ name: str, parentId: str }, ["name"]),
      (a) => {
        const f = add({ name: String(a.name), kind: "folder", parents: inFolder(a.parentId) });
        return ok(`Created folder ${f.id}`, { folderId: f.id, name: f.name, webViewLink: `https://drive.example/${f.id}`, parents: f.parents });
      },
      (a) => String(a.parentId ?? "root"),
    ),
    tool(
      "drive_upload",
      WRITE,
      obj({ name: str, folderId: str, mimeType: str, content_base64: str }, ["name", "content_base64"]),
      (a) => {
        const bytes = Buffer.from(String(a.content_base64), "base64");
        const f = add({ name: String(a.name), kind: "image", mimeType: String(a.mimeType ?? "image/png"), parents: inFolder(a.folderId), bytes });
        return ok(`Uploaded ${f.id}`, { fileId: f.id, name: f.name, mimeType: f.mimeType, size: bytes.length, webViewLink: "", parents: f.parents });
      },
      (a) => String(a.folderId ?? "root"),
    ),
    tool(
      "drive_trash",
      RISKY,
      obj({ fileId: str }, ["fileId"]),
      (a) => {
        const f = get(a.fileId);
        f.trashed = true;
        return ok(`Moved "${f.name}" to the Trash.`, { fileId: f.id, name: f.name, type: f.kind, trashed: true });
      },
      (a) => String(a.fileId),
    ),
    // ── Docs ──
    tool("docs_read", READ, obj({ documentId: str, offset: num, maxChars: num }, ["documentId"]), (a) => {
      const f = get(a.documentId, "doc");
      return ok(f.text, { documentId: f.id, name: f.name, offset: 0, nextOffset: null, totalChars: f.text.length });
    }),
    tool(
      "docs_create",
      WRITE,
      obj({ title: str, markdown: str, folderId: str }, ["title"]),
      (a) => {
        const f = add({ name: String(a.title), kind: "doc", text: String(a.markdown ?? ""), parents: inFolder(a.folderId) });
        const id = ws.wrongDocId ?? f.id;
        return ok(`Created ${id}`, { documentId: id, name: f.name, webViewLink: "" });
      },
      (a) => String(a.folderId ?? "root"),
    ),
    tool(
      "docs_append",
      WRITE,
      obj({ documentId: str, markdown: str }, ["documentId", "markdown"]),
      (a) => {
        const f = get(a.documentId, "doc");
        f.text += `\n\n${String(a.markdown)}`;
        return ok("Appended", { documentId: f.id, title: f.name, paragraphs: 1, tables: 0 });
      },
      (a) => String(a.documentId),
    ),
    tool(
      "docs_replace_text",
      WRITE,
      obj({ documentId: str, find: str, replace: str, matchCase: bool }, ["documentId", "find", "replace"]),
      (a) => {
        const f = get(a.documentId, "doc");
        const n = f.text.split(String(a.find)).length - 1;
        f.text = f.text.split(String(a.find)).join(String(a.replace));
        return ok(`Replaced ${n}`, { documentId: f.id, occurrencesChanged: n });
      },
      (a) => String(a.documentId),
    ),
    tool(
      "docs_comment_add",
      WRITE,
      obj({ documentId: str, text: str, replyToCommentId: str }, ["documentId", "text"]),
      (a) => {
        const f = get(a.documentId);
        const c = { id: nextId("cmt"), text: String(a.text) };
        f.comments.push(c);
        return ok(`Added comment ${c.id}.`, { documentId: f.id, commentId: c.id, createdTime: tick() });
      },
      (a) => String(a.documentId),
    ),
    tool("docs_comments_list", READ, obj({ documentId: str, includeResolved: bool }, ["documentId"]), (a) => {
      const f = get(a.documentId);
      return ok(f.comments.map((c) => c.text).join("\n"), { documentId: f.id, comments: f.comments.map((c) => ({ id: c.id, content: c.text })), nextPageToken: null });
    }),
    // ── Sheets ──
    tool(
      "sheets_create",
      WRITE,
      obj({ title: str, tabTitle: str, header: any, freezeHeader: bool, folderId: str }, ["title"]),
      (a) => {
        const f = add({ name: String(a.title), kind: "sheet", parents: inFolder(a.folderId) });
        return ok(`Created ${f.id}`, { spreadsheetId: f.id, url: "", title: f.name, folderId: a.folderId ?? null, firstTab: { title: "Sheet1", tabId: 0 } });
      },
      (a) => String(a.folderId ?? "root"),
    ),
    tool(
      "sheets_write",
      WRITE,
      obj({ spreadsheetId: str, range: str, values: rows, input: str }, ["spreadsheetId", "range", "values"]),
      (a) => {
        const f = get(a.spreadsheetId, "sheet");
        const { r0, c0 } = parseRange(String(a.range));
        const values = a.values as string[][];
        values.forEach((row, i) =>
          row.forEach((v, j) => {
            f.rows[r0 + i] ??= [];
            f.rows[r0 + i]![c0 + j] = String(v);
          }),
        );
        const cells = values.reduce((n, r) => n + r.length, 0);
        return ok(`Wrote ${cells} cells`, { spreadsheetId: f.id, updatedRange: a.range, updatedRows: values.length, updatedColumns: values[0]?.length ?? 0, updatedCells: cells });
      },
      (a) => String(a.spreadsheetId),
    ),
    tool(
      "sheets_append_rows",
      WRITE,
      obj({ spreadsheetId: str, range: str, rows, input: str }, ["spreadsheetId", "range", "rows"]),
      (a) => {
        const f = get(a.spreadsheetId, "sheet");
        const add = (a.rows as string[][]).map((r) => r.map(String));
        f.rows.push(...add);
        return ok(`Appended ${add.length} rows`, { spreadsheetId: f.id, updatedRows: add.length, updatedCells: add.reduce((n, r) => n + r.length, 0) });
      },
      (a) => String(a.spreadsheetId),
    ),
    tool("sheets_read", READ, obj({ spreadsheetId: str, range: str, render: str, maxRows: num, fromRow: num }, ["spreadsheetId", "range"]), (a) => {
      const f = get(a.spreadsheetId, "sheet");
      const { r0, c0, r1, c1 } = parseRange(String(a.range));
      const out = f.rows.slice(r0, r1 + 1).map((r) => r.slice(c0, c1 + 1));
      return ok(out.map((r) => r.join(" | ")).join("\n"), { spreadsheetId: f.id, rows: out, hasMore: false });
    }),
    // ── Slides ──
    tool("slides_read", READ, obj({ presentationId: str, slideIds: any, includeNotes: bool }, ["presentationId"]), (a) => {
      const f = get(a.presentationId, "slides");
      return ok(slideText(f), { presentationId: f.id, title: f.name, slideCount: f.slides.length, slides: f.slides.map((s, i) => ({ position: i + 1, ...s })) });
    }),
    tool(
      "slides_create",
      WRITE,
      obj({ title: str, subtitle: str, slides: { type: "array" }, titleSlide: bool, folderId: str }, ["title", "slides"]),
      (a) => {
        const outline = (a.slides as { title: string; bullets?: string[] }[]).map((s) => ({ slideId: nextId("s"), title: s.title, body: s.bullets ?? [], images: 0 }));
        const f = add({ name: String(a.title), kind: "slides", parents: inFolder(a.folderId), slides: [{ slideId: nextId("s"), title: String(a.title), body: [], images: 0 }, ...outline] });
        return ok(`Created ${f.id}`, { presentationId: f.id, url: "", title: f.name, folderId: a.folderId ?? null, slides: f.slides.map((s, i) => ({ position: i + 1, slideId: s.slideId, title: s.title })) });
      },
      (a) => String(a.folderId ?? "root"),
    ),
    tool(
      "slides_add_slide",
      WRITE,
      obj({ presentationId: str, title: str, bullets: any, notes: str, position: num }, ["presentationId", "title"]),
      (a) => {
        const f = get(a.presentationId, "slides");
        const s = { slideId: nextId("s"), title: String(a.title), body: (a.bullets as string[]) ?? [], images: 0 };
        f.slides.push(s);
        return ok(`Added ${s.slideId}`, { presentationId: f.id, slideId: s.slideId, position: f.slides.length });
      },
      (a) => String(a.presentationId),
    ),
    tool(
      "slides_replace_text",
      WRITE,
      obj({ presentationId: str, find: str, replace: str, matchCase: bool, slideIds: any }, ["presentationId", "find", "replace"]),
      (a) => {
        const f = get(a.presentationId, "slides");
        let n = 0;
        const swap = (t: string) => {
          n += t.split(String(a.find)).length - 1;
          return t.split(String(a.find)).join(String(a.replace));
        };
        for (const s of f.slides) {
          s.title = swap(s.title);
          s.body = s.body.map(swap);
        }
        return ok(`Replaced ${n}`, { presentationId: f.id, occurrencesChanged: n });
      },
      (a) => String(a.presentationId),
    ),
    tool(
      "slides_insert_image",
      WRITE,
      obj({ presentationId: str, slideId: str, imageUrl: str, driveFileId: str, placement: str }, ["presentationId", "slideId"]),
      (a) => {
        const f = get(a.presentationId, "slides");
        const s = f.slides.find((x) => x.slideId === a.slideId);
        if (!s) throw new Error(`No slide ${String(a.slideId)}`);
        if ((a.imageUrl === undefined) === (a.driveFileId === undefined)) throw new Error("Give exactly one of imageUrl and driveFileId.");
        if (a.driveFileId !== undefined) {
          const img = get(a.driveFileId);
          if (!["image/png", "image/jpeg", "image/gif"].includes(img.mimeType)) throw new Error(`"${img.name}" isn't an image`);
          // Slides fetches without credentials: a private Drive image can't be inserted (the extension never shares).
          if (!img.shared) throw new Error(`"${img.name}" isn't shared publicly, so Slides can't fetch it. Share it "anyone with the link" or pass a public https imageUrl.`);
        } else if (!String(a.imageUrl).startsWith("https://")) throw new Error("imageUrl must be https");
        s.images++;
        return ok("Inserted", { presentationId: f.id, slideId: s.slideId, imageId: nextId("img") });
      },
      (a) => String(a.presentationId),
    ),
    tool(
      "slides_delete_slide",
      RISKY,
      obj({ presentationId: str, slideId: str }, ["presentationId", "slideId"]),
      (a) => {
        const f = get(a.presentationId, "slides");
        const i = f.slides.findIndex((s) => s.slideId === a.slideId);
        if (i < 0) throw new Error(`No slide ${String(a.slideId)}`);
        f.slides.splice(i, 1);
        return ok(`Deleted ${String(a.slideId)}`, { presentationId: f.id, deleted: { slideId: a.slideId }, remaining: f.slides.length });
      },
      (a) => String(a.presentationId),
    ),
  ];
  return ws;
}
