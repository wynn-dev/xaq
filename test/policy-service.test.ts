import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../server/crypto.ts";
import { parseGrantInput } from "../server/policy/grants.ts";
import { matchesGlob } from "../server/util/glob.ts";
import { disallowedRecipients, threadLabels } from "../server/policy/enforce.ts";
import { grantInput, mailTestContext } from "./helpers.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

function setup() {
  const t = mailTestContext();
  dispose = t.dispose;
  t.addAccount("acc_a", "me@acme.com");
  t.addAccount("acc_b", "other@acme.com");
  return t;
}

describe("agents and keys", () => {
  it("creates agents with a hashed aib_ key shown once", () => {
    const { ctx } = setup();
    const { agent, apiKey } = ctx.policy.createAgent({ name: "  Support bot ", description: "triage", grants: [grantInput("acc_a")] });
    expect(apiKey).toMatch(/^aib_[0-9a-z]{32}$/);
    expect(agent.keyPrefix).toBe(apiKey.slice(0, 8));
    expect(agent.name).toBe("Support bot");
    expect(agent.grants).toHaveLength(1);
    const row = ctx.db.get<{ key_hash: string }>("SELECT key_hash FROM agents WHERE id = ?", agent.id)!;
    expect(row.key_hash).toBe(sha256(apiKey));
    expect(JSON.stringify(ctx.policy.getAgent(agent.id))).not.toContain(apiKey);
    expect(ctx.audit.list({ action: "agent.create" }).items[0]!.target).toBe(agent.id);
  });

  it("authenticates keys, rejects unknown/disabled ones and throttles last_used_at writes", () => {
    const { ctx } = setup();
    const { agent, apiKey } = ctx.policy.createAgent({ name: "a" });
    expect(ctx.policy.authenticate(apiKey)).toEqual({ agentId: agent.id, name: "a" });
    const first = ctx.policy.getAgent(agent.id)!.lastUsedAt;
    expect(first).not.toBeNull();
    ctx.policy.authenticate(apiKey);
    expect(ctx.policy.getAgent(agent.id)!.lastUsedAt).toBe(first);
    ctx.db.run("UPDATE agents SET last_used_at = ? WHERE id = ?", new Date(Date.now() - 120_000).toISOString(), agent.id);
    ctx.policy.authenticate(apiKey);
    expect(Date.parse(ctx.policy.getAgent(agent.id)!.lastUsedAt!)).toBeGreaterThan(Date.now() - 5_000);

    expect(ctx.policy.authenticate("aib_" + "0".repeat(32))).toBeNull();
    expect(ctx.policy.authenticate("not-a-key")).toBeNull();
    ctx.policy.updateAgent(agent.id, { disabled: true });
    expect(ctx.policy.authenticate(apiKey)).toBeNull();
  });

  it("records MCP use apart from other key use: first write immediate, then at most once a minute", () => {
    const { ctx } = setup();
    const { agent, apiKey } = ctx.policy.createAgent({ name: "a" });
    expect(ctx.policy.getAgent(agent.id)).toMatchObject({ lastUsedAt: null, lastMcpAt: null });
    // Any key use (e.g. `listen`) sets lastUsedAt only.
    ctx.policy.authenticate(apiKey);
    expect(ctx.policy.getAgent(agent.id)!.lastMcpAt).toBeNull();

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      ctx.policy.markMcpUse(agent.id);
      const first = ctx.policy.getAgent(agent.id)!.lastMcpAt;
      expect(Date.parse(first!)).toBe(Date.now());
      // Within the minute the UPDATE isn't even attempted (a write here would be visible).
      ctx.db.run("UPDATE agents SET last_mcp_at = NULL WHERE id = ?", agent.id);
      vi.setSystemTime(Date.now() + 59_000);
      ctx.policy.markMcpUse(agent.id);
      expect(ctx.policy.getAgent(agent.id)!.lastMcpAt).toBeNull();
      vi.setSystemTime(Date.now() + 2_000);
      ctx.policy.markMcpUse(agent.id);
      expect(ctx.policy.getAgent(agent.id)!.lastMcpAt).toBe(new Date().toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes the agent on bus agentState: coalesced, rate-limited with a trailing push, not after deletion", async () => {
    const { ctx } = setup();
    const states: { id: string; lastUsedAt: string | null; lastMcpAt: string | null; at: number }[] = [];
    ctx.bus.on("agentState", (a) => states.push({ id: a.id, lastUsedAt: a.lastUsedAt, lastMcpAt: a.lastMcpAt, at: Date.now() }));
    const { agent, apiKey } = ctx.policy.createAgent({ name: "a" });
    const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

    // First use: lastUsedAt and lastMcpAt are written together and go out as one push carrying both.
    ctx.policy.authenticate(apiKey);
    ctx.policy.markMcpUse(agent.id);
    expect(states).toHaveLength(0); // deferred to the next macrotask
    await tick();
    expect(states).toEqual([{ id: agent.id, lastUsedAt: expect.any(String), lastMcpAt: expect.any(String), at: expect.any(Number) }]);
    // Throttled writes don't push.
    ctx.policy.authenticate(apiKey);
    ctx.policy.markMcpUse(agent.id);
    await tick(10);
    expect(states).toHaveLength(1);

    // With a minimum interval, a burst folds into one trailing push no sooner than the interval.
    for (let i = 0; i < 5; i++) ctx.policy.publishAgent(agent.id, 200);
    await tick(400);
    expect(states).toHaveLength(2);
    expect(states[1]!.at - states[0]!.at).toBeGreaterThanOrEqual(190);

    // Access changes push too; a deleted agent never does.
    ctx.policy.updateAgent(agent.id, { name: "b" });
    await tick(10);
    expect(states).toHaveLength(3);
    ctx.policy.updateAgent(agent.id, { name: "c" });
    ctx.policy.deleteAgent(agent.id);
    ctx.policy.publishAgent(agent.id);
    await tick(10);
    expect(states).toHaveLength(3);
  });

  it("records how an agent was added; console input can't claim it was paired", () => {
    const { ctx } = setup();
    expect(ctx.policy.createAgent({ name: "a" }).agent.origin).toBe("key");
    expect(ctx.policy.createAgent({ name: "b", origin: "paired" } as never).agent.origin).toBe("key");
    const paired = ctx.policy.createAgent({ name: "c" }, { origin: "paired" }).agent;
    expect(ctx.policy.getAgent(paired.id)!.origin).toBe("paired");
  });

  it("rotates keys so the old one stops working", () => {
    const { ctx } = setup();
    const { agent, apiKey } = ctx.policy.createAgent({ name: "a" });
    const rotated = ctx.policy.rotateKey(agent.id);
    expect(rotated.apiKey).not.toBe(apiKey);
    expect(ctx.policy.authenticate(apiKey)).toBeNull();
    expect(ctx.policy.authenticate(rotated.apiKey)?.agentId).toBe(agent.id);
    expect(rotated.agent.keyPrefix).toBe(rotated.apiKey.slice(0, 8));
  });

  it("updates and deletes agents, auditing each change", () => {
    const { ctx } = setup();
    const { agent } = ctx.policy.createAgent({ name: "a", grants: [grantInput("acc_a")] });
    expect(ctx.policy.updateAgent(agent.id, { name: "b", description: null }).name).toBe("b");
    expect(() => ctx.policy.updateAgent(agent.id, { name: " " })).toThrow(/Name/);
    ctx.policy.deleteAgent(agent.id);
    expect(ctx.policy.getAgent(agent.id)).toBeNull();
    expect(ctx.policy.grants(agent.id)).toEqual([]);
    expect(() => ctx.policy.deleteAgent(agent.id)).toThrow(/not found/);
    const actions = ctx.audit.list().items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["agent.create", "agent.update", "agent.delete"]));
  });
});

