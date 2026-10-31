// Onboarding support in server/google: client JSON import, Testing-mode and Workspace detection,
// setup warnings, the test email and OAuth error codes.

import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError, GoogleClientImportResult, SetupWarning, TestEmailResult } from "../shared/types.ts";
import { accountsApi } from "../server/api/accounts.ts";
import { googleApi } from "../server/api/google.ts";
import { oauthRoutes } from "../server/api/oauth.ts";
import type { AppEnv } from "../server/api/util.ts";
import type { AppContext } from "../server/context.ts";
import { googleRuntime } from "../server/google/runtime.ts";
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

function withErrors<T extends Hono<AppEnv>>(app: T): T {
  app.onError((err, c) =>
    err instanceof HttpError ? c.json(err.toJSON(), err.status as ContentfulStatusCode) : c.json({ error: { code: "internal", message: err.message } }, 500),
  );
  return app;
}

const redirectUri = () => ctx.google.redirectUri();
const clientJson = (patch: Record<string, unknown> = {}, kind = "web") =>
  JSON.stringify({
    [kind]: {
      client_id: FAKE_CLIENT.clientId,
      project_id: FAKE_CLIENT.projectId,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      client_secret: FAKE_CLIENT.clientSecret,
      redirect_uris: [redirectUri()],
      javascript_origins: ["http://localhost:8425"],
      ...patch,
    },
  });

async function importJson(json: string, appType?: "internal" | "external") {
  const res = await withErrors(googleApi(ctx)).request("/google/client/import", { method: "POST", body: JSON.stringify({ json, appType }) });
  return { status: res.status, body: (await res.json()) as GoogleClientImportResult & ApiError };
}

const warnings = (code?: SetupWarning["code"]) => ctx.google.setupWarnings().filter((w) => !code || w.code === code);

