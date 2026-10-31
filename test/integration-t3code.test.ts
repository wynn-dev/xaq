// The T3 Code extension (xaq-extensions extensions/t3code, a fixture copy, through presetFromManifest): the risk table
// keyed on T3's real tool names, the http-private-only rule at every step of the OAuth flow, DCR/PKCE/iss against a
// T3-like fake, extra scopes, the 30-day expiry without refresh (warnings, the expired state and the agent's message,
// Reconnect keeping grants and pins), and several T3 servers as separate, uniquely named connections. Offline: fakes
// on 127.0.0.1, fake DNS.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { classifyTool } from "../server/broker/catalog/classify.ts";
import { reconnectMessage } from "../server/broker/policy/errors.ts";
import { type IntegrationPreset, SourceError, type ToolDef } from "../server/broker/types.ts";
import { checkTarget, guardedFetch } from "../server/broker/upstream/fetch.ts";
import { requireSameOrigin, UpstreamRuntime, upstreams } from "../server/broker/upstream/runtime.ts";
import { presetById, presets } from "../server/integrations/index.ts";
import { presetServerUrl } from "../server/integrations/user-server.ts";
import { hostSlugPart, presetServerSlug } from "../shared/user-server.ts";
import type { LookupFn } from "../server/util/ssrf.ts";
import { type FakeMcpUpstream, type FakeTool, startFakeMcpUpstream } from "./fake-mcp-upstream.ts";
import { fixtureManifest, useFixtureExtensions } from "./extension-fixtures.ts";
import { testContext } from "./helpers.ts";
import { CSRF, harness, json } from "./platform-helpers.ts";

afterAll(useFixtureExtensions());
const t3codePreset = presetById("t3code")!;
const classifyT3Tool = (t: ToolDef) => t3codePreset.classify(t);
const T3_MANIFEST = fixtureManifest("t3code");
const T3_TOOLS = Object.fromEntries(Object.entries(T3_MANIFEST.risk!.tools).map(([name, e]) => [name, { cls: e.class }]));
const T3_NAME_CHECK_EXEMPT = T3_MANIFEST.risk!.nameCheckExempt!;

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  cleanup = [];
});

const DAY = 86_400_000;
const THIRTY_DAYS_SEC = 2_592_000;

// ───────────────────────────── the risk table ─────────────────────────────

// T3's 83 tools as a live server listed them (t3@nightly 0.1.1-nightly.20261016.3218), written out independently of
// T3_TOOLS so a change to the table shows up here.
const READ = [
  "orchestrator_capabilities",
  "t3_project_list",
  "t3_project_read",
  "t3_environment_read",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_search",
  "t3_thread_wait",
  "t3_thread_transfers",
  "t3_thread_configuration",
  "t3_pending_request_list",
  "t3_pending_request_read",
  "t3_queue_list",
  "t3_queue_read",
  "t3_worktree_status",
  "t3_worktree_list",
  "t3_preview_list",
  "list_scheduled_tasks",
  "task_status",
  "list_thread_pull_requests",
  "read_pull_request_guide",
  "device_list",
  "device_screenshot",
  "preview_status",
  "preview_snapshot",
  "preview_wait_for",
];
const THREAD_WRITES = [
  "t3_thread_launch",
  "create_threads",
  "t3_thread_send",
  "t3_thread_send_attachments",
  "t3_attachment_prepare_upload",
  "t3_attachment_discard",
  "t3_thread_interrupt",
  "t3_thread_fork",
  "t3_thread_merge_back",
  "t3_thread_update",
  "t3_thread_organize",
  "t3_thread_configure",
  "t3_pending_request_respond",
  "t3_queue_edit",
  "t3_queue_cancel",
  "t3_queue_reorder",
  "t3_queue_promote_to_steer",
  "delegate_task",
  "task_cancel",
  "t3_workflow_stop",
  "request_secret",
  "run_scheduled_task_now",
];
const OTHER_WRITES = [
  "t3_project_create",
  "t3_project_clone",
  "t3_worktree_handoff",
  "link_pull_request",
  "unlink_pull_request",
  "watch_pull_request",
  "unwatch_pull_request",
  "write_pull_request_guides",
  "preview_open",
  "preview_navigate",
  "preview_resize",
  "preview_set_appearance",
  "preview_click",
  "preview_type",
  "preview_hover",
  "preview_select",
  "preview_drag",
  "preview_press",
  "preview_scroll",
  "preview_dialog",
  "preview_recording_start",
  "preview_recording_stop",
  "t3_preview_close",
  "device_open",
  "device_close",
  "html_render",
  "html_preview",
];
const RISKY_DELETE = ["t3_project_delete", "delete_scheduled_task"];
const RISKY_SETTINGS = ["t3_environment_preferences_update", "t3_project_update"];
// The browser preview runs in the user's profile with its saved logins: page JavaScript and file uploads send data out as them.
const RISKY_BROWSER = ["preview_evaluate", "preview_upload"];
const RISKY_OTHER = ["schedule_task", "update_scheduled_task"];

/** A tool as T3 lists it: reads readOnlyHint, everything else destructiveHint (as T3 does). */
const t3Tool = (name: string, properties: Record<string, unknown> = {}): ToolDef => ({
  name,
  description: `T3 tool ${name}.`,
  inputSchema: { type: "object", properties },
  annotations: READ.includes(name) ? { readOnlyHint: true, destructiveHint: false } : { readOnlyHint: false, destructiveHint: true },
});

