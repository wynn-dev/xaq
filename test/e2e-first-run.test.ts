// E2E 1: first run. A fresh instance is claimed with the setup token and walked through setup over
// the console API; /api/setup/state tracks every step.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Account, GoogleClientView, HealthResponse, SetupState, SetupStatus } from "../shared/types.ts";
import { HAS_AGENTS } from "./e2e/features.ts";
import { AdminClient, FAKE_CLIENT, grant, mailbox, PASSWORD, type Stack, startStack } from "./e2e/harness.ts";

describe("first run", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(() => s.close());

  it("serves health publicly and reports an unclaimed instance", async () => {
    for (const path of ["/health", "/api/health"]) {
      const res = await fetch(`${s.url}${path}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual<HealthResponse>({ status: "ok", version: "0.0.0-e2e", setupComplete: false });
    }
    const status = await s.admin.get<SetupStatus>("/api/setup/status");
    expect(status).toEqual({ claimed: false, authenticated: false });

    // Everything else needs a session; the error tells the console to show the claim screen.
    const denied = await s.admin.failure(s.admin.get("/api/setup/state"));
    expect(denied.status).toBe(401);
    expect(denied.code).toBe("setup_required");

    // The setup link token is on disk (0600) for the CLI banner and `service install`.
    expect(s.setupToken()).toMatch(/^\S{16,}$/);
  });

  it("rejects a claim without the CSRF header or with a wrong token, then claims with the real one", async () => {
    const token = s.setupToken()!;

    const csrf = await s.admin.failure(s.admin.call("POST", "/api/setup/claim", { token, password: PASSWORD }, { csrf: false }));
    expect(csrf.status).toBe(403);
    expect(csrf.code).toBe("csrf");

    const wrong = await s.admin.failure(s.admin.post("/api/setup/claim", { token: `${token}x`, password: PASSWORD }));
    expect(wrong.status).toBe(403);
    expect(wrong.code).toBe("invalid_token");
    expect(s.admin.cookie).toBeNull();

    const short = await s.admin.failure(s.admin.post("/api/setup/claim", { token, password: "short" }));
    expect(short.status).toBe(400);
    expect(s.setupToken()).toBe(token); // a failed claim leaves the link valid

    await s.admin.claim(token);
    expect(s.admin.cookie).toMatch(/^aib_session=.+/);
    expect(s.setupToken()).toBeNull(); // single use

    expect(await s.admin.get<SetupStatus>("/api/setup/status")).toEqual({ claimed: true, authenticated: true });
    const again = await s.admin.failure(s.admin.post("/api/setup/claim", { token, password: PASSWORD }));
    expect(again.status).toBe(409);

    // Another browser without the cookie is not signed in, and can log in with the password.
    const anon = await fetch(`${s.url}/api/setup/status`);
    expect(await anon.json()).toEqual({ claimed: true, authenticated: false });
    const login = await fetch(`${s.url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-xaq-csrf": "1" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(204);
    expect(login.headers.get("set-cookie")).toMatch(/^aib_session=[^;]+;.*HttpOnly/i);
  });

  it("progresses /api/setup/state through client config and account connection", async () => {
    const initial = await s.admin.get<SetupState>("/api/setup/state");
    expect(initial).toMatchObject({
      claimed: true,
      googleClientConfigured: false,
      gcpProjectId: null,
      googleAppType: null,
      accountsConnected: 0,
      agentsCreated: 0,
      complete: false,
      pubsub: { mode: "poll", topic: null, subscription: null },
    });

    // The redirect URI the operator must register follows publicUrl and the bound port.
    const before = await s.admin.get<GoogleClientView>("/api/google/client");
    expect(before).toMatchObject({ clientId: null, hasSecret: false, callbackMode: "direct" });
    expect(before.redirectUri).toBe(`http://localhost:${s.config.port}/oauth/callback`);

    const bad = await s.admin.failure(s.admin.put("/api/google/client", { ...FAKE_CLIENT, clientId: "not-a-client-id", appType: "internal" }));
    expect(bad.status).toBe(400);

    const view = await s.admin.put<GoogleClientView>("/api/google/client", { ...FAKE_CLIENT, appType: "external" });
    expect(view).toMatchObject({ clientId: FAKE_CLIENT.clientId, hasSecret: true, projectId: FAKE_CLIENT.projectId, appType: "external" });
    expect(JSON.stringify(view)).not.toContain(FAKE_CLIENT.clientSecret); // write-only

    expect(await s.admin.get<SetupState>("/api/setup/state")).toMatchObject({
      googleClientConfigured: true,
      gcpProjectId: "fake-project",
      googleAppType: "external",
      accountsConnected: 0,
      complete: false,
    });

    await s.admin.patch("/api/settings", { publicUrl: s.url });
    const account = await s.connectAccount(mailbox("first"), { name: "First Run" });
    expect(account).toMatchObject({ status: "active", displayName: "First Run" });
    expect(account.historyId).toMatch(/^\d+$/);

    const done = await s.admin.get<SetupState>("/api/setup/state");
    expect(done).toMatchObject({ accountsConnected: 1, agentsCreated: 0, complete: true });
    const health = (await (await fetch(`${s.url}/health`)).json()) as HealthResponse;
    expect(health.setupComplete).toBe(true);

    // The public skill points agents at this instance's MCP endpoint.
    const skill = await fetch(`${s.url}/skill.md`);
    expect(skill.headers.get("content-type")).toMatch(/text\/markdown/);
    const md = await skill.text();
    expect(md).toContain(`${s.url}/mcp`);
    expect(md).not.toContain("{{XAQ_URL}}");

    // Signing out invalidates the session server-side.
    const other = new AdminClient(() => s.url);
    await other.post("/api/auth/login", { password: PASSWORD });
    expect(other.cookie).toBeTruthy();
    const stale = other.cookie!;
    await other.post("/api/auth/logout");
    const res = await fetch(`${s.url}/api/setup/state`, { headers: { cookie: stale } });
    expect(res.status).toBe(401);
  });

  it.runIf(HAS_AGENTS)("creates the first agent: the key is shown once and works against /mcp", async () => {
    const [account] = await s.admin.get<Account[]>("/api/accounts");
    const { apiKey, agent } = await s.createAgent("first-agent", [grant(account!.id)]);
    expect(apiKey).toMatch(/^aib_/);
    expect(agent.keyPrefix).toBe(apiKey.slice(0, agent.keyPrefix.length));
    expect((await s.admin.get<SetupState>("/api/setup/state")).agentsCreated).toBe(1);
    expect(await (await fetch(`${s.url}/skill.md`)).text()).not.toContain(apiKey);
    // The MCP endpoint is stateless POST-only.
    expect((await fetch(`${s.url}/mcp`, { headers: { authorization: `Bearer ${apiKey}` } })).status).toBe(405);

    // The key is shown once: listing never returns it.
    const listed = JSON.stringify(await s.admin.get("/api/agents"));
    expect(listed).not.toContain(apiKey);
  });
});
