import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../server/api/util.ts";
import type { Account, ConnectAccountResponse } from "../shared/types.ts";
import { accountsApi } from "../server/api/accounts.ts";
import { googleApi } from "../server/api/google.ts";
import { callbackPage, OAUTH_CALLBACK_SCRIPT, OAUTH_CALLBACK_SCRIPT_HASH, oauthRoutes } from "../server/api/oauth.ts";
import type { AppContext } from "../server/context.ts";
import { adminAuth } from "../server/auth/index.ts";
import { AlreadyConnectedError, COMPLETED_MAX, COMPLETED_TTL_MS, completedAccount, connectAttempt, rememberCompleted, rememberFailed, storedFailure } from "../server/google/oauth.ts";
import { AccountNeedsReauthError, GoogleApiError } from "../server/google/types.ts";
import { HttpError } from "../server/util/errors.ts";
import { connectFakeAccount, FAKE_CLIENT, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

let fake: FakeGoogle;
let ctx: AppContext;
let rec: ReturnType<typeof recordingEvents>;
let dispose: () => Promise<void>;

beforeEach(async () => {
  fake = await startFakeGoogle();
  rec = recordingEvents();
  const t = testContext({ events: rec.factory }, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
});

afterEach(async () => {
  await dispose();
  await fake.close();
});

/** Mirrors server/app.ts: HttpError → ApiError JSON. */
function withErrors<T extends Hono<AppEnv>>(app: T): T {
  app.onError((err, c) =>
    err instanceof HttpError ? c.json(err.toJSON(), err.status as ContentfulStatusCode) : c.json({ error: { code: "internal", message: err.message } }, 500),
  );
  return app;
}

const tokenCalls = () => fake.requests.filter((r) => r.path === "/token").length;

async function consentRedirect(email: string, opts: Parameters<FakeGoogle["consentAs"]>[1] = {}, reauthAccountId?: string) {
  fake.addAccount(email);
  fake.consentAs(email, opts);
  const { authUrl } = ctx.google.startConnect({ reauthAccountId });
  const res = await fetch(authUrl, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

describe("OAuth client config", () => {
  it("stores the secret encrypted and never returns it", async () => {
    expect(ctx.google.clientView()).toMatchObject({ clientId: null, hasSecret: false, callbackMode: "direct" });
    const app = googleApi(ctx);
    const res = await app.request("/google/client", {
      method: "PUT",
      body: JSON.stringify({ ...FAKE_CLIENT, appType: "external" }),
    });
    const view = await res.json();
    expect(view).toEqual({
      clientId: FAKE_CLIENT.clientId,
      hasSecret: true,
      projectId: FAKE_CLIENT.projectId,
      appType: "external",
      redirectUri: `http://localhost:${ctx.config.port}/oauth/callback`,
      callbackMode: "direct",
      secretHint: FAKE_CLIENT.clientSecret.slice(-4),
      redirectUriConfirmed: true,
      warnings: [],
      check: { clientId: "ok", redirectUri: "ok", secret: "ok", warnings: [] },
    });
    expect(JSON.stringify(view)).not.toContain(FAKE_CLIENT.clientSecret);
    expect(JSON.stringify(ctx.settings.getState("google.client"))).not.toContain(FAKE_CLIENT.clientSecret);
    // Updating without a secret keeps the stored one.
    expect(ctx.google.setClient({ clientId: FAKE_CLIENT.clientId, projectId: "other-project", appType: "internal" }).hasSecret).toBe(true);
    expect(ctx.audit.list({ action: "google.client.update" }).items).toHaveLength(1);
  });

  it("validates the client id and project id with hints", () => {
    expect(() => ctx.google.setClient({ clientId: "nope", clientSecret: "x", projectId: "", appType: "internal" })).toThrow(/OAuth client ID/);
    expect(() => ctx.google.setClient({ ...FAKE_CLIENT, projectId: "My Project", appType: "internal" })).toThrow(/project ID/);
    expect(() => ctx.google.setClient({ clientId: FAKE_CLIENT.clientId, projectId: "", appType: "internal" })).toThrow(/secret is required/);
  });

  it("uses direct callbacks for https/localhost and paste mode otherwise", () => {
    ctx.settings.update({ publicUrl: "https://mail.example.com" });
    expect(ctx.google.clientView()).toMatchObject({ callbackMode: "direct", redirectUri: "https://mail.example.com/oauth/callback" });
    ctx.settings.update({ publicUrl: "http://127.0.0.1:9000" });
    expect(ctx.google.redirectUri()).toBe("http://127.0.0.1:9000/oauth/callback");
    ctx.settings.update({ publicUrl: "http://nas.local:8425" });
    expect(ctx.google.clientView()).toMatchObject({
      callbackMode: "paste",
      redirectUri: `http://localhost:${ctx.config.port}/oauth/callback`,
    });
  });
});

describe("connect", () => {
  beforeEach(() => {
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
  });

  it("builds a PKCE consent URL with offline access", () => {
    const { authUrl, state, callbackMode } = ctx.google.startConnect();
    const u = new URL(authUrl);
    expect(callbackMode).toBe("direct");
    expect(u.pathname).toBe("/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: FAKE_CLIENT.clientId,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge_method: "S256",
      response_type: "code",
      state,
    });
    expect(u.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.modify");
  });

  it("completes a direct-mode callback and renders a success page", async () => {
    fake.addAccount("alice@example.com", { name: "Alice Example" });
    const accountEvents: string[] = [];
    ctx.bus.on("account", (a) => accountEvents.push(a.email));
    const loc = await consentRedirect("alice@example.com");
    expect(loc.pathname).toBe("/oauth/callback");
    const res = await oauthRoutes(ctx).request(`${loc.pathname}${loc.search}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connected alice@example.com. You can close this tab.");
    expect(html).toContain('<script type="application/json" id="oauth-result">{"ok":true,"email":"alice@example.com"');
    expect(html).toContain("prefers-color-scheme: dark");

    const [acct] = ctx.accounts.list();
    expect(acct).toMatchObject({ email: "alice@example.com", displayName: "Alice Example", status: "active", lastError: null });
    // Baseline cursor from the profile (no backfill).
    expect(acct!.historyId).toBe("1000");
    expect(accountEvents).toContain("alice@example.com");
    expect(ctx.audit.list({ action: "account.connect" }).items[0]).toMatchObject({ actorType: "admin", accountId: acct!.id });
    // Tokens are encrypted at rest.
    const row = ctx.db.get<{ refresh_token_enc: string }>("SELECT refresh_token_enc FROM accounts");
    expect(row!.refresh_token_enc.startsWith("v1:")).toBe(true);
  });

  it("completes a paste-mode flow through the API", async () => {
    ctx.settings.update({ publicUrl: "http://nas.local:8425" });
    const app = withErrors(accountsApi(ctx));
    fake.addAccount("bob@gmail.com");
    fake.consentAs("bob@gmail.com");
    const start = (await (await app.request("/accounts/connect", { method: "POST" })).json()) as ConnectAccountResponse;
    expect(start.callbackMode).toBe("paste");
    const landed = (await fetch(start.authUrl, { redirect: "manual" })).headers.get("location")!;
    expect(landed.startsWith(`http://localhost:${ctx.config.port}/oauth/callback?`)).toBe(true);
    const res = await app.request("/accounts/connect/complete", { method: "POST", body: JSON.stringify({ url: `  ${landed}  ` }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: "bob@gmail.com", status: "active" });
    // Pasting it again (the admin-only endpoint): 409 naming the account, so the console shows it connected.
    const again = await app.request("/accounts/connect/complete", { method: "POST", body: JSON.stringify({ url: landed }) });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: { code: "oauth_already_connected", message: "Already connected: bob@gmail.com.", hint: expect.any(String) as string, email: "bob@gmail.com" },
    });
    expect(((await (await app.request("/accounts")).json()) as Account[]).map((a) => a.email)).toEqual(["bob@gmail.com"]);
  });

  it("rejects reused state, denied consent and URLs without a code", async () => {
    const loc = await consentRedirect("carol@example.com");
    await ctx.google.completeConnectFromUrl(loc.toString());
    const tokenCallsAfter = tokenCalls();
    // The same address again (a reload): reported as done, nothing exchanged.
    const again = await ctx.google.completeConnectFromUrl(loc.toString()).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(AlreadyConnectedError);
    expect((again as AlreadyConnectedError).message).toBe("Already connected: carol@example.com.");
    // The used state with any other code is just used.
    const forged = new URL(loc);
    forged.searchParams.set("code", "another-code");
    await expect(ctx.google.completeConnectFromUrl(forged.toString())).rejects.toThrow(/expired or was already used/);
    expect(tokenCalls()).toBe(tokenCallsAfter);

    const denied = await consentRedirect("carol@example.com", { deny: true });
    const err = await ctx.google.completeConnectFromUrl(denied.toString()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toMatch(/clicked Cancel \(or denied access\)/);
    expect((err as HttpError).code).toBe("oauth_access_denied");
    expect((err as HttpError).hint).toMatch(/Nothing needs fixing in Google Cloud/);
    expect((err as HttpError).hint).not.toMatch(/test user/i);

    await expect(ctx.google.completeConnectFromUrl("http://localhost/oauth/callback")).rejects.toThrow(/doesn't contain an authorization code/);
    const org = await ctx.google.completeConnectFromUrl("http://localhost/oauth/callback?error=org_internal").catch((e: unknown) => e);
    expect((org as HttpError).message).toMatch(/Internal, so only accounts in its own Google Workspace organization/);
    expect((org as HttpError).code).toBe("oauth_org_internal");
  });

  it("errors with a hint when Google returns no refresh token", async () => {
    const loc = await consentRedirect("dan@example.com", { noRefreshToken: true });
    const err = (await ctx.google.completeConnectFromUrl(loc.toString()).catch((e: unknown) => e)) as HttpError;
    expect(err.message).toMatch(/refresh token/);
    expect(err.hint).toContain("https://myaccount.google.com/permissions");
    expect(ctx.accounts.list()).toHaveLength(0);
  });

  it("rejects consent without Gmail access", async () => {
    const loc = await consentRedirect("erin@example.com", { scopes: ["openid", "https://www.googleapis.com/auth/pubsub"] });
    await expect(ctx.google.completeConnectFromUrl(loc.toString())).rejects.toThrow(/Gmail access wasn't granted/);
  });

  it("reauth must land on the same email and reactivates the account", async () => {
    const acct = await connectFakeAccount(ctx, fake, "frank@example.com");
    ctx.accounts.setStatus(acct.id, "needs_reauth", "boom");
    const wrong = await consentRedirect("someone-else@example.com", {}, acct.id);
    const err = (await ctx.google.completeConnectFromUrl(wrong.toString()).catch((e: unknown) => e)) as HttpError;
    expect(err.code).toBe("oauth_wrong_account");
    expect(err.message).toBe(
      "You were reconnecting frank@example.com, but signed in to Google as someone-else@example.com, so frank@example.com is still not reconnected. " +
        "xaq didn't keep the sign-in for someone-else@example.com.",
    );
    expect(err.hint).toMatch(/^Reconnect frank@example.com again and pick frank@example.com in Google's account chooser/);
    expect(ctx.accounts.list()).toHaveLength(1);
    const again = await connectFakeAccount(ctx, fake, "frank@example.com", { reauthAccountId: acct.id });
    expect(again).toMatchObject({ id: acct.id, status: "active", lastError: null });
    expect(new URL(ctx.google.startConnect({ reauthAccountId: acct.id }).authUrl).searchParams.get("login_hint")).toBe("frank@example.com");
  });

  it("never revokes the tokens of another connected account picked during a reconnect", async () => {
    const a = await connectFakeAccount(ctx, fake, "anna@example.com");
    const b = await connectFakeAccount(ctx, fake, "ben@example.com");
    ctx.accounts.setStatus(a.id, "needs_reauth", "revoked");
    ctx.accounts.setStatus(b.id, "needs_reauth", "revoked too");
    const before = ctx.db.get<{ refresh_token_enc: string }>("SELECT refresh_token_enc FROM accounts WHERE id = ?", b.id)!;
    const accountEvents: { email: string; status: string }[] = [];
    ctx.bus.on("account", (x) => accountEvents.push({ email: x.email, status: x.status }));
    const landed = await consentRedirect("ben@example.com", {}, a.id);
    await expect(ctx.google.completeConnectFromUrl(landed.toString())).rejects.toThrow(
      "You were reconnecting anna@example.com, but signed in to Google as ben@example.com, so anna@example.com is still not reconnected. " +
        "ben@example.com is also connected here, so xaq saved that new sign-in for ben@example.com; nothing else changed.",
    );
    expect(fake.revoked).toEqual([]);
    expect(accountEvents).toContainEqual({ email: "ben@example.com", status: "active" });
    // B got the fresh tokens and works; A still needs a reconnect.
    const after = ctx.db.get<{ refresh_token_enc: string }>("SELECT refresh_token_enc FROM accounts WHERE id = ?", b.id)!;
    expect(after.refresh_token_enc).not.toBe(before.refresh_token_enc);
    expect(ctx.accounts.get(b.id)!.status).toBe("active");
    await expect(ctx.google.gmail(b.id).getProfile()).resolves.toMatchObject({ emailAddress: "ben@example.com" });
    expect(ctx.accounts.get(a.id)!.status).toBe("needs_reauth");
  });

  it("says the other connected account wasn't changed when Google sent no refresh token", async () => {
    const a = await connectFakeAccount(ctx, fake, "amy@example.com");
    await connectFakeAccount(ctx, fake, "bob@example.com");
    const landed = await consentRedirect("bob@example.com", { noRefreshToken: true }, a.id);
    await expect(ctx.google.completeConnectFromUrl(landed.toString())).rejects.toThrow(
      "You were reconnecting amy@example.com, but signed in to Google as bob@example.com, so amy@example.com is still not reconnected. " +
        "bob@example.com is also connected here and wasn't changed.",
    );
    expect(fake.revoked).toEqual([]);
  });

  it("revokes per user like Google: removing one account doesn't touch others", async () => {
    const a = await connectFakeAccount(ctx, fake, "one@example.com");
    const b = await connectFakeAccount(ctx, fake, "two@example.com");
    await ctx.accounts.remove(a.id);
    ctx.db.run("UPDATE accounts SET access_expires_at = ?", new Date(0).toISOString());
    await expect(ctx.google.gmail(b.id).getProfile()).resolves.toMatchObject({ emailAddress: "two@example.com" });
  });

  it("fails clearly when the account being reconnected was removed meanwhile", async () => {
    const a = await connectFakeAccount(ctx, fake, "gone@example.com");
    fake.consentAs("gone@example.com");
    const { authUrl } = ctx.google.startConnect({ reauthAccountId: a.id });
    await ctx.accounts.remove(a.id);
    const revokedBefore = fake.revoked.length;
    const landed = (await fetch(authUrl, { redirect: "manual" })).headers.get("location")!;
    await expect(ctx.google.completeConnectFromUrl(landed)).rejects.toThrow(/was removed from xaq in the meantime\. xaq didn't keep the sign-in for gone@example.com/);
    expect(ctx.accounts.list()).toHaveLength(0);
    // Not connected here, so the fresh grant is revoked rather than left dangling.
    expect(fake.revoked.length).toBe(revokedBefore + 1);
  });

  it("keeps a paused account paused when it is reconnected", async () => {
    const a = await connectFakeAccount(ctx, fake, "pia@example.com");
    await ctx.ingest.pause(a.id);
    const again = await connectFakeAccount(ctx, fake, "pia@example.com", { reauthAccountId: a.id });
    expect(again).toMatchObject({ id: a.id, status: "paused", lastError: null });
  });

  it("does not retry the one-time code exchange after a server error", async () => {
    const landed = await consentRedirect("hal@example.com");
    fake.failNext({ path: "/token", status: 500, retryAfter: 0 });
    const before = tokenCalls();
    await expect(ctx.google.completeConnectFromUrl(landed.toString())).rejects.toBeInstanceOf(HttpError);
    expect(tokenCalls()).toBe(before + 1);
  });

  it("reloading the callback page after success says Already connected and changes nothing", async () => {
    const loc = await consentRedirect("rita@example.com");
    const routes = oauthRoutes(ctx);
    const path = `${loc.pathname}${loc.search}`;
    expect((await routes.request(path)).status).toBe(200);
    const events: string[] = [];
    ctx.bus.on("account", (a) => events.push(a.email));
    const before = tokenCalls();
    const resultOf = (html: string) =>
      JSON.parse(/<script type="application\/json" id="oauth-result">([^<]*)<\/script>/.exec(html)![1]!) as Record<string, unknown>;

    // Without a console session (a URL from history or a proxy log): done, but no email.
    let res = await routes.request(path);
    expect(res.status).toBe(200);
    let html = await res.text();
    expect(html).toContain("<h1>This sign-in was already completed</h1>");
    expect(html).not.toContain("rita@example.com");
    expect(html).toContain("Back to the console");
    expect(resultOf(html)).toMatchObject({ ok: true, already: true, email: null });

    // The admin's own browser (signed in to the console): names the account.
    const cookie = `aib_session=${adminAuth(ctx).sessions.create()}`;
    html = await (await routes.request(path, { headers: { cookie } })).text();
    expect(html).toContain("<h1>Already connected: rita@example.com</h1>");
    expect(html).not.toContain("Couldn&#39;t connect");
    expect(resultOf(html)).toMatchObject({ ok: true, already: true, email: "rita@example.com" });
    // The script returns before posting anything to the console for a reload.
    expect(OAUTH_CALLBACK_SCRIPT.indexOf("if (r.already)")).toBeLessThan(OAUTH_CALLBACK_SCRIPT.indexOf("postMessage"));

    // The right state with a wrong or missing code is just a used link, whoever asks.
    for (const code of ["wrong-code", null]) {
      const u = new URL(loc);
      if (code) u.searchParams.set("code", code);
      else u.searchParams.delete("code");
      const page = await (await routes.request(`${u.pathname}${u.search}`, { headers: { cookie } })).text();
      expect(page).not.toContain("rita@example.com");
      expect(page).not.toContain("Already connected");
    }

    expect(tokenCalls()).toBe(before);
    expect(events).toEqual([]);
    expect(ctx.audit.list({ action: "account.connect" }).items).toHaveLength(1);

    // Once the account is removed, the old address is just a used link.
    await ctx.accounts.remove(ctx.accounts.list()[0]!.id);
    const gone = await (await routes.request(path, { headers: { cookie } })).text();
    expect(gone).toContain("expired or was already used");
  });

  it("forgets finished sign-ins after an hour, and keeps at most COMPLETED_MAX", async () => {
    const acct = await connectFakeAccount(ctx, fake, "ttl@example.com");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      rememberCompleted(ctx, "state-ttl", "code-ttl", acct.id);
      expect(completedAccount(ctx, "state-ttl", "code-ttl")?.email).toBe("ttl@example.com");
      expect(completedAccount(ctx, "state-ttl", "code-other")).toBeNull();
      expect(completedAccount(ctx, "state-ttl", "")).toBeNull();
      vi.setSystemTime(Date.now() + COMPLETED_TTL_MS + 1);
      expect(completedAccount(ctx, "state-ttl", "code-ttl")).toBeNull();

      rememberCompleted(ctx, "state-0", "code-0", acct.id);
      for (let i = 1; i <= COMPLETED_MAX; i++) rememberCompleted(ctx, `state-${i}`, `code-${i}`, acct.id);
      expect(completedAccount(ctx, "state-0", "code-0")).toBeNull(); // the oldest went first
      expect(completedAccount(ctx, "state-1", "code-1")).not.toBeNull();
      expect(completedAccount(ctx, `state-${COMPLETED_MAX}`, `code-${COMPLETED_MAX}`)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets a later failure overwrite a finished sign-in's status", async () => {
    const acct = await connectFakeAccount(ctx, fake, "keep@example.com");
    rememberCompleted(ctx, "state-keep", "code-keep", acct.id);
    rememberFailed(ctx, "state-keep", new HttpError(400, "oauth_state", "This sign-in link has expired or was already used."));
    expect(connectAttempt(ctx, "state-keep")).toEqual({ status: "connected", accountId: acct.id, email: "keep@example.com" });
    rememberFailed(ctx, "state-lost", new HttpError(400, "oauth_no_code", "No code."));
    expect(connectAttempt(ctx, "state-lost")).toMatchObject({ status: "failed", code: "oauth_no_code" });
  });

  it("stores only fixed text for Google's redirect errors, never the URL's error_description", async () => {
    const evil = "<b>Call +1 555 0100 to restore access</b>".repeat(50);
    for (const [error, code] of [
      ["access_denied", "oauth_access_denied"],
      ["org_internal", "oauth_org_internal"],
      [`made_up_${"x".repeat(5000)}`, "oauth_error"],
    ] as const) {
      const { state } = ctx.google.startConnect();
      const res = await oauthRoutes(ctx).request(`/oauth/callback?state=${state}&error=${encodeURIComponent(error)}&error_description=${encodeURIComponent(evil)}`);
      expect(res.status).toBe(400);
      const status = connectAttempt(ctx, state);
      expect(status).toMatchObject({ status: "failed", code });
      const text = JSON.stringify(status);
      expect(text).not.toContain("555 0100");
      expect(text).not.toContain("made_up");
      expect(text.length).toBeLessThan(1500);
    }
    // Our own errors keep their text, capped.
    const long = storedFailure(new HttpError(400, "x".repeat(200), "m".repeat(5000), "h".repeat(5000)));
    expect(long.code.length).toBeLessThanOrEqual(64);
    expect(long.error.length).toBeLessThanOrEqual(500);
    expect(long.hint!.length).toBeLessThanOrEqual(1000);
  });

  it("escapes Google's error_description on the callback page", async () => {
    const res = await oauthRoutes(ctx).request(`/oauth/callback?error=access_denied&error_description=${encodeURIComponent("<script>alert(1)</script>")}&state=x`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
  });

  it("uses one static, hashable script on every callback page", async () => {
    const scripts = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const okHtml = callbackPage({ ok: true, email: "a@b.test", title: "t", message: "m", targetOrigin: "https://x.test" });
    const errHtml = callbackPage({ ok: false, title: "t", message: "</script><script>alert(1)</script>", hint: "h", targetOrigin: "*" });
    expect(scripts(okHtml)).toEqual([OAUTH_CALLBACK_SCRIPT]);
    expect(scripts(errHtml)).toEqual([OAUTH_CALLBACK_SCRIPT]);
    expect(OAUTH_CALLBACK_SCRIPT_HASH).toBe(`sha256-${createHash("sha256").update(OAUTH_CALLBACK_SCRIPT).digest("base64")}`);
    // Dynamic data is JSON in a data block with "<" escaped, so it can't close the element.
    const data = /<script type="application\/json" id="oauth-result">([^<]*)<\/script>/.exec(errHtml)![1]!;
    expect(JSON.parse(data)).toEqual({ ok: false, email: null, error: "</script><script>alert(1)</script>", code: "internal", hint: "h", targetOrigin: "*" });
    expect(errHtml).not.toContain("<script>alert(1)");
  });

  it("renders an escaped error page on callback failure", async () => {
    const res = await oauthRoutes(ctx).request("/oauth/callback?error=%3Cscript%3Ealert(1)%3C/script%3E");
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Couldn&#39;t connect the account");
  });

  it("removes an account: revokes the token and deletes the row", async () => {
    const acct = await connectFakeAccount(ctx, fake, "gina@example.com");
    const res = await accountsApi(ctx).request(`/accounts/${acct.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(ctx.accounts.list()).toHaveLength(0);
    expect(fake.revoked.some((t) => t.startsWith("1//fake-rt-"))).toBe(true);
    expect(ctx.audit.list({ action: "account.remove" }).items).toHaveLength(1);
  });
});

describe("tokens", () => {
  let accountId: string;
  beforeEach(async () => {
    accountId = (await connectFakeAccount(ctx, fake, "tess@example.com")).id;
  });

  it("caches access tokens and refreshes once (single-flight) when stale", async () => {
    const gmail = ctx.google.gmail(accountId);
    const before = tokenCalls();
    await gmail.getProfile();
    expect(tokenCalls()).toBe(before);
    ctx.db.run("UPDATE accounts SET access_expires_at = ?", new Date(Date.now() + 30_000).toISOString());
    await Promise.all([gmail.getProfile(), gmail.listLabels(), gmail.getProfile()]);
    expect(tokenCalls()).toBe(before + 1);
    await gmail.getProfile();
    expect(tokenCalls()).toBe(before + 1);
  });

  it("explains Workspace session-control reauth (invalid_rapt)", async () => {
    fake.failRefresh("tess@example.com", { rapt: true });
    ctx.db.run("UPDATE accounts SET access_expires_at = ?", new Date(0).toISOString());
    await expect(ctx.google.gmail(accountId).getProfile()).rejects.toBeInstanceOf(AccountNeedsReauthError);
    const acct = ctx.accounts.get(accountId)!;
    expect(acct.status).toBe("needs_reauth");
    expect(acct.lastError).toMatch(/invalid_rapt.*Workspace admin requires periodic re-authentication.*exempt this app/);
  });

  it("refreshes and retries once on 401", async () => {
    fake.expireAccessTokens("tess@example.com");
    const before = tokenCalls();
    await expect(ctx.google.gmail(accountId).getProfile()).resolves.toMatchObject({ emailAddress: "tess@example.com" });
    expect(tokenCalls()).toBe(before + 1);
  });

  it("marks the account needs_reauth on invalid_grant and emits one auth_failed event", async () => {
    fake.failRefresh("tess@example.com");
    const err = await ctx.google.gmail(accountId).getProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountNeedsReauthError);
    const acct = ctx.accounts.get(accountId)!;
    expect(acct.status).toBe("needs_reauth");
    expect(acct.lastError).toMatch(/Reconnect the account/);
    const failed = rec.ofType("account.auth_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ accountId, detail: { email: "tess@example.com" } });
    expect(failed[0]!.dedupeKey).toMatch(new RegExp(`^${accountId}:auth_failed:[0-9a-f]{12}$`));
    expect(ctx.audit.list({ action: "account.auth_failed" }).items[0]).toMatchObject({ actorType: "system", outcome: "error" });
    // Subsequent calls fail fast without hammering Google.
    const calls = tokenCalls();
    await expect(ctx.google.gmail(accountId).listLabels()).rejects.toBeInstanceOf(AccountNeedsReauthError);
    expect(tokenCalls()).toBe(calls);
    // The API reports it as a 409 with a hint.
    const res = await withErrors(accountsApi(ctx)).request(`/accounts/${accountId}/labels`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "needs_reauth", hint: expect.stringMatching(/Reconnect/) } });
  });
});

describe("Gmail client", () => {
  let accountId: string;
  beforeEach(async () => {
    accountId = (await connectFakeAccount(ctx, fake, "quinn@example.com")).id;
  });

  it("retries 429, 5xx and 403 rate limits, honoring Retry-After", async () => {
    const gmail = ctx.google.gmail(accountId);
    fake.failNext({ path: "/profile", status: 429, retryAfter: 0, times: 2 });
    await expect(gmail.getProfile()).resolves.toMatchObject({ emailAddress: "quinn@example.com" });
    fake.failNext({ path: "/labels", status: 403, reason: "userRateLimitExceeded", retryAfter: 0 });
    fake.failNext({ path: "/labels", status: 503, retryAfter: 0 });
    await expect(gmail.listLabels()).resolves.toContainEqual(expect.objectContaining({ id: "INBOX" }));
  });

  it("gives up after 5 attempts and does not retry client errors", async () => {
    const gmail = ctx.google.gmail(accountId);
    fake.failNext({ path: "/profile", status: 500, retryAfter: 0, times: 5 });
    const err = (await gmail.getProfile().catch((e: unknown) => e)) as GoogleApiError;
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(500);
    const before = fake.requests.length;
    fake.failNext({ path: "/profile", status: 403, reason: "forbidden", message: "nope" });
    const e2 = (await gmail.getProfile().catch((e: unknown) => e)) as GoogleApiError;
    expect(e2).toMatchObject({ status: 403, reason: "forbidden", message: "nope" });
    expect(fake.requests.length).toBe(before + 1);
    await expect(gmail.getMessage("does-not-exist")).rejects.toMatchObject({ notFound: true });
  });

  it("never re-sends after a 5xx or dropped response, but retries rate limits", async () => {
    const gmail = ctx.google.gmail(accountId);
    const raw = await ctx.google.mime.compose({ from: { name: null, email: "quinn@example.com" }, to: [{ name: null, email: "x@y.test" }], subject: "Once", text: "x" });
    fake.failNext({ path: "/messages/send", status: 500, afterProcessing: true, retryAfter: 0 });
    const err = (await gmail.send(raw).catch((e: unknown) => e)) as GoogleApiError;
    expect(err).toMatchObject({ status: 500 });
    expect(err.message).toMatch(/may have been sent: check Sent in Gmail before retrying/);
    expect(fake.sent("quinn@example.com")).toHaveLength(1);

    fake.failNext({ path: "/messages/send", status: 429, retryAfter: 0 });
    fake.failNext({ path: "/messages/send", status: 403, reason: "userRateLimitExceeded", retryAfter: 0 });
    await gmail.send(raw);
    expect(fake.sent("quinn@example.com")).toHaveLength(2);

    const draft = await gmail.createDraft(raw);
    fake.failNext({ path: "/drafts/send", status: 503, afterProcessing: true, retryAfter: 0 });
    await expect(gmail.sendDraft(draft.id)).rejects.toMatchObject({ status: 503 });
    expect(fake.sent("quinn@example.com")).toHaveLength(3);

    // Idempotent reads still retry 5xx.
    fake.failNext({ path: "/profile", status: 503, afterProcessing: true, retryAfter: 0 });
    await expect(gmail.getProfile()).resolves.toMatchObject({ emailAddress: "quinn@example.com" });
  });

  it("lists labels for the console, cached briefly", async () => {
    const id = fake.addLabel("quinn@example.com", "Clients/Acme");
    const labels = await ctx.google.labels(accountId);
    expect(labels[0]).toEqual({ id: "INBOX", name: "INBOX", type: "system" });
    expect(labels).toContainEqual({ id, name: "Clients/Acme", type: "user" });
    const calls = fake.requests.filter((r) => r.path.endsWith("/labels")).length;
    await ctx.google.labels(accountId);
    expect(fake.requests.filter((r) => r.path.endsWith("/labels")).length).toBe(calls);
    const res = await accountsApi(ctx).request(`/accounts/${accountId}/labels`);
    expect(await res.json()).toEqual(labels);
    // A label created meanwhile shows up on a fresh lookup (and refreshes the cache).
    const later = fake.addLabel("quinn@example.com", "Later");
    expect((await ctx.google.labels(accountId)).map((l) => l.id)).not.toContain(later);
    expect((await ctx.google.labels(accountId, { fresh: true })).map((l) => l.id)).toContain(later);
    expect((await ctx.google.labels(accountId)).map((l) => l.id)).toContain(later);
  });
});
