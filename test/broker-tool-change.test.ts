// A changed upstream tool just keeps working (the owner removed the tool-change hold on 2026-10-16), through the
// real broker wiring and a fake upstream: a description or schema change is used at once under the same name;
// nothing goes on hold, no event, webhook or listener ping is sent, and the only trace is one
// audit entry with the old and new definition hash. Access levels, approvals for risky tools and "always allow" rules
// apply to the changed tool as before. A tool an older version left on hold is usable after the upgrade.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeMcpUpstream, type FakeTool, startFakeMcpUpstream } from "./fake-mcp-upstream.ts";
import { CSRF, type Harness, harness, json } from "./platform-helpers.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

const text = (r: unknown) => (r as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join("\n");
const ID_SCHEMA = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };

const getPage = (extra: Partial<FakeTool> = {}): FakeTool => ({
  name: "get_page",
  description: "Read a page.",
  inputSchema: ID_SCHEMA,
  annotations: { readOnlyHint: true },
  handler: (args) => ({ content: [{ type: "text", text: `Page ${(args as { id: string }).id}` }] }),
  ...extra,
});

interface Setup {
  h: Harness;
  up: FakeMcpUpstream;
  api: (path: string, init?: RequestInit & { json?: unknown }) => Promise<Response>;
  conId: string;
  deleted: string[];
  agent(name: string, level: "full" | "ask" | "read"): Promise<{ id: string; apiKey: string }>;
  mcp(apiKey: string): Promise<Client>;
  storedHash(name: string): string;
  toolAudits(): { action: string; target: string | null; actor_type: string; detail: Record<string, unknown> }[];
  connectionEvents(): string[];
}

async function setup(): Promise<Setup> {
  const deleted: string[] = [];
  const up = await startFakeMcpUpstream({
    auth: { kind: "none" },
    tools: [
      getPage(),
      {
        name: "delete_page",
        description: "Delete a page.",
        inputSchema: ID_SCHEMA,
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

  const con = await json(await api("/connections", { method: "POST", json: { url: up.url, slug: "fake", name: "Fake", agentIds: [], levelDefault: "ask" } }));
  await json(await api(`/connections/${con.id}/private-target`, { method: "PUT", json: { allow: true } }));
  expect(await json(await api(`/connections/${con.id}/connect`, { method: "POST", json: {} }))).toMatchObject({ status: "connected" });
  expect(await ctx.broker.catalog.refresh(con.id)).toMatchObject({ ok: true });

  const grants: { agentId: string; level: string }[] = [];
  return {
    h,
    up,
    api,
    conId: con.id,
    deleted,
    async agent(name, level) {
      const { agent, apiKey } = ctx.policy.createAgent({ name });
      grants.push({ agentId: agent.id, level });
      expect((await api(`/connections/${con.id}/grants`, { method: "PUT", json: { grants } })).status).toBe(200);
      return { id: agent.id, apiKey };
    },
    async mcp(apiKey) {
      const client = new Client({ name: "tool-change", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://xaq.test/mcp"), {
          requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
          fetch: async (url, init) => h.app.request(String(url), init as RequestInit, { incoming: { socket: { remoteAddress: "127.0.0.1" } } }),
        }),
      );
      cleanup.push(() => client.close());
      return client;
    },
    storedHash: (name) => ctx.db.get<{ h: string }>("SELECT pin_hash AS h FROM upstream_tools WHERE connection_id = ? AND name = ?", con.id, name)!.h,
    toolAudits: () =>
      ctx.db
        .all<{ action: string; target: string | null; actor_type: string; detail: string }>(
          "SELECT action, target, actor_type, detail FROM audit_log WHERE action LIKE 'connection.tool%' AND action <> 'connection.tools_pinned' ORDER BY id",
        )
        .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> })),
    connectionEvents: () => ctx.db.all<{ type: string }>("SELECT type FROM events WHERE connection_id = ? ORDER BY seq", con.id).map((r) => r.type),
  };
}

/** Changes the upstream's tool and lists again (as the TTL or list_changed would). */
async function change(s: Setup, tool: FakeTool): Promise<void> {
  s.up.setTool(tool);
  const out = await s.h.ctx.broker.catalog.refresh(s.conId);
  expect(out).toMatchObject({ ok: true, changed: [tool.name] });
  s.h.ctx.broker.invalidate({ connectionId: s.conId });
}

