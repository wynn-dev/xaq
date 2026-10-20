// XLSX → sheets of display strings: shared and inline strings, numbers, booleans, errors, and dates (cells whose
// number format is a date format, built-in or custom, 1900 or 1904 based). Formulas show their cached value.
// Hidden sheets are kept and marked. Runs in the parser child only; the package goes through ZipPackage's caps.

import type { Element } from "@xmldom/xmldom";
import { mainPart } from "./docx.ts";
import { type Extracted, PARSE_LIMITS, type SheetData, UnsafeDocumentError } from "./types.ts";
import { attr, childElements, descendants, firstChild, local, parseXml, relId, relationships, relsPath, textOf } from "./xml.ts";
import { resolvePart, ZipPackage } from "./zip.ts";

/** Built-in number formats that are dates or times (ECMA-376 18.8.30). */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function isDateCode(code: string): boolean {
  // Drop quoted text, escapes and [colour]/[$-locale] blocks (but [h]/[mm]/[ss] elapsed time counts as a time).
  const s = code.replace(/"[^"]*"|\\.|_.|\*./g, "").replace(/\[(?![hms]+\])[^\]]*\]/gi, "");
  return /[dmyhs]/i.test(s) && !/^general$/i.test(s.trim());
}

/** Column letters → 0-based index ("A" → 0, "AB" → 27); null when not a cell reference. */
function colIndex(ref: string): number | null {
  const m = /^([A-Z]{1,3})\d+$/i.exec(ref);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]!.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function serialToIso(serial: number, date1904: boolean): string {
  // Excel's 1900 system counts the nonexistent 1900-02-29; serials from 61 on are one day ahead.
  const days = date1904 ? serial + 1462 : serial < 61 ? serial + 1 : serial;
  const ms = Math.round((days - 25569) * 86_400_000);
  const d = new Date(ms);
  if (!Number.isFinite(ms) || Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

const clip = (s: string) => (s.length > PARSE_LIMITS.cellChars ? `${s.slice(0, PARSE_LIMITS.cellChars - 1)}…` : s);

export function extractXlsx(input: Buffer): Extracted {
  const pkg = new ZipPackage(input);
  const part = mainPart(pkg, "xl/workbook.xml");
  const wbXml = pkg.text(part);
  if (wbXml === null) throw new UnsafeDocumentError("The file isn't an Excel workbook (no xl/workbook.xml).");
  const wb = parseXml(wbXml);
  const rels = relationships(pkg.text(relsPath(part)));
  const relOf = (suffix: string) => {
    for (const r of rels.values()) if (r.type.endsWith(suffix) && !r.external) return resolvePart(part, r.target);
    return null;
  };
  const date1904 = /^(1|true)$/i.test(attr(firstChild(wb, "workbookPr") ?? wb, "date1904") ?? "");

  let chars = 0;
  const strings: string[] = [];
  const sst = pkg.text(relOf("/sharedStrings") ?? "xl/sharedStrings.xml");
  if (sst) {
    for (const si of childElements(parseXml(sst), "si")) {
      // Phonetic runs (rPh) are reading aids, not content.
      let s = "";
      for (const t of descendants(si, "t")) if (local(t.parentNode!) !== "rPh") s += textOf(t);
      strings.push(clip(s));
    }
  }

  const dateStyles = new Set<number>();
  const stylesXml = pkg.text(relOf("/styles") ?? "xl/styles.xml");
  if (stylesXml) {
    const root = parseXml(stylesXml);
    const custom = new Map<number, string>();
    for (const f of descendants(root, "numFmt")) custom.set(Number(attr(f, "numFmtId")), attr(f, "formatCode") ?? "");
    const xfs = firstChild(root, "cellXfs");
    let i = 0;
    for (const xf of xfs ? childElements(xfs, "xf") : []) {
      const id = Number(attr(xf, "numFmtId") ?? 0);
      if (DATE_FORMATS.has(id) || (custom.has(id) && isDateCode(custom.get(id)!))) dateStyles.add(i);
      i++;
    }
  }

  const sheetEls = [...descendants(firstChild(wb, "sheets") ?? wb, "sheet")];
  const sheets: SheetData[] = [];
  const notes: string[] = [];
  for (const s of sheetEls.slice(0, PARSE_LIMITS.sheets)) {
    const hidden = /hidden/i.test(attr(s, "state") ?? "");
    const name = `${attr(s, "name") ?? `Sheet${sheets.length + 1}`}${hidden ? " (hidden)" : ""}`;
    const rel = rels.get(relId(s) ?? "");
    const path = rel && !rel.external ? resolvePart(part, rel.target) : null;
    const xml = path ? pkg.text(path) : null;
    if (xml === null) {
      sheets.push({ name, rows: [], totalRows: 0, totalCols: 0 });
      continue;
    }
    const sheet = readSheet(parseXml(xml), strings, dateStyles, date1904, PARSE_LIMITS.textChars - chars);
    chars += sheet.chars;
    sheets.push({ name, rows: sheet.rows, totalRows: sheet.totalRows, totalCols: sheet.totalCols });
    if (chars >= PARSE_LIMITS.textChars) {
      notes.push(`Reading stopped at sheet ${sheets.length}: the workbook has more text than is read.`);
      break;
    }
  }
  if (sheetEls.length > PARSE_LIMITS.sheets) notes.push(`Only the first ${PARSE_LIMITS.sheets} of ${sheetEls.length} sheets were read.`);
  return { format: "xlsx", sheets, totalSheets: sheetEls.length, notes };
}

function readSheet(root: Element, strings: string[], dateStyles: Set<number>, date1904: boolean, budget: number) {
  const rows: string[][] = [];
  let totalRows = 0;
  let totalCols = 0;
  let chars = 0;
  const data = firstChild(root, "sheetData");
  let next = 0;
  for (const row of data ? childElements(data, "row") : []) {
    const r = Number(attr(row, "r") ?? next + 1) - 1;
    next = r + 1;
    if (!Number.isInteger(r) || r < 0 || r > 1_048_575) continue;
    totalRows = Math.max(totalRows, r + 1);
    const cells: string[] = [];
    let col = 0;
    for (const c of childElements(row, "c")) {
      const ci = colIndex(attr(c, "r") ?? "") ?? col;
      col = ci + 1;
      totalCols = Math.max(totalCols, ci + 1);
      if (ci >= PARSE_LIMITS.cols || r >= PARSE_LIMITS.rows || chars > budget) continue;
      const t = attr(c, "t") ?? "n";
      const v = firstChild(c, "v");
      const raw = v ? textOf(v) : "";
      let value: string;
      if (t === "s") value = strings[Number(raw)] ?? "";
      else if (t === "inlineStr") value = clip([...descendants(c, "t")].map(textOf).join(""));
      else if (t === "b") value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
      else if (t === "n" && raw !== "" && dateStyles.has(Number(attr(c, "s") ?? -1)) && Number.isFinite(Number(raw))) value = serialToIso(Number(raw), date1904);
      else value = clip(raw);
      cells[ci] = value;
      chars += value.length + 1;
    }
    if (r < PARSE_LIMITS.rows && chars <= budget) rows[r] = Array.from(cells, (x) => x ?? "");
  }
  // Fill gaps, drop trailing empty rows and columns.
  const filled = Array.from(rows, (x) => x ?? []);
  while (filled.length && filled.at(-1)!.every((x) => !x)) filled.pop();
  const width = Math.max(0, ...filled.map((r) => r.findLastIndex((x) => !!x) + 1));
  return { rows: filled.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? "")), totalRows, totalCols, chars };
}