describe("client JSON import", () => {
  it("saves a Web application client, never echoes the secret and audits", async () => {
    const { status, body } = await importJson(clientJson(), "internal");
    expect(status).toBe(200);
    expect(body).toEqual({
      clientId: FAKE_CLIENT.clientId,
      hasSecret: true,
      projectId: FAKE_CLIENT.projectId,
      appType: "internal",
      redirectUri: redirectUri(),
      callbackMode: "direct",
      secretHint: FAKE_CLIENT.clientSecret.slice(-4),
      redirectUriConfirmed: true,
      warnings: [],
      check: { clientId: "ok", redirectUri: "ok", secret: "ok", warnings: [] },
      registeredRedirectUris: [redirectUri()],
    });
    expect(JSON.stringify(body)).not.toContain(FAKE_CLIENT.clientSecret);
    expect(ctx.audit.list({ action: "google.client.import" }).items[0]).toMatchObject({ outcome: "ok", detail: { clientId: FAKE_CLIENT.clientId, warnings: [] } });
    // The imported client works for connecting.
    await connectFakeAccount(ctx, fake, "a@example.com");
  });

  it("keeps the previous app type when omitted (null on a fresh instance)", async () => {
    expect((await importJson(clientJson())).body.appType).toBeNull();
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "external" });
    expect((await importJson(clientJson())).body.appType).toBe("external");
  });

  it("rejects a Desktop app client with a clear message", async () => {
    const { status, body } = await importJson(clientJson({ redirect_uris: ["http://localhost"] }, "installed"));
    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: "client_json_desktop", message: "This is a Desktop app client. Create a Web application client instead." });
    expect(body.error.hint).toContain(redirectUri());
    expect(ctx.google.clientView().clientId).toBeNull();
  });

  it("rejects files that aren't client JSON", async () => {
    for (const json of ["{not json", "[]", JSON.stringify({ type: "service_account" }), clientJson({ client_id: "123-abc" })]) {
      const { status, body } = await importJson(json);
      expect(status, json).toBe(400);
      expect(body.error.code, json).toBe("client_json_invalid");
      expect(body.error.hint).toMatch(/Download JSON/);
    }
    const project = await importJson(clientJson({ project_id: "My Project" }));
    expect(project.body.error.code).toBe("bad_request");
  });

  it("needs a secret unless one is stored for the same client", async () => {
    const missing = await importJson(clientJson({ client_secret: undefined }));
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("client_secret_missing");
    expect(missing.body.error.hint).toMatch(/Add secret/);

    ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
    const kept = await importJson(clientJson({ client_secret: undefined }));
    expect(kept.status).toBe(200);
    expect(kept.body.hasSecret).toBe(true);
    await connectFakeAccount(ctx, fake, "a@example.com"); // still the right secret
  });

  it("saves a client whose JSON lacks the redirect URI, with a warning that clears once a connection works", async () => {
    fake.registeredRedirectUris = ["https://example.com/oauth/callback"];
    const { status, body } = await importJson(clientJson({ redirect_uris: ["https://example.com/oauth/callback"] }), "internal");
    expect(status).toBe(200);
    expect(body.hasSecret).toBe(true);
    expect(body.registeredRedirectUris).toEqual(["https://example.com/oauth/callback"]);
    expect(body.warnings).toHaveLength(1);
    const w = body.warnings[0]!;
    expect(w).toMatchObject({ code: "redirect_uri_missing", severity: "error", url: `https://console.cloud.google.com/auth/clients?project=${FAKE_CLIENT.projectId}` });
    expect(w.hint).toContain("Google Auth Platform → Clients");
    expect(w.message).toContain(redirectUri());
    expect(w.message).toContain("https://example.com/oauth/callback");
    expect(w.hint).toContain(`add ${redirectUri()}`);
    expect(warnings("redirect_uri_missing")).toHaveLength(1);

    // Manual entry for the same client keeps what the JSON said.
    ctx.google.setClient({ clientId: FAKE_CLIENT.clientId, projectId: FAKE_CLIENT.projectId, appType: "internal" });
    expect(warnings("redirect_uri_missing")).toHaveLength(1);

    // The operator added the URI in Google without re-downloading; a successful connection proves it.
    fake.registeredRedirectUris = null;
    await connectFakeAccount(ctx, fake, "a@example.com");
    expect(warnings("redirect_uri_missing")).toEqual([]);

    // A different publicUrl means a different redirect URI: unverified again.
    ctx.settings.update({ publicUrl: "https://mail.example.org" });
    expect(warnings("redirect_uri_missing")[0]!.message).toContain("https://mail.example.org/oauth/callback");
  });

  it("drops redirect knowledge when a different client is entered manually", async () => {
    fake.registeredRedirectUris = [];
    await importJson(clientJson({ redirect_uris: [] }));
    expect(warnings("redirect_uri_missing")[0]!.message).toMatch(/It lists none/);
    ctx.google.setClient({ clientId: "other.apps.googleusercontent.com", clientSecret: "s", projectId: "", appType: "internal" });
    expect(warnings("redirect_uri_missing")).toEqual([]);
  });

  it("keeps PUT /google/client working", async () => {
    const res = await withErrors(googleApi(ctx)).request("/google/client", { method: "PUT", body: JSON.stringify({ ...FAKE_CLIENT, appType: "external" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ clientId: FAKE_CLIENT.clientId, hasSecret: true, appType: "external" });
  });
});

