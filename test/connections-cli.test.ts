import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exactOrigin as serverExactOrigin } from "../server/api/connections.ts";
import type { IntegrationPreset } from "../server/broker/types.ts";
import { SessionStore } from "../server/auth/sessions.ts";
import { sha256 } from "../server/crypto.ts";
import { AdminApiError, CLI_SESSION_TTL_MS, createCliSession, daemonOrigin, openAdminChannel } from "../server/connections-cli/admin.ts";
import { ConnectionsApi } from "../server/connections-cli/api.ts";
import { addConnection, disableConnection, listConnections, reconnectConnection, removeConnection, slugFromUrl } from "../server/connections-cli/manage.ts";
import { checkTarget, exactOrigin } from "../server/connections-cli/private.ts";
import { ScriptedPrompter } from "../server/connections-cli/prompt.ts";
import { readTomlMcpServers, UNREADABLE as TOML_UNREADABLE } from "../server/connections-cli/toml.ts";
import { readMcpServers, removeYamlServers, UNREADABLE } from "../server/connections-cli/yaml.ts";
import { presetFromManifest } from "../server/extensions/manifest.ts";
import { type Daemon, publicLookup, startDaemon } from "./connections-cli-fake.ts";
import { fixtureExtension } from "./extension-fixtures.ts";
import { harness } from "./platform-helpers.ts";

const WHOOP_LIKE: IntegrationPreset = {
  id: "whoop",
  displayName: "WHOOP",
  slug: "whoop",
  kind: "native",
  auth: { type: "user_app", authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth", tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token", scopes: [], clientIdInput: "clientId", clientSecretInput: "clientSecret" },
  classify: () => null,
  setupSteps: (ctx) => [
    { id: "dash", title: "Open the WHOOP developer dashboard", body: "Sign in and create a team.", link: { label: "Open", url: "https://developer-dashboard.whoop.com" } },
    { id: "app", title: "Create an app", body: "Tick the `read:recovery` scope.", copy: { label: "Redirect URI", value: ctx.redirectUri } },
    { id: "id", title: "Paste the client ID", body: "From the app page.", input: { key: "clientId", label: "Client ID", pattern: "^[0-9a-f-]{8,}$", placeholder: "a UUID" } },
    { id: "secret", title: "Paste the client secret", body: "Also from the app page.", input: { key: "clientSecret", label: "Client secret", secret: true } },
  ],
};

