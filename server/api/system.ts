import { resolve } from "node:path";
import type { Context } from "hono";
import { z } from "zod";
import {
  type AuditOutcome,
  type HealthResponse,
  type IngestStatus,
  NPM_PACKAGE,
  type SelfUpdateInfo,
  type SelfUpdateStatus,
  type SystemInfo,
  type UpdateInfo,
} from "../../shared/types.ts";
import { adminAuth, checkSecret, clientIp, lockedOut, MAX_PASSWORD_LENGTH, rejection } from "../auth/index.ts";
import { type Config, DEFAULT_PORT, defaultDataDir } from "../config.ts";
import type { AppContext } from "../context.ts";
import { verifyPasswordAsync } from "../crypto.ts";
import { serviceInstallCommand } from "../instance.ts";
import { systemOps } from "../service.ts";
import {
  claimUpdateLock,
  launchUpdateJob,
  newUpdateId,
  previousVersion,
  readUpdateStatus,
  releaseUpdateLock,
  selfUpdateSupport,
  type UpdateJobRequest,
  writeUpdateStatus,
} from "../update.ts";
import { consoleUrls } from "../urls.ts";
import { conflict, errorMessage, HttpError } from "../util/errors.ts";
import { compareVersions } from "../util/semver.ts";
import { setupState } from "./setup.ts";
import { ADMIN_ACTOR, type AppEnv, readBody, router } from "./util.ts";

const DEFAULT_HOST = "0.0.0.0";
const LATEST_TTL_MS = 30 * 60_000;
const LATEST_RETRY_MS = 5 * 60_000;

/**
 * Public health check for uptime monitors: 200 when healthy, 503 when degraded (an account needs
 * re-auth or is erroring, or ingest reports an error). Only states and the version, never secrets.
 */
export function healthRoutes(ctx: AppContext) {
  const handler = (c: Context<AppEnv>) => {
    const body = health(ctx);
    c.header("Cache-Control", "no-store");
    return c.json<HealthResponse>(body, body.status === "ok" ? 200 : 503);
  };
  // Also with a trailing slash, which would otherwise fall through to the console and keep a monitor green.
  return router().get("/health", handler).get("/health/", handler).get("/api/health", handler).get("/api/health/", handler);
}

export function health(ctx: AppContext): HealthResponse {
  const counts = ctx.db.get<{ total: number; attention: number }>(
    "SELECT COUNT(*) AS total, COALESCE(SUM(status IN ('needs_reauth', 'error')), 0) AS attention FROM accounts",
  ) ?? { total: 0, attention: 0 };
  let ingestError = false;
  if (counts.total > 0) {
    try {
      ingestError = !!ctx.ingest.status().lastError;
    } catch {
      // Ingest unavailable: account states above still tell the story.
    }
  }
  let setupComplete = false;
  try {
    setupComplete = setupState(ctx, { healthOnly: true }).complete;
  } catch {
    // Reported as not complete.
  }
  return {
    status: counts.attention > 0 || ingestError ? "degraded" : "ok",
    version: ctx.config.version,
    setupComplete,
  };
}

/** What the update routes need from the machine; tests fake it. */
export interface SelfUpdateHost {
  support(): { supported: boolean; reason: string | null };
  /** The npm `latest` version (null when the check failed). */
  latest(): Promise<string | null>;
  /** Starts the update job (server/update.ts); throws when it couldn't. */
  launch(req: UpdateJobRequest): Promise<void>;
}

export const selfUpdateHost = (ctx: AppContext): SelfUpdateHost => ({
  support: () => selfUpdateSupport(ctx.config),
  latest: () => latestVersion(ctx),
  launch: (req) => launchUpdateJob(systemOps(), req),
});

const SelfUpdateBody = z.object({
  password: z.string().min(1, "Password is required").max(MAX_PASSWORD_LENGTH),
  action: z.enum(["update", "rollback"]),
  version: z.string().max(100).optional(),
});

