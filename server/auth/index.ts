import { BlockList, isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../api/util.ts";
import type { CoreContext } from "../context.ts";
import { HttpError } from "../util/errors.ts";
import { clientKey, GLOBAL_SLOWDOWN_MS, LoginLimiter } from "./lockout.ts";
import { SESSION_TTL_MS, SessionStore } from "./sessions.ts";
import { ensureSetupToken, regenerateSetupToken } from "./setup-token.ts";

export const SESSION_COOKIE = "aib_session";
export const CSRF_HEADER = "x-xaq-csrf";
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 1024;

/** Secret checks (scrypt) allowed at once: libuv's default thread pool size. */
export const MAX_CONCURRENT_VERIFICATIONS = 4;
/** Requests from one client that may wait behind its in-flight check; more get 429. */
export const MAX_QUEUED_PER_CLIENT = 4;

/** Hands out at most `max` slots; waiters are served in order. */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly max: number) {}

  get inUse(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** Per-context admin auth state: the session store, the failed-login limiter and verification queues. */
export interface AdminAuth {
  sessions: SessionStore;
  limiter: LoginLimiter;
  /** One secret check per client at a time: the tail of each client's queue. */
  lanes: Map<string, { tail: Promise<void>; queued: number }>;
  verifySlots: Semaphore;
}

/** What admin auth needs from the context (the CLI builds this without loading the master key). */
export type AuthCore = Pick<CoreContext, "db" | "settings" | "audit" | "config">;

const instances = new WeakMap<AuthCore, AdminAuth>();

export function adminAuth(ctx: AuthCore): AdminAuth {
  let auth = instances.get(ctx);
  if (!auth) {
    auth = { sessions: new SessionStore(ctx.db), limiter: new LoginLimiter(), lanes: new Map(), verifySlots: new Semaphore(MAX_CONCURRENT_VERIFICATIONS) };
    instances.set(ctx, auth);
  }
  return auth;
}

/** Claimed = an admin password exists. Before that only the setup-token claim works. */
export const isClaimed = (ctx: AuthCore): boolean => !!ctx.settings.getState("admin.passwordHash");

/** The current setup token while unclaimed (created on demand), otherwise null. */
export function currentSetupToken(ctx: AuthCore): string | null {
  return isClaimed(ctx) ? null : ensureSetupToken(ctx.config.dataDir);
}

/** `xaq reset-password`: back to the unclaimed state with a fresh setup link. */
export function resetAdminPassword(ctx: AuthCore): string {
  const auth = adminAuth(ctx);
  ctx.db.tx(() => {
    ctx.settings.deleteState("admin.passwordHash");
    auth.sessions.deleteAll();
  });
  auth.limiter.reset();
  ctx.audit.record({ actorType: "system", action: "admin.password_reset", outcome: "ok" });
  return regenerateSetupToken(ctx.config.dataDir);
}

function socketAddress(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    // No Node socket (e.g. app.request() without bindings).
    return null;
  }
}

/** Some proxies (Azure, IIS) append ":port" to X-Forwarded-For entries. */
function stripPort(entry: string): string {
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
  if (v6) return v6[1]!;
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(entry);
  return v4 ? v4[1]! : entry;
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/**
 * Forwarding headers are believed only from a loopback peer (a proxy on the same host): the daemon usually
 * binds 0.0.0.0, so trusting other peers would let any LAN or tailnet peer forge its address.
 */
export function isTrustedProxy(peer: string): boolean {
  const ip = peer.replace(/%.*$/, "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  const v = isIP(ip);
  return v !== 0 && LOOPBACK.check(ip, v === 4 ? "ipv4" : "ipv6");
}

let warnedUntrustedProxy = false;

function warnUntrustedProxy(peer: string): void {
  if (warnedUntrustedProxy) return;
  warnedUntrustedProxy = true;
  process.stderr.write(`xaq: ignoring X-Forwarded-For from ${peer}: TRUST_PROXY only trusts a proxy on this machine (loopback).\n`);
}

/**
 * The client address. X-Forwarded-For is honored only with TRUST_PROXY and only from a loopback proxy; its
 * last entry is the client (the one proxy in front of xaq appended it; entries further left are client-controlled).
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  const peer = socketAddress(c);
  if (trustProxy && peer && !isTrustedProxy(peer) && c.req.header("x-forwarded-for")) warnUntrustedProxy(peer);
  if (trustProxy && peer && isTrustedProxy(peer)) {
    const chain = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => stripPort(s.trim()))
      .filter(Boolean);
    const forwarded = chain.at(-1);
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  return peer ?? "unknown";
}

function isSecure(c: Context, trustProxy: boolean): boolean {
  if (new URL(c.req.url).protocol === "https:") return true;
  const peer = socketAddress(c);
  return trustProxy && !!peer && isTrustedProxy(peer) && c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
}

export function sessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE) || undefined;
}

function writeSessionCookie(c: Context, token: string, trustProxy: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isSecure(c, trustProxy),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** Creates a session for the requester and sets the cookie. */
export function startSession(c: Context, ctx: AuthCore): void {
  const token = adminAuth(ctx).sessions.create({ ip: clientIp(c, ctx.config.trustProxy), userAgent: c.req.header("user-agent") });
  writeSessionCookie(c, token, ctx.config.trustProxy);
}

export function endSession(c: Context, ctx: AuthCore): void {
  const token = sessionToken(c);
  if (token) adminAuth(ctx).sessions.delete(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Whether the request carries a valid session; refreshes the cookie when the expiry slid forward. */
export function hasSession(c: Context, ctx: AuthCore): boolean {
  const token = sessionToken(c);
  const check = adminAuth(ctx).sessions.check(token);
  if (check.refreshed && token) writeSessionCookie(c, token, ctx.config.trustProxy);
  return check.valid;
}

/** Requires an admin session on every route it guards. */
export function requireAdmin(ctx: AuthCore): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!hasSession(c, ctx)) {
      if (!isClaimed(ctx)) {
        throw new HttpError(401, "setup_required", "This instance has not been claimed yet", "Open the setup link printed by xaq on startup.");
      }
      throw new HttpError(401, "unauthorized", "Sign in to continue");
    }
    c.set("admin", true);
    await next();
  };
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF guard: a custom header can't be sent cross-site without a CORS preflight (which this server
 * never approves), and SameSite=Lax already keeps the cookie off cross-site POSTs.
 */
export function csrfGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (MUTATING.has(c.req.method) && c.req.header(CSRF_HEADER) !== "1") {
      throw new HttpError(403, "csrf", `Missing ${CSRF_HEADER} header`, `Send "${CSRF_HEADER}: 1" with every mutating /api request.`);
    }
    await next();
  };
}

