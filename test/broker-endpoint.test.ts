// M1 PR 7 (docs/MCP-BROKER.md): upstream tools on /mcp next to the unchanged native ones, get_call_status,
// the instructions, connection events (visibility, the listener stream without Gmail, webhook filters), the
// broker service (hooks, poll, kill switch) and mcp.call approvals. The registry, calls and policy are fakes
// standing in for the catalog and policy workstreams.

import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { agentApi } from "../server/agentapi/index.ts";
import { createApp } from "../server/app.ts";
import { type BrokerParts, createBrokerService } from "../server/broker/service.ts";
import type { AccessLevel, IntegrationPreset, RegisteredTool, ToolClass, ToolDef, ToolResult } from "../server/broker/types.ts";
import type { AppContext } from "../server/context.ts";
import { exposedName } from "../server/broker/catalog/index.ts";
import { loopbackUrl } from "../server/urls.ts";
import { upstreams } from "../server/broker/upstream/runtime.ts";
import { Approvals } from "../server/mail/approvals.ts";
import { buildMcpServer, INSTRUCTIONS, rejectedCall } from "../server/mcp/server.ts";
import { type RunningServer, startServer } from "../server/server.ts";
import { parseTypes } from "../server/listen/options.ts";
import { matchesFilter, webhookInputSchema } from "../server/webhooks/filter.ts";
import type { StoredEvent } from "../server/events/types.ts";
import { testConfig, testContext } from "./helpers.ts";
import { addAccount, readGrant, SseReader } from "./listen-server-helpers.ts";
import { CSRF, fakeGoogle, fakeIngest, harness, json } from "./platform-helpers.ts";

// ───────────── Fakes for the catalog and policy workstreams ─────────────

interface FakeTool {
  def: ToolDef;
  cls: ToolClass;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });

const CATALOG: Record<string, FakeTool[]> = {
  notion: [
    { def: { name: "notion-search", description: "Search the workspace.", inputSchema: obj({ query: { type: "string", minLength: 1 } }, ["query"]), annotations: { readOnlyHint: true } }, cls: { risky: false, read: true, source: "preset" } },
    { def: { name: "notion-update-page", title: "Update page", description: "Edit a page.", inputSchema: obj({ page_id: { type: "string" }, markdown: { type: "string" } }, ["page_id"]) }, cls: { risky: false, read: false, source: "preset" } },
    {
      def: { name: "notion-delete-pages", description: "Delete pages.", inputSchema: obj({ page_ids: { type: "array", items: { type: "string" }, maxItems: 20 } }, ["page_ids"]), annotations: { readOnlyHint: true } },
      cls: { risky: true, read: false, source: "preset", targetPath: "/page_ids" },
    },
  ],
  t3: [
    { def: { name: "list_threads", description: "List threads.", inputSchema: obj({}) }, cls: { risky: false, read: true, source: "heuristic" } },
    { def: { name: "send_message", description: "Send a message.", inputSchema: obj({ text: { type: "string" } }) }, cls: { risky: true, read: false, source: "heuristic" } },
  ],
};

interface Recorder {
  calls: { agentId: string; name: string; args: Record<string, unknown> }[];
  throwOn: Set<string>;
}

function fakeParts(ctx: () => AppContext, rec: Recorder, extra: Partial<BrokerParts> = {}): Partial<BrokerParts> {
  const forAgent = (agentId: string): RegisteredTool[] =>
    ctx()
      .db.all<{ connection_id: string; slug: string; level: AccessLevel }>(
        "SELECT g.connection_id, c.slug, g.level FROM connection_grants g JOIN connections c ON c.id = g.connection_id WHERE g.agent_id = ? ORDER BY c.slug",
        agentId,
      )
      .flatMap((g) =>
        (CATALOG[g.slug] ?? [])
          .filter((t) => g.level !== "read" || t.cls.read)
          .map((t) => ({ exposedName: `${g.slug}__${t.def.name}`, connectionId: g.connection_id, slug: g.slug, def: t.def, cls: t.cls, level: g.level, pinHash: `pin-${t.def.name}` })),
      );
  return {
    registry: { forAgent, resolve: (agentId, name) => forAgent(agentId).find((t) => t.exposedName === name) ?? null },
    calls: {
      async call(agentId, name, args) {
        if (rec.throwOn.has(name)) throw new Error("boom");
        rec.calls.push({ agentId, name, args });
        ctx().audit.record({ actorType: "agent", actorId: agentId, action: name, outcome: "ok" });
        return { content: [{ type: "text", text: `ran ${name}` }] };
      },
    },
    callStatus: (agentId, approvalId) => ({ content: [{ type: "text", text: `status of ${approvalId} for ${agentId}: pending` }] }),
    ...extra,
  };
}

function seedConnection(ctx: AppContext, c: { id: string; slug: string; name: string; preset?: string; kind?: string; url?: string | null }, grants: Record<string, AccessLevel>) {
  const t = new Date().toISOString();
  ctx.db.run(
    "INSERT INTO connections (id, kind, preset, slug, name, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    c.id,
    c.kind ?? "remote_http",
    c.preset ?? null,
    c.slug,
    c.name,
    c.url === undefined ? `https://${c.slug}.example.com/mcp` : c.url,
    t,
    t,
  );
  for (const [agentId, level] of Object.entries(grants)) {
    ctx.db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", agentId, c.id, level, t, t);
  }
}

function setup(extra: Partial<BrokerParts> = {}) {
  const rec: Recorder = { calls: [], throwOn: new Set() };
  let ctxRef: AppContext;
  const t = testContext({ broker: (ctx) => createBrokerService(ctx, fakeParts(() => ctxRef, rec, extra)) });
  ctxRef = t.ctx;
  return { ...t, rec };
}

