import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "../../shared/agent-api.ts";
import { backupFile, isTooOpen, writePrivateFile } from "./fsutil.ts";
import { claudeServerEntry, helperNodeNote, helperScriptPath } from "./mcpheader.ts";
import type { Profile } from "./profile.ts";
import { DEFAULT_PROFILE } from "./paths.ts";
import { mcpServerName } from "./recipes.ts";
import { NPX } from "./version.ts";
import { safeText } from "./ui.ts";
import { isDeepStrictEqual } from "node:util";
import { readTomlMcpServers } from "../connections-cli/toml.ts";
import { cutEntries, hasAnchors, mcpServersBlock, readMcpServers, removeYamlServers } from "../connections-cli/yaml.ts";

/**
 * `--setup-mcp`: registers the xaq MCP server in the agent's own tool without the key ever
 * being shown or pasted. Every file we modify is backed up first; the key is redacted from any
 * output we relay.
 */

export interface McpSetupResult {
  ok: boolean;
  /** What happened, safe to print (never contains the key). */
  message: string;
  backup?: string | null;
  /** Manual steps when automatic setup isn't possible. Never contains the key. */
  manual?: string[];
  /** Exactly what was (or, in a dry run, would be) changed. Never contains the key. */
  changes?: string[];
  /** How to check it worked. */
  verify?: string[];
  /** Nothing was changed (--dry-run). */
  dryRun?: boolean;
  /** Things to know afterwards, e.g. which Node.js the setup depends on. */
  notes?: string[];
  /** `removeServers` entries that were taken out. */
  removed?: string[];
}

export interface McpSetupOptions {
  /** Print what would change; change nothing. */
  dryRun?: boolean;
  /**
   * Other entries to take out in the same write (`import --from`: servers now served through the broker). For the
   * file-based tools it's all or nothing: if one can't be removed safely, nothing is changed.
   */
  removeServers?: RemoveServer[];
}

export interface RemoveServer {
  name: string;
  /** Claude Code: the scope it's defined in, and for local/project scope the project directory. */
  scope?: "user" | "local" | "project";
  projectDir?: string;
}

/**
 * The safety net under every rewrite: the new file, read back with the same readers, must hold exactly the old
 * entries minus the removed ones (each unchanged, deep-equal), plus our entry as intended. Anything else means the
 * rewrite moved a line where it doesn't belong (e.g. a header under another server): refuse it. Returns the
 * problem, or null when it's right.
 */
export function checkRewrite(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  ours: { name: string; entry: unknown },
  removed: string[],
): string | null {
  if (!before || !after) return "it can't be read back";
  // A value the reader couldn't read compares equal to any other unreadable one: that verifies nothing.
  const opaque = (v: unknown): boolean => typeof v === "symbol" || (!!v && typeof v === "object" && Object.values(v as Record<string, unknown>).some(opaque));
  const gone = new Set(removed);
  for (const [name, entry] of Object.entries(before)) {
    if (name === ours.name || gone.has(name)) continue;
    if (!(name in after)) return `"${name}" would disappear`;
    if (opaque(entry) || opaque(after[name])) return `"${name}" has a value this can't read, so the result can't be verified`;
    if (!isDeepStrictEqual(after[name], entry)) return `"${name}" would change`;
  }
  for (const name of removed) if (name in after) return `"${name}" would still be there`;
  for (const name of Object.keys(after)) if (name !== ours.name && !(name in before)) return `"${name}" would appear`;
  if (!isDeepStrictEqual(after[ours.name], ours.entry)) return `"${ours.name}" wouldn't be exactly the new entry`;
  return null;
}

const refused = (file: string, why: string, manual: string[]): McpSetupResult => ({
  ok: false,
  message: `Not rewriting ${file}: read back, the result isn't right (${why}). Nothing was changed.`,
  manual,
});

/** The entries to remove, never the xaq entry itself. */
const removals = (t: McpSetupTarget, opts: McpSetupOptions) => (opts.removeServers ?? []).filter((r) => r.name !== t.name);
const removedNote = (extra: RemoveServer[]) => (extra.length ? ` Removed ${extra.map((r) => `"${r.name}"`).join(", ")} (now served through xaq).` : "");
const removedLine = (name: string, file: string) => `remove ${name} from ${file} (it's now served through xaq)`;

