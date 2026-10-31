import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountsApi } from "../server/api/accounts.ts";
import { googleApi } from "../server/api/google.ts";
import type { AppContext } from "../server/context.ts";
import { getRow } from "../server/google/accounts.ts";
import { storedFailure } from "../server/google/oauth.ts";
import { googleRuntime } from "../server/google/runtime.ts";
import { CALENDAR_SCOPES, GMAIL_SCOPE } from "../shared/google-scopes.ts";
import { HttpError } from "../server/util/errors.ts";
import { connectFakeAccount, consent, FAKE_CLIENT, type FakeGoogle, MAIL_ONLY, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

const ME = "me@example.com";

let fake: FakeGoogle;
let ctx: AppContext;
let dispose: () => Promise<void>;

beforeEach(async () => {
  fake = await startFakeGoogle();
  const t = testContext({ events: recordingEvents().factory }, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
  ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
  fake.addAccount(ME);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dispose();
  await fake.close();
});

/** An install upgraded from before Calendar (migration 7 wrote this because accounts existed). */
const preCalendarInstall = () => ctx.settings.setState("calendar.setup", { enabled: false });

const requested = (start: Parameters<AppContext["google"]["startConnect"]>[0] = {}) => {
  const q = new URL(ctx.google.startConnect(start).authUrl).searchParams;
  return { scopes: (q.get("scope") ?? "").split(" "), incremental: q.get("include_granted_scopes") };
};

const calendarLists = () => fake.requests.filter((r) => r.path.endsWith("/calendarList")).length;
const scopesOf = (id: string) => JSON.parse(getRow(ctx, id)!.scopes) as string[];

describe("which scopes a consent asks for", () => {
  it("a fresh install connects with mail and calendar in one consent", async () => {
    expect(requested()).toEqual({ scopes: [GMAIL_SCOPE, "openid", "email", "profile", ...CALENDAR_SCOPES], incremental: "true" });
    const { account, scope } = await consent(ctx, fake, ME);
    expect(scope).toEqual(expect.arrayContaining([...CALENDAR_SCOPES]));
    expect(account!.calendar).toEqual({ status: "active", missingScopes: [], lastSyncAt: null, error: null });
    // The probe right after the consent saw the API working.
    expect(calendarLists()).toBe(1);
    expect(ctx.calendar.setupState()).toMatchObject({ enabled: true, api: "enabled", step: "done" });
  });

  it("an upgraded install asks for mail only until Calendar is turned on, or asked for", () => {
    preCalendarInstall();
    expect(requested().scopes).not.toContain(CALENDAR_SCOPES[0]);
    expect(requested({ scopes: ["calendar"] }).scopes).toEqual(expect.arrayContaining([...CALENDAR_SCOPES]));
    ctx.calendar.updateSetup({ enabled: true });
    expect(requested().scopes).toEqual(expect.arrayContaining([...CALENDAR_SCOPES]));
  });

  it("turning Calendar off really drops the calendar scopes (for admins who block Calendar)", async () => {
    const res = await googleApi(ctx).request("/google/calendar", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect(await res.json()).toMatchObject({ enabled: false, step: "off" });
    expect(requested().scopes).toEqual([GMAIL_SCOPE, "openid", "email", "profile"]);
    const { account } = await consent(ctx, fake, ME);
    expect(account!.calendar).toBeNull();
    expect(calendarLists()).toBe(0);
  });

  it("a reconnect asks again for calendar scopes the account had only while Calendar is on and not mail-only", async () => {
    const account = await connectFakeAccount(ctx, fake, ME);
    const reauthAccountId = account.id;
    expect(scopesOf(reauthAccountId)).toEqual(expect.arrayContaining([...CALENDAR_SCOPES]));
    expect(requested({ reauthAccountId }).scopes).toEqual(expect.arrayContaining([...CALENDAR_SCOPES]));
    // An admin blocks Calendar: a mail-only reconnect leaves it out.
    const mailOnly = requested({ reauthAccountId, mailOnly: true }).scopes;
    expect(mailOnly).toEqual([GMAIL_SCOPE, "openid", "email", "profile"]);
    // So does any reconnect once Calendar is turned off; include_granted_scopes keeps what Google still grants.
    ctx.calendar.updateSetup({ enabled: false });
    expect(requested({ reauthAccountId }).scopes).toEqual([GMAIL_SCOPE, "openid", "email", "profile"]);
    expect(requested({ reauthAccountId }).incremental).toBe("true");
    expect(() => ctx.google.startConnect({ reauthAccountId, mailOnly: true, scopes: ["calendar"] })).toThrow(/mail-only connection can't add Google Calendar/);
  });

  it("a mail-only reconnect works through the API and keeps mail when Calendar is blocked", async () => {
    const { account } = await consent(ctx, fake, ME);
    const res = await accountsApi(ctx).request("/accounts/connect", { method: "POST", body: JSON.stringify({ reauthAccountId: account!.id, mailOnly: true }) });
    const url = new URL(((await res.json()) as { authUrl: string }).authUrl);
    expect(url.searchParams.get("scope")).not.toContain("calendar");
    // The admin's block: Google grants only mail now.
    fake.consentAs(ME, { scopes: MAIL_ONLY });
    const location = (await fetch(url, { redirect: "manual" })).headers.get("location")!;
    const reconnected = await ctx.google.completeConnectFromUrl(location);
    expect(reconnected.status).toBe("active");
  });

  it("accepts scopes [\"calendar\"] on POST /accounts/connect and rejects unknown names", async () => {
    preCalendarInstall();
    const { account } = await consent(ctx, fake, ME);
    const api = accountsApi(ctx);
    api.onError((err, c) => c.json(err instanceof HttpError ? err.toJSON() : { error: { code: "internal", message: err.message } }, err instanceof HttpError ? 400 : 500));
    const ok = await api.request("/accounts/connect", { method: "POST", body: JSON.stringify({ reauthAccountId: account!.id, scopes: ["calendar"] }) });
    expect(ok.status).toBe(200);
    const url = new URL(((await ok.json()) as { authUrl: string }).authUrl);
    expect(url.searchParams.get("scope")).toContain(CALENDAR_SCOPES[2]);
    expect(url.searchParams.get("login_hint")).toBe(ME);
    const bad = await api.request("/accounts/connect", { method: "POST", body: JSON.stringify({ scopes: ["drive"] }) });
    expect(bad.status).toBe(400);
  });
});

describe("Add Calendar to an existing account", () => {
  let id: string;
  beforeEach(async () => {
    preCalendarInstall();
    id = (await connectFakeAccount(ctx, fake, ME)).id;
    expect(scopesOf(id)).toEqual(expect.arrayContaining([GMAIL_SCOPE]));
  });

  it("swaps in the new refresh token in one update, never revokes the old one, and keeps the history cursor", async () => {
    const before = getRow(ctx, id)!;
    const { account } = await consent(ctx, fake, ME, { reauthAccountId: id, scopes: ["calendar"] });
    const after = getRow(ctx, id)!;
    expect(account!.calendar).toMatchObject({ status: "active", missingScopes: [] });
    expect(after.refresh_token_enc).not.toBe(before.refresh_token_enc);
    expect(after.history_id).toBe(before.history_id);
    expect(scopesOf(id)).toEqual(expect.arrayContaining([GMAIL_SCOPE, ...CALENDAR_SCOPES]));
    expect(fake.revoked).toEqual([]);
    // The old refresh token still works at Google (a new consent doesn't revoke it).
    const res = await fetch(`${fake.url}/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: ctx.crypto.decrypt(before.refresh_token_enc), client_id: FAKE_CLIENT.clientId, client_secret: FAKE_CLIENT.clientSecret }),
    });
    expect(res.status).toBe(200);
  });

  it("unticking Calendar keeps mail as it was and says so in plain words", async () => {
    const { error } = await consent(ctx, fake, ME, { reauthAccountId: id, scopes: ["calendar"] }, { scopes: MAIL_ONLY });
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ code: "oauth_calendar_not_granted" });
    expect(error!.message).toBe(`Google Calendar wasn't added to ${ME}: its Calendar permissions were unticked on Google's screen. Its mail keeps working as before.`);
    const row = getRow(ctx, id)!;
    expect(row.status).toBe("active");
    expect(scopesOf(id)).toEqual(expect.arrayContaining([GMAIL_SCOPE]));
    expect(ctx.calendar.setupState().accounts[0]).toMatchObject({ status: "not_granted", missingScopes: [...CALENDAR_SCOPES] });
    expect(calendarLists()).toBe(0);
    expect(fake.revoked).toEqual([]);
  });

  it("names the permissions left unticked when only some were granted", async () => {
    const { error } = await consent(ctx, fake, ME, { reauthAccountId: id, scopes: ["calendar"] }, { scopes: [...MAIL_ONLY, ...CALENDAR_SCOPES.slice(0, 2)] });
    expect(error!.message).toMatch(/only partly added to me@example.com: some Calendar permissions were unticked on Google's screen \(see when people are free or busy\)/);
    expect(ctx.accounts.get(id)!.calendar).toMatchObject({ status: "not_granted", missingScopes: [CALENDAR_SCOPES[2]] });
  });

  it("cancelling on Google's screen changes nothing and says so", async () => {
    const before = getRow(ctx, id)!;
    const { authUrl, state } = ctx.google.startConnect({ reauthAccountId: id, scopes: ["calendar"] });
    fake.consentAs(ME, { deny: true });
    const location = (await fetch(authUrl, { redirect: "manual" })).headers.get("location")!;
    const err = await ctx.google.completeConnectFromUrl(location).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "oauth_access_denied", message: `You cancelled adding Google Calendar to ${ME}, so nothing changed: its mail keeps working as before.` });
    expect(ctx.google.connectAttempt(state)).toMatchObject({ status: "failed", code: "oauth_access_denied", error: (err as Error).message });
    const after = getRow(ctx, id)!;
    for (const k of ["refresh_token_enc", "access_token_enc", "scopes", "status", "history_id", "calendar_status"] as const) expect(after[k]).toBe(before[k]);
  });

  it("says nothing changed and asks for the admin when a Workspace admin blocks Calendar", async () => {
    const before = getRow(ctx, id)!;
    const { state } = ctx.google.startConnect({ reauthAccountId: id, scopes: ["calendar"] });
    const err = (await ctx.google.completeConnectFromUrl(`?error=admin_policy_enforced&state=${state}`).catch((e: unknown) => e)) as HttpError;
    expect(err).toMatchObject({
      code: "oauth_admin_policy_enforced",
      message: `Your Google Workspace admin doesn't allow xaq to use Google Calendar, so nothing changed for ${ME}: its mail is unaffected.`,
    });
    expect(err.hint).toContain(`trust the OAuth client ID ${FAKE_CLIENT.clientId}`);
    expect(ctx.google.connectAttempt(state)).toMatchObject({ status: "failed", code: "oauth_admin_policy_enforced", error: err.message });
    expect(getRow(ctx, id)!.refresh_token_enc).toBe(before.refresh_token_enc);
  });

  it("picking another connected account says Calendar wasn't added and what happened to the other one", async () => {
    const other = await connectFakeAccount(ctx, fake, "other@example.com");
    const { error } = await consent(ctx, fake, "other@example.com", { reauthAccountId: id, scopes: ["calendar"] });
    expect(error).toMatchObject({ code: "oauth_wrong_account" });
    expect(error!.message).toBe(
      `You were adding Google Calendar to ${ME}, but signed in to Google as other@example.com, so nothing changed for ${ME}: its mail keeps working. ` +
        "other@example.com is also connected here, so xaq saved that new sign-in for other@example.com, which adds Google Calendar to it.",
    );
    expect((error as HttpError).hint).toMatch(/^Click Add Calendar for me@example.com again and pick me@example.com/);
    expect(ctx.accounts.get(other.id)!.calendar?.status).toBe("active");
    expect(ctx.accounts.get(id)!.calendar).toBeNull();
    // Without new scopes for the other account the old words still hold.
    const again = await consent(ctx, fake, "other@example.com", { reauthAccountId: id, scopes: ["calendar"] });
    expect(again.error!.message).toMatch(/saved that new sign-in for other@example.com; nothing else changed\.$/);
  });

  it("a code exchange without `scope` keeps the recorded scopes and skips the unticked check", async () => {
    const before = scopesOf(id);
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const res = await real(input, init);
      const body = typeof init?.body === "string" ? init.body : "";
      if (!String(input).endsWith("/token") || !body.includes("grant_type=authorization_code")) return res;
      const { scope: _, ...rest } = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify(rest), { status: res.status, headers: { "content-type": "application/json" } });
    });
    const { account, error } = await consent(ctx, fake, ME, { reauthAccountId: id, scopes: ["calendar"] });
    expect(error).toBeUndefined();
    expect(account!.status).toBe("active");
    expect(scopesOf(id)).toEqual(before);
  });
});

