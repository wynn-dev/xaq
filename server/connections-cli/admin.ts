import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SESSION_COOKIE, CSRF_HEADER } from "../auth/index.ts";
import { SESSION_MAX_AGE_MS } from "../auth/sessions.ts";
import { dataFiles } from "../config.ts";
import { sha256 } from "../crypto.ts";
import { type InstanceInfo, runningInstance } from "../instance.ts";

/**
 * The CLI's admin channel to the daemon on this machine (`connections …`, `import`), without the console password.
 *
 * Whoever can write the data directory already holds master.key and the database (`reset-password` relies on the
 * same thing), so the CLI proves it is the admin by writing there: it inserts a one-time admin session (only
 * sha256(token) is stored, like console sessions) that expires after 15 minutes, uses it as the session cookie
 * against the daemon's own /api on loopback, and deletes it when the command ends. Nothing new listens, no
 * token file sits on disk, and the daemon's admin auth (requireAdmin + the CSRF header) is unchanged: every API
 * call is checked, audited and rate-limited exactly like the console's.
 *
 * Console sessions slide forward on use up to SESSION_MAX_AGE_MS after created_at. The CLI's row is written with
 * created_at = expiry − SESSION_MAX_AGE_MS, so that hard limit is the 15-minute expiry and the row can never be
 * extended (a session kind column would say this directly).
 */

export const CLI_SESSION_TTL_MS = 15 * 60_000;
export const CLI_SESSION_LABEL = "xaq CLI (local admin, one-time)";

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    /** The parsed response body (some routes answer an error with their own shape, e.g. /finish). */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export interface AdminChannel {
  /** The daemon's loopback origin, e.g. http://127.0.0.1:8425. */
  readonly baseUrl: string;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  /**
   * A fingerprint of the connection's stored credential (issued_at plus its randomised ciphertext), read from the
   * database: it changes on every saved sign-in, so a Reconnect's completion is seen even on an active connection.
   * null when nothing is stored (or it can't be read). Never the credential itself.
   */
  credentialStamp(connectionId: string): string | null;
  /** Deletes the one-time session. Idempotent. */
  close(): void;
}

/** Signals that end a CLI command: the one-time session is deleted on each (and on a normal exit). */
export const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface OpenAdminOptions {
  dataDir: string;
  /** Tests: the running instance, instead of reading the lock file. */
  instance?: InstanceInfo | null;
  /** Tests: the daemon origin, instead of deriving it from the instance. */
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: () => number;
}

/** Where the CLI reaches the daemon: its bind address, or loopback when it listens on every interface. */
export function daemonOrigin(instance: Pick<InstanceInfo, "host" | "port">): string {
  const host = instance.host;
  const any = !host || host === "0.0.0.0" || host === "::" || host === "[::]";
  const h = any ? "127.0.0.1" : host.replace(/^\[|\]$/g, "");
  return `http://${h.includes(":") ? `[${h}]` : h}:${instance.port}`;
}

/** Inserts the one-time admin session; returns the token. */
export function createCliSession(dbPath: string, clock: () => number = Date.now): { token: string; remove: () => void } {
  const token = randomBytes(32).toString("base64url");
  const hash = sha256(token);
  const expires = clock() + CLI_SESSION_TTL_MS;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("INSERT INTO admin_sessions (token_hash, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)").run(
      hash,
      new Date(expires - SESSION_MAX_AGE_MS).toISOString(),
      new Date(expires).toISOString(),
      "local-cli",
      CLI_SESSION_LABEL,
    );
  } finally {
    db.close();
  }
  let removed = false;
  return {
    token,
    remove() {
      if (removed) return;
      removed = true;
      try {
        const d = new DatabaseSync(dbPath);
        try {
          d.exec("PRAGMA busy_timeout = 5000");
          d.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(hash);
        } finally {
          d.close();
        }
      } catch {
        // It expires on its own within 15 minutes.
      }
    },
  };
}

export function openAdminChannel(opts: OpenAdminOptions): AdminChannel {
  // xaq.db, or agentinbox.db in a data directory from before the rename (rename-xaq: keep).
  const dbPath = dataFiles(opts.dataDir).db;
  if (!existsSync(dbPath)) {
    throw new Error(
      `No xaq data in ${opts.dataDir}. Run this on the machine xaq runs on, as the user it runs as ` +
        "(with sudo for a system service), or pass its data directory with --data.",
    );
  }
  const instance = opts.instance === undefined ? runningInstance(opts.dataDir) : opts.instance;
  if (!instance && !opts.baseUrl) throw new Error(`xaq isn't running with the data directory ${opts.dataDir}. Start it first (or pass --data).`);
  const baseUrl = opts.baseUrl ?? daemonOrigin(instance!);
  let session: ReturnType<typeof createCliSession>;
  try {
    session = createCliSession(dbPath, opts.clock);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `Can't open ${dbPath}${code ? ` (${code})` : ""}: ${(err as Error).message}. Run this as the user xaq runs as (with sudo for a system service).`,
    );
  }
  const onExit = () => session.remove();
  process.once("exit", onExit);
  const doFetch = opts.fetch ?? fetch;
  const send = (method: string, path: string, body: unknown) => {
    const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${session.token}`, [CSRF_HEADER]: "1", accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    return doFetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  };
  return {
    baseUrl,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      let res: Response;
      try {
        res = await send(method, path, body);
        // The session's 15 minutes ran out (a slow sign-in): mint a fresh one and retry once.
        if (res.status === 401) {
          await res.body?.cancel().catch(() => {});
          session.remove();
          session = createCliSession(dbPath, opts.clock);
          res = await send(method, path, body);
        }
      } catch (err) {
        throw new Error(`Couldn't reach xaq at ${baseUrl}: ${(err as Error).message}`);
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON: reported below.
      }
      if (!res.ok) {
        const e = (data as { error?: { code?: string; message?: string; hint?: string } } | null)?.error;
        throw new AdminApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? `HTTP ${res.status} from ${path}`, e?.hint, data);
      }
      return data as T;
    },
    credentialStamp(connectionId: string): string | null {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          db.exec("PRAGMA busy_timeout = 5000");
          const r = db.prepare("SELECT issued_at, access_token_enc, header_value_enc FROM connection_credentials WHERE connection_id = ?").get(connectionId) as
            | { issued_at: string | null; access_token_enc: string | null; header_value_enc: string | null }
            | undefined;
          return r ? sha256(`${r.issued_at ?? ""}|${r.access_token_enc ?? ""}|${r.header_value_enc ?? ""}`) : null;
        } finally {
          db.close();
        }
      } catch {
        return null;
      }
    },
    close() {
      process.removeListener("exit", onExit);
      session.remove();
    },
  };
}
