// CSV/TSV → one sheet of rows (RFC 4180 quoting: quoted fields may hold the delimiter, newlines and "" for a quote).
// The delimiter is guessed from the first line (comma, semicolon, tab or pipe). Rows, columns and cell length are
// capped while reading; the scan itself is a single linear pass. Runs in the parser child.

import { type Extracted, PARSE_LIMITS } from "./types.ts";

function guessDelimiter(text: string): string {
  const first = text.slice(0, 4096).split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let max = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const n = first.split(d).length - 1;
    if (n > max) {
      max = n;
      best = d;
    }
  }
  return best;
}

export function extractCsv(input: Buffer): Extracted {
  let text = input.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = guessDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let totalRows = 0;
  let totalCols = 0;
  let chars = 0;
  let cols = 0;
  const endCell = () => {
    cols++;
    if (row.length < PARSE_LIMITS.cols) row.push(cell.length > PARSE_LIMITS.cellChars ? `${cell.slice(0, PARSE_LIMITS.cellChars - 1)}…` : cell);
    chars += Math.min(cell.length, PARSE_LIMITS.cellChars) + 1;
    cell = "";
  };
  const endRow = () => {
    endCell();
    totalCols = Math.max(totalCols, cols);
    cols = 0;
    totalRows++;
    if (rows.length < PARSE_LIMITS.rows && chars <= PARSE_LIMITS.textChars) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          if (cell.length <= PARSE_LIMITS.cellChars) cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else if (cell.length <= PARSE_LIMITS.cellChars) {
        cell += c;
      }
    } else if (c === '"' && cell === "") {
      quoted = true;
    } else if (c === d) {
      endCell();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else if (cell.length <= PARSE_LIMITS.cellChars) {
      cell += c;
    }
  }
  if (cell !== "" || row.length) endRow();
  const width = Math.max(0, ...rows.map((r) => r.length));
  const padded = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
  const notes = totalRows > rows.length ? [`Only the first ${rows.length.toLocaleString("en-US")} of ${totalRows.toLocaleString("en-US")} rows were read.`] : [];
  return { format: "csv", sheets: [{ name: "CSV", rows: padded, totalRows, totalCols }], totalSheets: 1, notes };
}
