// `xaq settings attachment-dirs list | add <dir> | remove <dir>`: the directories agents may attach files from
// (Settings.attachmentDirs), run on xaq's machine through the daemon's /api/settings over the local admin channel
// (server/connections-cli/admin.ts), so the daemon's own checks and audit apply. Admin only: agents can't reach it.

import { resolve } from "node:path";
import type { Command } from "commander";
import pc from "picocolors";
import type { Settings } from "../shared/types.ts";
import { LEGACY_PRODUCT } from "./brand.ts";
import { resolveDataDir } from "./config.ts";
import { AdminApiError, type AdminChannel } from "./connections-cli/admin.ts";
import { safeText } from "./listen/ui.ts";
import { NPX } from "./listen/version.ts";

export interface SettingsCliDeps {
  channel: Pick<AdminChannel, "request">;
  print(line?: string): void;
  /** Where a relative directory is resolved (default: this process's cwd). */
  cwd?: string;
}

const show = (dirs: string[], print: (line?: string) => void) => {
  if (!dirs.length) {
    print(`No directories are allowed: agents can't attach files by path. Allow one: ${NPX} settings attachment-dirs add <dir>`);
    return;
  }
  print("Agents may attach files from:");
  for (const d of dirs) print(`  ${safeText(d, 500)}`);
};

const save = async (deps: SettingsCliDeps, dirs: string[]): Promise<string[]> => {
  try {
    return (await deps.channel.request<Settings>("PATCH", "/api/settings", { attachmentDirs: dirs })).attachmentDirs;
  } catch (err) {
    if (err instanceof AdminApiError && err.hint) throw new Error(`${err.message}. ${err.hint}`);
    throw err;
  }
};

const current = async (deps: SettingsCliDeps) => (await deps.channel.request<Settings>("GET", "/api/settings")).attachmentDirs ?? [];

export async function listAttachmentDirs(deps: SettingsCliDeps): Promise<number> {
  show(await current(deps), deps.print);
  return 0;
}

export async function addAttachmentDir(dir: string, deps: SettingsCliDeps): Promise<number> {
  // Relative to this terminal's directory, not the daemon's.
  const abs = resolve(deps.cwd ?? process.cwd(), dir);
  const dirs = await current(deps);
  if (dirs.includes(abs)) {
    deps.print(`${pc.green("✔")} ${safeText(abs, 500)} is already allowed.`);
    return 0;
  }
  const saved = await save(deps, [...dirs, abs]);
  deps.print(`${pc.green("✔")} Agents may now attach files from ${safeText(abs, 500)} (xaq's own files and key-like files are always refused).`);
  if (saved.length > 1) show(saved, deps.print);
  return 0;
}

export async function removeAttachmentDir(dir: string, deps: SettingsCliDeps): Promise<number> {
  const abs = resolve(deps.cwd ?? process.cwd(), dir);
  const dirs = await current(deps);
  if (!dirs.includes(abs)) {
    deps.print(pc.yellow(`${safeText(abs, 500)} isn't allowed.`));
    show(dirs, deps.print);
    return 1;
  }
  const saved = await save(deps, dirs.filter((d) => d !== abs));
  deps.print(`${pc.green("✔")} Removed ${safeText(abs, 500)}.`);
  show(saved, deps.print);
  return 0;
}

const GROUP = "Run xaq:";

export function registerSettingsCommands(program: Command): void {
  const dataOption = (cmd: Command) => cmd.option("-d, --data <dir>", `xaq's data directory (default ~/.xaq, or an existing ~/.${LEGACY_PRODUCT}; env XAQ_DATA)`);
  const withChannel = async (o: { data?: string }, run: (deps: SettingsCliDeps) => Promise<number>) => {
    const { CLEANUP_SIGNALS, openAdminChannel } = await import("./connections-cli/admin.ts");
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
      process.exitCode = await run({ channel, print: (line = "") => console.log(line) });
    } finally {
      for (const [sig, h] of handlers) process.removeListener(sig, h);
      channel.close();
    }
  };

  const settings = program.command("settings").description("change xaq's settings from this machine (the rest are in the console under Settings)").helpGroup(GROUP);
  const dirs = settings
    .command("attachment-dirs")
    .description("directories on this machine agents may attach files from by path (none by default: path attachments are off)")
    .addHelpText(
      "after",
      `
Files in subdirectories count. xaq's own data and configuration, and files named like keys, databases or .env
files, are refused even inside an allowed directory. The console has the same list (Settings → Attachments from files).

Examples:
  ${NPX} settings attachment-dirs add ~/Documents/outgoing
  ${NPX} settings attachment-dirs list
  ${NPX} settings attachment-dirs remove ~/Documents/outgoing`,
    );
  dataOption(dirs.command("list").description("list the allowed directories")).action((o: { data?: string }) => withChannel(o, (deps) => listAttachmentDirs(deps)));
  dataOption(dirs.command("add").description("allow a directory (it must exist)").argument("<dir>", "the directory; relative paths are resolved from here")).action(
    (dir: string, o: { data?: string }) => withChannel(o, (deps) => addAttachmentDir(dir, deps)),
  );
  dataOption(dirs.command("remove").description("stop allowing a directory").argument("<dir>", "the directory, as listed")).action((dir: string, o: { data?: string }) =>
    withChannel(o, (deps) => removeAttachmentDir(dir, deps)),
  );
}