describe("a changed upstream tool keeps working", () => {
  it("description change: listed and callable; no event or ping; one audit entry with both hashes", async () => {
    const s = await setup();
    const a = await s.agent("Hermes", "full");
    const before = s.storedHash("get_page");

    await change(s, getPage({ description: "Read a page by its id." }));
    const after = s.storedHash("get_page");
    expect(after).not.toBe(before);

    // Listed under its name with the new description, and callable.
    const direct = await s.mcp(a.apiKey);
    const listed = (await direct.listTools()).tools.find((t) => t.name === "fake__get_page");
    expect(listed?.description).toContain("Read a page by its id.");
    const r1 = await direct.callTool({ name: "fake__get_page", arguments: { id: "p1" } });
    expect(r1.isError).toBeFalsy();
    expect(text(r1)).toContain("Page p1");

    // Nothing demands action: no connection event (the outbox feeds webhooks and the listener), no held count.
    expect(s.connectionEvents()).toEqual([]);
    expect((await json(await s.api(`/connections/${s.conId}`))).tools).toEqual({ total: 2 });
    // The only trace: one audit entry, old and new hash.
    expect(s.toolAudits()).toEqual([
      {
        action: "connection.tool_changed",
        target: "fake__get_page",
        actor_type: "system",
        detail: { connectionId: s.conId, tool: "get_page", previousHash: before, hash: after, fields: ["description"] },
      },
    ]);
    // It shows in the console's audit log.
    const page = await json(await s.api("/audit"));
    expect(page.items.some((e: { action: string; target: string }) => e.action === "connection.tool_changed" && e.target === "fake__get_page")).toBe(true);
  }, 20_000);

  it("input schema change: the new schema is used for validation, with no event", async () => {
    const s = await setup();
    const a = await s.agent("Hermes", "full");
    const before = s.storedHash("get_page");
    const schema = { type: "object", properties: { id: { type: "string" }, format: { type: "string", enum: ["md", "html"] } }, required: ["id", "format"] };
    await change(
      s,
      getPage({ inputSchema: schema, handler: (args) => ({ content: [{ type: "text", text: `Page ${(args as { id: string }).id} as ${(args as { format: string }).format}` }] }) }),
    );

    const direct = await s.mcp(a.apiKey);
    expect((await direct.listTools()).tools.find((t) => t.name === "fake__get_page")?.inputSchema).toMatchObject({ required: ["id", "format"] });
    expect(text(await direct.callTool({ name: "fake__get_page", arguments: { id: "p1", format: "md" } }))).toContain("Page p1 as md");
    // Validated against the new schema: the old arguments are now incomplete.
    const old = await direct.callTool({ name: "fake__get_page", arguments: { id: "p1" } });
    expect(old.isError).toBe(true);
    expect(text(old)).toMatch(/Invalid arguments/);

    expect(s.connectionEvents()).toEqual([]);
    expect(s.toolAudits()).toEqual([
      expect.objectContaining({ action: "connection.tool_changed", detail: expect.objectContaining({ previousHash: before, hash: s.storedHash("get_page"), fields: ["inputSchema"] }) }),
    ]);
  }, 20_000);

  it("access levels, approvals for risky tools and always-allow rules apply to the changed tool as before", async () => {
    const s = await setup();
    const asker = await s.agent("Asker", "ask");
    const other = await s.agent("Other", "ask");
    const reader = await s.agent("Reader", "read");
    const askMcp = await s.mcp(asker.apiKey);
    const otherMcp = await s.mcp(other.apiKey);
    const readMcp = await s.mcp(reader.apiKey);

    // Before the change: the risky tool asks; the owner approves with "always allow".
    const pending = await askMcp.callTool({ name: "fake__delete_page", arguments: { id: "p1" } });
    expect(text(pending)).toContain("pending_approval");
    const approvalId = /apr_[a-z0-9]+/.exec(text(pending))![0];
    expect(await json(await s.api(`/approvals/${approvalId}/approve`, { method: "POST", json: { alwaysAllow: {} } }))).toMatchObject({ status: "sent" });
    expect(s.deleted).toEqual(["p1"]);

    await change(s, {
      name: "delete_page",
      description: "Delete a page and its history.",
      inputSchema: ID_SCHEMA,
      handler: (args) => {
        s.deleted.push((args as { id: string }).id);
        return { content: [{ type: "text", text: `Deleted ${(args as { id: string }).id}` }] };
      },
    });
    // The rule still applies: runs at once.
    const ruled = await askMcp.callTool({ name: "fake__delete_page", arguments: { id: "p2" } });
    expect(text(ruled)).toContain("Deleted p2");
    expect(s.deleted).toEqual(["p1", "p2"]);
    // Another agent at "ask" without a rule still waits for approval.
    expect(text(await otherMcp.callTool({ name: "fake__delete_page", arguments: { id: "p3" } }))).toContain("pending_approval");
    expect(s.deleted).toEqual(["p1", "p2"]);
    // The read level still lists read tools only.
    expect((await readMcp.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("fake__"))).toEqual(["fake__get_page"]);

    // A schema change that classifies the read tool as risky: the normal risky rules apply (not a hold).
    await change(s, getPage({ description: "Read a page; can also purge it.", annotations: { destructiveHint: true } }));
    const askRead = await askMcp.callTool({ name: "fake__get_page", arguments: { id: "p4" } });
    expect(text(askRead)).toContain("pending_approval");
    s.h.ctx.broker.invalidate("all");
    expect((await (await s.mcp(reader.apiKey)).listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("fake__"))).toEqual([]);

    // No tool-change event at any point; only the approval events of the risky calls.
    expect(s.connectionEvents().filter((t) => t !== "approval.requested")).toEqual([]);
    expect(s.toolAudits().map((e) => [e.action, e.target])).toEqual([
      ["connection.tool_changed", "fake__delete_page"],
      ["connection.tool_changed", "fake__get_page"],
    ]);
  }, 20_000);
});
