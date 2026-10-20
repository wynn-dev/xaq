// Source mode (tsx, vitest) has no dist/attachment-parser.js, so the parser bundle is built on first use into
// node_modules/.cache/xaq with the build's own options (tsdown.config.mjs `parserConfig`; tsdown is a dev dependency,
// imported only here and only in source mode). A built xaq never runs this.

import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SRC_DIR = import.meta.dirname;
const ROOT = resolve(SRC_DIR, "..", "..", "..");
const SOURCES = ["child.ts", "csv.ts", "docx.ts", "pdf.ts", "pptx.ts", "types.ts", "xlsx.ts", "xml.ts", "zip.ts"];

/** Builds the bundle to `outFile` (renamed into place: concurrent test workers may build at once). */
export async function buildParserBundle(outFile: string): Promise<string> {
  // Not literal specifiers: the server build must not try to bundle tsdown or its config.
  const tsdown = "tsdown";
  const { build } = (await import(tsdown)) as { build: (c: Record<string, unknown>) => Promise<unknown> };
  const { parserConfig } = (await import(pathToFileURL(join(ROOT, "tsdown.config.mjs")).href)) as { parserConfig: Record<string, unknown> };
  const dir = `${outFile}.tmp-${process.pid}-${Date.now()}`;
  try {
    await build({ ...parserConfig, config: false, cwd: ROOT, outDir: dir, clean: true, logLevel: "error" });
    mkdirSync(dirname(outFile), { recursive: true });
    renameSync(join(dir, "attachment-parser.js"), outFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return outFile;
}

/** The cached bundle when it's newer than every parser source file and the lockfile, else a fresh build. */
export async function sourceModeBundle(): Promise<string> {
  const out = join(ROOT, "node_modules", ".cache", "xaq", "attachment-parser.js");
  if (existsSync(out)) {
    const built = statSync(out).mtimeMs;
    const inputs = [...SOURCES.map((f) => join(SRC_DIR, f)), join(ROOT, "pnpm-lock.yaml"), join(ROOT, "tsdown.config.mjs")];
    if (inputs.every((f) => !existsSync(f) || statSync(f).mtimeMs <= built)) return out;
  }
  return buildParserBundle(out);
}
