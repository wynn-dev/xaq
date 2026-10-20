import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { isMcpToolAction } from "../shared/types.ts";
import { overviewStats } from "../server/api/overview.ts";
import { agentToolMode } from "../server/api/agents.ts";
import { agentSearchSettings, chooseMode, hotToolNames, pinExistingAgentsDirect, SEARCH_MODE_THRESHOLD, setAgentSearchSettings } from "../server/broker/search/mode.ts";
import { SEARCH_AUDIT_ACTION, SEARCH_INSTRUCTIONS } from "../server/broker/search/tools.ts";
import type { BrokerCalls, RegisteredTool, ToolResult } from "../server/broker/types.ts";
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

function enableBroker(ctx: AppContext, on = true) {
  ctx.settings.update({ brokerUpstreams: on });
}

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
 * Stubs the broker's view and BrokerCalls on ctx.broker (the real /mcp seam, registerBrokerTools, stays). Like the real
 * BrokerCalls, `call` audits under the real name; risky tools come back pending_approval at once. The real wiring is
 * exercised end to end in the last test.
 */
function fakeBroker(ctx: AppContext, tools: RegisteredTool[]) {
  const calls: { agentId: string; name: string; args: Record<string, unknown>; signal: AbortSignal }[] = [];
  const slugs = [...new Set(tools.map((t) => t.slug))];
  ctx.broker.view = () =>
    ctx.settings.get().brokerUpstreams
      ? { connections: slugs.map((slug) => ({ connectionId: `con_${slug}`, slug, name: slug, level: "ask" as const })), tools }
      : null;
  const brokerCalls: BrokerCalls = {
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
  it("chooseMode: the query param and the setting win; otherwise above the threshold", () => {
    const base = { query: undefined, preference: "auto" as const, nativeCount: 9 };
    expect(chooseMode({ ...base, brokerCount: SEARCH_MODE_THRESHOLD - 9 })).toBe("direct");
    expect(chooseMode({ ...base, brokerCount: SEARCH_MODE_THRESHOLD - 8 })).toBe("search");
    expect(chooseMode({ ...base, brokerCount: 0, query: "search" })).toBe("search");
    expect(chooseMode({ ...base, brokerCount: 0, preference: "search" })).toBe("search");
    expect(chooseMode({ ...base, brokerCount: 100, preference: "direct" })).toBe("direct");
    expect(chooseMode({ ...base, brokerCount: 100, preference: "direct", query: "search" })).toBe("search");
    expect(chooseMode({ ...base, brokerCount: 0, query: "other" })).toBe("direct");
    expect(hotToolNames(0, [])).toEqual([]);
    expect(hotToolNames(3, [])).toEqual(["get_call_status"]);
    expect(hotToolNames(3, ["a", "b", "c", "d", "e"])).toEqual(["get_call_status", "a", "b", "c", "d"]);
  });

  it("changes nothing while brokerUpstreams is off, even with ?mode=search and 100 broker tools", async () => {
    const { ctx, connect } = setup();
    // The broker is on by default (console PR #65): this case is about the setting being off.
    enableBroker(ctx, false);
    fakeBroker(ctx, registered(100));
    const c = await connect({ mode: "search" });
    expect(await c.names()).toEqual(READER_TOOLS);
    expect(c.client.getInstructions()).toBe(INSTRUCTIONS);
  });

  it("?mode=search turns it on (also over HTTP), with the flow in the instructions", async () => {
    const { ctx, connect, reader } = setup();
    enableBroker(ctx);
    const c = await connect({ mode: "search" });
    expect(await c.names()).toEqual(META);
    expect(c.client.getInstructions()).toBe(`${INSTRUCTIONS}\n\n${SEARCH_INSTRUCTIONS}`);
    expect(SEARCH_INSTRUCTIONS.split("\n")).toHaveLength(3);
    // Without the param: unchanged.
    expect(await (await connect()).names()).toEqual(READER_TOOLS);

    const root = new Hono().route("/", mcpRoutes(ctx));
    const viaHttp = async (path: string) => {
      const transport = new StreamableHTTPClientTransport(new URL(`http://xaq.test${path}`), {
        requestInit: { headers: { Authorization: `Bearer ${reader.apiKey}` } },
        fetch: async (url, init) => root.request(String(url), init as RequestInit),
      });
      const client = new Client({ name: "test", version: "1" });
      await client.connect(transport);
      cleanup.push(() => client.close());
      return (await client.listTools()).tools.map((x) => x.name).sort();
    };
    expect(await viaHttp("/mcp?mode=search")).toEqual(META);
    expect(await viaHttp("/mcp")).toEqual(READER_TOOLS);
  });

  it("follows the per-agent setting, both ways", async () => {
    const { ctx, connect, reader } = setup();
    enableBroker(ctx);
    setAgentSearchSettings(ctx.db, reader.agent.id, { mode: "search" });
    expect(await (await connect()).names()).toEqual(META);
    setAgentSearchSettings(ctx.db, reader.agent.id, { mode: "direct" });
    fakeBroker(ctx, registered(60));
    expect(await (await connect()).names()).toEqual([...READER_TOOLS, "get_call_status", ...registered(60).map((t) => t.exposedName)].sort());
  });

  it("turns on above SEARCH_MODE_THRESHOLD visible tools (native + broker), with get_call_status and the configured hot tools exposed", async () => {
    const { ctx, connect, reader } = setup();
    enableBroker(ctx);
    fakeBroker(ctx, registered(SEARCH_MODE_THRESHOLD - READER_TOOLS.length));
    expect(await (await connect()).names()).toHaveLength(SEARCH_MODE_THRESHOLD + 1); // + get_call_status

    fakeBroker(ctx, registered(SEARCH_MODE_THRESHOLD - READER_TOOLS.length + 1));
    const c = await connect();
    expect(await c.names()).toEqual([...META, "get_call_status"].sort());

    setAgentSearchSettings(ctx.db, reader.agent.id, { hot: ["list_accounts", "notion__search"] });
    expect(await (await connect()).names()).toEqual([...META, "get_call_status", "list_accounts", "notion__search"].sort());
  });
});

