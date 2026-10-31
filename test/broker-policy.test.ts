// Broker policy, calls and mcp.call approvals (docs/MCP-BROKER.md "Access and approvals"): the three levels × risk,
// "always allow" rules (with and without a target, array targets), caps, exact-bytes approvals with the TOCTOU
// re-checks, get_call_status, expiry, output wrapping and delimiter escaping, token scrubbing, SourceError
// mapping and the kill switch. Offline: an in-process registry, source and credential store.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpCallApproval } from "../shared/types.ts";
import { type ApprovalRequestedEvent, approvalEventVisible, type BrokerPolicyRuntime, canonicalJson, createBrokerPolicyRuntime } from "../server/broker/policy/index.ts";
import { atPointer } from "../server/broker/policy/canonical.ts";
import { makeScrubber, processResult } from "../server/broker/policy/output.ts";
import { SourceError, type ToolResult } from "../server/broker/types.ts";
import { escapeDelimiters, wrapUntrusted } from "../server/mail/content.ts";
import { Approvals } from "../server/mail/approvals.ts";
import { addConnection, addTool, DbRegistry, FakeSource, FakeSources, grant, MemoryCredentials } from "./broker-policy-fakes.ts";
import { CSRF, type Harness, harness, json } from "./platform-helpers.ts";

const signal = () => new AbortController().signal;
const textOf = (r: ToolResult) => r.content.map((b) => (b.type === "text" ? String(b.text) : `[${b.type}]`)).join("\n");
const approvalIdOf = (r: ToolResult) => /approval_id: (apr_\w+)/.exec(textOf(r))?.[1] ?? null;

interface World {
  h: Harness;
  rt: BrokerPolicyRuntime;
  registry: DbRegistry;
  sources: FakeSources;
  credentials: MemoryCredentials;
  requested: ApprovalRequestedEvent[];
  agent: string;
  other: string;
  con: string;
  src: FakeSource;
}

let w: World;

beforeEach(() => {
  const h = harness();
  const { ctx } = h;
  const registry = new DbRegistry(ctx);
  const sources = new FakeSources();
  const credentials = new MemoryCredentials();
  const requested: ApprovalRequestedEvent[] = [];
  const rt = createBrokerPolicyRuntime(ctx, { registry, sources, credentials, onApprovalRequested: (e) => requested.push(e) });
  const agent = ctx.policy.createAgent({ name: "Hermes" }).agent.id;
  const other = ctx.policy.createAgent({ name: "Codex" }).agent.id;
  const con = addConnection(ctx, "notion", "Notion");
  addTool(ctx, con, "notion", { name: "search", read: true });
  addTool(ctx, con, "notion", { name: "update_page" });
  addTool(ctx, con, "notion", {
    name: "delete_pages",
    risky: true,
    inputSchema: { type: "object", properties: { page_ids: { type: "array", items: { type: "string" } }, reason: { type: "string" } }, required: ["page_ids"] },
  });
  addTool(ctx, con, "notion", { name: "send_message", risky: true, inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } } } });
  registry.targetPaths.set("notion__delete_pages", "/page_ids");
  const src = sources.add(con);
  w = { h, rt, registry, sources, credentials, requested, agent, other, con, src };
});

afterEach(async () => {
  await w.h.dispose();
});

const audits = (action: string) => w.h.ctx.audit.list({ action, limit: 200 }).items;

describe("levels × risk", () => {
  it("full: everything runs, risky or not", async () => {
    grant(w.h.ctx, w.agent, w.con, "full");
    expect(textOf(await w.rt.call(w.agent, "notion__update_page", {}, signal()))).toContain("ran update_page");
    expect(textOf(await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["p1"] }, signal()))).toContain("ran delete_pages");
    expect(w.src.calls.map((c) => c.name)).toEqual(["update_page", "delete_pages"]);
  });

  it("ask: non-risky runs; risky returns pending_approval at once without running", async () => {
    grant(w.h.ctx, w.agent, w.con, "ask");
    expect(textOf(await w.rt.call(w.agent, "notion__update_page", {}, signal()))).toContain("ran update_page");
    const r = await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["p1"] }, signal());
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/^pending_approval: /);
    expect(textOf(r)).toContain("get_call_status");
    expect(approvalIdOf(r)).toMatch(/^apr_/);
    expect(w.src.calls.map((c) => c.name)).toEqual(["update_page"]);
    const [entry] = audits("notion__delete_pages");
    expect(entry!.detail).toMatchObject({ decision: "ask", risky: true, connectionId: w.con, riskyCounted: true });
  });

  it("read: read tools run; a non-read tool is denied even if the registry let it through", async () => {
    grant(w.h.ctx, w.agent, w.con, "read");
    expect(textOf(await w.rt.call(w.agent, "notion__search", {}, signal()))).toContain("ran search");
    // The registry hides it at the read level…
    expect((await w.rt.call(w.agent, "notion__update_page", {}, signal())).isError).toBe(true);
    // …and the policy denies it on its own.
    w.registry.filterRead = false;
    const r = await w.rt.call(w.agent, "notion__update_page", {}, signal());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("read-only access to Notion");
    expect(audits("notion__update_page")[0]).toMatchObject({ outcome: "denied", reason: "read_only" });
    expect(w.src.calls.map((c) => c.name)).toEqual(["search"]);
  });

  it("no grant: the tool doesn't exist for the agent", async () => {
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    expect(r.isError).toBe(true);
    expect(audits("unknown_tool")[0]).toMatchObject({ reason: "unknown_tool" });
  });

  it("a disabled connection is denied in plain words", async () => {
    grant(w.h.ctx, w.agent, w.con, "full");
    w.h.ctx.db.run("UPDATE connections SET status = 'disabled' WHERE id = ?", w.con);
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    expect(textOf(r)).toContain("Notion is turned off");
    expect(w.src.calls).toHaveLength(0);
  });

  it("arguments are validated against the pinned schema before anything is forwarded", async () => {
    grant(w.h.ctx, w.agent, w.con, "full");
    const r = await w.rt.call(w.agent, "notion__delete_pages", { page_ids: "p1" }, signal());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Invalid arguments");
    expect(w.src.calls).toHaveLength(0);
  });
});