describe("grants", () => {
  it("upserts one grant per agent × account and audits", () => {
    const { ctx } = setup();
    const { agent } = ctx.policy.createAgent({ name: "a" });
    const g1 = ctx.policy.upsertGrant(agent.id, "acc_a", grantInput("acc_a", { level: "full" }));
    expect(g1.level).toBe("full");
    const g2 = ctx.policy.upsertGrant(agent.id, "acc_a", grantInput("acc_a", { level: "full", allowTo: [" *@Acme.com "] }));
    expect(g2.id).toBe(g1.id);
    expect(g2.allowTo).toEqual(["*@acme.com"]);
    expect(ctx.policy.grants(agent.id)).toHaveLength(1);
    expect(ctx.policy.grant(agent.id, "acc_a")?.level).toBe("full");
    ctx.policy.deleteGrant(agent.id, "acc_a");
    expect(ctx.policy.grant(agent.id, "acc_a")).toBeNull();
    expect(() => ctx.policy.deleteGrant(agent.id, "acc_a")).toThrow(/not found/);
    const audited = ctx.audit.list().items.filter((e) => e.action.startsWith("grant."));
    expect(audited.map((e) => e.action)).toEqual(["grant.delete", "grant.upsert", "grant.upsert"]);
    expect(audited[0]!.accountId).toBe("acc_a");
  });

  it.each([
    ["an unknown level", { level: "ask" }],
    ["no level", { level: undefined }],
    ["malformed glob", { allowTo: ["not an address"] }],
    ["glob without domain", { allowTo: ["alice@"] }],
  ])("rejects %s", (_name, patch) => {
    const { ctx } = setup();
    const { agent } = ctx.policy.createAgent({ name: "a" });
    expect(() => ctx.policy.upsertGrant(agent.id, "acc_a", { ...grantInput("acc_a"), ...(patch as object) })).toThrow(/Invalid grant/);
  });

  it("rejects unknown accounts, duplicate accounts and mismatched ids", () => {
    const { ctx } = setup();
    const { agent } = ctx.policy.createAgent({ name: "a" });
    expect(() => ctx.policy.upsertGrant(agent.id, "acc_nope", grantInput("acc_nope"))).toThrow(/Account acc_nope not found/);
    expect(() => ctx.policy.upsertGrant(agent.id, "acc_a", grantInput("acc_b"))).toThrow(/does not match/);
    expect(() => ctx.policy.createAgent({ name: "b", grants: [grantInput("acc_a"), grantInput("acc_a")] })).toThrow(/one grant per account/);
    expect(ctx.policy.listAgents()).toHaveLength(1);
  });

  it("accepts well-formed globs", () => {
    const { ctx } = setup();
    const { agent } = ctx.policy.createAgent({ name: "a" });
    const g = ctx.policy.upsertGrant(agent.id, "acc_a", grantInput("acc_a", { allowTo: ["alice@example.com", "*@example.com", "billing@*", "*@*.corp.example"] }));
    expect(g.allowTo).toHaveLength(4);
    expect(disallowedRecipients(g, ["bob@example.com", "billing@vendor.io", "x@eu.corp.example", "eve@evil.com"])).toEqual(["eve@evil.com"]);
  });
});

