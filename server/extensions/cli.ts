// `xaq ext add | list | update | remove`: run on xaq's machine, through the daemon's /api/extensions over the local
// admin channel (server/connections-cli/admin.ts), so the daemon's own checks (and the broker's usedBy) apply.

import type { Command } from "commander";
import pc from "picocolors";
import type { ExtensionErrorBody, ExtensionResolveResult, ExtensionUpdateResult, ExtensionView } from "../../shared/extensions.ts";
import { LEGACY_PRODUCT } from "../brand.ts";
import { resolveDataDir } from "../config.ts";
import { AdminApiError, type AdminChannel } from "../connections-cli/admin.ts";
import type { Prompter } from "../connections-cli/prompt.ts";
import { safeText } from "../listen/ui.ts";
import { NPX } from "../listen/version.ts";
import { parseSource } from "./sources.ts";

const enc = encodeURIComponent;

/** The admin extensions API as the CLI uses it. */
export class ExtensionsApi {
  constructor(readonly channel: Pick<AdminChannel, "request">) {}
  list(): Promise<ExtensionView[]> {
    return this.channel.request("GET", "/api/extensions");
  }
  resolve(source: string): Promise<ExtensionResolveResult> {
    return this.channel.request("POST", "/api/extensions/resolve", { source });
  }
  install(source: string, confirmThirdParty: boolean, expectIntegrity: string): Promise<ExtensionView> {
    return this.channel.request("POST", "/api/extensions", { source, confirmThirdParty, expectIntegrity });
  }
  update(name: string, body: { confirm: boolean; expectIntegrity?: string }): Promise<ExtensionUpdateResult> {
    return this.channel.request("POST", `/api/extensions/${enc(name)}/update`, body);
  }
  remove(name: string, force: boolean): Promise<void> {
    return this.channel.request("DELETE", `/api/extensions/${enc(name)}${force ? "?force=true" : ""}`);
  }
}

export interface ExtDeps {
  api: ExtensionsApi;
  prompter: Prompter;
  /** Where a relative directory is resolved (default: this process's cwd). */
  cwd?: string;
}

const shortCommit = (c: string | null) => (c ? c.slice(0, 12) : "(directory)");
const origin = (e: Pick<ExtensionView, "official">) => (e.official ? pc.green("official") : pc.yellow("third-party"));

function describe(p: Prompter, e: ExtensionView): void {
  p.print(`${pc.bold(safeText(e.displayName, 60))} ${pc.dim(`(${e.name})`)} ${safeText(e.version, 40)}, kind ${e.kind}, ${origin(e)}`);
  p.print(`  source     ${safeText(e.source, 200)}`);
  p.print(`  commit     ${shortCommit(e.commit)}`);
  p.print(`  integrity  ${e.integrity}`);
  if (e.kind === "code") p.print(`  network    ${e.network.length ? e.network.map((h) => safeText(h, 100)).join(", ") : "none declared"}`);
}

function printWarnings(p: Prompter, warnings: string[]): void {
  if (!warnings.length) return;
  p.print("");
  for (const w of warnings) p.print(pc.yellow(`! ${safeText(w, 600)}`));
  p.print("");
}

/** An API error body (a 409 that carries usedBy / warnings), or null. */
const errorBody = (err: unknown): ExtensionErrorBody | null => (err instanceof AdminApiError ? ((err.body as ExtensionErrorBody | null) ?? null) : null);

export async function addExtension(input: string, deps: ExtDeps): Promise<number> {
  const { api, prompter: p } = deps;
  // A directory is resolved here, against this terminal's cwd (and ~), not the daemon's: it gets the absolute path.
  const spec = parseSource(input, { cwd: deps.cwd ?? process.cwd() });
  const source = spec.type === "local" ? spec.path : input.trim();
  p.print(`Fetching ${pc.cyan(safeText(source, 200))}…`);
  const { candidate, warnings, installed } = await api.resolve(source);
  describe(p, candidate);
  if (installed) {
    if (installed.integrity === candidate.integrity) {
      p.print(`${pc.green("✔")} ${candidate.name} ${installed.version} is already installed.`);
      return 0;
    }
    p.print(pc.yellow(`${candidate.name} is already installed (${installed.version}, ${shortCommit(installed.commit)}). To change it: ${NPX} ext update ${candidate.name}`));
    return 1;
  }
  if (!candidate.official) {
    printWarnings(p, warnings);
    if (!(await p.confirm(`Install the third-party extension ${candidate.name}?`, false))) {
      p.print("Nothing was installed.");
      return 0;
    }
  }
  const ext = await api.install(source, !candidate.official, candidate.integrity);
  p.print(`${pc.green("✔")} Installed ${ext.name} ${ext.version}${ext.commit ? ` (${shortCommit(ext.commit)})` : ""}.`);
  return 0;
}

