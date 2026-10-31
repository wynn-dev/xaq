import { homedir } from "node:os";
import { join } from "node:path";
import { PRODUCT } from "../brand.ts";

/**
 * Agent-side locations (the machine running `connect` / `listen`, not the daemon), XDG on Linux and macOS
 * alike. One pairing per machine:
 *   config  $XDG_CONFIG_HOME/xaq  (~/.config/xaq)        profiles/default.json (0600), bin/, mcp/
 *   state   $XDG_STATE_HOME/xaq   (~/.local/state/xaq)   listen/default/{listen.log,status.json,work/}
 *   data    $XDG_DATA_HOME/xaq    (~/.local/share/xaq)   app/ (stable install the service runs)
 * Another, unrelated program is also called xaq and may own `~/.config/xaq`: we only add our own paths there.
 */

const xdg = (envVar: string, fallback: string) => {
  const v = process.env[envVar];
  // The XDG spec says relative paths are invalid and must be ignored.
  return v && v.startsWith("/") ? v : join(homedir(), fallback);
};

export const configDir = () => join(xdg("XDG_CONFIG_HOME", ".config"), PRODUCT);
export const stateDir = () => join(xdg("XDG_STATE_HOME", ".local/state"), PRODUCT);
export const dataDir = () => join(xdg("XDG_DATA_HOME", ".local/share"), PRODUCT);

export const profilePath = () => join(configDir(), "profiles", "default.json");
export const listenStateDir = () => join(stateDir(), "listen", "default");
export const logPath = () => join(listenStateDir(), "listen.log");
/** `listen --backfill` and `--dry-run` log separately, so they can run next to the listener without both rotating one file. */
export const oneOffLogPath = () => join(listenStateDir(), "one-off.log");
export const statusPath = () => join(listenStateDir(), "status.json");
/** Working directory for --exec commands: private (0700), so no planted CLAUDE.md, .mcp.json or hooks apply. */
export const workDir = () => join(listenStateDir(), "work");
/** The listener service's stable install, staged and swapped like the daemon's `<data>/app`. */
export const listenAppDir = () => join(dataDir(), "app");