describe("grant defaults, ordering and glob folding", () => {
  it("defaults the allowlist to anyone", () => {
    expect(parseGrantInput({ accountId: "acc_a", level: "read" })).toEqual({ accountId: "acc_a", level: "read", allowTo: [] });
  });

  it("lists grants and agents in insertion order", () => {
    const { ctx } = setup();
    const { agent } = ctx.policy.createAgent({ name: "a", grants: [grantInput("acc_b"), grantInput("acc_a")] });
    for (let i = 0; i < 5; i++) ctx.policy.createAgent({ name: `n${i}` });
    expect(ctx.policy.grants(agent.id).map((g) => g.accountId)).toEqual(["acc_b", "acc_a"]);
    expect(ctx.policy.listAgents().map((a) => a.name)).toEqual(["a", "n0", "n1", "n2", "n3", "n4"]);
  });

  it("folds case in ASCII only", () => {
    const kelvin = String.fromCodePoint(0x212a);
    expect(matchesGlob(`${kelvin}im@partner.com`, "kim@partner.com")).toBe(false);
    expect(matchesGlob(`${kelvin}im@partner.com`, "*@partner.com")).toBe(true);
    expect(matchesGlob("Kim@PARTNER.com", "kim@partner.com")).toBe(true);
    expect(matchesGlob(`kim@${String.fromCodePoint(0xff50)}artner.com`, "kim@partner.com")).toBe(true);
  });
});

describe("canSeeEvent", () => {
  it("needs a grant on the account (any level) and an enabled agent", () => {
    const { ctx } = setup();
    const { agent: reader } = ctx.policy.createAgent({ name: "r", grants: [grantInput("acc_a")] });
    const { agent: full } = ctx.policy.createAgent({ name: "f", grants: [grantInput("acc_a", { level: "full" })] });
    const ev = (type: "message.received" | "sync.gap" | "account.auth_failed", accountId = "acc_a") => ({ accountId, type });

    expect(ctx.policy.canSeeEvent(reader.id, ev("message.received"))).toBe(true);
    expect(ctx.policy.canSeeEvent(reader.id, ev("sync.gap"))).toBe(true);
    expect(ctx.policy.canSeeEvent(reader.id, ev("message.received", "acc_b"))).toBe(false);
    expect(ctx.policy.canSeeEvent(full.id, ev("account.auth_failed"))).toBe(true);
    ctx.policy.updateAgent(full.id, { disabled: true });
    expect(ctx.policy.canSeeEvent(full.id, ev("message.received"))).toBe(false);
  });
});

describe("thread labels", () => {
  it("computes thread-level label unions", () => {
    expect(threadLabels({ messages: [{ labelIds: ["A"] }, { labelIds: ["B", "A"] }, {}] }).sort()).toEqual(["A", "B"]);
  });
});