async function connectMcp(ctx: AppContext, agentId: string) {
  const server = buildMcpServer(ctx, { agentId, name: "agent" });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { client, close: async () => (await client.close(), await server.close()) };
}

const text = (r: unknown) => (r as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join("\n");
const audits = (ctx: AppContext, agentId: string) =>
  ctx.db.all<{ action: string; outcome: string; reason: string | null }>("SELECT action, outcome, reason FROM audit_log WHERE actor_id = ? ORDER BY id", agentId);

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers.splice(0).reverse()) await d();
});

// ───────────── /mcp ─────────────

describe("/mcp aggregation", () => {
  it("lists upstream tools and get_call_status next to the native tools", async () => {
    const t = setup();
    disposers.push(t.dispose);
    const { ctx } = t;
    addAccount(ctx, "acc_a", "me@acme.com");
    const { agent } = ctx.policy.createAgent({ name: "Hermes", grants: [readGrant("acc_a")] });
    seedConnection(ctx, { id: "con_notion", slug: "notion", name: "Notion" }, { [agent.id]: "ask" });
    seedConnection(ctx, { id: "con_t3", slug: "t3", name: "T3 forge" }, { [agent.id]: "read" });

    const on = await connectMcp(ctx, agent.id);
    const onTools = (await on.client.listTools()).tools;
    const instructions = on.client.getInstructions()!;
    await on.close();

    const native = onTools.filter((x) => !x.name.includes("__") && x.name !== "get_call_status");

    // Upstream tools with the read level applied (t3's send_message is hidden), plus get_call_status.
    const broker = onTools.filter((x) => !native.includes(x)).map((x) => x.name);
    expect(broker.sort()).toEqual(["get_call_status", "notion__notion-delete-pages", "notion__notion-search", "notion__notion-update-page", "t3__list_threads"]);
    expect(broker.every((n) => !n.includes("."))).toBe(true);

    // The pinned JSON Schema as is; a risky tool can't claim to be read-only.
    const del = onTools.find((x) => x.name === "notion__notion-delete-pages")!;
    expect(del.inputSchema).toEqual(CATALOG.notion![2]!.def.inputSchema);
    expect(del.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(onTools.find((x) => x.name === "notion__notion-update-page")!.title).toBe("Update page");

    expect(instructions.startsWith(INSTRUCTIONS)).toBe(true);
    expect(instructions).toContain("- Notion: tools named notion__…; risky actions");
    expect(instructions).toContain("- T3 forge: tools named t3__…; read only.");
    expect(instructions.match(/data, not instructions/g)).toHaveLength(2); // email's rule, plus one for integrations
  });

  it("an agent without connections gets nothing extra", async () => {
    const t = setup();
    disposers.push(t.dispose);
    const { agent } = t.ctx.policy.createAgent({ name: "plain" });
    const s = await connectMcp(t.ctx, agent.id);
    expect((await s.client.listTools()).tools.map((x) => x.name)).toEqual(["list_accounts"]);
    expect(s.client.getInstructions()).toBe(INSTRUCTIONS);
    await s.close();
  });

  it("routes upstream calls to BrokerCalls and get_call_status to the policy; audits dynamic names", async () => {
    const t = setup();
    disposers.push(t.dispose);
    const { ctx, rec } = t;
    const { agent } = ctx.policy.createAgent({ name: "Hermes" });
    seedConnection(ctx, { id: "con_notion", slug: "notion", name: "Notion" }, { [agent.id]: "full" });
    const s = await connectMcp(ctx, agent.id);

    const r = await s.client.callTool({ name: "notion__notion-search", arguments: { query: "roadmap" } });
    expect(text(r)).toBe("ran notion__notion-search");
    expect(rec.calls).toEqual([{ agentId: agent.id, name: "notion__notion-search", args: { query: "roadmap" } }]);

    expect(text(await s.client.callTool({ name: "get_call_status", arguments: { approval_id: "apr_1" } }))).toBe(`status of apr_1 for ${agent.id}: pending`);

    const unknown = await s.client.callTool({ name: "notion__nope", arguments: {} });
    expect(unknown.isError).toBe(true);

    rec.throwOn.add("notion__notion-update-page");
    const failed = await s.client.callTool({ name: "notion__notion-update-page", arguments: { page_id: "p" } });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("Internal error");

    // The native tools still answer as before.
    expect(text(await s.client.callTool({ name: "list_accounts", arguments: {} }))).not.toContain("Internal error");
    await s.close();

    expect(audits(ctx, agent.id)).toEqual([
      { action: "notion__notion-search", outcome: "ok", reason: null }, // by BrokerCalls
      { action: "get_call_status", outcome: "ok", reason: null },
      { action: "unknown_tool", outcome: "error", reason: "unknown_tool" },
      { action: "notion__notion-update-page", outcome: "error", reason: "internal" },
      { action: "list_accounts", outcome: "ok", reason: null },
    ]);
  });

  it("skips tools that aren't valid MCP listings, repairs invalid results, and sets readOnlyHint from the read class", async () => {
    const tool = (name: string, inputSchema: Record<string, unknown>, cls: ToolClass, annotations?: ToolDef["annotations"]): RegisteredTool => ({
      exposedName: `x__${name}`,
      connectionId: "con_x",
      slug: "x",
      def: { name, description: name, inputSchema, ...(annotations ? { annotations } : {}) },
      cls,
      level: "full",
      pinHash: "p",
    });
    const tools = [
      tool("bad", { type: "object", properties: { x: true } }, { risky: false, read: true, source: "heuristic" }),
      tool("weird_result", obj({}), { risky: false, read: false, source: "heuristic" }, { readOnlyHint: true }),
      tool("broken_result", obj({}), { risky: false, read: true, source: "heuristic" }),
    ];
    const results: Record<string, unknown> = {
      x__weird_result: { content: [{ type: "text", text: "done" }], structuredContent: "not an object" },
      x__broken_result: { content: "nope" },
    };
    const t = setup({
      registry: { forAgent: () => tools, resolve: (_a, n) => tools.find((x) => x.exposedName === n) ?? null },
      calls: { call: async (_a, name) => results[name] as ToolResult },
    });
    disposers.push(t.dispose);
    const { ctx } = t;
    const { agent } = ctx.policy.createAgent({ name: "Hermes" });
    seedConnection(ctx, { id: "con_x", slug: "x", name: "X" }, { [agent.id]: "full" });
    const s = await connectMcp(ctx, agent.id);
    // The SDK client validates the whole list: one bad schema would have taken every tool down.
    const listed = (await s.client.listTools()).tools;
    expect(listed.map((x) => x.name)).toEqual(["list_accounts", "list_events", "wait_for_events", "ack_events", "get_call_status", "x__weird_result", "x__broken_result"]);
    expect(listed.find((x) => x.name === "x__weird_result")!.annotations).toMatchObject({ readOnlyHint: false }); // not a read tool, whatever it claims
    expect(listed.find((x) => x.name === "x__broken_result")!.annotations).toMatchObject({ readOnlyHint: true });

    const weird = await s.client.callTool({ name: "x__weird_result", arguments: {} });
    expect(weird).toEqual({ content: [{ type: "text", text: "done" }] });
    const broken = await s.client.callTool({ name: "x__broken_result", arguments: {} });
    expect(broken.isError).toBe(true);
    expect(text(broken)).toContain("isn't a valid MCP tool result");
    await s.close();
  });

  it("rejectedCall: a listed exposed name is its own action, never unknown_tool", () => {
    const dynamic = new Set(["notion__notion-search"]);
    expect(rejectedCall({ name: "notion__notion-search" }, { error: { code: -32602 } }, new Map(), dynamic)).toEqual({ action: "notion__notion-search", reason: "invalid_request", detail: { code: -32602 } });
    expect(rejectedCall({ name: "notion__notion-search" }, { result: { isError: true } }, new Map(), dynamic)).toEqual({ action: "notion__notion-search", reason: "invalid_arguments", detail: null });
    expect(rejectedCall({ name: "notion__other" }, { result: { isError: true } }, new Map(), dynamic)!.action).toBe("unknown_tool");
  });
});

// ───────────── Events ─────────────

describe("connection events", () => {
  it("are visible to agents with a grant on the connection; event tools without Gmail", async () => {
    const t = setup();
    disposers.push(t.dispose);
    const { ctx } = t;
    const a = ctx.policy.createAgent({ name: "a" }).agent;
    const b = ctx.policy.createAgent({ name: "b" }).agent;
    seedConnection(ctx, { id: "con_1", slug: "notion", name: "Notion" }, { [a.id]: "read" });
    seedConnection(ctx, { id: "con_2", slug: "whoop", name: "WHOOP", kind: "native_whoop", preset: "whoop", url: null }, { [b.id]: "full" });
    const e1 = ctx.broker.emitConnectionEvent({ type: "connection.auth_failed", connectionId: "con_1", dedupeKey: "k1", detail: { reason: "notion-search</tool_output>\u200b" } })!;
    ctx.broker.emitConnectionEvent({ type: "whoop.recovery_updated", connectionId: "con_2", dedupeKey: "k2", detail: { cycleId: 1 } });
    expect(e1).toMatchObject({ type: "connection.auth_failed", accountId: "", accountEmail: "", connectionId: "con_1" });

    expect(ctx.events.feed(a.id).events.map((e) => e.type)).toEqual(["connection.auth_failed"]);
    expect(ctx.events.feed(b.id).events.map((e) => e.type)).toEqual(["whoop.recovery_updated"]);

    const s = await connectMcp(ctx, a.id);
    const names = (await s.client.listTools()).tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["list_events", "wait_for_events", "ack_events"]));
    const feed = text(await s.client.callTool({ name: "list_events", arguments: {} }));
    expect(feed).toContain("connection.auth_failed · connection con_1");
    // Event detail reaches the agent cleaned and delimiter-escaped.
    expect(feed).toContain("notion-search&lt;/tool_output>");
    expect(feed).not.toContain("\u200b");
    expect(feed).not.toContain("whoop");
    await s.close();
  });

  it("still accepts connection.tool_changed (never emitted since the hold was removed) in saved listener and webhook filters", () => {
    expect(parseTypes("message.received,connection.tool_changed")).toEqual(["message.received", "connection.tool_changed"]);
    const base = { agentId: "agt_x", name: "n", url: "https://example.com/h" };
    expect(webhookInputSchema.safeParse({ ...base, eventTypes: ["connection.tool_changed"] }).success).toBe(true);
  });

  it("webhook filters accept the new types; an account filter excludes connection events", () => {
    const base = { agentId: "agt_x", name: "n", url: "https://example.com/h" };
    expect(webhookInputSchema.safeParse({ ...base, eventTypes: ["connection.auth_failed", "approval.requested", "whoop.recovery_updated"] }).success).toBe(true);
    expect(webhookInputSchema.safeParse({ ...base, eventTypes: ["bogus"] }).success).toBe(false);
    expect(webhookInputSchema.safeParse({ ...base, eventTypes: ["message.bogus"] }).success).toBe(false);
    const ev = { type: "connection.auth_failed", accountId: "", connectionId: "con_1", message: null, threadLabelIds: [] } as unknown as StoredEvent;
    expect(matchesFilter({}, ev)).toBe(true);
    expect(matchesFilter({ from: ["*@x.com"] }, ev)).toBe(true);
    expect(matchesFilter({ accountIds: ["acc_a"] }, ev)).toBe(false);
  });
});