/** Placeholder shown wherever the key would go in printed file contents. */
const KEY_SHOWN = "<the key from your xaq profile>";
const backupLine = (file: string) => (existsSync(file) ? `back up ${file} to ${file}.xaq-backup-<timestamp> (0600)` : `${file} doesn't exist yet: nothing to back up`);
const indent = (text: string) =>
  text
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => `    ${l}`);

export interface McpSetupTarget {
  name: string;
  url: string;
  key: string;
}

const redact = (s: string, key: string) => s.split(key).join("aib_…(redacted)");

/**
 * The MCP endpoint is always derived from the URL the user connected to (and transport-checked
 * there), never taken from the daemon: a daemon's advertised mcpUrl comes from its publicUrl setting,
 * which defaults to http://localhost:8425 and could also point the key somewhere else entirely.
 */
export function mcpTarget(profileName: string, profile: Profile): McpSetupTarget & { profile: string } {
  return { name: mcpServerName(profileName), url: `${profile.url}/mcp`, key: profile.apiKey, profile: profileName };
}

export function setupMcp(tool: AgentTool, t: McpSetupTarget & { profile?: string }, profileFile: string, opts: McpSetupOptions = {}): McpSetupResult {
  switch (tool) {
    case "claude-code":
      return setupClaude(t, t.profile ?? "default", opts);
    case "codex":
      return setupCodex(t, profileFile, opts);
    case "cursor":
      return setupCursor(t, profileFile, opts);
    case "hermes":
      return setupHermes(t, profileFile, opts);
    default:
      return { ok: false, message: "No automatic MCP setup for --tool other.", manual: manualGeneric(t, profileFile) };
  }
}

function manualGeneric(t: McpSetupTarget, profileFile: string): string[] {
  return [
    `MCP endpoint (streamable HTTP): ${t.url}`,
    `Header: Authorization: Bearer <key>. The key is the "apiKey" field in ${profileFile}; tools that run a header helper can use \`${NPX} mcp-header\`, which prints it as JSON to a pipe.`,
  ];
}

// ───────────── Claude Code ─────────────

export const claudeConfigFile = () => (process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json"));

function setupClaude(t: McpSetupTarget, profile: string, opts: McpSetupOptions): McpSetupResult {
  // headersHelper: Claude Code asks our helper for the header at connect time, so the key is never in
  // argv (visible in `ps`), in ~/.claude.json, or on screen.
  const json = JSON.stringify(claudeServerEntry(t.url, profile, { install: !opts.dryRun }));
  const addCommand = `claude mcp add-json --scope user ${t.name} '${json.replace(/'/g, `'"'"'`)}'`;
  const manual = [addCommand];
  const file = claudeConfigFile();
  const verify = [`claude mcp list   (shows "${t.name}" as connected; inside Claude Code: /mcp)`];
  // The helper command names a node binary: say which, and how to recover when it goes away.
  const notes = [helperNodeNote(profile, `${NPX} setup-mcp --tool claude-code${profile === DEFAULT_PROFILE ? "" : ` --profile ${profile}`}`)];
  const removeArgs = removals(t, opts).map((r) => ({ r, args: ["mcp", "remove", r.name, "--scope", r.scope ?? "user"], cwd: r.projectDir }));
  const changes = [
    `write the header helper ${helperScriptPath()} (0600; reads the key from your profile when Claude Code connects)`,
    backupLine(file),
    `run: claude mcp remove ${t.name} --scope user   (drops an earlier "${t.name}" entry, if any)`,
    `run: ${addCommand}`,
    ...removeArgs.map((x) => `run: claude ${x.args.join(" ")}${x.cwd ? `   (in ${x.cwd})` : ""}   (now served through xaq)`),
    `the key stays in your xaq profile: neither the command line nor ${file} contains it`,
  ];
  if (opts.dryRun) return { ok: true, dryRun: true, message: `Dry run for Claude Code: nothing was changed. setup-mcp would:`, changes, verify, notes };
  const probe = spawnSync("claude", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) return { ok: false, message: "The `claude` CLI was not found on PATH.", manual };
  const backup = backupFile(file);
  // `add-json` refuses an existing name, so replace it. argv arrays only, and nothing secret in them.
  spawnSync("claude", ["mcp", "remove", t.name, "--scope", "user"], { stdio: "ignore" });
  const r = spawnSync("claude", ["mcp", "add-json", "--scope", "user", t.name, json], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    const out = redact(`${r.stderr ?? ""}${r.stdout ?? ""}`, t.key).trim();
    return { ok: false, message: `claude mcp add-json failed${out ? `: ${safeText(out, 300)}` : ""}`, backup, manual };
  }
  // Only after the broker entry is in: a failed removal leaves a duplicate, never a gap.
  const done: string[] = [];
  for (const x of removeArgs) {
    const rr = spawnSync("claude", x.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: x.cwd });
    if (rr.status === 0) done.push(`ran: claude ${x.args.join(" ")}`);
    else notes.push(`Couldn't remove "${x.r.name}" (${x.r.scope ?? "user"} scope): remove it yourself with claude ${x.args.join(" ")}${x.cwd ? ` in ${x.cwd}` : ""}.`);
  }
  if (existsSync(file) && isTooOpen(file)) chmodSync(file, 0o600);
  return {
    ok: true,
    message: `Registered MCP server "${t.name}" in Claude Code (user scope). The key stays in your xaq profile; Claude Code asks for it through a header helper.`,
    backup,
    changes: [`ran: ${addCommand}`, `${file} now lists "${t.name}" (user scope)`, ...done],
    verify,
    notes,
    removed: removeArgs.filter((x) => done.includes(`ran: claude ${x.args.join(" ")}`)).map((x) => x.r.name),
  };
}