describe("Workspace admins blocking Calendar", () => {
  const blocked = async (start: Parameters<AppContext["google"]["startConnect"]>[0] = {}) => {
    const { state } = ctx.google.startConnect(start);
    const err = await ctx.google.completeConnectFromUrl(`?error=admin_policy_enforced&state=${state}`).then(
      () => Promise.reject(new Error("connected")),
      (e: unknown) => e as HttpError,
    );
    return { err, stored: ctx.google.connectAttempt(state) };
  };

  it("points at connecting without Calendar when the consent asked for it", async () => {
    const { err, stored } = await blocked();
    expect(err.code).toBe("oauth_admin_policy_enforced");
    expect(err.message).toMatch(/blocks Google Calendar access/);
    expect(err.hint).toMatch(/^Connect again with mail only \(the connect dialog offers it\), or turn Calendar off in Settings → Google Calendar → Turn off/);
    // The stored attempt keeps the calendar explanation (fixed text, never the URL's).
    expect(stored).toMatchObject({ status: "failed", code: "oauth_admin_policy_enforced", hint: err.hint });
    expect(storedFailure(err).hint).toBe(err.hint);
  });

  it("keeps the plain explanation for mail-only consents", async () => {
    preCalendarInstall();
    const { err } = await blocked();
    expect(err.message).toBe("Your Google Workspace admin blocks this app.");
  });
});