describe("always allow rules", () => {
  beforeEach(() => grant(w.h.ctx, w.agent, w.con, "ask"));

  it("without a target: approving once with alwaysAllow means the next call doesn't ask", async () => {
    const id = approvalIdOf(await w.rt.call(w.agent, "notion__send_message", { to: "bob@example.com", body: "hi" }, signal()))!;
    await w.rt.approve(id, { alwaysAllow: {} });
    const again = await w.rt.call(w.agent, "notion__send_message", { to: "eve@example.com", body: "yo" }, signal());
    expect(textOf(again)).toContain("ran send_message");
    expect(audits("notion__send_message")[0]!.detail).toMatchObject({ decision: "allow", ruleId: expect.stringMatching(/^rul_/) });
    // Another agent's calls still ask.
    grant(w.h.ctx, w.other, w.con, "ask");
    expect(textOf(await w.rt.call(w.other, "notion__send_message", { to: "x@example.com" }, signal()))).toMatch(/^pending_approval/);
  });

  it("with a target: only that target goes through", async () => {
    const id = approvalIdOf(await w.rt.call(w.agent, "notion__send_message", { to: "bob@example.com" }, signal()))!;
    await w.rt.approve(id, { alwaysAllow: { target: true, targetPath: "/to" } });
    expect(textOf(await w.rt.call(w.agent, "notion__send_message", { to: "bob@example.com", body: "again" }, signal()))).toContain("ran");
    expect(textOf(await w.rt.call(w.agent, "notion__send_message", { to: "eve@example.com" }, signal()))).toMatch(/^pending_approval/);
  });

  it("array targets: allowed only when every id is covered", async () => {
    const id = approvalIdOf(await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["p1", "p2"] }, signal()))!;
    // The tool's own targetPath (/page_ids) is used: one rule per id.
    await w.rt.approve(id, { alwaysAllow: { target: true } });
    expect(w.rt.listRules({ agentId: w.agent }).map((r) => r.targetValue).sort()).toEqual(['"p1"', '"p2"']);
    expect(textOf(await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["p2"] }, signal()))).toContain("ran");
    expect(textOf(await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["p1", "p2"] }, signal()))).toContain("ran");
    expect(textOf(await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["p1", "p3"] }, signal()))).toMatch(/^pending_approval/);
    expect(textOf(await w.rt.call(w.agent, "notion__delete_pages", { page_ids: [] }, signal()))).toMatch(/^pending_approval/);
  });

  it("JSON Pointers, not dot paths: {\"a.b\"} and {a:{b}} are different targets", () => {
    const args = { "a.b": "x", a: { b: "y" }, "c/d": "z", "e~f": "t" };
    expect(atPointer(args, "/a.b")).toBe("x");
    expect(atPointer(args, "/a/b")).toBe("y");
    expect(atPointer(args, "/c~1d")).toBe("z");
    expect(atPointer(args, "/e~0f")).toBe("t");
    expect(atPointer(args, "a.b")).toBeUndefined();
  });

  it("revoking the grant deletes the rules; a re-granted connection or a returning tool doesn't inherit old ones", async () => {
    const id = approvalIdOf(await w.rt.call(w.agent, "notion__send_message", { to: "bob@example.com" }, signal()))!;
    await w.rt.approve(id, { alwaysAllow: {} });
    expect(w.rt.onGrantRemoved(w.agent, w.con).rulesDeleted).toBe(1);

    // A rule older than the current grant (a missed delete) is ignored.
    const id2 = approvalIdOf(await w.rt.call(w.agent, "notion__send_message", { to: "bob@example.com" }, signal()))!;
    await w.rt.approve(id2, { alwaysAllow: {} });
    w.h.ctx.db.run("UPDATE approval_rules SET created_at = '2000-01-01T00:00:00.000Z'");
    expect(textOf(await w.rt.call(w.agent, "notion__send_message", { to: "bob@example.com" }, signal()))).toMatch(/^pending_approval/);

    // A removed tool loses its rules.
    w.h.ctx.db.run("UPDATE approval_rules SET created_at = ?", new Date().toISOString());
    expect(w.rt.onToolRemoved(w.con, "send_message").rulesDeleted).toBe(1);
  });

  it("rules are listed and deleted through the admin API", async () => {
    const cookie = await w.h.claim();
    const id = approvalIdOf(await w.rt.call(w.agent, "notion__send_message", { to: "bob@example.com" }, signal()))!;
    await w.rt.approve(id, { alwaysAllow: {} });
    const list = await json(await w.h.request(`/api/approval-rules?agentId=${w.agent}`, { cookie }));
    expect(list).toHaveLength(1);
    const del = await w.h.request(`/api/approval-rules/${list[0].id}`, { method: "DELETE", cookie, headers: CSRF });
    expect(del.status).toBe(204);
    expect(w.rt.listRules()).toHaveLength(0);
  });
});

