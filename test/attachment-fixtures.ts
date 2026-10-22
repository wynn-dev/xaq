// Small, real attachment files built in code (reviewable, deterministic): a PDF with text per page, DOCX, XLSX and
// PPTX packages (OOXML zipped with fflate), a CSV, a PNG and an opaque binary. Plus hostile ones: a zip bomb, an
// XXE attempt and a path-traversal entry.

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
const zip = (files: Record<string, string | Uint8Array>, level: 0 | 6 = 6) =>
  Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])) as Zippable, { level }));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A PDF with one page per entry; each "\n" starts a new text line. Helvetica, no compression. `encrypted`: a standard
 * security handler (RC4, revision 2) whose user password isn't empty, so a reader needs a password to open it.
 */
export function makePdf(pages: string[], opts: { encrypted?: boolean } = {}): Buffer {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s);
  add(""); // 1: catalog
  add(""); // 2: pages
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"); // 3
  const kids: number[] = [];
  for (const text of pages) {
    const ops = text
      .split("\n")
      .map((l, i) => `BT /F1 12 Tf 72 ${720 - i * 16} Td (${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`)
      .join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(ops, "latin1")} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  // /O and /U are arbitrary: no password, empty or not, produces this /U, so the file can't be opened.
  const encrypt = opts.encrypted ? add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -44 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> >>`) : null;
  const encryptRef = encrypt ? ` /Encrypt ${encrypt} 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]` : "";
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${encryptRef} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const run = (t: string, rpr = "") => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (inner: string, ppr = "") => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${inner}</w:p>`;

