// A changed upstream tool just keeps working (the owner removed the tool-change hold on 2026-10-16), through the
// real broker wiring and a fake upstream: a description or schema change is used at once under the same name, in
// direct and search mode; nothing goes on hold, no event, webhook or listener ping is sent, and the only trace is one
// audit entry with the old and new definition hash. Access levels apply to the changed tool as before. A tool an
// older version left on hold is usable after the upgrade.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { pinHash } from "../server/broker/catalog/index.ts";
import { setAgentSearchSettings } from "../server/broker/search/mode.ts";
import type { ToolDef } from "../server/broker/types.ts";
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
  agent(name: string, level: "full" | "read"): Promise<{ id: string; apiKey: string }>;
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
  ctx.settings.update({ brokerUpstreams: true });

  const con = await json(await api("/connections", { method: "POST", json: { url: up.url, slug: "fake", name: "Fake", agentIds: [], levelDefault: "full" } }));
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
  it("description change: listed and callable in direct and search mode; no event or ping; one audit entry with both hashes", async () => {
    const s = await setup();
    const { ctx } = s.h;
    const a = await s.agent("Hermes", "full");
    const before = s.storedHash("get_page");

    await change(s, getPage({ description: "Read a page by its id." }));
    const after = s.storedHash("get_page");
    expect(after).not.toBe(before);

    // Direct mode: listed under its name with the new description, and callable.
    setAgentSearchSettings(ctx.db, a.id, { mode: "direct" });
    const direct = await s.mcp(a.apiKey);
    const listed = (await direct.listTools()).tools.find((t) => t.name === "fake__get_page");
    expect(listed?.description).toContain("Read a page by its id.");
    const r1 = await direct.callTool({ name: "fake__get_page", arguments: { id: "p1" } });
    expect(r1.isError).toBeFalsy();
    expect(text(r1)).toContain("Page p1");

    // Search mode: found with the new definition and callable through call_read_tool.
    setAgentSearchSettings(ctx.db, a.id, { mode: "search" });
    const search = await s.mcp(a.apiKey);
    expect((await search.listTools()).tools.map((t) => t.name)).toContain("search_tools");
    const found = JSON.parse(text(await search.callTool({ name: "search_tools", arguments: { query: "read a page by id" } }))) as { tools: { name: string; description: string }[] };
    expect(found.tools.find((t) => t.name === "fake__get_page")?.description).toContain("Read a page by its id.");
    const r2 = await search.callTool({ name: "call_read_tool", arguments: { name: "fake__get_page", arguments: { id: "p2" } } });
    expect(text(r2)).toContain("Page p2");

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

  it("input schema change: the new schema is used for validation, in direct and search mode, with no event", async () => {
    const s = await setup();
    const { ctx } = s.h;
    const a = await s.agent("Hermes", "full");
    const before = s.storedHash("get_page");
    const schema = { type: "object", properties: { id: { type: "string" }, format: { type: "string", enum: ["md", "html"] } }, required: ["id", "format"] };
    await change(
      s,
      getPage({ inputSchema: schema, handler: (args) => ({ content: [{ type: "text", text: `Page ${(args as { id: string }).id} as ${(args as { format: string }).format}` }] }) }),
    );

    setAgentSearchSettings(ctx.db, a.id, { mode: "direct" });
    const direct = await s.mcp(a.apiKey);
    expect((await direct.listTools()).tools.find((t) => t.name === "fake__get_page")?.inputSchema).toMatchObject({ required: ["id", "format"] });
    expect(text(await direct.callTool({ name: "fake__get_page", arguments: { id: "p1", format: "md" } }))).toContain("Page p1 as md");
    // Validated against the new schema: the old arguments are now incomplete.
    const old = await direct.callTool({ name: "fake__get_page", arguments: { id: "p1" } });
    expect(old.isError).toBe(true);
    expect(text(old)).toMatch(/Invalid arguments/);

    setAgentSearchSettings(ctx.db, a.id, { mode: "search" });
    const search = await s.mcp(a.apiKey);
    expect(text(await search.callTool({ name: "call_read_tool", arguments: { name: "fake__get_page", arguments: { id: "p2", format: "html" } } }))).toContain("Page p2 as html");

    expect(s.connectionEvents()).toEqual([]);
    expect(s.toolAudits()).toEqual([
      expect.objectContaining({ action: "connection.tool_changed", detail: expect.objectContaining({ previousHash: before, hash: s.storedHash("get_page"), fields: ["inputSchema"] }) }),
    ]);
  }, 20_000);

  it("access levels apply to the changed tool as before", async () => {
    const s = await setup();
    const writer = await s.agent("Writer", "full");
    const reader = await s.agent("Reader", "read");
    const writeMcp = await s.mcp(writer.apiKey);
    const readMcp = await s.mcp(reader.apiKey);

    expect(text(await writeMcp.callTool({ name: "fake__delete_page", arguments: { id: "p1" } }))).toContain("Deleted p1");

    await change(s, {
      name: "delete_page",
      description: "Delete a page and its history.",
      inputSchema: ID_SCHEMA,
      handler: (args) => {
        s.deleted.push((args as { id: string }).id);
        return { content: [{ type: "text", text: `Deleted ${(args as { id: string }).id}` }] };
      },
    });
    // Full access still runs it at once.
    expect(text(await writeMcp.callTool({ name: "fake__delete_page", arguments: { id: "p2" } }))).toContain("Deleted p2");
    expect(s.deleted).toEqual(["p1", "p2"]);
    // The read level still lists read tools only.
    expect((await readMcp.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("fake__"))).toEqual(["fake__get_page"]);

    // A schema change that classifies the read tool as risky: it leaves the read level (not a hold).
    await change(s, getPage({ description: "Read a page; can also purge it.", annotations: { destructiveHint: true } }));
    s.h.ctx.broker.invalidate("all");
    expect((await (await s.mcp(reader.apiKey)).listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("fake__"))).toEqual([]);

    // No tool-change event at any point.
    expect(s.connectionEvents()).toEqual([]);
    expect(s.toolAudits().map((e) => [e.action, e.target])).toEqual([
      ["connection.tool_changed", "fake__delete_page"],
      ["connection.tool_changed", "fake__get_page"],
    ]);
  }, 20_000);

  it("a tool held by an older version works after the upgrade (released at startup, audited)", async () => {
    const s = await setup();
    const { ctx } = s.h;
    const a = await s.agent("Hermes", "full");
    // The rows as the older version left them: get_page held as changed (the waiting definition is the new one),
    // delete_page held as new (nothing stored in use).
    const before = s.storedHash("get_page");
    const candidate: ToolDef = { name: "get_page", description: "Read a page by its id.", inputSchema: ID_SCHEMA, annotations: { readOnlyHint: true } };
    const { name: _n, ...stored } = candidate;
    ctx.db.run(
      "UPDATE upstream_tools SET state = 'held', held_reason = 'changed', candidate_definition = ?, candidate_hash = ? WHERE connection_id = ? AND name = 'get_page'",
      JSON.stringify(stored),
      pinHash(candidate),
      s.conId,
    );
    ctx.db.run(
      "UPDATE upstream_tools SET state = 'held', held_reason = 'new', candidate_definition = definition, candidate_hash = pin_hash, definition = NULL, pin_hash = NULL WHERE connection_id = ? AND name = 'delete_page'",
      s.conId,
    );
    // The upstream serves the definition that was waiting (that's why it was held).
    s.up.setTool(getPage({ description: "Read a page by its id." }));
    ctx.broker.invalidate("all");
    expect(ctx.broker.view(a.id)!.tools.map((t) => t.exposedName)).toEqual(["fake__get_page"]);

    // Startup releases them (and the listing it starts finds nothing more to change).
    await ctx.broker.start?.();
    expect(ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM upstream_tools WHERE state = 'held'")!.n).toBe(0);
    setAgentSearchSettings(ctx.db, a.id, { mode: "direct" });
    const client = await s.mcp(a.apiKey);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["fake__get_page", "fake__delete_page"]));
    expect(text(await client.callTool({ name: "fake__get_page", arguments: { id: "p1" } }))).toContain("Page p1");
    expect(text(await client.callTool({ name: "fake__delete_page", arguments: { id: "p2" } }))).toContain("Deleted p2");
    expect(s.storedHash("get_page")).toBe(pinHash(candidate));
    const audits = s.toolAudits().filter((e) => e.detail.releasedHold === true);
    expect(audits.map((e) => [e.target, e.detail.previousHash])).toEqual([
      ["fake__delete_page", null],
      ["fake__get_page", before],
    ]);
    expect(s.connectionEvents()).toEqual([]);
  }, 20_000);
});
