// get_attachment's answer: readable content, never raw bytes by default.
//
// - Text and HTML: cleaned text (the content pool, as for mail bodies).
// - PDF, DOCX, XLSX, CSV, PPTX: parsed in the sandboxed child (server/mail/extract/sandbox.ts), rendered as text
//   with page/slide/sheet headings, and paged: `offset`/`max_chars`, or `page`/`slide`/`sheet` to jump. Small
//   spreadsheets also come as structuredContent rows. Parsed results are kept briefly (by content hash) so paging
//   doesn't parse again.
// - Images: MCP image content up to MAX_ATTACHMENT_BYTES (never decoded or resized here).
// - Anything else, anything too large, and anything the parser couldn't read: metadata plus a saved file path
//   (server/mail/saved-attachments.ts). `format: "file"` saves any attachment; `format: "base64"` returns small
//   files' bytes as an embedded resource, as get_attachment used to.
// All third-party text is wrapped as untrusted.

import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { MAX_ATTACHMENT_BYTES, ToolError } from "../mail/agent.ts";
import type { Address } from "../../shared/types.ts";
import { cleanLine, formatAddress, formatSize, MAX_HTML_CHARS, stripInvisible, truncateText, wrapUntrusted } from "../mail/content.ts";
import { markdownTable } from "../mail/extract/docx.ts";
import { attachmentParser, type ParseFailure } from "../mail/extract/sandbox.ts";
import { type Extracted, PARSE_LIMITS, type ParseFormat, type SheetData } from "../mail/extract/types.ts";
import { contentPool } from "../mail/pool.ts";
import { SaveError, saveAttachment } from "../mail/saved-attachments.ts";

/** Characters one get_attachment answer shows at most, whatever max_chars or maxBodyChars say. */
export const ATTACHMENT_MAX_CHARS = 100_000;
/** Shown when maxBodyChars is 0 (unlimited) and the agent didn't pass max_chars. */
const DEFAULT_CHARS = 20_000;
/** structuredContent carries a sheet's rows only up to this many cells in total. */
const STRUCTURED_MAX_CELLS = 2_000;
const CACHE_ENTRIES = 16;
const CACHE_CHARS = 16_000_000;

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const attachmentArgs = {
  format: z
    .enum(["auto", "file", "base64"])
    .optional()
    .describe(
      `auto (default): readable content (text, tables, pages, slides, images); other files are saved and their path returned. file: save it and return the path. base64: the raw bytes, files up to ${formatSize(MAX_ATTACHMENT_BYTES)} only.`,
    ),
  offset: z.number().int().min(0).optional().describe("Character offset to continue from (each answer says the next one)."),
  max_chars: z.number().int().min(200).max(ATTACHMENT_MAX_CHARS).optional().describe("Characters to show (default: the operator's body limit, at most 100,000)."),
  page: z.number().int().min(1).optional().describe("PDF: start at this page."),
  slide: z.number().int().min(1).optional().describe("PPTX: start at this slide."),
  sheet: z.union([z.string().min(1), z.number().int().min(1)]).optional().describe("XLSX: start at this sheet (name or 1-based number)."),
};
type Args = { format?: "auto" | "file" | "base64"; offset?: number; max_chars?: number; page?: number; slide?: number; sheet?: string | number };

export interface FetchedAttachment {
  messageId: string;
  attachmentId: string;
  from: string | null;
  filename: string;
  mimeType: string;
  data: Buffer;
  maxChars: number;
}

type Kind = "text" | "html" | "image" | ParseFormat | "other";

const FORMAT_NAMES: Record<ParseFormat, string> = { pdf: "PDF", docx: "Word document", xlsx: "spreadsheet", csv: "CSV file", pptx: "presentation" };

const OOXML: Record<string, ParseFormat> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-word.document.macroenabled.12": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12": "pptx",
};
const BY_EXT: Record<string, ParseFormat> = { pdf: "pdf", docx: "docx", docm: "docx", xlsx: "xlsx", xlsm: "xlsx", pptx: "pptx", pptm: "pptx", csv: "csv", tsv: "csv" };