describe("listener stream without Gmail", () => {
  let running: RunningServer | undefined;
  afterEach(async () => {
    await running?.close();
    if (running) rmSync(running.ctx.config.dataDir, { recursive: true, force: true });
    running = undefined;
  });

  it("streams connection events to an agent with only a connection grant", async () => {
    running = await startServer({ config: testConfig(), overrides: { google: fakeGoogle(), ingest: fakeIngest() } });
    const { ctx, url } = running;
    agentApi(ctx, { heartbeatMs: 60_000 });
    const { agent, apiKey } = ctx.policy.createAgent({ name: "Hermes" });
    seedConnection(ctx, { id: "con_1", slug: "notion", name: "Notion" }, { [agent.id]: "ask" });
    const open = () => fetch(`${url}/agent/v1/events/stream?start=beginning&types=approval.requested,connection.auth_failed`, { headers: { authorization: `Bearer ${apiKey}` } });

    const res = await open();
    expect(res.status).toBe(200);
    const reader = new SseReader(res);
    try {
      await reader.until((f) => f.some((x) => x.comment === "connected"));
      ctx.broker.emitConnectionEvent({ type: "approval.requested", connectionId: "con_1", dedupeKey: "a0", detail: { approvalId: "apr_0", agentId: "agt_other" } }); // another agent's
      ctx.broker.emitConnectionEvent({ type: "approval.requested", connectionId: "con_1", dedupeKey: "a1", detail: { approvalId: "apr_1", agentId: agent.id } });
      ctx.broker.emitConnectionEvent({ type: "connection.expiring", connectionId: "con_1", dedupeKey: "a2" }); // not asked for
      await reader.until((f) => f.some((x) => x.event === "mail"));
      expect(reader.mail().map((m) => m.payload)).toEqual([
        expect.objectContaining({ type: "approval.requested", data: expect.objectContaining({ connectionId: "con_1", detail: { approvalId: "apr_1", agentId: agent.id } }) }),
      ]);
    } finally {
      reader.cancel();
    }
  });
});

