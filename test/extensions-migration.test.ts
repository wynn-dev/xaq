// The upgrade from core presets to extensions, with no re-auth.
// A DB fixture shaped like Wynn's install:
// - notion-personal and notion-work: the Notion preset, with OAuth tokens;
// - whoop: a generic MCP connection to his dashboard's URL with a bearer key (not the WHOOP preset);
// - brightspace: generic, with a bearer key, on http://127.0.0.1:<port> through the private-target allow.
// The upgrade runs with the extension store stubbed (not yet installed, then installed; and installed from the start).
// All four list and call tools with the same credentials and the same exposed names, and no re-auth state appears.
// A T3 connection made by today's core preset keeps working once it's bound to the manifest extension.
// Offline: every upstream is a fake on 127.0.0.1.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { classifyTool } from "../server/broker/catalog/classify.ts";
import { addRule } from "../server/broker/policy/store.ts";
import { createBrokerService } from "../server/broker/service.ts";
import type { IntegrationPreset, ToolClass, ToolDef } from "../server/broker/types.ts";
import { upstreams } from "../server/broker/upstream/runtime.ts";
import type { AppContext } from "../server/context.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeIntegrity } from "../server/extensions/integrity.ts";
import { type ExtensionPin, extensionStore } from "../server/extensions/store.ts";
import { boundPreset, presetById, presetSource, presets, snapshotPreset, useExtensionStore } from "../server/integrations/index.ts";
import { fixtureManifest, type StubStore, stubExtensionStore } from "./extension-fixtures.ts";
import { entriesFromDir, fakeSha, startFakeGithub, writeTree } from "./extension-fakes.ts";
import { type FakeMcpUpstream, type FakeTool, startFakeMcpUpstream } from "./fake-mcp-upstream.ts";
import { CSRF, harness, json } from "./platform-helpers.ts";

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  cleanup = [];
  useExtensionStore(null);
});
afterAll(() => useExtensionStore(null));

const DAY = 86_400_000;
const PINS: ExtensionPin[] = ["notion", "t3code", "whoop", "brightspace"].map((name) => ({
  name,
  commit: "2222222222222222222222222222222222222222",
  integrity: `sha256-${Buffer.alloc(32, 7).toString("base64")}`,
}));