describe("caps on risky calls", () => {
  it("count runs, queued calls and unknown outcomes; not denials or calls that never left", async () => {
    w.h.ctx.settings.setState("broker.policy", { riskyPerHour: 3, riskyPerDay: null });
    grant(w.h.ctx, w.agent, w.con, "full");
    await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["a"] }, signal()); // ran: 1
    w.src.handler = () => {
      throw new SourceError("needs_reauth", "expired");
    };
    await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["b"] }, signal()); // never left: 1
    w.src.handler = () => {
      throw new SourceError("timeout", "slow");
    };
    await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["c"] }, signal()); // unknown outcome: 2
    grant(w.h.ctx, w.agent, w.con, "ask");
    expect(textOf(await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["d"] }, signal()))).toMatch(/^pending_approval/); // queued: 3
    const r = await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["e"] }, signal());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Limit reached: 3 of 3 risky tool calls");
    // Non-risky calls aren't capped.
    w.src.handler = () => ({ content: [{ type: "text", text: "ok" }] });
    expect(textOf(await w.rt.call(w.agent, "notion__update_page", {}, signal()))).toContain("ok");
    // Per agent.
    grant(w.h.ctx, w.other, w.con, "full");
    expect(textOf(await w.rt.call(w.other, "notion__delete_pages", { page_ids: ["f"] }, signal()))).toContain("ok");
  });

  it("concurrent risky calls can't all pass the check before any is recorded", async () => {
    w.h.ctx.settings.setState("broker.policy", { riskyPerHour: 2 });
    grant(w.h.ctx, w.agent, w.con, "full");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    w.src.handler = async () => {
      await gate;
      return { content: [{ type: "text", text: "done" }] };
    };
    const calls = [1, 2, 3].map((i) => w.rt.call(w.agent, "notion__delete_pages", { page_ids: [`p${i}`] }, signal()));
    release();
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.isError).length).toBe(1);
  });
});

