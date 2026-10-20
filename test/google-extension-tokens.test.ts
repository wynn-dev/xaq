// Google access for code extensions, against the fake Google (docs/EXTENSIONS.md "Google accounts for code
// extensions"): the incremental consent (exactly the extension's scopes, the account keeps what it had, a partial grant
// in plain words), downscoped tokens through the refresh grant's `scope` (RFC 6749 §6) with Google's answer checked,
// the per-account-and-scope-set cache with expiry and single flight, the helper core's own Drive use takes (A1), and
// the API-enabled probe. Tests reach only the fake on 127.0.0.1 (test/setup-no-network.ts refuses anything else).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../server/context.ts";
import { getRow } from "../server/google/accounts.ts";
import { probeGoogleApis } from "../server/google/apis.ts";
import { extensionConsentConnection, startConnect } from "../server/google/oauth.ts";
import { googleRuntime } from "../server/google/runtime.ts";
import { accountHasScopes, accountMissingScopes, googleAccessToken, grantedScopes } from "../server/google/scoped.ts";
import { DOCS_SCOPE, DRIVE_FILE_SCOPE, DRIVE_READONLY_SCOPE, GMAIL_SCOPE, SHEETS_SCOPE, SLIDES_SCOPE, WORKSPACE_SCOPES } from "../server/google/scopes.ts";
import { DownscopeError, ScopesNotGrantedError } from "../server/google/types.ts";
import { HttpError } from "../server/util/errors.ts";
import { connectFakeAccount, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";
import { WORKSPACE_APIS } from "./google-extension-fixtures.ts";

const ME = "me@example.com";
const OTHER = "other@example.com";

let fake: FakeGoogle;
let ctx: AppContext;
let dispose: () => Promise<void>;

beforeEach(async () => {
  fake = await startFakeGoogle();
  const t = testContext({ events: recordingEvents().factory }, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
});

afterEach(async () => {
  await dispose();
  await fake.close();
});

/** What the consent asked Google for (the authorize URL's parameters). */
const asked = (authUrl: string) => {
  const q = new URL(authUrl).searchParams;
  return { scopes: (q.get("scope") ?? "").split(" "), include: q.get("include_granted_scopes"), hint: q.get("login_hint"), prompt: q.get("prompt") };
};

/** The extension's consent for `accountId`, through the fake's consent screen; `tick` is what the user leaves ticked. */
async function allow(accountId: string, email: string, opts: { tick?: string[]; deny?: boolean; as?: string } = {}) {
  fake.consentAs(opts.as ?? email, opts.deny ? { deny: true } : opts.tick ? { scopes: opts.tick } : {});
  const done: { accountId: string; granted: string[] }[] = [];
  const r = startConnect(ctx, {
    reauthAccountId: accountId,
    extension: { connectionId: "con_test", displayName: "Google Workspace", scopes: WORKSPACE_SCOPES, onDone: (id, granted) => done.push({ accountId: id, granted }) },
  });
  const res = await fetch(r.authUrl, { redirect: "manual" });
  const location = res.headers.get("location")!;
  return { authUrl: r.authUrl, done, complete: () => ctx.google.completeConnectFromUrl(location) };
}

async function connectWithWorkspace(email = ME) {
  const account = await connectFakeAccount(ctx, fake, email);
  await (await allow(account.id, email)).complete();
  return account;
}

const gmailProfile = (token: string) => fetch(`${fake.url}/gmail/v1/users/me/profile`, { headers: { authorization: `Bearer ${token}` } });
const driveAbout = (token: string) => fetch(`${fake.url}/drive/v3/about`, { headers: { authorization: `Bearer ${token}` } });

describe("the consent: incremental, exactly the extension's scopes", () => {
  it("asks for the extension's scopes on top of what the account has (include_granted_scopes), and the account keeps it all", async () => {
    const account = await connectFakeAccount(ctx, fake, ME);
    const before = account.grantedScopes!;
    expect(before).toContain(GMAIL_SCOPE);
    expect(before.some((s) => WORKSPACE_SCOPES.includes(s))).toBe(false);
    const a = await allow(account.id, ME);
    const q = asked(a.authUrl);
    expect(q.include).toBe("true");
    expect(q.hint).toBe(ME);
    expect(q.scopes).toEqual(expect.arrayContaining([...WORKSPACE_SCOPES, GMAIL_SCOPE]));
    const after = await a.complete();
    expect(after.id).toBe(account.id);
    expect(after.grantedScopes).toEqual(expect.arrayContaining([...before, ...WORKSPACE_SCOPES]));
    expect(a.done).toEqual([{ accountId: account.id, granted: expect.arrayContaining([...WORKSPACE_SCOPES]) }]);
    // Nothing revoked, and the account's mail still works with its own token.
    expect(fake.revoked).toEqual([]);
    expect((await ctx.google.gmail(account.id).getProfile()).emailAddress).toBe(ME);
  });

  it("doesn't ask for Calendar on its own: only what the account already had plus the extension's", async () => {
    const account = await connectFakeAccount(ctx, fake, ME, { scopes: [GMAIL_SCOPE, "openid", "email", "profile"] });
    const q = asked((await allow(account.id, ME)).authUrl);
    expect(q.scopes.some((s) => s.includes("calendar"))).toBe(false);
  });

  it("a partial grant keeps what was ticked and says in plain words what's missing and what won't work", async () => {
    const account = await connectFakeAccount(ctx, fake, ME);
    const a = await allow(account.id, ME, { tick: [GMAIL_SCOPE, "openid", DOCS_SCOPE, SHEETS_SCOPE] });
    const err = (await a.complete().catch((e: unknown) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.code).toBe("oauth_extension_not_granted");
    expect(err.message).toContain("Google Workspace got only part of the access");
    expect(err.message).toContain("see and download all your Google Drive files (without it, it can't search your Drive or open files it didn't create)");
    expect(err.message).toContain("Google Slides presentations (without it, its Google Slides tools won't work)");
    expect(err.message).not.toContain("Google Docs documents");
    expect(err.hint).toContain("tick every box");
    // Saved anyway: the ticked scopes are on the account, and its old ones too.
    const scopes = grantedScopes(ctx, account.id);
    expect(scopes).toEqual(expect.arrayContaining([GMAIL_SCOPE, DOCS_SCOPE, SHEETS_SCOPE, ...account.grantedScopes!]));
    expect(accountMissingScopes(ctx, account.id, WORKSPACE_SCOPES)).toEqual([SLIDES_SCOPE, DRIVE_FILE_SCOPE, DRIVE_READONLY_SCOPE]);
    expect(a.done).toHaveLength(1);
    expect(ctx.google.connectAttempt(new URL(a.authUrl).searchParams.get("state")!)).toMatchObject({ status: "failed", code: "oauth_extension_not_granted" });
  });

  it("a cancel and a wrong account are said for the extension, and change nothing for the account", async () => {
    const account = await connectFakeAccount(ctx, fake, ME);
    const before = grantedScopes(ctx, account.id);
    await expect((await allow(account.id, ME, { deny: true })).complete()).rejects.toThrow(/You cancelled giving Google Workspace access to me@example.com, so nothing changed/);
    fake.addAccount(OTHER);
    await expect((await allow(account.id, ME, { as: OTHER })).complete()).rejects.toThrow(/You were giving Google Workspace access to me@example.com, but signed in to Google as other@example.com/);
    expect(grantedScopes(ctx, account.id)).toEqual(before);
    expect(getRow(ctx, account.id)!.status).toBe("active");
  });

  it("an extension consent needs one connected account, and only the extension's access", async () => {
    const account = await connectFakeAccount(ctx, fake, ME);
    expect(() => startConnect(ctx, { reauthAccountId: account.id, scopes: ["pubsub"], extension: { connectionId: "c", displayName: "X", scopes: WORKSPACE_SCOPES } })).toThrow(
      /one connected account/,
    );
    expect(() => startConnect(ctx, { extension: { connectionId: "c", displayName: "X", scopes: WORKSPACE_SCOPES } })).toThrow(/one connected account/);
  });
});

describe("downscoped tokens (the refresh grant's scope)", () => {
  it("returns a token limited to exactly the scopes asked for: the fake's bookkeeping, and Drive takes it while Gmail refuses it", async () => {
    const account = await connectWithWorkspace();
    const t = await googleAccessToken(ctx, account.id, WORKSPACE_SCOPES);
    expect(t.scopes.sort()).toEqual([...WORKSPACE_SCOPES].sort());
    expect(fake.tokenScopes(t.accessToken)).toEqual({ email: ME, scopes: expect.arrayContaining([...WORKSPACE_SCOPES]) });
    expect(fake.tokenScopes(t.accessToken)!.scopes).not.toContain(GMAIL_SCOPE);
    expect(fake.refreshes.at(-1)).toEqual({ email: ME, requested: [...WORKSPACE_SCOPES].sort(), issued: [...WORKSPACE_SCOPES].sort() });
    expect(t.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
    expect((await driveAbout(t.accessToken)).status).toBe(200);
    const gmail = await gmailProfile(t.accessToken);
    expect(gmail.status).toBe(403);
    expect(await gmail.text()).toContain("ACCESS_TOKEN_SCOPE_INSUFFICIENT");
    // And the other way round: a token minted for Gmail doesn't open Drive.
    const mail = await googleAccessToken(ctx, account.id, [GMAIL_SCOPE]);
    expect(fake.tokenScopes(mail.accessToken)!.scopes).toEqual([GMAIL_SCOPE]);
    expect((await driveAbout(mail.accessToken)).status).toBe(403);
    expect((await gmailProfile(mail.accessToken)).status).toBe(200);
    // The account's recorded scopes and its own (full, xaq-internal) token are untouched by the downscoped refreshes.
    const own = await googleRuntime(ctx).tokens.accessToken(account.id);
    expect(grantedScopes(ctx, account.id)).toEqual(expect.arrayContaining([GMAIL_SCOPE, ...WORKSPACE_SCOPES]));
    expect(await googleRuntime(ctx).tokens.accessToken(account.id)).toBe(own);
    expect([t.accessToken, mail.accessToken]).not.toContain(own);
  });

  it("a subset gets a token for the subset only", async () => {
    const account = await connectWithWorkspace();
    const t = await googleAccessToken(ctx, account.id, [DRIVE_READONLY_SCOPE]);
    expect(fake.tokenScopes(t.accessToken)!.scopes).toEqual([DRIVE_READONLY_SCOPE]);
    const doc = await fetch(`${fake.url}/v1/documents/nope`, { headers: { authorization: `Bearer ${t.accessToken}` } });
    expect(doc.status).toBe(404); // drive.readonly may read Docs; the made-up id isn't there
  });

  it("refuses scopes the account hasn't granted without asking Google", async () => {
    const account = await connectFakeAccount(ctx, fake, ME);
    const n = fake.refreshes.length;
    const err = await googleAccessToken(ctx, account.id, WORKSPACE_SCOPES).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopesNotGrantedError);
    expect((err as ScopesNotGrantedError).missing).toEqual(WORKSPACE_SCOPES);
    expect(fake.refreshes.length).toBe(n);
  });

  it("fails closed: a server that ignores `scope` and answers with the whole grant gets its token dropped", async () => {
    const account = await connectWithWorkspace();
    fake.ignoreRefreshScope = true;
    const err = await googleAccessToken(ctx, account.id, [DRIVE_READONLY_SCOPE]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownscopeError);
    expect((err as Error).message).toMatch(/more access than asked for \(.*gmail\.modify/);
    // Nothing was cached: the next call asks again (and gets a limited one once the server behaves).
    fake.ignoreRefreshScope = false;
    const t = await googleAccessToken(ctx, account.id, [DRIVE_READONLY_SCOPE]);
    expect(fake.tokenScopes(t.accessToken)!.scopes).toEqual([DRIVE_READONLY_SCOPE]);
  });

  it("accepts identity scopes Google adds to a downscoped answer (they can't read mail or files), nothing else", async () => {
    const account = await connectWithWorkspace();
    fake.refreshAddsIdentity = true;
    const t = await googleAccessToken(ctx, account.id, [DRIVE_READONLY_SCOPE]);
    expect(t.scopes).toEqual(expect.arrayContaining([DRIVE_READONLY_SCOPE, "openid", `https://www.googleapis.com/auth/userinfo.email`, "email"]));
    expect(t.scopes).not.toContain(GMAIL_SCOPE);
    expect((await driveAbout(t.accessToken)).status).toBe(200);
    expect((await gmailProfile(t.accessToken)).status).toBe(403);
    // Identity on top of the whole grant is still refused: Gmail is outside the request.
    fake.ignoreRefreshScope = true;
    await expect(googleAccessToken(ctx, account.id, [DOCS_SCOPE])).rejects.toThrow(DownscopeError);
  });

  it("the pending-consent memory evicts only the oldest attempt when full", async () => {
    const account = await connectFakeAccount(ctx, fake, ME);
    const states: string[] = [];
    for (let i = 0; i < 201; i++) {
      const r = startConnect(ctx, { reauthAccountId: account.id, extension: { connectionId: `con_${i}`, displayName: "Google Workspace", scopes: WORKSPACE_SCOPES } });
      states.push(new URL(r.authUrl).searchParams.get("state")!);
    }
    expect(extensionConsentConnection(ctx, states[0]!)).toBeNull();
    expect(extensionConsentConnection(ctx, states[1]!)).toBe("con_1");
    expect(extensionConsentConnection(ctx, states[200]!)).toBe("con_200");
  });

  it("access revoked outside xaq (invalid_scope): re-reads the account's scopes and says what's missing", async () => {
    const account = await connectWithWorkspace();
    // The recorded scopes say yes; the refresh token Google holds no longer covers Drive (simulated with a reconnect
    // whose consent left the Workspace scopes out, its scopes recorded as before).
    const recorded = getRow(ctx, account.id)!.scopes;
    fake.consentAs(ME, { scopes: [GMAIL_SCOPE, "openid"] });
    fake.failRefresh(ME); // drop the old grant so include_granted_scopes adds nothing back
    const r = ctx.google.startConnect({ reauthAccountId: account.id, mailOnly: true });
    await ctx.google.completeConnectFromUrl((await fetch(r.authUrl, { redirect: "manual" })).headers.get("location")!).catch(() => undefined);
    ctx.db.run("UPDATE accounts SET scopes = ?, status = 'active' WHERE id = ?", recorded, account.id);
    const err = await googleAccessToken(ctx, account.id, [DRIVE_READONLY_SCOPE]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopesNotGrantedError);
    expect((err as ScopesNotGrantedError).missing).toEqual([DRIVE_READONLY_SCOPE]);
    expect(accountHasScopes(ctx, account.id, [DRIVE_READONLY_SCOPE])).toBe(false);
  });
});

describe("the token cache", () => {
  it("caches per account and scope set until it nearly expires, with one refresh in flight", async () => {
    const account = await connectWithWorkspace();
    const n = fake.refreshes.length;
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => googleAccessToken(ctx, account.id, WORKSPACE_SCOPES)));
    expect(new Set([a!.accessToken, b!.accessToken, c!.accessToken]).size).toBe(1);
    expect(fake.refreshes.length).toBe(n + 1);
    // Same set in another order: the same entry.
    expect((await googleAccessToken(ctx, account.id, [...WORKSPACE_SCOPES].reverse())).accessToken).toBe(a!.accessToken);
    expect(fake.refreshes.length).toBe(n + 1);
    // Another set: its own token.
    const d = await googleAccessToken(ctx, account.id, [DRIVE_READONLY_SCOPE]);
    expect(d.accessToken).not.toBe(a!.accessToken);
    expect(fake.refreshes.length).toBe(n + 2);
  });

  it("refreshes again once the token is within a minute of expiring", async () => {
    const account = await connectWithWorkspace();
    fake.accessTokenTtl = 30; // already inside the early-refresh window when issued
    const a = await googleAccessToken(ctx, account.id, WORKSPACE_SCOPES);
    const b = await googleAccessToken(ctx, account.id, WORKSPACE_SCOPES);
    expect(b.accessToken).not.toBe(a.accessToken);
    expect(b.expiresAt).toBeLessThan(Date.now() + 31_000);
  });

  it("is dropped when the account's refresh token changes (a new consent), and per account", async () => {
    const account = await connectWithWorkspace();
    const other = await connectWithWorkspace(OTHER);
    const a = await googleAccessToken(ctx, account.id, WORKSPACE_SCOPES);
    const o = await googleAccessToken(ctx, other.id, WORKSPACE_SCOPES);
    expect(fake.tokenScopes(o.accessToken)!.email).toBe(OTHER);
    await (await allow(account.id, ME)).complete();
    const b = await googleAccessToken(ctx, account.id, WORKSPACE_SCOPES);
    expect(b.accessToken).not.toBe(a.accessToken);
    expect((await googleAccessToken(ctx, other.id, WORKSPACE_SCOPES)).accessToken).toBe(o.accessToken);
  });

  it("a revoked grant marks the account needs_reauth (invalid_grant), as the account's own refresh does", async () => {
    const account = await connectWithWorkspace();
    fake.failRefresh(ME);
    await expect(googleAccessToken(ctx, account.id, WORKSPACE_SCOPES)).rejects.toThrow(/needs to be reconnected/);
    expect(getRow(ctx, account.id)!.status).toBe("needs_reauth");
  });
});

describe("core's helper (Gmail's attach-from-Drive)", () => {
  it("accountHasScopes and googleAccessToken for a scope subset", async () => {
    const account = await connectFakeAccount(ctx, fake, ME);
    expect(accountHasScopes(ctx, account.id, [GMAIL_SCOPE])).toBe(true);
    expect(accountHasScopes(ctx, account.id, [DRIVE_READONLY_SCOPE])).toBe(false);
    expect(accountHasScopes(ctx, "acc_missing", [GMAIL_SCOPE])).toBe(false);
    await (await allow(account.id, ME)).complete();
    expect(accountHasScopes(ctx, account.id, [DRIVE_READONLY_SCOPE])).toBe(true);
    const t = await googleAccessToken(ctx, account.id, [DRIVE_READONLY_SCOPE]);
    expect(t.scopes).toEqual([DRIVE_READONLY_SCOPE]);
    fake.drive.addFile(ME, { id: "f1", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet" });
    const res = await fetch(`${fake.url}/drive/v3/files/f1`, { headers: { authorization: `Bearer ${t.accessToken}` } });
    expect(await res.json()).toMatchObject({ id: "f1", name: "Budget" });
  });
});

describe("the API-enabled probe", () => {
  it("before consent: unchecked (an identity-only token can't prove it); after: on, and Google's 'not enabled' is recognised", async () => {
    ctx.google.setClient({ clientId: "fake-client.apps.googleusercontent.com", clientSecret: "fake-client-secret", projectId: "fake-project", appType: "external" });
    const account = await connectFakeAccount(ctx, fake, ME);
    const apis = [...WORKSPACE_APIS, { service: "tasks.googleapis.com", label: "Google Tasks API" }];
    const before = await probeGoogleApis(ctx, account.id, apis, []);
    expect(before.map((c) => c.state)).toEqual(["unchecked", "unchecked", "unchecked", "unchecked", "unchecked"]);
    expect(before[0]!.message).toContain("once you've allowed access");
    expect(before[4]!.message).toContain("can't check this API itself");
    expect(before[0]!.enableUrl).toBe("https://console.cloud.google.com/apis/library/docs.googleapis.com?project=fake-project");
    // An API that's off is seen even before consent (Google checks it before the scopes).
    fake.disableApi("sheets", true);
    expect((await probeGoogleApis(ctx, account.id, apis, []))[1]).toMatchObject({ state: "disabled", message: "The Google Sheets API is turned off in your Google Cloud project." });
    fake.disableApi("sheets", false);

    await (await allow(account.id, ME)).complete();
    const on = await probeGoogleApis(ctx, account.id, WORKSPACE_APIS, WORKSPACE_SCOPES);
    expect(on.map((c) => [c.service, c.state])).toEqual(WORKSPACE_APIS.map((a) => [a.service, "enabled"]));
    fake.disableApi("docs", true);
    fake.disableApi("slides", true);
    const off = await probeGoogleApis(ctx, account.id, WORKSPACE_APIS, WORKSPACE_SCOPES);
    // Google's own activationUrl when it sends one (Docs), else the API Library page in the project (Slides).
    expect(off[0]).toMatchObject({ state: "disabled", enableUrl: "https://console.developers.google.com/apis/api/docs.googleapis.com/overview?project=123456789" });
    expect(off[2]).toMatchObject({ state: "disabled", enableUrl: "https://console.cloud.google.com/apis/library/slides.googleapis.com?project=fake-project" });
    expect(off[1]!.state).toBe("enabled");
    expect(off[3]!.state).toBe("enabled");
    // Every probe token was downscoped: never one with the account's Gmail access.
    for (const r of fake.refreshes.filter((x) => x.requested)) expect(r.issued ?? []).not.toContain(GMAIL_SCOPE);
  });
});