export async function listExtensions(deps: ExtDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const all = await api.list();
  if (!all.length) {
    p.print(`No extensions installed. Add one: ${NPX} ext add <name|github-url|git-url|./dir>`);
    return 0;
  }
  const w = Math.max(4, ...all.map((e) => e.name.length));
  const v = Math.max(7, ...all.map((e) => safeText(e.version, 20).length));
  p.print(pc.dim(`${"NAME".padEnd(w)}  ${"VERSION".padEnd(v)}  ${"COMMIT".padEnd(12)}  ${"ORIGIN".padEnd(11)}  ${"USED BY".padEnd(16)}  SOURCE`));
  for (const e of all) {
    const used = e.usedBy.length ? safeText(e.usedBy.join(", "), 40) : "-";
    p.print(
      `${e.name.padEnd(w)}  ${safeText(e.version, 20).padEnd(v)}  ${shortCommit(e.commit).padEnd(12)}  ${(e.official ? "official" : "third-party").padEnd(11)}  ${used.padEnd(16)}  ${safeText(e.source, 120)}`,
    );
  }
  return 0;
}

export async function updateExtension(name: string, deps: ExtDeps): Promise<number> {
  const { api, prompter: p } = deps;
  p.print(`Checking ${pc.cyan(name)} for an update…`);
  const preview = await api.update(name, { confirm: false });
  if (!preview.update) {
    p.print(`${pc.green("✔")} ${name} is up to date.`);
    return 0;
  }
  const { from, to, warnings } = preview.update;
  const row = (label: string, a: string, b: string) => p.print(`  ${label.padEnd(10)} ${a}  →  ${a === b ? pc.dim(b) : pc.bold(b)}`);
  p.print(`Update ${pc.bold(name)}:`);
  row("version", safeText(from.version, 40), safeText(to.version, 40));
  row("commit", shortCommit(from.commit), shortCommit(to.commit));
  row("integrity", from.integrity, to.integrity);
  if (from.kind !== to.kind) row("kind", from.kind, to.kind);
  const hosts = (e: ExtensionView) => (e.network.length ? e.network.map((h) => safeText(h, 100)).join(", ") : "none");
  if (to.kind === "code" && hosts(from) !== hosts(to)) row("network", hosts(from), hosts(to));
  printWarnings(p, warnings);
  if (from.usedBy.length) p.print(pc.dim(`Used by ${from.usedBy.join(", ")}: they switch to the new version.`));
  if (!(await p.confirm(`Install ${name} ${safeText(to.version, 40)}?`, false))) {
    p.print("Nothing was changed.");
    return 0;
  }
  const done = await api.update(name, { confirm: true, expectIntegrity: to.integrity });
  if (!done.update) {
    p.print(`${pc.green("✔")} ${name} is up to date.`);
    return 0;
  }
  p.print(`${pc.green("✔")} Updated ${name} to ${safeText(done.update.to.version, 40)}${done.update.to.commit ? ` (${shortCommit(done.update.to.commit)})` : ""}.`);
  return 0;
}

