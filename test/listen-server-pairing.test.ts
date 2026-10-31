import { afterEach, describe, expect, it } from "vitest";
import type { PairingStart } from "../shared/agent-api.ts";
import type { ConsoleStreamMessage, PairingRequest } from "../shared/types.ts";
import { type AgentApiOptions, agentApi, sweepPairings } from "../server/agentapi/index.ts";
import { sha256 } from "../server/crypto.ts";
import { addAccount } from "./listen-server-helpers.ts";
import { CSRF, grantInput, type Harness, harness, json } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const MIN = 60_000;

async function setup(opts: AgentApiOptions = {}) {
  h = harness();
  let t = Date.parse("2026-10-15T12:00:00.000Z");
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  agentApi(h.ctx, { clock: clock.now, ...opts });
  h.ctx.config.trustProxy = true;
  addAccount(h.ctx, "acc_a", "me@acme.com");
  const cookie = await h.claim();
  const r = h.request;
  const ipHeaders = (ip: string) => ({ "x-forwarded-for": ip });
  return {
    h,
    clock,
    cookie,
    start: (ip = "10.0.0.1", body: unknown = { name: "Hermes on laptop", client: { hostname: "laptop", tool: "hermes" } }) =>
      r("/agent/v1/pairings", { method: "POST", headers: ipHeaders(ip), json: body }),
    poll: (deviceCode: string, ip = "10.0.0.1") => r("/agent/v1/pairings/poll", { method: "POST", headers: ipHeaders(ip), json: { deviceCode } }),
    /** Sends the request's real user code unless the body has one. */
    approve: (id: string, body: Record<string, unknown> = { grants: [grantInput("acc_a")] }) => {
      const userCode = h!.ctx.db.get<{ user_code: string }>("SELECT user_code FROM pairings WHERE id = ?", id)?.user_code ?? "XXXX-XXXX";
      return r(`/api/pairings/${id}/approve`, { method: "POST", cookie, headers: CSRF, json: { userCode, ...body } });
    },
    deny: (id: string, note?: string) => r(`/api/pairings/${id}/deny`, { method: "POST", cookie, headers: CSRF, json: { note } }),
    list: async (status?: string): Promise<PairingRequest[]> => json(await r(`/api/pairings${status ? `?status=${status}` : ""}`, { cookie })),
    actions: (action: string) => h!.ctx.audit.list({ action }).items,
  };
}

async function started(s: Awaited<ReturnType<typeof setup>>, ip?: string): Promise<PairingStart & { id: string }> {
  const res = await s.start(ip);
  expect(res.status).toBe(200);
  const body = (await res.json()) as PairingStart;
  const pending = await s.list("pending");
  return { ...body, id: pending.find((p) => p.userCode === body.userCode)!.id };
}