/** 429 response for a locked-out address. */
export function lockedOut(c: Context, minutes: number): Response {
  c.header("Retry-After", String(minutes * 60));
  const message = `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  return c.json({ error: { code: "locked_out", message } }, 429);
}

export type CheckResult =
  | { ok: true }
  | { ok: false; lockedMinutes: number; nowBanned: boolean; /** Too many concurrent attempts from this client. */ busy?: boolean };

export interface CheckOptions {
  /**
   * Count toward (and be slowed down by) the instance-wide failure budget. Off for the setup claim:
   * it's only open while unclaimed and needs the token.
   */
  global?: boolean;
  /** Test hook: how long to wait while over the global budget. */
  slowdownMs?: number;
}

/**
 * Verifies a secret under the failed-login limiter.
 * - Each client gets one check at a time (a few more may queue, the rest get `busy`), and at most
 *   MAX_CONCURRENT_VERIFICATIONS run at once overall.
 * - The attempt is recorded before `verify` (scrypt) runs and refunded if it succeeds, so
 *   concurrent requests can't all slip past the ban.
 * - Locked-out clients and secrets this client already failed with never reach `verify`.
 * - While the instance-wide budget is exhausted, each attempt waits a little first; it is never refused.
 */
export async function checkSecret(
  ctx: AuthCore,
  ip: string,
  secret: string,
  verify: () => boolean | Promise<boolean>,
  opts: CheckOptions = {},
): Promise<CheckResult> {
  const auth = adminAuth(ctx);
  const key = clientKey(ip);
  const lane = auth.lanes.get(key) ?? { tail: Promise.resolve(), queued: 0 };
  if (lane.queued > MAX_QUEUED_PER_CLIENT) return { ok: false, lockedMinutes: 0, nowBanned: false, busy: true };
  lane.queued++;
  auth.lanes.set(key, lane);
  const previous = lane.tail;
  let done!: () => void;
  lane.tail = new Promise<void>((resolve) => (done = resolve));
  try {
    await previous;
    return await checkOnce(auth, ip, secret, verify, opts);
  } finally {
    done();
    if (--lane.queued === 0) auth.lanes.delete(key);
  }
}

async function checkOnce(auth: AdminAuth, ip: string, secret: string, verify: () => boolean | Promise<boolean>, opts: CheckOptions): Promise<CheckResult> {
  const { limiter } = auth;
  const global = opts.global !== false;
  if (global && limiter.overGlobalBudget() && !limiter.bannedMinutes(ip)) {
    await new Promise((r) => setTimeout(r, opts.slowdownMs ?? GLOBAL_SLOWDOWN_MS));
  }
  // From here to the reservation everything is synchronous.
  const locked = limiter.bannedMinutes(ip);
  if (locked) return { ok: false, lockedMinutes: locked, nowBanned: false };
  if (limiter.knownBad(ip, secret)) return { ok: false, lockedMinutes: 0, nowBanned: limiter.fail(ip, secret, { global }) };
  const reservation = limiter.record(ip, secret, { global });
  const release = await auth.verifySlots.acquire();
  let ok = false;
  try {
    ok = await verify();
  } finally {
    release();
  }
  if (!ok) return { ok: false, lockedMinutes: 0, nowBanned: reservation.banned };
  limiter.clear(ip);
  if (reservation.countedGlobally) limiter.refundGlobal();
  return { ok: true };
}

/** The 429 for a rejected check (locked out or too many at once), or null to continue. */
export function rejection(c: Context, check: CheckResult): Response | null {
  if (check.ok) return null;
  if (check.busy) {
    c.header("Retry-After", "2");
    return c.json({ error: { code: "too_many_requests", message: "Another sign-in attempt from your address is still being checked. Try again in a moment." } }, 429);
  }
  return check.lockedMinutes ? lockedOut(c, check.lockedMinutes) : null;
}
