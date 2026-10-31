import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CLI_NAME, NPM_PACKAGE } from "../shared/types.ts";
import { envVar, underService } from "./brand.ts";
import { type Config, dataFiles, DEFAULT_PORT, defaultDataDir } from "./config.ts";
import { Crypto } from "./crypto.ts";

/**
 * How to run this CLI in printed hints: `npx xaq-cli` when run through npx (and in service logs, read
 * by someone who most likely installed that way: the service's own copy isn't on their PATH), else the
 * installed `xaq`.
 */
export function cliCommand(args: string): string {
  const viaNpx = process.env.npm_command === "exec" || /[\\/]_npx[\\/]/.test(process.argv[1] ?? "") || underService();
  return `${viaNpx ? `npx ${NPM_PACKAGE}` : CLI_NAME} ${args}`;
}

/**
 * `service install` with the flags this run used, so the service gets the same data and address.
 * Printed by the startup banner and shown in the console (SystemInfo.serviceCommand).
 */
export function serviceInstallCommand(config: Pick<Config, "dataDir" | "host" | "port">): string {
  const flags: string[] = [];
  if (resolve(config.dataDir) !== defaultDataDir()) flags.push(`--data ${quoteArg(config.dataDir)}`);
  if (config.host !== "0.0.0.0") flags.push(`--host ${quoteArg(config.host)}`);
  if (config.port !== DEFAULT_PORT) flags.push(`--port ${config.port}`);
  return cliCommand(["service install", ...flags].join(" "));
}

const quoteArg = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** `reset-password`, with `--data <dir>` when the data directory isn't the default one. */
export function resetPasswordCommand(dataDir: string): string {
  const custom = resolve(dataDir) !== defaultDataDir();
  return cliCommand(custom ? `reset-password --data ${quoteArg(dataDir)}` : "reset-password");
}

// ───────────── Single instance per data directory ─────────────

export interface InstanceInfo {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  /** Kernel boot id (Linux), so a lock from before a reboot is never mistaken for a live one. */
  bootId?: string | null;
  /** The process's own start time as the OS reports it, so a reused pid doesn't look alive. */
  processStart?: string | null;
  /** Started by the background service (XAQ_SERVICE=1). */
  service?: boolean;
}

/** `<data>/xaq.lock`. */
export const lockPath = (dataDir: string) => dataFiles(dataDir).lock;

/** Data dirs locked by this process: a lock naming our own pid is live only if it's in here. */
const heldByUs = new Set<string>();

export function bootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Process start time: /proc (Linux, in clock ticks since boot) or `ps` elsewhere; null if unknown. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the parenthesized command name; starttime is field 22, i.e. index 19 here.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    // No /proc (macOS) or no such process.
  }
  if (process.platform === "linux" || process.platform === "win32") return null;
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the process a lock names is still the one that wrote it. Our own pid is live only if we
 * hold the lock (in containers every start is pid 1); otherwise the pid must exist, on the same
 * boot, with the same start time (when both are known).
 */
function isLive(info: InstanceInfo, dataDir: string): boolean {
  if (info.pid === process.pid) return heldByUs.has(dataDir);
  if (!isAlive(info.pid)) return false;
  const boot = bootId();
  if (info.bootId && boot && info.bootId !== boot) return false;
  if (info.processStart) {
    const start = processStartTime(info.pid);
    if (start && start !== info.processStart) return false;
  }
  return true;
}

function readLock(dataDir: string): InstanceInfo | null {
  try {
    const info = JSON.parse(readFileSync(lockPath(dataDir), "utf8")) as InstanceInfo;
    return Number.isInteger(info.pid) && info.pid > 0 ? info : null;
  } catch {
    return null;
  }
}

/** The running instance for this data directory, if any. */
export function runningInstance(dataDir: string): InstanceInfo | null {
  const info = readLock(dataDir);
  return info && isLive(info, dataDir) ? info : null;
}

export interface InstanceLock {
  /** Records the bound port (for `reset-password` and error messages). */
  update(port: number): void;
  release(): void;
}

