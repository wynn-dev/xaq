// E2E 2 + 8: connecting accounts through the real OAuth flow (direct callback and paste mode), re-auth
// after the refresh token is revoked, and account removal revoking every agent's access.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Account, Agent, ConnectAccountResponse, ConnectAttempt, GoogleClientView, HealthResponse, MailEvent, Settings } from "../shared/types.ts";
import { HAS_AGENTS } from "./e2e/features.ts";
import { grant, mailbox, type Stack, startStack } from "./e2e/harness.ts";
import { waitFor } from "./e2e/wait.ts";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
  await s.bootstrap();
});
afterAll(() => s.close());

const accountById = async (id: string) => (await s.admin.get<Account[]>("/api/accounts")).find((a) => a.id === id);

describe("connect account", () => {
  it("runs the direct OAuth flow: PKCE consent → /oauth/callback → active account; the state is single-use", async () => {
    const email = mailbox("direct");
    s.fake.addAccount(email, { name: "Direct Desk" });

    const start = await s.admin.post<{ authUrl: string; state: string; callbackMode: string }>("/api/accounts/connect");
    expect(start.callbackMode).toBe("direct");
    const auth = new URL(start.authUrl);
    expect(auth.origin).toBe(s.fake.url);
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({
      client_id: "fake-client.apps.googleusercontent.com",
      redirect_uri: `${s.url}/oauth/callback`,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      code_challenge_method: "S256",
      state: start.state,
    });
    expect(auth.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.modify");

    s.fake.consentAs(email);
    const consent = await fetch(start.authUrl, { redirect: "manual" });
    expect(consent.status).toBe(302);
    const callback = consent.headers.get("location")!;
    expect(callback.startsWith(`${s.url}/oauth/callback?`)).toBe(true);

    const page = await fetch(callback);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Account connected");
    expect(html).toContain(email);

    const account = (await s.admin.get<Account[]>("/api/accounts")).find((a) => a.email === email);
    expect(account).toMatchObject({ status: "active", displayName: "Direct Desk", lastError: null });
    expect(account!.historyId).toMatch(/^\d+$/);

    // Reloading the callback says it's done, without exchanging anything again; only the admin's
    // signed-in browser sees which account.
    const replay = await fetch(callback);
    expect(replay.status).toBe(200);
    const anonymous = await replay.text();
    expect(anonymous).toContain("This sign-in was already completed");
    expect(anonymous).not.toContain(email);
    const mine = await fetch(callback, { headers: { cookie: s.admin.cookie! } });
    expect(await mine.text()).toContain(`Already connected: ${email}`);
    // The used state with another code (a forged replay) fails cleanly.
    const forged = new URL(callback);
    forged.searchParams.set("code", "forged");
    const bad = await fetch(forged);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("expired or was already used");

    // Labels come from Gmail through the account's token.
    const labels = await s.admin.get<{ id: string; name: string }[]>(`/api/accounts/${account!.id}/labels`);
    expect(labels.map((l) => l.id)).toContain("INBOX");
  });

  it("shows Google's consent denial on the callback page and creates no account", async () => {
    const email = mailbox("deny");
    s.fake.addAccount(email);
    const start = await s.admin.post<{ authUrl: string }>("/api/accounts/connect");
    s.fake.consentAs(email, { deny: true });
    const consent = await fetch(start.authUrl, { redirect: "manual" });
    const page = await fetch(consent.headers.get("location")!);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("You clicked Cancel (or denied access) on Google&#39;s screen");
    expect((await s.admin.get<Account[]>("/api/accounts")).some((a) => a.email === email)).toBe(false);
  });

  it("uses paste mode when publicUrl is plain http on a non-localhost host", async () => {
    const before = await s.admin.get<Settings>("/api/settings");
    try {
      await s.admin.patch("/api/settings", { publicUrl: `http://xaq.lan:${s.config.port}` });
      const view = await s.admin.get<GoogleClientView>("/api/google/client");
      expect(view.callbackMode).toBe("paste");
      expect(view.redirectUri).toBe(`http://localhost:${s.config.port}/oauth/callback`);

      const email = mailbox("paste");
      s.fake.addAccount(email);
      const start = await s.admin.post<{ authUrl: string; callbackMode: string }>("/api/accounts/connect");
      expect(start.callbackMode).toBe("paste");
      s.fake.consentAs(email);
      const consent = await fetch(start.authUrl, { redirect: "manual" });
      const landed = consent.headers.get("location")!;
      expect(landed).toMatch(/^http:\/\/localhost:\d+\/oauth\/callback\?code=/);

      // A pasted URL without a code gets an actionable error.
      const junk = await s.admin.failure(s.admin.post("/api/accounts/connect/complete", { url: "http://localhost/oauth/callback?foo=1" }));
      expect(junk.status).toBe(400);
      expect(junk.body?.error.hint).toBeTruthy();

      // The user pastes the URL their browser landed on (which didn't load).
      const account = await s.admin.post<Account>("/api/accounts/connect/complete", { url: `  ${landed}  ` });
      expect(account).toMatchObject({ email, status: "active" });
    } finally {
      await s.admin.patch("/api/settings", { publicUrl: before.publicUrl });
    }
  });

  it("marks the account needs_reauth with an account.auth_failed event when the refresh token is revoked, and reconnecting restores it", async () => {
    const email = mailbox("reauth");
    const account = await s.connectAccount(email);
    const stream = await s.admin.stream();
    try {
      s.fake.failRefresh(email);
      s.kick(account.id); // next Gmail call: 401 → refresh → invalid_grant

      const failed = await waitFor(async () => {
        const a = await accountById(account.id);
        return a?.status === "needs_reauth" ? a : null;
      }, { what: "needs_reauth" });
      expect(failed.lastError).toMatch(/reconnect/i);

      const ev = await s.waitForEvent((e) => e.type === "account.auth_failed" && e.accountId === account.id, { kick: false });
      expect(ev).toMatchObject({ accountEmail: email, message: null });
      expect(ev.detail).toMatchObject({ email });
      await stream.next("account", (a) => a.id === account.id && a.status === "needs_reauth");
      await stream.next("event", (e) => e.type === "account.auth_failed" && e.accountId === account.id);

      // Health turns degraded for uptime monitors; manual resync explains what to do.
      const health = await fetch(`${s.url}/health`);
      expect(health.status).toBe(503);
      expect(((await health.json()) as HealthResponse).status).toBe("degraded");
      const resync = await s.admin.failure(s.admin.post(`/api/accounts/${account.id}/resync`));
      expect(resync.status).toBe(409);

      // Mail that arrives while the account can't sync is picked up after reconnecting (cursor continuity).
      const during = s.fake.deliver(email, { from: "Gap <gap@elsewhere.test>", subject: "During reauth", text: "queued" });

      // Reconnect (the console passes reauthAccountId): same account id, active again.
      const back = await s.connectAccount(email, { reauthAccountId: account.id });
      expect(back).toMatchObject({ id: account.id, status: "active", lastError: null });
      expect((await fetch(`${s.url}/health`)).status).toBe(200);
      await stream.next("account", (a) => a.id === account.id && a.status === "active");

      await s.waitForEvent((e) => e.accountId === account.id && e.message?.id === during.id);

      // Mail flows again with the new token.
      s.fake.deliver(email, { from: "Back <back@elsewhere.test>", subject: "After reauth", text: "hello again" });
      await s.waitForEvent((e) => e.accountId === account.id && e.message?.subject === "After reauth");
    } finally {
      stream.close();
    }
  });

  it("refuses a reconnect that signs in as a different Google account", async () => {
    const email = mailbox("owner");
    const other = mailbox("intruder");
    const account = await s.connectAccount(email);
    s.fake.addAccount(other);
    const start = await s.admin.post<{ authUrl: string }>("/api/accounts/connect", { reauthAccountId: account.id });
    s.fake.consentAs(other);
    const consent = await fetch(start.authUrl, { redirect: "manual" });
    const page = await fetch(consent.headers.get("location")!);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain(`You were reconnecting ${email}, but signed in to Google as ${other}`);
    expect((await s.admin.get<Account[]>("/api/accounts")).some((a) => a.email === other)).toBe(false);
  });
});

describe("connect attempt status (the console's fallback when the callback page can't reach it)", () => {
  const status = (state: string) => s.admin.post<ConnectAttempt>("/api/accounts/connect/status", { state });

  it("reports a reconnect of an already-working account, which the account list alone can't show", async () => {
    const email = mailbox("twin");
    const account = await s.connectAccount(email);
    // Like the console's "Connect Gmail account" with an address that's already here, and like Reconnect.
    for (const body of [{}, { reauthAccountId: account.id }]) {
      const start = await s.admin.post<ConnectAccountResponse>("/api/accounts/connect", body);
      expect(await status(start.state)).toEqual({ status: "pending" });
      s.fake.consentAs(email);
      const consent = await fetch(start.authUrl, { redirect: "manual" });
      const callback = consent.headers.get("location")!;
      expect((await fetch(callback)).status).toBe(200);
      expect(await status(start.state)).toEqual({ status: "connected", accountId: account.id, email });
      // A forged replay of the used state fails on the page but doesn't rewrite the result.
      const forged = new URL(callback);
      forged.searchParams.set("code", "forged");
      expect((await fetch(forged)).status).toBe(400);
      expect(await status(start.state)).toEqual({ status: "connected", accountId: account.id, email });
    }
    const audit = await s.admin.get<{ items: { action: string; accountId: string | null }[] }>("/api/audit");
    expect(audit.items.filter((e) => e.action === "account.reconnect" && e.accountId === account.id).length).toBeGreaterThanOrEqual(2);
  });

  it("reports a failed sign-in with the same code as the callback page", async () => {
    const email = mailbox("deny-status");
    s.fake.addAccount(email);
    const start = await s.admin.post<ConnectAccountResponse>("/api/accounts/connect");
    s.fake.consentAs(email, { deny: true });
    const consent = await fetch(start.authUrl, { redirect: "manual" });
    expect((await fetch(consent.headers.get("location")!)).status).toBe(400);
    expect(await status(start.state)).toMatchObject({ status: "failed", code: "oauth_access_denied", error: expect.stringContaining("Cancel") });

    const owner = await s.connectAccount(mailbox("status-owner"));
    const other = mailbox("status-intruder");
    s.fake.addAccount(other);
    const wrong = await s.admin.post<ConnectAccountResponse>("/api/accounts/connect", { reauthAccountId: owner.id });
    s.fake.consentAs(other);
    const c2 = await fetch(wrong.authUrl, { redirect: "manual" });
    expect((await fetch(c2.headers.get("location")!)).status).toBe(400);
    expect(await status(wrong.state)).toMatchObject({ status: "failed", code: "oauth_wrong_account" });
  });

  it("knows nothing about states it never issued, and is admin-only", async () => {
    expect(await status("not-a-state")).toEqual({ status: "unknown" });
    // An unknown state on the public callback doesn't get remembered as a failure.
    await fetch(`${s.url}/oauth/callback?state=made-up&error=access_denied`);
    expect(await status("made-up")).toEqual({ status: "unknown" });
    const start = await s.admin.post<ConnectAccountResponse>("/api/accounts/connect");
    const anon = await s.admin.request("/api/accounts/connect/status", { json: { state: start.state }, cookie: false });
    expect(anon.status).toBe(401);
  });
});

describe("pause and resume", () => {
  it("stops ingest while paused and catches up on resume", async () => {
    const email = mailbox("pause");
    const account = await s.connectAccount(email);
    const paused = await s.admin.post<Account>(`/api/accounts/${account.id}/pause`);
    expect(paused.status).toBe("paused");

    const during = s.fake.deliver(email, { from: "p@else.test", subject: "While paused", text: "x" });
    s.kick();
    await new Promise((r) => setTimeout(r, 400));
    expect((await s.events({ accountId: account.id })).some((e) => e.message?.id === during.id)).toBe(false);
    const resync = await s.admin.failure(s.admin.post(`/api/accounts/${account.id}/resync`));
    expect(resync.status).toBe(409);

    const resumed = await s.admin.post<Account>(`/api/accounts/${account.id}/resume`);
    expect(resumed.status).toBe("active");
    await s.waitForEvent((e) => e.message?.id === during.id, { accountId: account.id });

    // Manual resync re-scans recent mail without duplicating it and reports a sync.gap.
    await s.admin.post<Account>(`/api/accounts/${account.id}/resync`);
    const events = await s.events({ accountId: account.id });
    expect(events.filter((e) => e.message?.id === during.id)).toHaveLength(1);
    expect(events.find((e) => e.type === "sync.gap")?.detail).toMatchObject({ reason: "manual" });
  });
});

describe("account removal", () => {
  it("revokes the token, stops ingest and 404s afterwards", async () => {
    const email = mailbox("remove-basic");
    const keep = mailbox("keep-basic");
    const account = await s.connectAccount(email);
    await s.connectAccount(keep);
    const revokedBefore = s.fake.revoked.length;
    await s.admin.del(`/api/accounts/${account.id}`);
    expect((await s.admin.get<Account[]>("/api/accounts")).map((a) => a.id)).not.toContain(account.id);
    expect(s.fake.revoked.length).toBe(revokedBefore + 1);

    s.fake.deliver(email, { from: "carol@client.test", subject: "Removed box", text: "x" });
    s.fake.deliver(keep, { from: "carol@client.test", subject: "Kept box", text: "y" });
    await s.waitForEvent((e) => e.message?.subject === "Kept box");
    expect((await s.events()).some((e) => e.message?.subject === "Removed box")).toBe(false);
    expect((await s.admin.failure(s.admin.del(`/api/accounts/${account.id}`))).status).toBe(404);
  });

  it.runIf(HAS_AGENTS)("deletes the account's grants, revokes the token, and the agent loses access over MCP", async () => {
    const email = mailbox("remove");
    const keep = mailbox("keep");
    const account = await s.connectAccount(email);
    const kept = await s.connectAccount(keep);
    const msg = s.fake.deliver(email, { from: "Carol <carol@client.test>", subject: "Contract", text: "Please sign" });

    const { agent, apiKey } = await s.createAgent("remover", [
      grant(account.id, { level: "full" }),
      grant(kept.id, { level: "read" }),
    ]);
    const mcp = await s.agent(apiKey);
    try {
      expect(await mcp.ok("get_message", { account: email, message_id: msg.id })).toContain("Please sign");
      expect(await mcp.tools()).toContain("create_draft");

      const revokedBefore = s.fake.revoked.length;
      await s.admin.del(`/api/accounts/${account.id}`);

      expect((await s.admin.get<Account[]>("/api/accounts")).map((a) => a.id)).not.toContain(account.id);
      const after = await s.admin.get<Agent>(`/api/agents/${agent.id}`);
      expect(after.grants.map((g) => g.accountId)).toEqual([kept.id]);
      expect(s.fake.revoked.length).toBe(revokedBefore + 1);

      // The same MCP client (stateless HTTP) immediately sees the reduced access.
      const accounts = await mcp.ok("list_accounts");
      expect(accounts).toContain(keep);
      expect(accounts).not.toContain(email);
      expect(await mcp.tools()).not.toContain("create_draft");
      const denied = await mcp.call("get_message", { account: email, message_id: msg.id });
      expect(denied.isError).toBe(true);
      expect(denied.text).not.toContain("Please sign");

      // Mail arriving at the removed mailbox produces no events.
      s.fake.deliver(email, { from: "carol@client.test", subject: "After removal", text: "x" });
      s.fake.deliver(keep, { from: "carol@client.test", subject: "Still connected", text: "y" });
      await s.waitForEvent((e) => e.message?.subject === "Still connected");
      const events: MailEvent[] = await s.events();
      expect(events.some((e) => e.message?.subject === "After removal")).toBe(false);

      const missing = await s.admin.failure(s.admin.del(`/api/accounts/${account.id}`));
      expect(missing.status).toBe(404);
    } finally {
      await mcp.close();
    }
  });
});
