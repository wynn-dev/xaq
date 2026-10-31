// Broker M1 PRs 3/4: the upstream manager and the credential store, against the fake upstream
// (test/fake-mcp-upstream.ts). Offline and deterministic: every server listens on 127.0.0.1, DNS is a fake lookup.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.ts";
import { expiryNotice } from "../server/broker/credentials/expiry.ts";
import { Refresher } from "../server/broker/credentials/refresher.ts";
import { scrubText } from "../server/broker/credentials/scrub.ts";
import { discoverAuthServer, fetchJsonDoc } from "../server/broker/upstream/discovery.ts";
import { allowFromColumn, canonicalPrivateTarget, checkTarget, guardedFetch } from "../server/broker/upstream/fetch.ts";
import { exchangeCode } from "../server/broker/upstream/oauth.ts";
import { HTTPS_LOCALHOST_REDIRECT, UpstreamRuntime } from "../server/broker/upstream/runtime.ts";
import { type RefreshFn, SourceError, type StoredTokens, type ToolCallContext } from "../server/broker/types.ts";
import type { ConnectionEvent } from "../server/broker/credentials/store.ts";
import type { AppContext } from "../server/context.ts";
import type { LookupFn } from "../server/webhooks/ssrf.ts";
import { type FakeMcpUpstream, type FakeUpstreamOptions, startFakeMcpUpstream } from "./fake-mcp-upstream.ts";
import { testContext } from "./helpers.ts";

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  cleanup = [];
});

async function fake(opts: FakeUpstreamOptions = {}): Promise<FakeMcpUpstream> {
  const up = await startFakeMcpUpstream(opts);
  cleanup.push(() => up.close());
  return up;
}

