import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { setupTokenPath } from "../server/auth/setup-token.ts";
import { BAN_MS, LoginLimiter } from "../server/auth/lockout.ts";
import { SESSION_TTL_MS, SessionStore } from "../server/auth/sessions.ts";
import { resetAdminPassword } from "../server/auth/index.ts";
import { CSRF, harness, type Harness, json, PASSWORD, sessionCookie } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

describe("setup claim", () => {
  it("creates a setup token while unclaimed and reports status", async () => {
    h = harness();
    expect(h.setupToken()).toMatch(/^[0-9a-z]{24}$/);
    const res = await h.request("/api/setup/status");
    expect(await json(res)).toEqual({ claimed: false, authenticated: false });
  });

  it("rejects a wrong token and a short password, then claims once", async () => {
    h = harness();
    const token = h.setupToken();

    let res = await h.request("/api/setup/claim", { method: "POST", headers: CSRF, json: { token: "nope", password: PASSWORD } });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("invalid_token");

    res = await h.request("/api/setup/claim", { method: "POST", headers: CSRF, json: { token, password: "short" } });
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toMatch(/at least 10/);

    res = await h.request("/api/setup/claim", { method: "POST", headers: CSRF, json: { token, password: PASSWORD } });
    expect(res.status).toBe(204);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^aib_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Secure/);
    expect(h.setupToken()).toBeNull();

    const status = await h.request("/api/setup/status", { cookie: sessionCookie(res)! });
    expect(await json(status)).toEqual({ claimed: true, authenticated: true });

    res = await h.request("/api/setup/claim", { method: "POST", headers: CSRF, json: { token, password: PASSWORD } });
    expect(res.status).toBe(409);

    const actions = h.ctx.audit.list().items.map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toEqual(["admin.claim:ok", "admin.claim:denied"]);
  });

  it("verifies the setup token on its own, under the claim's lockout", async () => {
    h = harness();
    const token = h.setupToken()!;
    const verify = (t: string) => h!.request("/api/setup/verify-token", { method: "POST", headers: CSRF, json: { token: t } });

    let res = await verify(token);
    expect(res.status).toBe(204);
    expect(h.setupToken()).toBe(token); // checking doesn't consume it

    // A mutating /api request: the CSRF header is required like everywhere else.
    res = await h.request("/api/setup/verify-token", { method: "POST", json: { token } });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("csrf");

    res = await verify(`${token}x`);
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error.code).toBe("invalid_token");
    // A custom data directory needs --data, but an unauthenticated caller never learns the path.
    expect(body.error.hint).toMatch(/reset-password --data <dir>/);
    expect(body.error.hint).not.toContain(h.ctx.config.dataDir);

    // Five distinct wrong tokens lock the address out, for the claim as well.
    for (let i = 1; i < 5; i++) await verify(`wrong-${i}`);
    res = await verify(token);
    expect(res.status).toBe(429);
    res = await h.request("/api/setup/claim", { method: "POST", headers: CSRF, json: { token, password: PASSWORD } });
    expect(res.status).toBe(429);
    expect(h.ctx.audit.list().items.filter((e) => e.action === "admin.claim" && e.outcome === "denied")).toHaveLength(5);
  });

  it("says how to get a new link when the token file is gone, and 409 once claimed", async () => {
    h = harness();
    const token = h.setupToken()!;
    rmSync(setupTokenPath(h.ctx.config.dataDir));
    let res = await h.request("/api/setup/verify-token", { method: "POST", headers: CSRF, json: { token } });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error.code).toBe("setup_token_expired");
    expect(body.error.hint).toMatch(/reset-password/);

    h.ctx.settings.setState("admin.passwordHash", "x");
    res = await h.request("/api/setup/verify-token", { method: "POST", headers: CSRF, json: { token } });
    expect(res.status).toBe(409);
  });

  it("marks the cookie Secure behind an https proxy when trusted", async () => {
    h = harness();
    h.ctx.config.trustProxy = true;
    const res = await h.request("/api/setup/claim", {
      method: "POST",
      headers: { ...CSRF, "x-forwarded-proto": "https" },
      json: { token: h.setupToken(), password: PASSWORD },
    });
    expect(res.headers.get("set-cookie")).toMatch(/Secure/);
  });
});