describe("T3 Code extension: shape and risk table", () => {
  it("is registered, user-named, same-origin OAuth, no fixed URL, a 30-day cap, Full access scopes named broad", () => {
    expect(presets()).toContain(t3codePreset);
    expect(t3codePreset).toMatchObject({
      id: "t3code",
      displayName: "T3 Code",
      slug: "t3",
      kind: "remote_http",
      userServer: { defaultPath: "/mcp", sameOriginIssuer: true },
      auth: { type: "mcp_oauth", broadScopes: ["settings:write", "source-control:write"] },
      reconnectPolicy: { tokenLifetimeCapDays: 30 },
    });
    expect(t3codePreset.url).toBeUndefined();
  });

  it("covers exactly T3's 83 tools", () => {
    const all = [...READ, ...THREAD_WRITES, ...OTHER_WRITES, ...RISKY_DELETE, ...RISKY_SETTINGS, ...RISKY_BROWSER, ...RISKY_OTHER].sort();
    expect(new Set(all).size).toBe(83);
    expect(Object.keys(T3_TOOLS).sort()).toEqual(all);
  });

  it.each(READ)("read (free, listed at read only): %s", (name) => {
    expect(classifyTool(t3Tool(name), t3codePreset)).toEqual({ risky: false, read: true, source: "preset" });
  });

  it.each(THREAD_WRITES)("thread work, a normal write despite T3's destructiveHint: %s", (name) => {
    expect(classifyTool(t3Tool(name), t3codePreset)).toEqual({ risky: false, read: false, source: "preset" });
  });

  it.each(OTHER_WRITES)("projects, worktrees, pull requests, previews: a normal write: %s", (name) => {
    expect(classifyTool(t3Tool(name), t3codePreset)).toEqual({ risky: false, read: false, source: "preset" });
  });

  it.each([...RISKY_DELETE, ...RISKY_SETTINGS, ...RISKY_BROWSER, ...RISKY_OTHER])("risky (asks at the ask level): %s", (name) => {
    expect(classifyTool(t3Tool(name), t3codePreset)).toMatchObject({ risky: true, read: false, source: "preset" });
  });

  it("preview_evaluate (JavaScript in the user's signed-in browser profile) asks; the other preview actions don't", () => {
    const evaluate = { ...t3Tool("preview_evaluate", { tabId: {}, expression: {} }), description: "Evaluate JavaScript in the tab." };
    expect(classifyTool(evaluate, t3codePreset)).toEqual({ risky: true, read: false, source: "preset" });
    expect(classifyT3Tool(evaluate)).toEqual({ risky: true, read: false, source: "preset" });
    for (const name of ["preview_open", "preview_navigate", "preview_click", "preview_type"]) expect(classifyTool(t3Tool(name), t3codePreset).risky, name).toBe(false);
    const steps = t3codePreset.setupSteps({ publicUrl: "http://x", redirectUri: "http://x/cb" });
    expect(steps.find((s) => s.id === "access")!.body).toMatch(/browser profile on that computer with its saved logins/);
  });

  it("targets for always-allow come from the tool's own id argument", () => {
    expect(classifyT3Tool(t3Tool("t3_project_delete", { projectId: {}, force: {} }))?.targetPath).toBe("/projectId");
    expect(classifyT3Tool(t3Tool("t3_project_update", { projectId: {} }))?.targetPath).toBe("/projectId");
    expect(classifyT3Tool(t3Tool("delete_scheduled_task", { scheduledTaskId: {} }))?.targetPath).toBe("/scheduledTaskId");
    expect(classifyT3Tool(t3Tool("t3_project_delete", {}))?.targetPath).toBeUndefined();
    expect(classifyT3Tool(t3Tool("t3_thread_send", { threadId: {} }))?.targetPath).toBeUndefined();
  });

  it("the name-check exemption covers exactly the reviewed names; everything else still gets it", () => {
    expect([...T3_NAME_CHECK_EXEMPT].sort()).toEqual(["t3_thread_merge_back", "t3_thread_send", "t3_thread_send_attachments"]);
    // Every non-risky table entry whose name has a risky verb is in the exemption, and nothing else is.
    const verbHits = Object.entries(T3_TOOLS)
      .filter(([, s]) => s.cls !== "risky")
      .map(([name]) => name)
      .filter((name) => classifyTool({ name, description: "", inputSchema: {} }).risky);
    expect(verbHits.sort()).toEqual([...T3_NAME_CHECK_EXEMPT].sort());
    // A preset without the exemption saying "write" for a send tool can't make it safe.
    const lenient: Pick<IntegrationPreset, "classify"> = { classify: () => ({ risky: false, read: false, source: "preset" }) };
    expect(classifyTool({ name: "t3_thread_send", description: "", inputSchema: {} }, lenient).risky).toBe(true);
  });

  it("unknown tools (a newer T3) fall back to the generic rules", () => {
    expect(classifyT3Tool(t3Tool("t3_thread_delete"))).toBeNull();
    // Deleting a thread, removing a worktree: risky by the verb list even with readOnlyHint claimed.
    for (const name of ["t3_thread_delete", "t3_worktree_remove"]) {
      expect(classifyTool({ name, description: "", inputSchema: {}, annotations: { readOnlyHint: true } }, t3codePreset)).toMatchObject({ risky: true, read: false });
    }
    // T3 marks its writes destructive: an unknown one asks; an unknown read stays a read.
    expect(classifyTool({ name: "t3_thread_pin", description: "", inputSchema: {}, annotations: { destructiveHint: true } }, t3codePreset)).toMatchObject({ risky: true, source: "annotation" });
    expect(classifyTool({ name: "t3_label_list", description: "", inputSchema: {}, annotations: { readOnlyHint: true } }, t3codePreset)).toEqual({ risky: false, read: true, source: "annotation" });
    expect(classifyT3Tool(t3Tool("toString"))).toBeNull();
    expect(classifyT3Tool(t3Tool("__proto__"))).toBeNull();
  });

  it("setup steps say where the pairing code comes from, what the levels mean, and the 30 days", () => {
    const steps = t3codePreset.setupSteps({ publicUrl: "http://127.0.0.1:8425", redirectUri: "http://127.0.0.1:8425/oauth/connections/callback" });
    expect(steps.map((s) => s.id)).toEqual(["server", "pairing", "access", "reconnect"]);
    const text = steps.map((s) => s.body).join("\n");
    expect(text).toContain("Settings → Connections");
    expect(text).toContain("`t3 auth pairing create`");
    expect(text).toContain("`t3 serve`");
    expect(text).toContain("#token=");
    expect(text).toMatch(/Read only/);
    expect(text).toMatch(/Supervised \(Limited on older T3 versions\)/);
    expect(text).toMatch(/We recommend Supervised/);
    expect(text).toMatch(/Full access also lets agents add and change projects, T3's settings and source control/);
    expect(text).toMatch(/30 days/);
    expect(text).toMatch(/Reconnect takes a new pairing code and keeps/);
    for (const s of steps) expect(s.input).toBeUndefined();
  });

  it("user-named server URLs: the MCP path is added to a bare origin; slugs name the host", () => {
    expect(presetServerUrl("http://100.104.249.49:3773", "/mcp")).toBe("http://100.104.249.49:3773/mcp");
    expect(presetServerUrl(" http://100.104.249.49:3773/ ", "/mcp")).toBe("http://100.104.249.49:3773/mcp");
    expect(presetServerUrl("http://127.0.0.1:3773/mcp", "/mcp")).toBe("http://127.0.0.1:3773/mcp");
    expect(() => presetServerUrl("ftp://h/", "/mcp")).toThrow();
    expect(() => presetServerUrl("http://u:p@h/", "/mcp")).toThrow();
    expect(hostSlugPart("http://forge.tail1234.ts.net:3773/mcp")).toBe("forge");
    expect(presetServerSlug("t3", "http://100.104.249.49:3773/mcp")).toBe("t3-100-104-249-49");
    expect(presetServerSlug("t3", "http://forge.tail1234.ts.net:3773/mcp")).toBe("t3-forge");
  });
});

// ───────────────────────────── http only on private addresses, at every step ─────────────────────────────

/** A fake resolver: unknown names don't resolve. */
const dns =
  (map: Record<string, string[]>): LookupFn =>
  async (host) => {
    const a = map[host];
    if (!a) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

const LOOKUP = dns({
  "forge.test": ["100.104.249.49"], // Tailscale CGNAT
  "lan.test": ["192.168.1.20"],
  "pub.test": ["93.184.216.34"], // a hostname that resolves publicly
  "evil.test": ["93.184.216.35"],
});

/**
 * A T3-like OAuth server whose documents the test rewrites: it names itself http://forge.test:3773 and listens on
 * 127.0.0.1 (the runtime's `dial` maps every host to it, after the guard checked the fake-DNS address).
 */
async function t3Like() {
  const origin = "http://forge.test:3773";
  const patch = { prm: {} as Record<string, unknown>, md: {} as Record<string, unknown>, www: null as string | null };
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    hits.push(`${req.method} ${path}`);
    const custom = routes.get(path);
    if (custom) return custom(req, res);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
    if (path === "/mcp") return send(401, { error: "invalid_mcp_credential" }, { "www-authenticate": patch.www ?? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      return send(200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["orchestration:read", "orchestration:operate"], ...patch.prm });
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return send(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/mcp/authorize`,
        token_endpoint: `${origin}/oauth/mcp/token`,
        registration_endpoint: `${origin}/oauth/mcp/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["orchestration:read", "orchestration:operate"],
        authorization_response_iss_parameter_supported: true,
        ...patch.md,
      });
    }
    if (path === "/oauth/mcp/register" && req.method === "POST") {
      return send(201, { client_id: "signed-client-id", redirect_uris: ["x"], grant_types: ["authorization_code"], token_endpoint_auth_method: "none" });
    }
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>T3 Code</title>"); // the SPA fallback
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise((r) => server.close(() => r(undefined))));
  const port = (server.address() as AddressInfo).port;
  return { origin, url: `${origin}/mcp`, port, patch, routes, hits };
}