/** A fake resolver: unknown names don't resolve. */
const dns =
  (map: Record<string, string[]>): LookupFn =>
  async (host) => {
    const a = map[host];
    if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

interface Env {
  ctx: AppContext;
  rt: UpstreamRuntime;
  events: ConnectionEvent[];
  /** Moves the broker's clock (and the fake's, when given). */
  advance(ms: number, up?: FakeMcpUpstream): void;
}

function env(o: { lookup?: LookupFn; dial?: (url: URL) => { address: string; port: number }; callTimeoutMs?: number } = {}): Env {
  const t = testContext();
  t.ctx.settings.update({ brokerUpstreams: true });
  let skew = 0;
  const events: ConnectionEvent[] = [];
  const rt = new UpstreamRuntime(t.ctx, {
    emit: (e) => void events.push(e),
    now: () => Date.now() + skew,
    lookup: o.lookup ?? dns({}),
    dial: o.dial ? (_target, url) => o.dial!(url) : undefined,
    callTimeoutMs: o.callTimeoutMs,
  });
  cleanup.push(() => t.dispose());
  cleanup.push(() => rt.stop());
  return {
    ctx: t.ctx,
    rt,
    events,
    advance(ms, up) {
      skew += ms;
      up?.advanceTime(ms);
    },
  };
}

let seq = 0;
function addConnection(ctx: AppContext, c: { url: string; auth: "none" | "header" | "oauth"; privateTarget?: string | null; preset?: string | null; kind?: string }): string {
  const id = `con_test${++seq}`;
  const ts = new Date().toISOString();
  ctx.db.run(
    "INSERT INTO connections (id, kind, preset, slug, name, url, auth_type, private_target, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    c.kind ?? "remote_http",
    c.preset ?? null,
    `up${seq}`,
    `Upstream ${seq}`,
    c.url,
    c.auth,
    c.privateTarget === undefined ? new URL(c.url).origin.replace(/^(https?:\/\/[^/]+?)(:\d+)?$/, (_m, o: string, p?: string) => o + (p ?? (o.startsWith("https") ? ":443" : ":80"))) : c.privateTarget,
    ts,
    ts,
  );
  return id;
}

const status = (ctx: AppContext, id: string) => ctx.db.get<{ status: string; status_reason: string | null; expires_at: string | null; protocol: string | null }>("SELECT status, status_reason, expires_at, protocol FROM connections WHERE id = ?", id)!;

const callCtx = (connectionId: string, signal: AbortSignal = AbortSignal.timeout(10_000)): ToolCallContext => ({ agentId: "agt_x", connectionId, signal, auditDetail: {} });

const firstText = (r: { content: { type: string; [k: string]: unknown }[] }) => String(r.content[0]?.text ?? "");

/** Connects an OAuth connection through the real flow: startConnect → the fake's authorize → the callback route. */
async function connectOAuth(e: Env, id: string, up: FakeMcpUpstream, opts: Parameters<UpstreamRuntime["startConnect"]>[1] = {}) {
  const start = await e.rt.startConnect(id, opts);
  const cb = await up.oauth!.followAuthorize(start.authUrl);
  expect(cb.searchParams.get("state")).toBe(start.state);
  return { start, cb, done: await e.rt.finishConnect({ code: cb.searchParams.get("code"), state: cb.searchParams.get("state"), iss: cb.searchParams.get("iss") }) };
}

// ───────────────────────────── guarded fetch ─────────────────────────────

describe("guarded fetch: SSRF guard and the private-target allow", () => {
  async function server(handler: Parameters<typeof createServer>[1]): Promise<{ origin: string; port: number }> {
    const s: Server = createServer(handler);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise((r) => s.close(() => r(undefined))));
    const port = (s.address() as AddressInfo).port;
    return { origin: `http://127.0.0.1:${port}`, port };
  }

  it("refuses loopback, private and link-local targets without an allow; plain http to a public host", async () => {
    const f = guardedFetch({ lookup: dns({ "lan.test": ["10.1.2.3"], "pub.test": ["93.184.216.34"], "meta.test": ["169.254.169.254"] }) });
    cleanup.push(() => f.close());
    for (const url of ["http://127.0.0.1:9/", "http://lan.test/", "http://meta.test/", "http://pub.test/", "http://[::1]:9/", "http://100.100.1.1/"]) {
      const err = await f(url).catch((x: unknown) => x);
      expect(err, url).toBeInstanceOf(SourceError);
      expect((err as SourceError).code, url).toBe("blocked_target");
    }
  });

  it("an allow covers exactly its scheme://host:port: another port, another private host, link-local, metadata and mapped IPv6 stay blocked", async () => {
    const a = await server((_req, res) => res.end("ok"));
    const lookup = dns({ "forge.test": ["100.104.249.49"], "ll.test": ["169.254.10.10"], "mapped.test": ["::ffff:127.0.0.1"], "md6.test": ["fd00:ec2::254"] });
    const f = guardedFetch({ allow: { origin: a.origin }, lookup });
    cleanup.push(() => f.close());
    expect(await (await f(`${a.origin}/x`)).text()).toBe("ok");
    for (const url of ["http://127.0.0.1:9/", "http://127.0.0.2:" + a.port + "/", "http://forge.test:3773/"]) {
      expect(((await f(url).catch((x: unknown) => x)) as SourceError).code, url).toBe("blocked_target");
    }
    // Under an allow pinned to those hosts, link-local, metadata and IPv4-mapped answers are still refused.
    for (const host of ["ll.test", "mapped.test", "md6.test"]) {
      const err = await checkTarget(new URL(`http://${host}:80/`), { allow: { origin: `http://${host}:80` }, lookup }).catch((x: unknown) => x);
      expect((err as SourceError).code, host).toBe("blocked_target");
    }
    // A tailnet (CGNAT) host with its allow passes the guard.
    await expect(checkTarget(new URL("http://forge.test:3773/mcp"), { allow: { origin: "http://forge.test:3773" }, lookup })).resolves.toMatchObject({ address: "100.104.249.49" });
    await expect(checkTarget(new URL("http://100.104.249.49:3773/mcp"), { allow: { origin: "http://100.104.249.49:3773" }, lookup })).resolves.toBeTruthy();
  });

  it("follows at most 3 redirects, re-checking every hop; a redirect to another private target is refused", async () => {
    const other = await server((_req, res) => res.end("other"));
    let hops = 0;
    const a = await server((req, res) => {
      if (req.url === "/to-other") return res.writeHead(302, { location: `${other.origin}/` }).end();
      if (req.url === "/loop") {
        hops++;
        return res.writeHead(307, { location: "/loop" }).end();
      }
      if (req.url === "/same") return res.writeHead(301, { location: "/final" }).end();
      res.end(`final ${req.method}`);
    });
    const f = guardedFetch({ allow: { origin: a.origin } });
    cleanup.push(() => f.close());
    expect(await (await f(`${a.origin}/same`)).text()).toBe("final GET");
    expect(((await f(`${a.origin}/to-other`).catch((x: unknown) => x)) as SourceError).code).toBe("blocked_target");
    const loop = await f(`${a.origin}/loop`).catch((x: unknown) => x);
    expect((loop as SourceError).message).toContain("more than 3");
    expect(hops).toBe(4);
    // A caller handling redirects itself gets the 3xx (its next request is checked again).
    expect((await f(`${a.origin}/same`, { redirect: "manual" })).status).toBe(301);
  });

  it("caps response bodies", async () => {
    const big = "x".repeat(64 * 1024);
    const a = await server((req, res) => {
      if (req.url === "/declared") return res.writeHead(200, { "content-length": String(big.length) }).end(big);
      res.write(big);
      res.end(big);
    });
    const f = guardedFetch({ allow: { origin: a.origin }, maxBytes: 32 * 1024 });
    cleanup.push(() => f.close());
    expect(((await f(`${a.origin}/declared`).catch((x: unknown) => x)) as SourceError).message).toContain("over the");
    const streamed = await f(`${a.origin}/streamed`);
    await expect(streamed.text()).rejects.toBeTruthy();
  });

  it("private_target must be canonical scheme://host:port", () => {
    expect(canonicalPrivateTarget("http://127.0.0.1:3773")).toBe("http://127.0.0.1:3773");
    expect(canonicalPrivateTarget("http://100.104.249.49:3773")).toBe("http://100.104.249.49:3773");
    expect(() => canonicalPrivateTarget("https://[::1]:8443")).toThrow(); // the schema CHECK refuses brackets
    for (const bad of [
      "http://127.0.0.1", // no explicit port
      "http://127.0.0.1:3773/",
      "http://127.0.0.1:3773/mcp",
      "http://127.0.0.1:3773?x=1",
      "http://u:p@127.0.0.1:3773",
      "http://0x7f.0.0.1:80",
      "http://0177.0.0.1:80",
      "http://2130706433:80",
      "http://[::ffff:127.0.0.1]:80",
      "http://Host.Example:80",
      "http://h%2e:80",
      "http://h\\x:80",
      "http://h\t:80",
      "ftp://h:21",
    ]) {
      expect(() => canonicalPrivateTarget(bad), bad).toThrow();
    }
  });
});

// ───────────────────────────── discovery ─────────────────────────────

