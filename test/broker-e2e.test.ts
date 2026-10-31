// M1 done-when #1, the core path, end to end and offline: an admin adds a connection to a fake upstream MCP server
// with OAuth + DCR through /api/connections (connect, then the real /oauth/connections/callback), grants an agent
// "full", the agent sees `slug__tool` on /mcp, read and risky tools run at once, and after the kill switch the
// agent can't call them.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { upstreams } from "../server/broker/upstream/runtime.ts";
import { type FakeMcpUpstream, startFakeMcpUpstream } from "./fake-mcp-upstream.ts";
import { CSRF, harness, json } from "./platform-helpers.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

const text = (r: unknown) => (r as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join("\n");

describe("broker end to end (fake upstream, OAuth + DCR)", () => {
  it("connect, list, read, a risky call, kill", async () => {
    const deleted: string[] = [];
    const up: FakeMcpUpstream = await startFakeMcpUpstream({
      auth: { kind: "oauth", dcr: true },
      tools: [
        {
          name: "get_page",
          description: "Read a page.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          annotations: { readOnlyHint: true },
          handler: (args) => ({ content: [{ type: "text", text: `Page ${(args as { id: string }).id}: hello` }] }),
        },
        {
          name: "delete_page",
          description: "Delete a page.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
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

    // Add the connection (the agent at "full"), allow its loopback host, connect: probe → OAuth (DCR) → authorize URL.
    const con = await json(await api("/connections", { method: "POST", json: { url: up.url, slug: "fake", name: "Fake", agentIds: [agent.id], levelDefault: "full" } }));
    expect(await json(await api(`/connections/${con.id}/private-target`, { method: "PUT", json: { allow: true } }))).toMatchObject({ privateTarget: up.origin });
    const started = await json(await api(`/connections/${con.id}/connect`, { method: "POST", json: {} }));
    expect(started).toMatchObject({ status: "authorize", callbackMode: "direct" });
    expect(up.requests.some((r) => r.method === "POST" && r.path.endsWith("/register"))).toBe(true); // DCR

    // The fake auto-approves and redirects to our callback, which finishes the connection.
    const cb = await up.oauth!.followAuthorize(started.authorizeUrl);
    expect(cb.pathname).toBe("/oauth/connections/callback");
    const landing = await h.request(`${cb.pathname}${cb.search}`);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("Fake connected");
    expect(await json(await api(`/connections/${con.id}`))).toMatchObject({ status: "active", authType: "oauth" });

    // The catalog lists and pins the tools.
    const listed = await ctx.broker.catalog.refresh(con.id);
    expect(listed).toMatchObject({ ok: true });
    expect((await json(await api(`/connections/${con.id}`))).tools).toEqual({ total: 2 });

    // The agent, over HTTP with its key.
    const client = new Client({ name: "e2e", version: "1" });
    const app = h.app;
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://xaq.test/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
        fetch: async (url, init) => app.request(String(url), init as RequestInit, { incoming: { socket: { remoteAddress: "127.0.0.1" } } }),
      }),
    );
    cleanup.push(() => client.close());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_accounts", "fake__get_page", "fake__delete_page"]));

    // A read tool runs at once; its output comes wrapped as untrusted.
    const read = await client.callTool({ name: "fake__get_page", arguments: { id: "p1" } });
    expect(read.isError).toBeFalsy();
    expect(text(read)).toContain("Page p1: hello");
    expect(text(read)).toContain("<tool_output");

    // A risky tool at "full" runs at once, exactly once.
    const risky = await client.callTool({ name: "fake__delete_page", arguments: { id: "p2" } });
    expect(text(risky)).toContain("Deleted p2");
    expect(deleted).toEqual(["p2"]);

    // Reconnect while the agent keeps working: the sign-in replaces the pooled session, and calls after it still
    // work (nothing holds on to the closed one).
    const again = await json(await api(`/connections/${con.id}/connect`, { method: "POST", json: {} }));
    expect(again).toMatchObject({ status: "authorize" });
    expect(text(await client.callTool({ name: "fake__get_page", arguments: { id: "mid" } }))).toContain("Page mid: hello");
    const cb2 = await up.oauth!.followAuthorize(again.authorizeUrl);
    expect((await h.request(`${cb2.pathname}${cb2.search}`)).status).toBe(200);
    const afterReconnect = await client.callTool({ name: "fake__get_page", arguments: { id: "post" } });
    expect(afterReconnect.isError).toBeFalsy();
    expect(text(afterReconnect)).toContain("Page post: hello");
    await ctx.broker.catalog.refresh(con.id);
    expect((await json(await api(`/connections/${con.id}`))).tools).toEqual({ total: 2 });

    // A sign-in started before a URL edit can't complete afterwards (it was for the old server).
    const stale = await json(await api(`/connections/${con.id}/connect`, { method: "POST", json: {} }));
    const cb3 = await up.oauth!.followAuthorize(stale.authorizeUrl);
    const moved = up.url.replace("127.0.0.1", "localhost");
    expect(await json(await api(`/connections/${con.id}`, { method: "PATCH", json: { url: moved } }))).toMatchObject({ status: "needs_reauth", url: moved });
    expect((await h.request(`${cb3.pathname}${cb3.search}`)).status).toBe(400);
    expect(upstreams(ctx).store.tokens(con.id)).toBeNull();
    expect(await json(await api(`/connections/${con.id}`))).toMatchObject({ status: "needs_reauth" });

    // Kill switch: disabled, credentials gone, and the agent can't call the tools any more.
    expect((await api(`/connections/${con.id}/kill`, { method: "POST" })).status).toBe(204);
    expect(upstreams(ctx).store.tokens(con.id)).toBeNull();
    const before = up.requests.filter((r) => r.rpcMethod === "tools/call").length;
    const after = await client.callTool({ name: "fake__get_page", arguments: { id: "p3" } });
    expect(after.isError).toBe(true);
    expect(up.requests.filter((r) => r.rpcMethod === "tools/call").length).toBe(before);
    expect(audit(ctx.db.all<{ action: string; outcome: string }>("SELECT action, outcome FROM audit_log WHERE actor_id = ? ORDER BY id", agent.id))).toEqual(
      expect.arrayContaining(["fake__get_page:ok", "fake__delete_page:ok"]),
    );
  }, 20_000);
});

const audit = (rows: { action: string; outcome: string }[]) => rows.map((r) => `${r.action}:${r.outcome}`);