describe("mcp.call approvals", () => {
  beforeEach(() => grant(w.h.ctx, w.agent, w.con, "ask"));

  const queue = async (args: Record<string, unknown> = { reason: "cleanup", page_ids: ["p1"] }) => {
    const id = approvalIdOf(await w.rt.call(w.agent, "notion__delete_pages", args, signal()))!;
    return { id, approval: w.h.ctx.mail.getApproval(id) as McpCallApproval };
  };

  it("stores the canonical bytes, their sha256, the pin and the agent; approve forwards exactly those bytes", async () => {
    const { id, approval } = await queue({ reason: "cleanup", page_ids: ["p1"] });
    expect(approval).toMatchObject({ kind: "mcp.call", status: "pending", agentId: w.agent, connectionId: w.con, accountId: null });
    expect(approval.call.args).toBe(canonicalJson({ page_ids: ["p1"], reason: "cleanup" }));
    expect(approval.call.args).toBe('{"page_ids":["p1"],"reason":"cleanup"}');
    expect(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)).toBe(24 * 3_600_000);

    // Pending at once; get_call_status says so.
    expect(textOf(w.rt.getCallStatus(w.agent, id))).toMatch(/^pending: /);

    w.src.handler = () => ({ content: [{ type: "text", text: "deleted p1" }] });
    const done = await w.rt.approve(id);
    expect(done.status).toBe("sent");
    expect(w.src.calls).toHaveLength(1);
    expect(w.src.calls[0]!.json).toBe(approval.call.args);

    const status = w.rt.getCallStatus(w.agent, id);
    expect(status.isError).toBeFalsy();
    expect(textOf(status)).toMatch(/^done: /);
    expect(textOf(status)).toMatch(/<tool_output source="notion\/delete_pages" nonce="\w+" untrusted>\ndeleted p1\n<\/tool_output>/);
  });

  it("approval.requested carries ids and the link, never the arguments", async () => {
    const { id } = await queue({ page_ids: ["secret-page"] });
    expect(w.requested).toHaveLength(1);
    const ev = w.requested[0]!;
    expect(ev).toMatchObject({ type: "approval.requested", approvalId: id, agentId: w.agent, agentName: "Hermes", connectionId: w.con, tool: "delete_pages", exposedName: "notion__delete_pages" });
    expect(ev.url).toBe(`${w.h.ctx.settings.publicUrl()}/approve/${id}`);
    expect(JSON.stringify(ev)).not.toContain("secret-page");
    expect(approvalEventVisible(w.agent, ev, "listener")).toBe(true);
    expect(approvalEventVisible(w.other, ev, "listener")).toBe(false);
    expect(approvalEventVisible(w.other, ev, "webhook")).toBe(true);
  });

  it("TOCTOU: a changed pin cancels the approval and nothing runs", async () => {
    const { id } = await queue();
    w.h.ctx.db.run("UPDATE upstream_tools SET pin_hash = 'changed' WHERE name = 'delete_pages'");
    await expect(w.rt.approve(id)).rejects.toThrow(/definition changed/);
    expect(w.h.ctx.mail.getApproval(id)!.status).toBe("rejected");
    expect(w.src.calls).toHaveLength(0);
  });

  it("TOCTOU: tampered stored arguments fail the hash check and nothing runs", async () => {
    const { id } = await queue();
    w.h.ctx.db.run(`UPDATE approvals SET tool_call = json_set(tool_call, '$.args', '{"page_ids":["everything"]}') WHERE id = ?`, id);
    await expect(w.rt.approve(id)).rejects.toThrow(/fingerprint/);
    expect(w.src.calls).toHaveLength(0);
  });

  it("re-checks the agent and its level", async () => {
    const { id } = await queue();
    grant(w.h.ctx, w.agent, w.con, "read");
    await expect(w.rt.approve(id)).rejects.toThrow(/can no longer use|read-only/);
    const { id: id2 } = await (async () => {
      grant(w.h.ctx, w.agent, w.con, "ask");
      return queue();
    })();
    w.h.ctx.policy.updateAgent(w.agent, { disabled: true });
    await expect(w.rt.approve(id2)).rejects.toThrow(/agent is disabled|already rejected/);
    expect(w.src.calls).toHaveLength(0);
  });

  it("runs by the stored connection and upstream tool name, not the exposed name", async () => {
    const { id } = await queue();
    // A slug edit renames the exposed tool; another connection takes the old slug.
    w.h.ctx.db.run("UPDATE connections SET slug = 'notion-old' WHERE id = ?", w.con);
    w.h.ctx.db.run("UPDATE upstream_tools SET exposed_name = 'notion-old__' || name WHERE connection_id = ?", w.con);
    const evil = addConnection(w.h.ctx, "notion", "Evil");
    addTool(w.h.ctx, evil, "notion", { name: "delete_pages", risky: true });
    grant(w.h.ctx, w.agent, evil, "full");
    const evilSrc = w.sources.add(evil);
    await w.rt.approve(id);
    expect(evilSrc.calls).toHaveLength(0);
    expect(w.src.calls).toHaveLength(1);
  });

  it("the W7 hook: runApprovedCall runs an already-claimed approval", async () => {
    const { id } = await queue();
    w.h.ctx.db.run("UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?", new Date().toISOString(), id);
    await w.rt.runApprovedCall(w.h.ctx.mail.getApproval(id) as McpCallApproval);
    expect(w.h.ctx.mail.getApproval(id)!.status).toBe("sent");
    expect(w.src.calls).toHaveLength(1);
  });

  it("runApprovedCall claims the run itself: concurrent or repeated hooks forward it once", async () => {
    const { id } = await queue();
    w.h.ctx.db.run("UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?", new Date().toISOString(), id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    w.src.handler = async () => {
      await gate;
      return { content: [{ type: "text", text: "ok" }] };
    };
    const a = w.h.ctx.mail.getApproval(id) as McpCallApproval;
    const runs = [w.rt.runApprovedCall(a), w.rt.runApprovedCall(a)];
    release();
    await Promise.all(runs);
    await w.rt.runApprovedCall(a);
    expect(w.src.calls).toHaveLength(1);
    // Still pending (never claimed by a human): the hook doesn't run it.
    const { id: id2 } = await queue();
    await w.rt.runApprovedCall(w.h.ctx.mail.getApproval(id2) as McpCallApproval);
    expect(w.src.calls).toHaveLength(1);
  });

  it("pending_approval tells the agent not to call again", async () => {
    const r = await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["p1"] }, signal());
    expect(textOf(r)).toContain("Don't call this tool again for the same action");
    expect(textOf(r)).toContain("check with get_call_status");
  });

  it("always allow also approves and runs the agent's other pending calls the new rule covers", async () => {
    const { id } = await queue({ page_ids: ["p1"] });
    const { id: covered } = await queue({ page_ids: ["p1"], reason: "again" });
    const { id: uncovered } = await queue({ page_ids: ["p1", "p2"] });
    grant(w.h.ctx, w.other, w.con, "ask");
    const otherId = approvalIdOf(await w.rt.call(w.other, "notion__delete_pages", { page_ids: ["p1"] }, signal()))!;
    await w.rt.approve(id, { alwaysAllow: { target: true } });
    expect(w.h.ctx.mail.getApproval(covered)!.status).toBe("sent");
    expect(w.h.ctx.mail.getApproval(uncovered)!.status).toBe("pending");
    expect(w.h.ctx.mail.getApproval(otherId)!.status).toBe("pending");
    expect(w.src.calls).toHaveLength(2);
  });

  it("both recoveries, in either order, leave an interrupted mcp.call failed with an unknown outcome", async () => {
    const mail = new Approvals(w.h.ctx);
    for (const order of [["mail", "broker"], ["broker", "mail"]]) {
      const { id } = await queue();
      w.h.ctx.db.run("UPDATE approvals SET status = 'approved', decided_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", id);
      for (const step of order) {
        if (step === "mail") mail.recoverInterrupted(0);
        else w.rt.recoverInterrupted();
      }
      const a = w.h.ctx.mail.getApproval(id) as McpCallApproval;
      expect(a.status).toBe("failed");
      expect(a.call.outcomeUnknown).toBe(true);
      expect(textOf(w.rt.getCallStatus(w.agent, id))).toMatch(/^outcome unknown: /);
    }
    expect(w.src.calls).toHaveLength(0);
  });

  it("reject and expire", async () => {
    const { id } = await queue();
    w.rt.reject(id, "no thanks");
    expect(textOf(w.rt.getCallStatus(w.agent, id))).toMatch(/^rejected: .*no thanks/);
    const { id: id2 } = await queue();
    w.h.ctx.db.run("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", id2);
    expect(textOf(w.rt.getCallStatus(w.agent, id2))).toMatch(/^expired: /);
    await expect(w.rt.approve(id2)).rejects.toThrow(/already expired/);
    expect(w.src.calls).toHaveLength(0);
  });

  it("get_call_status is scoped to the calling agent", async () => {
    const { id } = await queue();
    const r = w.rt.getCallStatus(w.other, id);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("No tool call request");
  });

  it("an interrupted call ends with an unknown outcome and is never retried", async () => {
    const { id } = await queue();
    w.h.ctx.db.run("UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ?", new Date().toISOString(), id);
    expect(w.rt.recoverInterrupted()).toBe(1);
    expect(w.h.ctx.mail.getApproval(id)!.status).toBe("failed");
    expect(textOf(w.rt.getCallStatus(w.agent, id))).toMatch(/^outcome unknown: /);

    const { id: id2 } = await queue();
    w.src.handler = () => {
      throw new SourceError("timeout", "slow");
    };
    await w.rt.approve(id2);
    const a = w.h.ctx.mail.getApproval(id2) as McpCallApproval;
    expect(a.status).toBe("failed");
    expect(a.call.outcomeUnknown).toBe(true);
    await expect(w.rt.approve(id2)).rejects.toThrow(/already failed/);
    expect(w.src.calls).toHaveLength(1);
  });

  it("a call that never left (re-auth) goes back to pending with the fix", async () => {
    const { id } = await queue();
    w.src.handler = () => {
      throw new SourceError("needs_reauth", "invalid_grant");
    };
    await w.rt.approve(id);
    const a = w.h.ctx.mail.getApproval(id)!;
    expect(a.status).toBe("pending");
    expect(a.error).toContain("Connections → Reconnect");
  });

  it("losing the grant cancels pending approvals; the mail sweep leaves mcp.call alone", async () => {
    const { id } = await queue();
    new Approvals(w.h.ctx).cancelForAgent(w.agent, null, "send removed", "mail");
    expect(w.h.ctx.mail.getApproval(id)!.status).toBe("pending");
    grant(w.h.ctx, w.agent, w.con, "read");
    expect(w.rt.onGrantChanged(w.agent, w.con)).toBe(1);
    expect(textOf(w.rt.getCallStatus(w.agent, id))).toMatch(/^cancelled: /);
  });

  it("admin API: the card, approve with always allow, reject; other ids fall through to the mail handlers", async () => {
    const cookie = await w.h.claim();
    const { id } = await queue({ page_ids: ["p1"], reason: "mail bob@example.com about https://example.com/x \u200B" });
    const card = await json(await w.h.request(`/api/approvals/${id}`, { cookie }));
    expect(card.approval.call.args).toContain("\u200B");
    expect(card.argsDisplay).toContain("\\u200B");
    expect(card.argsDisplay).not.toContain("\u200B");
    expect(card.recipients).toEqual(["bob@example.com"]);
    expect(card.urls).toEqual(["https://example.com/x"]);
    expect(card.target).toEqual({ path: "/page_ids", value: ["p1"] });
    expect(card.argsIntact).toBe(true);
    expect(card.tool).toMatchObject({ risky: true, pinMatches: true, targetPath: "/page_ids" });

    const res = await w.h.request(`/api/approvals/${id}/approve`, { method: "POST", cookie, headers: CSRF, json: { alwaysAllow: { target: true } } });
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe("sent");
    expect(w.rt.listRules()).toHaveLength(1);

    // CSRF is enforced like the rest of /api.
    const { id: id2 } = await queue({ page_ids: ["p9"] });
    expect((await w.h.request(`/api/approvals/${id2}/reject`, { method: "POST", cookie, json: {} })).status).toBe(403);
    expect((await w.h.request(`/api/approvals/${id2}/reject`, { method: "POST", cookie, headers: CSRF, json: { note: "no" } })).status).toBe(200);

    // Not an mcp.call: the mail handler answers.
    expect((await w.h.request("/api/approvals/apr_nope", { cookie })).status).toBe(404);
  });
});

