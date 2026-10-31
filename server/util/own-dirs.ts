// Where secrets live on this machine, which files are never attached from (server/mail/local-files.ts) and which no
// attachment directory may be, contain or sit inside (Settings.attachmentDirs, server/settings.ts):
// - xaq's own directories: the daemon's data directory (the configured one, ~/.xaq, ~/.agentinbox) and the CLI's XDG
//   directories (config with the agents' profiles and MCP headers, state, data), both where XDG_* points now and at
//   their default locations: a daemon run by launchd or systemd may not see the user's XDG_CONFIG_HOME;
// - the service files xaq writes (launchd plists, systemd units): their environment may carry XAQ_MASTER_KEY;
// - the MCP configs `setup-mcp` writes with plaintext agent keys (Codex, Cursor, Claude Code, Hermes) and their
//   *.xaq-backup-* copies, with the agent tools' own credential directories;
// - common credential stores (SSH, AWS, GitHub CLI, GnuPG, macOS keychains, Kubernetes, Docker, .netrc, .npmrc).
// Nothing here reads these files; paths are computed from the environment.

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LEGACY_PRODUCT, PRODUCT } from "../brand.ts";
import { legacyDataDir, newDataDir } from "../config.ts";
import { claudeConfigFile } from "../listen/mcpsetup.ts";

/** Case-insensitive file systems (macOS, Windows by default): paths are compared lower-cased there. */
const FOLD = process.platform === "darwin" || process.platform === "win32";
export const normPath = (p: string): string => (FOLD ? p.toLowerCase() : p);

/** `child` is `dir` or below it. Both absolute and normalised. */
export function within(dir: string, child: string): boolean {
  const rel = relative(normPath(dir), normPath(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** An XDG base directory from the environment (absolute only, as the spec says), else null. */
const xdgEnv = (env: NodeJS.ProcessEnv, name: string): string | null => {
  const v = env[name];
  return v && v.startsWith("/") ? v : null;
};

/**
 * The daemon's data directory (the configured one, ~/.xaq and the pre-rename ~/.agentinbox) and the CLI's XDG
 * directories (config, state, data; `xaq`, `agentinbox` and `xaq-cli` under each, see server/listen/paths.ts), under
 * both the XDG_* values this process sees and the default locations.
 */
export function ownDirs(dataDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  const bases = [
    xdgEnv(env, "XDG_CONFIG_HOME"),
    join(home, ".config"),
    xdgEnv(env, "XDG_STATE_HOME"),
    join(home, ".local", "state"),
    xdgEnv(env, "XDG_DATA_HOME"),
    join(home, ".local", "share"),
  ].filter((b): b is string => !!b);
  const names = [PRODUCT, LEGACY_PRODUCT, `${PRODUCT}-cli`];
  return [...new Set([resolve(dataDir), newDataDir(), legacyDataDir(), ...bases.flatMap((b) => names.map((n) => join(b, n)))])];
}

/** Secret-holding directories and files beyond xaq's own directories. */
export interface ProtectedPaths {
  /** Nothing at or below these is attached. */
  dirs: string[];
  /** These files, and their `<file>.xaq-backup-*` copies, are never attached. */
  files: string[];
}

/** Every directory and file in the header comment, for this user and environment. */
export function protectedPaths(dataDir: string, env: NodeJS.ProcessEnv = process.env): ProtectedPaths {
  const home = homedir();
  const h = (...p: string[]) => join(home, ...p);
  const configHome = xdgEnv(env, "XDG_CONFIG_HOME");
  const hermesRoot = env.HERMES_HOME?.trim() ? resolve(env.HERMES_HOME.trim().replace(/^~(?=\/|$)/, home)) : h(`.hermes${env.HERMES_DATA_DIR_SUFFIX ?? ""}`);
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() ? resolve(env.CLAUDE_CONFIG_DIR.trim()) : null;
  const codexDir = env.CODEX_HOME || h(".codex");
  const dirs = [
    ...ownDirs(dataDir, env),
    // Service files: launchd agents (all of them: their EnvironmentVariables may hold secrets), systemd units.
    h("Library", "LaunchAgents"),
    h(".config", "systemd", "user"),
    ...(configHome ? [join(configHome, "systemd", "user")] : []),
    "/etc/systemd/system",
    "/Library/LaunchDaemons",
    // Agent tools that keep MCP keys and their own credentials there.
    codexDir,
    h(".codex"),
    h(".cursor"),
    hermesRoot,
    h(".hermes"),
    h(".claude"),
    ...(claudeDir ? [claudeDir] : []),
    // Credential stores.
    h(".ssh"),
    h(".aws"),
    h(".config", "gh"),
    ...(configHome ? [join(configHome, "gh")] : []),
    h(".gnupg"),
    h("Library", "Keychains"),
    h(".kube"),
    h(".docker"),
  ];
  const files = [
    join(codexDir, "config.toml"),
    h(".cursor", "mcp.json"),
    claudeConfigFile(),
    h(".claude.json"),
    join(hermesRoot, "config.yaml"),
    join(hermesRoot, ".env"),
    h(".netrc"),
    h(".npmrc"),
    h(".docker", "config.json"),
  ];
  return { dirs: [...new Set(dirs.map((d) => resolve(d)))], files: [...new Set(files.map((f) => resolve(f)))] };
}