// ───────────── Broker service ─────────────

describe("broker service", () => {
  const silent = { info() {}, warn() {} };
  const pollPreset = (): IntegrationPreset => ({
    id: "whoop",
    displayName: "WHOOP",
    slug: "whoop",
    kind: "native",
    auth: { type: "user_app", authorizeUrl: "https://x/a", tokenUrl: "https://x/t", scopes: [], clientIdInput: "client_id", clientSecretInput: "client_secret" },
    classify: () => null,
    setupSteps: () => [],
    events: {
      types: ["whoop.recovery_updated"],
      pollIntervalMs: 1000,
      handleWebhook: async () => [],
      poll: async (cursor, deps) => ({
        events: [
          { type: "whoop.recovery_updated", connectionId: deps.connectionId, dedupeKey: `r:${cursor ?? 0}`, data: { n: Number(cursor ?? 0) } },
          { type: "calendar.event_created", connectionId: deps.connectionId, dedupeKey: "evil", data: {} }, // not its own type: dropped
        ],
        cursor: String(Number(cursor ?? 0) + 1),
      }),
    },
  });

  /** DNS and Tailscale fakes: no network. `serve` is the `tailscale serve status --json` config, or null without the CLI. */
  const fakeReach = (answers: Record<string, string[]>, serve: () => unknown = () => null) => ({
    lookup: async (host: string) => {
      const a = answers[host];
      if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    tailscale: async () => {
      const c = serve();
      return c === null ? null : { bin: "tailscale", stdout: JSON.stringify(c) };
    },
  });
  const TAILNET = "https://box.tail1234.ts.net";

  it("polls native presets without a webhook URL, keeps the cursor, and serves webhook targets", async () => {
    const t = setup({
      presets: () => [pollPreset()],
      nativeDeps: (c) => ({ connectionId: c.id, accessToken: async () => "tok", fetch, log: silent }),
      reachability: fakeReach({ "inbox.example.com": ["93.184.216.34"] }),
    });
    disposers.push(t.dispose);
    const { ctx } = t;
    const { agent } = ctx.policy.createAgent({ name: "Hermes" });
    seedConnection(ctx, { id: "con_w", slug: "whoop", name: "WHOOP", kind: "native_whoop", preset: "whoop", url: null }, { [agent.id]: "full" });

    expect(await ctx.broker.pollEvents(10_000)).toBe(1);
    expect(await ctx.broker.pollEvents(10_500)).toBe(0); // not due yet
    expect(await ctx.broker.pollEvents(11_000)).toBe(1);
    expect(ctx.db.get<{ events_cursor: string }>("SELECT events_cursor FROM connections WHERE id = 'con_w'")!.events_cursor).toBe("2");
    expect(ctx.events.feed(agent.id).events.map((e) => [e.type, e.detail])).toEqual([
      ["whoop.recovery_updated", { n: 0 }],
      ["whoop.recovery_updated", { n: 1 }],
    ]);

    // Webhook target: needs the client secret (here from the encrypted table, as the credential store writes it).
    expect(ctx.broker.hooks.webhookTarget("con_w")).toBeNull();
    const t0 = new Date().toISOString();
    ctx.db.run(
      "INSERT INTO connection_credentials (connection_id, oauth_client_enc, created_at, updated_at) VALUES (?, ?, ?, ?)",
      "con_w",
      ctx.crypto.encrypt(JSON.stringify({ client_id: "id", client_secret: "s3cret" })),
      t0,
      t0,
    );
    expect(ctx.broker.hooks.webhookTarget("con_w")).toMatchObject({ clientSecret: "s3cret", preset: { id: "whoop" } });
    expect(ctx.broker.hooks.webhookTarget("con_nope")).toBeNull();
    ctx.broker.hooks.emit([{ type: "whoop.recovery_updated", connectionId: "con_w", dedupeKey: "trace-1", data: { traceId: "trace-1" } }]);
    ctx.broker.hooks.emit([{ type: "whoop.recovery_updated", connectionId: "con_w", dedupeKey: "trace-1", data: { traceId: "trace-1" } }]);
    expect(ctx.events.feed(agent.id).events).toHaveLength(3);

    expect(ctx.broker.hooks.presetWebhookTargets!("whoop").map((x) => x.deps.connectionId)).toEqual(["con_w"]);
    expect(ctx.broker.hooks.presetWebhookTargets!("notion")).toEqual([]);

    // A public https URL offers webhooks, and the reconciliation poll keeps running: a delivery never resets the cursor.
    ctx.settings.update({ publicUrl: "https://inbox.example.com" });
    await ctx.broker.webhookReachability();
    expect(ctx.broker.webhookUrl("con_w")).toBe("https://inbox.example.com/hooks/connections/con_w");
    expect(await ctx.broker.pollEvents(99_000)).toBe(1);
    ctx.broker.hooks.delivered!("con_w");
    expect(ctx.db.get<{ events_cursor: string }>("SELECT events_cursor FROM connections WHERE id = 'con_w'")!.events_cursor).toBe("3");
    expect(await ctx.broker.pollEvents(200_000)).toBe(1);
    expect(ctx.db.get<{ events_cursor: string }>("SELECT events_cursor FROM connections WHERE id = 'con_w'")!.events_cursor).toBe("4");

    // The URL stops being public (here: tailnet-only): no webhook URL, and still polling.
    ctx.settings.update({ publicUrl: TAILNET });
    await ctx.broker.webhookReachability();
    expect(ctx.broker.webhookUrl("con_w")).toBeNull();
    expect(await ctx.broker.pollEvents(300_000)).toBe(1);
  });

  it("a tailnet-only https URL (Tailscale serve, no Funnel): no webhook URL, and the connection polls", async () => {
    const t = setup({
      presets: () => [pollPreset()],
      nativeDeps: (c) => ({ connectionId: c.id, accessToken: async () => "tok", fetch, log: silent }),
      reachability: fakeReach({ "box.tail1234.ts.net": ["100.101.102.103", "fd7a:115c:a1e0::1"] }),
    });
    disposers.push(t.dispose);
    const { ctx } = t;
    const { agent } = ctx.policy.createAgent({ name: "Hermes" });
    seedConnection(ctx, { id: "con_w", slug: "whoop", name: "WHOOP", kind: "native_whoop", preset: "whoop", url: null }, { [agent.id]: "full" });
    ctx.settings.update({ publicUrl: TAILNET });
    expect(await ctx.broker.pollEvents(10_000)).toBe(1);
    expect(await ctx.broker.webhookReachability()).toMatchObject({ reach: "private", webhookBase: null, funnel: null });
    expect(ctx.broker.webhookUrl("con_w")).toBeNull();
    expect(await ctx.broker.pollEvents(11_000)).toBe(1);
    expect(ctx.events.feed(agent.id).events.map((e) => e.type)).toEqual(["whoop.recovery_updated", "whoop.recovery_updated"]);
  });

  it("GET /api/connections/presets: a preset's webhook step only for a public URL, the Funnel offer only on *.ts.net with Tailscale", async () => {
    let serve: unknown = null;
    // The setup context as a preset sees it (WHOOP's steps used it; WHOOP is a code extension now).
    const hookPreset = (): IntegrationPreset => ({
      ...pollPreset(),
      setupSteps: (sc) => [
        { id: "app", title: "Create an app", body: "…", copy: { label: "Redirect URI", value: sc.redirectUri } },
        ...(sc.webhookUrl
          ? [{ id: "webhook", title: "Optional: turn on webhooks", body: "…", copy: { label: "Webhook URL", value: sc.webhookUrl } }]
          : sc.funnel
            ? [
                { id: "funnel", title: "Optional: Funnel", body: "Warning: it's reachable from the whole internet.", copy: { label: "Command", value: sc.funnel.command } },
                { id: "funnel-webhook", title: "Optional: paste the Funnel webhook URL", body: "…", copy: { label: "Webhook URL", value: sc.funnel.webhookUrl } },
              ]
            : []),
        { id: "connect", title: "Connect", body: "…" },
      ],
    });
    const h = harness({
      broker: (ctx) =>
        createBrokerService(ctx, {
          presets: () => [hookPreset()],
          reachability: fakeReach({ "box.tail1234.ts.net": ["100.101.102.103"], "inbox.example.com": ["93.184.216.34"] }, () => serve),
        }),
    });
    disposers.push(h.dispose);
    const cookie = await h.claim();
    const { ctx } = h;
    const steps = async () => {
      // Each case re-checks: the cache keeps one entry, for the current public URL.
      const [p] = (await json(await h.request("/api/connections/presets", { cookie, headers: CSRF }))) as { setupSteps: { id: string; title: string; body: string; copy?: { value: string } }[] }[];
      return p!.setupSteps;
    };
    const text = (s: Awaited<ReturnType<typeof steps>>) => JSON.stringify(s);

    // Tailnet-only, no Tailscale CLI: no webhook anywhere.
    ctx.settings.update({ publicUrl: TAILNET });
    let s = await steps();
    expect(s.map((x) => x.id)).toEqual(["app", "connect"]);
    expect(text(s)).not.toContain("/hooks/");

    // Public: the optional webhook step, with the preset's URL (no connection id needed).
    ctx.settings.update({ publicUrl: "https://inbox.example.com" });
    s = await steps();
    expect(s.map((x) => x.id)).toEqual(["app", "webhook", "connect"]);
    expect(s.find((x) => x.id === "webhook")).toMatchObject({ copy: { value: "https://inbox.example.com/hooks/connections/whoop" } });

    // Tailnet-only with the Tailscale CLI (console served on 443): the Funnel offer on its own port, hooks path only.
    serve = { TCP: { "443": { HTTPS: true } }, Web: { "box.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8425" } } } } };
    ctx.settings.update({ publicUrl: TAILNET });
    s = await steps();
    expect(s.map((x) => x.id)).toEqual(["app", "funnel", "funnel-webhook", "connect"]);
    const origin = loopbackUrl(ctx.config.host, ctx.config.port);
    expect(s.find((x) => x.id === "funnel")!.copy!.value).toBe(`tailscale funnel --bg --https=8443 --set-path=/hooks/connections ${origin}/hooks/connections`);
    expect(s.find((x) => x.id === "funnel-webhook")!.copy!.value).toBe("https://box.tail1234.ts.net:8443/hooks/connections/whoop");
  });

  it("mcp.call approvals run through the broker's runner; an interrupted one is never retried", async () => {
    const runs: string[] = [];
    let t = setup();
    disposers.push(t.dispose);
    const seed = (ctx: AppContext, id: string, status = "pending", decidedAt: string | null = null) => {
      const { agent } = ctx.policy.createAgent({ name: `a-${id}` });
      if (!ctx.db.get("SELECT 1 FROM connections WHERE id = 'con_n'")) seedConnection(ctx, { id: "con_n", slug: "notion", name: "Notion" }, {});
      const call = { tool: "notion-delete-pages", exposedName: "notion__notion-delete-pages", args: '{"page_ids":["p1"]}', argsSha256: "h", pinHash: "pin" };
      ctx.db.run(
        `INSERT INTO approvals (id, agent_id, connection_id, kind, status, payload, tool_call, decided_at, created_at, expires_at)
         VALUES (?, ?, 'con_n', 'mcp.call', ?, '{}', ?, ?, ?, ?)`,
        id,
        agent.id,
        status,
        JSON.stringify(call),
        decidedAt,
        new Date().toISOString(),
        new Date(Date.now() + 3_600_000).toISOString(),
      );
    };
    // The real policy runtime: the tool isn't in the registry for this agent any more, so it's cancelled, never run.
    seed(t.ctx, "apr_1");
    expect((await t.ctx.mail.approve("apr_1")).status).toBe("rejected");

    t = setup({
      // Stands in for the policy runtime, which records the outcome on the claimed approval itself.
      runApprovedCall: async (a) => {
        runs.push(a.call.args);
        const result: ToolResult = { content: [{ type: "text", text: "deleted" }], structuredContent: { ok: true } };
        t.ctx.db.run("UPDATE approvals SET status = 'sent', tool_call = json_set(tool_call, '$.result', json(?)) WHERE id = ? AND status = 'approved'", JSON.stringify(result), a.id);
      },
    });
    disposers.push(t.dispose);
    seed(t.ctx, "apr_2");
    const done = await t.ctx.mail.approve("apr_2");
    expect(done.status).toBe("sent");
    expect(runs).toEqual(['{"page_ids":["p1"]}']);
    expect(done.call).toMatchObject({ result: { content: [{ type: "text", text: "deleted" }], structuredContent: { ok: true } } });

    seed(t.ctx, "apr_3", "approved", new Date(Date.now() - 3_600_000).toISOString());
    expect(new Approvals(t.ctx).recoverInterrupted()).toBe(1);
    const stuck = new Approvals(t.ctx).get("apr_3")!;
    expect(stuck.status).toBe("failed");
    expect(stuck.error).toMatch(/may or may not have run/);
    expect(stuck.call).toMatchObject({ outcomeUnknown: true });
    expect(runs).toHaveLength(1);
  });
});