/** What get_attachment does with a file: from its MIME type, then its extension, then its first bytes. */
export function attachmentKind(mimeType: string, filename: string, data: Buffer): Kind {
  const m = mimeType.toLowerCase().split(";")[0]!.trim();
  const ext = /\.([a-z0-9]{1,8})$/i.exec(filename)?.[1]?.toLowerCase() ?? "";
  if (m === "application/pdf") return "pdf";
  if (OOXML[m]) return OOXML[m];
  if (m === "text/csv" || m === "text/tab-separated-values" || m === "application/csv") return "csv";
  if (IMAGE_TYPES.has(m)) return "image";
  const generic = m === "application/octet-stream" || m === "application/zip" || m === "binary/octet-stream" || !m;
  if (generic && BY_EXT[ext]) return BY_EXT[ext];
  if (m === "text/html" || /^html?$/.test(ext)) return "html";
  if (m.startsWith("text/") || /^application\/(json|xml|x-yaml|yaml|javascript|x-ndjson|ld\+json)$/.test(m)) return "text";
  if (generic && /^(txt|md|json|ics|xml|ya?ml|log)$/.test(ext)) return "text";
  if (generic && data.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  return "other";
}

// ───────────── Rendering and paging ─────────────

interface Section {
  n: number;
  label: string;
  start: number;
}

interface Rendered {
  text: string;
  /** Page/slide/sheet starts, in order (empty for DOCX). */
  sections: Section[];
  unit: "page" | "slide" | "sheet" | null;
  total: number;
  notes: string[];
  hiddenChars: number;
  sheets: SheetData[] | null;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, "<br>");

// C0/C1 controls except tab and newline.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point here
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const recleaned = (s: string) => stripInvisible(s.replace(CONTROLS, "")).text;

function render(x: Extracted): Rendered {
  const parts: string[] = [];
  const sections: Section[] = [];
  let at = 0;
  const add = (heading: string | null, body: string, section?: Omit<Section, "start">) => {
    if (parts.length) at += 2;
    if (section) sections.push({ ...section, start: at });
    const block = heading ? `${heading}\n${body}` : body;
    parts.push(block);
    at += block.length;
  };
  let unit: Rendered["unit"] = null;
  let total = 0;
  switch (x.format) {
    case "pdf":
      unit = "page";
      total = x.totalPages;
      for (const p of x.pages) add(`--- Page ${p.n} of ${x.totalPages} ---`, p.text || "(no text on this page)", { n: p.n, label: `page ${p.n}` });
      if (!x.pages.length) add(null, "(The PDF has no pages.)");
      break;
    case "docx":
      add(null, x.markdown || "(The document has no text.)");
      break;
    case "pptx":
      unit = "slide";
      total = x.totalSlides;
      for (const s of x.slides) {
        add(`--- Slide ${s.n} of ${x.totalSlides} ---`, `${s.text || "(no text on this slide)"}${s.notes ? `\n\nSpeaker notes:\n${s.notes}` : ""}`, { n: s.n, label: `slide ${s.n}` });
      }
      if (!x.slides.length) add(null, "(The presentation has no slides.)");
      break;
    default: {
      unit = "sheet";
      total = x.totalSheets;
      x.sheets.forEach((s, i) => {
        const read = s.rows.length < s.totalRows || (s.rows[0]?.length ?? 0) < s.totalCols ? `; ${s.rows.length} × ${s.rows[0]?.length ?? 0} read` : "";
        const title = x.format === "csv" ? "## CSV" : `## Sheet ${i + 1} of ${x.totalSheets}: ${cleanLine(s.name, 100)}`;
        const body = s.rows.length ? markdownTable(s.rows.map((r) => r.map(cell))) : "(empty)";
        add(`${title} (${s.totalRows} rows × ${s.totalCols} columns${read})\n`, body, { n: i + 1, label: x.format === "csv" ? "the CSV" : `sheet ${i + 1}` });
      });
    }
  }
  return {
    text: parts.join("\n\n"),
    sections,
    unit,
    total,
    notes: x.notes,
    hiddenChars: x.hiddenChars ?? 0,
    sheets: x.format === "xlsx" || x.format === "csv" ? x.sheets : null,
  };
}

/** Parsed results by content hash, so paging through a file doesn't parse it again. */
const caches = new WeakMap<AppContext, Map<string, Rendered>>();

function cached(ctx: AppContext, key: string): Rendered | undefined {
  const cache = caches.get(ctx);
  const hit = cache?.get(key);
  if (hit && cache) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function remember(ctx: AppContext, key: string, value: Rendered): void {
  let cache = caches.get(ctx);
  if (!cache) caches.set(ctx, (cache = new Map()));
  cache.set(key, value);
  let chars = 0;
  for (const v of cache.values()) chars += v.text.length;
  while (cache.size > CACHE_ENTRIES || (chars > CACHE_CHARS && cache.size > 1)) {
    const [k, v] = cache.entries().next().value!;
    cache.delete(k);
    chars -= v.text.length;
  }
}

/** The window to show: [start, start + shown) of the text, cut at a line or word boundary when it can be. */
function windowOf(text: string, start: number, max: number): { shown: string; end: number } {
  const t = truncateText(text.slice(start), max);
  return { shown: t.text, end: t.truncated ? start + t.text.length : text.length };
}

// ───────────── The answer ─────────────

type Output = string | CallToolResult["content"] | { content: CallToolResult["content"]; structuredContent: Record<string, unknown> };

export async function attachmentOutput(ctx: AppContext, r: FetchedAttachment, args: Args): Promise<Output> {
  const name = cleanLine(r.filename, 200) || "attachment";
  const type = cleanLine(r.mimeType, 100) || "application/octet-stream";
  const head = `Attachment ${name} (${type}, ${formatSize(r.data.length)}) from message ${cleanLine(r.messageId, 100)}, attachment_id ${cleanLine(r.attachmentId, 100)}`;
  const meta = { filename: name, mimeType: type, size: r.data.length, messageId: r.messageId, attachmentId: r.attachmentId };
  const format = args.format ?? "auto";

  /** Saves the file; the path line, or why it couldn't be saved. */
  const save = async (): Promise<{ path: string | null; line: string }> => {
    try {
      const path = await saveAttachment(ctx, r.messageId, r.filename, r.mimeType, r.data);
      return { path, line: `Saved at: ${path}` };
    } catch (err) {
      return { path: null, line: `It couldn't be saved to a file: ${err instanceof SaveError ? err.message : "unexpected error"}.` };
    }
  };
  const saved = async (lead: string) => {
    const s = await save();
    const text = `${head}\n${lead}${lead ? "\n" : ""}${s.line}`;
    return { content: [{ type: "text" as const, text }], structuredContent: { attachment: { ...meta, savedPath: s.path } } };
  };

  if (format === "file") return saved("");
  if (format === "base64") {
    if (r.data.length > MAX_ATTACHMENT_BYTES) {
      throw new ToolError("too_large", `${name} is ${formatSize(r.data.length)}; format "base64" returns files up to ${formatSize(MAX_ATTACHMENT_BYTES)}. Use format "file" to save it instead.`);
    }
    return [
      { type: "text", text: `${head}. Content is base64-encoded below.` },
      { type: "resource", resource: { uri: `attachment://${encodeURIComponent(r.messageId)}/${encodeURIComponent(r.filename)}`, mimeType: type, blob: r.data.toString("base64") } },
    ];
  }

  const kind = attachmentKind(r.mimeType, r.filename, r.data);
  const limit = Math.min(args.max_chars ?? (r.maxChars || DEFAULT_CHARS), r.maxChars || ATTACHMENT_MAX_CHARS, ATTACHMENT_MAX_CHARS);
  const selectors = (["page", "slide", "sheet"] as const).filter((k) => args[k] !== undefined);
  if (selectors.length > 1 || (selectors.length && args.offset !== undefined)) {
    throw new ToolError("invalid_arguments", "Pass at most one of offset, page, slide or sheet.");
  }

  if (kind === "image") {
    if (r.data.length > MAX_ATTACHMENT_BYTES) return saved(`The image is over ${formatSize(MAX_ATTACHMENT_BYTES)}, so it isn't shown inline.`);
    return [
      { type: "text", text: head },
      { type: "image", data: r.data.toString("base64"), mimeType: r.mimeType.toLowerCase() },
    ];
  }

  if (kind === "text" || kind === "html") {
    if (selectors.length) throw new ToolError("invalid_arguments", `${selectors[0]} applies to PDFs, presentations and spreadsheets; use offset for this file.`);
    // Bounded input: text beyond MAX_HTML_CHARS is never read (the agent sees a note).
    const clipped = r.data.length > MAX_HTML_CHARS;
    const raw = r.data.subarray(0, MAX_HTML_CHARS).toString("utf8");
    const cleaned = kind === "html" ? (await contentPool(ctx).html(raw)).markdown : await contentPool(ctx).text(raw);
    const start = Math.min(args.offset ?? 0, cleaned.length);
    const w = windowOf(cleaned, start, limit);
    const more = w.end < cleaned.length;
    const notes: string[] = [];
    if (start > 0 || more) notes.push(`[Showing characters ${(start + 1).toLocaleString("en-US")}–${w.end.toLocaleString("en-US")} of ${cleaned.length.toLocaleString("en-US")}.${more ? ` Next part: call get_attachment again with offset=${w.end}.` : " That's the end."}]`);
    if (clipped) notes.push(`[Only the first ${formatSize(MAX_HTML_CHARS)} of this ${formatSize(r.data.length)} file are read; use format "file" to save the whole file.]`);
    return `${head}\n${wrapUntrusted(r.from, w.shown)}${notes.length ? `\n${notes.join("\n")}` : ""}`;
  }

  if (kind === "other") return saved("This file type isn't shown as text; the file was saved so you can open it with another tool.");

  // A document: parsed in the sandbox (or from the cache).
  const formatName = FORMAT_NAMES[kind];
  if (r.data.length > PARSE_LIMITS.inputBytes) return saved(`This ${formatName} is over ${formatSize(PARSE_LIMITS.inputBytes)}, too large to read here.`);
  const key = `${kind}:${createHash("sha256").update(r.data).digest("base64url")}`;
  let doc = cached(ctx, key);
  if (!doc) {
    const outcome = await attachmentParser(ctx).parse(r.data, { format: kind });
    if (!outcome.ok) return saved(`Couldn't read this ${formatName}: ${failureText(outcome.reason, outcome.message)}`);
    doc = render(outcome.result);
    remember(ctx, key, doc);
  }

  const wrongSelector = selectors.find((k) => (k === "page" && doc.unit !== "page") || (k === "slide" && doc.unit !== "slide") || (k === "sheet" && doc.unit !== "sheet"));
  if (wrongSelector) {
    const right = doc.unit ? `${doc.unit} or offset` : "offset";
    throw new ToolError("invalid_arguments", `${wrongSelector} doesn't apply to a ${formatName}; use ${right}.`);
  }
  let start = Math.min(args.offset ?? 0, doc.text.length);
  if (args.page !== undefined || args.slide !== undefined) {
    const n = (args.page ?? args.slide)!;
    const s = doc.sections.find((x) => x.n === n);
    if (!s) throw new ToolError("invalid_arguments", `This ${formatName} has ${doc.sections.length} ${doc.unit}${doc.sections.length === 1 ? "" : "s"} that could be read${doc.total > doc.sections.length ? ` (of ${doc.total})` : ""}; ${doc.unit} ${n} isn't one of them.`);
    start = s.start;
  }
  if (args.sheet !== undefined) {
    const want = args.sheet;
    const idx = typeof want === "number" ? want - 1 : (doc.sheets ?? []).findIndex((s) => s.name.toLowerCase() === want.toLowerCase() || s.name.toLowerCase() === `${want.toLowerCase()} (hidden)`);
    const s = idx >= 0 ? doc.sections[idx] : undefined;
    if (!s) {
      const names = (doc.sheets ?? []).map((x, i) => `${i + 1}: ${cleanLine(x.name, 60)}`).join(", ");
      throw new ToolError("invalid_arguments", `No sheet ${typeof want === "number" ? want : `"${cleanLine(want, 60)}"`} in this ${formatName}. Its sheets: ${names || "none"}.`);
    }
    start = s.start;
  }
  const w = windowOf(doc.text, start, limit);
  const more = w.end < doc.text.length;
  const covered = doc.sections.filter((s, i) => s.start < w.end && (doc.sections[i + 1]?.start ?? Infinity) > start);
  const range = covered.length ? (covered.length === 1 ? covered[0]!.label : `${doc.unit}s ${covered[0]!.n}–${covered.at(-1)!.n}`) : null;
  const next = doc.sections.find((s) => s.start >= w.end);
  const lines: string[] = [];
  const what = range && doc.unit ? `${range} of ${doc.total}` : null;
  if (start === 0 && !more) {
    lines.push(`[The whole ${formatName}${what && doc.unit !== "sheet" ? ` (${doc.total} ${doc.unit}${doc.total === 1 ? "" : "s"})` : ""}.]`);
  } else {
    const nextHint = more ? ` Next part: call get_attachment again with offset=${w.end}${next && doc.unit ? ` (or ${doc.unit}=${next.n} to start at the next ${doc.unit})` : ""}.` : " That's the end.";
    lines.push(`[Showing characters ${(start + 1).toLocaleString("en-US")}–${w.end.toLocaleString("en-US")} of ${doc.text.length.toLocaleString("en-US")}${what ? ` (${what})` : ""}.${nextHint}]`);
  }
  // Notes are ours (caps reached), but sit outside the untrusted wrapper: cleaned like any line anyway.
  for (const n of doc.notes) lines.push(`[${cleanLine(n, 300)}]`);
  if (doc.hiddenChars) lines.push(`[${doc.hiddenChars} invisible character${doc.hiddenChars === 1 ? " was" : "s were"} removed from the text.]`);
  if (doc.notes.length) lines.push('[Use format "file" to save the whole file.]');

  // The child already cleaned the text; cleaning what's shown again means a subverted child can't skip it.
  const text = `${head}\n${wrapUntrusted(r.from, recleaned(w.shown))}\n${lines.join("\n")}`;
  const structured = structuredSheets(doc);
  if (!structured) return text;
  return { content: [{ type: "text", text }], structuredContent: { attachment: meta, untrusted: true, sheets: structured } };
}

// ───────────── list_attachments ─────────────

export function formatAttachmentList(r: {
  account: { email: string };
  threadId: string | null;
  messageId: string | null;
  messageCount: number;
  attachments: { messageId: string; id: string; filename: string; mimeType: string; size: number; from: Address | null; date: string }[];
}): Output {
  const where = r.threadId ? `thread ${cleanLine(r.threadId, 100)}` : `message ${cleanLine(r.messageId ?? "", 100)}`;
  const items = r.attachments.map((a) => ({
    messageId: a.messageId,
    attachmentId: a.id,
    filename: cleanLine(a.filename, 200) || "(unnamed)",
    mimeType: cleanLine(a.mimeType, 100),
    size: a.size,
  }));
  if (!items.length) {
    const text = `No attachments in ${where} (${r.account.email}${r.threadId ? `, ${r.messageCount} message${r.messageCount === 1 ? "" : "s"}` : ""}).`;
    return { content: [{ type: "text", text }], structuredContent: { attachments: [] } };
  }
  const messages = new Set(items.map((x) => x.messageId)).size;
  const lines = [
    `${items.length} attachment${items.length === 1 ? "" : "s"} in ${where} (${r.account.email}${r.threadId ? `; in ${messages} of ${r.messageCount} message${r.messageCount === 1 ? "" : "s"}` : ""}). File names are third-party text.`,
  ];
  for (const [i, x] of items.entries()) {
    const from = r.attachments[i]!.from;
    lines.push(
      `- ${x.filename} (${x.mimeType}, ${formatSize(x.size)}) · message_id: ${cleanLine(x.messageId, 100)} · attachment_id: ${cleanLine(x.attachmentId, 100)}${from ? ` · from ${formatAddress(from)}` : ""} · ${cleanLine(r.attachments[i]!.date, 40)}`,
    );
  }
  lines.push("Read one with get_attachment (message_id and attachment_id).");
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { attachments: items } };
}

/** Small spreadsheets' rows as data (cells cleaned like the text). Null when they're over STRUCTURED_MAX_CELLS. */
function structuredSheets(doc: Rendered): { name: string; rows: string[][] }[] | null {
  if (!doc.sheets) return null;
  const cells = doc.sheets.reduce((n, s) => n + s.rows.length * (s.rows[0]?.length ?? 0), 0);
  if (cells > STRUCTURED_MAX_CELLS || doc.sheets.some((s) => s.rows.length < s.totalRows)) return null;
  return doc.sheets.map((s) => ({ name: cleanLine(s.name, 100), rows: s.rows.map((row) => row.map(recleaned)) }));
}

function failureText(reason: ParseFailure, message: string): string {
  switch (reason) {
    case "timeout":
      return "reading it took too long.";
    case "crashed":
      return "the parser stopped while reading it (the file may be damaged or hostile).";
    case "busy":
      return "too many attachments are being read right now; try again in a moment.";
    case "unavailable":
      return "the document parser isn't available on this server.";
    default:
      return `${cleanLine(message, 300).replace(/\.?$/, ".")}`;
  }
}