describe("scope backfill on token refresh", () => {
  let id: string;
  beforeEach(async () => {
    preCalendarInstall();
    id = (await connectFakeAccount(ctx, fake, ME)).id;
  });

  it("records the scope a refresh reports, and broadcasts the account", async () => {
    ctx.db.run("UPDATE accounts SET scopes = ? WHERE id = ?", JSON.stringify([GMAIL_SCOPE, ...CALENDAR_SCOPES]), id);
    expect(ctx.accounts.get(id)!.calendar?.status).toBe("active");
    const seen: string[][] = [];
    ctx.bus.on("account", (a) => seen.push(a.grantedScopes ?? []));
    await googleRuntime(ctx).tokens.accessToken(id, { force: true });
    expect(scopesOf(id)).not.toContain(CALENDAR_SCOPES[0]);
    expect(ctx.accounts.get(id)!.calendar).toBeNull();
    expect(seen).toHaveLength(1);
    // Unchanged scopes don't broadcast again.
    await googleRuntime(ctx).tokens.accessToken(id, { force: true });
    expect(seen).toHaveLength(1);
  });

  it("treats a refresh response without scope as unchanged", async () => {
    const before = scopesOf(id);
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const res = await real(input, init);
      if (!String(input).endsWith("/token")) return res;
      const { scope: _, ...body } = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json" } });
    });
    await googleRuntime(ctx).tokens.accessToken(id, { force: true });
    expect(scopesOf(id)).toEqual(before);
  });

  it("a refresh with the old token that finishes after the consent never overwrites the new token's scopes", async () => {
    googleRuntime(ctx).tokens.invalidate(id);
    // Hold the refresh at Google until the consent below has stored its tokens.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (String(input).endsWith("/token") && body.includes("grant_type=refresh_token") && !held) {
        held = true;
        const res = await real(input, init);
        await gate;
        return res;
      }
      return real(input, init);
    });
    const inflight = googleRuntime(ctx).tokens.accessToken(id);
    await vi.waitFor(() => expect(held).toBe(true));
    const { account } = await consent(ctx, fake, ME, { reauthAccountId: id, scopes: ["calendar"] });
    expect(account!.calendar?.status).toBe("active");
    const swapped = getRow(ctx, id)!;
    release();
    const token = await inflight;
    const after = getRow(ctx, id)!;
    expect(after.scopes).toBe(swapped.scopes);
    expect(after.access_token_enc).toBe(swapped.access_token_enc);
    expect(after.refresh_token_enc).toBe(swapped.refresh_token_enc);
    // The caller gets the new, calendar-capable access token.
    expect(token).toBe(ctx.crypto.decrypt(swapped.access_token_enc!));
  });
});