describe("pairing start and console listing", () => {
  it("creates a pending request with a hashed device code and a short user code", async () => {
    const s = await setup();
    const pairings: PairingRequest[] = [];
    s.h.ctx.bus.on("pairing", (p) => pairings.push(p));
    const res = await s.start();
    expect(res.status).toBe(200);
    const body = (await res.json()) as PairingStart;
    expect(body.deviceCode).toMatch(/^[0-9a-z]{48}$/);
    expect(body.userCode).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(body.verificationUrl).toBe(`${s.h.ctx.settings.publicUrl()}/approvals?pairing=${body.userCode}`);
    expect(body.interval).toBe(3);
    expect(body.expiresAt).toBe(new Date(s.clock.now() + 10 * MIN).toISOString());

    const rows = s.h.ctx.db.all<Record<string, unknown>>("SELECT * FROM pairings");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.device_code_hash).toBe(sha256(body.deviceCode));
    expect(JSON.stringify(rows)).not.toContain(body.deviceCode);

    const [listed] = await s.list("pending");
    expect(listed).toMatchObject({ userCode: body.userCode, name: "Hermes on laptop", status: "pending", ip: "10.0.0.1", client: { hostname: "laptop", tool: "hermes" } });
    expect(JSON.stringify(listed)).not.toContain(body.deviceCode);
    expect(pairings.map((p) => p.status)).toEqual(["pending"]);
    expect(s.actions("pairing.requested")[0]).toMatchObject({ target: listed!.id, outcome: "ok", detail: { userCode: body.userCode, ip: "10.0.0.1" } });
    expect((await s.h.request("/api/pairings?status=nope", { cookie: s.cookie })).status).toBe(400);
  });

  it("needs no CSRF header or session, validates input and never falls back to the console", async () => {
    const s = await setup();
    expect((await s.start("10.0.0.1", { name: "" })).status).toBe(400);
    expect((await s.start("10.0.0.1", { name: "x", requested: { accounts: [""] } })).status).toBe(400);
    const missing = await s.h.request("/agent/v1/nope");
    expect(missing.status).toBe(404);
    expect((await json(missing)).error.code).toBe("not_found");
    // The admin routes still need the session.
    expect((await s.h.request("/api/pairings")).status).toBe(401);
  });

  it("forwards pairing changes on the console event stream", async () => {
    const s = await setup();
    const res = await s.h.request("/api/events/stream", { cookie: s.cookie });
    const reader = res.body!.getReader();
    await s.start();
    let text = "";
    while (!text.includes('"kind":"pairing"')) text += new TextDecoder().decode((await reader.read()).value);
    const line = text.split("\n").find((l) => l.includes('"kind":"pairing"'))!;
    const msg = JSON.parse(line.slice("data: ".length)) as ConsoleStreamMessage;
    expect(msg).toMatchObject({ kind: "pairing", data: { status: "pending", name: "Hermes on laptop" } });
    await reader.cancel();
  });
});