/** A DOCX with a title, headings, bold/italic, a bullet and a numbered list, a table and a hyperlink. */
export function makeDocx(opts: { body?: string } = {}): Buffer {
  const body =
    opts.body ??
    [
      para(run("Quarterly report"), '<w:pStyle w:val="Title"/>'),
      para(run("Summary"), '<w:pStyle w:val="Heading1"/>'),
      para(run("Revenue grew ") + run("12%", "<w:b/>") + run(" this quarter, ") + run("as planned", "<w:i/>") + run(".")),
      para(run("First point"), '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
      para(run("Nested point"), '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>'),
      para(run("Step one"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
      para(run("Step two"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>'),
      para(run("Details"), '<w:pStyle w:val="Heading2"/>'),
      "<w:tbl><w:tr><w:tc>" + para(run("Region")) + "</w:tc><w:tc>" + para(run("Revenue")) + "</w:tc></w:tr>" +
        "<w:tr><w:tc>" + para(run("EU")) + "</w:tc><w:tc>" + para(run("100")) + "</w:tc></w:tr>" +
        "<w:tr><w:tc>" + para(run("US|West")) + "</w:tc><w:tc>" + para(run("200")) + "</w:tc></w:tr></w:tbl>",
      para(run("See ") + `<w:hyperlink r:id="rIdLink">${run("the dashboard")}</w:hyperlink>` + run(" for more.")),
    ].join("");
  return zip({
    "[Content_Types].xml": xml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/_rels/document.xml.rels": xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLink" Type="${REL}/hyperlink" Target="https://dash.example.test/q3" TargetMode="External"/><Relationship Id="rIdNum" Type="${REL}/numbering" Target="numbering.xml"/><Relationship Id="rIdSty" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    "word/styles.xml": xml(
      `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style></w:styles>`,
    ),
    "word/numbering.xml": xml(
      `<w:numbering ${W}><w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="20"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num></w:numbering>`,
    ),
    "word/document.xml": xml(`<w:document ${W}><w:body>${body}</w:body></w:document>`),
  });
}

/** A DOCX whose document.xml declares an external entity (XXE) and uses it. */
export function makeXxeDocx(): Buffer {
  const doc = `<?xml version="1.0"?>\n<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n<w:document ${W}><w:body>${para("<w:r><w:t>&xxe;</w:t></w:r>")}</w:body></w:document>`;
  const base = makeDocx();
  // Same package, document.xml replaced.
  return zip({ ...unzipToStrings(base), "word/document.xml": doc });
}

function unzipToStrings(buf: Buffer): Record<string, string> {
  // Only for our own fixtures: small, trusted.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(unzipSync(new Uint8Array(buf)))) out[k] = strFromU8(v as Uint8Array);
  return out;
}

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

type Cell = string | number | { date: number } | null;

const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** An XLSX with the given sheets. Strings go to sharedStrings; `{ date: serial }` cells use a date format. */
export function makeXlsx(sheets: { name: string; rows: Cell[][] }[]): Buffer {
  const strings: string[] = [];
  const sid = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  const files: Record<string, string> = {};
  sheets.forEach((sh, n) => {
    const rows = sh.rows
      .map((r, ri) => {
        const cells = r
          .map((c, ci) => {
            const ref = `${colName(ci)}${ri + 1}`;
            if (c === null) return "";
            if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
            if (typeof c === "object") return `<c r="${ref}" s="1"><v>${c.date}</v></c>`;
            return `<c r="${ref}" t="s"><v>${sid(c)}</v></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("");
    files[`xl/worksheets/sheet${n + 1}.xml`] = xml(`<worksheet ${S}><sheetData>${rows}</sheetData></worksheet>`);
  });
  return zip({
    ...files,
    "[Content_Types].xml": xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    "_rels/.rels": xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": xml(`<workbook ${S}><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdT" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/sharedStrings.xml": xml(`<sst ${S} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`),
    "xl/styles.xml": xml(`<styleSheet ${S}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`),
  });
}

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const shape = (paras: string[]) => `<p:sp><p:txBody>${paras.map((t) => `<a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;

/** A PPTX: each slide's text paragraphs, and optional speaker notes. Slides are listed out of file order on purpose. */
export function makePptx(slides: { text: string[]; notes?: string }[]): Buffer {
  const files: Record<string, string> = {};
  const n = slides.length;
  slides.forEach((s, i) => {
    // Files numbered backwards: presentation.xml order must win over file names.
    const f = n - i;
    files[`ppt/slides/slide${f}.xml`] = xml(`<p:sld ${P}><p:cSld><p:spTree>${shape(s.text)}</p:spTree></p:cSld></p:sld>`);
    if (s.notes !== undefined) {
      files[`ppt/slides/_rels/slide${f}.xml.rels`] = xml(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${f}.xml"/></Relationships>`,
      );
      files[`ppt/notesSlides/notesSlide${f}.xml`] = xml(
        `<p:notes ${P}><p:cSld><p:spTree>${shape([s.notes])}<p:sp><p:txBody><a:p><a:fld type="slidenum"><a:t>${f}</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
      );
    }
  });
  return zip({
    ...files,
    "[Content_Types].xml": xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    "_rels/.rels": xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`),
    "ppt/presentation.xml": xml(`<p:presentation ${P}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": xml(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${n - i}.xml"/>`).join("")}</Relationships>`,
    ),
  });
}

/** A zip whose one entry inflates to `mb` megabytes of zeros (a few KB compressed). Named like a sheet. */
export function makeZipBomb(mb = 200): Buffer {
  return zip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": new Uint8Array(mb * 1024 * 1024) }, 6);
}

/** The same bomb, but its headers claim the entry is 1000 bytes (only the real inflated size can stop it). */
export function makeLyingZipBomb(mb = 100): Buffer {
  const buf = makeZipBomb(mb);
  const name = Buffer.from("xl/workbook.xml");
  for (let i = 0; i + 46 < buf.length; i++) {
    const sig = buf.readUInt32LE(i);
    if (sig === 0x02014b50 && buf.subarray(i + 46, i + 46 + name.length).equals(name)) buf.writeUInt32LE(1000, i + 24);
    if (sig === 0x04034b50 && buf.subarray(i + 30, i + 30 + name.length).equals(name)) buf.writeUInt32LE(1000, i + 22);
  }
  return buf;
}

/** A DOCX-shaped zip with an entry that climbs out of the archive. */
export function makeTraversalDocx(): Buffer {
  return zip({ ...unzipToStrings(makeDocx()), "../../evil.txt": "pwned" });
}

/** A 1×1 PNG. */
export const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** Opaque bytes (no known format). */
export const BINARY = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 256));

export const CSV = 'region,revenue,notes\nEU,100,"steady, slow"\nUS,200,"line\nbreak"\nAPAC,300,"""quoted"""\n';