describe("strict discovery", () => {
  it("a 200 with HTML is not metadata (T3's SPA fallback); JSON with the exact issuer is", async () => {
    const up = await fake({ auth: { kind: "oauth" }, spaFallback: true });
    const allow = { origin: canonicalPrivateTarget(up.origin.replace(/\/$/, "")) };
    const f = guardedFetch({ allow });
    cleanup.push(() => f.close());
    expect(await fetchJsonDoc(f, `${up.origin}/.well-known/openid-configuration`)).toBeNull();
    const md = await discoverAuthServer(f, up.oauth!.issuer, allow);
    expect(md.issuer).toBe(up.oauth!.issuer);
  });

  it("refuses a wrong issuer and a server without PKCE S256", async () => {
    const up = await fake({ auth: { kind: "oauth" } });
    const allow = { origin: up.origin };
    const f = guardedFetch({ allow });
    cleanup.push(() => f.close());
    up.oauth!.settings.metadataIssuer = "http://evil.example";
    await expect(discoverAuthServer(f, up.oauth!.issuer, allow)).rejects.toThrow(/expected/);
    up.oauth!.settings.metadataIssuer = null;
    up.oauth!.settings.pkce = false;
    await expect(discoverAuthServer(f, up.oauth!.issuer, allow)).rejects.toThrow(/S256/);
  });
});

// ───────────────────────────── OAuth connections ─────────────────────────────

