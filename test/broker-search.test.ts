import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { isMcpToolAction } from "../shared/types.ts";
import { overviewStats } from "../server/api/overview.ts";
import { chooseMode, SEARCH_MODE_THRESHOLD } from "../server/broker/search/mode.ts";
import { SEARCH_AUDIT_ACTION, SEARCH_INSTRUCTIONS } from "../server/broker/search/tools.ts";
import type { BrokerService } from "../server/broker/service.ts";
import type { RegisteredTool, ToolResult } from "../server/broker/types.ts";
import type { AppContext } from "../server/context.ts";
import { mcpRoutes } from "../server/mcp/index.ts";
import { type BuildOptions, buildMcpServer, INSTRUCTIONS } from "../server/mcp/server.ts";
import { CATALOG } from "./broker-search-catalog.ts";
import { grantInput, mailTestContext } from "./mail-fakes.ts";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

const META = ["call_read_tool", "call_write_tool", "search_tools"];
// What a read-only agent gets on main (9 tools).
const READER_TOOLS = ["ack_events", "get_attachment", "get_message", "get_thread", "list_accounts", "list_attachments", "list_events", "list_labels", "search_threads", "wait_for_events"];

/** Broker tools from the eval catalog as the registry would serve them. */
function registered(n: number): RegisteredTool[] {
  return CATALOG.slice(0, n).map((t) => {
    const [slug, name] = t.name.split("__") as [string, string];
    return {
      exposedName: t.name,
      connectionId: `con_${slug}`,
      slug,
      def: { name, description: t.description, inputSchema: t.inputSchema },
      cls: { risky: t.risky, read: t.read, source: "heuristic" },
      level: "ask",
      pinHash: "h",
    };
  });
}

/**
 * Stubs the broker's view and calls on ctx.broker (the real /mcp seam, registerBrokerTools, stays). Like the real
 * calls, `call` audits under the real name; risky tools come back pending_approval at once. The real wiring is
 * exercised end to end in the last test.
 */
function fakeBroker(ctx: AppContext, tools: RegisteredTool[]) {
  const calls: { agentId: string; name: string; args: Record<string, unknown>; signal: AbortSignal }[] = [];
  const slugs = [...new Set(tools.map((t) => t.slug))];
  ctx.broker.view = () => ({ connections: slugs.map((slug) => ({ connectionId: `con_${slug}`, slug, name: slug, level: "ask" as const })), tools });
  const brokerCalls: BrokerService["calls"] = {
    async call(agentId, name, args, signal): Promise<ToolResult> {
      calls.push({ agentId, name, args, signal });
      const tool = tools.find((t) => t.exposedName === name)!;
      if (tool.cls.risky) {
        ctx.audit.record({ actorType: "agent", actorId: agentId, action: name, outcome: "ok", reason: "pending_approval" });
        return { content: [{ type: "text", text: JSON.stringify({ status: "pending_approval", approval_id: "apr_1" }) }] };
      }
      ctx.audit.record({ actorType: "agent", actorId: agentId, action: name, outcome: "ok" });
      return { content: [{ type: "text", text: `ran ${name}` }] };
    },
  };
  ctx.broker.calls = brokerCalls;
  return { calls };
}

function setup() {
  const t = mailTestContext();
  cleanup.push(t.dispose);
  const gmail = t.addAccount("acc_a", "me@acme.com");
  gmail.add({
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX"],
    from: { name: null, email: "alice@client.com" },
    to: [{ name: null, email: "me@acme.com" }],
    subject: "Hi",
    text: "Hello",
  });
  const reader = t.addAgent("reader", [grantInput("acc_a", { capabilities: ["read"] })]);
  const connect = async (opts: BuildOptions = {}, agentId = reader.agent.id) => {
    const server = buildMcpServer(t.ctx, { agentId, name: "reader" }, opts);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    cleanup.push(() => client.close());
    const names = async () => (await client.listTools()).tools.map((x) => x.name).sort();
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { isError: !!r.isError, content: r.content as { type: string; text: string }[], text: (r.content as { text: string }[]).map((c) => c.text).join("\n") };
    };
    return { client, names, call };
  };
  const auditRows = () => t.ctx.audit.list({ agentId: reader.agent.id }).items.filter((e) => e.actorType === "agent").reverse();
  return { ...t, reader, connect, auditRows };
}

