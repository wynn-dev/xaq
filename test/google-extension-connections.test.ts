// A Google extension's connections, end to end and offline (docs/EXTENSIONS.md "Google accounts for code
// extensions"): the echo test extension dressed as google-workspace is installed through the store from a fake
// official registry, its setup view lists the accounts, API links, gcloud command and Check again, a connection is
// bound to one account and connected through the fake Google consent, and its child calls `xaq/credentials/get`: the
// token is downscoped, for that connection's account only, accepted by the fake Drive and refused by Gmail.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GoogleApiCheckView, PresetView } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { readSetupToken } from "../server/auth/setup-token.ts";
import type { ToolSource } from "../server/broker/types.ts";
import type { AppContext } from "../server/context.ts";
import { codeExtensionNodeProblem } from "../server/extensions/host/index.ts";
import { computeIntegrity } from "../server/extensions/integrity.ts";
import { extensionStore } from "../server/extensions/store.ts";
import { grantedScopes } from "../server/google/scoped.ts";
import { GMAIL_SCOPE, WORKSPACE_SCOPES } from "../server/google/scopes.ts";
import { presets } from "../server/integrations/index.ts";
import { entriesFromDir, type FakeGithub, fakeSha, startFakeGithub } from "./extension-fakes.ts";
import { connectFakeAccount, FAKE_CLIENT, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { googleEcho, WORKSPACE_APIS } from "./google-extension-fixtures.ts";
import { testContext } from "./helpers.ts";
import { CSRF, PASSWORD, sessionCookie } from "./platform-helpers.ts";

const ME = "me@example.com";
const OPS = "ops@example.com";
const NAME = "google-workspace";

let fake: FakeGoogle;
let gh: FakeGithub;
let ctx: AppContext;
let dispose: () => Promise<void>;
let request: (path: string, init?: RequestInit & { json?: unknown }) => Promise<Response>;
let work: string;

/** Publishes the google echo at the fake official registry (wynn-dev/xaq-extensions, indexed commit and integrity). */
function publish(): void {
  const dir = googleEcho(join(work, "gws"));
  const sha = fakeSha("gws-1");
  gh.commit("wynn-dev", "xaq-extensions", "main", sha, entriesFromDir(dir, `extensions/${NAME}`));
  gh.index.extensions = [
    { name: NAME, displayName: "Google Workspace", description: "Docs, Sheets, Slides", kind: "code", version: "1.0.0", path: `extensions/${NAME}`, commit: sha, integrity: computeIntegrity(dir) },
  ];
}

beforeEach(async () => {
  fake = await startFakeGoogle();
  gh = await startFakeGithub();
  work = mkdtempSync(join(tmpdir(), "xaq-gws-"));
  const t = testContext({ events: recordingEvents().factory }, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
  ctx.google.setClient({ ...FAKE_CLIENT, appType: "external" });
  // The store reaches only the fake GitHub on 127.0.0.1.
  extensionStore(ctx, { urls: gh.urls });
  ctx.broker.start?.();
  const app = createApp(ctx);
  let cookie = "";
  request = (path, init = {}) => {
    const { json, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("x-agentinbox-csrf", CSRF["x-agentinbox-csrf"]);
    if (cookie) headers.set("cookie", cookie);
    if (json !== undefined) headers.set("content-type", "application/json");
    return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } }));
  };
  const claimed = await request("/api/setup/claim", { method: "POST", json: { token: readSetupToken(ctx.config.dataDir), password: PASSWORD } });
  cookie = sessionCookie(claimed)!;
  publish();
});

afterEach(async () => {
  // Installed files are read-only: the store removes them (the data directory is deleted next).
  const store = extensionStore(ctx);
  for (const e of store.list()) await store.remove(e.name, { force: true }).catch(() => undefined);
  await dispose();
  await fake.close();
  await gh.close();
  rmSync(work, { recursive: true, force: true });
});