// ───────────── Codex (~/.codex/config.toml) ─────────────

export const codexConfigFile = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tomlString = (s: string) => JSON.stringify(s);

/** Removes `[mcp_servers.<name>]` and its sub-tables from a TOML document, or returns null if it's defined in a form we won't rewrite safely. */
export function removeTomlServer(toml: string, name: string): string | null {
  const keyForms = `(?:${escapeRe(name)}|"${escapeRe(name)}"|'${escapeRe(name)}')`;
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${keyForms}\\s*(?:\\.[^\\]]*)?\\]\\s*(?:#.*)?$`);
  const anyHeader = /^\s*\[/;
  // Inline or dotted definitions (`mcp_servers = { … }`, `mcp_servers.xaq.url = …`): leave to the human.
  if (new RegExp(`^\\s*mcp_servers\\s*(?:=|\\.\\s*${keyForms}\\s*[.=])`, "m").test(toml)) return null;
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (anyHeader.test(line)) skipping = header.test(line);
    // Our own marker comment sits just above the table: drop it too, so re-running doesn't pile them up.
    if (!skipping && line.trim() !== CODEX_MARKER && line.trim() !== LEGACY_CODEX_MARKER) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

const CODEX_MARKER = "# Added by `xaq setup-mcp`. The key is also in your xaq profile; rotate it in the console.";
/** The marker setup-mcp wrote before the rename: dropped too when the table is rewritten. */
const LEGACY_CODEX_MARKER = "# Added by `agentinbox setup-mcp`. The key is also in your agentinbox profile; rotate it in the console.";

export function codexBlock(t: McpSetupTarget): string {
  return [
    CODEX_MARKER,
    `[mcp_servers.${t.name}]`,
    `url = ${tomlString(t.url)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${t.key}`)} }`,
    `# codex exec never prompts: approve ${t.name} tools up front (the grant's access still applies).`,
    `default_tools_approval_mode = "approve"`,
    "",
  ].join("\n");
}