describe("search mode: when it applies", () => {
  it("chooseMode: above the threshold", () => {
    expect(chooseMode(9, SEARCH_MODE_THRESHOLD - 9)).toBe("direct");
    expect(chooseMode(9, SEARCH_MODE_THRESHOLD - 8)).toBe("search");
  });

  it("turns on above SEARCH_MODE_THRESHOLD visible tools (native + broker), with get_call_status exposed and the flow in the instructions", async () => {
    const { ctx, connect, reader } = setup();
    fakeBroker(ctx, registered(SEARCH_MODE_THRESHOLD - READER_TOOLS.length));
    const direct = await connect();
    expect(await direct.names()).toHaveLength(SEARCH_MODE_THRESHOLD + 1); // + get_call_status
    expect(direct.client.getInstructions()).not.toContain(SEARCH_INSTRUCTIONS);

    fakeBroker(ctx, registered(SEARCH_MODE_THRESHOLD - READER_TOOLS.length + 1));
    const c = await connect();
    expect(await c.names()).toEqual([...META, "get_call_status"].sort());
    expect(c.client.getInstructions()!.endsWith(`\n\n${SEARCH_INSTRUCTIONS}`)).toBe(true);
    expect(SEARCH_INSTRUCTIONS.split("\n")).toHaveLength(3);

    // The same over HTTP.
    const root = new Hono().route("/", mcpRoutes(ctx));
    const transport = new StreamableHTTPClientTransport(new URL("http://xaq.test/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${reader.apiKey}` } },
      fetch: async (url, init) => root.request(String(url), init as RequestInit),
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    cleanup.push(() => client.close());
    expect((await client.listTools()).tools.map((x) => x.name).sort()).toEqual([...META, "get_call_status"].sort());
  });
});

describe("search mode: the meta-tools", () => {
  it("search_tools returns the top 5 (max 10) native and broker tools with full schemas and read/risky flags", async () => {
    const { ctx, connect, reader } = setup();
    fakeBroker(ctx, registered(100));
    const c = await connect();
    const found = (r: { text: string }) => (JSON.parse(r.text) as { tools: { name: string; kind: string; risky: boolean; inputSchema: Record<string, unknown> }[] }).tools;

    const refund = found(await c.call("search_tools", { query: "refund the customer's payment" }));
    expect(refund).toHaveLength(5);
    expect(refund[0]).toMatchObject({ name: "stripe__create_refund", kind: "write", risky: true, call_with: "call_write_tool" });
    expect(refund[0]!.inputSchema).toEqual(CATALOG.find((t) => t.name === "stripe__create_refund")!.inputSchema);
    expect(found(await c.call("search_tools", { query: "list", limit: 10 }))).toHaveLength(10);
    expect((await c.call("search_tools", { query: "list", limit: 11 })).isError).toBe(true);

    // Native tools are searchable too, with the schema a direct tools/list shows.
    const mail = found(await c.call("search_tools", { query: "read the email message", limit: 10 }));
    const getMessage = mail.find((t) => t.name === "get_message")!;
    expect(getMessage).toMatchObject({ kind: "read", risky: false });
    fakeBroker(ctx, []);
    const direct = await connect();
    const listed = (await direct.client.listTools()).tools.find((t) => t.name === "get_message")!;
    expect(getMessage.inputSchema).toEqual(listed.inputSchema);
  });

  it("refuses a read tool through call_write_tool and a write tool through call_read_tool", async () => {
    const { ctx, connect, auditRows } = setup();
    const f = fakeBroker(ctx, registered(100));
    const c = await connect();

    const a = await c.call("call_write_tool", { name: "notion__search", arguments: { query: "x" } });
    expect(a).toMatchObject({ isError: true, text: "notion__search is a read tool: run it with call_read_tool." });
    const b = await c.call("call_read_tool", { name: "notion__archive_page", arguments: { page_id: "p" } });
    expect(b.isError).toBe(true);
    expect(b.text).toMatch(/run it with call_write_tool/);
    const n = await c.call("call_read_tool", { name: "ack_events", arguments: { seq: 1 } });
    expect(n.isError).toBe(true);
    expect(f.calls).toEqual([]);
    expect(auditRows().map((r) => [r.action, r.outcome, r.reason])).toEqual([
      ["notion__search", "denied", "wrong_call_tool"],
      ["notion__archive_page", "denied", "wrong_call_tool"],
      ["ack_events", "denied", "wrong_call_tool"],
    ]);
  });

  it("runs broker tools through the broker's calls under the real name: a risky call still waits for approval", async () => {
    const { ctx, connect, reader } = setup();
    const f = fakeBroker(ctx, registered(100));
    const c = await connect();

    const args = { channel_id: "C1", text: "Ship it" };
    const r = await c.call("call_write_tool", { name: "slack__post_message", arguments: args });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ status: "pending_approval", approval_id: "apr_1" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ agentId: reader.agent.id, name: "slack__post_message", args });

    const read = await c.call("call_read_tool", { name: "notion__search", arguments: { query: "roadmap" } });
    expect(read.text).toBe("ran notion__search");
    expect(f.calls.map((x) => x.name)).toEqual(["slack__post_message", "notion__search"]);

    const unknown = await c.call("call_read_tool", { name: "nope__tool" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/No tool named "nope__tool"/);
  });

  it("runs native tools exactly like a direct call: same result, same audit", async () => {
    const { ctx, connect, auditRows } = setup();
    const strip = (rows: ReturnType<typeof auditRows>) => rows.map(({ id: _i, ts: _t, durationMs: _d, ...rest }) => rest);

    const direct = await connect();
    const d1 = await direct.call("get_message", { message_id: "m1" });
    const d2 = await direct.call("get_message", {});
    const d3 = await direct.call("get_message", { message_id: "missing" });
    const directAudit = strip(auditRows());

    fakeBroker(ctx, registered(100));
    const search = await connect();
    const s1 = await search.call("call_read_tool", { name: "get_message", arguments: { message_id: "m1" } });
    const s2 = await search.call("call_read_tool", { name: "get_message", arguments: {} });
    const s3 = await search.call("call_read_tool", { name: "get_message", arguments: { message_id: "missing" } });
    const searchAudit = strip(auditRows()).slice(directAudit.length);

    expect(s1).toEqual(d1);
    expect(s3).toEqual(d3);
    expect(d2.isError && s2.isError).toBe(true);
    expect(searchAudit).toEqual(directAudit);
    expect(directAudit.map((r) => [r.action, r.outcome, r.reason])).toEqual([
      ["get_message", "ok", null],
      ["get_message", "error", "invalid_arguments"],
      ["get_message", "error", "not_found"],
    ]);
  });
});

describe("search mode: calling a tool by name", () => {
  /** A tools/call answer as text: a protocol error (e.g. -32602) by its message. */
  const outcome = async (c: Awaited<ReturnType<ReturnType<typeof setup>["connect"]>>, name: string, args: Record<string, unknown> = {}) =>
    c.call(name, args).then(
      (r) => `${r.isError ? "error" : "ok"}: ${r.text}`,
      (err: Error) => `throws: ${err.message}`,
    );

  it("runs an unlisted tool called by name exactly like direct mode; unknown and ungranted names fail the same way", async () => {
    const { ctx, connect, reader, auditRows } = setup();
    const strip = (rows: ReturnType<typeof auditRows>) => rows.map(({ id: _i, ts: _t, durationMs: _d, ...rest }) => rest);
    // send_message: no send grant; github__nope: no such connection tool; get_mesage: a typo.
    const names = ["search_threads", "get_message", "send_message", "github__nope", "get_mesage"] as const;
    const args: Record<string, Record<string, unknown>> = { search_threads: { query: "" }, get_message: { message_id: "m1" } };

    fakeBroker(ctx, []);
    const direct = await connect();
    const d = [];
    for (const n of names) d.push(await outcome(direct, n, args[n]));
    const directAudit = strip(auditRows());

    const f = fakeBroker(ctx, registered(100));
    const search = await connect();
    expect(await search.names()).toEqual([...META, "get_call_status"].sort());
    const s = [];
    for (const n of names) s.push(await outcome(search, n, args[n]));

    expect(s).toEqual(d);
    expect(s[0]).toMatch(/^ok: .*Hi/s);
    expect(s[1]).toMatch(/^ok: /);
    for (const r of s.slice(2)) expect(r).toMatch(/^error: MCP error -32602: Tool \S+ not found/);
    expect(s[0]).not.toContain("-32602");
    expect(strip(auditRows()).slice(directAudit.length)).toEqual(directAudit);
    expect(f.calls).toEqual([]);
  });

  it("runs a broker tool called by name through the broker's calls: a risky one is still pending approval", async () => {
    const { ctx, connect, reader } = setup();
    const f = fakeBroker(ctx, registered(100));
    const c = await connect();
    expect(await c.names()).not.toContain("slack__post_message");

    const r = await c.call("slack__post_message", { channel_id: "C1", text: "Ship it" });
    expect(JSON.parse(r.text)).toEqual({ status: "pending_approval", approval_id: "apr_1" });
    expect((await c.call("notion__search", { query: "roadmap" })).text).toBe("ran notion__search");
    expect(f.calls.map((x) => [x.agentId, x.name])).toEqual([
      [reader.agent.id, "slack__post_message"],
      [reader.agent.id, "notion__search"],
    ]);
  });
});

describe("search mode: audit", () => {
  it("audits the query's length only, and counts inner calls (not the meta-tools) as tool calls", async () => {
    const { ctx, connect, auditRows } = setup();
    fakeBroker(ctx, registered(100));
    const c = await connect();
    const query = "secret plans for the merger";
    await c.call("search_tools", { query });
    await c.call("call_read_tool", { name: "list_accounts" });
    await c.call("call_write_tool", { name: "slack__post_message", arguments: { channel_id: "C", text: "hi" } });
    await c.call("search_tools", { query: "x", limit: 50 }); // refused by the SDK

    const rows = auditRows();
    expect(rows.map((r) => [r.action, r.outcome])).toEqual([
      [SEARCH_AUDIT_ACTION, "ok"],
      ["list_accounts", "ok"],
      ["slack__post_message", "ok"],
      [SEARCH_AUDIT_ACTION, "error"],
    ]);
    expect(rows[0]!.detail).toEqual({ queryLength: query.length, results: expect.any(Number) });
    expect(JSON.stringify(ctx.db.all("SELECT * FROM audit_log"))).not.toContain("merger");
    expect(rows.filter((r) => isMcpToolAction(r.action)).map((r) => r.action)).toEqual(["list_accounts", "slack__post_message"]);
    expect(overviewStats(ctx).toolCalls24h).toBe(2);
  });
});