export async function removeExtension(name: string, flags: { force?: boolean }, deps: ExtDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const ext = (await api.list()).find((e) => e.name === name);
  if (!ext) throw new Error(`${name} isn't installed.`);
  if (ext.usedBy.length && !flags.force) {
    p.print(pc.yellow(`${name} is used by ${ext.usedBy.join(", ")}.`));
    p.print(`Remove those connections first (${NPX} connections remove <name>), or pass --force, which disables them (their credentials stay until you remove them).`);
    return 1;
  }
  const what = ext.usedBy.length ? ` and disable ${ext.usedBy.join(", ")}` : "";
  if (!(await p.confirm(`Remove the extension ${name}${what}?`, false))) return 0;
  try {
    await api.remove(name, !!flags.force);
  } catch (err) {
    const body = errorBody(err);
    if (body?.error.code === "in_use") {
      p.print(pc.yellow(`${name} is used by ${(body.usedBy ?? []).join(", ")}. Pass --force to disable them and remove it.`));
      return 1;
    }
    throw err;
  }
  p.print(`${pc.green("✔")} Removed ${name}.`);
  return 0;
}

const GROUP = "MCP connections (on xaq's machine):";

export function registerExtensionCommands(program: Command): void {
  const dataOption = (cmd: Command) => cmd.option("-d, --data <dir>", `xaq's data directory (default ~/.xaq, or an existing ~/.${LEGACY_PRODUCT}; env XAQ_DATA)`);
  const withApi = async (o: { data?: string; yes?: boolean }, run: (deps: ExtDeps) => Promise<number>) => {
    const { CLEANUP_SIGNALS, openAdminChannel } = await import("../connections-cli/admin.ts");
    const { TerminalPrompter } = await import("../connections-cli/prompt.ts");
    const channel = openAdminChannel({ dataDir: resolveDataDir(o.data, { quiet: true }) });
    const handlers = CLEANUP_SIGNALS.map((sig) => {
      const h = () => {
        channel.close();
        process.exit(sig === "SIGINT" ? 130 : 128 + (sig === "SIGTERM" ? 15 : 1));
      };
      process.once(sig, h);
      return [sig, h] as const;
    });
    try {
      process.exitCode = await run({ api: new ExtensionsApi(channel), prompter: new TerminalPrompter(!!o.yes) });
    } finally {
      for (const [sig, h] of handlers) process.removeListener(sig, h);
      channel.close();
    }
  };

  const ext = program
    .command("ext")
    .description("extensions: the integrations xaq can connect to (Notion, WHOOP, T3 Code, …), from the official registry or elsewhere")
    .summary("add, list, update or remove extensions")
    .helpGroup(GROUP);

  dataOption(
    ext
      .command("add")
      .description("install an extension: a registry name, a GitHub URL, another git URL (#ref, #ref:path), or a ./directory")
      .argument("<name|url|path>", "e.g. notion, https://github.com/you/repo/tree/main/ext, ./my-extension"),
  )
    .option("-y, --yes", "install a third-party extension without asking (the warning is still printed)")
    .addHelpText(
      "after",
      `
Anything that isn't the official registry (wynn-dev/xaq-extensions) is third-party: you see its kind, its declared
network hosts and its source first, and confirm. A code extension runs on this machine with network access.

Examples:
  ${NPX} ext add notion
  ${NPX} ext add https://github.com/you/xaq-ext/tree/main/extensions/thing
  ${NPX} ext add https://git.example.com/you/ext.git#v1.2.0
  ${NPX} ext add ./my-extension`,
    )
    .action((source: string, o: { data?: string; yes?: boolean }) => withApi(o, (deps) => addExtension(source, deps)));

  dataOption(ext.command("list").description("list installed extensions: version, commit, official or third-party, and the connections using each")).action((o: { data?: string }) =>
    withApi(o, (deps) => listExtensions(deps)),
  );

  dataOption(ext.command("update").description("show what an update changes (version, commit, integrity) and install it on confirmation").argument("<name>", "the extension's name"))
    .option("-y, --yes", "install the update without asking")
    .action((name: string, o: { data?: string; yes?: boolean }) => withApi(o, (deps) => updateExtension(name, deps)));

  dataOption(ext.command("remove").description("remove an extension (refused while connections use it, unless --force)").argument("<name>", "the extension's name"))
    .option("--force", "also when connections use it: they're disabled (credentials stay until you remove them)")
    .option("-y, --yes", "don't ask")
    .action((name: string, o: { data?: string; yes?: boolean; force?: boolean }) => withApi(o, (deps) => removeExtension(name, o, deps)));
}
