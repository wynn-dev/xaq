// DOCX → markdown: headings (from the paragraph style's name, so localized style ids work), bullet and numbered
// lists (from numbering.xml, nested by level), tables, external hyperlinks, bold and italic. Images become
// "[image: alt text]". Runs in the parser child only; the package goes through ZipPackage's caps.

import type { Element } from "@xmldom/xmldom";
import { type Extracted, PARSE_LIMITS, UnsafeDocumentError } from "./types.ts";
import { attr, childElements, descendants, firstChild, local, parseXml, relId, relationships, relsPath } from "./xml.ts";
import { resolvePart, ZipPackage } from "./zip.ts";

const OFFICE_DOC = /\/officeDocument$/;

/** The main part of an OOXML package (from _rels/.rels), else `fallback`. */
export function mainPart(pkg: ZipPackage, fallback: string): string {
  for (const r of relationships(pkg.text("_rels/.rels")).values()) {
    if (OFFICE_DOC.test(r.type) && !r.external) {
      const p = resolvePart("", r.target);
      if (p && pkg.has(p)) return p;
    }
  }
  return fallback;
}

const on = (el: Element | null) => {
  if (!el) return false;
  const v = attr(el, "val");
  return v === null || !/^(0|false|off|none)$/i.test(v);
};

interface Seg {
  text: string;
  b: boolean;
  i: boolean;
  href: string | null;
}