describe("search mode: the meta-tools", () => {
  it("search_tools returns the top 5 (max 10) native and broker tools with full schemas and read/risky flags", async () => {
    const { ctx, connect, reader } = setup();
    enableBroker(ctx);
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
    setAgentSearchSettings(ctx.db, reader.agent.id, { mode: "direct" });
    const direct = await connect();
    const listed = (await direct.client.listTools()).tools.find((t) => t.name === "get_message")!;
    expect(getMessage.inputSchema).toEqual(listed.inputSchema);
  });

  it("refuses a read tool through call_write_tool and a write tool through call_read_tool", async () => {
    const { ctx, connect, auditRows } = setup();
    enableBroker(ctx);
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

  it("runs broker tools through BrokerCalls under the real name: a risky call still waits for approval", async () => {
    const { ctx, connect, reader } = setup();
    enableBroker(ctx);
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
    enableBroker(ctx);
    const strip = (rows: ReturnType<typeof auditRows>) => rows.map(({ id: _i, ts: _t, durationMs: _d, ...rest }) => rest);

    const direct = await connect();
    const d1 = await direct.call("get_message", { message_id: "m1" });
    const d2 = await direct.call("get_message", {});
    const d3 = await direct.call("get_message", { message_id: "missing" });
    const directAudit = strip(auditRows());

    const search = await connect({ mode: "search" });
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
    enableBroker(ctx);
    const f = fakeBroker(ctx, registered(100));
    const strip = (rows: ReturnType<typeof auditRows>) => rows.map(({ id: _i, ts: _t, durationMs: _d, ...rest }) => rest);
    // send_message: no send grant; github__nope: no such connection tool; get_mesage: a typo.
    const names = ["search_threads", "get_message", "send_message", "github__nope", "get_mesage"] as const;
    const args: Record<string, Record<string, unknown>> = { search_threads: { query: "" }, get_message: { message_id: "m1" } };

    setAgentSearchSettings(ctx.db, reader.agent.id, { mode: "direct" });
    const direct = await connect();
    const d = [];
    for (const n of names) d.push(await outcome(direct, n, args[n]));
    const directAudit = strip(auditRows());

    setAgentSearchSettings(ctx.db, reader.agent.id, { mode: "search" });
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

  it("runs a broker tool called by name through BrokerCalls: a risky one is still pending approval", async () => {
    const { ctx, connect, reader } = setup();
    enableBroker(ctx);
    const f = fakeBroker(ctx, registered(100));
    setAgentSearchSettings(ctx.db, reader.agent.id, { mode: "search" });
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

describe("search mode: agents keep their mode", () => {
  /** /mcp over HTTP as the agent: the real route, which records an `auto` agent's first mode. */
  const viaHttp = async (ctx: AppContext, apiKey: string) => {
    const root = new Hono().route("/", mcpRoutes(ctx));
    const transport = new StreamableHTTPClientTransport(new URL("http://xaq.test/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
      fetch: async (url, init) => root.request(String(url), init as RequestInit),
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    cleanup.push(() => client.close());
    return {
      names: async () => (await client.listTools()).tools.map((x) => x.name).sort(),
      call: async (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }),
    };
  };

  it("upgrade: agents from before search mode are pinned to direct once; new agents follow auto; explicit settings stay", async () => {
    const { ctx, reader, addAgent } = setup();
    enableBroker(ctx);
    // Hermes before the upgrade: no setting, 9 native + 40 broker tools, over the threshold.
    fakeBroker(ctx, registered(40));
    const explicit = addAgent("explicit", [grantInput("acc_a", { capabilities: ["read"] })]);
    setAgentSearchSettings(ctx.db, explicit.agent.id, { mode: "search" });
    // The marker is unset, as on an install upgrading to this release.
    expect(ctx.settings.getState("broker.searchDirectPinned")).toBeNull();

    expect(pinExistingAgentsDirect(ctx.db, ctx.settings)).toBe(1);
    expect(agentSearchSettings(ctx.db, reader.agent.id).mode).toBe("direct");
    expect(agentSearchSettings(ctx.db, explicit.agent.id).mode).toBe("search");
    const before = ctx.db.all("SELECT key, value FROM settings WHERE key LIKE 'broker.search:%' ORDER BY key");

    const hermes = await viaHttp(ctx, reader.apiKey);
    const listed = await hermes.names();
    expect(listed).toContain("search_threads");
    expect(listed).toHaveLength(READER_TOOLS.length + 40 + 1);
    const r = await hermes.call("search_threads", { query: "" });
    expect(r.isError).toBeFalsy();
    expect((r.content as { text: string }[])[0]!.text).toContain("Hi");
    expect(await (await viaHttp(ctx, explicit.apiKey)).names()).toEqual([...META, "get_call_status"].sort());

    // Running the step again (every later start) changes nothing.
    expect(pinExistingAgentsDirect(ctx.db, ctx.settings)).toBe(0);
    expect(ctx.db.all("SELECT key, value FROM settings WHERE key LIKE 'broker.search:%' ORDER BY key")).toEqual(before);

    // An agent created after the upgrade: auto, so above the threshold it starts in search mode (and keeps it).
    const fresh = addAgent("fresh", [grantInput("acc_a", { capabilities: ["read"] })]);
    expect(agentSearchSettings(ctx.db, fresh.agent.id).mode).toBe("auto");
    expect(await (await viaHttp(ctx, fresh.apiKey)).names()).toEqual([...META, "get_call_status"].sort());
    expect(agentSearchSettings(ctx.db, fresh.agent.id).mode).toBe("search");
  });

  it("the broker's start runs the step; a new install pins nobody", async () => {
    const upgraded = setup();
    await upgraded.ctx.broker.start?.();
    expect(agentSearchSettings(upgraded.ctx.db, upgraded.reader.agent.id).mode).toBe("direct");

    const t = mailTestContext();
    cleanup.push(t.dispose);
    await t.ctx.broker.start?.();
    expect(t.ctx.settings.getState("broker.searchDirectPinned")).not.toBeNull();
    const later = t.addAgent("later", []);
    expect(t.ctx.db.get("SELECT value FROM settings WHERE key = ?", `broker.search:${later.agent.id}`)).toBeUndefined();
  });

  it("auto is decided on the first /mcp request: a direct agent that later crosses the threshold stays direct", async () => {
    const { ctx, reader } = setup();
    enableBroker(ctx);
    fakeBroker(ctx, registered(5));
    // Console probes (the agent page, Test connection) don't decide it.
    expect(agentToolMode(ctx, reader.agent.id)).toEqual({ setting: "auto", mode: "direct", tools: READER_TOOLS.length + 5, threshold: SEARCH_MODE_THRESHOLD });
    expect(agentSearchSettings(ctx.db, reader.agent.id).mode).toBe("auto");

    expect(await (await viaHttp(ctx, reader.apiKey)).names()).toContain("search_threads");
    expect(agentSearchSettings(ctx.db, reader.agent.id).mode).toBe("direct");

    // A big connection later: still every tool, and the agent page has what it needs for its hint.
    fakeBroker(ctx, registered(80));
    const names = await (await viaHttp(ctx, reader.apiKey)).names();
    expect(names).toHaveLength(READER_TOOLS.length + 80 + 1);
    expect(agentToolMode(ctx, reader.agent.id)).toEqual({ setting: "direct", mode: "direct", tools: READER_TOOLS.length + 80, threshold: SEARCH_MODE_THRESHOLD });

    // Search mode only when the user turns it on.
    setAgentSearchSettings(ctx.db, reader.agent.id, { mode: "search" });
    expect(await (await viaHttp(ctx, reader.apiKey)).names()).toEqual([...META, "get_call_status"].sort());
  });
});

describe("search mode: audit", () => {
  it("audits the query's length only, and counts inner calls (not the meta-tools) as tool calls", async () => {
    const { ctx, connect, auditRows } = setup();
    enableBroker(ctx);
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