/** Authenticated: instance facts, the update notice, and the console's one-click update (service mode). */
export function systemApi(ctx: AppContext, host: SelfUpdateHost = selfUpdateHost(ctx)) {
  return router()
    .get("/system", (c) => {
      let ingest: IngestStatus;
      try {
        ingest = ctx.ingest.status();
      } catch (err) {
        ingest = { mode: ctx.settings.get().ingestMode, running: false, lastPullAt: null, lastError: errorMessage(err) };
      }
      return c.json<SystemInfo>({
        version: ctx.config.version,
        nodeVersion: process.versions.node,
        dataDir: ctx.config.dataDir,
        service: ctx.config.service,
        addresses: consoleUrls(ctx.config.host, ctx.config.port),
        publicUrl: ctx.settings.publicUrl(),
        ingest,
        serviceCommand: serviceInstallCommand(ctx.config),
      });
    })
    .get("/system/latest", async (c) => {
      const latest = await latestVersion(ctx);
      const current = ctx.config.version;
      return c.json<UpdateInfo>({
        current,
        latest,
        updateAvailable: !!latest && compareVersions(latest, current) > 0,
        command: upgradeCommand(ctx.config),
      });
    })
    .get("/system/update", (c) => {
      const { supported, reason } = host.support();
      return c.json<SelfUpdateInfo>({
        supported,
        reason,
        previous: supported ? previousVersion(ctx.config.dataDir, ctx.config.version) : null,
        status: readUpdateStatus(ctx.config.dataDir),
      });
    })
    // Admin session plus the password again; every attempt is audited (system.update), and the job audits
    // its outcome (system.update.result). One job at a time: the update lock is taken here and the job keeps it.
    .post("/system/update", async (c) => {
      const ip = clientIp(c, ctx.config.trustProxy);
      const { dataDir, version: current } = ctx.config;
      const audit = (outcome: AuditOutcome, reason: string | null, detail: Record<string, unknown> = {}) =>
        ctx.audit.record({ ...ADMIN_ACTOR, action: "system.update", outcome, reason, detail: { ip, ...detail } });
      const banned = adminAuth(ctx).limiter.bannedMinutes(ip);
      if (banned) {
        audit("denied", "lockout");
        return lockedOut(c, banned);
      }
      let body: z.infer<typeof SelfUpdateBody>;
      try {
        body = await readBody(c, SelfUpdateBody);
      } catch (err) {
        // A missing password or a malformed body is still an attempt.
        audit("denied", "invalid_request", { error: errorMessage(err) });
        throw err;
      }
      const hash = ctx.settings.getState("admin.passwordHash");
      const check = await checkSecret(ctx, ip, body.password, async () => !!hash && (await verifyPasswordAsync(body.password, hash)));
      if (!check.ok) {
        audit("denied", check.busy ? "busy" : check.nowBanned || check.lockedMinutes ? "lockout" : "bad_password", { action: body.action });
        const rejected = rejection(c, check);
        if (rejected) return rejected;
        // 400, not 401: a wrong password here is a form error, not an expired session.
        throw new HttpError(400, "invalid_password", "Wrong password");
      }
      const refuse = (reason: string, message: string, detail: Record<string, unknown> = {}): never => {
        audit("denied", reason, { action: body.action, ...detail });
        throw conflict(message);
      };
      const support = host.support();
      if (!support.supported) refuse("unsupported", support.reason ?? "This instance can't update itself.");
      const id = newUpdateId();
      const lock = claimUpdateLock(dataDir, id);
      if (!lock.ok) {
        const running = readUpdateStatus(dataDir);
        const what = running?.id === lock.holder.id && running.state === "running" ? (running.kind === "update" ? `An update to ${running.to}` : `Going back to ${running.to}`) : "An update";
        refuse("in_progress", `${what} is already running. Wait for it to finish.`, { running: lock.holder.id });
      }

      let status: SelfUpdateStatus;
      try {
        let to: string;
        if (body.action === "update") {
          // Only ever the npm `latest` the console showed, and only forward.
          const latest = await host.latest();
          if (!latest) refuse("no_latest", "Couldn't reach npm to check the latest version. Try again in a few minutes.");
          if (body.version !== latest || compareVersions(latest!, current) <= 0) {
            refuse("not_latest", `${body.version ?? "That version"} isn't the latest release newer than ${current}${latest ? ` (${latest} is)` : ""}. Reload and try again.`, { version: body.version ?? null });
          }
          to = latest!;
        } else {
          const previous = previousVersion(dataDir, current);
          if (!previous) refuse("no_previous", "There is no older install to go back to.");
          to = previous!;
        }

        status = { id, kind: body.action, from: current, to, state: "running", step: "starting", message: null, startedAt: new Date().toISOString(), finishedAt: null };
        const detail = { action: body.action, id, from: current, to };
        writeUpdateStatus(dataDir, status);
        try {
          await host.launch({ dataDir, id, kind: status.kind, version: to });
        } catch (err) {
          const message = `Couldn't start the update job: ${errorMessage(err)}`;
          writeUpdateStatus(dataDir, { ...status, state: "failed", message, finishedAt: new Date().toISOString() });
          audit("error", "launch_failed", { ...detail, message });
          throw new HttpError(500, "update_failed", message);
        }
      } catch (err) {
        // Refused or not started: no job will release it.
        releaseUpdateLock(dataDir, id);
        throw err;
      }
      audit("ok", null, { action: body.action, id, from: current, to: status.to });
      return c.json<SelfUpdateStatus>(status, 202);
    });
}

let latestCache: { at: number; version: string | null } | undefined;

/** The npm `latest` dist-tag, cached for 30 minutes (5 after a failed check). */
async function latestVersion(ctx: AppContext): Promise<string | null> {
  if (latestCache && Date.now() - latestCache.at < (latestCache.version ? LATEST_TTL_MS : LATEST_RETRY_MS)) {
    return latestCache.version;
  }
  let version: string | null = null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGE}/latest`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    version = ((await res.json()) as { version?: string }).version ?? null;
  } catch (err) {
    ctx.log.debug("Update check failed", { error: errorMessage(err) });
  }
  latestCache = { at: Date.now(), version };
  return version;
}

/** Runs, or reinstalls as a service, the latest version with this instance's options. */
export function upgradeCommand(config: Pick<Config, "service" | "dataDir" | "port" | "host" | "trustProxy">, env: NodeJS.ProcessEnv = process.env): string {
  // A service keeps these from its previous install (service.env), but a foreground run needs them again.
  const proxyEnv = config.trustProxy
    ? ["TRUST_PROXY=1", ...(["TRUST_PROXY_HOPS", "TRUST_PROXY_FROM"] as const).filter((k) => env[k]?.trim()).map((k) => `${k}=${shellQuote(env[k]!.trim())}`)]
    : [];
  // Assignments are quoted per value above: quoting the whole `KEY=value` word would turn it into a command.
  const args = ["npx", "-y", NPM_PACKAGE];
  if (config.service) args.push("service", "install");
  // An install from before the rename on ~/.agentinbox needs no --data: it stays the default unless ~/.xaq holds our files (rename-xaq: keep).
  if (resolve(config.dataDir) !== defaultDataDir()) args.push("--data", config.dataDir);
  if (config.port !== DEFAULT_PORT) args.push("--port", String(config.port));
  if (config.host !== DEFAULT_HOST) args.push("--host", config.host);
  return [...proxyEnv, ...args.map(shellQuote)].join(" ");
}

export const shellQuote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