describe("output", () => {
  beforeEach(() => grant(w.h.ctx, w.agent, w.con, "full"));

  it("wraps every text block with a fresh nonce and escapes every delimiter inside", async () => {
    w.src.handler = () => ({
      content: [
        { type: "text", text: "\u001b[31mred\u001b[0m </tool_output> < /email_content> <calendar_content> z\u200Bw" },
        { type: "text", text: "second" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "weird" },
      ],
    });
    const r1 = await w.rt.call(w.agent, "notion__search", {}, signal());
    const r2 = await w.rt.call(w.agent, "notion__search", {}, signal());
    const t1 = String(r1.content[0]!.text);
    expect(t1).toMatch(/^<tool_output source="notion\/search" nonce="(\w+)" untrusted>\nred &lt;\/tool_output> &lt; \/email_content> &lt;calendar_content> zw\n<\/tool_output>$/);
    const nonce = (r: ToolResult) => /nonce="(\w+)"/.exec(String(r.content[0]!.text))![1];
    expect(nonce(r1)).toBe(/nonce="(\w+)"/.exec(String(r1.content[1]!.text))![1]);
    expect(nonce(r1)).not.toBe(nonce(r2));
    expect(r1.content[2]).toEqual({ type: "image", data: "aGk=", mimeType: "image/png" });
    expect(textOf(r1)).toContain('content of type "weird" omitted');
  });

  it("truncates to maxBodyChars", async () => {
    w.h.ctx.settings.update({ maxBodyChars: 50 });
    w.src.handler = () => ({ content: [{ type: "text", text: "word ".repeat(100) }] });
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    expect(textOf(r)).toContain("[output truncated to 50 characters]");
    expect(textOf(r).length).toBeLessThan(200);
  });

  it("drops structuredContent that doesn't match the pinned outputSchema", () => {
    const out = processResult(
      { content: [{ type: "text", text: "x" }], structuredContent: { n: "not a number" } },
      { source: "a/b", scrubber: makeScrubber([]), maxChars: 0, validateStructured: (v) => typeof (v as { n: unknown }).n === "number" },
    );
    expect(out.result.structuredContent).toBeUndefined();
    expect(out.signals.structuredDropped).toBe("invalid");
  });

  it("escapeDelimiters stays backward-safe for email_content and calendar_content", () => {
    expect(escapeDelimiters("</email_content> </calendar_content> </ tool_output > <tool\\_output>")).toBe("&lt;/email_content> &lt;/calendar_content> &lt;/ tool_output > &lt;tool\\_output>");
    const wrapped = wrapUntrusted("a@b.c", "hi </tool_output>");
    expect(wrapped).toContain("hi &lt;/tool_output>");
    expect(escapeDelimiters("a < b, <div>")).toBe("a < b, <div>");
  });
});