describe("the local admin channel", () => {
  it("a one-time session works against the real admin API, can't slide past 15 minutes, and is deleted on close", async () => {
    const h = harness();
    try {
      await h.claim();
      let now = Date.now();
      const s = createCliSession(h.ctx.config.dbPath, () => now);
      const cookie = `aib_session=${s.token}`;
      expect((await h.request("/api/agents", { cookie })).status).toBe(200);
      // Only the hash is stored, with a hard limit at the expiry: a check never extends it.
      const row = h.ctx.db.get<{ created_at: string; expires_at: string; user_agent: string }>("SELECT * FROM admin_sessions WHERE token_hash = ?", sha256(s.token))!;
      expect(Date.parse(row.expires_at) - now).toBe(CLI_SESSION_TTL_MS);
      expect(row.user_agent).toContain("CLI");
      const store = new SessionStore(h.ctx.db, () => now + 60_000);
      expect(store.check(s.token)).toEqual({ valid: true, refreshed: false });
      now += CLI_SESSION_TTL_MS + 1000;
      expect(new SessionStore(h.ctx.db, () => now).check(s.token).valid).toBe(false);

      const s2 = createCliSession(h.ctx.config.dbPath);
      expect((await h.request("/api/agents", { cookie: `aib_session=${s2.token}` })).status).toBe(200);
      s2.remove();
      expect((await h.request("/api/agents", { cookie: `aib_session=${s2.token}` })).status).toBe(401);
    } finally {
      await h.dispose();
    }
  });

  it("sends the cookie and CSRF header, and turns API errors into AdminApiError", async () => {
    const h = harness();
    try {
      await h.claim();
      h.ctx.settings.update({ brokerUpstreams: false });
      const ch = openAdminChannel({
        dataDir: h.ctx.config.dataDir,
        instance: { pid: 1, host: "0.0.0.0", port: 8425, startedAt: "" },
        fetch: ((url: string, init: RequestInit) => h.request(new URL(url).pathname, init)) as typeof fetch,
      });
      expect(ch.baseUrl).toBe("http://127.0.0.1:8425");
      expect(Array.isArray(await ch.request("GET", "/api/agents"))).toBe(true);
      const err = await ch.request("POST", "/api/connections", {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdminApiError);
      expect((err as AdminApiError).status).toBe(404);
      // Routes not mounted (brokerUpstreams off): said in plain words.
      await expect(new ConnectionsApi(ch).list()).rejects.toThrow(/brokerUpstreams/);
      ch.close();
      expect(h.ctx.db.get("SELECT 1 AS x FROM admin_sessions WHERE ip = 'local-cli'")).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  it("mints a fresh session when the 15 minutes ran out mid-command", async () => {
    const d = await startDaemon();
    try {
      expect(await d.api.list()).toEqual([]);
      d.h.ctx.db.run("DELETE FROM admin_sessions WHERE ip = 'local-cli'");
      expect(await d.api.list()).toEqual([]);
      expect(d.h.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM admin_sessions WHERE ip = 'local-cli'")!.n).toBe(1);
    } finally {
      await d.dispose();
    }
  });

  it("refuses without a data directory or a running daemon", () => {
    expect(() => openAdminChannel({ dataDir: "/nonexistent/xaq" })).toThrow(/No xaq data/);
    expect(daemonOrigin({ host: "::", port: 9 })).toBe("http://127.0.0.1:9");
    expect(daemonOrigin({ host: "100.64.1.2", port: 9 })).toBe("http://100.64.1.2:9");
  });
});

describe("connections add: names are unique, so the CLI only sends one you chose", () => {
  let d: Daemon;
  beforeEach(async () => {
    d = await startDaemon();
  });
  afterEach(() => d.dispose());
  const deps = (p: ScriptedPrompter) => ({ api: d.api, prompter: p, env: {}, pollMs: 1, timeoutMs: 2000 });
  const names = () => d.h.ctx.db.all<{ slug: string; name: string }>("SELECT slug, name FROM connections ORDER BY created_at, rowid").map((r) => `${r.slug}=${r.name}`);

  it("the same host twice (another port or path) and the same preset twice get the server's suffixed defaults", async () => {
    const yes = () => new ScriptedPrompter([], true);
    expect(await addConnection("http://127.0.0.1:8787/mcp", { yes: true }, deps(yes()))).toBe(0);
    expect(await addConnection("http://127.0.0.1:8788/mcp", { yes: true, slug: "local-b" }, deps(yes()))).toBe(0);
    expect(await addConnection("https://mcp.example.com/a/mcp", { yes: true }, deps(yes()))).toBe(0);
    expect(await addConnection("https://mcp.example.com/b/mcp", { yes: true, slug: "example-b" }, deps(yes()))).toBe(0);
    expect(await addConnection("notion", { yes: true }, deps(yes()))).toBe(0);
    expect(await addConnection("notion", { yes: true, slug: "notion-work" }, deps(yes()))).toBe(0);
    expect(names().map((n) => n.slice(n.indexOf("=") + 1))).toEqual(["127.0.0.1", "127.0.0.1 (2)", "mcp.example.com", "mcp.example.com (2)", "Notion", "Notion (2)"]);
  });

  it("--name is used as given; a taken one (any case) fails before any question", async () => {
    expect(await addConnection("notion", { yes: true, name: "Work wiki" }, deps(new ScriptedPrompter([], true)))).toBe(0);
    expect(names()).toEqual(["notion=Work wiki"]);
    const p = new ScriptedPrompter([]); // no answers: any prompt would throw
    await expect(addConnection("https://mcp.example.com/mcp", { name: "work WIKI" }, deps(p))).rejects.toThrow(/already have a connection named "Work wiki"/);
    expect(d.upstreams.probes).toEqual([]);
    expect(names()).toEqual(["notion=Work wiki"]);
  });
});

describe("connections add", () => {
  let d: Daemon;
  beforeEach(async () => {
    d = await startDaemon({ presets: [WHOOP_LIKE] });
  });
  afterEach(() => d.dispose());
  const deps = (p: ScriptedPrompter, env: NodeJS.ProcessEnv = {}) => ({ api: d.api, prompter: p, env, pollMs: 1, timeoutMs: 2000 });
  const row = (slug: string) =>
    d.h.ctx.db.get<{ id: string; url: string | null; level_default: string; private_target: string | null; preset: string | null; status: string }>(
      "SELECT id, url, level_default, private_target, preset, status FROM connections WHERE slug = ?",
      slug,
    );

  it("a URL on this machine: the private allow prompt for the exact origin, a header, the access choice and the agents", async () => {
    const url = "http://127.0.0.1:8787/mcp";
    d.upstreams.probe = (_u, allow) =>
      allow ? { reachable: true, auth: "header", message: "401 without OAuth metadata." } : { reachable: false, auth: "unknown", blocked: "private_target", message: "blocked" };
    // allow? · slug · access (1 = full) · all agents? no · Hermes? yes · Claude Code? no · add? · header name · value
    const p = new ScriptedPrompter(["y", "brightspace", "1", "n", "y", "n", "y", "", "bs-token"]);
    expect(await addConnection(url, {}, deps(p))).toBe(0);
    const c = row("brightspace")!;
    expect(c).toMatchObject({ url, level_default: "full", private_target: "http://127.0.0.1:8787" });
    expect(d.upstreams.probes).toEqual([
      { url, privateTarget: null },
      { url, privateTarget: "http://127.0.0.1:8787" },
    ]);
    expect(d.upstreams.connects).toEqual([{ slug: "brightspace", input: { header: { name: "Authorization", value: "Bearer bs-token" } }, privateTarget: "http://127.0.0.1:8787" }]);
    expect(d.h.ctx.db.all("SELECT agent_id FROM connection_grants WHERE connection_id = ?", c.id)).toEqual([{ agent_id: d.agents.hermes }]);
    expect(p.text).toContain("An allow covers exactly http://127.0.0.1:8787");
    expect(p.text).not.toContain("bs-token");
    expect(p.text).toContain('✔ Connected "brightspace": 3 tools, seen by agents as brightspace__<tool> (Full access).');
  });

  it("--yes never allows a private host; --allow-private with the exact origin does", async () => {
    d.upstreams.probe = (_u, allow) => (allow ? { reachable: true, auth: "none", message: "" } : { reachable: false, auth: "unknown", blocked: "private_target", message: "blocked" });
    const p = new ScriptedPrompter([], true);
    expect(await addConnection("http://127.0.0.1:3000/mcp", { yes: true }, deps(p))).toBe(0);
    expect(p.text).toContain("--yes doesn't answer this; nothing was added (pass --allow-private http://127.0.0.1:3000 to allow it)");
    expect(d.h.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM connections")!.n).toBe(0);
    expect(await addConnection("http://127.0.0.1:3000/mcp", { yes: true, allowPrivate: "http://127.0.0.1:3000" }, deps(new ScriptedPrompter([], true)))).toBe(0);
    expect(d.h.ctx.db.get("SELECT private_target FROM connections")).toEqual({ private_target: "http://127.0.0.1:3000" });
  });

  it("a paste-mode Reconnect succeeds once the first tool sync lands", async () => {
    d.upstreams.probe = () => ({ reachable: true, auth: "oauth", message: "OAuth" });
    d.upstreams.connect = () => ({ status: "authorize", authorizeUrl: "https://t3.example/authorize?state=ok", callbackMode: "paste", redirectUri: "https://localhost/oauth/connections/callback" });
    const c = await d.api.create({ slug: "t3", url: "https://t3.example/mcp" });
    d.h.ctx.db.run("UPDATE connections SET auth_type = 'oauth', status = 'needs_reauth' WHERE id = ?", c.id);
    // The sign-in finishes at once; the tools arrive a moment later (the catalog's first sync).
    d.upstreams.finish = (id) => {
      d.h.ctx.db.run("UPDATE connections SET status = 'active' WHERE id = ?", id);
      setTimeout(() => d.giveTools("t3", 4), 30);
    };
    const p = new ScriptedPrompter(["https://localhost/oauth/connections/callback?code=x&state=ok"]);
    expect(await reconnectConnection("t3", {}, deps(p))).toBe(0);
    expect(p.text).toContain('✔ Connected "t3": 4 tools');
  });

  it("Reconnect on an active OAuth connection waits for the new credential, not just any update", async () => {
    d.upstreams.probe = () => ({ reachable: true, auth: "oauth", message: "OAuth" });
    d.upstreams.connect = () => ({ status: "authorize", authorizeUrl: "https://t3.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Foauth%2Fconnections%2Fcallback" });
    const c = await d.api.create({ slug: "forge", url: "https://t3.example/mcp" });
    d.giveTools("forge");
    const t = new Date().toISOString();
    d.h.ctx.db.run("UPDATE connections SET auth_type = 'oauth', status = 'active' WHERE id = ?", c.id);
    d.h.ctx.db.run("INSERT INTO connection_credentials (connection_id, access_token_enc, issued_at, created_at, updated_at) VALUES (?, 'v1:old', ?, ?, ?)", c.id, t, t, t);
    let signedIn = false;
    const d2 = {
      ...deps(new ScriptedPrompter([], true)),
      openBrowser: async () => {
        // Some unrelated update first (a catalog refresh), then the sign-in saving new tokens.
        d.h.ctx.db.run("UPDATE connections SET updated_at = ? WHERE id = ?", new Date(Date.now() + 5000).toISOString(), c.id);
        setTimeout(() => {
          signedIn = true;
          d.h.ctx.db.run("UPDATE connection_credentials SET access_token_enc = 'v1:new', issued_at = ? WHERE connection_id = ?", new Date(Date.now() + 9000).toISOString(), c.id);
        }, 30);
      },
    };
    expect(await reconnectConnection("forge", {}, d2)).toBe(0);
    expect(signedIn).toBe(true);
  });

  it("declining the allow adds nothing", async () => {
    d.upstreams.probe = () => ({ reachable: false, auth: "unknown", blocked: "private_target", message: "blocked" });
    expect(await addConnection("http://10.0.0.5/mcp", {}, deps(new ScriptedPrompter(["n"])))).toBe(0);
    expect(d.h.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM connections")!.n).toBe(0);
  });

  it("OAuth over SSH: paste mode through the daemon's own callback, then the default access (ask) for all agents", async () => {
    const url = "https://mcp.example.com/mcp";
    d.upstreams.probe = () => ({ reachable: true, auth: "oauth", issuer: "https://auth.example.com", registration: "dcr", message: "OAuth" });
    d.upstreams.connect = () => ({ status: "authorize", authorizeUrl: "https://auth.example.com/authorize?state=ok&redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Foauth%2Fconnections%2Fcallback" });
    const opened: string[] = [];
    const landed = "http://localhost:8425/oauth/connections/callback?code=c0de&state=ok&iss=https%3A%2F%2Fauth.example.com";
    const p = new ScriptedPrompter(["", "", "y", "y", "not a url", landed]);
    const code = await addConnection(url, {}, { ...deps(p, { SSH_CONNECTION: "1 2 3 4" }), openBrowser: async (u: string) => opened.push(u) });
    expect(code).toBe(0);
    expect(row("example")).toMatchObject({ level_default: "full" });
    expect(d.h.ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM connection_grants")!.n).toBe(2);
    expect(p.text).toContain("registers itself automatically (dynamic client registration)");
    expect(p.text).toContain("an address starting with http://localhost:8425/oauth/connections/callback");
    expect(p.text).toContain("That isn't the address after signing in");
    expect(d.upstreams.finishes).toEqual([landed]);
    expect(p.text).toContain('✔ Connected "example": 3 tools');
    expect(opened).toEqual([]);
  });

  it("paste mode (the daemon says so) reports /finish's error", async () => {
    d.upstreams.probe = () => ({ reachable: true, auth: "oauth", message: "OAuth" });
    d.upstreams.connect = () => ({ status: "authorize", authorizeUrl: "https://auth.example.com/authorize", callbackMode: "paste", redirectUri: "https://localhost/oauth/connections/callback" });
    const p = new ScriptedPrompter(["", "", "y", "y", "https://localhost/oauth/connections/callback?code=x&state=nope"]);
    expect(await addConnection("https://mcp.linear.app/mcp", {}, deps(p))).toBe(1);
    expect(p.text).toContain("isn't connected: This sign-in link has expired or was already used.");
    expect(p.text).toContain("Reconnect: npx xaq-cli connections reconnect linear");
  });

  it("OAuth on the desktop: opens the browser and waits for the callback to mark it active", async () => {
    d.upstreams.probe = () => ({ reachable: true, auth: "oauth", message: "OAuth" });
    d.upstreams.connect = () => ({ status: "authorize", authorizeUrl: "https://mcp.linear.app/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A8425%2Foauth%2Fconnections%2Fcallback" });
    const opened: string[] = [];
    const d2 = {
      ...deps(new ScriptedPrompter([], true)),
      openBrowser: async (u: string) => {
        opened.push(u);
        // What the callback does on success.
        setTimeout(() => {
          d.giveTools("linear");
          d.h.ctx.db.run("UPDATE connections SET status = 'active', updated_at = ? WHERE slug = 'linear'", new Date(Date.now() + 1000).toISOString());
        }, 5);
      },
    };
    expect(await addConnection("https://mcp.linear.app/mcp", { yes: true }, d2)).toBe(0);
    expect(opened).toHaveLength(1);
  });

  it("a preset renders its setup steps and passes their inputs to the connect", async () => {
    d.upstreams.connect = (conn) => {
      d.giveTools(conn.slug, 7);
      return { status: "connected" };
    };
    const p = new ScriptedPrompter(["nope", "0f8e2c1a-1111", "whsecret", "", "", "", "y"]);
    expect(await addConnection("whoop", {}, deps(p))).toBe(0);
    expect(p.text).toContain("1. Open the WHOOP developer dashboard");
    expect(p.text).toContain("   Open: https://developer-dashboard.whoop.com");
    expect(p.text).toMatch(/   Redirect URI: http:\/\/localhost:\d+\/oauth\/connections\/callback/);
    expect(p.text).toContain("That doesn't look right (it looks like a UUID)");
    expect(row("whoop")).toMatchObject({ preset: "whoop" });
    expect(d.upstreams.connects).toEqual([{ slug: "whoop", input: { inputs: { clientId: "0f8e2c1a-1111", clientSecret: "whsecret" } }, privateTarget: null }]);
    expect(p.text).not.toContain("whsecret");
    expect(p.text).toContain('Connected "whoop": 7 tools');
  });

  it("t3code: the server's address (path added), the private allow, the steps, and a host-named connection", async () => {
    const t3 = await startDaemon({ presets: [presetFromManifest(fixtureExtension("t3code"))] });
    try {
      t3.upstreams.probe = (_u, allow) =>
        allow ? { reachable: true, auth: "oauth", message: "OAuth", issuer: "http://100.104.249.49:3773", registration: "dcr", refresh: false } : { reachable: false, auth: "unknown", blocked: "private_target", message: "blocked" };
      t3.upstreams.connect = (conn) => {
        t3.giveTools(conn.slug, 83);
        return { status: "connected" };
      };
      const p = new ScriptedPrompter([], true);
      const flags = { yes: true, url: "http://100.104.249.49:3773", allowPrivate: "http://100.104.249.49:3773" };
      expect(await addConnection("t3code", flags, { api: t3.api, prompter: p, env: {}, pollMs: 1, timeoutMs: 2000 })).toBe(0);
      expect(t3.h.ctx.db.get("SELECT preset, name, url, private_target FROM connections WHERE slug = 't3-100-104-249-49'")).toEqual({
        preset: "t3code",
        name: "100.104.249.49:3773",
        url: "http://100.104.249.49:3773/mcp",
        private_target: "http://100.104.249.49:3773",
      });
      expect(p.text).toContain("Settings → Connections");
      expect(p.text).toContain('Connected "t3-100-104-249-49": 83 tools');
      // Something that doesn't sign in isn't T3.
      t3.upstreams.probe = () => ({ reachable: true, auth: "none", message: "" });
      await expect(addConnection("t3code", { yes: true, url: "https://other.example.com" }, { api: t3.api, prompter: new ScriptedPrompter([], true), env: {}, pollMs: 1, timeoutMs: 2000 })).rejects.toThrow(
        /doesn't look like a T3 Code server/,
      );
    } finally {
      await t3.dispose();
    }
  });

  it("an unknown integration names what's installed; an official extension that isn't installed says to install it", async () => {
    await expect(addConnection("whop", {}, deps(new ScriptedPrompter([])))).rejects.toThrow(/Unknown integration "whop"\. Installed integrations: whoop\. Install one with `npx xaq-cli ext add <name>`.*or pass an MCP server URL/);
    await expect(addConnection("notion", {}, deps(new ScriptedPrompter([])))).rejects.toThrow("The notion extension isn't installed. Install it first: `npx xaq-cli ext add notion`, then run `npx xaq-cli connections add notion` again.");
    await expect(addConnection("Brightspace", {}, deps(new ScriptedPrompter([])))).rejects.toThrow(/ext add brightspace/);
  });

  it("list, reconnect (header), disable and remove", async () => {
    d.upstreams.probe = () => ({ reachable: true, auth: "header", message: "" });
    await addConnection("https://hearloom.example.com/mcp", { yes: true, header: "Authorization" }, deps(new ScriptedPrompter(["tok-1"], true)));
    d.h.ctx.db.run("UPDATE connections SET status = 'needs_reauth', expires_at = ?, auth_type = 'header' WHERE slug = 'hearloom'", new Date(Date.now() + 3 * 86_400_000 + 60_000).toISOString());
    const p = new ScriptedPrompter(["", "tok-2", "y", "y"]);
    await listConnections(deps(p));
    expect(p.text).toMatch(/hearloom\s+needs_reauth\s+Full access\s+3\s+https:\/\/hearloom\.example\.com\/mcp {2}\(expires in 3 days, Reconnect\)/);
    expect(await reconnectConnection("hearloom", {}, deps(p))).toBe(0);
    expect(d.upstreams.connects.at(-1)).toEqual({ slug: "hearloom", input: { header: { name: "Authorization", value: "Bearer tok-2" } }, privateTarget: null });
    expect(await disableConnection("hearloom", deps(p))).toBe(0);
    expect(row("hearloom")!.status).toBe("disabled");
    expect(await removeConnection("hearloom", deps(p))).toBe(0);
    expect(row("hearloom")).toBeUndefined();
    await expect(reconnectConnection("nope", {}, deps(p))).rejects.toThrow(/No connection "nope". There are none yet/);
  });

  it("slugs and private targets", async () => {
    expect(slugFromUrl(new URL("https://mcp.notion.com/mcp"))).toBe("notion");
    expect(slugFromUrl(new URL("http://127.0.0.1:8787/mcp"))).toBe("127-0-0-1-8787");
    expect(await checkTarget(new URL("http://localhost:3000/mcp"))).toEqual({ kind: "private", origin: "http://localhost:3000", addresses: ["127.0.0.1"] });
    expect(await checkTarget(new URL("https://[fd7a:115c:a1e0::1]/mcp"))).toEqual({ kind: "never", address: "fd7a:115c:a1e0::1", why: "ipv6_literal" });
    expect(await checkTarget(new URL("http://169.254.169.254/latest"))).toEqual({ kind: "never", address: "169.254.169.254", why: "link_local" });
    expect(await checkTarget(new URL("https://example.com/mcp"), publicLookup)).toEqual({ kind: "public" });
    expect(await checkTarget(new URL("https://nas.lan/mcp"), async () => [{ address: "192.168.1.9", family: 4 }])).toMatchObject({ kind: "private", origin: "https://nas.lan:443" });
    // The CLI's exact origin is the server's.
    for (const u of ["http://127.0.0.1:8787/mcp", "https://nas.lan/mcp", "http://100.104.249.49:3773", "http://localhost:3000/mcp"]) expect(exactOrigin(new URL(u))).toBe(serverExactOrigin(u));
  });
});

describe("config readers", () => {
  it("YAML: flow style, anchors and block scalars are unreadable instead of guessed; removal keeps the rest byte for byte", () => {
    const yaml = [
      "a: 1",
      "mcp_servers:",
      "  ok:",
      "    url: 'https://x.example/mcp'  # comment",
      "    args:",
      "      - one",
      '      - "two"',
      "  flow: { url: https://y }",
      "  anchored: &a",
      "    url: https://z",
      "  block:",
      "    url: |",
      "      https://w",
      "  'quoted name':",
      "    url: \"https://q.example/mcp#frag\"",
      "b: 2",
      "",
    ].join("\n");
    const s = readMcpServers(yaml)!;
    expect(s.ok).toEqual({ url: "https://x.example/mcp", args: ["one", "two"] });
    expect(s.flow).toBe(UNREADABLE);
    expect(s.anchored).toBe(UNREADABLE);
    expect((s.block as Record<string, unknown>).url).toBe(UNREADABLE);
    expect(s["quoted name"]).toEqual({ url: "https://q.example/mcp#frag" });
    // An anchor anywhere in the block: never rewritten (a kept entry might use one a removed entry defines).
    expect(removeYamlServers(yaml, ["ok", "quoted name"])).toBeNull();
    const plain = yaml.replace("  anchored: &a\n    url: https://z\n", "");
    expect(removeYamlServers(plain, ["ok", "quoted name"])).toBe(
      ["a: 1", "mcp_servers:", "  flow: { url: https://y }", "  block:", "    url: |", "      https://w", "b: 2", ""].join("\n"),
    );
    expect(removeYamlServers(plain, ["flow"])).toBeNull();
    expect(removeYamlServers("mcp_servers:\n  only:\n    url: x\nz: 1\n", ["only"])).toBe("mcp_servers: {}\nz: 1\n");
    expect(readMcpServers("mcp_servers: {}\n")).toEqual({});
    expect(readMcpServers("other: 1\n")).toEqual({});
  });

  it("TOML: dotted keys, quoted names and inline tables; a server with a value it can't read is UNREADABLE", () => {
    const toml = [
      'mcp_servers.dotted.url = "https://d.example/mcp"',
      '[mcp_servers."my server"]',
      "url = 'https://m.example/mcp'",
      'http_headers = { "X-Key" = "k\\u0041" }',
      "[mcp_servers.multi]",
      'description = """',
      "long",
      '"""',
      "[other]",
      "x = [[1, 2], [3]]",
    ].join("\n");
    const s = readTomlMcpServers(toml);
    expect(s.dotted).toEqual({ url: "https://d.example/mcp" });
    expect(s["my server"]).toEqual({ url: "https://m.example/mcp", http_headers: { "X-Key": "kA" } });
    expect(s.multi).toBe(TOML_UNREADABLE);
  });
});
