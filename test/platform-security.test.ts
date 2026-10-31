import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adminAuth, checkSecret, isTrustedProxy, MAX_CONCURRENT_VERIFICATIONS } from "../server/auth/index.ts";
import { contentSecurityPolicy, inlineScriptHashes, registerInlineScript, scriptHash } from "../server/csp.ts";
import { BAN_MS, clientKey, GLOBAL_MAX_FAILURES, LoginLimiter, MAX_ATTEMPTS, MAX_ENTRIES } from "../server/auth/lockout.ts";
import { SESSION_MAX_AGE_MS, SESSION_TTL_MS, SessionStore } from "../server/auth/sessions.ts";
import { acquireInstanceLock, assertMasterKeyUsable, bootId, lockPath, processStartTime, resetPasswordCommand, runningInstance } from "../server/instance.ts";
import { startServer } from "../server/server.ts";
import { testConfig } from "./helpers.ts";
import { CSRF, fakeGoogle, fakeIngest, type Harness, harness, json, PASSWORD } from "./platform-helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const login = (password: string, headers: Record<string, string> = {}) =>
  h!.request("/api/auth/login", { method: "POST", headers: { ...CSRF, ...headers }, json: { password } });

describe("M1: lockout and hashing", () => {
  it("bans a client repeating the same wrong password after 30 attempts", async () => {
    h = harness();
    await h.claim();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expect((await login("same-wrong")).status).toBe(401);
    expect((await login("same-wrong")).status).toBe(401);
    expect((await login(PASSWORD)).status).toBe(429);
  });

  it("doesn't hash a secret the client already failed with", async () => {
    h = harness();
    let verifications = 0;
    const verify = () => (verifications++, false);
    await checkSecret(h.ctx, "1.1.1.1", "guess", verify);
    await checkSecret(h.ctx, "1.1.1.1", "guess", verify);
    await checkSecret(h.ctx, "1.1.1.1", "guess", verify);
    expect(verifications).toBe(1);
    // Another client still gets a real check.
    await checkSecret(h.ctx, "2.2.2.2", "guess", verify);
    expect(verifications).toBe(2);
  });

  it("clears failures when the password changes", async () => {
    h = harness();
    const cookie = await h.claim();
    for (let i = 0; i < 4; i++) await login(`wrong-${i}`);
    // "wrong-0" was rejected before; once it becomes the password it must work at once.
    const res = await h.request("/api/auth/password", { method: "POST", headers: CSRF, cookie, json: { current: PASSWORD, next: "wrong-0-but-now-right" } });
    expect(res.status).toBe(204);
    expect(adminAuth(h.ctx).limiter.size).toBe(0);
    expect((await login("wrong-0-but-now-right")).status).toBe(204);
  });

  it("keeps /health responsive while passwords are checked", async () => {
    h = harness();
    await h.claim();
    const attempts = Array.from({ length: 8 }, (_, i) => login(`parallel-${i}`, { "x-forwarded-for": `10.0.0.${i}` }));
    const started = performance.now();
    expect((await h.request("/health")).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(100);
    await Promise.all(attempts);
  });
});

describe("N1: concurrent guesses", () => {
  it("verifies at most 5 of 200 concurrent distinct guesses from one client", async () => {
    h = harness();
    await h.claim();
    const codes: Record<number, number> = {};
    await Promise.all(
      Array.from({ length: 200 }, async (_, i) => {
        const res = await login(`guess-${i}`);
        codes[res.status] = (codes[res.status] ?? 0) + 1;
      }),
    );
    // 401 = actually verified and wrong; everything else was turned away without hashing.
    expect(codes[401] ?? 0).toBeLessThanOrEqual(5);
    expect(codes[429]).toBeGreaterThanOrEqual(195);
    expect((await login(PASSWORD)).status).toBe(429);
  });

  it("records the attempt before verifying, and never runs more than 4 verifications at once", async () => {
    h = harness();
    let running = 0;
    let peak = 0;
    let calls = 0;
    const slowWrong = async () => {
      calls++;
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return false;
    };
    // One client: everything is serialized and capped at 5 distinct secrets.
    await Promise.all(Array.from({ length: 50 }, (_, i) => checkSecret(h!.ctx, "203.0.113.1", `s${i}`, slowWrong)));
    expect(calls).toBeLessThanOrEqual(5);
    expect(peak).toBe(1);
    // Many clients: at most MAX_CONCURRENT_VERIFICATIONS at a time.
    calls = 0;
    peak = 0;
    await Promise.all(Array.from({ length: 20 }, (_, i) => checkSecret(h!.ctx, `198.51.100.${i}`, "x", slowWrong)));
    expect(calls).toBe(20);
    expect(peak).toBe(MAX_CONCURRENT_VERIFICATIONS);
  });

  it("refunds the reservation when the secret is right", async () => {
    h = harness();
    const { limiter } = adminAuth(h.ctx);
    for (let i = 0; i < 4; i++) await checkSecret(h.ctx, "203.0.113.2", `bad-${i}`, () => false);
    // The 5th distinct secret is reserved (which bans) before it's verified; success lifts it.
    expect((await checkSecret(h.ctx, "203.0.113.2", "good", () => true)).ok).toBe(true);
    expect(limiter.bannedMinutes("203.0.113.2")).toBe(0);
  });
});

describe("M2: client identity", () => {
  it("uses the rightmost X-Forwarded-For entry behind a trusted proxy", async () => {
    h = harness();
    await h.claim();
    h.ctx.config.trustProxy = true;
    // The attacker rotates the spoofable left part; the proxy-appended address stays the same.
    for (let i = 0; i < 5; i++) await login(`wrong-${i}`, { "x-forwarded-for": `6.6.6.${i}, 203.0.113.7` });
    expect((await login(PASSWORD, { "x-forwarded-for": "9.9.9.9, 203.0.113.7" })).status).toBe(429);
    // Other clients are unaffected.
    expect((await login(PASSWORD, { "x-forwarded-for": "198.51.100.1" })).status).toBe(204);
  });

  it("ignores X-Forwarded-For from a public peer, and entries that aren't IPs", async () => {
    h = harness();
    await h.claim();
    h.ctx.config.trustProxy = true;
    const peer = "198.51.100.77";
    for (let i = 0; i < 5; i++) await h.request("/api/auth/login", { method: "POST", headers: { ...CSRF, "x-forwarded-for": `203.0.113.${i}` }, json: { password: `w${i}` }, peer });
    // All five counted against the public peer itself.
    expect((await h.request("/api/auth/login", { method: "POST", headers: CSRF, json: { password: PASSWORD }, peer })).status).toBe(429);
    // Garbage in the chosen entry falls back to the (loopback) socket address.
    for (let i = 0; i < 5; i++) await login(`x${i}`, { "x-forwarded-for": "not-an-ip" });
    expect((await login(PASSWORD, { "x-forwarded-for": "198.51.100.8" })).status).toBe(204);
    expect((await login(PASSWORD)).status).toBe(429);
  });

  it("trusts forwarding headers only from loopback", async () => {
    h = harness();
    await h.claim();
    h.ctx.config.trustProxy = true;
    const from = (peer: string, xff: string, password: string) =>
      h!.request("/api/auth/login", { method: "POST", headers: { ...CSRF, "x-forwarded-for": xff }, json: { password }, peer });

    // A LAN peer can't pick its address: failures count against the peer itself.
    for (let i = 0; i < 5; i++) await from("192.168.1.50", `203.0.113.${i}`, `lan-${i}`);
    expect((await from("192.168.1.50", "203.0.113.99", PASSWORD)).status).toBe(429);

    // A loopback proxy is believed.
    for (let i = 0; i < 5; i++) await from("127.0.0.1", "198.51.100.1", `lo-${i}`);
    expect((await from("127.0.0.1", "198.51.100.1", PASSWORD)).status).toBe(429);
    expect((await from("127.0.0.1", "198.51.100.2", PASSWORD)).status).toBe(204);
    expect((await from("::ffff:127.0.0.1", "198.51.100.3", PASSWORD)).status).toBe(204);
    expect(["::1", "127.8.9.10"].map(isTrustedProxy)).toEqual([true, true]);
    expect(["10.1.2.3", "fd12::1", "::ffff:10.0.0.1", "not-an-ip"].map(isTrustedProxy)).toEqual([false, false, false, false]);
  });

  it("marks the session cookie Secure from X-Forwarded-Proto only behind a trusted proxy", async () => {
    h = harness();
    await h.claim();
    h.ctx.config.trustProxy = true;
    const cookieFrom = async (peer: string) => {
      const res = await h!.request("/api/auth/login", { method: "POST", headers: { ...CSRF, "x-forwarded-proto": "https" }, json: { password: PASSWORD }, peer });
      expect(res.status).toBe(204);
      return res.headers.get("set-cookie") ?? "";
    };
    expect(await cookieFrom("192.168.1.60")).not.toMatch(/;\s*Secure/i);
    expect(await cookieFrom("127.0.0.1")).toMatch(/;\s*Secure/i);
  });

  it("keys IPv6 clients by /64", () => {
    expect(clientKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(clientKey("192.0.2.1")).toBe("192.0.2.1");
    const limiter = new LoginLimiter();
    for (let i = 0; i < 5; i++) limiter.fail(`2001:db8:1:2::${i + 1}`, `p${i}`);
    expect(limiter.bannedMinutes("2001:db8:1:2:ffff::9")).toBe(15);
  });

  it("slows everyone down past the global budget, but never refuses", async () => {
    let t = 0;
    const limiter = new LoginLimiter(() => t);
    for (let i = 0; i < GLOBAL_MAX_FAILURES - 1; i++) limiter.fail(`10.${i >> 8}.${i & 255}.1`, `p${i}`);
    expect(limiter.overGlobalBudget()).toBe(false);
    // Claim failures don't count.
    limiter.fail("10.9.9.9", "claim:x", { global: false });
    expect(limiter.overGlobalBudget()).toBe(false);
    limiter.fail("10.9.9.10", "last");
    expect(limiter.overGlobalBudget()).toBe(true);
    expect(limiter.bannedMinutes("192.0.2.200")).toBe(0);
    t += BAN_MS + 1;
    expect(limiter.overGlobalBudget()).toBe(false);

    h = harness();
    const { limiter: real } = adminAuth(h.ctx);
    for (let i = 0; i < GLOBAL_MAX_FAILURES; i++) real.fail(`10.${i >> 8}.${i & 255}.1`, `p${i}`);
    let started = performance.now();
    const ok = await checkSecret(h.ctx, "192.0.2.200", "right", () => true, { slowdownMs: 150 });
    expect(ok.ok).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    started = performance.now();
    await checkSecret(h.ctx, "192.0.2.201", "token", () => false, { global: false, slowdownMs: 150 });
    expect(performance.now() - started).toBeLessThan(140);
  });

  it("bounds its memory", () => {
    const limiter = new LoginLimiter();
    for (let i = 0; i < MAX_ENTRIES + 50; i++) limiter.fail(`ip-${i}`, "x");
    expect(limiter.size).toBe(MAX_ENTRIES);
  });
});

describe("M3: body limits", () => {
  it("rejects oversized bodies before parsing", async () => {
    h = harness();
    const cookie = await h.claim();
    let res = await login("x".repeat(20_000));
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe("payload_too_large");
    res = await h.request("/api/settings", { method: "PATCH", headers: CSRF, cookie, json: { publicUrl: "x".repeat(2 * 1024 * 1024) } });
    expect(res.status).toBe(413);
    res = await login("x".repeat(2000));
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toMatch(/at most 1024/);
  });

  it("gives the unauthenticated setup token check the small auth limit", async () => {
    h = harness();
    const res = await h.request("/api/setup/verify-token", { method: "POST", headers: CSRF, json: { token: "x".repeat(20_000) } });
    expect(res.status).toBe(413);
  });
});

describe("N3: CSP hashes only known scripts", () => {
  it("allows registered and index.html scripts, never ones found in a response", () => {
    const injected = "fetch('/api/settings')";
    expect(contentSecurityPolicy()).not.toContain(scriptHash(injected));
    registerInlineScript("window.__static = 1");
    expect(contentSecurityPolicy()).toContain(`'${scriptHash("window.__static = 1")}'`);
    const html = `<script>a()</script><script type="application/json">{"x":1}</script><script src="/x.js"></script><script type="module">b()</script>`;
    expect(inlineScriptHashes(html)).toEqual([scriptHash("a()"), scriptHash("b()")]);
  });
});

describe("N4: MCP and agent body limits", () => {
  it("rejects oversized bodies on /mcp and /agent", async () => {
    h = harness();
    let res = await h.request("/mcp", { method: "POST", json: { x: "x".repeat(5 * 1024 * 1024) } });
    expect(res.status).toBe(413);
    res = await h.request("/agent/anything", { method: "POST", json: { x: "x".repeat(100 * 1024) } });
    expect(res.status).toBe(413);
  });
});

describe("m5: master key guard", () => {
  it("refuses a missing or wrong key once secrets are stored", async () => {
    h = harness();
    const { config } = h.ctx;
    h.ctx.db.run(
      "INSERT INTO accounts (id, email, refresh_token_enc, created_at) VALUES ('acc_1', 'a@example.com', ?, ?)",
      h.ctx.crypto.encrypt("refresh-token"),
      new Date().toISOString(),
    );
    expect(() => assertMasterKeyUsable(config, "")).not.toThrow();
    const key = Buffer.from(readFileSync(config.masterKeyPath, "utf8").trim(), "base64");
    expect(key.length).toBe(32);
    expect(() => assertMasterKeyUsable(config, Buffer.alloc(32, 7).toString("base64"))).toThrow(/can't decrypt/);
    expect(() => assertMasterKeyUsable(config, key.toString("base64"))).not.toThrow();
    rmSync(config.masterKeyPath);
    expect(() => assertMasterKeyUsable(config, "")).toThrow(/no master key/);
    await expect(startServer({ config: { ...config, port: 0 } })).rejects.toThrow(/no master key/);
    expect(existsSync(config.masterKeyPath)).toBe(false);
  });

  it("allows a fresh data directory", () => {
    const config = testConfig();
    try {
      expect(() => assertMasterKeyUsable(config, "")).not.toThrow();
    } finally {
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });
});

describe("files", () => {
  it("creates the database owner-only", () => {
    h = harness();
    expect(statSync(h.ctx.config.dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(h.ctx.config.dataDir).mode & 0o777).toBe(0o700);
  });
});

describe("instance lock", () => {
  it("refuses a second instance on the same data directory and replaces stale locks", async () => {
    const config = testConfig();
    const overrides = { google: fakeGoogle(), ingest: fakeIngest() };
    try {
      writeFileSync(lockPath(config.dataDir), JSON.stringify({ pid: 2 ** 22 + 12345, host: "0.0.0.0", port: 1, startedAt: "" }));
      const running = await startServer({ config, overrides });
      await expect(startServer({ config: { ...config, port: 0 }, overrides })).rejects.toThrow(/already running .*pid \d+, port \d+/);
      await running.close();
      expect(existsSync(lockPath(config.dataDir))).toBe(false);
      const lock = acquireInstanceLock(config);
      lock.release();
    } finally {
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });
});

describe("instance lock: lost setup link", () => {
  it("points to reset-password (with --data for a custom directory) while the instance isn't set up", () => {
    const config = testConfig();
    try {
      const lock = acquireInstanceLock(config);
      // No setup token yet (claimed, or never started): no hint.
      expect(() => acquireInstanceLock(config)).toThrow(/^(?![\s\S]*Lost its setup link)/);
      writeFileSync(join(config.dataDir, "setup-token"), "tok\n");
      expect(() => acquireInstanceLock(config)).toThrow(`Lost its setup link? \`${resetPasswordCommand(config.dataDir)}\` prints it again.`);
      expect(resetPasswordCommand(config.dataDir)).toMatch(/reset-password --data \S+/);
      expect(resetPasswordCommand(join(homedir(), ".xaq"))).toMatch(/reset-password$/);
      expect(resetPasswordCommand("/srv/agent inbox")).toMatch(/reset-password --data '\/srv\/agent inbox'$/);
      lock.release();
    } finally {
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });
});

describe("instance lock: pid reuse", () => {
  const lockWith = (dataDir: string, info: Record<string, unknown>) =>
    writeFileSync(lockPath(dataDir), JSON.stringify({ host: "0.0.0.0", port: 1, startedAt: "", ...info }));

  it("treats a lock naming our own pid as stale unless we hold it (containers are always pid 1)", () => {
    const config = testConfig();
    try {
      lockWith(config.dataDir, { pid: process.pid });
      expect(runningInstance(config.dataDir)).toBeNull();
      const lock = acquireInstanceLock(config);
      expect(runningInstance(config.dataDir)?.pid).toBe(process.pid);
      expect(() => acquireInstanceLock(config)).toThrow(/already running/);
      lock.release();
    } finally {
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("treats a live foreign pid from another boot or with another start time as stale", () => {
    const config = testConfig();
    const pid = process.ppid;
    try {
      lockWith(config.dataDir, { pid, bootId: "00000000-0000-0000-0000-000000000000" });
      if (bootId()) expect(runningInstance(config.dataDir)).toBeNull();
      lockWith(config.dataDir, { pid, bootId: bootId(), processStart: "1" });
      if (processStartTime(pid)) expect(runningInstance(config.dataDir)).toBeNull();
      // The same process, same boot, same start time: really running.
      lockWith(config.dataDir, { pid, bootId: bootId(), processStart: processStartTime(pid) });
      expect(runningInstance(config.dataDir)?.pid).toBe(pid);
      expect(() => acquireInstanceLock(config)).toThrow(/already running/);
      lockWith(config.dataDir, { pid, bootId: "00000000-0000-0000-0000-000000000000" });
      if (bootId()) acquireInstanceLock(config).release();
    } finally {
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });
});

describe("sessions", () => {
  it("ends at the absolute lifetime even when used daily", () => {
    h = harness();
    let t = Date.parse("2026-01-01T00:00:00Z");
    const store = new SessionStore(h.ctx.db, () => t);
    const token = store.create();
    while (t < Date.parse("2026-01-01T00:00:00Z") + SESSION_MAX_AGE_MS - 2 * 86_400_000) {
      t += 86_400_000;
      expect(store.check(token).valid).toBe(true);
    }
    t += 3 * 86_400_000;
    expect(store.check(token).valid).toBe(false);
    expect(SESSION_TTL_MS).toBeLessThan(SESSION_MAX_AGE_MS);
  });
});