export function extractDocx(input: Buffer): Extracted {
  const pkg = new ZipPackage(input);
  const part = mainPart(pkg, "word/document.xml");
  const xml = pkg.text(part);
  if (xml === null) throw new UnsafeDocumentError("corrupt", "The file isn't a Word document (no word/document.xml).");
  const rels = relationships(pkg.text(relsPath(part)));
  const byType = (suffix: string) => {
    for (const r of rels.values()) if (r.type.endsWith(suffix) && !r.external) return resolvePart(part, r.target);
    return null;
  };

  // Paragraph style id → heading level (from the style's name: "heading 1", "Title").
  const headings = new Map<string, number>();
  const stylesXml = pkg.text(byType("/styles") ?? "word/styles.xml");
  if (stylesXml) {
    for (const s of childElements(parseXml(stylesXml), "style")) {
      const id = attr(s, "styleId");
      const name = (attr(firstChild(s, "name") ?? s, "val") ?? "").toLowerCase();
      const m = /^heading\s*([1-6])$/.exec(name);
      if (id && m) headings.set(id, Number(m[1]));
      else if (id && name === "title") headings.set(id, 1);
      else if (id && name === "subtitle") headings.set(id, 2);
    }
  }

  // numId → ilvl → ordered?
  const ordered = new Map<string, Map<string, boolean>>();
  const numberingXml = pkg.text(byType("/numbering") ?? "word/numbering.xml");
  if (numberingXml) {
    const root = parseXml(numberingXml);
    const abstract = new Map<string, Map<string, boolean>>();
    for (const a of childElements(root, "abstractNum")) {
      const levels = new Map<string, boolean>();
      for (const l of childElements(a, "lvl")) {
        const fmt = attr(firstChild(l, "numFmt") ?? l, "val") ?? "bullet";
        levels.set(attr(l, "ilvl") ?? "0", fmt !== "bullet" && fmt !== "none");
      }
      abstract.set(attr(a, "abstractNumId") ?? "", levels);
    }
    for (const n of childElements(root, "num")) {
      const a = attr(firstChild(n, "abstractNumId") ?? n, "val") ?? "";
      ordered.set(attr(n, "numId") ?? "", abstract.get(a) ?? new Map());
    }
  }

  const out: string[] = [];
  let chars = 0;
  let full = false;
  const push = (block: string) => {
    if (full) return;
    out.push(block);
    chars += block.length + 2;
    if (chars > PARSE_LIMITS.textChars) full = true;
  };
  const counters = new Map<string, number[]>();

  const segments = (p: Element): Seg[] => {
    const segs: Seg[] = [];
    const walk = (el: Element, href: string | null) => {
      for (const c of childElements(el)) {
        const name = local(c);
        if (name === "r") {
          const rPr = firstChild(c, "rPr");
          const b = on(rPr && firstChild(rPr, "b"));
          const i = on(rPr && firstChild(rPr, "i"));
          for (const x of childElements(c)) {
            const n = local(x);
            if (n === "t") segs.push({ text: x.textContent ?? "", b, i, href });
            else if (n === "tab") segs.push({ text: "\t", b: false, i: false, href });
            else if (n === "br" || n === "cr") segs.push({ text: "\n", b: false, i: false, href });
            else if (n === "drawing" || n === "pict") {
              const alt = [...descendants(x, "docPr")].map((d) => attr(d, "descr") || attr(d, "title")).find(Boolean);
              segs.push({ text: alt ? `[image: ${alt.replace(/\s+/g, " ").trim()}]` : "[image]", b: false, i: false, href: null });
            }
          }
        } else if (name === "hyperlink") {
          const id = relId(c);
          const r = id ? rels.get(id) : undefined;
          const url = r?.external && /^(https?|mailto):/i.test(r.target) ? r.target : null;
          walk(c, url ?? href);
        } else if (name === "ins" || name === "smartTag" || name === "fldSimple" || name === "customXml" || name === "sdtContent" || name === "sdt") {
          walk(c, href);
        }
      }
    };
    walk(p, null);
    return segs;
  };

  const render = (segs: Seg[]): string => {
    // Merge neighbours with the same formatting, then mark them up with the spaces kept outside the markers.
    const merged: Seg[] = [];
    for (const s of segs) {
      const prev = merged.at(-1);
      if (prev && prev.b === s.b && prev.i === s.i && prev.href === s.href) prev.text += s.text;
      else merged.push({ ...s });
    }
    return merged
      .map((s) => {
        if (!s.text) return "";
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text)!;
        let core = m[2]!;
        if (!core) return s.text;
        if (s.b && s.i) core = `***${core}***`;
        else if (s.b) core = `**${core}**`;
        else if (s.i) core = `*${core}*`;
        if (s.href) core = `[${core.replace(/[[\]]/g, "\\$&")}](${s.href.replace(/[()\s]/g, encodeURIComponent)})`;
        return m[1] + core + m[3];
      })
      .join("");
  };

  const paragraph = (p: Element) => {
    const pPr = firstChild(p, "pPr");
    const text = render(segments(p)).replace(/[ \t]+\n/g, "\n").trim();
    const style = pPr ? attr(firstChild(pPr, "pStyle") ?? pPr, "val") : null;
    const numPr = pPr ? firstChild(pPr, "numPr") : null;
    const level = style ? headings.get(style) : undefined;
    if (!text) return;
    if (level) return push(`${"#".repeat(level)} ${text.replace(/\n+/g, " ")}`);
    if (numPr) {
      const numId = attr(firstChild(numPr, "numId") ?? numPr, "val") ?? "";
      const ilvl = Math.min(8, Number(attr(firstChild(numPr, "ilvl") ?? numPr, "val") ?? 0) || 0);
      if (numId !== "0") {
        const isOrdered = ordered.get(numId)?.get(String(ilvl)) ?? false;
        const c = counters.get(numId) ?? [];
        c[ilvl] = (c[ilvl] ?? 0) + 1;
        c.length = ilvl + 1;
        counters.set(numId, c);
        const marker = isOrdered ? `${c[ilvl]}.` : "-";
        return push(`${"  ".repeat(ilvl)}${marker} ${text.replace(/\n/g, `\n${"  ".repeat(ilvl + 1)}`)}`);
      }
    }
    push(text);
  };

  const cellText = (tc: Element) =>
    [...descendants(tc, "p")]
      .map((p) => render(segments(p)).trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/\|/g, "\\|")
      .slice(0, PARSE_LIMITS.cellChars);

  const table = (tbl: Element) => {
    const rows: string[][] = [];
    for (const tr of childElements(tbl, "tr")) {
      const row: string[] = [];
      for (const tc of childElements(tr, "tc")) {
        row.push(cellText(tc));
        const tcPr = firstChild(tc, "tcPr");
        const span = Math.min(50, Number(attr(firstChild(tcPr ?? tc, "gridSpan") ?? tc, "val") ?? 1) || 1);
        for (let i = 1; i < span; i++) row.push("");
      }
      if (row.length) rows.push(row.slice(0, PARSE_LIMITS.cols));
      if (rows.length >= PARSE_LIMITS.rows) break;
    }
    if (rows.length) push(markdownTable(rows));
  };

  const block = (el: Element) => {
    for (const c of childElements(el)) {
      if (full) return;
      const name = local(c);
      if (name === "p") paragraph(c);
      else if (name === "tbl") table(c);
      else if (name === "sdt") block(firstChild(c, "sdtContent") ?? c);
      else if (name === "customXml" || name === "ins") block(c);
    }
  };

  const body = firstChild(parseXml(xml), "body");
  if (body) block(body);
  const notes = full ? [`Only the first ${PARSE_LIMITS.textChars.toLocaleString("en-US")} characters of the document were read.`] : [];
  return { format: "docx", markdown: out.join("\n\n"), notes };
}

/** Rows (first one the header) as a markdown table; short rows are padded. */
export function markdownTable(rows: string[][]): string {
  const width = Math.max(1, ...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}