function setupCodex(t: McpSetupTarget, profileFile: string, opts: McpSetupOptions): McpSetupResult {
  const file = codexConfigFile();
  const manual = [
    `Add to ${file}:`,
    `  [mcp_servers.${t.name}]`,
    `  url = "${t.url}"`,
    `  http_headers = { Authorization = "Bearer <key>" }   # <key>: the apiKey field of ${profileFile}`,
    `  default_tools_approval_mode = "approve"`,
  ];
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const withoutOurs = removeTomlServer(current, t.name);
  if (withoutOurs === null) return { ok: false, message: `${file} defines mcp_servers inline; not rewriting it automatically.`, manual };
  let without = withoutOurs;
  const extra = removals(t, opts);
  for (const r of extra) {
    const next = removeTomlServer(without, r.name);
    if (next === null || next === without) return { ok: false, message: `Couldn't remove [mcp_servers.${r.name}] from ${file} safely; nothing was changed.`, manual };
    without = next;
  }
  const verify = [`codex mcp list   (shows "${t.name}")`];
  const replaces = withoutOurs !== current.replace(/\n{3,}/g, "\n\n") ? `replace [mcp_servers.${t.name}] in` : `add [mcp_servers.${t.name}] to`;
  const changes = [
    backupLine(file),
    ...extra.map((r) => removedLine(`[mcp_servers.${r.name}]`, file)),
    `${replaces} ${file} (other tables are kept) and set the file to 0600, since it will hold the key:`,
    ...indent(codexBlock({ ...t, key: KEY_SHOWN })),
  ];
  const base = without.replace(/\s*$/, "");
  const next = `${base ? `${base}\n\n` : ""}${codexBlock(t)}`;
  const toTable = (x: ReturnType<typeof readTomlMcpServers>) => x as Record<string, unknown>;
  const problem = checkRewrite(
    toTable(readTomlMcpServers(current)),
    toTable(readTomlMcpServers(next)),
    { name: t.name, entry: { url: t.url, http_headers: { Authorization: `Bearer ${t.key}` }, default_tools_approval_mode: "approve" } },
    extra.map((r) => r.name),
  );
  if (problem) return refused(file, problem, manual);
  if (opts.dryRun) return { ok: true, dryRun: true, message: `Dry run for Codex: nothing was changed. setup-mcp would:`, changes, verify };
  const backup = backupFile(file);
  writePrivateFile(file, next, { privateDir: false });
  return { ok: true, message: `Added [mcp_servers.${t.name}] to ${file} (now mode 0600: it holds the key).${removedNote(extra)}`, backup, verify, removed: extra.map((r) => r.name) };
}

// ───────────── Cursor (~/.cursor/mcp.json) ─────────────

export const cursorConfigFile = () => join(homedir(), ".cursor", "mcp.json");

function setupCursor(t: McpSetupTarget, profileFile: string, opts: McpSetupOptions): McpSetupResult {
  const file = cursorConfigFile();
  const manual = [
    `Add to ${file} under "mcpServers":`,
    `  "${t.name}": { "url": "${t.url}", "headers": { "Authorization": "Bearer <key>" } }   // <key>: the apiKey field of ${profileFile}`,
  ];
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    if (text.trim()) {
      try {
        doc = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { ok: false, message: `${file} is not plain JSON (comments?); not rewriting it automatically.`, manual };
      }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, message: `${file} is not a JSON object.`, manual };
    }
  }
  const servers = doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers) ? (doc.mcpServers as Record<string, unknown>) : {};
  const verify = [`agent mcp list   (Cursor CLI; or Cursor Settings → MCP shows "${t.name}")`];
  const entry = (key: string) => ({ url: t.url, headers: { Authorization: `Bearer ${key}` } });
  const extra = removals(t, opts);
  const absent = extra.find((r) => !(r.name in servers));
  if (absent) return { ok: false, message: `"mcpServers.${absent.name}" isn't in ${file}; nothing was changed.`, manual };
  const changes = [
    backupLine(file),
    ...extra.map((r) => removedLine(`"mcpServers.${r.name}"`, file)),
    `${t.name in servers ? "replace" : "add"} "mcpServers.${t.name}" ${t.name in servers ? "in" : "to"} ${file} (other servers are kept) and set the file to 0600, since it will hold the key:`,
    ...indent(`"${t.name}": ${JSON.stringify(entry(KEY_SHOWN), null, 2)}`),
  ];
  if (opts.dryRun) return { ok: true, dryRun: true, message: `Dry run for Cursor: nothing was changed. setup-mcp would:`, changes, verify };
  const before = structuredClone(servers);
  for (const r of extra) delete servers[r.name];
  servers[t.name] = entry(t.key);
  doc.mcpServers = servers;
  const reread = (JSON.parse(JSON.stringify(doc)) as { mcpServers: Record<string, unknown> }).mcpServers;
  const problem = checkRewrite(before, reread, { name: t.name, entry: entry(t.key) }, extra.map((r) => r.name));
  if (problem) return refused(file, problem, manual);
  const backup = backupFile(file);
  writePrivateFile(file, JSON.stringify(doc, null, 2) + "\n", { privateDir: false });
  return {
    ok: true,
    message: `Added "${t.name}" to ${file} (now mode 0600: it holds the key).${removedNote(extra)} Cursor may ask you to enable it once.`,
    backup,
    verify,
    removed: extra.map((r) => r.name),
  };
}

// ───────────── Hermes (~/.hermes/config.yaml + ~/.hermes/.env) ─────────────

/**
 * The Hermes home a bare `hermes` uses (hermes_constants.py / hermes_cli/profiles.py): $HERMES_HOME, else
 * ~/.hermes (plus HERMES_DATA_DIR_SUFFIX), switched to profiles/<name> by the sticky `active_profile` file.
 * Commands xaq runs get HERMES_HOME set to this, so they edit the same files.
 */