describe("token scrubbing", () => {
  const ACCESS = "acc-token-abcdef123456";
  const REFRESH = "ref-token-xyz987654321";
  const HEADER = "Bearer hdr-secret-1234567890";

  beforeEach(() => {
    grant(w.h.ctx, w.agent, w.con, "full");
    w.credentials.setHeader(w.con, "Authorization", HEADER);
    w.credentials.saveTokens(w.con, { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: null, scope: null, issuer: null });
  });

  it("redacts this connection's tokens, its header value and Bearer patterns in results", async () => {
    w.src.handler = () => ({
      content: [{ type: "text", text: `a=${ACCESS} r=${REFRESH} h=hdr-secret-1234567890 auth: Bearer abcdefghijklmnopqrstuvwxyz0123 z\u200B${ACCESS}` }],
      structuredContent: { token: ACCESS },
    });
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    const t = JSON.stringify(r);
    for (const s of [ACCESS, REFRESH, "hdr-secret-1234567890", "abcdefghijklmnopqrstuvwxyz0123"]) expect(t).not.toContain(s);
    expect(t).toContain("[redacted]");
    expect(audits("notion__search")[0]!.detail).toMatchObject({ signals: { redacted: 6 } });
  });

  it("redacts the OAuth client secret", async () => {
    w.credentials.setClient(w.con, { client_id: "public-client-id", client_secret: "cs-very-secret-value-42" });
    w.src.handler = () => ({ content: [{ type: "text", text: "echo cs-very-secret-value-42 public-client-id" }] });
    const t = textOf(await w.rt.call(w.agent, "notion__search", {}, signal()));
    expect(t).not.toContain("cs-very-secret-value-42");
    expect(t).toContain("public-client-id");
  });

  it("redacts in error messages, and in what's stored for get_call_status", async () => {
    w.src.handler = () => {
      throw new SourceError("unavailable", `upstream said ${ACCESS} is bad`);
    };
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    expect(textOf(r)).not.toContain(ACCESS);
    expect(textOf(r)).toContain("[redacted]");

    grant(w.h.ctx, w.agent, w.con, "ask");
    const id = approvalIdOf(await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["p"] }, signal()))!;
    w.src.handler = () => ({ content: [{ type: "text", text: `leak ${REFRESH}` }] });
    await w.rt.approve(id);
    const row = w.h.ctx.db.get<{ tool_call: string }>("SELECT tool_call FROM approvals WHERE id = ?", id)!;
    expect(row.tool_call).not.toContain(REFRESH);
  });

  it("risky calls keep full arguments in the audit log, with secret-like keys redacted", async () => {
    await w.rt.call(w.agent, "notion__send_message", { to: "bob@example.com", body: `hi ${ACCESS}`, api_key: "k-123456789" } as never, signal());
    const d = audits("notion__send_message")[0]!.detail as { args: Record<string, unknown>; argsSha256: string; argsBytes: number };
    expect(d.args).toEqual({ to: "bob@example.com", body: "hi [redacted]", api_key: "[redacted]" });
    expect(d.argsSha256).toMatch(/^[0-9a-f]{64}$/);
    // Non-risky calls keep only the fingerprint.
    await w.rt.call(w.agent, "notion__update_page", { title: "x" }, signal());
    expect(audits("notion__update_page")[0]!.detail).not.toHaveProperty("args");
  });
});

