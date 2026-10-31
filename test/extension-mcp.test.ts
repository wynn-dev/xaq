// Prompts and resources on /mcp for every upstream, remote and code (docs/EXTENSIONS.md "Prompts and resources"),
// end to end and offline: a code-extension connection (the echo fixture, a real child) and a remote one (the fake
// upstream), an agent at "read", both tool-list modes, routing, namespacing, audit, the kill switch, events through
// the outbox, and the state directory going with the connection.

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  exposedResourceTemplate,
  exposedResourceUri,
  parseResourceUri,
  createPassthrough,
  splitExposedName,
} from "../server/broker/passthrough.ts";
import { createBrokerService } from "../server/broker/service.ts";
import type { IntegrationPreset, ToolSource } from "../server/broker/types.ts";
import type { AppContext } from "../server/context.ts";
import { codeExtensionNodeProblem, codeExtensionSource, extensionStateDir, type InstalledExtension } from "../server/extensions/host/index.ts";
import { extensionStore } from "../server/extensions/store.ts";
import { type FakeMcpUpstream, startFakeMcpUpstream } from "./fake-mcp-upstream.ts";
import { CSRF, harness, json } from "./platform-helpers.ts";

const FIXTURE = resolve(import.meta.dirname, "fixtures/extensions/echo");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

const textOf = (r: unknown) => (r as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join("\n");

function installEcho(ctx: AppContext): InstalledExtension {
  const installDir = join(ctx.config.dataDir, "extensions", "echo", "0123abcd");
  mkdirSync(installDir, { recursive: true });
  cpSync(FIXTURE, installDir, { recursive: true });
  return {
    name: "echo",
    kind: "code",
    version: "1.0.0",
    source: FIXTURE,
    commit: null,
    integrity: "sha256-test",
    official: false,
    installDir,
    manifest: JSON.parse(readFileSync(join(installDir, "xaq-extension.json"), "utf8")),
    installedAt: new Date().toISOString(),
  };
}

/** What B2's presetFromManifest makes of the echo manifest (kind "code" → native, createSource → the host). */
const echoPreset = (ext: () => InstalledExtension): IntegrationPreset => ({
  id: "echo",
  displayName: "Echo",
  slug: "echo",
  kind: "native",
  auth: { type: "none" },
  classify: () => ({ risky: false, read: true, source: "preset" }),
  setupSteps: () => [],
  createSource: (deps) => codeExtensionSource(ext(), deps, { verify: () => true }),
});

async function world(opts: { level?: "read" | "ask" | "full" } = {}) {
  const up: FakeMcpUpstream = await startFakeMcpUpstream({
    tools: [{ name: "get_page", description: "Read a page.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
    prompts: [{ name: "summarize", description: "Summarize a page.", arguments: [{ name: "page", required: true }], get: (a) => ({ messages: [{ role: "user", content: { type: "text", text: `Summarize ${a.page}` } }] }) }],
    resources: [{ uri: "https://pages.example/p/1", name: "page-1", mimeType: "text/markdown" }],
    resourceTemplates: [{ uriTemplate: "https://pages.example/p/{id}", name: "page" }],
    read: (uri) => ({ contents: [{ uri, mimeType: "text/markdown", text: `# ${uri}` }] }),
  });
  cleanup.push(() => up.close());
  let ext: InstalledExtension | null = null;
  const h = harness({ broker: (ctx) => createBrokerService(ctx, { presets: () => [echoPreset(() => ext!)] }) });
  cleanup.push(() => h.dispose());
  const { ctx } = h;
  ext = installEcho(ctx);
  const cookie = await h.claim();
  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => h.request(`/api${path}`, { cookie, ...init, headers: { ...CSRF, ...(init.headers as object) } });
  const { agent, apiKey } = ctx.policy.createAgent({ name: "Hermes" });
  const level = opts.level ?? "read";

  // The remote connection, through the API (no auth on the fake).
  const remote = await json(await api("/connections", { method: "POST", json: { url: up.url, slug: "fake", name: "Fake", agentIds: [agent.id], levelDefault: level } }));
  await api(`/connections/${remote.id}/private-target`, { method: "PUT", json: { allow: true } });
  expect(await json(await api(`/connections/${remote.id}/connect`, { method: "POST", json: {} }))).toMatchObject({ status: "connected" });

  // The code-extension connection (B2 creates these from the manifest; seeded here).
  const t = new Date().toISOString();
  ctx.db.run("INSERT INTO connections (id, kind, preset, slug, name, auth_type, created_at, updated_at) VALUES ('con_echo', 'stdio', 'echo', 'echo', 'Echo', 'none', ?, ?)", t, t);
  ctx.db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, 'con_echo', ?, ?, ?)", agent.id, level, t, t);
  ctx.broker.invalidate("all");
  ctx.broker.attach("con_echo");
  expect(await ctx.broker.catalog.refresh(remote.id)).toMatchObject({ ok: true });
  expect(await ctx.broker.catalog.refresh("con_echo")).toMatchObject({ ok: true });

  const connect = async (key: string, mode?: string) => {
    const client = new Client({ name: "agent", version: "1" });
    const app = h.app;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://xaq.test/mcp${mode ? `?mode=${mode}` : ""}`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
        fetch: async (url, init) => app.request(String(url), init as RequestInit, { incoming: { socket: { remoteAddress: "127.0.0.1" } } }),
      }),
    );
    cleanup.push(() => client.close());
    return client;
  };
  return { h, ctx, up, api, agent, apiKey, remote, connect };
}

