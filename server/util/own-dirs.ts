// xaq's own directories on this machine, which files are never attached from (server/mail/local-files.ts) and
// which can't be allowed for attachments (Settings.attachmentDirs).

import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LEGACY_PRODUCT, PRODUCT } from "../brand.ts";
import { legacyDataDir, newDataDir } from "../config.ts";

/** Case-insensitive file systems (macOS, Windows by default): paths are compared lower-cased there. */
const FOLD = process.platform === "darwin" || process.platform === "win32";
export const normPath = (p: string): string => (FOLD ? p.toLowerCase() : p);

/** `child` is `dir` or below it. Both absolute and normalised. */
export function within(dir: string, child: string): boolean {
  const rel = relative(normPath(dir), normPath(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * The daemon's data directory (the configured one, ~/.xaq and the pre-rename ~/.agentinbox) and the CLI's
 * XDG directories (config, state, data; `xaq`, `agentinbox` and `xaq-cli` under each, see server/listen/paths.ts).
 */
export function ownDirs(dataDir: string): string[] {
  const xdg = (env: string, fallback: string) => {
    const v = process.env[env];
    return v && v.startsWith("/") ? v : join(homedir(), fallback);
  };
  const bases = [xdg("XDG_CONFIG_HOME", ".config"), xdg("XDG_STATE_HOME", ".local/state"), xdg("XDG_DATA_HOME", ".local/share")];
  const names = [PRODUCT, LEGACY_PRODUCT, `${PRODUCT}-cli`];
  return [...new Set([resolve(dataDir), newDataDir(), legacyDataDir(), ...bases.flatMap((b) => names.map((n) => join(b, n)))])];
}
