// What the attachment parser child (server/mail/extract/child.ts) is asked and what it answers. The child extracts
// everything up to the caps below once; the daemon pages over the result (server/mail/attachment-read.ts).

/** Document formats the child parses. Text, HTML and images never reach it. */
export type ParseFormat = "pdf" | "docx" | "xlsx" | "pptx" | "csv";

/**
 * Caps on what one attachment may cost the child. Each is checked while parsing (not after), so a hostile file stops
 * at the cap instead of growing past it. The daemon's sandbox adds the process limits (heap, wall clock, output).
 */
export const PARSE_LIMITS = {
  /** Input bytes the daemon hands to the child at all; larger files are only saved. */
  inputBytes: 25 * 1024 * 1024,
  /** Characters of text extracted per attachment (all pages, sheets or slides together). */
  textChars: 2_000_000,
  /** PDF pages read; later pages are reported as not read. */
  pdfPages: 500,
  /** Zip entries in a DOCX/XLSX/PPTX package (the central directory is refused above this). */
  zipEntries: 2_000,
  /** Decompressed bytes of one zip entry we read. */
  zipEntryBytes: 32 * 1024 * 1024,
  /** Decompressed bytes of all entries we read, together. */
  zipTotalBytes: 64 * 1024 * 1024,
  /** Compression ratio past which an entry is treated as a zip bomb (only checked above 1 MB). */
  zipRatio: 200,
  /** XLSX sheets / PPTX slides read. */
  sheets: 50,
  slides: 1_000,
  /** Rows and columns kept per sheet (XLSX and CSV). */
  rows: 10_000,
  cols: 200,
  /** Characters kept per cell. */
  cellChars: 2_000,
} as const;

export interface ParseTask {
  format: ParseFormat;
}

export interface SheetData {
  name: string;
  /** Rows as read (at most PARSE_LIMITS.rows × cols), cells as display strings. */
  rows: string[][];
  /** Rows and columns in the sheet before the caps. */
  totalRows: number;
  totalCols: number;
}

/** `notes`: what wasn't read (caps). `hiddenChars`: invisible/smuggling characters removed (set by the child). */
export type Extracted = (
  | { format: "pdf"; totalPages: number; pages: { n: number; text: string }[] }
  | { format: "docx"; markdown: string }
  | { format: "xlsx" | "csv"; sheets: SheetData[]; totalSheets: number }
  | { format: "pptx"; totalSlides: number; slides: { n: number; text: string; notes: string }[] }
) & { notes: string[]; hiddenChars?: number };

/** The child's single line of stdout. */
export type ParseReply = { ok: true; result: Extracted } | { ok: false; error: string };

/** A file the parser refuses to read (zip bomb, XXE, entry outside the archive, …): said in plain words. */
export class UnsafeDocumentError extends Error {}
