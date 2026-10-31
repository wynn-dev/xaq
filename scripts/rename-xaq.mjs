#!/usr/bin/env node
// The mechanical part of the agentinbox → xaq rename: string (and path) replacements over the tracked
// files, with explicit include / exclude rules. Idempotent: run it again after rebasing onto a newer main
// and it only touches what still says agentinbox.
//
//   node scripts/rename-xaq.mjs            rewrite files, print a summary
//   node scripts/rename-xaq.mjs --check    change nothing; exit 1 if anything would change
//
// What it does NOT do (hand-written, in the files listed under HAND_WRITTEN): the XAQ_* → AGENTINBOX_*
// environment fallback, the data-directory and XDG rules, the service migration (launchd / systemd),
// the agent-side names kept for profiles made before the rename (Hermes routes, MCP server names), the
// skill replacement, the agentinbox-cli shim and the workflows. Those files are skipped, and any line in
// them that mentions agentinbox without saying why is listed at the end for a human to look at.
//
// Inside included files, a line containing "rename-xaq: keep", or a region between "rename-xaq: keep-start"
// and "rename-xaq: keep-end", is left alone (for text that must name the old product, e.g. upgrade notes).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const check = process.argv.includes("--check");

/** File types the rename looks at. */
const INCLUDE = /\.(ts|tsx|mts|mjs|js|cjs|md|html|css|json|txt|sh|ya?ml|toml|env)$/;

/** Never touched: history, plans, generated or owned elsewhere. */
const EXCLUDE = [
  /^pnpm-lock\.yaml$/,
  /^package\.json$/, // hand-written: name, bin, URLs
  /^\.github\//, // hand-written: nightly.yml, shim.yml
  /^shim\//, // the agentinbox-cli shim is about the old name
  /^server\/db\/schema\.ts$/, // applied migrations are never edited
  /^src\/routeTree\.gen\.ts$/,
  /^LICENSE$/,
];

/** Written by hand for the migration: skipped here, but reviewed (see the report at the end). */
const HAND_WRITTEN = [
  "scripts/rename-xaq.mjs",
  "server/brand.ts",
  "server/config.ts",
  "server/instance.ts",
  "server/crypto.ts",
  "server/service.ts",
  "server/cli.ts",
  "server/skill/index.ts",
  "server/agentapi/stream.ts",
  "server/listen/service.ts",
  "server/listen/names.ts",
  "server/listen/paths.ts",
  "server/listen/exec.ts",
  "server/listen/mcpsetup.ts",
  "server/listen/mcpheader.ts",
  "server/listen/recipes.ts",
  "test/rename-migration.test.ts",
  "vite.config.ts",
];

/** Hand-written files that are about the rename itself: every mention there is deliberate, so no review. */
const ABOUT_THE_RENAME = ["scripts/rename-xaq.mjs", "server/listen/names.ts", "test/rename-migration.test.ts"];

/**
 * Names that keep the old spelling everywhere, because something outside this repo depends on them:
 * HTTP headers (a listener, a console tab or a receiver of another version), the Pub/Sub topic and
 * subscription in each user's Google Cloud project, internal message names shared by the OAuth popup and
 * the console, the launchd labels installed services are found by, and the console theme key (read as a
 * fallback). Matched case-sensitively.
 */
const PROTECTED = [
  "formerly agentinbox",
  "Upgrading from agentinbox",
  "upgrading-from-agentinbox",
  "com.unlaboredlabs.agentinbox",
  "x-agentinbox-",
  "X-Agentinbox-",
  "agentinbox-gmail",
  "agentinbox-oauth",
  "agentinbox:oauth",
  "agentinbox-connection-oauth",
  "agentinbox:connection-oauth",
  "agentinbox:unauthorized",
  "agentinboxTest",
  "agentinbox.theme",
];

/**
 * Protected only in one file. SKILL.md (served to agents, so no keep markers in it) names the tools an agent set up
 * before the rename may still have (server/listen/names.ts). Elsewhere, e.g. in tests of new profiles, those names
 * mean the product's own server and are renamed.
 */
const PROTECTED_IN = { "server/skill/SKILL.md": ["mcp-agentinbox", "mcp__agentinbox"] };

