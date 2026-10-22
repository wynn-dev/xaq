// Attachment parsing in the sandboxed child (server/mail/extract): each format's extraction from real files, the
// caps on hostile ones (zip bomb, XXE, path traversal, huge CSV), and the sandbox itself: no file system, no
// processes, no code from strings, no network, a hard deadline, crashes and runaway output contained.

import { afterAll, describe, expect, it } from "vitest";
import { AttachmentParser, BOOTSTRAP, parserArgs } from "../server/mail/extract/sandbox.ts";
import type { Extracted } from "../server/mail/extract/types.ts";
import { createLogger } from "../server/util/log.ts";
import { CSV, makeDocx, makeLyingZipBomb, makePdf, makePptx, makeTraversalDocx, makeXlsx, makeXxeDocx, makeZipBomb } from "./attachment-fixtures.ts";

const log = createLogger("test").child("parser");
const parsers: AttachmentParser[] = [];
afterAll(async () => {
  for (const p of parsers) await p.close();
});
const parser = (opts?: ConstructorParameters<typeof AttachmentParser>[1]) => {
  const p = new AttachmentParser(log, opts);
  parsers.push(p);
  return p;
};
const real = parser();

async function ok(bytes: Buffer, format: Parameters<AttachmentParser["parse"]>[1]["format"]): Promise<Extracted> {
  const r = await real.parse(bytes, { format });
  if (!r.ok) throw new Error(`${r.reason}: ${r.message}`);
  return r.result;
}

/** Hostile parser code: replaces the bundle, runs under the real argv and bootstrap. */
const hostile = (src: string, opts: ConstructorParameters<typeof AttachmentParser>[1] = {}) =>
  parser({ ...opts, loadCode: async () => Buffer.from(src) });

describe("extraction", () => {
  it("reads a PDF page by page", async () => {
    const r = await ok(makePdf(["Invoice 42\nTotal due: 100 EUR", "Page two: terms and conditions"]), "pdf");
    expect(r).toMatchObject({ format: "pdf", totalPages: 2, notes: [] });
    if (r.format !== "pdf") throw new Error();
    expect(r.pages.map((p) => p.n)).toEqual([1, 2]);
    expect(r.pages[0]!.text).toContain("Invoice 42");
    expect(r.pages[0]!.text).toContain("Total due: 100 EUR");
    expect(r.pages[1]!.text).toContain("terms and conditions");
  });

  it("reads a DOCX as markdown: headings, lists, tables, links, emphasis", async () => {
    const r = await ok(makeDocx(), "docx");
    if (r.format !== "docx") throw new Error();
    const md = r.markdown;
    expect(md).toContain("# Quarterly report");
    expect(md).toContain("# Summary");
    expect(md).toContain("## Details");
    expect(md).toContain("Revenue grew **12%** this quarter, *as planned*.");
    expect(md).toContain("- First point\n\n  - Nested point");
    expect(md).toContain("1. Step one\n\n2. Step two");
    expect(md).toContain("| Region | Revenue |\n| --- | --- |\n| EU | 100 |\n| US\\|West | 200 |");
    expect(md).toContain("See [the dashboard](https://dash.example.test/q3) for more.");
  });

  it("reads an XLSX: sheets in order, shared strings, numbers, dates, hidden-free", async () => {
    const r = await ok(
      makeXlsx([
        { name: "Revenue", rows: [["Region", "Q1", "Booked"], ["EU", 100, { date: 45292 }], ["US", 250.5, null]] },
        { name: "Notes", rows: [["Plain note"]] },
      ]),
      "xlsx",
    );
    if (r.format !== "xlsx") throw new Error();
    expect(r.totalSheets).toBe(2);
    expect(r.sheets.map((s) => s.name)).toEqual(["Revenue", "Notes"]);
    expect(r.sheets[0]!.rows).toEqual([
      ["Region", "Q1", "Booked"],
      ["EU", "100", "2024-01-01"],
      ["US", "250.5", ""],
    ]);
    expect(r.sheets[0]).toMatchObject({ totalRows: 3, totalCols: 3 });
  });

  it("reads a CSV with quoted fields", async () => {
    const r = await ok(Buffer.from(CSV), "csv");
    if (r.format !== "csv") throw new Error();
    expect(r.sheets[0]!.rows).toEqual([
      ["region", "revenue", "notes"],
      ["EU", "100", "steady, slow"],
      ["US", "200", "line\nbreak"],
      ["APAC", "300", '"quoted"'],
    ]);
  });

  it("caps CSV rows and columns", async () => {
    const wide = Array.from({ length: 300 }, (_, i) => `c${i}`).join(",");
    const csv = `${wide}\n${Array.from({ length: 12_000 }, (_, i) => `${i},x`).join("\n")}\n`;
    const r = await ok(Buffer.from(csv), "csv");
    if (r.format !== "csv") throw new Error();
    expect(r.sheets[0]!.rows).toHaveLength(10_000);
    expect(r.sheets[0]!.rows[0]).toHaveLength(200);
    expect(r.sheets[0]).toMatchObject({ totalRows: 12_001, totalCols: 300 });
    expect(r.notes[0]).toMatch(/first 10,000 of 12,001 rows/);
  });

  it("reads a PPTX slide by slide in presentation order, with speaker notes", async () => {
    const r = await ok(
      makePptx([
        { text: ["Welcome", "Agenda for today"], notes: "Greet everyone" },
        { text: ["Numbers"], notes: "Mention the EU growth" },
        { text: ["Thanks"] },
      ]),
      "pptx",
    );
    if (r.format !== "pptx") throw new Error();
    expect(r.totalSlides).toBe(3);
    expect(r.slides).toEqual([
      { n: 1, text: "Welcome\nAgenda for today", notes: "Greet everyone" },
      { n: 2, text: "Numbers", notes: "Mention the EU growth" },
      { n: 3, text: "Thanks", notes: "" },
    ]);
  });

  it("strips control characters from extracted text", async () => {
    const r = await ok(Buffer.from("a,b\u0007c\u001b[31m\nd,e\n"), "csv");
    if (r.format !== "csv") throw new Error();
    expect(r.sheets[0]!.rows[0]).toEqual(["a", "bc[31m"]);
  });
});