describe("pairing poll", () => {
  it("approves, delivers the key exactly once, then reports consumed", async () => {
    const s = await setup();
    const p = await started(s);
    expect(await json(await s.poll(p.deviceCode))).toEqual({ status: "pending" });
    // RFC 8628: each slow_down adds 5 s, and the longer interval is enforced from then on.
    expect(await json(await s.poll(p.deviceCode))).toEqual({ status: "slow_down", interval: 8 });
    s.clock.advance(3000);
    expect(await json(await s.poll(p.deviceCode))).toEqual({ status: "slow_down", interval: 13 });
    s.clock.advance(13_000);
    expect(await json(await s.poll(p.deviceCode))).toEqual({ status: "pending" });
    s.clock.advance(13_000);

    const approved = await s.approve(p.id, { name: "Hermes", grants: [grantInput("acc_a")] });
    expect(approved.status).toBe(200);
    const agentText = await approved.text();
    const agent = JSON.parse(agentText);
    expect(agent).toMatchObject({ name: "Hermes", origin: "paired", grants: [{ accountId: "acc_a" }], listeners: [] });
    expect(agentText).not.toMatch(/aib_[0-9a-z]{32}/);
    const row = s.h.ctx.db.get<{ api_key_enc: string | null; status: string }>("SELECT api_key_enc, status FROM pairings WHERE id = ?", p.id)!;
    expect(row.status).toBe("approved");
    expect(row.api_key_enc).toMatch(/^v1:/);
    expect(row.api_key_enc).not.toMatch(/aib_/);
    expect((await s.approve(p.id)).status).toBe(409);

    s.clock.advance(13_000);
    const delivered = await json(await s.poll(p.deviceCode));
    expect(delivered).toMatchObject({ status: "approved", agent: { id: agent.id, name: "Hermes" } });
    expect(delivered.apiKey).toMatch(/^aib_/);
    expect(delivered.mcpUrl).toBe(`${s.h.ctx.settings.publicUrl()}/mcp`);
    expect(delivered.skillUrl).toBe(`${s.h.ctx.settings.publicUrl()}/skill.md`);
    expect(s.h.ctx.policy.authenticate(delivered.apiKey)?.agentId).toBe(agent.id);
    expect(agentText).not.toContain(delivered.apiKey);
    const after = s.h.ctx.db.get<{ api_key_enc: string | null; delivered_at: string | null }>("SELECT api_key_enc, delivered_at FROM pairings WHERE id = ?", p.id)!;
    expect(after.api_key_enc).toBeNull();
    expect(after.delivered_at).not.toBeNull();

    s.clock.advance(13_000);
    expect(await json(await s.poll(p.deviceCode))).toEqual({ status: "consumed" });
    expect(s.actions("pairing.approved")[0]).toMatchObject({ actorType: "admin", target: p.id, detail: { agentId: agent.id } });
    expect(s.actions("pairing.key_delivered")[0]).toMatchObject({ actorType: "agent", actorId: agent.id, target: p.id });
    expect(JSON.stringify(s.h.ctx.audit.list({ limit: 200 }).items)).not.toContain(delivered.apiKey);
    // A later sweep must not treat a delivered pairing as an orphan.
    s.clock.advance(20 * MIN);
    sweepPairings(s.h.ctx);
    expect(s.h.ctx.policy.getAgent(agent.id)).not.toBeNull();
  });

  it("validates approval grants", async () => {
    const s = await setup();
    const p = await started(s);
    // No mailbox grant is fine (installs with only connections), but an unknown connection isn't.
    expect((await s.approve(p.id, { grants: [], connections: [{ connectionId: "con_nope", level: "read" }] })).status).toBe(400);
    expect((await s.approve(p.id, { grants: [{ ...grantInput("acc_a"), level: "ask" as never }] })).status).toBe(400);
    expect((await s.approve(p.id, { grants: [grantInput("acc_missing")] })).status).toBe(404);
    expect((await s.approve(p.id, { grants: [grantInput("acc_a"), grantInput("acc_a")] })).status).toBe(400);
    expect(s.h.ctx.policy.listAgents()).toHaveLength(0);
    expect((await s.list("pending")).map((x) => x.id)).toEqual([p.id]);
    expect((await s.approve("par_nope")).status).toBe(404);
  });

  it("reports a denial with its note", async () => {
    const s = await setup();
    const p = await started(s);
    const res = await s.deny(p.id, "Not this laptop");
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: p.id, status: "denied", decisionNote: "Not this laptop" });
    expect(await json(await s.poll(p.deviceCode))).toEqual({ status: "denied", note: "Not this laptop" });
    expect((await s.approve(p.id)).status).toBe(409);
    expect(s.actions("pairing.denied")[0]).toMatchObject({ target: p.id, outcome: "ok" });
    expect(s.h.ctx.policy.listAgents()).toHaveLength(0);
  });

  it("expires pending codes after the TTL", async () => {
    const s = await setup();
    const p = await started(s);
    s.clock.advance(10 * MIN + 1);
    expect(await json(await s.poll(p.deviceCode))).toEqual({ status: "expired" });
    expect((await s.approve(p.id)).status).toBe(409);
    expect((await s.list())[0]!.status).toBe("expired");
    expect(s.actions("pairing.expired")).toHaveLength(1);
  });

  it("deletes the agent and wipes the key when an approved key is never collected", async () => {
    const s = await setup({ collectGraceMs: 2 * MIN });
    const p = await started(s);
    s.clock.advance(9 * MIN);
    const agent = await json(await s.approve(p.id));
    // Approved late: the CLI still gets the grace period.
    s.clock.advance(1.5 * MIN);
    expect(sweepPairings(s.h.ctx)).toBe(0);
    s.clock.advance(MIN);
    const revoked: string[] = [];
    s.h.ctx.bus.on("agent", (e) => revoked.push(`${e.agentId}:${e.reason}`));
    expect(sweepPairings(s.h.ctx)).toBe(1);
    expect(s.h.ctx.policy.getAgent(agent.id)).toBeNull();
    expect(revoked).toEqual([`${agent.id}:deleted`]);
    const row = s.h.ctx.db.get<{ api_key_enc: string | null; status: string }>("SELECT api_key_enc, status FROM pairings WHERE id = ?", p.id)!;
    expect(row).toEqual({ api_key_enc: null, status: "expired" });
    expect(await json(await s.poll(p.deviceCode))).toEqual({ status: "expired" });
    expect(s.actions("pairing.expired")[0]).toMatchObject({ detail: { keyCollected: false, agentDeleted: agent.id } });
  });

  it("returns expired when the agent was deleted before the key was collected", async () => {
    const s = await setup();
    const p = await started(s);
    const agent = await json(await s.approve(p.id));
    s.h.ctx.policy.deleteAgent(agent.id);
    // Wiped right away (bus "agent"), not only at the next poll.
    expect(s.h.ctx.db.get<{ api_key_enc: string | null }>("SELECT api_key_enc FROM pairings WHERE id = ?", p.id)!.api_key_enc).toBeNull();
    expect(await json(await s.poll(p.deviceCode))).toEqual({ status: "expired" });
    expect(s.actions("pairing.expired")[0]).toMatchObject({ target: p.id, detail: { reason: "agent_deleted" } });
  });

  for (const [what, takeOver, reason] of [
    ["rotates its key", (s: Awaited<ReturnType<typeof setup>>, id: string) => s.h.ctx.policy.rotateKey(id), "key_rotated"],
    ["edits it", (s: Awaited<ReturnType<typeof setup>>, id: string) => s.h.ctx.policy.updateAgent(id, { name: "Set up by hand" }), "agent_updated"],
  ] as const) {
    it(`keeps the agent when the admin ${what} before the key is collected`, async () => {
      const s = await setup();
      const p = await started(s);
      const agent = await json(await s.approve(p.id));
      takeOver(s, agent.id);
      const row = s.h.ctx.db.get<{ api_key_enc: string | null; status: string }>("SELECT api_key_enc, status FROM pairings WHERE id = ?", p.id)!;
      expect(row).toEqual({ api_key_enc: null, status: "approved" });
      expect(await json(await s.poll(p.deviceCode))).toEqual({ status: "consumed" });
      s.clock.advance(20 * MIN);
      sweepPairings(s.h.ctx);
      expect(s.h.ctx.policy.getAgent(agent.id)).not.toBeNull();
      expect(s.actions("pairing.key_withdrawn")[0]).toMatchObject({ target: p.id, detail: { reason, agentId: agent.id } });
    });
  }

  it("never deletes an agent whose key no longer matches the uncollected one", async () => {
    const s = await setup();
    const p = await started(s);
    const agent = await json(await s.approve(p.id));
    // A key change that bypassed the bus: the sweep compares hashes before deleting.
    s.h.ctx.db.run("UPDATE agents SET key_hash = 'other' WHERE id = ?", agent.id);
    s.clock.advance(20 * MIN);
    expect(sweepPairings(s.h.ctx)).toBe(1);
    expect(s.h.ctx.policy.getAgent(agent.id)).not.toBeNull();
    expect(s.h.ctx.db.get<{ api_key_enc: string | null }>("SELECT api_key_enc FROM pairings WHERE id = ?", p.id)!.api_key_enc).toBeNull();
    expect(s.actions("pairing.expired")[0]).toMatchObject({ detail: { agentDeleted: null } });
  });
});