// oxlint-disable-next-line typescript/no-explicit-any
const body = async (res: Response): Promise<any> => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const textOf = (r: unknown) => (r as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join("\n");
const ctl = (connectionId: string) => ({ agentId: "agt_test", connectionId, signal: AbortSignal.timeout(20_000), auditDetail: {} });

/** Follows the fake consent screen for an authorize URL and returns where Google sends the browser back. */
async function consentAt(authorizeUrl: string, email: string, opts: { tick?: string[] } = {}): Promise<URL> {
  fake.consentAs(email, opts.tick ? { scopes: opts.tick } : {});
  const res = await fetch(authorizeUrl, { redirect: "manual" });
  return new URL(res.headers.get("location")!);
}

async function createConnection(slug: string, agentIds: string[] = []): Promise<{ id: string; status: string; statusReason: string | null }> {
  const res = await request("/api/connections", { method: "POST", json: { preset: NAME, slug, agentIds, levelDefault: "full" } });
  expect(res.status).toBe(201);
  return body(res);
}

/** Connects `id` as `email` through the API and Google's (direct) callback; returns the connection view. */
async function connectAs(id: string, email: string, opts: { tick?: string[] } = {}) {
  const r = await body(await request(`/api/connections/${id}/connect`, { method: "POST", json: { inputs: { google_account: email } } }));
  if (r.status === "connected") return r.connection;
  expect(r).toMatchObject({ status: "authorize", callbackMode: "direct" });
  const back = await consentAt(r.authorizeUrl, email, opts);
  const page = await request(`${back.pathname}${back.search}`);
  expect([200, 400]).toContain(page.status);
  return body(await request(`/api/connections/${id}`));
}

async function source(id: string): Promise<ToolSource> {
  ctx.broker.attach(id);
  const s = ctx.broker.source(id)!;
  await (s as unknown as { ready(): Promise<void> }).ready();
  return s;
}

describe.skipIf(codeExtensionNodeProblem() !== null)("a google extension, store → setup → consent → credentials/get → Drive", () => {
  it("installs from the official registry, shows the setup, connects through the fake consent, and the child's token works on Drive only", async () => {
    // Install through the store: official (the indexed commit and integrity), so its google auth is honoured.
    const installed = await extensionStore(ctx).install(NAME, { confirmThirdParty: false });
    expect(installed).toMatchObject({ name: NAME, official: true, kind: "code" });
    expect(presets().find((p) => p.id === NAME)?.auth).toMatchObject({ type: "google", scopes: WORKSPACE_SCOPES });
    const me = await connectFakeAccount(ctx, fake, ME);

    // The setup view: the account to pick, a link per API in the project, the gcloud command, Check again, consent.
    const list = (await body(await request("/api/connections/presets"))) as PresetView[];
    const view = list.find((p) => p.id === NAME)!;
    expect(view).toMatchObject({ kind: "native", authType: "oauth", official: true });
    expect(view.setupSteps.map((s) => s.id)).toEqual(["google-account", "google-apis", "google-consent", "google-done"]);
    expect(view.setupSteps[0]!.input!.choices).toEqual([{ value: ME, label: ME }]);
    expect(view.setupSteps[1]!.apis).toEqual(WORKSPACE_APIS.map((a) => ({ ...a, url: `https://console.cloud.google.com/apis/library/${a.service}?project=fake-project` })));
    expect(view.setupSteps[1]!.copy!.value).toBe(
      "gcloud services enable docs.googleapis.com sheets.googleapis.com slides.googleapis.com drive.googleapis.com --project=fake-project",
    );
    expect(view.setupSteps[2]!.body).toContain("Google hasn't verified this app");
    // Check again, before consent: nothing provable yet; an API that's off is seen.
    fake.disableApi("slides", true);
    const before = (await body(await request(`/api/connections/presets/${NAME}/google-apis`, { method: "POST", json: { account: ME } }))) as GoogleApiCheckView[];
    expect(before.map((c) => c.state)).toEqual(["unchecked", "unchecked", "disabled", "unchecked"]);
    fake.disableApi("slides", false);

    // A connection starts without access; Connect binds the account and starts the incremental consent.
    const { agent } = ctx.policy.createAgent({ name: "Hermes" });
    const created = await createConnection("gws", [agent.id]);
    expect(created).toMatchObject({ status: "needs_reauth" });
    const start = await body(await request(`/api/connections/${created.id}/connect`, { method: "POST", json: { inputs: { google_account: ME } } }));
    expect(start.status).toBe("authorize");
    const q = new URL(start.authorizeUrl).searchParams;
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("login_hint")).toBe(ME);
    expect(q.get("scope")!.split(" ")).toEqual(expect.arrayContaining([...WORKSPACE_SCOPES, GMAIL_SCOPE]));
    const back = await consentAt(start.authorizeUrl, ME);
    expect((await request(`${back.pathname}${back.search}`)).status).toBe(200);
    const conn = await body(await request(`/api/connections/${created.id}`));
    expect(conn).toMatchObject({
      status: "active",
      grantedScopes: WORKSPACE_SCOPES,
      google: { accountId: me.id, email: ME, granted: WORKSPACE_SCOPES, missing: [] },
    });
    expect(grantedScopes(ctx, me.id)).toEqual(expect.arrayContaining([GMAIL_SCOPE, ...WORKSPACE_SCOPES]));

    // Check again after consent: every API on.
    const after = (await body(await request(`/api/connections/presets/${NAME}/google-apis`, { method: "POST", json: { account: ME } }))) as GoogleApiCheckView[];
    expect(after.map((c) => c.state)).toEqual(["enabled", "enabled", "enabled", "enabled"]);

    // The child asks for its credentials and uses them: Drive and Docs take the token, Gmail refuses it.
    fake.drive.addFile(ME, { id: "doc1", name: "Plan", mimeType: "application/vnd.google-apps.document" });
    const s = await source(created.id);
    const refreshesBefore = fake.refreshes.length;
    const out = JSON.parse(
      textOf(await s.callTool("authfetch", { urls: [`${fake.url}/drive/v3/about`, `${fake.url}/v1/documents/doc1`, `${fake.url}/gmail/v1/users/me/profile`] }, ctl(created.id))),
    ) as { tokenSha256: string; expiresAt: number; results: { status: number; body: string }[] };
    expect(out.results.map((r) => r.status)).toEqual([200, 200, 403]);
    expect(JSON.parse(out.results[0]!.body)).toMatchObject({ user: { emailAddress: ME } });
    expect(out.results[2]!.body).toContain("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    expect(out.expiresAt).toBeGreaterThan(Date.now());
    // The fake's bookkeeping: the token handed over was minted for exactly the manifest's scopes (never Gmail), for ME.
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    const handed = fake.issued().find((t) => sha(t.accessToken) === out.tokenSha256)!;
    expect(handed).toBeDefined();
    expect(handed.email).toBe(ME);
    expect([...handed.scopes].sort()).toEqual([...WORKSPACE_SCOPES].sort());
    for (const r of fake.refreshes.filter((x) => x.requested)) expect(r.issued ?? []).not.toContain(GMAIL_SCOPE);
    // A second call is served from the cache (same token, no new refresh).
    const again = JSON.parse(textOf(await s.callTool("whoami", {}, ctl(created.id)))) as { tokenSha256: string; keys: string[] };
    expect(again.tokenSha256).toBe(out.tokenSha256);
    expect(again.keys).toEqual(["accessToken", "expiresAt"]);
    expect(fake.refreshes.length).toBe(refreshesBefore);
    // The token echoed in a tool result is scrubbed like a stored credential.
    const { connectionSecrets } = await import("../server/broker/policy/output.ts");
    const secrets = connectionSecrets({ tokens: () => null, header: () => null, client: () => null }, created.id);
    expect(secrets.map(sha)).toContain(out.tokenSha256);
  });

  it("each connection gets its own account's token, never another connection's; a partial grant works for what was ticked", async () => {
    await extensionStore(ctx).install(NAME, { confirmThirdParty: false });
    await connectFakeAccount(ctx, fake, ME);
    await connectFakeAccount(ctx, fake, OPS);
    const a = await createConnection("gws-me");
    const b = await createConnection("gws-ops");
    expect(await connectAs(a.id, ME)).toMatchObject({ status: "active", google: { email: ME } });
    // OPS unticks Slides and the full Drive read: the connection works, and says what won't.
    const G = "https://www.googleapis.com/auth/";
    const partial = await connectAs(b.id, OPS, { tick: [GMAIL_SCOPE, "openid", `${G}documents`, `${G}spreadsheets`, `${G}drive.file`] });
    expect(partial).toMatchObject({ status: "active", google: { email: OPS, granted: [`${G}documents`, `${G}spreadsheets`, `${G}drive.file`] } });
    expect(partial.google.missing.map((m: { scope: string }) => m.scope)).toEqual([`${G}presentations`, `${G}drive.readonly`]);
    expect(partial.google.missing[1]).toMatchObject({ grants: "see and download all your Google Drive files", without: "it can't search your Drive or open files it didn't create" });

    const url = `${fake.url}/drive/v3/about`;
    const who = async (id: string) => JSON.parse(textOf(await (await source(id)).callTool("authfetch", { urls: [url] }, ctl(id)))) as { results: { status: number; body: string }[] };
    expect(JSON.parse((await who(a.id)).results[0]!.body).user.emailAddress).toBe(ME);
    expect(JSON.parse((await who(b.id)).results[0]!.body).user.emailAddress).toBe(OPS);
    // OPS's token is limited to what OPS granted of the manifest's scopes.
    const opsMinted = fake.refreshes.filter((r) => r.email === OPS && r.requested);
    expect(opsMinted.at(-1)!.issued).toEqual([`${G}documents`, `${G}drive.file`, `${G}spreadsheets`]);
    for (const r of fake.refreshes.filter((x) => x.requested)) expect(r.issued ?? []).not.toContain(GMAIL_SCOPE);
  });

  it("an account already allowed connects at once; a removed or broken account turns the connection to needs_reauth; removing the connection keeps the account's access", async () => {
    await extensionStore(ctx).install(NAME, { confirmThirdParty: false });
    const me = await connectFakeAccount(ctx, fake, ME);
    const a = await createConnection("gws-a");
    await connectAs(a.id, ME);
    // A second connection on the same account: nothing to ask Google.
    const b = await createConnection("gws-b");
    const r = await body(await request(`/api/connections/${b.id}/connect`, { method: "POST", json: { inputs: { google_account: ME } } }));
    expect(r).toMatchObject({ status: "connected", connection: { status: "active", google: { email: ME, missing: [] } } });
    // An unknown account is refused in plain words.
    const bad = await body(await request(`/api/connections/${b.id}/connect`, { method: "POST", json: { inputs: { google_account: "nobody@example.com" } } }));
    expect(bad).toMatchObject({ status: "error", message: expect.stringContaining("isn't connected to xaq") });

    // The account's grant is revoked at Google: the child's credentials/get says needs_reauth, and the connection follows.
    fake.failRefresh(ME);
    ctx.db.run("UPDATE accounts SET access_token_enc = NULL WHERE id = ?", me.id);
    const s = await source(a.id);
    const denied = await s.callTool("whoami", {}, ctl(a.id));
    expect(textOf(denied)).toMatch(/rpc -32010: needs_reauth/);
    expect(await body(await request(`/api/connections/${a.id}`))).toMatchObject({ status: "needs_reauth", statusReason: expect.stringContaining(`${ME} needs to be reconnected`) });

    // Removing the connection leaves the account's granted scopes alone.
    expect((await request(`/api/connections/${b.id}`, { method: "DELETE" })).status).toBe(204);
    expect(grantedScopes(ctx, me.id)).toEqual(expect.arrayContaining([...WORKSPACE_SCOPES]));
    // Removing the account: the connection has no account any more.
    await ctx.accounts.remove(me.id);
    expect(await body(await request(`/api/connections/${a.id}`))).toMatchObject({ status: "needs_reauth", google: { accountId: null, email: null } });
  });

  it("after the consent the connection lists its tools on its own (nothing here attaches it); identity scopes in Google's answer are fine", async () => {
    await extensionStore(ctx).install(NAME, { confirmThirdParty: false });
    await connectFakeAccount(ctx, fake, ME);
    const c = await createConnection("gws-own");
    const start = await body(await request(`/api/connections/${c.id}/connect`, { method: "POST", json: { inputs: { google_account: ME } } }));
    const back = await consentAt(start.authorizeUrl, ME);
    const page = await request(`${back.pathname}${back.search}`);
    expect(page.status).toBe(200);
    // The page reports to the console's connection sign-in, with this connection.
    const html = await page.text();
    expect(html).toContain(`"connectionId":"${c.id}"`);
    expect(html).toContain('"ok":true');
    const until = Date.now() + 15_000;
    let view = await body(await request(`/api/connections/${c.id}`));
    while (view.tools.total === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      view = await body(await request(`/api/connections/${c.id}`));
    }
    expect(view).toMatchObject({ status: "active", google: { email: ME } });
    expect(view.tools.total).toBeGreaterThan(0);
    // Google adds identity scopes to the downscoped answer: the child still gets its token.
    fake.refreshAddsIdentity = true;
    const s = ctx.broker.source(c.id)!;
    const out = JSON.parse(textOf(await s.callTool("authfetch", { urls: [`${fake.url}/drive/v3/about`, `${fake.url}/gmail/v1/users/me/profile`] }, ctl(c.id)))) as {
      results: { status: number }[];
    };
    expect(out.results.map((r) => r.status)).toEqual([200, 403]);
  });

  it("a re-pick binds the new account only once its consent succeeds: an abandoned or cancelled one keeps the old account", async () => {
    await extensionStore(ctx).install(NAME, { confirmThirdParty: false });
    const me = await connectFakeAccount(ctx, fake, ME);
    const ops = await connectFakeAccount(ctx, fake, OPS);
    const c = await createConnection("gws-repick");
    await connectAs(c.id, ME);
    const repick = () => request(`/api/connections/${c.id}/connect`, { method: "POST", json: { inputs: { google_account: OPS } } }).then(body);
    // Abandoned: the consent never comes back.
    expect((await repick()).status).toBe("authorize");
    expect(await body(await request(`/api/connections/${c.id}`))).toMatchObject({ status: "active", google: { accountId: me.id } });
    // Cancelled on Google's screen: the page tells the console (it stops waiting), and nothing changes.
    const start = await repick();
    fake.consentAs(OPS, { deny: true });
    const back = new URL((await fetch(start.authorizeUrl, { redirect: "manual" })).headers.get("location")!);
    const page = await request(`${back.pathname}${back.search}`);
    expect(page.status).toBe(400);
    const html = await page.text();
    expect(html).toContain(`"connectionId":"${c.id}"`);
    expect(html).toContain("oauth_access_denied");
    expect(html).toContain(`click Reconnect on`);
    expect(await body(await request(`/api/connections/${c.id}`))).toMatchObject({ status: "active", google: { accountId: me.id } });
    // Completed: now it's OPS.
    expect(await connectAs(c.id, OPS)).toMatchObject({ status: "active", google: { accountId: ops.id, email: OPS } });
  });

  it("paste mode: the address Google lands on finishes the extension's connection through /api/connections/finish", async () => {
    await extensionStore(ctx).install(NAME, { confirmThirdParty: false });
    await connectFakeAccount(ctx, fake, ME);
    ctx.settings.update({ publicUrl: "http://xaq.lan:8425" }); // plain http off localhost: Google can't redirect here
    const c = await createConnection("gws-paste");
    const start = await body(await request(`/api/connections/${c.id}/connect`, { method: "POST", json: { inputs: { google_account: ME } } }));
    expect(start).toMatchObject({ status: "authorize", callbackMode: "paste" });
    const back = await consentAt(start.authorizeUrl, ME);
    const done = await body(await request("/api/connections/finish", { method: "POST", json: { url: back.toString() } }));
    expect(done).toMatchObject({ status: "connected", connection: { id: c.id, status: "active", google: { email: ME, missing: [] } } });
  });
});