// ───────────── /api/connections ─────────────

describe("/api/connections", () => {
  it("is 404 with the setting off; CRUD, grants, private target, tool counts, presets and the kill switch", async () => {
    const killHook: { credentialsPresent: boolean }[] = [];
    const h = harness({
      broker: (ctx) =>
        createBrokerService(ctx, {
          onKill: [(id) => void killHook.push({ credentialsPresent: !!ctx.db.get("SELECT 1 AS x FROM connection_credentials WHERE connection_id = ?", id) })],
          presets: () => [
            {
              id: "notion",
              displayName: "Notion",
              slug: "notion",
              kind: "remote_http",
              url: "https://mcp.notion.com/mcp",
              auth: { type: "mcp_oauth" },
              classify: () => null,
              setupSteps: (s) => [{ id: "connect", title: "Connect", body: "Approve in Notion.", copy: { label: "Redirect URI", value: s.redirectUri } }],
              reconnectPolicy: { maxLifetimeDays: 180, idleDays: 30 },
            },
          ],
        }),
    });
    disposers.push(h.dispose);
    const cookie = await h.claim();
    const req = (path: string, init: RequestInit & { json?: unknown } = {}) => h.request(`/api${path}`, { cookie, ...init, headers: { ...CSRF, ...(init.headers as object) } });
    const { ctx } = h;
    const a = ctx.policy.createAgent({ name: "a" }).agent;
    const b = ctx.policy.createAgent({ name: "b" }).agent;

    expect(await json(await req("/connections"))).toEqual([]);
    // Same session + CSRF rules as the rest of /api.
    expect((await h.request("/api/connections", { method: "POST", cookie, json: { url: "https://x.example.com/mcp" } })).status).toBe(403);
    expect((await h.request("/api/connections")).status).toBe(401);

    // Create: custom URL, every agent at the default level.
    const created = await req("/connections", { method: "POST", json: { url: "http://127.0.0.1:8787/mcp", name: "Brightspace" } });
    expect(created.status).toBe(201);
    const con = await json(created);
    expect(con).toMatchObject({ kind: "remote_http", slug: "127", name: "Brightspace", levelDefault: "ask", status: "active", agents: 2, tools: { total: 0 }, expiresInDays: null });
    expect((await req("/connections", { method: "POST", json: { url: "https://h.example.com/mcp", slug: "127" } })).status).toBe(409);
    expect((await req("/connections", { method: "POST", json: { url: "ftp://h.example.com" } })).status).toBe(400);
    expect((await req("/connections", { method: "POST", json: { preset: "nope" } })).status).toBe(400);
    const notion = await json(await req("/connections", { method: "POST", json: { preset: "notion", agentIds: [a.id], levelDefault: "read" } }));
    expect(notion).toMatchObject({ slug: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", preset: "notion", authType: "oauth", agents: 1, levelDefault: "read" });

    // Presets, with setup steps resolved for this install.
    const presets = await json(await req("/connections/presets"));
    expect(presets).toEqual([expect.objectContaining({ id: "notion", authType: "oauth", setupSteps: [expect.objectContaining({ copy: { label: "Redirect URI", value: `${ctx.settings.publicUrl()}/oauth/connections/callback` } })] })]);

    // Upstream tools: all of them count (a changed tool is never held).
    const now = new Date().toISOString();
    const def = (d: string) => JSON.stringify({ description: d, inputSchema: { type: "object" } });
    const longName = `read_${"x".repeat(80)}`;
    ctx.db.run(
      `INSERT INTO upstream_tools (connection_id, name, exposed_name, definition, pin_hash, class_source, state, held_reason, candidate_definition, candidate_hash, first_seen_at, updated_at)
       VALUES (?, 'search', '127__search', ?, 'h1', 'heuristic', 'active', NULL, NULL, NULL, ?, ?),
              (?, 'list', '127__list', ?, 'h3', 'heuristic', 'active', NULL, NULL, NULL, ?, ?),
              (?, 'fetch.page', '127__fetch_page', ?, 'h4', 'heuristic', 'active', NULL, NULL, NULL, ?, ?),
              (?, ?, ?, ?, 'h5', 'heuristic', 'active', NULL, NULL, NULL, ?, ?)`,
      con.id, def("Search."), now, now,
      con.id, def("List."), now, now,
      con.id, def("Fetch."), now, now,
      con.id, longName, exposedName("127", longName), def("Long."), now, now,
    );
    expect((await json(await req(`/connections/${con.id}`))).tools).toEqual({ total: 4 });
    // No review or accept step exists any more.
    expect((await req(`/connections/${con.id}/held`)).status).toBe(404);
    expect((await req(`/connections/${con.id}/held/search/accept`, { method: "POST", json: { candidateHash: "h1" } })).status).toBe(404);

    // Update: name, slug (exposed names follow), level default.
    const patched = await json(await req(`/connections/${con.id}`, { method: "PATCH", json: { name: "BS", slug: "brightspace", levelDefault: "full" } }));
    expect(patched).toMatchObject({ name: "BS", slug: "brightspace", levelDefault: "full" });
    // The catalog's naming rule: dots become "_", long names are cut to 64 with a hash suffix.
    const renamed = ctx.db.all<{ name: string; exposed_name: string }>("SELECT name, exposed_name FROM upstream_tools WHERE connection_id = ? ORDER BY name", con.id);
    expect(renamed.map((r) => r.exposed_name)).toEqual(["brightspace__fetch_page", "brightspace__list", exposedName("brightspace", longName), "brightspace__search"]);
    expect(renamed.every((r) => r.exposed_name.length <= 64 && !r.exposed_name.includes("."))).toBe(true);
    expect((await req(`/connections/${con.id}`, { method: "PATCH", json: { slug: "notion" } })).status).toBe(409);
    expect((await req(`/connections/${con.id}`, { method: "PATCH", json: { slug: "Bad_Slug" } })).status).toBe(400);

    // Private-target allow: pinned to scheme://host:port; editing the URL clears it.
    expect(await json(await req(`/connections/${con.id}/private-target`, { method: "PUT", json: { allow: true } }))).toMatchObject({ privateTarget: "http://127.0.0.1:8787" });
    // A new URL never gets the old credentials: header deleted, reconnect needed, pending calls cancelled.
    ctx.db.run(
      "UPDATE connections SET protocol = '2025-11-25', protocol_checked_at = ?, expires_at = ? WHERE id = ?",
      now,
      new Date(Date.now() + 86_400_000).toISOString(),
      con.id,
    );
    upstreams(ctx).store.setHeader(con.id, "Authorization", "Bearer old-server-token");
    ctx.db.run(
      `INSERT INTO approvals (id, agent_id, connection_id, kind, status, payload, tool_call, created_at, expires_at) VALUES ('apr_url', ?, ?, 'mcp.call', 'pending', '{}', '{}', ?, ?)`,
      a.id, con.id, now, new Date(Date.now() + 3_600_000).toISOString(),
    );
    expect(await json(await req(`/connections/${con.id}`, { method: "PATCH", json: { url: "http://127.0.0.1:9999/mcp" } }))).toMatchObject({
      privateTarget: null,
      url: "http://127.0.0.1:9999/mcp",
      status: "needs_reauth",
      statusReason: "URL changed; reconnect",
      expiresAt: null,
      protocol: null,
    });
    expect(ctx.db.get("SELECT 1 AS x FROM connection_credentials WHERE connection_id = ?", con.id)).toBeUndefined();
    expect(ctx.db.get("SELECT protocol_checked_at FROM connections WHERE id = ?", con.id)).toEqual({ protocol_checked_at: null });
    expect(ctx.db.get("SELECT status FROM approvals WHERE id = 'apr_url'")).toEqual({ status: "rejected" });
    expect(ctx.db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'connection.update' ORDER BY id DESC LIMIT 1")!.detail).toContain('"credentialsCleared":true');
    // Preset connections keep the preset's URL.
    expect((await req(`/connections/${notion.id}`, { method: "PATCH", json: { url: "https://evil.example.com/mcp" } })).status).toBe(400);
    const actions = ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'connection.private_target%' ORDER BY id").map((r) => r.action);
    expect(actions).toEqual(["connection.private_target.allow", "connection.private_target.revoke"]);

    // Grants: the full list replaces the old one; a removed agent's pending calls are cancelled.
    expect((await json(await req(`/connections/${con.id}/grants`))).map((g: { agentId: string }) => g.agentId).sort()).toEqual([a.id, b.id].sort());
    ctx.db.run(
      `INSERT INTO approvals (id, agent_id, connection_id, kind, status, payload, tool_call, created_at, expires_at) VALUES ('apr_b', ?, ?, 'mcp.call', 'pending', '{}', '{}', ?, ?)`,
      b.id, con.id, now, new Date(Date.now() + 3_600_000).toISOString(),
    );
    const grants = await json(await req(`/connections/${con.id}/grants`, { method: "PUT", json: { grants: [{ agentId: a.id, level: "read" }] } }));
    expect(grants).toEqual([expect.objectContaining({ agentId: a.id, level: "read" })]);
    expect(ctx.db.get("SELECT status FROM approvals WHERE id = 'apr_b'")).toEqual({ status: "rejected" });
    expect((await req(`/connections/${con.id}/grants`, { method: "PUT", json: { grants: [{ agentId: "agt_nope", level: "read" }] } })).status).toBe(400);

    // Probe and connect go to the upstream runtime: a loopback URL without an allow is blocked (no network needed).
    expect(await json(await req("/connections/probe", { method: "POST", json: { url: "http://127.0.0.1:1/mcp" } }))).toMatchObject({
      reachable: false,
      blocked: "private_target",
      privateTarget: "http://127.0.0.1:1",
    });
    expect(await json(await req(`/connections/${con.id}/connect`, { method: "POST", json: { header: { name: "Authorization", value: "Bearer s3cret" } } }))).toMatchObject({
      status: "connected",
      connection: { status: "active", authType: "header" },
    });
    expect(upstreams(ctx).store.header(con.id)).toEqual({ name: "Authorization", value: "Bearer s3cret" });
    expect(JSON.stringify(ctx.db.all("SELECT detail FROM audit_log"))).not.toContain("s3cret");

    // Kill switch, then delete.
    expect((await req(`/connections/${con.id}/kill`, { method: "POST" })).status).toBe(204);
    expect(killHook).toEqual([{ credentialsPresent: true }]); // hooks (a revoke) run before the credentials go
    expect(await json(await req(`/connections/${con.id}`))).toMatchObject({ status: "disabled" });
    expect(ctx.db.get("SELECT 1 AS x FROM connection_credentials WHERE connection_id = ?", con.id)).toBeUndefined();
    expect((await req(`/connections/${con.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await req(`/connections/${con.id}`)).status).toBe(404);
    expect(ctx.db.get("SELECT COUNT(*) AS n FROM connection_grants WHERE connection_id = ?", con.id)).toEqual({ n: 0 });
    expect((await json(await req("/connections"))).map((c: { slug: string }) => c.slug)).toEqual(["notion"]);
  });

  it("a user_app reconnect (WHOOP's, now from the extension's manifest) keeps the pasted client as a candidate until the consent completes", async () => {
    const userApp: IntegrationPreset = {
      id: "whoop",
      displayName: "WHOOP",
      slug: "whoop",
      kind: "native",
      auth: {
        type: "user_app",
        authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
        tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
        scopes: ["offline", "read:recovery"],
        clientIdInput: "client_id",
        clientSecretInput: "client_secret",
      },
      classify: () => null,
      setupSteps: () => [],
    };
    const h = harness({ broker: (ctx) => createBrokerService(ctx, { presets: () => [userApp] }) });
    disposers.push(h.dispose);
    const cookie = await h.claim();
    const { ctx } = h;
    const t0 = new Date().toISOString();
    ctx.db.run(
      "INSERT INTO connections (id, kind, preset, slug, name, auth_type, created_at, updated_at) VALUES ('con_w', 'native_whoop', 'whoop', 'whoop', 'WHOOP', 'oauth', ?, ?)",
      t0,
      t0,
    );
    upstreams(ctx).store.setClient("con_w", { client_id: "good-id", client_secret: "good-secret-123" });
    const res = await h.request("/api/connections/con_w/connect", { method: "POST", cookie, headers: CSRF, json: { inputs: { client_id: "typo-id", client_secret: "typo-secret-123" } } });
    const r = await json(res);
    expect(r).toMatchObject({ status: "authorize" });
    const u = new URL(r.authorizeUrl);
    expect(u.origin + u.pathname).toBe("https://api.prod.whoop.com/oauth/oauth2/auth");
    expect(u.searchParams.get("client_id")).toBe("typo-id");
    expect(u.searchParams.get("scope")).toBe("offline read:recovery");
    expect(u.searchParams.get("state")!.length).toBeGreaterThanOrEqual(8);
    // The working client is untouched until WHOOP's consent comes back.
    expect(upstreams(ctx).store.client("con_w")).toEqual({ client_id: "good-id", client_secret: "good-secret-123" });
  });

  it("the app serves connection webhooks through the broker's hook host by default", async () => {
    const t = setup();
    disposers.push(t.dispose);
    const res = await createApp(t.ctx).request("/hooks/connections/con_missing", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});
