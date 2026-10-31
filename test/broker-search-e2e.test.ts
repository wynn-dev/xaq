// Search mode through the real broker wiring (M3 done-when: approvals still hold through call_write_tool): a fake
// upstream connection with enough tools that the agent goes over SEARCH_MODE_THRESHOLD, so /mcp switches to search
// mode by itself; search_tools finds the upstream tool, call_write_tool on a risky one returns pending_approval, and
// after the owner approves, get_call_status has the result.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { SEARCH_MODE_THRESHOLD } from "../server/broker/search/mode.ts";
import { SEARCH_AUDIT_ACTION } from "../server/broker/search/tools.ts";
import { type FakeMcpUpstream, startFakeMcpUpstream } from "./fake-mcp-upstream.ts";
import { CSRF, harness, json } from "./platform-helpers.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

const text = (r: unknown) => (r as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join("\n");

describe("search mode end to end (fake upstream)", () => {
  it("switches on above the threshold; search, a risky call through call_write_tool, approve, get_call_status", async () => {
    const deleted: string[] = [];
    const reads = Array.from({ length: SEARCH_MODE_THRESHOLD }, (_, i) => ({
      name: `get_record_${i}`,
      description: `Read record set ${i} of the archive.`,
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      annotations: { readOnlyHint: true },
      handler: (args: unknown) => ({ content: [{ type: "text" as const, text: `Record ${(args as { id: string }).id}` }] }),
    }));
    const up: FakeMcpUpstream = await startFakeMcpUpstream({
      auth: { kind: "none" },
      tools: [
        ...reads,
        {
          name: "delete_page",
          description: "Delete a page from the wiki.",
          inputSchema: { type: "object", properties: { id: { type: "string", description: "The page to delete." } }, required: ["id"] },
          handler: (args) => {
            deleted.push((args as { id: string }).id);
            return { content: [{ type: "text", text: `Deleted ${(args as { id: string }).id}` }] };
          },
        },
      ],
    });
    cleanup.push(() => up.close());
    const h = harness();
    cleanup.push(() => h.dispose());
    const { ctx } = h;
    const cookie = await h.claim();
    const api = (path: string, init: RequestInit & { json?: unknown } = {}) => h.request(`/api${path}`, { cookie, ...init, headers: { ...CSRF, ...(init.headers as object) } });
    const { agent, apiKey } = ctx.policy.createAgent({ name: "Hermes" });

    const con = await json(await api("/connections", { method: "POST", json: { url: up.url, slug: "wiki", name: "Wiki", agentIds: [agent.id], levelDefault: "ask" } }));
    await json(await api(`/connections/${con.id}/private-target`, { method: "PUT", json: { allow: true } }));
    expect(await json(await api(`/connections/${con.id}/connect`, { method: "POST", json: {} }))).toMatchObject({ status: "connected" });
    expect(await ctx.broker.catalog.refresh(con.id)).toMatchObject({ ok: true });
    expect(ctx.broker.view(agent.id)!.tools).toHaveLength(SEARCH_MODE_THRESHOLD + 1);

    // The agent, over HTTP: more than 30 tools, so search mode is on by itself.
    const client = new Client({ name: "e2e", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://xaq.test/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
        fetch: async (url, init) => h.app.request(String(url), init as RequestInit, { incoming: { socket: { remoteAddress: "127.0.0.1" } } }),
      }),
    );
    cleanup.push(() => client.close());
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["call_read_tool", "call_write_tool", "get_call_status", "search_tools"]);
    expect(client.getInstructions()).toMatch(/search_tools/);

    // search_tools finds the upstream tool, with its schema and the broker's classification.
    const found = JSON.parse(text(await client.callTool({ name: "search_tools", arguments: { query: "delete a wiki page" } }))) as {
      tools: { name: string; kind: string; risky: boolean; inputSchema: { properties: Record<string, unknown> } }[];
    };
    expect(found.tools[0]).toMatchObject({ name: "wiki__delete_page", kind: "write", risky: true });
    expect(found.tools[0]!.inputSchema.properties).toHaveProperty("id");

    // A read runs at once through call_read_tool.
    expect(text(await client.callTool({ name: "call_read_tool", arguments: { name: "wiki__get_record_3", arguments: { id: "r1" } } }))).toContain("Record r1");

    // The risky one at "ask": pending at once, nothing sent upstream.
    const pending = await client.callTool({ name: "call_write_tool", arguments: { name: "wiki__delete_page", arguments: { id: "p2" } } });
    expect(text(pending)).toContain("pending_approval");
    const approvalId = /apr_[a-z0-9]+/.exec(text(pending))![0];
    expect(deleted).toEqual([]);
    expect(text(await client.callTool({ name: "get_call_status", arguments: { approval_id: approvalId } }))).toMatch(/pending/);

    // The owner approves: the stored call runs once, and get_call_status has its result.
    expect(await json(await api(`/approvals/${approvalId}/approve`, { method: "POST", json: {} }))).toMatchObject({ status: "sent" });
    expect(deleted).toEqual(["p2"]);
    expect(text(await client.callTool({ name: "get_call_status", arguments: { approval_id: approvalId } }))).toContain("Deleted p2");

    // Audited once each, under the real names; the search by its length only.
    const rows = ctx.db.all<{ action: string; outcome: string; detail: string | null }>("SELECT action, outcome, detail FROM audit_log WHERE actor_id = ? ORDER BY id", agent.id);
    const actions = rows.map((r) => r.action);
    expect(actions.filter((a) => a === "wiki__delete_page")).toHaveLength(1);
    expect(actions.filter((a) => a === "wiki__get_record_3")).toHaveLength(1);
    expect(actions.filter((a) => a === SEARCH_AUDIT_ACTION)).toHaveLength(1);
    expect(actions.some((a) => a.startsWith("call_") || a === "search_tools" || a === "unknown_tool")).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("wiki page");

    // Called by name, unlisted: the same broker path. A read runs; the risky one is pending at once, nothing sent.
    expect(ctx.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", `broker.search:${agent.id}`)?.value).toContain('"search"');
    expect(text(await client.callTool({ name: "wiki__get_record_4", arguments: { id: "r2" } }))).toContain("Record r2");
    const direct = await client.callTool({ name: "wiki__delete_page", arguments: { id: "p3" } });
    expect(text(direct)).toContain("pending_approval");
    expect(deleted).toEqual(["p2"]);

    // Read only: the write tool is refused by name exactly as in direct mode (it isn't the agent's tool any more).
    expect(await json(await api(`/connections/${con.id}/grants`, { method: "PUT", json: { grants: [{ agentId: agent.id, level: "read" }] } }))).toHaveLength(1);
    const refusal = async () => {
      const r = await client.callTool({ name: "wiki__delete_page", arguments: { id: "p4" } }).catch((err: Error) => err.message);
      return typeof r === "string" ? r : text(r);
    };
    expect(await refusal()).toMatch(/-32602.*wiki__delete_page not found/);
    expect(deleted).toEqual(["p2"]);
  }, 20_000);
});