/**
 * Takes `<data>/xaq.lock`. Two processes on one data directory would both run ingest and
 * emit every event twice, even on different ports. A lock whose process is gone (dead,
 * rebooted, or its pid reused by something else) is replaced.
 */
export function acquireInstanceLock(config: Pick<Config, "dataDir" | "host" | "port">): InstanceLock {
  const dataDir = config.dataDir;
  const file = lockPath(dataDir);
  const info: InstanceInfo = {
    pid: process.pid,
    host: config.host,
    port: config.port,
    startedAt: new Date().toISOString(),
    bootId: bootId(),
    processStart: processStartTime(process.pid),
    service: underService(),
  };
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(info), { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw err;
      const other = runningInstance(dataDir);
      if (other) {
        const where = `(pid ${other.pid}${other.port ? `, port ${other.port}` : ""})`;
        throw new Error(
          other.service
            ? `xaq is already running as a background service with the data directory ${dataDir} ${where}. ` +
                `Use that one, stop it (\`${cliCommand("service uninstall")}\` keeps your data), or use another --data directory.`
            : `xaq is already running with the data directory ${dataDir} ${where}. ` +
                `Stop it first, or use another --data directory. If no such process exists, delete ${file}.` +
                (existsSync(join(dataDir, "setup-token")) ? ` Lost its setup link? \`${resetPasswordCommand(dataDir)}\` prints it again.` : ""),
        );
      }
      rmSync(file, { force: true });
    }
  }
  heldByUs.add(dataDir);
  const ours = () => {
    const current = readLock(dataDir);
    return current?.pid === process.pid && current.startedAt === info.startedAt;
  };
  return {
    update(port) {
      info.port = port;
      if (ours()) writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
    },
    release() {
      if (ours()) rmSync(file, { force: true });
      heldByUs.delete(dataDir);
    },
  };
}

// ───────────── Master key guard ─────────────

/** One ciphertext from the database, or null when nothing encrypted is stored. */
function sampleCiphertext(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath);
  try {
    const queries = [
      "SELECT refresh_token_enc AS v FROM accounts WHERE refresh_token_enc LIKE 'v1:%' LIMIT 1",
      "SELECT json_extract(value, '$.clientSecretEnc') AS v FROM settings WHERE key = 'google.client'",
    ];
    for (const sql of queries) {
      try {
        const v = (db.prepare(sql).get() as { v?: unknown } | undefined)?.v;
        if (typeof v === "string" && v.startsWith("v1:")) return v;
      } catch {
        // Table not created yet.
      }
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * Refuses to start with a master key that can't read the stored secrets: a missing master.key would
 * otherwise be regenerated, silently making every refresh token and client secret unreadable.
 * `envKey` overrides XAQ_MASTER_KEY (used by `service install` to check the key it will install).
 */
export function assertMasterKeyUsable(config: Pick<Config, "dbPath" | "masterKeyPath">, envKey = envVar("MASTER_KEY")): void {
  const sample = sampleCiphertext(config.dbPath);
  if (!sample) return;
  let raw: string | null = envKey || null;
  const source = raw ? "XAQ_MASTER_KEY" : config.masterKeyPath;
  if (!raw && existsSync(config.masterKeyPath)) raw = readFileSync(config.masterKeyPath, "utf8").trim();
  if (!raw) {
    throw new Error(
      `${config.dbPath} holds encrypted secrets, but there is no master key: ${config.masterKeyPath} is missing and XAQ_MASTER_KEY is not set. ` +
        "Restore master.key from your backup (or set XAQ_MASTER_KEY to the key used before). " +
        "xaq won't create a new key, because the stored Google tokens and secrets could never be read again.",
    );
  }
  try {
    new Crypto(Buffer.from(raw, "base64")).decrypt(sample);
  } catch {
    throw new Error(
      `The master key from ${source} can't decrypt the secrets stored in ${config.dbPath}. ` +
        "Use the key this data directory was created with (master.key from your backup, or the previous XAQ_MASTER_KEY).",
    );
  }
}