/** Resource text comes wrapped as untrusted, like tool output. */
const wrapped = (source: string, text: string) => expect.stringMatching(new RegExp(`^<tool_output source="${source}" nonce="[A-Za-z0-9_-]+" untrusted>\\n${text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\n</tool_output>$`));

// The code-extension half needs a Node without the known permission-model bypasses (on older ones it's refused).
describe.skipIf(codeExtensionNodeProblem() !== null)("prompts and resources on /mcp", () => {
  for (const mode of [undefined, "search"]) {
    it(`lists and routes both connections' prompts and resources, namespaced (${mode ?? "direct"} mode)`, async () => {
      const { ctx, agent, apiKey, connect, up } = await world();
      const client = await connect(apiKey, mode);
      expect(client.getServerCapabilities()).toMatchObject({ prompts: {}, resources: {} });

      const prompts = (await client.listPrompts()).prompts;
      expect(prompts.map((p) => p.name).sort()).toEqual(["echo__greet", "fake__summarize"]);
      expect(prompts.find((p) => p.name === "echo__greet")).toMatchObject({ description: "Says hello.", arguments: [{ name: "who", required: true }] });
      const greet = await client.getPrompt({ name: "echo__greet", arguments: { who: "Wynn" } });
      expect(greet.messages).toEqual([{ role: "user", content: { type: "text", text: "Hello, Wynn!" } }]);
      const sum = await client.getPrompt({ name: "fake__summarize", arguments: { page: "p1" } });
      expect(sum.messages[0]!.content).toEqual({ type: "text", text: "Summarize p1" });

      const resources = (await client.listResources()).resources;
      expect(resources.map((r) => [r.uri, r.name]).sort()).toEqual([
        [`xaq://echo/${encodeURIComponent("echo://notes/today")}`, "echo__today"],
        [`xaq://fake/${encodeURIComponent("https://pages.example/p/1")}`, "fake__page-1"],
      ]);
      const note = await client.readResource({ uri: `xaq://echo/${encodeURIComponent("echo://notes/today")}` });
      expect(note.contents).toEqual([{ uri: `xaq://echo/${encodeURIComponent("echo://notes/today")}`, mimeType: "text/plain", text: wrapped("echo/resource", "note for echo://notes/today") }]);

      const templates = (await client.listResourceTemplates()).resourceTemplates;
      expect(templates.map((t) => t.uriTemplate).sort()).toEqual(["xaq://echo/echo%3A%2F%2Fnotes%2F{day}", "xaq://fake/https%3A%2F%2Fpages.example%2Fp%2F{id}"]);
      // A client expands the template; the URI decodes back to the upstream's own.
      const page = await client.readResource({ uri: "xaq://fake/https%3A%2F%2Fpages.example%2Fp%2F42" });
      expect(page.contents).toEqual([{ uri: "xaq://fake/https%3A%2F%2Fpages.example%2Fp%2F42", mimeType: "text/markdown", text: wrapped("fake/resource", "# https://pages.example/p/42") }]);
      expect(up.requests.some((r) => r.body.includes('"resources/read"') && r.body.includes("https://pages.example/p/42"))).toBe(true);

      // Tools work alongside (the code extension's through the policy path).
      expect(textOf(await client.callTool({ name: "echo__echo", arguments: { text: "hi" } }))).toContain("hi");

      // Audited like reads: under the agent, against the connection.
      const audit = ctx.db.all<{ action: string; target: string; outcome: string }>("SELECT action, target, outcome FROM audit_log WHERE actor_id = ? AND action IN ('prompts/get', 'resources/read') ORDER BY id", agent.id);
      expect(audit.map((a) => a.action)).toEqual(["prompts/get", "prompts/get", "resources/read", "resources/read"]);
      expect(audit.every((a) => a.outcome === "ok")).toBe(true);
    });
  }

  it("visible at any level (read class); unknown names and foreign slugs are errors; a killed connection's are gone", async () => {
    const { ctx, api, agent, apiKey, connect, remote } = await world({ level: "read" });
    const client = await connect(apiKey);
    await expect(client.getPrompt({ name: "nope__greet" })).rejects.toThrow(/No connection named nope/);
    await expect(client.getPrompt({ name: "garbage" })).rejects.toThrow(/isn't a prompt/);
    await expect(client.readResource({ uri: "https://pages.example/p/1" })).rejects.toThrow(/xaq:\/\//);

    // Another agent without grants: no prompts or resources at all.
    const { apiKey: otherKey } = ctx.policy.createAgent({ name: "Other" });
    const other = await connect(otherKey);
    expect(other.getServerCapabilities()?.prompts).toBeUndefined();

    // The kill switch: the connection's prompts and resources disappear.
    expect((await api(`/connections/${remote.id}/kill`, { method: "POST", json: {} })).status).toBeLessThan(300);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["echo__greet"]);
    await expect(client.getPrompt({ name: "fake__summarize", arguments: { page: "x" } })).rejects.toThrow(/turned off/);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ? AND action = 'prompts/get'", agent.id)!.n).toBe(0);
  });

  it("a code extension's events reach the outbox; removing the connection deletes its state directory", async () => {
    const { ctx, agent, apiKey, connect } = await world({ level: "full" });
    const client = await connect(apiKey);
    await client.callTool({ name: "echo__state", arguments: { text: "kept" } });
    const stateDir = extensionStateDir(ctx.config.dataDir, "echo", "con_echo");
    expect(existsSync(join(stateDir, "note.txt"))).toBe(true);
    await client.callTool({ name: "echo__emit", arguments: { type: "echo.said", key: "e1" } });
    await client.callTool({ name: "echo__emit", arguments: { type: "fake.forged", key: "e2" } });
    const until = Date.now() + 5000;
    while (!ctx.events.feed(agent.id).events.some((e) => e.type === "echo.said") && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(ctx.events.feed(agent.id).events.filter((e) => e.connectionId === "con_echo").map((e) => [e.type, e.detail])).toEqual([["echo.said", { said: "hi" }]]);

    // In a real install (its DB, log and master.key open in this process), through /mcp: every attempt is refused.
    const escape = textOf(
      await client.callTool({
        name: "echo__escape",
        arguments: {
          paths: { masterKey: ctx.config.masterKeyPath, db: ctx.config.dbPath, dataDir: ctx.config.dataDir, otherState: extensionStateDir(ctx.config.dataDir, "echo", "con_other"), otherConnectionId: "con_other" },
        },
      }),
    );
    expect(escape).toContain("readMasterKey");
    expect(escape).toContain("inheritedFiles");
    expect(escape).not.toContain("ALLOWED");

    // An install or update of the extension (the store's onChange) restarts its connections: a new child.
    const pidOf = () => (ctx.broker.source("con_echo") as unknown as { pid: number | null }).pid;
    const oldPid = pidOf();
    expect(oldPid).toBeTypeOf("number");
    ctx.broker.start?.(); // where the broker subscribes to the store (the harness doesn't start services)
    await extensionStore(ctx).install(FIXTURE, { confirmThirdParty: true });
    const until2 = Date.now() + 5000;
    while ((pidOf() === oldPid || pidOf() === null) && Date.now() < until2) await new Promise((r) => setTimeout(r, 20));
    expect(pidOf()).not.toBe(oldPid);
    expect(textOf(await client.callTool({ name: "echo__echo", arguments: { text: "after update" } }))).toContain("after update");

    // Killed: the child is stopped, and anything it still sent would be dropped, not delivered.
    const before = ctx.events.feed(agent.id).events.length;
    const src = ctx.broker.source("con_echo");
    await ctx.broker.kill("con_echo", "test");
    expect(ctx.broker.source("con_echo")).toBeNull();
    expect(src).not.toBeNull();
    expect(ctx.events.feed(agent.id).events.length).toBe(before);

    await ctx.broker.remove("con_echo");
    expect(existsSync(stateDir)).toBe(false);
  });
});

describe("connections without their extension", () => {
  it("a code connection whose extension isn't installed says so (status error), and calls say so too; the presets list skips the reachability check", async () => {
    let checks = 0;
    const h = harness({
      broker: (ctx) =>
        createBrokerService(ctx, {
          presets: () => [],
          reachability: {
            lookup: async () => {
              checks++;
              return [{ address: "93.184.216.34", family: 4 }];
            },
            tailscale: async () => {
              checks++;
              return null;
            },
          },
        }),
    });
    cleanup.push(() => h.dispose());
    const { ctx } = h;
    const cookie = await h.claim();
    ctx.settings.update({ publicUrl: "https://inbox.example.com" });
    const t = new Date().toISOString();
    ctx.db.run("INSERT INTO connections (id, kind, preset, slug, name, auth_type, created_at, updated_at) VALUES ('con_w', 'native_whoop', 'whoop', 'whoop', 'WHOOP', 'oauth', ?, ?)", t, t);
    const view = await json(await h.request("/api/connections/con_w", { cookie, headers: CSRF }));
    expect(view).toMatchObject({ status: "error", statusReason: expect.stringContaining("Needs the whoop extension") });
    expect((await json(await h.request("/api/connections", { cookie, headers: CSRF })))[0]).toMatchObject({ status: "error" });
    const r = await ctx.broker.source("con_w")!.callTool("x", {}, { agentId: "a", connectionId: "con_w", signal: AbortSignal.timeout(1000), auditDetail: {} });
    expect(r).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Needs the whoop extension") }] });
    // Stored status untouched: installing the extension fixes it without a write.
    expect(ctx.db.get<{ status: string }>("SELECT status FROM connections WHERE id = 'con_w'")!.status).toBe("active");

    expect(await json(await h.request("/api/connections/presets", { cookie, headers: CSRF }))).toEqual([]);
    expect(checks).toBe(0);
  });
});

describe("passthrough names and URIs", () => {
  it("splits exposed names at the first __ and round-trips resource URIs", () => {
    expect(splitExposedName("notion__search__pages")).toEqual({ slug: "notion", name: "search__pages" });
    expect(splitExposedName("Notion__x")).toBeNull();
    expect(splitExposedName("__x")).toBeNull();
    const u = "file:///a b/ü?q=1#f";
    expect(parseResourceUri(exposedResourceUri("fs", u))).toEqual({ slug: "fs", uri: u });
    expect(parseResourceUri("xaq://fs/%E0%A4%A")).toBeNull();
    expect(parseResourceUri("https://x/y")).toBeNull();
    expect(exposedResourceTemplate("gh", "repo://{owner}/{repo}/issues{?state}")).toBe("xaq://gh/repo%3A%2F%2F{owner}%2F{repo}%2Fissues{?state}");
  });

  it("scrubs the connection's secrets from prompt and resource output, rewrites embedded resource URIs, drops huge blobs", async () => {
    const secret = "sk-live-abcdefghijklmnopqrstuvwxyz";
    const source: ToolSource = {
      connectionId: "con_1",
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
      prompts: {
        listPrompts: async () => [{ name: "ok" }, { name: "bad name" }, { name: "x".repeat(200) }],
        getPrompt: async () => ({
          messages: [
            { role: "user", content: { type: "text", text: `key ${secret} \u001b[31mred\u001b[0m hid\u200bden` } },
            { role: "user", content: { type: "resource", resource: { uri: "doc://1", text: `again ${secret}` } } },
            { role: "user", content: { type: "image", data: "A".repeat(8 * 1024 * 1024), mimeType: "image/png" } },
          ],
        }),
        listResources: async () => [
          { uri: "doc://a", name: "Meeting notes 2026" },
          { uri: "doc://b", name: "  tabs\tand\u200b spaces " },
          { uri: "doc://c", name: " \u0007 " },
        ],
        listResourceTemplates: async () => [],
        readResource: async (uri) => ({ contents: [{ uri, text: `secret ${secret}` }, { uri, blob: "A".repeat(8 * 1024 * 1024) }] }),
      },
    };
    const audits: unknown[] = [];
    const db = {
      all: () => [{ connection_id: "con_1", slug: "acme", name: "Acme", level: "read", disabled: 0 }],
    } as unknown as AppContext["db"];
    const pass = createPassthrough({
      db,
      source: () => source,
      credentials: { tokens: () => null, header: () => ({ name: "Authorization", value: `Bearer ${secret}` }), client: () => null },
      audit: (a) => void audits.push(a),
      log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as unknown as AppContext["log"],
    });
    const signal = AbortSignal.timeout(5000);
    expect((await pass.listPrompts("agt", signal)).map((p) => p.name)).toEqual(["acme__ok"]);
    // A resource name with spaces isn't dropped: it's a label (the URI routes), made safe.
    expect((await pass.listResources("agt", signal)).map((r) => [r.name, r.uri])).toEqual([
      ["acme__Meeting_notes_2026", "xaq://acme/doc%3A%2F%2Fa"],
      ["acme__tabs_and_spaces", "xaq://acme/doc%3A%2F%2Fb"],
    ]);
    const r = await pass.getPrompt("agt", "acme__ok", {}, signal);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.messages).toHaveLength(2);
    // Cleaned like tool output (ANSI, invisible characters); a prompt's own text isn't wrapped, embedded resource text is.
    expect(r.messages[0]!.content).toEqual({ type: "text", text: "key [redacted] red hidden" });
    expect((r.messages[1]!.content as unknown as { resource: { text: string } }).resource.text).toMatch(/^<tool_output source="acme\/ok" nonce="[^"]+" untrusted>\nagain \[redacted\]\n<\/tool_output>$/);
    expect(r.messages[1]!.content).toMatchObject({ type: "resource", resource: { uri: "xaq://acme/doc%3A%2F%2F1" } });
    const read = await pass.readResource("agt", exposedResourceUri("acme", "doc://2"), signal);
    expect(JSON.stringify(read)).not.toContain(secret);
    expect(read.contents.map((c) => c.uri)).toEqual(["xaq://acme/doc%3A%2F%2F2", "xaq://acme/doc%3A%2F%2F2"]);
    expect(read.contents[1]).toMatchObject({ text: expect.stringContaining("left out a binary resource") });
    expect((read.contents[0] as { text: string }).text).toMatch(/^<tool_output source="acme\/resource" nonce="[^"]+" untrusted>\nsecret \[redacted\]\n<\/tool_output>$/);
    expect(audits).toHaveLength(2);
  });
});