export function hermesHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.HERMES_HOME?.trim();
  if (set) return set.replace(/^~(?=\/|$)/, homedir());
  const root = join(homedir(), `.hermes${env.HERMES_DATA_DIR_SUFFIX ?? ""}`);
  let active = "";
  try {
    active = readFileSync(join(root, "active_profile"), "utf8").replace(/^\uFEFF/, "").trim().toLowerCase();
  } catch {
    // No sticky profile.
  }
  return active && active !== "default" && /^[a-z0-9][a-z0-9_-]*$/.test(active) ? join(root, "profiles", active) : root;
}

/**
 * Whether `mcp_servers.<name>` is on in a Hermes config.yaml ("enabled" absent, null or not a false word
 * is on, like Hermes' mcp_server_enabled). "unknown" for layouts this small block-YAML reader won't judge:
 * callers that need it on treat that as not on.
 */
export function yamlMcpServerState(yaml: string, name: string): "enabled" | "disabled" | "missing" | "unknown" {
  const lines = yaml.replace(/^\uFEFF/, "").split("\n");
  const tops = lines.flatMap((l, i) => (/^mcp_servers\s*:/.test(l) ? [i] : []));
  if (tops.length === 0) return "missing";
  if (tops.length > 1) return "unknown";
  const top = tops[0]!;
  const rest = lines[top]!.replace(/^mcp_servers\s*:/, "").replace(/\s#.*$/, "").trim();
  if (rest) return rest === "{}" || rest === "null" || rest === "~" ? "missing" : "unknown";
  let end = top + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^\s/.test(lines[end]!) || lines[end]!.startsWith("#"))) end++;
  const body = lines.slice(top + 1, end).filter((l) => l.trim() && !l.trimStart().startsWith("#"));
  if (!body.length) return "missing";
  const indent = body[0]!.match(/^(\s*)/)![1]!;
  if (!indent || /\t/.test(indent) || body.some((l) => /[&*]|<</.test(l.split("#")[0]!))) return "unknown";
  const key = new RegExp(`^${indent}(["']?)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1\\s*:(.*)$`);
  const starts = body.flatMap((l, i) => (key.test(l) ? [i] : []));
  if (starts.length === 0) return "missing";
  if (starts.length > 1) return "unknown";
  const inline = key.exec(body[starts[0]!]!)![2]!.replace(/\s#.*$/, "").trim();
  if (inline) return "unknown"; // flow style ({ url: … })
  const own: string[] = [];
  for (const l of body.slice(starts[0]! + 1)) {
    if (l.match(/^(\s*)/)![1]!.length <= indent.length) break;
    own.push(l);
  }
  if (!own.length) return "unknown";
  const childIndent = own[0]!.match(/^(\s*)/)![1]!.length;
  const enabled = own.filter((l) => l.match(/^(\s*)/)![1]!.length === childIndent && /^\s*["']?enabled["']?\s*:/.test(l));
  if (enabled.length > 1) return "unknown";
  if (!enabled.length) return "enabled";
  const value = enabled[0]!.replace(/^\s*["']?enabled["']?\s*:/, "").replace(/\s#.*$/, "").trim().replace(/^["']|["']$/g, "").toLowerCase();
  return ["false", "0", "no", "off"].includes(value) ? "disabled" : "enabled";
}
export const hermesEnvVar = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_API_KEY";

/**
 * Inserts or replaces `mcp_servers.<name>` in a YAML document without a YAML library, handling the
 * common block-style layout. Returns null for anything unusual (flow style, anchors, odd indentation).
 */
export function upsertYamlServer(yaml: string, name: string, entry: string[]): string | null {
  const lines = yaml.split("\n");
  const top = lines.findIndex((l) => /^mcp_servers\s*:/.test(l));
  const block = (indent: string) => [`${indent}${name}:`, ...entry.map((e) => `${indent}${indent}${e}`)];
  if (top < 0) {
    const base = yaml.replace(/\s*$/, "");
    return `${base ? `${base}\n\n` : ""}mcp_servers:\n${block("  ").join("\n")}\n`;
  }
  const rest = lines[top]!.replace(/^mcp_servers\s*:/, "").replace(/#.*$/, "").trim();
  if (rest && rest !== "{}" && rest !== "null" && rest !== "~") return null;
  if (rest) lines[top] = "mcp_servers:";
  // The block runs until the next non-blank line at column 0.
  let end = top + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^\s/.test(lines[end]!))) end++;
  const body = lines.slice(top + 1, end);
  const firstChild = body.find((l) => l.trim() && !l.trimStart().startsWith("#"));
  const indent = firstChild ? firstChild.match(/^(\s*)/)![1]! : "  ";
  if (!indent || /\t/.test(indent)) return null;
  // Comments inside the old entry never end it early (cutEntries), so none of its lines can land elsewhere.
  const cut = cutEntries(body, indent, [name]);
  if (!cut) return null;
  const { kept } = cut;
  const insert = block(indent);
  return [...lines.slice(0, top + 1), ...insert, ...kept, ...lines.slice(end)].join("\n");
}

function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*(?:export\\s+)?${escapeRe(key)}\\s*=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  const base = text.replace(/\s*$/, "");
  return `${base ? `${base}\n` : ""}${line}\n`;
}

function setupHermes(t: McpSetupTarget, profileFile: string, opts: McpSetupOptions): McpSetupResult {
  const home = hermesHome();
  const configFile = join(home, "config.yaml");
  const envFile = join(home, ".env");
  const envVar = hermesEnvVar(t.name);
  const entry = [`url: ${JSON.stringify(t.url)}`, `headers:`, `  Authorization: "Bearer \${${envVar}}"`];
  const manual = [
    `Add to ${configFile}:`,
    `  mcp_servers:`,
    `    ${t.name}:`,
    ...entry.map((e) => `      ${e}`),
    `and to ${envFile}:  ${envVar}=<key>   (<key>: the apiKey field of ${profileFile})`,
    `then check it with: hermes mcp test ${t.name}`,
  ];
  const current = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  const extra = removals(t, opts);
  const blk = mcpServersBlock(current);
  if (blk && hasAnchors(current.split("\n").slice(blk.start + 1, blk.end))) {
    return {
      ok: false,
      message: `${configFile} uses YAML anchors, aliases or merge keys (&, *, <<) under mcp_servers; not rewriting it automatically. Nothing was changed.`,
      manual,
    };
  }
  const upserted = upsertYamlServer(current, t.name, entry);
  // Removed in the same write, before anything touches the disk: one entry we can't cut out cleanly changes nothing.
  const next = upserted === null ? null : removeYamlServers(upserted, extra.map((r) => r.name));
  if (upserted !== null && next === null) {
    return { ok: false, message: `Couldn't remove ${extra.map((r) => `"${r.name}"`).join(", ")} from ${configFile} safely; nothing was changed.`, manual };
  }
  if (next === null) return { ok: false, message: `${configFile} uses a layout we won't rewrite automatically.`, manual };
  {
    const ours = { url: t.url, headers: { Authorization: `Bearer \${${envVar}}` } };
    const problem = checkRewrite(readMcpServers(current), readMcpServers(next), { name: t.name, entry: ours }, extra.map((r) => r.name));
    if (problem) return refused(configFile, problem, manual);
  }
  const verify = [`hermes mcp test ${t.name}`];
  const changes = [
    backupLine(configFile),
    backupLine(envFile),
    ...extra.map((r) => removedLine(`"mcp_servers.${r.name}"`, configFile)),
    `add (or replace) "mcp_servers.${t.name}" in ${configFile} (0600):`,
    ...indent(["mcp_servers:", `  ${t.name}:`, ...entry.map((e) => `    ${e}`)].join("\n")),
    `set ${envVar}=${KEY_SHOWN} in ${envFile} (0600; Hermes' place for secrets)`,
  ];
  if (opts.dryRun) return { ok: true, dryRun: true, message: `Dry run for Hermes: nothing was changed. setup-mcp would:`, changes, verify };
  const envCurrent = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const backup = backupFile(configFile);
  const envBackup = backupFile(envFile);
  writePrivateFile(envFile, upsertEnvLine(envCurrent, envVar, t.key), { privateDir: false });
  writePrivateFile(configFile, next.endsWith("\n") ? next : `${next}\n`, { privateDir: false });
  return {
    ok: true,
    message: `Added "${t.name}" to ${configFile}; the key is in ${envFile} as ${envVar} (0600).${removedNote(extra)}`,
    backup: [backup, envBackup].filter(Boolean).join(", ") || null,
    verify,
    removed: extra.map((r) => r.name),
  };
}
