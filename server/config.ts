import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { envVar, PRODUCT, underService } from "./brand.ts";

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
  /** Running under `xaq service install` (XAQ_SERVICE=1 in the unit/plist). */
  service: boolean;
  version: string;
  /**
   * Base URLs for Google APIs. XAQ_GOOGLE_BASE (tests only) points all of them at test/fake-google.ts.
   * Defaults: https://oauth2.googleapis.com, https://accounts.google.com, https://gmail.googleapis.com, https://pubsub.googleapis.com,
   * https://www.googleapis.com (Calendar: paths start with /calendar/v3), https://www.googleapis.com (Drive: /drive/v3).
   */
  google: {
    oauthBase: string;
    authBase: string;
    gmailBase: string;
    pubsubBase: string;
    calendarBase: string;
    /**
     * Drive, Docs, Sheets and Slides (core's Drive client, server/google/drive.ts, and a code extension's API probe,
     * server/google/apis.ts): one base for all of them (tests: the fake). Unset: Drive uses https://www.googleapis.com
     * and the probe each API's own https://<service>.
     */
    apisBase?: string;
  };
}

export interface ConfigInput {
  dataDir?: string;
  host?: string;
  port?: number;
  dev?: boolean;
}

export const DEFAULT_PORT = 8425;

/** The data directory when neither --data nor XAQ_DATA says. */
export const defaultDataDir = () => join(homedir(), `.${PRODUCT}`);

/** The data directory: --data, else XAQ_DATA, else the default. */
export function resolveDataDir(flag?: string): string {
  return resolve(flag ?? (envVar("DATA") || defaultDataDir()));
}

/** The database, lock and log files in a data directory. */
export function dataFiles(dataDir: string): { db: string; lock: string; log: string } {
  return { db: join(dataDir, `${PRODUCT}.db`), lock: join(dataDir, `${PRODUCT}.lock`), log: join(dataDir, `${PRODUCT}.log`) };
}

export function loadConfig(input: ConfigInput = {}, version = "0.0.0"): Config {
  const dataDir = resolveDataDir(input.dataDir);
  // Only a directory that already had files in it can have exposed anything.
  const existed = hasFiles(dataDir);
  const google = envVar("GOOGLE_BASE") || undefined;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  restrictDir(dataDir, existed);
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
      oauthBase: google ?? "https://oauth2.googleapis.com",
      authBase: google ?? "https://accounts.google.com",
      gmailBase: google ?? "https://gmail.googleapis.com",
      pubsubBase: google ?? "https://pubsub.googleapis.com",
      calendarBase: google ?? "https://www.googleapis.com",
      ...(google ? { apisBase: google } : {}),
    },
  };
}

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