describe("hostile documents", () => {
  it("refuses a zip bomb without inflating it", async () => {
    const bomb = makeZipBomb(200);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const r = await real.parse(bomb, { format: "xlsx" });
    expect(r).toMatchObject({ ok: false, reason: "unreadable", message: expect.stringMatching(/zip bomb/) });
  });

  it("stops a zip bomb whose headers lie about its size at the decompression cap", async () => {
    const r = await real.parse(makeLyingZipBomb(100), { format: "xlsx" });
    expect(r).toMatchObject({ ok: false, reason: "unreadable", message: expect.stringMatching(/zip bomb/) });
  });

  it("refuses XML with a DOCTYPE (XXE) and never resolves the entity", async () => {
    const r = await real.parse(makeXxeDocx(), { format: "docx" });
    expect(r).toMatchObject({ ok: false, reason: "unreadable", message: expect.stringMatching(/DOCTYPE/) });
  });

  it("refuses a package with an entry outside the archive", async () => {
    const r = await real.parse(makeTraversalDocx(), { format: "docx" });
    expect(r).toMatchObject({ ok: false, reason: "unreadable", message: expect.stringMatching(/outside the archive/) });
  });

  it("says plainly when a file isn't the format it claims", async () => {
    expect(await real.parse(Buffer.from("not a pdf"), { format: "pdf" })).toMatchObject({ ok: false, reason: "unreadable", message: expect.stringMatching(/readable PDF/) });
    expect(await real.parse(Buffer.from("PK nonsense"), { format: "docx" })).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("says a password-protected PDF is password-protected", async () => {
    expect(await real.parse(makePdf(["locked"], { encrypted: true }), { format: "pdf" })).toEqual({ ok: false, reason: "unreadable", message: "The PDF is password-protected." });
  });

  it("reads a truncated PDF as far as it goes or says it can't", async () => {
    const pdf = makePdf(["Some text"]);
    const r = await real.parse(pdf.subarray(0, Math.floor(pdf.length / 2)), { format: "pdf" });
    if (r.ok) expect(r.result.format).toBe("pdf");
    else expect(r.reason).toBe("unreadable");
  });
});

describe("sandbox", () => {
  it("passes exactly the permission flags, with no fs allowances", () => {
    const args = parserArgs();
    expect(args.slice(0, 4)).toEqual(["--permission", "--no-experimental-sqlite", "--disallow-code-generation-from-strings", "--max-old-space-size=256"]);
    expect(args.filter((a) => a.startsWith("--allow"))).toEqual([]);
    expect(args.slice(-3)).toEqual(["--input-type=module", "-e", BOOTSTRAP]);
  });

  it("the child can't read or write files, spawn, eval, open sqlite, signal xaq or reach the network", async () => {
    const probe = hostile(`
      export async function run() {
        const out = {};
        const fs = process.getBuiltinModule("node:fs");
        for (const [k, f] of [["read", () => fs.readFileSync("/etc/hostname")], ["readSelf", () => fs.readFileSync(process.execPath)],
          ["write", () => fs.writeFileSync("/tmp/xaq-parser-escape-" + process.pid, "x")],
          ["spawn", () => process.getBuiltinModule("node:child_process").execFileSync("/bin/true")],
          ["worker", () => new (process.getBuiltinModule("node:worker_threads").Worker)("1", { eval: true })],
          ["eval", () => eval("1")], ["fn", () => new Function("return 1")()],
          ["sqlite", () => { const m = process.getBuiltinModule("node:sqlite"); if (!m) throw Object.assign(new Error(), { code: "UNAVAILABLE" }); }],
          ["kill", () => process.kill(process.ppid, 0)],
          ["net", () => process.getBuiltinModule("node:net").connect(9, "127.0.0.1")],
        ]) {
          try { f(); out[k] = "ALLOWED"; } catch (e) { out[k] = e.code || e.name; }
        }
        try { await fetch("http://127.0.0.1:9/"); out.fetch = "ALLOWED"; } catch (e) { out.fetch = /disabled/.test(e.message) ? "disabled" : "failed:" + e.message; }
        out.env = Object.keys(process.env);
        out.cwd = process.cwd();
        return { ok: false, error: JSON.stringify(out) };
      }`);
    const r = await probe.parse(Buffer.from("x"), { format: "csv" });
    if (r.ok) throw new Error("expected the probe's report");
    const report = JSON.parse(r.message) as Record<string, unknown>;
    expect(report).toMatchObject({
      read: "ERR_ACCESS_DENIED",
      readSelf: "ERR_ACCESS_DENIED",
      write: "ERR_ACCESS_DENIED",
      spawn: "ERR_ACCESS_DENIED",
      worker: "ERR_ACCESS_DENIED",
      eval: "EvalError",
      fn: "EvalError",
      sqlite: "UNAVAILABLE",
      kill: "Error",
      net: "Error",
      fetch: "disabled",
      env: [],
      cwd: "/",
    });
  });

  it("kills a parse that runs past the deadline, remembers it, and keeps serving", async () => {
    const p = hostile("export function run() { for (;;); }", { deadlineMs: 1500 });
    const started = Date.now();
    const r = await p.parse(Buffer.from("loop"), { format: "pdf" });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
    // The same input fails fast the second time.
    const again = Date.now();
    expect(await p.parse(Buffer.from("loop"), { format: "pdf" })).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - again).toBeLessThan(200);
    // The real parser is unaffected.
    expect((await ok(Buffer.from("a,b\n"), "csv")).format).toBe("csv");
  });

  it("contains a crash and an out-of-memory child", async () => {
    expect(await hostile("export function run() { process.abort(); }").parse(Buffer.from("x"), { format: "pdf" })).toMatchObject({ ok: false, reason: "crashed" });
    const oom = hostile("export function run() { const keep = []; for (;;) keep.push(new Array(1e6).fill(keep.length)); }", { heapMb: 64 });
    expect(await oom.parse(Buffer.from("x"), { format: "pdf" })).toMatchObject({ ok: false, reason: "crashed" });
  });

  it("kills a child whose output runs past the cap", async () => {
    const p = hostile('export function run() { return { ok: true, result: { format: "docx", markdown: "x".repeat(40 * 1024 * 1024), notes: [] } }; }', { heapMb: 512 });
    expect(await p.parse(Buffer.from("x"), { format: "docx" })).toMatchObject({ ok: false, reason: "unreadable", message: expect.stringMatching(/more output/) });
  });

  it("doesn't trust the child's answer: a wrong shape or another format is refused", async () => {
    const wrongShape = hostile('export function run() { return { ok: true, result: { format: "pdf", pages: "not a list", notes: [] } }; }');
    expect(await wrongShape.parse(Buffer.from("x"), { format: "pdf" })).toMatchObject({ ok: false, reason: "crashed", message: expect.stringMatching(/unexpected/) });
    const otherFormat = hostile('export function run() { return { ok: true, result: { format: "docx", markdown: "x", notes: [] } }; }');
    expect(await otherFormat.parse(Buffer.from("x"), { format: "pdf" })).toMatchObject({ ok: false, reason: "crashed" });
  });

  it("bounds the queue and runs at most `concurrency` children", async () => {
    const p = hostile("export async function run(input) { await new Promise((r) => setTimeout(r, 300)); return { ok: true, result: { format: 'docx', markdown: input.toString(), notes: [] } }; }", {
      concurrency: 1,
      maxQueue: 2,
    });
    const jobs = [0, 1, 2, 3].map((i) => p.parse(Buffer.from(`job${i}`), { format: "docx" }));
    const results = await Promise.all(jobs);
    // One running + two queued; the fourth is refused at once.
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results[3]).toMatchObject({ ok: false, reason: "busy" });
  });

  it("keeps the event loop responsive while a child spins", async () => {
    const p = hostile("export function run() { for (;;); }", { deadlineMs: 1000 });
    const pending = p.parse(Buffer.from("spin"), { format: "pdf" });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    await pending;
    clearInterval(timer);
    expect(ticks).toBeGreaterThanOrEqual(10);
  });
});