describe("approval checks", () => {
  it("requires the user code from the terminal, ignoring case and dashes", async () => {
    const s = await setup();
    const p = await started(s);
    expect((await s.approve(p.id, { userCode: "", grants: [grantInput("acc_a")] })).status).toBe(400);
    const wrong = await s.approve(p.id, { userCode: "AAAA-AAAA", grants: [grantInput("acc_a")] });
    expect(wrong.status).toBe(409);
    expect((await json(wrong)).error).toMatchObject({ code: "user_code_mismatch", message: expect.stringMatching(/doesn't match/) });
    expect(s.actions("pairing.approved")[0]).toMatchObject({ outcome: "denied", reason: "user_code_mismatch", target: p.id });
    expect(s.h.ctx.policy.listAgents()).toHaveLength(0);
    const ok = await s.approve(p.id, { userCode: ` ${p.userCode.replace("-", "").toLowerCase()} `, grants: [grantInput("acc_a")] });
    expect(ok.status).toBe(200);
  });

  it("strips control and format characters from requester text and normalizes the tool", async () => {
    const s = await setup();
    const res = await s.start("10.0.0.1", {
      name: "Claude Code on wynn-mbp\u202e\u200b\n[verified]",
      description: "\u001b[31mred\u0007",
      requested: { reason: "needs\u2028mail\u{E0041}" },
      client: { hostname: "wynn-mbp\u0007\u001b[31m", tool: "anything-not-in-AgentTool" },
    });
    expect(res.status).toBe(200);
    const [p] = await s.list();
    expect(p).toMatchObject({
      name: "Claude Code on wynn-mbp[verified]",
      description: "[31mred",
      requested: { reason: "needsmail" },
      client: { hostname: "wynn-mbp[31m", tool: "other" },
    });
    expect((await s.start("10.0.0.2", { name: "\u200b\u0007" })).status).toBe(400);
    // `requested` is informational: approval takes only the grants the human chose.
    const agent = await json(await s.approve(p!.id));
    expect(agent.grants.map((g: { level: string }) => g.level)).toEqual(["read"]);
  });
});

describe("browser and DNS-rebinding guard", () => {
  it("refuses browser requests, non-JSON bodies and foreign Host names before doing anything", async () => {
    const s = await setup({ maxPendingPerSource: 10 });
    const body = JSON.stringify({ name: "Claude Code on wynn-mbp" });
    const post = (headers: Record<string, string>, url = "/agent/v1/pairings") => s.h.app.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    const cases: [Record<string, string>, number, string][] = [
      [{ origin: "http://evil.example" }, 403, "browser_request"],
      [{ "sec-fetch-site": "same-origin" }, 403, "browser_request"],
      [{ "content-type": "text/plain;charset=UTF-8" }, 415, "unsupported_media_type"],
      [{ host: "evil.example:8425" }, 421, "unknown_host"],
    ];
    for (let round = 0; round < 4; round++) {
      for (const [headers, status, code] of cases) {
        const res = await post(headers);
        expect(res.status).toBe(status);
        expect((await json(res)).error.code).toBe(code);
      }
    }
    expect((await post({ origin: "http://evil.example" }, "/agent/v1/pairings/poll")).status).toBe(403);
    expect((await s.h.app.request("/agent/v1/me", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect(s.h.ctx.db.all("SELECT * FROM pairings")).toHaveLength(0);
    // None of that spent the address's start budget.
    for (const host of ["localhost:8425", "127.0.0.1", "[::1]:8425", new URL(s.h.ctx.settings.publicUrl()).host]) {
      expect((await post({ host }, "/agent/v1/pairings")).status).toBe(200);
    }
  });

  it("accepts the public URL host and local interface addresses", async () => {
    const { networkInterfaces } = await import("node:os");
    const { hostAllowed } = await import("../server/agentapi/guard.ts");
    const s = await setup();
    s.h.ctx.settings.update({ publicUrl: "https://mail.example.com" });
    expect(await hostAllowed(s.h.ctx, "mail.example.com")).toBe(true);
    expect(await hostAllowed(s.h.ctx, "evil.example")).toBe(false);
    expect(await hostAllowed(s.h.ctx, "203.0.113.9")).toBe(false);
    const lan = Object.values(networkInterfaces()).flat().find((a) => a && !a.internal);
    if (lan) expect(await hostAllowed(s.h.ctx, lan.address.toLowerCase())).toBe(true);
  });

  it("accepts only the Tailscale name that tailscale status reports", async () => {
    const { hostAllowed } = await import("../server/agentapi/guard.ts");
    const s = await setup();
    const deps = (name: string | null) => ({ tailscaleName: async () => name });
    expect(await hostAllowed(s.h.ctx, "me.tail1234.ts.net", deps("me.tail1234.ts.net"))).toBe(true);
    expect(await hostAllowed(s.h.ctx, "other.tail1234.ts.net", deps("me.tail1234.ts.net"))).toBe(false);
    expect(await hostAllowed(s.h.ctx, "me.tail1234.ts.net", deps(null))).toBe(false);
    expect(await hostAllowed(s.h.ctx, "evil.example", deps("me.tail1234.ts.net"))).toBe(false);
  });
});

describe("pairing limits", () => {
  it("rate limits starts per client IP", async () => {
    const s = await setup({ startsPerHour: 3, maxPending: 100 });
    for (let i = 0; i < 3; i++) expect((await s.start("10.0.0.1")).status).toBe(200);
    const limited = await s.start("10.0.0.1");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await json(limited)).error.code).toBe("rate_limited");
    expect((await s.start("10.0.0.1")).status).toBe(429);
    expect((await s.start("10.0.0.2")).status).toBe(200);
    // One audit entry per flood, not per request.
    expect(s.actions("pairing.requested").filter((e) => e.outcome === "denied")).toMatchObject([{ reason: "rate_limit", detail: { ip: "10.0.0.1" } }]);
    s.clock.advance(61 * MIN);
    expect((await s.start("10.0.0.1")).status).toBe(200);
  });

  it("caps concurrently pending requests", async () => {
    const s = await setup({ maxPending: 2 });
    expect((await s.start("10.0.0.1")).status).toBe(200);
    expect((await s.start("10.0.0.2")).status).toBe(200);
    const full = await s.start("10.0.0.3");
    expect(full.status).toBe(429);
    expect((await json(full)).error.code).toBe("too_many_pending");
    expect(s.actions("pairing.requested").find((e) => e.outcome === "denied")).toMatchObject({ reason: "pending_cap" });
    const [first] = await s.list("pending");
    await s.deny(first!.id);
    expect((await s.start("10.0.0.3")).status).toBe(200);
    s.clock.advance(11 * MIN);
    expect((await s.start("10.0.0.4")).status).toBe(200);
  });

  it("caps pending requests per source, grouping IPv6 by /64, and audits the refusals once", async () => {
    const s = await setup({ startsPerHour: 100 });
    for (let i = 1; i <= 3; i++) expect((await s.start(`2001:db8:1:2::${i}`)).status).toBe(200);
    for (let i = 4; i <= 9; i++) {
      const res = await s.start(`2001:db8:1:2:abcd::${i}`);
      expect(res.status).toBe(429);
      expect((await json(res)).error.code).toBe("too_many_pending");
    }
    expect((await s.start("2001:db8:1:3::1")).status).toBe(200);
    expect(s.actions("pairing.requested").filter((e) => e.outcome === "denied")).toMatchObject([{ reason: "pending_cap_source" }]);
  });

  it("limits pairing starts globally", async () => {
    const s = await setup({ globalStartsPerHour: 2 });
    expect((await s.start("10.0.0.1")).status).toBe(200);
    expect((await s.start("10.0.0.2")).status).toBe(200);
    const res = await s.start("10.0.0.3");
    expect(res.status).toBe(429);
    expect((await s.start("10.0.0.4")).status).toBe(429);
    expect(s.actions("pairing.requested").filter((e) => e.outcome === "denied")).toMatchObject([{ reason: "global_rate_limit" }]);
  });

  it("exempts this machine from the global caps but not from the per-source ones", async () => {
    const s = await setup({ maxPending: 2, globalStartsPerHour: 2, maxPendingPerSource: 3 });
    expect((await s.start("203.0.113.1")).status).toBe(200);
    expect((await s.start("203.0.113.2")).status).toBe(200);
    expect((await s.start("203.0.113.3")).status).toBe(429); // global pending cap
    for (let i = 0; i < 3; i++) expect((await s.start("127.0.0.1")).status).toBe(200);
    const own = await s.start("127.0.0.1");
    expect(own.status).toBe(429);
    expect((await json(own)).error.message).toMatch(/This address/);
  });

  it("refuses pairing when it is turned off", async () => {
    const s = await setup();
    s.h.ctx.settings.update({ pairingEnabled: false });
    const res = await s.start();
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error.code).toBe("pairing_disabled");
    expect(body.error.hint).toMatch(/Settings/);
    expect(s.actions("pairing.requested")[0]).toMatchObject({ outcome: "denied", reason: "pairing_disabled" });
    expect(s.h.ctx.db.all("SELECT * FROM pairings")).toHaveLength(0);
  });

  it("locks out an address that polls with many unknown device codes", async () => {
    const s = await setup();
    const p = await started(s, "10.0.0.9");
    for (let i = 0; i < 5; i++) expect(await json(await s.poll(`guess${i}`, "10.0.0.1"))).toEqual({ status: "expired" });
    const locked = await s.poll("guess-more", "10.0.0.1");
    expect(locked.status).toBe(429);
    expect((await json(locked)).error.code).toBe("locked_out");
    // A real device code is never refused, even from the locked-out address.
    expect(await json(await s.poll(p.deviceCode, "10.0.0.1"))).toEqual({ status: "pending" });
    expect(s.actions("pairing.poll")[0]).toMatchObject({ outcome: "denied", reason: "lockout" });
  });
});
