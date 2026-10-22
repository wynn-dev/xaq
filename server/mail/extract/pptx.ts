// PPTX → text per slide, in presentation order (presentation.xml's slide list, not file names), with each slide's
// speaker notes. Paragraphs are lines; slide-number and other fields in the notes are left out. Runs in the parser
// child only; the package goes through ZipPackage's caps.

import type { Element } from "@xmldom/xmldom";
import { mainPart } from "./docx.ts";
import { type Extracted, PARSE_LIMITS, UnsafeDocumentError } from "./types.ts";
import { childElements, descendants, firstChild, local, parseXml, relId, relationships, relsPath, textOf } from "./xml.ts";
import { resolvePart, ZipPackage } from "./zip.ts";

/** Text of every a:p in the part, one line each; runs inside a:fld (slide numbers, dates) skipped when `noFields`. */
function paragraphs(root: Element, noFields: boolean): string {
  const lines: string[] = [];
  for (const p of descendants(root, "p")) {
    // DrawingML paragraphs only (p:p doesn't exist; a:p is "p" under the a: namespace).
    if (p.namespaceURI && !p.namespaceURI.includes("drawingml")) continue;
    let line = "";
    for (const c of childElements(p)) {
      const n = local(c);
      if (n === "r") line += textOf(firstChild(c, "t") ?? c);
      else if (n === "br") line += "\n";
      else if (n === "fld" && !noFields) line += textOf(firstChild(c, "t") ?? c);
    }
    line = line.replace(/[ \t]+/g, " ").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

export function extractPptx(input: Buffer): Extracted {
  const pkg = new ZipPackage(input);
  const part = mainPart(pkg, "ppt/presentation.xml");
  const presXml = pkg.text(part);
  if (presXml === null) throw new UnsafeDocumentError("corrupt", "The file isn't a PowerPoint presentation (no ppt/presentation.xml).");
  const rels = relationships(pkg.text(relsPath(part)));
  const pres = parseXml(presXml);
  const ids = [...descendants(firstChild(pres, "sldIdLst") ?? pres, "sldId")];
  const slides: { n: number; text: string; notes: string }[] = [];
  const notes: string[] = [];
  let chars = 0;
  for (const [i, el] of ids.slice(0, PARSE_LIMITS.slides).entries()) {
    const rel = rels.get(relId(el) ?? "");
    const path = rel && !rel.external ? resolvePart(part, rel.target) : null;
    const xml = path ? pkg.text(path) : null;
    if (!path || xml === null) {
      slides.push({ n: i + 1, text: "", notes: "" });
      continue;
    }
    const text = paragraphs(parseXml(xml), false);
    let speaker = "";
    for (const r of relationships(pkg.text(relsPath(path))).values()) {
      if (!r.type.endsWith("/notesSlide") || r.external) continue;
      const notesPath = resolvePart(path, r.target);
      const notesXml = notesPath ? pkg.text(notesPath) : null;
      if (notesXml) speaker = paragraphs(parseXml(notesXml), true);
      break;
    }
    slides.push({ n: i + 1, text, notes: speaker });
    chars += text.length + speaker.length;
    if (chars > PARSE_LIMITS.textChars) {
      notes.push(`Reading stopped at slide ${i + 1}: the presentation has more text than is read.`);
      break;
    }
  }
  if (ids.length > PARSE_LIMITS.slides) notes.push(`Only the first ${PARSE_LIMITS.slides} of ${ids.length} slides were read.`);
  return { format: "pptx", totalSlides: ids.length, slides, notes };
}