describe("MCP OAuth connections", () => {
  it("DCR, PKCE S256, state, iss and resource; the callback route finishes it; the client is reused on reconnect", async () => {
    const up = await fake({ auth: { kind: "oauth", requireResource: true, scopesSupported: ["mcp", "offline_access"] } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    const start = await e.rt.startConnect(id);
    const auth = new URL(start.authUrl);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("resource")).toBe(up.url);
    expect(auth.searchParams.get("scope")?.split(" ")).toContain("offline_access");
    expect(start.redirectUri).toMatch(/\/oauth\/connections\/callback$/);
    // The verifier never sits in the plaintext oauth_states row.
    expect(e.ctx.db.get<{ code_verifier: string; connection_id: string }>("SELECT code_verifier, connection_id FROM oauth_states WHERE state = ?", start.state)).toEqual({ code_verifier: "", connection_id: id });
    const cb = await up.oauth!.followAuthorize(start.authUrl);
    const page = await createApp(e.ctx).request(`/oauth/connections/callback${cb.search}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("agentinbox:connection-oauth");
    expect(html).toContain("Upstream");
    expect(up.oauth!.registrations.size).toBe(1);
    expect(status(e.ctx, id).status).toBe("active");
    // Replaying the callback: state is single use.
    expect((await createApp(e.ctx).request(`/oauth/connections/callback${cb.search}`)).status).toBe(400);

    const src = e.rt.source(id);
    expect((await src.listTools(AbortSignal.timeout(5000))).tools.map((t) => t.name)).toContain("echo");
    expect(firstText(await src.callTool("echo", { a: 1 }, callCtx(id)))).toBe('{"a":1}');

    await connectOAuth(e, id, up);
    expect(up.oauth!.registrations.size).toBe(1); // never re-registered casually
  });

  it("two concurrent Reconnects keep their own verifiers", async () => {
    const up = await fake({ auth: { kind: "oauth" } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    const s1 = await e.rt.startConnect(id);
    const s2 = await e.rt.startConnect(id);
    const cb1 = await up.oauth!.followAuthorize(s1.authUrl);
    const cb2 = await up.oauth!.followAuthorize(s2.authUrl);
    await e.rt.finishConnectFromUrl(cb2.toString());
    await e.rt.finishConnectFromUrl(`?${cb1.searchParams.toString()}`);
    expect(status(e.ctx, id).status).toBe("active");
  });

  it("an iss from another server is refused before the code is redeemed (RFC 9207)", async () => {
    const up = await fake({ auth: { kind: "oauth", issMode: "wrong" } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    const start = await e.rt.startConnect(id);
    const cb = await up.oauth!.followAuthorize(start.authUrl);
    await expect(e.rt.finishConnect({ code: cb.searchParams.get("code"), state: cb.searchParams.get("state"), iss: cb.searchParams.get("iss") })).rejects.toMatchObject({ code: "oauth_issuer" });
    expect(up.requests.some((r) => r.path === "/token")).toBe(false);
  });

  it("an authorization server on another (private) origin goes through the normal guard", async () => {
    const up = await fake({ auth: { kind: "oauth", authServer: "separate" } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    await expect(e.rt.startConnect(id)).rejects.toMatchObject({ code: "blocked_target" });
  });

  it("refresh rotation: proactive and single-flight under concurrent calls; reactive on a 401", async () => {
    const up = await fake({ auth: { kind: "oauth", accessTokenTtlSec: 3600 } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    await connectOAuth(e, id, up);
    const src = e.rt.source(id);
    await src.callTool("echo", {}, callCtx(id));
    const refreshes = () => up.requests.filter((r) => r.path === "/token" && r.body.includes("grant_type=refresh_token"));
    const before = e.rt.store.tokens(id)!;

    // Inside the last 10 % of the lifetime: proactive, one refresh for three concurrent calls.
    e.advance(3300_000, up);
    await Promise.all([1, 2, 3].map((n) => src.callTool("echo", { n }, callCtx(id))));
    expect(refreshes().map((r) => r.status)).toEqual([200]);
    const after = e.rt.store.tokens(id)!;
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(refreshes()[0]!.body).toContain(`resource=${encodeURIComponent(up.url)}`);

    // Reactive: the server forgets the access token; a 401 refreshes once and retries once.
    up.oauth!.expireAccessTokens();
    expect(firstText(await src.callTool("echo", { r: 1 }, callCtx(id)))).toBe('{"r":1}');
    expect(refreshes()).toHaveLength(2);
    expect(up.oauth!.grants.every((g) => !g.revoked)).toBe(true);
  });

  it("reuse of a rotated-out refresh token revokes the grant: needs_reauth once, auth_failed once, then calls fail fast", async () => {
    const up = await fake({ auth: { kind: "oauth", accessTokenTtlSec: 3600 } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    await connectOAuth(e, id, up);
    const old = e.rt.store.tokens(id)!;
    const refresh = e.rt.refreshFnFor(e.rt.store && (e.ctx.db.get("SELECT * FROM connections WHERE id = ?", id) as never))!;
    await e.rt.refresher.accessToken(id, refresh, AbortSignal.timeout(5000), { force: true });
    // Something restores the old refresh token (a lost write): spending it again revokes the whole grant.
    e.rt.store.saveTokens(id, old);
    const err = await e.rt.refresher.accessToken(id, refresh, AbortSignal.timeout(5000), { force: true }).catch((x: unknown) => x);
    expect((err as SourceError).code).toBe("needs_reauth");
    expect(up.oauth!.grants[0]!.revoked).toBe(true);
    expect(status(e.ctx, id).status).toBe("needs_reauth");
    const src = e.rt.source(id);
    const n = up.requests.length;
    await expect(src.callTool("echo", {}, callCtx(id))).rejects.toMatchObject({ code: "needs_reauth", message: expect.stringContaining("Reconnect") });
    expect(up.requests.length).toBe(n);
    e.rt.store.markNeedsReauth(id, "again");
    expect(e.events.filter((x) => x.type === "connection.auth_failed")).toHaveLength(1);
    expect(e.ctx.db.all("SELECT 1 FROM audit_log WHERE action = 'connection.auth_failed' AND target = ?", id)).toHaveLength(1);
    // Never a secret in the stored reason.
    expect(status(e.ctx, id).status_reason).not.toContain(old.refreshToken!);
  });

  it("forced invalid_grant on a 401 → SourceError needs_reauth", async () => {
    const up = await fake({ auth: { kind: "oauth" } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    await connectOAuth(e, id, up);
    up.oauth!.settings.forceInvalidGrant = true;
    up.oauth!.expireAccessTokens();
    await expect(e.rt.source(id).callTool("echo", {}, callCtx(id))).rejects.toMatchObject({ code: "needs_reauth" });
    expect(status(e.ctx, id).status).toBe("needs_reauth");
  });

  it("no refresh grant (T3): dated warnings at 7 and 1 days, then needs_reauth before any 401", async () => {
    const up = await fake({ auth: { kind: "oauth", refreshGrant: false, accessTokenTtlSec: 30 * 86400 } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    await connectOAuth(e, id, up);
    expect(e.rt.store.tokens(id)!.refreshToken).toBeNull();
    const exp = status(e.ctx, id).expires_at!;
    expect(Date.parse(exp) - Date.now()).toBeGreaterThan(29 * 86400_000);

    e.advance(23.5 * 86400_000, up);
    await e.rt.sweep();
    await e.rt.sweep();
    expect(e.events.filter((x) => x.type === "connection.expiring").map((x) => x.detail.daysLeft)).toEqual([7]);
    e.advance(6 * 86400_000, up);
    await e.rt.sweep();
    expect(e.events.filter((x) => x.type === "connection.expiring").map((x) => x.detail.daysLeft)).toEqual([7, 1]);
    // Still valid: calls work until the day.
    expect(firstText(await e.rt.source(id).callTool("echo", { ok: 1 }, callCtx(id)))).toBe('{"ok":1}');
    e.advance(1 * 86400_000, up);
    const n = up.requests.length;
    await expect(e.rt.source(id).callTool("echo", {}, callCtx(id))).rejects.toMatchObject({ code: "needs_reauth" });
    expect(up.requests.filter((r) => r.server === "mcp").length).toBe(up.requests.slice(0, n).filter((r) => r.server === "mcp").length);
    expect(status(e.ctx, id).status).toBe("needs_reauth");
    expect(expiryNotice({ name: "t3 forge", expiresAt: new Date(Date.now() + 6.5 * 86400_000).toISOString() })).toMatchObject({ daysLeft: 7, level: 7 });
  });

  it("a preset's reconnect cap becomes the dated expiry", async () => {
    const up = await fake({ auth: { kind: "oauth" } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    await connectOAuth(e, id, up, { reconnectPolicy: { maxLifetimeDays: 180, idleDays: 30 } });
    expect(Math.round((Date.parse(status(e.ctx, id).expires_at!) - Date.now()) / 86400_000)).toBe(180);
  });

  it("insufficient_scope: the scope union is kept and the connection needs a human", async () => {
    const up = await fake({ auth: { kind: "oauth", scopesSupported: ["read"], requiredScope: "write" } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    await connectOAuth(e, id, up);
    await expect(e.rt.source(id).listTools(AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "needs_reauth" });
    expect(e.rt.store.tokens(id)!.scope?.split(" ")).toContain("write");
    expect(status(e.ctx, id).status).toBe("needs_reauth");
  });

  it("the callback route 404s while brokerUpstreams is off; paste mode accepts the https://localhost landing URL", async () => {
    const up = await fake({ auth: { kind: "oauth" } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    const start = await e.rt.startConnect(id, { redirect: "https_localhost" });
    expect(start).toMatchObject({ callbackMode: "paste", redirectUri: HTTPS_LOCALHOST_REDIRECT });
    const cb = await up.oauth!.followAuthorize(start.authUrl);
    expect(cb.origin).toBe("https://localhost");
    e.ctx.settings.update({ brokerUpstreams: false });
    expect((await createApp(e.ctx).request(`/oauth/connections/callback${cb.search}`)).status).toBe(404);
    e.ctx.settings.update({ brokerUpstreams: true });
    await expect(e.rt.finishConnectFromUrl(cb.toString())).resolves.toMatchObject({ connectionId: id });
  });
});

// ───────────────────────────── transports, static auth, timeouts ─────────────────────────────

describe("remote ToolSource: protocol generations, static auth, cancellation", () => {
  it("2025 sessions, 2026 stateless and legacy HTTP+SSE, with a bearer; the generation is cached per connection", async () => {
    const e = env();
    for (const [protocol, path, verdict] of [
      ["streamable-2025", "/mcp", "2025-11-25"],
      ["stateless-2026", "/mcp", "2026-07-28"],
      ["sse-2024", "/sse", "sse:2024-11-05"],
    ] as const) {
      const up = await fake({ protocol, path, auth: { kind: "bearer", token: "tok-123456" } });
      const id = addConnection(e.ctx, { url: up.url, auth: "header" });
      e.rt.store.setHeader(id, "Authorization", "Bearer tok-123456");
      const src = e.rt.source(id);
      expect((await src.listTools(AbortSignal.timeout(5000))).tools, protocol).toHaveLength(6);
      expect(firstText(await src.callTool("echo", { p: protocol }, callCtx(id))), protocol).toBe(JSON.stringify({ p: protocol }));
      expect(status(e.ctx, id).protocol, protocol).toBe(verdict);
      // Only our credential goes upstream.
      const auths = new Set(up.requests.filter((r) => r.server === "mcp").map((r) => r.headers.authorization));
      expect([...auths], protocol).toEqual(["Bearer tok-123456"]);
      // A fresh source reuses the cached verdict: no server/discover probe for a legacy server.
      await e.rt.invalidate(id);
      const n = up.requests.length;
      await e.rt.source(id).listTools(AbortSignal.timeout(5000));
      if (protocol === "streamable-2025") expect(up.requests.slice(n).map((r) => r.rpcMethod).filter(Boolean)[0]).toBe("initialize");
    }
  });

  it("a custom API-key header; a wrong key marks needs_reauth", async () => {
    const up = await fake({ protocol: "stateless-2026", auth: { kind: "bearer", token: "key-abcdef", header: "x-api-key" } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "header" });
    e.rt.store.setHeader(id, "x-api-key", "key-abcdef");
    expect(await e.rt.source(id).listTools(AbortSignal.timeout(5000))).toMatchObject({ tools: expect.any(Array) });
    e.rt.store.setHeader(id, "x-api-key", "wrong-key");
    await e.rt.invalidate(id);
    await expect(e.rt.source(id).listTools(AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "needs_reauth" });
    expect(status(e.ctx, id).status).toBe("needs_reauth");
  });

  it("a session lost to a server restart reconnects once", async () => {
    const up = await fake({ protocol: "streamable-2025" });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "none" });
    const src = e.rt.source(id);
    await src.listTools(AbortSignal.timeout(5000));
    up.expireSessions();
    expect(firstText(await src.callTool("echo", { again: true }, callCtx(id)))).toBe('{"again":true}');
  });

  it("the SSRF block: a loopback upstream without the allow is refused; probe offers the exact origin", async () => {
    const up = await fake({ auth: { kind: "oauth" } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "none", privateTarget: null });
    await expect(e.rt.source(id).listTools(AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "blocked_target" });
    expect(up.requests).toHaveLength(0);
    const p = await e.rt.probe(up.url);
    expect(p).toMatchObject({ auth: "blocked", privateTarget: up.origin });
    expect(await e.rt.probe(up.url, { privateTarget: up.origin })).toMatchObject({ auth: "oauth", issuer: up.oauth!.issuer, registration: "dcr", refresh: true });
  });

  it("probe: none, header, oauth without refresh (T3), and a tailnet host through its allow", async () => {
    const lookup = dns({ "forge.test": ["100.104.249.49"] });
    const none = await fake({ protocol: "stateless-2026" });
    const bearer = await fake({ auth: { kind: "bearer", token: "t-12345678" } });
    const t3 = await fake({ auth: { kind: "oauth", refreshGrant: false }, spaFallback: true, advertisedOrigin: "http://forge.test:3773" });
    const e = env({ lookup, dial: (url) => (url.hostname === "forge.test" ? { address: "127.0.0.1", port: Number(new URL(t3.listenOrigin).port) } : { address: url.hostname, port: Number(url.port) }) });
    expect(await e.rt.probe(none.url, { privateTarget: none.origin })).toEqual({ auth: "none" });
    expect(await e.rt.probe(bearer.url, { privateTarget: bearer.origin })).toEqual({ auth: "header" });
    expect(await e.rt.probe(t3.url)).toMatchObject({ auth: "blocked", privateTarget: "http://forge.test:3773" });
    expect(await e.rt.probe(t3.url, { privateTarget: "http://forge.test:3773" })).toMatchObject({ auth: "oauth", refresh: false });
    // And the whole OAuth flow on the tailnet host over http, token requests included.
    const id = addConnection(e.ctx, { url: t3.url, auth: "oauth", privateTarget: "http://forge.test:3773" });
    await connectOAuth(e, id, t3);
    expect(firstText(await e.rt.source(id).callTool("echo", { forge: 1 }, callCtx(id)))).toBe('{"forge":1}');
  });

  it("cancellation from the caller's signal reaches the upstream; the per-call timeout is a SourceError", async () => {
    const up = await fake({ protocol: "streamable-2025" });
    const e = env({ callTimeoutMs: 300 });
    const id = addConnection(e.ctx, { url: up.url, auth: "none" });
    const src = e.rt.source(id);
    await src.listTools(AbortSignal.timeout(5000));
    const ac = new AbortController();
    const started = Date.now();
    const call = src.callTool("slow", {}, callCtx(id, ac.signal));
    setTimeout(() => ac.abort(new Error("agent went away")), 50);
    await expect(call).rejects.toThrow("agent went away");
    expect(Date.now() - started).toBeLessThan(250);
    for (let i = 0; i < 50 && up.cancellations.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(up.cancellations.length).toBeGreaterThan(0);
    await expect(src.callTool("slow", {}, callCtx(id))).rejects.toMatchObject({ code: "timeout" });
  });
});

// ───────────────────────────── store and refresher units ─────────────────────────────

describe("credential store and refresher", () => {
  it("encrypts at rest; saveTokens is a compare-and-swap on the refresh token", () => {
    const e = env();
    const id = addConnection(e.ctx, { url: "https://example.com/mcp", auth: "oauth", privateTarget: null });
    const t: StoredTokens = { accessToken: "at-1-secret", refreshToken: "rt-1-secret", expiresAt: Date.now() + 3600_000, scope: null, issuer: "https://as" };
    expect(e.rt.store.saveTokens(id, t)).toBe(true);
    const raw = JSON.stringify(e.ctx.db.get("SELECT * FROM connection_credentials WHERE connection_id = ?", id));
    expect(raw).not.toContain("at-1-secret");
    expect(raw).not.toContain("rt-1-secret");
    expect(e.rt.store.saveTokens(id, { ...t, refreshToken: "rt-2" }, "rt-other")).toBe(false);
    expect(e.rt.store.saveTokens(id, { ...t, refreshToken: "rt-2" }, "rt-1-secret")).toBe(true);
    expect(e.rt.store.tokens(id)!.refreshToken).toBe("rt-2");
    e.rt.store.setHeader(id, "Authorization", "Bearer x");
    e.rt.store.clear(id);
    expect(e.rt.store.tokens(id)).toBeNull();
    expect(e.rt.store.header(id)).toBeNull();
  });

  it("one refresh in flight per connection, however many callers; the rotated token is saved before use", async () => {
    const e = env();
    const id = addConnection(e.ctx, { url: "https://example.com/mcp", auth: "oauth", privateTarget: null });
    const issued = Date.now() - 3500_000;
    e.rt.store.saveTokens(id, { accessToken: "a0", refreshToken: "r0", expiresAt: issued + 3600_000, issuedAt: issued, scope: null, issuer: null });
    let calls = 0;
    const refresh: RefreshFn = async (cur) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { accessToken: `a${calls}`, refreshToken: `r${calls}`, expiresAt: Date.now() + 3600_000, scope: null, issuer: null, issuedAt: Date.now(), ...(cur.refreshToken === "r0" ? {} : { accessToken: "wrong" }) };
    };
    const r = new Refresher(e.rt.store, { log: e.ctx.log });
    const tokens = await Promise.all(Array.from({ length: 5 }, () => r.accessToken(id, refresh, AbortSignal.timeout(5000))));
    expect(calls).toBe(1);
    expect(new Set(tokens)).toEqual(new Set(["a1"]));
    expect(e.rt.store.tokens(id)!.refreshToken).toBe("r1");
    // Not due: no refresh.
    await r.accessToken(id, refresh, AbortSignal.timeout(5000));
    expect(calls).toBe(1);
  });

  it("scrubs secrets from stored text", () => {
    expect(scrubText("bad token Bearer abcdefghijkl and sk-live_0123456789abcdef and ?access_token=xyz&x=1", ["mysecret123"])).not.toMatch(/abcdefghijkl|0123456789abcdef|xyz/);
    expect(scrubText("echo mysecret123", ["mysecret123"])).toBe("echo [redacted]");
  });
});

// ───────────────────────────── OAuth edge cases (fake modes added for these) ─────────────────────────────

describe("MCP OAuth: registration order and authorization server variants", () => {
  it("refuses an authorization server that doesn't advertise PKCE methods at all", async () => {
    const up = await fake({ auth: { kind: "oauth", pkce: "absent" } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    await expect(e.rt.startConnect(id)).rejects.toThrow(/S256/);
    expect(up.oauth!.registrations.size).toBe(0);
  });

  it("an issuer with a path: RFC 8414 path insertion and an exact issuer match", async () => {
    const up = await fake({ auth: { kind: "oauth", issuerPath: "/tenant1" } });
    expect(up.oauth!.issuer).toBe(`${up.origin}/tenant1`);
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    await connectOAuth(e, id, up);
    expect(up.requests.some((r) => r.path === "/.well-known/oauth-authorization-server/tenant1" && r.status === 200)).toBe(true);
    expect(firstText(await e.rt.source(id).callTool("echo", { t: 1 }, callCtx(id)))).toBe('{"t":1}');
  });

  it("iss: accepted when absent from a server that doesn't advertise it; required from one that does", async () => {
    const quiet = await fake({ auth: { kind: "oauth", advertiseIss: false, issMode: "omit" } });
    const e = env();
    const a = addConnection(e.ctx, { url: quiet.url, auth: "oauth" });
    await connectOAuth(e, a, quiet);
    expect(status(e.ctx, a).status).toBe("active");

    const loud = await fake({ auth: { kind: "oauth", issMode: "omit" } });
    const b = addConnection(e.ctx, { url: loud.url, auth: "oauth" });
    const start = await e.rt.startConnect(b);
    const cb = await loud.oauth!.followAuthorize(start.authUrl);
    await expect(e.rt.finishConnectFromUrl(cb.toString())).rejects.toMatchObject({ code: "oauth_issuer" });
  });

  it("a pre-registered client comes first; without DCR or one, the user is asked for a client ID", async () => {
    const up = await fake({
      auth: { kind: "oauth", dcr: false, preRegistered: [{ client_id: "shipped-client", redirect_uris: [], token_endpoint_auth_method: "none" }] },
    });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    await expect(e.rt.startConnect(id)).rejects.toThrow(/paste its client ID/);
    up.oauth!.registrations.get("shipped-client")!.redirect_uris = [e.rt.callback().redirectUri];
    await connectOAuth(e, id, up, { preRegistered: { client_id: "shipped-client" } });
    expect(e.rt.store.client(id)).toMatchObject({ client_id: "shipped-client", source: "pre_registered", issuer: up.oauth!.issuer });
  });

  it("a client ID metadata document on a public https install, before DCR", async () => {
    const e = env({ lookup: dns({ "broker.example": ["93.184.216.34"] }) });
    e.ctx.settings.update({ publicUrl: "https://broker.example" });
    const app = createApp(e.ctx);
    const up = await fake({ auth: { kind: "oauth", cimd: true, cimdFetch: async (url) => app.request(new URL(url).pathname) } });
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    expect(await e.rt.probe(up.url, { privateTarget: up.origin })).toMatchObject({ auth: "oauth", registration: "metadata_document" });
    await connectOAuth(e, id, up);
    expect(e.rt.store.client(id)).toMatchObject({ client_id: "https://broker.example/oauth/connections/client.json", source: "metadata_document" });
    expect(up.requests.some((r) => r.path === "/register")).toBe(false);
    const doc = (await (await app.request("/oauth/connections/client.json")).json()) as { redirect_uris: string[] };
    expect(doc.redirect_uris).toEqual(["https://broker.example/oauth/connections/callback"]);
  });

  it("a native user_app flow (WHOOP-style): our state, its exchange; the client record it returns is stored; a bad code leaves the status alone", async () => {
    const e = env();
    const id = addConnection(e.ctx, { url: "https://api.prod.whoop.com/x", auth: "oauth", kind: "native_whoop", preset: "whoop", privateTarget: null });
    e.rt.store.setClient(id, { client_id: "cid", client_secret: "csecret-123456" });
    const seen: string[] = [];
    e.rt.registerNativeFlow({
      preset: "whoop",
      authorizeUrl: ({ state, redirectUri, client }) => `https://api.prod.whoop.com/oauth/oauth2/auth?client_id=${String(client?.client_id)}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      exchange: async (code, p) => {
        seen.push(`${code}@${p.redirectUri}`);
        if (code === "bad") throw new SourceError("needs_reauth", "WHOOP refused the token request (invalid_grant)");
        return { tokens: { accessToken: "wa", refreshToken: "wr", expiresAt: Date.now() + 3600_000, scope: "offline", issuer: null }, client: { ...p.client, whoop_user_id: 42 } };
      },
      refreshFn: () => async (cur) => ({ ...cur, accessToken: "wa2" }),
    });
    const bad = await e.rt.startConnect(id, { redirect: "https_localhost" });
    expect(bad.state.length).toBeGreaterThanOrEqual(8);
    await expect(e.rt.finishConnect({ code: "bad", state: bad.state })).rejects.toMatchObject({ code: "needs_reauth" });
    expect(status(e.ctx, id).status).toBe("active");
    const ok = await e.rt.startConnect(id, { redirect: "https_localhost" });
    await e.rt.finishConnectFromUrl(`${HTTPS_LOCALHOST_REDIRECT}?code=good&state=${ok.state}`);
    expect(seen).toEqual([`bad@${HTTPS_LOCALHOST_REDIRECT}`, `good@${HTTPS_LOCALHOST_REDIRECT}`]);
    expect(e.rt.store.tokens(id)).toMatchObject({ accessToken: "wa", refreshToken: "wr" });
    expect(e.rt.store.client(id)).toMatchObject({ client_id: "cid", whoop_user_id: 42 });
  });

  it("an abandoned sign-in against another authorization server changes nothing: refresh still goes to the first", async () => {
    const a = await fake({ auth: { kind: "oauth", accessTokenTtlSec: 3600 } });
    const b = await fake({ auth: { kind: "oauth" } });
    const e = env();
    const id = addConnection(e.ctx, { url: a.url, auth: "oauth" });
    await connectOAuth(e, id, a);
    const before = { client: e.rt.store.client(id), tokens: e.rt.store.tokens(id) };
    // The upstream now points elsewhere (or its metadata names another AS); the admin starts and abandons a sign-in.
    e.ctx.db.run("UPDATE connections SET url = ?, private_target = ? WHERE id = ?", b.url, b.origin, id);
    await e.rt.startConnect(id);
    expect(b.oauth!.registrations.size).toBe(1);
    e.ctx.db.run("UPDATE connections SET url = ?, private_target = ? WHERE id = ?", a.url, a.origin, id);
    expect(e.rt.store.client(id)).toEqual(before.client);
    expect(e.rt.store.tokens(id)).toEqual(before.tokens);
    const n = b.requests.length;
    const conn = e.ctx.db.get("SELECT * FROM connections WHERE id = ?", id) as never;
    await e.rt.refresher.accessToken(id, e.rt.refreshFnFor(conn)!, AbortSignal.timeout(5000), { force: true });
    expect(b.requests.length).toBe(n);
    expect(a.requests.filter((r) => r.path === "/token" && r.body.includes("grant_type=refresh_token")).map((r) => r.status)).toEqual([200]);
    expect(status(e.ctx, id).status).toBe("active");
  });

  it("two concurrent first connects with DCR: whichever finishes last, client and tokens match", async () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const up = await fake({ auth: { kind: "oauth" } });
      const e = env();
      const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
      const starts = [await e.rt.startConnect(id), await e.rt.startConnect(id)];
      expect(up.oauth!.registrations.size).toBe(2);
      expect(e.rt.store.client(id)).toBeNull(); // nothing stored before a consent
      const cbs = [await up.oauth!.followAuthorize(starts[0]!.authUrl), await up.oauth!.followAuthorize(starts[1]!.authUrl)];
      for (const i of order) await e.rt.finishConnectFromUrl(cbs[i]!.toString());
      const last = order[1]!;
      expect(e.rt.store.client(id)!.client_id).toBe(new URL(starts[last]!.authUrl).searchParams.get("client_id"));
      up.oauth!.expireAccessTokens();
      expect(firstText(await e.rt.source(id).callTool("echo", { o: last }, callCtx(id)))).toBe(`{"o":${last}}`);
      expect(status(e.ctx, id).status).toBe("active");
    }
  });

  it("step-up: the reconnect asks for the union of the 401's scope and the granted one", async () => {
    const up = await fake({ auth: { kind: "oauth", scopesSupported: ["notes:read", "notes:write"], challengeScope: "notes:read" } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    const first = await connectOAuth(e, id, up);
    expect(new URL(first.start.authUrl).searchParams.get("scope")).toBe("notes:read");
    expect(e.rt.store.tokens(id)!.scope).toBe("notes:read");
    up.oauth!.settings.challengeScope = "notes:write";
    const again = await e.rt.startConnect(id);
    expect(new URL(again.authUrl).searchParams.get("scope")?.split(" ").sort()).toEqual(["notes:read", "notes:write"]);
  });

  it("iss is checked before an error response is acted on; an unknown state echoes nothing", async () => {
    const up = await fake({ auth: { kind: "oauth", issMode: "wrong", deny: true } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    const start = await e.rt.startConnect(id);
    const cb = await up.oauth!.followAuthorize(start.authUrl);
    expect(cb.searchParams.get("error")).toBe("access_denied");
    await expect(e.rt.finishConnectFromUrl(cb.toString())).rejects.toMatchObject({ code: "oauth_issuer" });
    const err = await e.rt.finishConnect({ state: "nope", error: "server_error", errorDescription: "<script>evil</script>" }).catch((x: unknown) => x);
    expect(err).toMatchObject({ code: "oauth_error" });
    expect(JSON.stringify({ m: (err as Error).message, h: (err as { hint?: string }).hint })).not.toContain("evil");
  });

  it("token requests never follow redirects (a 307 would re-send the code and verifier)", async () => {
    let elsewhere = 0;
    const s = createServer((req, res) => {
      if (req.url === "/token") return res.writeHead(307, { location: "/steal" }).end();
      elsewhere++;
      res.end("{}");
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise((r) => s.close(() => r(undefined))));
    const origin = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const f = guardedFetch({ allow: { origin } });
    cleanup.push(() => f.close());
    const client = { issuer: origin, client_id: "c", token_endpoint_auth_method: "none", source: "dcr" as const, token_endpoint: `${origin}/token` };
    await expect(exchangeCode(f, client, { code: "x", verifier: "v".repeat(43), redirectUri: "http://localhost/cb", resource: `${origin}/mcp` })).rejects.toMatchObject({ code: "protocol" });
    expect(elsewhere).toBe(0);
  });

  it("the allow only covers the connection's own origin, whatever is stored", async () => {
    expect(allowFromColumn("http://127.0.0.1:1111", "http://127.0.0.1:2222/mcp")).toBeNull();
    expect(allowFromColumn("http://127.0.0.1:1111", "http://127.0.0.1:1111/mcp")).toEqual({ origin: "http://127.0.0.1:1111" });
    const up = await fake({ protocol: "stateless-2026" });
    const e = env();
    expect(await e.rt.probe(up.url, { privateTarget: "http://127.0.0.1:1" })).toMatchObject({ auth: "blocked", privateTarget: null });
    const id = addConnection(e.ctx, { url: up.url, auth: "none", privateTarget: "http://127.0.0.1:1" });
    await expect(e.rt.source(id).listTools(AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "blocked_target" });
  });

  it("Google's /oauth/callback never consumes a connection's state", async () => {
    const up = await fake({ auth: { kind: "oauth" } });
    const e = env();
    const id = addConnection(e.ctx, { url: up.url, auth: "oauth" });
    const start = await e.rt.startConnect(id);
    const cb = await up.oauth!.followAuthorize(start.authUrl);
    await createApp(e.ctx).request(`/oauth/callback?code=${cb.searchParams.get("code")}&state=${start.state}`);
    await createApp(e.ctx).request(`/oauth/callback?error=access_denied&state=${start.state}`);
    await expect(e.rt.finishConnectFromUrl(cb.toString())).resolves.toMatchObject({ connectionId: id });
  });

  it("the fake's up.fetch maps only its own origin (port boundary)", async () => {
    const up = await fake({ advertisedOrigin: "http://forge.test:3773" });
    // Not mapped to the fake (forge.test doesn't resolve), where a prefix match would have mapped it.
    await expect(up.fetch("http://forge.test:37731/mcp")).rejects.toBeInstanceOf(Error);
  });
});
