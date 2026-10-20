import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { envVar, LEGACY_PRODUCT, pickDir, PRODUCT, underService } from "./brand.ts";

export interface Config {
  dataDir: string;
  dbPath: string;
  masterKeyPath: string;
  host: string;
  port: number;
  /** Dev mode: console served by Vite on :5173, server only serves /api, /mcp, /oauth. */
  dev: boolean;
  /** Honor X-Forwarded-For / X-Forwarded-Proto (behind a reverse proxy). */
  trustProxy: boolean;
  /** Running under `xaq service install` (XAQ_SERVICE=1 in the unit/plist; AGENTINBOX_SERVICE=1 in units from before the rename). */
  service: boolean;
  version: string;
  /**
   * Base URLs for Google APIs. Overridable so tests can point at test/fake-google.ts.
   * Defaults: https://oauth2.googleapis.com, https://accounts.google.com, https://gmail.googleapis.com, https://pubsub.googleapis.com,
   * https://www.googleapis.com (Calendar: paths start with /calendar/v3), https://www.googleapis.com (Drive: /drive/v3).
   */
  google: { oauthBase: string; authBase: string; gmailBase: string; pubsubBase: string; calendarBase: string; driveBase: string };
}

export interface ConfigInput {
  dataDir?: string;
  host?: string;
  port?: number;
  dev?: boolean;
}

export const DEFAULT_PORT = 8425;

/** New installs keep their data here. */
export const newDataDir = () => join(homedir(), `.${PRODUCT}`);
/** Where installs from before the rename keep theirs; still used unless `~/.xaq` holds our files. */
export const legacyDataDir = () => join(homedir(), `.${LEGACY_PRODUCT}`);
/** Files only our daemon creates in its data directory: a `~/.xaq` holding one is ours. */
const DATA_MARKERS = [`${PRODUCT}.db`, `${LEGACY_PRODUCT}.db`, "master.key", `${PRODUCT}.lock`, `${LEGACY_PRODUCT}.lock`];
const pickDataDir = () => pickDir(homedir(), DATA_MARKERS, { dot: true });

/**
 * The data directory when neither --data nor XAQ_DATA / AGENTINBOX_DATA says: `~/.xaq` when it holds our
 * files; else an existing `~/.agentinbox` (from before the rename); else `~/.xaq`. A `~/.xaq` without our
 * files belongs to another program called xaq: then our files only go in beside its own (see restrictDir).
 * Nothing is moved: master.key stays put.
 */
export const defaultDataDir = () => resolve(pickDataDir().dir);

let toldLegacy = false;

/**
 * The data directory: --data, else XAQ_DATA (AGENTINBOX_DATA), else the default. Says once per process
 * when the default is the pre-rename `~/.agentinbox` (unless `quiet`).
 */
export function resolveDataDir(flag?: string, opts: { quiet?: boolean } = {}): string {
  const given = flag ?? (envVar("DATA") || undefined);
  if (given !== undefined) return resolve(given);
  const { dir, kind } = pickDataDir();
  if (kind === "legacy" && !opts.quiet && !toldLegacy) {
    toldLegacy = true;
    process.stderr.write(`${PRODUCT}: using the existing data directory ${dir} (from before agentinbox was renamed to ${PRODUCT}; new installs use ${newDataDir()}).\n`);
  }
  return resolve(dir);
}

/**
 * The database, lock and log files in a data directory: `xaq.*`, or in a data directory from before the
 * rename (it has agentinbox.db and no xaq.db) `agentinbox.*`. The lock keeps the name an older
 * agentinbox (from before the rename) still running on that directory uses, so the two never run at once.
 */
export function dataFiles(dataDir: string): { db: string; lock: string; log: string } {
  const legacy = !existsSync(join(dataDir, `${PRODUCT}.db`)) && existsSync(join(dataDir, `${LEGACY_PRODUCT}.db`));
  const base = legacy ? LEGACY_PRODUCT : PRODUCT;
  return { db: join(dataDir, `${base}.db`), lock: join(dataDir, `${base}.lock`), log: join(dataDir, `${base}.log`) };
}

export function loadConfig(input: ConfigInput = {}, version = "0.0.0"): Config {
  const dataDir = resolveDataDir(input.dataDir);
  // Only a directory that already had files in it can have exposed anything.
  const existed = hasFiles(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // A ~/.xaq that also holds another program's files (it is called xaq too) isn't ours to chmod.
  if (!hasForeignFiles(dataDir)) restrictDir(dataDir, existed);
  return {
    dataDir,
    dbPath: dataFiles(dataDir).db,
    masterKeyPath: join(dataDir, "master.key"),
    host: input.host ?? process.env.HOST ?? "0.0.0.0",
    port: input.port ?? (process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT),
    dev: input.dev ?? false,
    trustProxy: process.env.TRUST_PROXY === "1",
    service: underService(),
    version,
    google: {
      oauthBase: envVar("GOOGLE_OAUTH_BASE") ?? "https://oauth2.googleapis.com",
      authBase: envVar("GOOGLE_AUTH_BASE") ?? "https://accounts.google.com",
      gmailBase: envVar("GOOGLE_GMAIL_BASE") ?? "https://gmail.googleapis.com",
      pubsubBase: envVar("GOOGLE_PUBSUB_BASE") ?? "https://pubsub.googleapis.com",
      calendarBase: envVar("GOOGLE_CALENDAR_BASE") ?? "https://www.googleapis.com",
      driveBase: envVar("GOOGLE_DRIVE_BASE") ?? "https://www.googleapis.com",
    },
  };
}

/** What our daemon keeps in its data directory (names only; nothing is read). */
// (install.lock: the listeners' shared install directory holds app* and that lock; same rule there.)
// (extensions, extension-state: installed extensions and code extensions' state, docs/EXTENSIONS.md.)
const OWN_ENTRY = /^(?:(?:xaq|agentinbox)\.(?:db(?:-wal|-shm|-journal)?|lock|log)|master\.key|setup-token|service\.env|app(?:\.new|\.old)?|install\.lock|units|backups?|extensions|extension-state)$/;

/** Whether the directory holds anything our daemon didn't put there. */
export const hasForeignFiles = (dir: string) => {
  try {
    return readdirSync(dir).some((n) => !OWN_ENTRY.test(n));
  } catch {
    return false;
  }
};

const hasFiles = (dir: string) => {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
};

/**
 * An existing data dir may be group/world accessible (umask, manual mkdir): tighten it to owner-only.
 * Only a directory that already held files gets a notice; a new (or empty) one is tightened silently.
 */
function restrictDir(dir: string, existed: boolean): void {
  try {
    if (process.platform !== "win32" && statSync(dir).mode & 0o077) {
      chmodSync(dir, 0o700);
      if (existed) process.stderr.write(`xaq: made ${dir} private to your user (it was readable by other users).\n`);
    }
  } catch {
    // Not ours to change; the files inside are still created owner-only.
  }
}