describe("login", () => {
  it("logs in, and locks the address out after 5 distinct wrong passwords", async () => {
    h = harness();
    await h.claim();
    const login = (password: string) => h!.request("/api/auth/login", { method: "POST", headers: CSRF, json: { password } });

    const ok = await login(PASSWORD);
    expect(ok.status).toBe(204);
    expect(sessionCookie(ok)).toMatch(/^aib_session=/);

    // The same wrong password repeated counts once.
    for (let i = 0; i < 3; i++) expect((await login("wrong-0")).status).toBe(401);
    for (let i = 1; i < 5; i++) expect((await login(`wrong-${i}`)).status).toBe(401);

    const locked = await login(PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
    expect((await json(locked)).error.message).toMatch(/Try again in 15 minutes/);

    const denied = h.ctx.audit.list({ action: "admin.login", outcome: "denied" }).items;
    expect(denied[0]!.reason).toBe("lockout");
  });

  it("returns 409 before the instance is claimed", async () => {
    h = harness();
    const res = await h.request("/api/auth/login", { method: "POST", headers: CSRF, json: { password: PASSWORD } });
    expect(res.status).toBe(409);
  });

  it("logout ends the session", async () => {
    h = harness();
    const cookie = await h.claim();
    expect((await h.request("/api/settings", { cookie })).status).toBe(200);
    const out = await h.request("/api/auth/logout", { method: "POST", headers: CSRF, cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/aib_session=;/);
    expect((await h.request("/api/settings", { cookie })).status).toBe(401);
  });

  it("changing the password revokes other sessions", async () => {
    h = harness();
    const mine = await h.claim();
    const other = sessionCookie(await h.request("/api/auth/login", { method: "POST", headers: CSRF, json: { password: PASSWORD } }))!;

    let res = await h.request("/api/auth/password", { method: "POST", headers: CSRF, cookie: mine, json: { current: "nope", next: "a new password!" } });
    expect(res.status).toBe(400);
    res = await h.request("/api/auth/password", { method: "POST", headers: CSRF, cookie: mine, json: { current: PASSWORD, next: "a new password!" } });
    expect(res.status).toBe(204);

    expect((await h.request("/api/settings", { cookie: mine })).status).toBe(200);
    expect((await h.request("/api/settings", { cookie: other })).status).toBe(401);
    const relogin = await h.request("/api/auth/login", { method: "POST", headers: CSRF, json: { password: "a new password!" } });
    expect(relogin.status).toBe(204);
  });

  it("reset-password returns to the unclaimed state with a fresh link", async () => {
    h = harness();
    const cookie = await h.claim();
    const token = resetAdminPassword(h.ctx);
    expect(h.setupToken()).toBe(token);
    expect((await h.request("/api/settings", { cookie })).status).toBe(401);
    const res = await h.request("/api/setup/claim", { method: "POST", headers: CSRF, json: { token, password: "another password" } });
    expect(res.status).toBe(204);
  });
});

describe("guards", () => {
  it("requires the CSRF header on mutating /api requests", async () => {
    h = harness();
    const cookie = await h.claim();
    let res = await h.request("/api/auth/login", { method: "POST", json: { password: PASSWORD } });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("csrf");
    res = await h.request("/api/settings", { method: "PATCH", cookie, json: { retentionDays: 7 } });
    expect(res.status).toBe(403);
    res = await h.request("/api/settings", { method: "PATCH", cookie, headers: CSRF, json: { retentionDays: 7 } });
    expect(res.status).toBe(200);
  });

  it("requires a session for the console API", async () => {
    h = harness();
    let res = await h.request("/api/settings");
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("setup_required");
    await h.claim();
    res = await h.request("/api/system");
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("unauthorized");
    res = await h.request("/api/settings", { cookie: "aib_session=forged" });
    expect(res.status).toBe(401);
  });
});

describe("session store", () => {
  it("slides the expiry at most daily and expires old sessions", () => {
    h = harness();
    let t = Date.parse("2026-01-01T00:00:00Z");
    const store = new SessionStore(h.ctx.db, () => t);
    const token = store.create();
    expect(store.check(token)).toEqual({ valid: true, refreshed: false });
    t += 2 * 86_400_000;
    expect(store.check(token)).toEqual({ valid: true, refreshed: true });
    t += SESSION_TTL_MS - 1000;
    expect(store.check(token).valid).toBe(true);
    t += SESSION_TTL_MS + 1;
    expect(store.check(token).valid).toBe(false);
    store.create();
    t += SESSION_TTL_MS + 1;
    expect(store.pruneExpired()).toBe(1);
  });
});

describe("login limiter", () => {
  it("bans after 5 distinct failures and lifts the ban after 15 minutes", () => {
    let t = 0;
    const limiter = new LoginLimiter(() => t);
    for (let i = 0; i < 4; i++) expect(limiter.fail("1.2.3.4", `p${i}`)).toBe(false);
    expect(limiter.bannedMinutes("1.2.3.4")).toBe(0);
    expect(limiter.fail("1.2.3.4", "p4")).toBe(true);
    expect(limiter.bannedMinutes("1.2.3.4")).toBe(15);
    expect(limiter.bannedMinutes("5.6.7.8")).toBe(0);
    t += BAN_MS + 1;
    expect(limiter.bannedMinutes("1.2.3.4")).toBe(0);
    expect(limiter.fail("1.2.3.4", "p5")).toBe(false);
  });

  it("forgets failures outside the window", () => {
    let t = 0;
    const limiter = new LoginLimiter(() => t);
    for (let i = 0; i < 4; i++) limiter.fail("ip", `p${i}`);
    t += BAN_MS + 1;
    expect(limiter.fail("ip", "p4")).toBe(false);
  });
});
