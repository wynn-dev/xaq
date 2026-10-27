#!/usr/bin/env node
// Writes npm-shrinkwrap.json for the package about to be published (nightly.yml runs it after `npm version`).
// npm installs a dependency's shrinkwrap exactly, so everyone who installs this release gets the same runtime
// tree, and the console's update job refuses a release without one (server/service.ts shrinkwrapProblems).
//
//   node scripts/shrinkwrap.mjs
//
// It resolves package.json's runtime dependencies with npm (in a scratch directory: npm can't read pnpm's
// node_modules), so the versions are npm's resolution of the same ranges, not necessarily pnpm-lock.yaml's
// (docs/FOLLOWUPS.md). Dev dependencies are left out: they are never installed from the package.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "xaq-shrinkwrap-"));
try {
  const { name, version, dependencies, engines } = pkg;
  writeFileSync(join(scratch, "package.json"), `${JSON.stringify({ name, version, dependencies, engines }, null, 2)}\n`);
  const run = (...args) => execFileSync(npm, args, { cwd: scratch, stdio: "inherit" });
  run("install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error");
  run("shrinkwrap", "--loglevel=error");
  const wrap = JSON.parse(readFileSync(join(scratch, "npm-shrinkwrap.json"), "utf8"));
  const missing = Object.entries(wrap.packages ?? {}).filter(([path, meta]) => path && !meta.link && !meta.integrity);
  if (missing.length) throw new Error(`npm-shrinkwrap.json pins packages without an integrity hash: ${missing.map(([p]) => p).join(", ")}`);
  copyFileSync(join(scratch, "npm-shrinkwrap.json"), join(ROOT, "npm-shrinkwrap.json"));
  console.log(`Wrote npm-shrinkwrap.json (${Object.keys(wrap.packages).length - 1} packages).`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