describe("Testing mode and Workspace detection", () => {
  it("records the refresh token expiry from the code exchange and refreshes, and clears it on a long-lived reconnect", async () => {
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "external" });
    fake.refreshTokenTtl = 604_800;
    const acct = await connectFakeAccount(ctx, fake, "tess@gmail.com");
    const at = Date.parse(acct.refreshTokenExpiresAt!);
    expect(Math.abs(at - (Date.now() + 604_800_000))).toBeLessThan(10_000);
    expect(acct.refreshTokenExpiryKind).toBe("testing");
    expect(acct.workspaceDomain).toBeNull();

    const [w] = warnings("testing_mode");
    expect(w).toMatchObject({
      severity: "warning",
      accountId: acct.id,
      url: `https://console.cloud.google.com/auth/audience?project=${FAKE_CLIENT.projectId}`,
      hint: "Google Cloud → Google Auth Platform → Audience → Publish app → Push to production? → Confirm. Then reconnect the account so it gets a long-lived token.",
    });
    expect(w!.message).toContain("tess@gmail.com");
    expect(w!.message).toContain(acct.refreshTokenExpiresAt!.slice(0, 10));

    // A refresh reports the time left: the stored expiry follows it.
    ctx.db.run("UPDATE accounts SET refresh_expires_at = ? WHERE id = ?", "2000-01-01T00:00:00.000Z", acct.id);
    await googleRuntime(ctx).tokens.accessToken(acct.id, { force: true });
    expect(Math.abs(Date.parse(ctx.accounts.get(acct.id)!.refreshTokenExpiresAt!) - at)).toBeLessThan(10_000);

    // Published app: the reconnect gets a long-lived token.
    fake.refreshTokenTtl = null;
    const again = await connectFakeAccount(ctx, fake, "tess@gmail.com", { reauthAccountId: acct.id });
    expect(again.refreshTokenExpiresAt).toBeNull();
    expect(again.refreshTokenExpiryKind).toBeNull();
    // A refresh without refresh_token_expires_in leaves the column alone.
    await googleRuntime(ctx).tokens.accessToken(acct.id, { force: true });
    expect(ctx.accounts.get(acct.id)!.refreshTokenExpiresAt).toBeNull();
    expect(warnings("testing_mode")).toEqual([]);
  });

  it("treats other lifetimes (time-based access) as a neutral expiry, not Testing", async () => {
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "external" });
    fake.refreshTokenTtl = 30 * 86_400;
    const acct = await connectFakeAccount(ctx, fake, "tina@gmail.com");
    expect(acct.refreshTokenExpiryKind).toBe("time_based");
    expect(warnings("testing_mode")).toEqual([]);
    const [w] = warnings("sign_in_expires");
    expect(w).toMatchObject({ severity: "warning", accountId: acct.id });
    expect(w!.message).toMatch(/^Google will expire the sign-in for tina@gmail.com on \d{4}-\d{2}-\d{2}/);
    expect(w!.hint).toMatch(/Reconnect tina@gmail.com before then/);
    expect(w!.url).toBeUndefined();
    // 7 days ± 1 day still counts as Testing.
    fake.refreshTokenTtl = 604_800 - 3600;
    const t = await connectFakeAccount(ctx, fake, "tom@gmail.com");
    expect(t.refreshTokenExpiryKind).toBe("testing");
  });

  it("marks an expired Testing token as an error", async () => {
    fake.refreshTokenTtl = 604_800;
    const acct = await connectFakeAccount(ctx, fake, "tess@gmail.com");
    ctx.db.run("UPDATE accounts SET refresh_expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), acct.id);
    expect(warnings("testing_mode")[0]).toMatchObject({ severity: "error" });
    expect(warnings("testing_mode")[0]!.message).toMatch(/expired/);
  });

  it("reads the Workspace domain from the id_token and flags app type mismatches", async () => {
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "external" });
    fake.addAccount("ann@acme.test", { workspaceDomain: "Acme.test" });
    fake.addAccount("bob@acme.test", { workspaceDomain: "acme.test" });
    const ann = await connectFakeAccount(ctx, fake, "ann@acme.test");
    await connectFakeAccount(ctx, fake, "bob@acme.test");
    expect(ann.workspaceDomain).toBe("acme.test");
    expect(warnings("app_type_mismatch")).toEqual([
      expect.objectContaining({ severity: "info", message: expect.stringContaining("acme.test") as string }),
    ]);

    // A personal account breaks the "all one Workspace" pattern.
    const personal = await connectFakeAccount(ctx, fake, "pat@example.net");
    expect(personal.workspaceDomain).toBeNull();
    expect(warnings("app_type_mismatch")).toEqual([]);

    // Internal app type with a personal account connected: the app is really External.
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
    expect(warnings("app_type_mismatch")).toEqual([expect.objectContaining({ severity: "warning", accountId: personal.id })]);
  });

  it("treats legacy accounts (no recorded domain) as personal only for gmail.com addresses", async () => {
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
    const g = await connectFakeAccount(ctx, fake, "old@gmail.com");
    const w = await connectFakeAccount(ctx, fake, "old@corp.test");
    ctx.db.run("UPDATE accounts SET workspace_domain = NULL");
    expect(warnings("app_type_mismatch").map((x) => x.accountId)).toEqual([g.id]);
    expect(ctx.accounts.get(w.id)!.workspaceDomain).toBeNull();
  });
});