describe("SourceError → plain words", () => {
  beforeEach(() => grant(w.h.ctx, w.agent, w.con, "full"));

  const failWith = async (err: unknown) => {
    w.src.handler = () => {
      throw err;
    };
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    expect(r.isError).toBe(true);
    return { text: textOf(r), audit: audits("notion__search")[0]! };
  };

  it.each([
    [new SourceError("needs_reauth", "x"), /The owner must reconnect Notion in xaq \(Connections → Reconnect\)/, "needs_reauth"],
    [new SourceError("timeout", "x"), /Notion didn't answer in time\. The call may or may not have run/, "timeout"],
    [new SourceError("rate_limited", "x", 30_000), /limiting requests right now\. Try again in 30 seconds\./, "rate_limited"],
    [new SourceError("rate_limited", "x"), /Try again in a minute\./, "rate_limited"],
    [new SourceError("blocked_target", "x"), /blocked the connection to Notion.*allow this host/, "blocked_target"],
    [new SourceError("unavailable", "connection refused"), /Notion is unavailable right now \(connection refused\)/, "unavailable"],
    [new SourceError("protocol", "bad json"), /couldn't understand \(bad json\)/, "protocol"],
    [new Error("boom at /srv/internal.js"), /^The call to Notion failed unexpectedly\. It may or may not have run there/, "internal"],
  ])("%s", async (err, message, reason) => {
    const { text, audit } = await failWith(err);
    expect(text).toMatch(message);
    expect(text).not.toContain("/srv/internal.js");
    expect(audit).toMatchObject({ outcome: "error", reason });
  });

  it("a connection needing re-auth is denied before anything is sent", async () => {
    w.h.ctx.db.run("UPDATE connections SET status = 'needs_reauth' WHERE id = ?", w.con);
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    expect(textOf(r)).toContain("Connections → Reconnect");
    expect(w.src.calls).toHaveLength(0);
  });
});

describe("hostile schemas and sizes", () => {
  const EVIL = "^(a+)+$";
  const evilInput = "a".repeat(40) + "!";

  beforeEach(() => grant(w.h.ctx, w.agent, w.con, "full"));

  it("an upstream outputSchema pattern can't backtrack on its own structuredContent (RE2, linear)", async () => {
    addTool(w.h.ctx, w.con, "notion", {
      name: "evil_out",
      read: true,
      outputSchema: { type: "object", properties: { s: { type: "string", pattern: EVIL } }, patternProperties: { [EVIL]: { type: "string" } } },
    });
    w.src.handler = () => ({ content: [{ type: "text", text: "x" }], structuredContent: { s: evilInput, [evilInput]: "v" } });
    const t0 = performance.now();
    const r = await w.rt.call(w.agent, "notion__evil_out", {}, signal());
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.structuredContent).toBeUndefined(); // doesn't match the pattern: dropped
  });

  it("input patterns run on RE2 too, and still validate", async () => {
    addTool(w.h.ctx, w.con, "notion", { name: "evil_in", inputSchema: { type: "object", properties: { s: { type: "string", pattern: EVIL }, t: { type: "string", pattern: "^[a-z]+$" } } } });
    const t0 = performance.now();
    const r = await w.rt.call(w.agent, "notion__evil_in", { s: evilInput }, signal());
    expect(performance.now() - t0).toBeLessThan(500);
    expect(textOf(r)).toContain("Invalid arguments");
    expect(textOf(await w.rt.call(w.agent, "notion__evil_in", { t: "ABC" }, signal()))).toContain("Invalid arguments");
    expect(textOf(await w.rt.call(w.agent, "notion__evil_in", { s: "aaa", t: "abc" }, signal()))).toContain("ran evil_in");
  });

  it("a pattern RE2 can't express isn't checked (the upstream validates its own input)", async () => {
    addTool(w.h.ctx, w.con, "notion", { name: "lookahead", inputSchema: { type: "object", properties: { s: { type: "string", pattern: "^(?=a)a$" } } } });
    expect(textOf(await w.rt.call(w.agent, "notion__lookahead", { s: "zzz" }, signal()))).toContain("ran lookahead");
  });

  it("uniqueItems is dropped and oversized arguments are refused", async () => {
    addTool(w.h.ctx, w.con, "notion", { name: "uniq", inputSchema: { type: "object", properties: { xs: { type: "array", uniqueItems: true } } } });
    const t0 = performance.now();
    await w.rt.call(w.agent, "notion__uniq", { xs: Array.from({ length: 20_000 }, (_, i) => ({ i })) }, signal());
    expect(performance.now() - t0).toBeLessThan(2000);
    const big = await w.rt.call(w.agent, "notion__uniq", { xs: ["x".repeat(1024 * 1024)] }, signal());
    expect(textOf(big)).toContain("too large");
    expect(w.src.calls).toHaveLength(1);
  });
});

describe("scrubber and kill races", () => {
  beforeEach(() => grant(w.h.ctx, w.agent, w.con, "full"));

  it("a token straddling the 300-character cut of an error message doesn't leak its prefix", async () => {
    const token = "straddle-token-0123456789abcdef";
    w.credentials.saveTokens(w.con, { accessToken: token, refreshToken: null, expiresAt: null, scope: null, issuer: null });
    w.src.handler = () => {
      throw new SourceError("unavailable", `${"x".repeat(290)} ${token}`);
    };
    const t = textOf(await w.rt.call(w.agent, "notion__search", {}, signal()));
    expect(t).not.toContain(token.slice(0, 8));
  });

  it("a token refreshed during the call is scrubbed from its result", async () => {
    w.credentials.saveTokens(w.con, { accessToken: "old-token-aaaaaaaaaaaa", refreshToken: null, expiresAt: null, scope: null, issuer: null });
    w.src.handler = () => {
      w.credentials.saveTokens(w.con, { accessToken: "new-token-bbbbbbbbbbbb", refreshToken: "new-refresh-cccccccccc", expiresAt: null, scope: null, issuer: null });
      return { content: [{ type: "text", text: "new-token-bbbbbbbbbbbb new-refresh-cccccccccc" }] };
    };
    const t = textOf(await w.rt.call(w.agent, "notion__search", {}, signal()));
    expect(t).not.toContain("new-token-bbbbbbbbbbbb");
    expect(t).not.toContain("new-refresh-cccccccccc");
  });

  it("a kill while the source is being acquired stops the call before it's forwarded", async () => {
    const original = w.sources.source.bind(w.sources);
    w.sources.source = async (id: string) => {
      await Promise.resolve();
      w.h.ctx.db.run("UPDATE connections SET status = 'disabled' WHERE id = ?", id);
      return original(id);
    };
    const r = await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["p"] }, signal());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("turned off");
    expect(w.src.calls).toHaveLength(0);
    expect(audits("notion__delete_pages")[0]).toMatchObject({ reason: "connection_disabled" });
    expect(audits("notion__delete_pages")[0]!.detail).not.toHaveProperty("riskyCounted");
  });
});

describe("kill switch", () => {
  it("disables the connection, cancels pending approvals, clears credentials and closes the source", async () => {
    grant(w.h.ctx, w.agent, w.con, "ask");
    w.credentials.setHeader(w.con, "Authorization", "Bearer something-long-enough");
    const id = approvalIdOf(await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["p"] }, signal()))!;
    const cookie = await w.h.claim();
    const res = await w.h.request(`/api/connections/${w.con}/kill`, { method: "POST", cookie, headers: CSRF });
    expect(res.status).toBe(204);
    expect(w.h.ctx.db.get<{ status: string }>("SELECT status FROM connections WHERE id = ?", w.con)!.status).toBe("disabled");
    expect(w.h.ctx.mail.getApproval(id)!.status).toBe("rejected");
    expect(w.credentials.cleared).toEqual([w.con]);
    expect(w.credentials.header(w.con)).toBeNull();
    expect(w.sources.closed).toEqual([w.con]);
    expect(w.src.closed).toBe(1);
    expect(textOf(await w.rt.call(w.agent, "notion__update_page", {}, signal()))).toContain("turned off");
    expect(audits("connection.kill")[0]).toMatchObject({ outcome: "ok", target: w.con });
  });
});
