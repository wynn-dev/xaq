// The attachment parser's code, run only inside the sandboxed child (server/mail/extract/sandbox.ts). Built as one
// self-contained file (dist/attachment-parser.js, every dependency bundled in, no imports but node: builtins): the
// child has no file-system access at all, so the daemon reads this file and sends it on stdin, and the child's
// bootstrap imports it from a data: URL. It exports run(); it never touches stdin/stdout itself.

import { stripInvisible } from "../invisible.ts";
import { extractCsv } from "./csv.ts";
import { extractDocx } from "./docx.ts";
import { extractPdf } from "./pdf.ts";
import { extractPptx } from "./pptx.ts";
import { type Extracted, PARSE_LIMITS, type ParseReply, type ParseTask, UnsafeDocumentError } from "./types.ts";
import { extractXlsx } from "./xlsx.ts";

// C0/C1 controls except tab and newline (and CR, normalized below): never meaningful in extracted text.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point here
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** The same cleaning as mail content: invisible/smuggling unicode (counted) and control characters. */
function cleanAll(r: Extracted): Extracted {
  let removed = 0;
  const clean = (s: string) => {
    const x = stripInvisible(s.replace(/\r\n?/g, "\n").replace(CONTROLS, ""));
    removed += x.removed;
    return x.text;
  };
  const out = cleanParts(r, clean);
  return { ...out, hiddenChars: removed };
}

function cleanParts(r: Extracted, clean: (s: string) => string): Extracted {
  switch (r.format) {
    case "pdf":
      return { ...r, pages: r.pages.map((p) => ({ ...p, text: clean(p.text) })) };
    case "docx":
      return { ...r, markdown: clean(r.markdown) };
    case "pptx":
      return { ...r, slides: r.slides.map((s) => ({ ...s, text: clean(s.text), notes: clean(s.notes) })) };
    default:
      return { ...r, sheets: r.sheets.map((s) => ({ ...s, name: clean(s.name), rows: s.rows.map((row) => row.map(clean)) })) };
  }
}

export async function run(input: Buffer, task: ParseTask): Promise<ParseReply> {
  if (input.length > PARSE_LIMITS.inputBytes) return { ok: false, code: "too_complex", error: "The file is too large to read." };
  try {
    let result: Extracted;
    switch (task.format) {
      case "pdf":
        result = await extractPdf(new Uint8Array(input.buffer, input.byteOffset, input.length));
        break;
      case "docx":
        result = extractDocx(input);
        break;
      case "xlsx":
        result = extractXlsx(input);
        break;
      case "pptx":
        result = extractPptx(input);
        break;
      case "csv":
        result = extractCsv(input);
        break;
      default:
        return { ok: false, code: "parser_error", error: "Unknown format." };
    }
    return { ok: true, result: cleanAll(result) };
  } catch (err) {
    if (err instanceof UnsafeDocumentError) return { ok: false, code: err.code, error: err.message };
    return { ok: false, code: "parser_error", error: "The file couldn't be parsed." };
  }
}