describe("setup warnings", () => {
  it("reports accounts needing reauth, errors first", async () => {
    const acct = await connectFakeAccount(ctx, fake, "rae@example.com");
    fake.failRefresh("rae@example.com");
    await expect(googleRuntime(ctx).tokens.accessToken(acct.id, { force: true })).rejects.toThrow();
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "external" });

    const all = warnings();
    expect(all.find((w) => w.code === "needs_reauth")).toMatchObject({ severity: "error", accountId: acct.id });
    expect(all.find((w) => w.code === "needs_reauth")!.hint).toContain("Reconnect");
    const order = { error: 0, warning: 1, info: 2 };
    expect(all.map((w) => order[w.severity])).toEqual([...all.map((w) => order[w.severity])].sort());
  });
});

describe("test email", () => {
  const send = (id: string) => withErrors(accountsApi(ctx)).request(`/accounts/${id}/test-email`, { method: "POST" });

  it("sends a self-addressed message, kicks ingest and audits", async () => {
    const acct = await connectFakeAccount(ctx, fake, "tim@example.com", { name: "Tim" });
    const res = await send(acct.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestEmailResult;
    expect(body.messageId).toBeTruthy();
    expect(Date.parse(body.sentAt)).toBeGreaterThan(Date.now() - 10_000);
    const msg = fake.message("tim@example.com", body.messageId)!;
    expect(msg.threadId).toBe(body.threadId);
    expect(msg.labelIds).toEqual(expect.arrayContaining(["SENT", "INBOX"]));
    const header = (n: string) => msg.payload!.headers!.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value;
    expect(header("Subject")).toBe("xaq test: your setup works");
    expect(header("To")).toContain("tim@example.com");
    expect(header("From")).toContain("tim@example.com");
    expect(ctx.audit.list({ action: "account.test_email" }).items[0]).toMatchObject({ outcome: "ok", accountId: acct.id, target: body.messageId });

    // Ingest picks it up as both sent and received (special-cased for the test email only).
    await expect.poll(() => rec.events.filter((e) => e.message?.id === body.messageId).map((e) => e.type).sort(), { timeout: 5000 }).toEqual([
      "message.received",
      "message.sent",
    ]);
  });

  it("does not report ordinary self-addressed mail as received", async () => {
    const acct = await connectFakeAccount(ctx, fake, "una@example.com");
    const raw = await ctx.google.mime.compose({ from: { name: null, email: "una@example.com" }, to: [{ name: null, email: "una@example.com" }], subject: "note to self", text: "x" });
    const msg = await ctx.google.gmail(acct.id).send(raw);
    ctx.ingest.kick(acct.id);
    await expect.poll(() => rec.events.some((e) => e.message?.id === msg.id), { timeout: 5000 }).toBe(true);
    expect(rec.events.filter((e) => e.message?.id === msg.id).map((e) => e.type)).toEqual(["message.sent"]);
  });

  it("is rate limited per account and refuses paused accounts", async () => {
    const acct = await connectFakeAccount(ctx, fake, "rita@example.com");
    for (let i = 0; i < 5; i++) expect((await send(acct.id)).status).toBe(200);
    const limited = await send(acct.id);
    expect(limited.status).toBe(429);
    const err = ((await limited.json()) as ApiError).error;
    expect(err.code).toBe("rate_limited");
    expect(err.hint).toMatch(/Try again in \d+ minute/);

    const other = await connectFakeAccount(ctx, fake, "paula@example.com");
    ctx.accounts.setStatus(other.id, "paused");
    const paused = await send(other.id);
    expect(paused.status).toBe(409);
    expect(((await paused.json()) as ApiError).error.code).toBe("account_paused");
    expect((await send("acc_missing")).status).toBe(404);
  });

  it("maps a disconnected account to needs_reauth", async () => {
    const acct = await connectFakeAccount(ctx, fake, "nora@example.com");
    fake.failRefresh("nora@example.com");
    googleRuntime(ctx).tokens.invalidate(acct.id);
    const res = await send(acct.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ApiError).error.code).toBe("needs_reauth");
  });
});