const text = (r: unknown) => (r as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join("\n");
const ok = (s: string): FakeTool["handler"] => (args) => ({ content: [{ type: "text", text: `${s} ${JSON.stringify(args)}` }] });

// ───────────── Today's core presets (origin/main before the move), as the broker saw them ─────────────

const cls = (c: "read" | "write" | "risky"): ToolClass => ({ risky: c === "risky", read: c === "read", source: "preset" });
const table =
  (t: Record<string, "read" | "write" | "risky">) =>
  (tool: ToolDef): ToolClass | null =>
    Object.hasOwn(t, tool.name) ? cls(t[tool.name]!) : null;

/** Notion reads that the generic rules wouldn't list at Read only (no readOnlyHint, no leading read verb). */
const HIDDEN_READS = ["notion-memory-search", "notion-ai-search", "notion-download-skill", "notion-download-attachment", "notion-wait-session"];

const CORE_NOTION: IntegrationPreset = {
  id: "notion",
  displayName: "Notion",
  slug: "notion",
  kind: "remote_http",
  url: "https://mcp.notion.com/mcp",
  auth: { type: "mcp_oauth" },
  classify: table({
    "notion-search": "read",
    "notion-move-pages": "write",
    "notion-delete-pages": "risky",
    "notion-spawn-session": "risky",
    ...Object.fromEntries(HIDDEN_READS.map((n) => [n, "read" as const])),
  }),
  setupSteps: () => [],
  reconnectPolicy: { maxLifetimeDays: 180, idleDays: 30 },
};
const CORE_T3: IntegrationPreset = {
  id: "t3code",
  displayName: "T3 Code",
  slug: "t3",
  kind: "remote_http",
  auth: { type: "mcp_oauth" },
  classify: table({ t3_project_list: "read", t3_thread_send: "write", t3_project_delete: "risky" }),
  setupSteps: () => [],
  userServer: { defaultPath: "/mcp", sameOriginIssuer: true },
  nameCheckExempt: ["t3_thread_send", "t3_thread_send_attachments", "t3_thread_merge_back"],
};

// ───────────── The environment ─────────────

/** A harness whose preset registry is "today's core" until `upgrade()` switches it to the extension registry. */
async function env() {
  let phase: "core" | "extensions" = "core";
  const h = harness({ broker: (ctx) => createBrokerService(ctx, { presets: () => (phase === "core" ? [CORE_NOTION, CORE_T3] : presets()) }) });
  cleanup.push(() => h.dispose());
  const cookie = await h.claim();
  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => h.request(`/api${path}`, { cookie, ...init, headers: { ...CSRF, ...(init.headers as object) } });
  h.ctx.settings.update({ brokerUpstreams: true });
  const { agent, apiKey } = h.ctx.policy.createAgent({ name: "Hermes" });
  const client = async () => {
    const c = new Client({ name: "migration", version: "1" });
    await c.connect(
      new StreamableHTTPClientTransport(new URL("http://xaq.test/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
        fetch: async (url, init) => h.app.request(String(url), init as RequestInit, { incoming: { socket: { remoteAddress: "127.0.0.1" } } }),
      }),
    );
    cleanup.push(() => c.close());
    return c;
  };
  /** The startup upgrade, as after updating xaq: the extension registry, the store, the bootstrap pins. */
  const upgrade = (store: StubStore) => {
    phase = "extensions";
    useExtensionStore(store);
    h.ctx.broker.invalidate("all");
    return h.ctx.broker.upgradeExtensions(store, PINS);
  };
  return { h, ctx: h.ctx, api, agent, client, upgrade };
}

type Env = Awaited<ReturnType<typeof env>>;

async function fake(opts: Parameters<typeof startFakeMcpUpstream>[0]): Promise<FakeMcpUpstream> {
  const up = await startFakeMcpUpstream(opts);
  cleanup.push(() => up.close());
  return up;
}

/** Notion-like tools, with hints like Notion's: only search says readOnlyHint, only deleting says destructiveHint. */
const notionTools = (label: string): FakeTool[] => [
  {
    name: "notion-search",
    description: "Search the workspace.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    annotations: { readOnlyHint: true },
    handler: ok(`${label} search`),
  },
  {
    name: "notion-move-pages",
    description: "Move pages to a new parent.",
    inputSchema: { type: "object", properties: { page_ids: { type: "array" }, parent: { type: "string" } } },
    handler: ok(`${label} moved`),
  },
  {
    name: "notion-delete-pages",
    description: "Delete pages.",
    inputSchema: { type: "object", properties: { page_ids: { type: "array" } } },
    annotations: { destructiveHint: true },
    handler: ok(`${label} deleted`),
  },
  // A Custom Agent acts on its own (mail, Slack): delegating to one must ask. The generic rules see a plain write.
  {
    name: "notion-spawn-session",
    description: "Start a session with a Custom Agent.",
    inputSchema: { type: "object", properties: { agent_url: { type: "string" }, message: { type: "string" } } },
    handler: ok(`${label} spawned`),
  },
  ...HIDDEN_READS.map((name) => ({ name, description: "Notion workspace data.", inputSchema: { type: "object", properties: {} }, handler: ok(`${label} ${name}`) })),
];

let seq = 0;
function insertConnection(ctx: AppContext, c: { slug: string; name: string; preset: string | null; url: string; authType: "oauth" | "header"; privateTarget: string }): string {
  const id = `con_wynn${++seq}`;
  const t = new Date(Date.now() - 40 * DAY).toISOString();
  ctx.db.run(
    "INSERT INTO connections (id, kind, preset, slug, name, url, auth_type, level_default, private_target, status, created_at, updated_at) VALUES (?, 'remote_http', ?, ?, ?, ?, ?, 'ask', ?, 'active', ?, ?)",
    id,
    c.preset,
    c.slug,
    c.name,
    c.url,
    c.authType,
    c.privateTarget,
    t,
    t,
  );
  return id;
}

const grant = (ctx: AppContext, agentId: string, connectionId: string, level: "full" | "ask" | "read") =>
  ctx.db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", agentId, connectionId, level, new Date().toISOString(), new Date().toISOString());

const approvalId = (s: string) => /apr_[a-z0-9]+/.exec(s)![0];

/**
 * Wynn's install: two Notion workspaces on the Notion preset (personal at "ask", work at Read only), WHOOP's
 * dashboard and Brightspace as generic servers; an always-allow rule and a pending approval from before.
 */
async function wynnInstall(e: Env) {
  const store = upstreams(e.ctx).store;
  const ups = {
    personal: await fake({ auth: { kind: "oauth" }, tools: notionTools("personal") }),
    work: await fake({ auth: { kind: "oauth" }, tools: notionTools("work") }),
    whoop: await fake({
      auth: { kind: "bearer", token: "whoop-dashboard-key" },
      tools: [{ name: "get_status", description: "Recovery, sleep and strain today.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, handler: ok("whoop status") }],
    }),
    brightspace: await fake({
      auth: { kind: "bearer", token: "brightspace-key" },
      tools: [
        { name: "get_my_courses", description: "Your enrolled courses.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, handler: ok("courses") },
        { name: "check_auth", description: "Checks whether you're logged in.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, handler: ok("auth ok") },
      ],
    }),
  };
  const ids = {
    personal: insertConnection(e.ctx, { slug: "notion-personal", name: "Notion (personal)", preset: "notion", url: ups.personal.url, authType: "oauth", privateTarget: ups.personal.origin }),
    work: insertConnection(e.ctx, { slug: "notion-work", name: "Notion (work)", preset: "notion", url: ups.work.url, authType: "oauth", privateTarget: ups.work.origin }),
    whoop: insertConnection(e.ctx, { slug: "whoop", name: "WHOOP dashboard", preset: null, url: ups.whoop.url, authType: "header", privateTarget: ups.whoop.origin }),
    brightspace: insertConnection(e.ctx, { slug: "brightspace", name: "Brightspace", preset: null, url: ups.brightspace.url, authType: "header", privateTarget: ups.brightspace.origin }),
  };
  // OAuth tokens from each Notion workspace (a refresh token, an hour left), the Notion cap 140 days out.
  const tokens: Record<"personal" | "work", string> = { personal: "", work: "" };
  for (const k of ["personal", "work"] as const) {
    const t = ups[k].oauth!.issueTokens();
    tokens[k] = t.access_token;
    store.saveConsent(
      ids[k],
      { client_id: "fake-client", issuer: ups[k].oauth!.issuer, resource: ups[k].url, source: "pre_registered" },
      { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: Date.now() + 3_600_000, scope: null, issuer: ups[k].oauth!.issuer },
    );
    e.ctx.db.run("UPDATE connections SET expires_at = ? WHERE id = ?", new Date(Date.now() + 140 * DAY).toISOString(), ids[k]);
  }
  store.setHeader(ids.whoop, "Authorization", "Bearer whoop-dashboard-key");
  store.setHeader(ids.brightspace, "Authorization", "Bearer brightspace-key");
  grant(e.ctx, e.agent.id, ids.personal, "ask");
  grant(e.ctx, e.agent.id, ids.work, "read");
  grant(e.ctx, e.agent.id, ids.whoop, "read");
  grant(e.ctx, e.agent.id, ids.brightspace, "ask");
  for (const id of Object.values(ids)) await refresh(e, id);
  // An "always allow" rule from before (made after the tool was listed): deleting this one page never asks.
  addRule(e.ctx.db, { agentId: e.agent.id, connectionId: ids.personal, tool: "notion-delete-pages", targetPath: "/page_ids", targetValue: '"p-keep"' });
  // A call waiting for approval from before the upgrade.
  const c = await e.client();
  const pending = approvalId(text(await c.callTool({ name: "notion-personal__notion-delete-pages", arguments: { page_ids: ["p-pending"] } })));
  return { ups, ids, tokens, pending };
}

type Wynn = Awaited<ReturnType<typeof wynnInstall>>;

async function refresh(e: Env, id: string) {
  const r = await e.ctx.broker.catalog.refresh(id);
  if (r.ok) return;
  // Not attached yet (created behind the API's back): attach, which lists.
  e.ctx.broker.attach(id);
  expect(await e.ctx.broker.catalog.refresh(id)).toMatchObject({ ok: true });
}

/** Everything the upgrade must leave alone, byte for byte (`approvals`: the ones that existed before it). */
function snapshot(ctx: AppContext, approvals: string[] = []) {
  return {
    connections: ctx.db.all("SELECT id, kind, preset, slug, name, url, auth_type, level_default, all_agents, private_target, status, status_reason, expires_at FROM connections ORDER BY id"),
    credentials: ctx.db.all("SELECT * FROM connection_credentials ORDER BY connection_id"),
    grants: ctx.db.all("SELECT agent_id, connection_id, level FROM connection_grants ORDER BY connection_id"),
    rules: ctx.db.all("SELECT id, agent_id, connection_id, tool, target_path, target_value FROM approval_rules ORDER BY id"),
    approvals: ctx.db.all(`SELECT id, agent_id, connection_id, kind, status, payload, tool_call FROM approvals WHERE id IN (${approvals.map(() => "?").join(", ") || "NULL"}) ORDER BY id`, ...approvals),
    exposed: ctx.db.all("SELECT connection_id, name, exposed_name FROM upstream_tools ORDER BY exposed_name"),
  };
}

const ALL_NOTION = ["notion-delete-pages", "notion-move-pages", "notion-search", "notion-spawn-session", ...HIDDEN_READS];
const EXPOSED = [
  "brightspace__check_auth",
  "brightspace__get_my_courses",
  ...ALL_NOTION.map((n) => `notion-personal__${n}`),
  // Read only: Notion's reads, all of them, and nothing else.
  ...["notion-search", ...HIDDEN_READS].map((n) => `notion-work__${n}`),
  "whoop__get_status",
].sort();

const authHeaders = (up: FakeMcpUpstream) => new Set(up.requests.filter((r) => r.rpcMethod === "tools/call").map((r) => r.headers.authorization));

/**
 * All four list their tools under the same names, Notion's rules hold (spawning a Custom Agent asks, its reads are
 * listed at Read only, moving pages is a write), and calls reach each server with its own unchanged credential.
 */
async function allFourWork(e: Env, w: Wynn) {
  const c = await e.client();
  const listed = (await c.listTools()).tools.map((t) => t.name).filter((n) => n.includes("__"));
  expect(listed.sort()).toEqual(EXPOSED);
  expect(text(await c.callTool({ name: "notion-personal__notion-search", arguments: { query: "plans" } }))).toContain('personal search {"query":"plans"}');
  expect(text(await c.callTool({ name: "notion-work__notion-search", arguments: { query: "okrs" } }))).toContain('work search {"query":"okrs"}');
  for (const name of HIDDEN_READS) expect(text(await c.callTool({ name: `notion-work__${name}`, arguments: {} }))).toContain(`work ${name}`);
  expect(text(await c.callTool({ name: "notion-personal__notion-move-pages", arguments: { page_ids: ["p1"], parent: "p0" } }))).toContain("personal moved");
  expect(text(await c.callTool({ name: "notion-personal__notion-spawn-session", arguments: { agent_url: "a1", message: "go" } }))).toContain("pending_approval");
  expect(text(await c.callTool({ name: "whoop__get_status", arguments: {} }))).toContain("whoop status");
  expect(text(await c.callTool({ name: "brightspace__get_my_courses", arguments: {} }))).toContain("courses");
  // The always-allow rule still lets its one target through at "ask".
  expect(text(await c.callTool({ name: "notion-personal__notion-delete-pages", arguments: { page_ids: ["p-keep"] } }))).toContain("personal deleted");
  // The same credentials: each server saw only its own token.
  expect(authHeaders(w.ups.personal)).toEqual(new Set([`Bearer ${w.tokens.personal}`]));
  expect(authHeaders(w.ups.work)).toEqual(new Set([`Bearer ${w.tokens.work}`]));
  expect(authHeaders(w.ups.whoop)).toEqual(new Set(["Bearer whoop-dashboard-key"]));
  expect(authHeaders(w.ups.brightspace)).toEqual(new Set(["Bearer brightspace-key"]));
  return c;
}

/** No re-auth state anywhere: every connection active, no auth failure, no sign-in started, no token request. */
function noReauth(e: Env, w: Wynn) {
  expect(e.ctx.db.all("SELECT slug, status FROM connections WHERE status <> 'active'")).toEqual([]);
  expect(e.ctx.db.all("SELECT type FROM events WHERE type = 'connection.auth_failed'")).toEqual([]);
  expect(e.ctx.db.all("SELECT state FROM oauth_states WHERE connection_id IS NOT NULL")).toEqual([]);
  for (const up of [w.ups.personal, w.ups.work]) expect(up.requests.filter((r) => r.server === "auth" && r.path.endsWith("/token"))).toEqual([]);
}

/** The approval from before the upgrade still runs, once, on the same credential. */
async function approvePending(e: Env, w: Wynn) {
  expect(await json(await e.api(`/approvals/${w.pending}/approve`, { method: "POST", json: {} }))).toMatchObject({ status: "sent" });
  const deletes = w.ups.personal.requests.filter((r) => r.rpcMethod === "tools/call" && r.body.includes("p-pending"));
  expect(deletes).toHaveLength(1);
  expect(deletes[0]!.headers.authorization).toBe(`Bearer ${w.tokens.personal}`);
}

describe("upgrade to extensions: Wynn's install, no re-auth", () => {
  it("the fixture exercises the gap: the generic rules alone would loosen spawning and hide five reads", () => {
    const def = (t: FakeTool): ToolDef => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? {}, ...(t.annotations ? { annotations: t.annotations } : {}) });
    const tools = notionTools("x");
    const generic = (name: string) => classifyTool(def(tools.find((t) => t.name === name)!), null);
    expect(generic("notion-spawn-session")).toMatchObject({ risky: false });
    for (const name of HIDDEN_READS) expect(generic(name), name).toMatchObject({ read: false });
    expect(generic("notion-move-pages")).toMatchObject({ risky: false, read: false });
  });

  it("not yet installed: bound connections keep Notion's rules through the bootstrap snapshot; then the install takes over", async () => {
    const e = await env();
    const w = await wynnInstall(e);
    const before = snapshot(e.ctx, [w.pending]);
    await allFourWork(e, w);

    // xaq is updated: the Notion preset left core, and its extension isn't installed yet.
    const store = stubExtensionStore({ installable: ["notion"], hold: true });
    const up = e.upgrade(store);
    expect(up.bound).toEqual([
      { connectionId: w.ids.personal, extension: "notion" },
      { connectionId: w.ids.work, extension: "notion" },
    ]);
    expect(up.missing).toEqual(["notion"]);
    expect(store.installs).toEqual([PINS[0]]);
    // The snapshot serves the bound connections only: Add connection doesn't offer it.
    expect(presets().map((p) => p.id)).not.toContain("notion");
    expect((await json(await e.api("/connections/presets"))).map((p: { id: string }) => p.id)).not.toContain("notion");
    expect((await e.api("/connections", { method: "POST", json: { preset: "notion" } })).status).toBe(400);
    for (const id of Object.values(w.ids)) await refresh(e, id);

    // The same names and credentials, and Notion's rules: nothing got looser.
    await allFourWork(e, w);
    noReauth(e, w);
    expect(snapshot(e.ctx, [w.pending])).toEqual(before);

    // The background install finishes: the installed extension takes over (re-listed under its manifest).
    store.release();
    await up.done;
    expect(presets().map((p) => p.id)).toContain("notion");
    for (const id of Object.values(w.ids)) await refresh(e, id);
    await allFourWork(e, w);
    noReauth(e, w);
    expect(snapshot(e.ctx, [w.pending])).toEqual(before);
    expect((await json(await e.api(`/connections/${w.ids.personal}`))).preset).toBe("notion");
    await approvePending(e, w);
  }, 30_000);

  it("already installed: nothing to install, the manifest's rules apply at once, nothing else changes", async () => {
    const e = await env();
    const w = await wynnInstall(e);
    const before = snapshot(e.ctx, [w.pending]);
    const store = stubExtensionStore({ installed: ["notion", "t3code", "brightspace"] });
    const up = e.upgrade(store);
    expect(up.missing).toEqual([]);
    await up.done;
    expect(store.installs).toEqual([]);
    for (const id of Object.values(w.ids)) await refresh(e, id);
    await allFourWork(e, w);
    // A generic connection stays generic even with a same-named extension installed: whoop and brightspace have no preset.
    expect(e.ctx.db.all("SELECT slug, preset FROM connections WHERE preset IS NULL ORDER BY slug")).toEqual([
      { slug: "brightspace", preset: null },
      { slug: "whoop", preset: null },
    ]);
    noReauth(e, w);
    expect(snapshot(e.ctx, [w.pending])).toEqual(before);
    await approvePending(e, w);
  }, 30_000);

  it("a failed or unpinned install leaves the connections on the snapshot, working", async () => {
    const e = await env();
    const w = await wynnInstall(e);
    const before = snapshot(e.ctx, [w.pending]);
    const failing = stubExtensionStore({ installable: [] });
    const up = e.upgrade(failing);
    await up.done;
    expect(failing.installs.map((p) => p.name)).toEqual(["notion"]);
    for (const id of Object.values(w.ids)) await refresh(e, id);
    await allFourWork(e, w);
    // Placeholder pins install nothing (no fetch for an all-zero commit).
    const placeholder = stubExtensionStore({ installable: ["notion"] });
    const zero = (name: string): ExtensionPin => ({ name, commit: "0".repeat(40), integrity: `sha256-${"A".repeat(43)}=` });
    await e.ctx.broker.upgradeExtensions(placeholder, ["notion", "t3code", "whoop", "brightspace"].map(zero)).done;
    expect(placeholder.installs).toEqual([]);
    noReauth(e, w);
    expect(snapshot(e.ctx, [w.pending])).toEqual(before);
    await approvePending(e, w);
  }, 30_000);

  it("bound to an extension with neither an install nor a snapshot: generic rules, and a reconnect waits for the install", async () => {
    const e = await env();
    const bs = await fake({ auth: { kind: "bearer", token: "k" }, tools: [] });
    const id = insertConnection(e.ctx, { slug: "bs", name: "Brightspace", preset: "brightspace", url: bs.url, authType: "header", privateTarget: bs.origin });
    e.upgrade(stubExtensionStore({}));
    const r = await json(await e.api(`/connections/${id}/connect`, { method: "POST", json: {} }));
    expect(r).toMatchObject({ status: "error" });
    expect(r.message).toMatch(/brightspace extension isn't installed yet/);
  });
});

describe("the extension store's hooks (startup wiring)", () => {
  it("presets() reads B1's store; usedBy is the bound connections; install, forced remove and stop are reflected", async () => {
    const e = await env();
    const work = mkdtempSync(join(tmpdir(), "xaq-b2-hooks-"));
    cleanup.push(async () => rmSync(work, { recursive: true, force: true }));
    // Startup: the broker registers this context's store with presets() and fills its hooks.
    void e.ctx.broker.start?.();
    const store = extensionStore(e.ctx);
    expect(presetSource()).toBe(store);
    expect(presetById("bs-dev")).toBeNull();

    // An install (a local copy of the Brightspace manifest: third-party, so under another name) reloads presets()
    // through onChange.
    const dir = writeTree(join(work, "bs-dev"), { "xaq-extension.json": JSON.stringify({ ...fixtureManifest("brightspace"), name: "bs-dev", slug: "bs-dev" }) });
    await store.install(dir, { confirmThirdParty: true });
    expect(presetById("bs-dev")).toMatchObject({ id: "bs-dev", auth: { type: "header" }, official: false });

    // A connection bound to it: usedBy names it, and a plain remove is refused.
    const id = insertConnection(e.ctx, { slug: "bs", name: "Brightspace", preset: "bs-dev", url: "http://127.0.0.1:8787/mcp", authType: "header", privateTarget: "http://127.0.0.1:8787" });
    upstreams(e.ctx).store.setHeader(id, "Authorization", "Bearer kept");
    expect(store.usedBy("bs-dev")).toEqual([id]);
    await expect(store.remove("bs-dev", { force: false })).rejects.toMatchObject({ code: "in_use" });
    // Forced: the connection is disabled, its credential stays (until the connection is removed), the preset goes.
    await store.remove("bs-dev", { force: true });
    // Unbound too (preset cleared): a later extension of that name, say a third-party one, can't take it over.
    expect(e.ctx.db.get("SELECT status, status_reason, preset FROM connections WHERE id = ?", id)).toEqual({ status: "disabled", status_reason: "its extension bs-dev was removed", preset: null });
    expect(store.usedBy("bs-dev")).toEqual([]);
    expect(upstreams(e.ctx).store.header(id)).toEqual({ name: "Authorization", value: "Bearer kept" });
    expect(presetById("bs-dev")).toBeNull();

    // Stopping the broker unregisters its store.
    await e.ctx.broker.stop?.();
    expect(presetSource()).toBeNull();
  }, 30_000);

  it("a forced remove of an official extension keeps its connections bound: re-adding it brings the same gating back", async () => {
    const e = await env();
    const gh = await startFakeGithub();
    cleanup.push(() => gh.close());
    const work = mkdtempSync(join(tmpdir(), "xaq-b2-official-"));
    cleanup.push(async () => rmSync(work, { recursive: true, force: true }));
    // The official notion extension, published in the (fake) xaq-extensions repo.
    const dir = writeTree(join(work, "notion"), { "xaq-extension.json": readFileSync(new URL("./fixtures/extensions/notion/xaq-extension.json", import.meta.url), "utf8") });
    const sha = fakeSha("notion-official");
    gh.commit("wynn-dev", "xaq-extensions", "main", sha, entriesFromDir(dir, "extensions/notion"));
    const pin = { name: "notion", commit: sha, integrity: computeIntegrity(dir) };
    const store = extensionStore(e.ctx, { urls: gh.urls });
    void e.ctx.broker.start?.();
    await store.installPinned(pin);
    const id = insertConnection(e.ctx, { slug: "notion-personal", name: "Notion", preset: "notion", url: "https://mcp.notion.com/mcp", authType: "oauth", privateTarget: "http://127.0.0.1:1" });
    const spawn: ToolDef = { name: "notion-spawn-session", description: "Start a session with a Custom Agent.", inputSchema: { type: "object", properties: {} } };
    expect(presetById("notion")!.classify(spawn)).toMatchObject({ risky: true });

    // Forced: disabled, but still bound (an official name can't be taken by a third party).
    await store.remove("notion", { force: true });
    expect(e.ctx.db.get("SELECT status, preset FROM connections WHERE id = ?", id)).toEqual({ status: "disabled", preset: "notion" });
    expect(presetById("notion")).toBeNull();

    // Re-added: the connection is the extension's again, with spawning gated as before.
    await store.installPinned(pin);
    expect(store.usedBy("notion")).toEqual([id]);
    expect(presetById("notion")!.classify(spawn)).toMatchObject({ risky: true, source: "preset" });
    expect(classifyTool(spawn, boundPreset("notion"))).toMatchObject({ risky: true });
    await e.ctx.broker.stop?.();
  }, 30_000);
});

describe("a new connection from a remote extension", () => {
  it("Brightspace: the user names the server, connects with its bearer token, and the manifest classifies its tools", async () => {
    const bs = await fake({
      auth: { kind: "bearer", token: "bs-token" },
      tools: [
        { name: "get_my_courses", description: "Your enrolled courses.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, handler: ok("courses") },
        { name: "check_auth", description: "Checks whether you're logged in.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, handler: ok("auth ok") },
      ],
    });
    const e = await env();
    e.upgrade(stubExtensionStore({ installed: ["brightspace"] }));
    const created = await e.api("/connections", { method: "POST", json: { preset: "brightspace", url: bs.origin, agentIds: [e.agent.id], levelDefault: "read" } });
    expect(created.status).toBe(201);
    const con = await json(created);
    expect(con).toMatchObject({ preset: "brightspace", url: bs.url, authType: "header", slug: "brightspace-127-0-0" });
    await e.api(`/connections/${con.id}/private-target`, { method: "PUT", json: { allow: true } });
    expect(await json(await e.api(`/connections/${con.id}/connect`, { method: "POST", json: { header: { name: "Authorization", value: "Bearer bs-token" } } }))).toMatchObject({ status: "connected" });
    await refresh(e, con.id);
    // At Read only: the data tools are listed; check_auth (it can start a sign-in with MFA) isn't.
    const c = await e.client();
    const names = (await c.listTools()).tools.map((t) => t.name).filter((n) => n.includes("__"));
    expect(names).toEqual(["brightspace-127-0-0__get_my_courses"]);
    expect(text(await c.callTool({ name: "brightspace-127-0-0__get_my_courses", arguments: {} }))).toContain("courses");
    expect(authHeaders(bs)).toEqual(new Set(["Bearer bs-token"]));
  }, 30_000);
});

describe("upgrade to extensions: T3 Code", () => {
  it("a T3 connection made by today's core preset keeps working once bound to the manifest extension", async () => {
    const t3 = await fake({
      protocol: "streamable-2025",
      auth: { kind: "oauth", refreshGrant: false, accessTokenTtlSec: 2_592_000, scopesSupported: ["orchestration:read", "orchestration:operate"] },
      spaFallback: true,
      tools: [
        { name: "t3_project_list", description: "List projects.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, handler: ok("projects") },
        {
          name: "t3_thread_send",
          description: "Send a message to a T3 thread.",
          inputSchema: { type: "object", properties: { threadId: { type: "string" }, message: { type: "string" } } },
          annotations: { destructiveHint: true },
          handler: ok("queued"),
        },
        {
          name: "t3_project_delete",
          description: "Delete a project.",
          inputSchema: { type: "object", properties: { projectId: { type: "string" } } },
          annotations: { destructiveHint: true },
          handler: ok("deleted"),
        },
      ],
    });
    const e = await env();
    // Made with today's core preset: the API, the private allow, a real sign-in (DCR, PKCE, same-origin).
    const created = await e.api("/connections", { method: "POST", json: { preset: "t3code", url: t3.origin, agentIds: [e.agent.id], levelDefault: "ask" } });
    expect(created.status).toBe(201);
    const con = await json(created);
    await e.api(`/connections/${con.id}/private-target`, { method: "PUT", json: { allow: true } });
    const started = await json(await e.api(`/connections/${con.id}/connect`, { method: "POST", json: {} }));
    const cb = await t3.oauth!.followAuthorize(started.authorizeUrl);
    expect((await e.h.request(`${cb.pathname}${cb.search}`)).status).toBe(200);
    await refresh(e, con.id);
    const token = (await json(await e.api(`/connections/${con.id}`))) as { expiresAt: string; slug: string };
    // From before the upgrade: an always-allow rule for deleting one project, and a delete waiting for approval.
    addRule(e.ctx.db, { agentId: e.agent.id, connectionId: con.id, tool: "t3_project_delete", targetPath: "/projectId", targetValue: '"p-keep"' });
    const send = (c: Client) => c.callTool({ name: `${con.slug}__t3_thread_send`, arguments: { threadId: "th1", message: "hi" } });
    const del = (c: Client, projectId: string) => c.callTool({ name: `${con.slug}__t3_project_delete`, arguments: { projectId } });
    const c0 = await e.client();
    expect(text(await send(c0))).toContain("queued");
    const pending = approvalId(text(await del(c0, "p-pending")));
    const before = snapshot(e.ctx, [pending]);

    // Updated xaq, extension not installed yet: the bootstrap snapshot keeps T3's table and exemptions (the send goes
    // through, deleting asks unless the rule covers it), with the same names and the same sign-in.
    const store = stubExtensionStore({ installable: ["t3code"], hold: true });
    const up = e.upgrade(store);
    expect(up.bound).toEqual([{ connectionId: con.id, extension: "t3code" }]);
    await refresh(e, con.id);
    const c1 = await e.client();
    expect((await c1.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith(`${con.slug}__`)).sort()).toEqual(
      [`${con.slug}__t3_project_delete`, `${con.slug}__t3_project_list`, `${con.slug}__t3_thread_send`].sort(),
    );
    expect(text(await c1.callTool({ name: `${con.slug}__t3_project_list`, arguments: {} }))).toContain("projects");
    expect(text(await send(c1))).toContain("queued");
    expect(text(await del(c1, "p-keep"))).toContain("deleted");
    expect(text(await del(c1, "p-other"))).toContain("pending_approval");
    expect(snapshot(e.ctx, [pending])).toEqual(before);

    // Installed: the manifest's table and exemptions apply, on the same credential.
    store.release();
    await up.done;
    await refresh(e, con.id);
    const c2 = await e.client();
    expect(text(await send(c2))).toContain("queued");
    expect(text(await del(c2, "p-keep"))).toContain("deleted");
    expect(text(await del(c2, "p1"))).toContain("pending_approval");
    expect(snapshot(e.ctx, [pending])).toEqual(before);
    expect(new Set(t3.requests.filter((r) => r.rpcMethod === "tools/call").map((r) => r.headers.authorization)).size).toBe(1);
    const after = await json(await e.api(`/connections/${con.id}`));
    expect(after).toMatchObject({ status: "active", expired: false, expiresAt: token.expiresAt, slug: token.slug, preset: "t3code" });
    // The approval from before runs once.
    expect(await json(await e.api(`/approvals/${pending}/approve`, { method: "POST", json: {} }))).toMatchObject({ status: "sent" });
    expect(t3.requests.filter((r) => r.rpcMethod === "tools/call" && r.body.includes("p-pending"))).toHaveLength(1);
  }, 30_000);

  it("never installed: a T3 connection still reconnects, under the snapshot's same-origin sign-in, before its 30 days run out", async () => {
    const t3 = await fake({
      protocol: "streamable-2025",
      auth: { kind: "oauth", refreshGrant: false, accessTokenTtlSec: 2_592_000, scopesSupported: ["orchestration:read"] },
      spaFallback: true,
      tools: [{ name: "t3_project_list", description: "List projects.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, handler: ok("projects") }],
    });
    const e = await env();
    const con = await json(await e.api("/connections", { method: "POST", json: { preset: "t3code", url: t3.origin, agentIds: [] } }));
    await e.api(`/connections/${con.id}/private-target`, { method: "PUT", json: { allow: true } });
    const first = await json(await e.api(`/connections/${con.id}/connect`, { method: "POST", json: {} }));
    const cb = await t3.oauth!.followAuthorize(first.authorizeUrl);
    expect((await e.h.request(`${cb.pathname}${cb.search}`)).status).toBe(200);
    // The install fails for good; the connection nears its expiry.
    await e.upgrade(stubExtensionStore({ installable: [] })).done;
    expect(snapshotPreset("t3code")).toMatchObject({ userServer: { defaultPath: "/mcp", sameOriginIssuer: true }, reconnectPolicy: { tokenLifetimeCapDays: 30 } });
    e.ctx.db.run("UPDATE connections SET expires_at = ? WHERE id = ?", new Date(Date.now() + 2 * DAY).toISOString(), con.id);
    // Reconnect works: a new sign-in on T3's own origin, and the connection is good for another 30 days.
    const again = await json(await e.api(`/connections/${con.id}/connect`, { method: "POST", json: {} }));
    expect(again).toMatchObject({ status: "authorize" });
    expect(new URL(again.authorizeUrl).origin).toBe(t3.origin);
    const cb2 = await t3.oauth!.followAuthorize(again.authorizeUrl);
    expect((await e.h.request(`${cb2.pathname}${cb2.search}`)).status).toBe(200);
    const view = await json(await e.api(`/connections/${con.id}`));
    expect(view).toMatchObject({ status: "active", expiresInDays: 29 });
  }, 30_000);

  it("the manifest's 30-day cap: a T3 that hands out longer tokens still expires (and warns) at 30 days", async () => {
    const t3 = await fake({
      protocol: "streamable-2025",
      auth: { kind: "oauth", refreshGrant: false, accessTokenTtlSec: 90 * 86_400, scopesSupported: ["orchestration:read"] },
      spaFallback: true,
      tools: [{ name: "t3_project_list", description: "List projects.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, handler: ok("projects") }],
    });
    const e = await env();
    e.upgrade(stubExtensionStore({ installed: ["t3code"] }));
    const con = await json(await e.api("/connections", { method: "POST", json: { preset: "t3code", url: t3.origin, agentIds: [] } }));
    await e.api(`/connections/${con.id}/private-target`, { method: "PUT", json: { allow: true } });
    const started = await json(await e.api(`/connections/${con.id}/connect`, { method: "POST", json: {} }));
    const cb = await t3.oauth!.followAuthorize(started.authorizeUrl);
    expect((await e.h.request(`${cb.pathname}${cb.search}`)).status).toBe(200);
    const view = await json(await e.api(`/connections/${con.id}`));
    expect(view.expiresInDays).toBe(29);
    expect((Date.parse(view.expiresAt) - Date.now()) / DAY).toBeLessThanOrEqual(30);
    // And Full access scopes would be flagged: the view carries the manifest's broad scopes.
    expect(view.broadScopes).toEqual(["settings:write", "source-control:write"]);
  }, 30_000);
});
