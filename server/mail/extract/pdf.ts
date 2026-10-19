// PDF → text per page, with PDF.js (unpdf's serverless build: no worker file, no canvas, no native code). Runs in
// the parser child only. Nothing is fetched: no standard fonts, CMaps, ICC profiles or wasm decoders (text
// extraction doesn't need them); eval-based font compilation no longer exists in this PDF.js line.

import { getDocument } from "unpdf/pdfjs";
import { type Extracted, PARSE_LIMITS, UnsafeDocumentError } from "./types.ts";

type TextItem = { str?: string; hasEOL?: boolean };

export async function extractPdf(input: Uint8Array): Promise<Extracted> {
  const task = getDocument({
    data: input,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "PasswordException") throw new UnsafeDocumentError("The PDF is password-protected.");
    throw new UnsafeDocumentError("The file isn't a readable PDF.");
  }
  const totalPages = doc.numPages;
  const pages: { n: number; text: string }[] = [];
  const notes: string[] = [];
  let chars = 0;
  const last = Math.min(totalPages, PARSE_LIMITS.pdfPages);
  for (let n = 1; n <= last; n++) {
    let text = "";
    try {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      for (const item of content.items as TextItem[]) {
        text += item.str ?? "";
        if (item.hasEOL) text += "\n";
        if (chars + text.length > PARSE_LIMITS.textChars) break;
      }
      page.cleanup();
    } catch {
      text = "[This page couldn't be read.]";
    }
    text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    chars += text.length;
    pages.push({ n, text });
    if (chars > PARSE_LIMITS.textChars) {
      notes.push(`Text extraction stopped at page ${n}: the PDF has more text than is read (${PARSE_LIMITS.textChars.toLocaleString("en-US")} characters).`);
      break;
    }
  }
  if (totalPages > last && pages.length === last) notes.push(`Only the first ${last} of ${totalPages} pages were read.`);
  await task.destroy().catch(() => undefined);
  return { format: "pdf", totalPages, pages, notes };
}