/** In order. Each is idempotent: no replacement contains its own search string. */
const REPLACEMENTS = [
  ["github.com/wynn-dev/agentinbox", "github.com/wynn-dev/xaq"],
  // xaq reads like the name Xaq ("zack"): "a xaq server", not "an".
  ["an agentinbox", "a xaq"],
  ["An agentinbox", "A xaq"],
  ["agentinbox-cli", "xaq-cli"],
  ["AGENTINBOX_", "XAQ_"],
  ["AgentInbox", "xaq"],
  ["Agentinbox", "Xaq"],
  ["agentinbox", "xaq"],
];

/**
 * A hand-written line that names the old product on purpose: it says why, or it is one of the old names
 * the migration looks for (environment variables, data directory, service names, package, skill).
 */
const EXPLAINED = new RegExp(
  [
    "legacy|LEGACY|before the rename|pre-rename|from before|older than the rename|rename-xaq",
    "agentinbox is now xaq|Coming from agentinbox|Upgrading from agentinbox|installed as agentinbox|or agentinbox\\b|replaces an agentinbox",
    "AGENTINBOX_|AGENTINBOX\\)|~/\\.agentinbox|unlaboredlabs|agentinbox-listen|agentinbox-cli|agentinbox skill|agentinbox\\.(db|lock|log)|name:.{0,4}agentinbox|\\|agentinbox|=== \"agentinbox\"",
  ].join("|"),
);

const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);

const protectedFor = (file) => [...PROTECTED, ...(PROTECTED_IN[file] ?? [])];
const protect = (line, file) => {
  const list = protectedFor(file);
  let out = line;
  // Private-use characters as placeholders: they never occur in the sources.
  list.forEach((p, i) => (out = out.split(p).join(`\uE000${i}\uE001`)));
  return out;
};
const unprotect = (line, file) => line.replace(/\uE000(\d+)\uE001/g, (_, i) => protectedFor(file)[Number(i)]);
const rename = (line, file = "") => {
  let out = protect(line, file);
  for (const [from, to] of REPLACEMENTS) out = out.split(from).join(to);
  return unprotect(out, file);
};

/** The text with every replaceable line renamed; keep markers respected. */
function renameText(text, file) {
  let keeping = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.includes("rename-xaq: keep-start")) keeping = true;
      if (line.includes("rename-xaq: keep-end")) {
        keeping = false;
        return line;
      }
      if (keeping || line.includes("rename-xaq: keep")) return line;
      return rename(line, file);
    })
    .join("\n");
}

const changed = [];
const moved = [];
const review = [];
let replacements = 0;

for (const file of files) {
  if (EXCLUDE.some((re) => re.test(file))) continue;
  if (HAND_WRITTEN.includes(file)) {
    if (ABOUT_THE_RENAME.includes(file) || !existsSync(join(ROOT, file))) continue;
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/agentinbox/i.test(line) && !EXPLAINED.test(line) && !PROTECTED.some((p) => line.includes(p))) review.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    continue;
  }
  if (!INCLUDE.test(file) || !existsSync(join(ROOT, file))) continue;
  const path = join(ROOT, file);
  const before = readFileSync(path, "utf8");
  const after = renameText(before, file);
  if (after !== before) {
    const count = before.split("\n").filter((l, i) => l !== after.split("\n")[i]).length;
    replacements += count;
    changed.push(`${file} (${count} line${count === 1 ? "" : "s"})`);
    if (!check) writeFileSync(path, after);
  }
  const target = rename(file);
  if (target !== file) {
    moved.push(`${file} → ${target}`);
    if (!check) {
      mkdirSync(dirname(join(ROOT, target)), { recursive: true });
      renameSync(path, join(ROOT, target));
    }
  }
}

const say = (title, list) => {
  console.log(`${title}: ${list.length}`);
  for (const l of list) console.log(`  ${l}`);
};
console.log(check ? "rename-xaq --check (nothing written)\n" : "rename-xaq\n");
say("Files rewritten", changed);
console.log(`Lines changed: ${replacements}`);
say("Files moved", moved);
say("Hand-written lines naming agentinbox without saying why (review)", review);
if (check && (changed.length || moved.length)) process.exitCode = 1;