function runtimeEnv(dialPort: number) {
  const t = testContext();
  const rt = new UpstreamRuntime(t.ctx, {
    emit: () => {},
    lookup: LOOKUP,
    dial: () => ({ address: "127.0.0.1", port: dialPort }),
  });
  cleanup.push(() => t.dispose());
  cleanup.push(() => rt.stop());
  return { ctx: t.ctx, rt };
}

let seq = 0;
function addT3(ctx: ReturnType<typeof testContext>["ctx"], url: string, privateTarget: string | null): string {
  const id = `con_t3test${++seq}`;
  const ts = new Date().toISOString();
  ctx.db.run(
    "INSERT INTO connections (id, kind, preset, slug, name, url, auth_type, private_target, created_at, updated_at) VALUES (?, 'remote_http', 't3code', ?, ?, ?, 'oauth', ?, ?, ?)",
    id,
    `t3-test-${seq}`,
    `T3 ${seq}`,
    url,
    privateTarget,
    ts,
    ts,
  );
  return id;
}

const startT3 = (rt: UpstreamRuntime, id: string) => rt.startConnect(id, { sameOriginIssuer: true });
const code = (err: unknown) => (err instanceof SourceError ? err.code : String(err));

describe("T3 Code: plain http only on private addresses, at every step", () => {
  it("the MCP URL: http needs the admin's allow, and only for private ranges (loopback, RFC 1918, CGNAT, ULA)", async () => {
    // Without an allow every private host is blocked; with one, its exact origin passes.
    for (const url of ["http://forge.test:3773/mcp", "http://lan.test:3773/mcp", "http://127.0.0.1:3773/mcp", "http://100.104.249.49:3773/mcp"]) {
      expect(code(await checkTarget(new URL(url), { lookup: LOOKUP }).catch((e: unknown) => e)), url).toBe("blocked_target");
      const origin = new URL(url).origin;
      await expect(checkTarget(new URL(url), { allow: { origin }, lookup: LOOKUP }), url).resolves.toBeTruthy();
    }
    // ULA and IPv6 loopback are allowable too.
    const v6 = dns({ "ula.test": ["fd7a:115c:a1e0::1"], "lo6.test": ["::1"] });
    for (const host of ["ula.test", "lo6.test"]) await expect(checkTarget(new URL(`http://${host}:3773/mcp`), { allow: { origin: `http://${host}:3773` }, lookup: v6 })).resolves.toBeTruthy();
    // A hostname that resolves publicly: plain http is refused even with an allow for exactly that origin.
    const err = await checkTarget(new URL("http://pub.test:3773/mcp"), { allow: { origin: "http://pub.test:3773" }, lookup: LOOKUP }).catch((e: unknown) => e);
    expect(code(err)).toBe("blocked_target");
    expect((err as Error).message).toMatch(/https/);
    // A public IP over http, no allow: refused. Over https it's an ordinary public server.
    expect(code(await checkTarget(new URL("http://93.184.216.34/mcp"), { lookup: LOOKUP }).catch((e: unknown) => e))).toBe("blocked_target");
    await expect(checkTarget(new URL("https://pub.test/mcp"), { lookup: LOOKUP })).resolves.toBeTruthy();
    // The allow is pinned to its scheme: an https allow doesn't open http on the same host (no downgrade).
    expect(code(await checkTarget(new URL("http://forge.test:443/mcp"), { allow: { origin: "https://forge.test:443" }, lookup: LOOKUP }).catch((e: unknown) => e))).toBe("blocked_target");
  });

  it("the whole flow works over http on the allowed tailnet host (the positive case)", async () => {
    const t3 = await t3Like();
    const e = runtimeEnv(t3.port);
    const id = addT3(e.ctx, t3.url, "http://forge.test:3773");
    const start = await startT3(e.rt, id);
    const auth = new URL(start.authUrl);
    expect(auth.origin).toBe("http://forge.test:3773");
    expect(auth.pathname).toBe("/oauth/mcp/authorize");
    expect(t3.hits).toContain("POST /oauth/mcp/register");
  });

  it("the resource metadata URL in the 401: an http hop to a public host is refused", async () => {
    const t3 = await t3Like();
    t3.patch.www = 'Bearer resource_metadata="http://pub.test/.well-known/oauth-protected-resource/mcp"';
    const e = runtimeEnv(t3.port);
    const id = addT3(e.ctx, t3.url, "http://forge.test:3773");
    expect(code(await startT3(e.rt, id).catch((x: unknown) => x))).toBe("blocked_target");
  });

  it("the issuer: http on another host, public or private, is refused; https elsewhere fails the same-origin rule", async () => {
    for (const issuer of ["http://pub.test:3773", "http://lan.test:3773", "http://forge.test:3774"]) {
      const t3 = await t3Like();
      t3.patch.prm = { authorization_servers: [issuer] };
      const e = runtimeEnv(t3.port);
      const id = addT3(e.ctx, t3.url, "http://forge.test:3773");
      expect(code(await startT3(e.rt, id).catch((x: unknown) => x)), issuer).toBe("blocked_target");
    }
    // An https authorization server elsewhere is a valid generic issuer, but not for T3 (unit-checked: no TLS here).
    const d = (issuer: string) => ({ issuer, resource: "http://forge.test:3773/mcp", metadata: { authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` } });
    expect(() => requireSameOrigin(new URL("http://forge.test:3773/mcp"), d("https://login.example"))).toThrow(SourceError);
    expect(() => requireSameOrigin(new URL("http://forge.test:3773/mcp"), d("http://forge.test:3773"))).not.toThrow();
    // Same host, another scheme: another origin.
    expect(() => requireSameOrigin(new URL("http://forge.test:3773/mcp"), d("https://forge.test:3773"))).toThrow(/not on http:\/\/forge.test:3773/);
  });

  it("the issuer named in the metadata must be exactly the server's (as the generic upstream checks)", async () => {
    const t3 = await t3Like();
    t3.patch.md = { issuer: "http://forge.test:3773/other" };
    const e = runtimeEnv(t3.port);
    const id = addT3(e.ctx, t3.url, "http://forge.test:3773");
    await expect(startT3(e.rt, id)).rejects.toThrow(/expected http:\/\/forge.test:3773/);
  });

  it.each([
    ["authorization_endpoint", "http://pub.test/oauth/mcp/authorize"],
    ["authorization_endpoint", "https://evil.test/oauth/mcp/authorize"], // https, but not T3's own page: the pairing code would go there
    ["authorization_endpoint", "javascript:alert(1)"],
    ["token_endpoint", "http://pub.test/oauth/mcp/token"],
    ["token_endpoint", "https://evil.test/oauth/mcp/token"],
    ["token_endpoint", "http://lan.test:3773/oauth/mcp/token"],
    ["registration_endpoint", "http://pub.test/oauth/mcp/register"],
    ["registration_endpoint", "https://evil.test/oauth/mcp/register"],
  ])("%s %s is refused before anything is sent there", async (field, value) => {
    const t3 = await t3Like();
    t3.patch.md = { [field]: value };
    const e = runtimeEnv(t3.port);
    const id = addT3(e.ctx, t3.url, "http://forge.test:3773");
    const err = await startT3(e.rt, id).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(SourceError);
    expect(["blocked_target", "protocol"]).toContain(code(err));
    expect(t3.hits).not.toContain("POST /oauth/mcp/register");
  });

  it("the resource named by the server must be its own", async () => {
    const t3 = await t3Like();
    t3.patch.prm = { resource: "http://lan.test:3773/mcp" };
    const e = runtimeEnv(t3.port);
    const id = addT3(e.ctx, t3.url, "http://forge.test:3773");
    await expect(startT3(e.rt, id)).rejects.toThrow(/different resource/);
  });

  it("redirects follow the same rule: a hop to an http public host or another private host is refused", async () => {
    for (const location of ["http://pub.test/.well-known/oauth-authorization-server", "http://lan.test:3773/.well-known/oauth-authorization-server", "http://evil.test:80/x"]) {
      const t3 = await t3Like();
      t3.routes.set("/.well-known/oauth-authorization-server", (_req, res) => res.writeHead(302, { location }).end());
      const e = runtimeEnv(t3.port);
      const id = addT3(e.ctx, t3.url, "http://forge.test:3773");
      expect(code(await startT3(e.rt, id).catch((x: unknown) => x)), location).toBe("blocked_target");
      expect(t3.hits.filter((h) => h.includes("oauth-authorization-server"))).toHaveLength(1);
    }
    // A same-origin redirect is followed (and re-checked).
    const t3 = await t3Like();
    let n = 0;
    t3.routes.set("/.well-known/oauth-authorization-server", (_req, res) => {
      t3.routes.delete("/.well-known/oauth-authorization-server");
      n++;
      res.writeHead(307, { location: "/.well-known/oauth-authorization-server" }).end();
    });
    const e = runtimeEnv(t3.port);
    const id = addT3(e.ctx, t3.url, "http://forge.test:3773");
    await expect(startT3(e.rt, id)).resolves.toMatchObject({ authUrl: expect.stringContaining("http://forge.test:3773/oauth/mcp/authorize") });
    expect(n).toBe(1);
  });

  it("the guarded fetch refuses a redirect hop to plain http on a public host (no downgrade)", async () => {
    const t3 = await t3Like();
    t3.routes.set("/down", (_req, res) => res.writeHead(301, { location: "http://pub.test/landing" }).end());
    const f = guardedFetch({ allow: { origin: "http://forge.test:3773" }, lookup: LOOKUP, dial: () => ({ address: "127.0.0.1", port: t3.port }) });
    cleanup.push(() => f.close());
    expect(code(await f("http://forge.test:3773/down").catch((x: unknown) => x))).toBe("blocked_target");
  });

  it("the registration request never follows a redirect", async () => {
    const t3 = await t3Like();
    t3.routes.set("/oauth/mcp/register", (_req, res) => res.writeHead(307, { location: "/elsewhere" }).end());
    const e = runtimeEnv(t3.port);
    const id = addT3(e.ctx, t3.url, "http://forge.test:3773");
    await expect(startT3(e.rt, id)).rejects.toThrow(/redirected/i);
    expect(t3.hits).not.toContain("POST /elsewhere");
  });

  it("without the allow nothing is fetched from a private T3; the probe names the exact origin to allow", async () => {
    const t3 = await t3Like();
    const e = runtimeEnv(t3.port);
    const id = addT3(e.ctx, t3.url, null);
    expect(code(await startT3(e.rt, id).catch((x: unknown) => x))).toBe("blocked_target");
    expect(t3.hits).toEqual([]);
    expect(await e.rt.probe(t3.url)).toMatchObject({ auth: "blocked", privateTarget: "http://forge.test:3773" });
    // A public host over http can't be allowed: no allow is offered.
    expect(await e.rt.probe("http://pub.test:3773/mcp")).toMatchObject({ auth: "blocked", privateTarget: null });
  });
});

// ───────────────────────────── the connection end to end, through the API ─────────────────────────────

const T3_FAKE_TOOLS: FakeTool[] = [
  {
    name: "t3_project_list",
    description: "List registered projects in this environment.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
    handler: () => ({ content: [{ type: "text", text: '{"projects":[{"id":"p1","title":"demo"}]}' }] }),
  },
  {
    name: "t3_thread_send",
    description: "Send a message to any T3 thread in this environment.",
    inputSchema: { type: "object", properties: { threadId: { type: "string" }, message: { type: "string" } }, required: ["threadId", "message"] },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: (a) => ({ content: [{ type: "text", text: `queued to ${(a as { threadId: string }).threadId}` }] }),
  },
  {
    name: "t3_project_delete",
    description: "Delete a project using the existing project deletion lifecycle.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, force: { type: "boolean" } }, required: ["projectId"] },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: (a) => ({ content: [{ type: "text", text: `deleted ${(a as { projectId: string }).projectId}` }] }),
  },
];

async function fakeT3(grantScope: string | null = null): Promise<FakeMcpUpstream> {
  const up = await startFakeMcpUpstream({
    protocol: "streamable-2025",
    auth: {
      kind: "oauth",
      refreshGrant: false, // T3: authorization_code only, no refresh tokens
      accessTokenTtlSec: THIRTY_DAYS_SEC,
      scopesSupported: ["orchestration:read", "orchestration:operate"],
      grantScope,
    },
    spaFallback: true,
    tools: T3_FAKE_TOOLS,
  });
  cleanup.push(() => up.close());
  return up;
}

async function apiEnv() {
  const h = harness();
  cleanup.push(() => h.dispose());
  const cookie = await h.claim();
  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => h.request(`/api${path}`, { cookie, ...init, headers: { ...CSRF, ...(init.headers as object) } });
  return { h, ctx: h.ctx, api };
}

type ApiEnv = Awaited<ReturnType<typeof apiEnv>>;

async function signIn(s: ApiEnv, up: FakeMcpUpstream, id: string) {
  const started = await json(await s.api(`/connections/${id}/connect`, { method: "POST", json: {} }));
  expect(started).toMatchObject({ status: "authorize" });
  const cb = await up.oauth!.followAuthorize(started.authorizeUrl);
  const landing = await s.h.request(`${cb.pathname}${cb.search}`);
  expect(landing.status).toBe(200);
  await s.ctx.broker.catalog.refresh(id);
  return { authorizeUrl: new URL(started.authorizeUrl as string), callback: cb };
}

/** Adds a T3 connection for `up` (origin only, as a user types it), allows its loopback origin and signs in. */
async function connectT3(s: ApiEnv, up: FakeMcpUpstream, body: Record<string, unknown> = {}) {
  const created = await s.api("/connections", { method: "POST", json: { preset: "t3code", url: up.origin, ...body } });
  expect(created.status).toBe(201);
  const con = await json(created);
  expect(await json(await s.api(`/connections/${con.id}/private-target`, { method: "PUT", json: { allow: true } }))).toMatchObject({ privateTarget: up.origin });
  return { con, ...(await signIn(s, up, con.id)) };
}

async function agentClient(s: ApiEnv, apiKey: string) {
  const client = new Client({ name: "t3-e2e", version: "1" });
  const app = s.h.app;
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://xaq.test/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
      fetch: async (url, init) => app.request(String(url), init as RequestInit, { incoming: { socket: { remoteAddress: "127.0.0.1" } } }),
    }),
  );
  cleanup.push(() => client.close());
  return client;
}

const text = (r: unknown) => (r as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join("\n");

describe("T3 Code connection end to end (fake T3: DCR, PKCE, iss, no refresh, 30 days)", () => {
  it("connects with DCR, PKCE S256, state, resource and iss; records extra scopes; agents list and call; risky asks", async () => {
    const up = await fakeT3("orchestration:read orchestration:operate settings:write source-control:write");
    const s = await apiEnv();
    const { agent, apiKey } = s.ctx.policy.createAgent({ name: "Hermes" });
    const { con, authorizeUrl, callback } = await connectT3(s, up, { agentIds: [agent.id], levelDefault: "ask" });

    // The URL got T3's MCP path; name and slug come from the host.
    expect(con).toMatchObject({ preset: "t3code", url: up.url, name: new URL(up.url).host, slug: "t3-127-0-0-1", authType: "oauth" });
    // DCR as a public client, PKCE S256, our state, the resource; iss came back and matched.
    const reg = up.requests.find((r) => r.method === "POST" && r.path.endsWith("/register"));
    expect(JSON.parse(reg!.body)).toMatchObject({ token_endpoint_auth_method: "none", grant_types: ["authorization_code"] });
    const q = authorizeUrl.searchParams;
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("resource")).toBe(up.url);
    expect(q.get("state")).toBeTruthy();
    expect(callback.searchParams.get("iss")).toBe(up.oauth!.issuer);

    // T3 granted more than was asked for: accepted, recorded and shown.
    const view = await json(await s.api(`/connections/${con.id}`));
    expect(view).toMatchObject({ status: "active", expired: false, expiresInDays: 29 });
    expect(view.grantedScopes).toEqual(["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"]);
    const days = (Date.parse(view.expiresAt) - Date.now()) / DAY;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const audit = s.ctx.db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'connection.connect' AND target = ? AND actor_type = 'admin' AND detail LIKE '%scope%' ORDER BY id DESC LIMIT 1", con.id)!;
    expect(JSON.parse(audit.detail)).toMatchObject({ refresh: false, scope: "orchestration:read orchestration:operate settings:write source-control:write" });

    // The agent: T3's real tool names, namespaced; a read runs, a thread send goes straight through, delete asks.
    const client = await agentClient(s, apiKey);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["t3-127-0-0-1__t3_project_list", "t3-127-0-0-1__t3_thread_send", "t3-127-0-0-1__t3_project_delete"]));
    expect(text(await client.callTool({ name: "t3-127-0-0-1__t3_project_list", arguments: {} }))).toContain('"title":"demo"');
    expect(text(await client.callTool({ name: "t3-127-0-0-1__t3_thread_send", arguments: { threadId: "th1", message: "hi" } }))).toContain("queued to th1");
    const pending = text(await client.callTool({ name: "t3-127-0-0-1__t3_project_delete", arguments: { projectId: "p1" } }));
    expect(pending).toContain("pending_approval");
    const called = () => up.requests.filter((r) => r.rpcMethod === "tools/call").map((r) => (JSON.parse(r.body) as { params: { name: string } }).params.name);
    expect(called()).not.toContain("t3_project_delete");

    expect(called()).not.toContain("t3_project_delete");
  }, 30_000);

  it("Read only in T3 grants less than asked: recorded as is", async () => {
    const up = await fakeT3("orchestration:read");
    const s = await apiEnv();
    const { con } = await connectT3(s, up);
    expect((await json(await s.api(`/connections/${con.id}`))).grantedScopes).toEqual(["orchestration:read"]);
  });

  it("expiry: warned 7 and 1 days ahead with a Reconnect link, then expired with a clear agent message, never a raw 401", async () => {
    const up = await fakeT3();
    const s = await apiEnv();
    const { agent, apiKey } = s.ctx.policy.createAgent({ name: "Hermes" });
    const { con } = await connectT3(s, up, { name: "forge", agentIds: [agent.id], levelDefault: "full" });
    const rt = upstreams(s.ctx);
    const consoleUrl = `${s.ctx.settings.publicUrl()}/connections/${con.id}`;
    const events = (type: string) => s.ctx.db.all<{ detail: string }>("SELECT detail FROM events WHERE connection_id = ? AND type = ? ORDER BY seq", con.id, type).map((e) => e.detail);
    // The runtime's sweep reads the real clock: move the credential's expiry instead.
    const expiresIn = (ms: number) => {
      const iso = new Date(Date.now() + ms).toISOString();
      s.ctx.db.run("UPDATE connections SET expires_at = ? WHERE id = ?", iso, con.id);
      s.ctx.db.run("UPDATE connection_credentials SET expires_at = ? WHERE connection_id = ?", iso, con.id);
    };

    // 8 days left: nothing yet. 6 days left: the 7-day warning, once.
    expiresIn(8 * DAY);
    await rt.sweep();
    expect(events("connection.expiring")).toHaveLength(0);
    expiresIn(6 * DAY - 60_000);
    await rt.sweep();
    await rt.sweep();
    expect(events("connection.expiring")).toHaveLength(1);
    expect(events("connection.expiring")[0]).toContain(consoleUrl);
    expect(events("connection.expiring")[0]).toMatch(/expires in 6 days/);
    // The console shows it, with Reconnect.
    expect(await json(await s.api(`/connections/${con.id}`))).toMatchObject({ status: "active", expired: false, expiresInDays: 5 });
    // 12 hours left: the 1-day warning.
    expiresIn(DAY / 2);
    await rt.sweep();
    expect(events("connection.expiring")).toHaveLength(2);
    expect(events("connection.expiring")[1]).toMatch(/expires in 1 day /);

    // Past it, before the sweep runs: the agent's call is refused with the clear message; nothing reaches T3.
    expiresIn(-60_000);
    const client = await agentClient(s, apiKey);
    const before = up.requests.filter((r) => r.rpcMethod === "tools/call").length;
    const r = await client.callTool({ name: "t3-127-0-0-1__t3_project_list", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(`The T3 Code connection 'forge' expired; ask your user to reconnect it in xaq at ${consoleUrl} . Nothing was sent to forge.`);
    expect(up.requests.filter((x) => x.rpcMethod === "tools/call").length).toBe(before);
    // The sweep marks it: needs_reauth, expired, one auth_failed event with the link.
    await rt.sweep();
    expect(await json(await s.api(`/connections/${con.id}`))).toMatchObject({ status: "needs_reauth", expired: true });
    const failed = events("connection.auth_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('"expired":true');
    expect(failed[0]).toContain(consoleUrl);
    // Still listed (calls explain), still the same message.
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("t3-127-0-0-1__t3_project_list");
    expect(text(await client.callTool({ name: "t3-127-0-0-1__t3_project_list", arguments: {} }))).toContain("expired; ask your user to reconnect it in xaq at");
  }, 30_000);

  it("a 401 with no refresh token marks the connection expired, and the agent gets the expired message", async () => {
    const up = await fakeT3();
    const s = await apiEnv();
    const { agent, apiKey } = s.ctx.policy.createAgent({ name: "Hermes" });
    const { con } = await connectT3(s, up, { name: "forge", agentIds: [agent.id], levelDefault: "full" });
    const client = await agentClient(s, apiKey);
    expect(text(await client.callTool({ name: "t3-127-0-0-1__t3_project_list", arguments: {} }))).toContain("demo");
    up.oauth!.revokeAll(); // T3 forgot the token (a reset, or the user removed the agent in T3)
    const r = await client.callTool({ name: "t3-127-0-0-1__t3_project_list", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("The T3 Code connection 'forge' expired; ask your user to reconnect it in xaq at");
    expect(text(r)).not.toMatch(/\b401\b/);
    const view = await json(await s.api(`/connections/${con.id}`));
    expect(view).toMatchObject({ status: "needs_reauth", expired: true });
    expect(Date.parse(view.expiresAt)).toBeLessThanOrEqual(Date.now());
  }, 30_000);

  it("Reconnect keeps the name, slug, grants and levels, and widens nothing: no new agents, no new scopes asked", async () => {
    const up = await fakeT3();
    const s = await apiEnv();
    const a = s.ctx.policy.createAgent({ name: "Hermes" }).agent;
    const b = s.ctx.policy.createAgent({ name: "Codex" }).agent;
    const { con, authorizeUrl: first } = await connectT3(s, up, { name: "forge", agentIds: [a.id, b.id], levelDefault: "ask" });
    expect((await s.api(`/connections/${con.id}/grants`, { method: "PUT", json: { grants: [{ agentId: a.id, level: "read" }, { agentId: b.id, level: "ask" }] } })).status).toBe(200);
    // An agent added later doesn't get it ("All agents" is off): a reconnect mustn't change that.
    const c = s.ctx.policy.createAgent({ name: "Cursor" }).agent;

    // Expire it, then reconnect.
    s.ctx.db.run("UPDATE connections SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), con.id);
    await upstreams(s.ctx).sweep();
    expect((await json(await s.api(`/connections/${con.id}`))).expired).toBe(true);
    const { authorizeUrl: again } = await signIn(s, up, con.id);

    const after = await json(await s.api(`/connections/${con.id}`));
    expect(after).toMatchObject({ status: "active", expired: false, name: "forge", slug: con.slug, levelDefault: "ask", allAgents: false, agents: 2 });
    expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.now() + 29 * DAY);
    const grants = (await json(await s.api(`/connections/${con.id}/grants`))) as { agentId: string; level: string }[];
    expect(grants.map((g) => `${g.agentId}:${g.level}`).sort()).toEqual([`${a.id}:read`, `${b.id}:ask`].sort());
    expect(grants.some((g) => g.agentId === c.id)).toBe(false);
    // The sign-in asks T3 for no scope it didn't ask for (or grant) before.
    const scopes = (u: URL) => new Set((u.searchParams.get("scope") ?? "").split(" ").filter(Boolean));
    const before = new Set([...scopes(first), ...(after.grantedScopes as string[])]);
    expect([...scopes(again)].every((x) => before.has(x))).toBe(true);
    // The tools are listed again.
    expect(after.tools.total).toBe(3);
  }, 30_000);

  it("search mode once T3's many tools arrive: found by search and called by their real names", async () => {
    // T3-sized: over the 30-tool threshold.
    const reads: FakeTool[] = READ.filter((n) => n !== "t3_project_list").map((name) => ({
      name,
      description: `T3 read tool ${name}.`,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      handler: () => ({ content: [{ type: "text", text: `ran ${name}` }] }),
    }));
    const up = await startFakeMcpUpstream({
      protocol: "streamable-2025",
      auth: { kind: "oauth", refreshGrant: false, accessTokenTtlSec: THIRTY_DAYS_SEC, scopesSupported: ["orchestration:read", "orchestration:operate"] },
      tools: [...T3_FAKE_TOOLS, ...reads],
    });
    cleanup.push(() => up.close());
    const s = await apiEnv();
    const { agent, apiKey } = s.ctx.policy.createAgent({ name: "Hermes" });
    // Before T3: few tools, every one listed.
    const early = await agentClient(s, apiKey);
    expect((await early.listTools()).tools.map((t) => t.name)).not.toContain("search_tools");

    // Over the threshold: meta-tools listed, T3 found by search and still callable by its real name.
    await connectT3(s, up, { agentIds: [agent.id], levelDefault: "ask" });
    const search = await agentClient(s, apiKey);
    const listed = (await search.listTools()).tools.map((t) => t.name);
    expect(listed).toContain("search_tools");
    expect(listed).not.toContain("t3-127-0-0-1__t3_thread_list");
    expect(text(await search.callTool({ name: "search_tools", arguments: { query: "list threads" } }))).toContain("t3-127-0-0-1__t3_thread_list");
    expect(text(await search.callTool({ name: "t3-127-0-0-1__t3_thread_list", arguments: {} }))).toContain("ran t3_thread_list");
    expect(text(await search.callTool({ name: "t3-127-0-0-1__t3_project_delete", arguments: { projectId: "p9" } }))).toContain("pending_approval");
  }, 30_000);

  it("several T3 servers are several connections, with unique names per owner", async () => {
    const one = await fakeT3();
    const two = await fakeT3();
    const s = await apiEnv();
    const create = (body: Record<string, unknown>) => s.api("/connections", { method: "POST", json: { preset: "t3code", agentIds: [], ...body } });
    const first = await json(await create({ url: one.origin }));
    const second = await json(await create({ url: two.origin }));
    expect(first.name).toBe(new URL(one.origin).host);
    expect(second.name).toBe(new URL(two.origin).host);
    expect(first.slug).toBe("t3-127-0-0-1");
    expect(second.slug).toBe("t3-127-0-0-1-2");
    expect([first.url, second.url]).toEqual([one.url, two.url]);

    // A name that's taken (any case) is refused, on create and on rename; a free one is fine.
    const dup = await create({ url: two.origin, name: first.name.toUpperCase(), slug: "t3-dup" });
    expect(dup.status).toBe(409);
    expect((await json(dup)).error.message).toMatch(/already have a connection named/);
    expect((await s.api(`/connections/${second.id}`, { method: "PATCH", json: { name: first.name } })).status).toBe(409);
    expect(await json(await s.api(`/connections/${second.id}`, { method: "PATCH", json: { name: "laptop" } }))).toMatchObject({ name: "laptop" });
    // A default name that's taken gets a suffix instead of failing.
    const third = await json(await create({ url: one.origin, slug: "t3-third" }));
    expect(third.name).toBe(`${new URL(one.origin).host} (2)`);

    // The address is required for this preset.
    expect((await create({})).status).toBe(400);
  });

  it("the expired message names the preset only when there is one", () => {
    expect(reconnectMessage({ name: "forge", kind: "T3 Code", expired: true, consoleUrl: "http://x/connections/c" })).toBe(
      "The T3 Code connection 'forge' expired; ask your user to reconnect it in xaq at http://x/connections/c . Nothing was sent to forge.",
    );
    expect(reconnectMessage({ name: "mine", kind: null, expired: true, consoleUrl: "http://x/connections/c" })).toMatch(/^The connection 'mine' expired;/);
    expect(reconnectMessage({ name: "mine", kind: null, expired: false, consoleUrl: "http://x/connections/c" })).toMatch(/^The owner must reconnect mine in xaq \(Connections → Reconnect\)/);
  });
});