describe("OAuth error codes", () => {
  async function landed(email: string, opts: Parameters<FakeGoogle["consentAs"]>[1] = {}) {
    fake.addAccount(email);
    fake.consentAs(email, opts);
    const { authUrl } = ctx.google.startConnect();
    return (await fetch(authUrl, { redirect: "manual" })).headers.get("location")!;
  }
  const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as HttpError);

  it("explains a wrong client secret at the token exchange", async () => {
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
    const url = await landed("a@example.com");
    ctx.google.setClient({ ...FAKE_CLIENT, clientSecret: "wrong", appType: "internal" });
    const err = await failure(ctx.google.completeConnectFromUrl(url));
    expect(err).toMatchObject({ code: "oauth_invalid_client", message: expect.stringContaining("Google rejected the client ID or secret.") as string });
    expect(err!.hint).toContain("Re-import the client JSON (Clients → your client → Download JSON)");
  });

  it("names the exact redirect URI on redirect_uri_mismatch", async () => {
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
    const url = await landed("a@example.com");
    fake.failNext({ path: "/token", status: 400, reason: "redirect_uri_mismatch" });
    const err = await failure(ctx.google.completeConnectFromUrl(url));
    expect(err!.code).toBe("oauth_redirect_uri_mismatch");
    expect(err!.hint).toContain(`add exactly ${redirectUri()}`);
  });

  it("gives specific codes for the other connect failures", async () => {
    expect((await failure(Promise.resolve().then(() => ctx.google.startConnect())))!.code).toBe("google_client_missing");
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
    expect((await failure(ctx.google.completeConnectFromUrl("not a url")))!.code).toBe("oauth_url_invalid");
    expect((await failure(ctx.google.completeConnectFromUrl("http://localhost/oauth/callback")))!.code).toBe("oauth_no_code");
    const noGmail = await landed("b@example.com", { scopes: ["openid", "email"] });
    expect((await failure(ctx.google.completeConnectFromUrl(noGmail)))!.code).toBe("oauth_gmail_scope_missing");
    const noRefresh = await landed("c@example.com", { noRefreshToken: true });
    expect((await failure(ctx.google.completeConnectFromUrl(noRefresh)))!.code).toBe("oauth_no_refresh_token");
  });

  it("posts code and hint from the callback page", async () => {
    ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
    const url = new URL(await landed("d@example.com", { deny: true }));
    const res = await oauthRoutes(ctx).request(`/oauth/callback${url.search}`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Connection cancelled");
    const data = JSON.parse(/<script type="application\/json" id="oauth-result">([^<]*)<\/script>/.exec(html)![1]!) as Record<string, unknown>;
    expect(data).toMatchObject({
      ok: false,
      email: null,
      error: "You clicked Cancel (or denied access) on Google's screen, so nothing was connected.",
      code: "oauth_access_denied",
      hint: expect.stringContaining("Nothing needs fixing in Google Cloud") as string,
    });
    // Cancelling isn't a setup problem: no advice to add test users or publish the app.
    expect(String(data.hint)).not.toMatch(/test user|publish/i);
  });
});
