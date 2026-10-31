import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountsApi } from "../server/api/accounts.ts";
import { googleApi } from "../server/api/google.ts";
import type { AppEnv } from "../server/api/util.ts";
import type { AppContext } from "../server/context.ts";
import { now } from "../server/db/index.ts";
import { getRow } from "../server/google/accounts.ts";
import { noteCalendarApi, probeCalendar } from "../server/calendar/setup.ts";
import { GoogleApiError } from "../server/google/types.ts";
import { CALENDAR_SCOPES } from "../shared/google-scopes.ts";
import { HttpError } from "../server/util/errors.ts";
import type { CalendarSetupState, SetupWarning } from "../shared/types.ts";
import { ACTIVATION_URL, consent, fakeCalendar, MAIL_ONLY } from "./calendar-setup-fakes.ts";
import { connectFakeAccount, FAKE_CLIENT, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";
import { grantInput } from "./mail-fakes.ts";

const OPS = "ops@example.com";
const WYNN = "wynn@example.com";

let fake: FakeGoogle;
let ctx: AppContext;
let rec: ReturnType<typeof recordingEvents>;
let cal: ReturnType<typeof fakeCalendar>;
let dispose: () => Promise<void>;

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(async () => {
  fake = await startFakeGoogle();
  fake.pullWaitMs = 200;
  rec = recordingEvents();
  const t = testContext({ events: rec.factory }, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
  cal = fakeCalendar(ctx);
  ctx.google.setClient({ ...FAKE_CLIENT, appType: "internal" });
});

afterEach(async () => {
  await dispose();
  await fake.close();
});

function withErrors(app: Hono<AppEnv>): Hono<AppEnv> {
  app.onError((err, c) => c.json(err instanceof HttpError ? err.toJSON() : { error: { code: "internal", message: err.message } }, err instanceof HttpError ? (err.status as 409) : 500));
  return app;
}

const api = () => withErrors(googleApi(ctx));
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const calendarWarnings = () => ctx.google.setupWarnings().filter((w) => w.code.startsWith("calendar_"));
const received = (email: string) => rec.ofType("message.received").filter((e) => e.accountId === ctx.accounts.getByEmail(email)!.id);

/** Wynn's install before the upgrade: two accounts, Pub/Sub, mail flowing. Migration 7 then wrote enabled:false. */
async function existingInstall() {
  ctx.settings.setState("calendar.setup", { enabled: false });
  const ops = await connectFakeAccount(ctx, fake, OPS, { pubsub: true });
  const wynn = await connectFakeAccount(ctx, fake, WYNN);
  await ctx.google.provisionPubsub();
  ctx.ingest.start?.();
  await waitFor(() => ctx.ingest.status().lastPullAt !== null);
  fake.deliver(WYNN, { from: "a@x.test", subject: "Before the upgrade", text: "x" });
  await waitFor(() => received(WYNN).length === 1);
  return { ops, wynn };
}

describe("upgrading an existing install (zero mail downtime)", () => {
  it("adds Calendar per account while mail keeps flowing, the watch stays and the token is swapped", async () => {
    const { ops, wynn } = await existingInstall();
    expect(ctx.accounts.get(wynn.id)!.calendar).toBeNull();

    // Step 2: the notice.
    expect(calendarWarnings()).toEqual([expect.objectContaining({ code: "calendar_not_added", severity: "info" })]);
    expect(await json<CalendarSetupState>(api().request("/google/calendar"))).toMatchObject({
      enabled: false,
      dismissed: false,
      api: "unknown",
      step: "off",
      enableApiCommand: "gcloud services enable calendar-json.googleapis.com --project=fake-project",
      enableApiUrl: "https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com&project=fake-project",
      dataAccessUrl: "https://console.cloud.google.com/auth/scopes?project=fake-project",
      scopes: [...CALENDAR_SCOPES],
    });

    // Step 5: turn it on.
    const on = await json<CalendarSetupState>(api().request("/google/calendar", { method: "PATCH", body: JSON.stringify({ enabled: true }) }));
    expect(on).toMatchObject({ enabled: true, step: "connect_accounts" });
    expect(on.accounts.map((a) => [a.email, a.status, a.missingScopes.length])).toEqual([
      [OPS, "not_granted", 3],
      [WYNN, "not_granted", 3],
    ]);
    expect(calendarWarnings().map((w) => [w.code, w.accountId])).toEqual([
      ["calendar_scope_missing", ops.id],
      ["calendar_scope_missing", wynn.id],
    ]);

    // Step 6: "Add Calendar to wynn@", with mail arriving before, during and after the consent.
    const before = getRow(ctx, wynn.id)!;
    const watchBefore = fake.watch(WYNN);
    fake.consentAs(WYNN);
    const { authUrl } = ctx.google.startConnect({ reauthAccountId: wynn.id, scopes: ["calendar"] });
    expect(authUrl).toContain(`login_hint=${encodeURIComponent(WYNN)}`);
    const location = (await fetch(authUrl, { redirect: "manual" })).headers.get("location")!;
    fake.deliver(WYNN, { from: "a@x.test", subject: "During the consent", text: "x" });
    const done = ctx.google.completeConnectFromUrl(location);
    fake.deliver(WYNN, { from: "a@x.test", subject: "While the token is swapped", text: "x" });
    const account = await done;
    fake.deliver(WYNN, { from: "a@x.test", subject: "After the upgrade", text: "x" });
    await waitFor(() => received(WYNN).length === 4);
    expect(received(WYNN).map((e) => e.message?.subject)).toEqual(["Before the upgrade", "During the consent", "While the token is swapped", "After the upgrade"]);
    expect(rec.ofType("sync.gap")).toEqual([]);

    const after = getRow(ctx, wynn.id)!;
    expect(account.calendar).toMatchObject({ status: "active", missingScopes: [] });
    expect(after.refresh_token_enc).not.toBe(before.refresh_token_enc);
    expect(fake.revoked).toEqual([]);
    expect(fake.watch(WYNN)).not.toBeNull();
    expect(fake.watch(WYNN)!.topic).toBe(watchBefore!.topic);
    expect(ctx.google.pubsubState()).toMatchObject({ principalAccountId: ops.id, lastError: null });

    // The other account is untouched until its own consent; then setup is done.
    expect(getRow(ctx, ops.id)!.scopes).not.toContain("calendar");
    expect(ctx.calendar.setupState()).toMatchObject({ step: "connect_accounts", api: "enabled" });
    await consent(ctx, fake, OPS, { reauthAccountId: ops.id, scopes: ["calendar"] });
    expect(ctx.calendar.setupState()).toMatchObject({ step: "done", api: "enabled" });
    expect(calendarWarnings()).toEqual([]);
    // The principal kept Pub/Sub through include_granted_scopes.
    expect(ctx.google.pubsubState().principalAccountId).toBe(ops.id);
    fake.deliver(OPS, { from: "a@x.test", subject: "Ops still flows", text: "x" });
    await waitFor(() => received(OPS).length === 1);
  });

  it("an unticked Calendar leaves the account not_granted and mail flowing", async () => {
    const { wynn } = await existingInstall();
    ctx.calendar.updateSetup({ enabled: true });
    const { error } = await consent(ctx, fake, WYNN, { reauthAccountId: wynn.id, scopes: ["calendar"] }, { scopes: MAIL_ONLY });
    expect(error).toMatchObject({ code: "oauth_calendar_not_granted" });
    expect(ctx.calendar.setupState().accounts.find((a) => a.accountId === wynn.id)).toMatchObject({ status: "not_granted", missingScopes: [...CALENDAR_SCOPES] });
    expect(ctx.accounts.get(wynn.id)!.status).toBe("active");
    fake.deliver(WYNN, { from: "a@x.test", subject: "Still here", text: "x" });
    await waitFor(() => received(WYNN).length === 2);
  });

  it("a cancelled consent leaves the account as it was and mail flowing", async () => {
    const { wynn } = await existingInstall();
    const err = await consent(ctx, fake, WYNN, { reauthAccountId: wynn.id, scopes: ["calendar"] }, { deny: true });
    expect(err.error).toMatchObject({ code: "oauth_access_denied" });
    expect(ctx.accounts.get(wynn.id)).toMatchObject({ status: "active", calendar: null });
    fake.deliver(WYNN, { from: "a@x.test", subject: "Still here", text: "x" });
    await waitFor(() => received(WYNN).length === 2);
  });

  it("the notice can be dismissed and brought back", async () => {
    await connectFakeAccount(ctx, fake, OPS);
    ctx.settings.setState("calendar.setup", { enabled: false });
    expect(calendarWarnings().map((w) => w.code)).toEqual(["calendar_not_added"]);
    const res = await json<CalendarSetupState>(api().request("/google/calendar", { method: "PATCH", body: JSON.stringify({ dismissed: true }) }));
    expect(res).toMatchObject({ dismissed: true, enabled: false });
    expect(calendarWarnings()).toEqual([]);
    ctx.calendar.updateSetup({ dismissed: false });
    expect(calendarWarnings().map((w) => w.code)).toEqual(["calendar_not_added"]);
    expect(ctx.audit.list({ action: "calendar.setup.update" }).items).toHaveLength(2);
    const bad = await api().request("/google/calendar", { method: "PATCH", body: JSON.stringify({ enabled: "yes" }) });
    expect(bad.status).toBe(400);
  });
});

describe("Calendar API turned off in the project", () => {
  it("is detected right after the consent, warned about with Google's activationUrl, and cleared by a check", async () => {
    cal.disableApi(true);
    const { account } = await consent(ctx, fake, OPS, {}, {});
    expect(account!.calendar).toMatchObject({ status: "api_disabled", error: "The Google Calendar API is turned off in your Google Cloud project." });
    expect(ctx.calendar.setupState()).toMatchObject({ api: "disabled", step: "enable_api", enableApiUrl: ACTIVATION_URL });
    const [w] = calendarWarnings();
    expect(w).toMatchObject({ code: "calendar_api_disabled", severity: "warning", url: ACTIVATION_URL });
    expect(w!.hint).toContain("gcloud services enable calendar-json.googleapis.com --project=fake-project");

    // With an agent that uses Calendar it is an error.
    ctx.policy.createAgent({ name: "Hermes", grants: [grantInput(account!.id, { capabilities: ["read", "calendar.read"] })] });
    expect(calendarWarnings()[0]!.severity).toBe("error");

    const calendars = await withErrors(accountsApi(ctx)).request(`/accounts/${account!.id}/calendars`);
    expect(calendars.status).toBe(409);
    expect(await calendars.json()).toMatchObject({ error: { code: "calendar_api_disabled" } });

    cal.disableApi(false);
    const checked = await json<CalendarSetupState>(api().request("/google/calendar/check", { method: "POST" }));
    expect(checked).toMatchObject({ api: "enabled", step: "done" });
    expect(ctx.accounts.get(account!.id)!.calendar).toMatchObject({ status: "active", error: null });
    expect(calendarWarnings()).toEqual([]);
  });

  it("a success on one account clears api_disabled on the others (the API is per project)", async () => {
    const a = (await consent(ctx, fake, OPS)).account!;
    const b = (await consent(ctx, fake, WYNN)).account!;
    ctx.db.run("UPDATE accounts SET calendar_status = 'api_disabled', calendar_error = 'off'");
    await ctx.calendar.calendars(a.id);
    expect(ctx.accounts.get(b.id)!.calendar?.status).toBe("active");
  });
});

describe("API state across accounts", () => {
  const disabledError = (activationUrl: string) =>
    new GoogleApiError(403, "Google Calendar API has not been used in project 1", "SERVICE_DISABLED", { reasons: ["SERVICE_DISABLED"], metadata: { activationUrl } });

  it("an account left marked api_disabled doesn't keep the install disabled once the API is seen working", async () => {
    const a = (await consent(ctx, fake, OPS)).account!;
    const b = (await consent(ctx, fake, WYNN)).account!;
    ctx.policy.createAgent({ name: "Hermes", grants: [grantInput(b.id, { capabilities: ["calendar.read"] })] });
    noteCalendarApi(ctx, "disabled", disabledError(ACTIVATION_URL));
    ctx.db.run("UPDATE accounts SET calendar_status = 'api_disabled', calendar_error = 'off'");
    expect(calendarWarnings().map((w) => [w.code, w.severity])).toEqual([["calendar_api_disabled", "error"]]);
    // Sync (A) on the other account sees the API working.
    noteCalendarApi(ctx, "enabled");
    expect(ctx.calendar.setupState()).toMatchObject({ api: "enabled", step: "done" });
    expect(ctx.accounts.get(a.id)!.calendar?.status).toBe("active");
    expect(ctx.accounts.get(b.id)!.calendar?.status).toBe("active");
    expect(calendarWarnings()).toEqual([]);
  });

  it("prefers the newest install-wide observation over a stale account row", async () => {
    const a = (await consent(ctx, fake, OPS)).account!;
    ctx.db.run("UPDATE accounts SET calendar_status = 'api_disabled' WHERE id = ?", a.id);
    ctx.settings.setState("calendar.setup", { enabled: true, api: { state: "enabled", at: now() } });
    expect(ctx.calendar.setupState().api).toBe("enabled");
  });

  it("stores Google's activationUrl only when it is a Google Cloud console link, and fills it in later", async () => {
    await consent(ctx, fake, OPS);
    const project = "https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com&project=fake-project";
    for (const bad of ["https://evil.example/enable", "javascript:alert(1)", "http://console.cloud.google.com/x", "https://user@console.cloud.google.com/x"]) {
      noteCalendarApi(ctx, "disabled", disabledError(bad));
      expect(ctx.calendar.setupState().enableApiUrl).toBe(project);
      expect(calendarWarnings()[0]!.url).toBe(project);
    }
    expect(ctx.settings.getState("calendar.setup")!.api).toMatchObject({ state: "disabled", activationUrl: null });
    noteCalendarApi(ctx, "disabled", disabledError(ACTIVATION_URL));
    expect(ctx.settings.getState("calendar.setup")!.api).toMatchObject({ state: "disabled", activationUrl: ACTIVATION_URL });
    // A later answer without one keeps it.
    noteCalendarApi(ctx, "disabled", new GoogleApiError(403, "disabled", "accessNotConfigured"));
    expect(ctx.calendar.setupState().enableApiUrl).toBe(ACTIVATION_URL);
  });

  it("a working calendar list clears only api_disabled, never sync's own error", async () => {
    const a = (await consent(ctx, fake, OPS)).account!;
    ctx.db.run("UPDATE accounts SET calendar_status = 'error', calendar_error = 'Calendar sync failed: HTTP 500' WHERE id = ?", a.id);
    await ctx.calendar.calendars(a.id);
    expect(ctx.accounts.get(a.id)!.calendar).toMatchObject({ status: "error", error: "Calendar sync failed: HTTP 500" });
  });

  it("a connect waits for a slow probe only briefly; the answer is recorded when it comes", async () => {
    const a = (await consent(ctx, fake, OPS)).account!;
    cal.delayMs = 200;
    cal.disableApi(true);
    const t = Date.now();
    await probeCalendar(ctx, a.id, { waitMs: 30 });
    expect(Date.now() - t).toBeLessThan(150);
    expect(ctx.accounts.get(a.id)!.calendar?.status).toBe("active");
    await waitFor(() => ctx.accounts.get(a.id)!.calendar?.status === "api_disabled");
  });
});

describe("GET /accounts/:id/calendars", () => {
  it("lists the account's calendars, primary first, names cleaned, synced from calendar_sync", async () => {
    const { account } = await consent(ctx, fake, OPS);
    ctx.db.run("INSERT INTO calendar_sync (account_id, calendar_id, updated_at) VALUES (?, ?, ?)", account!.id, OPS, now());
    const res = await withErrors(accountsApi(ctx)).request(`/accounts/${account!.id}/calendars`);
    expect(await res.json()).toEqual([
      { id: OPS, name: OPS, primary: true, accessRole: "owner", timeZone: "Europe/Berlin", color: "#9fe1e7", synced: true },
      { id: "team@group.calendar.google.com", name: "Team standups", primary: false, accessRole: "writer", timeZone: "Europe/Berlin", color: null, synced: false },
    ]);
    expect(ctx.calendar.setupState().accounts[0]).toMatchObject({ syncedCalendars: 1, push: false });
  });

  it("answers 409 calendar_not_granted, needs_reauth, and 404 for unknown accounts", async () => {
    ctx.calendar.updateSetup({ enabled: false });
    const { account } = await consent(ctx, fake, OPS);
    const app = withErrors(accountsApi(ctx));
    const notGranted = await app.request(`/accounts/${account!.id}/calendars`);
    expect(notGranted.status).toBe(409);
    expect(await notGranted.json()).toMatchObject({ error: { code: "calendar_not_granted", message: `Google Calendar isn't added to ${OPS} yet.`, hint: expect.stringContaining("Add Calendar") } });
    expect(cal.calls).toEqual([]);
    ctx.accounts.setStatus(account!.id, "needs_reauth", "x");
    expect(await json(app.request(`/accounts/${account!.id}/calendars`))).toMatchObject({ error: { code: "needs_reauth" } });
    expect((await app.request("/accounts/acc_nope/calendars")).status).toBe(404);
  });

  it("re-reads the granted scopes when Google says one is missing", async () => {
    const { account } = await consent(ctx, fake, OPS, {}, { scopes: [...MAIL_ONLY, ...CALENDAR_SCOPES.slice(0, 2)] });
    // xaq believes it has every scope (stale), Google knows better.
    ctx.db.run("UPDATE accounts SET scopes = ? WHERE id = ?", JSON.stringify([...MAIL_ONLY, ...CALENDAR_SCOPES]), account!.id);
    cal.scopeInsufficient(1);
    const err = await ctx.calendar.calendars(account!.id).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "calendar_not_granted" });
    expect(ctx.accounts.get(account!.id)!.calendar).toMatchObject({ status: "not_granted", missingScopes: [CALENDAR_SCOPES[2]] });
  });

  it("retries once when the refreshed scopes are complete (the cached token predated a consent)", async () => {
    const { account } = await consent(ctx, fake, OPS);
    cal.scopeInsufficient(1);
    expect(await ctx.calendar.calendars(account!.id)).toHaveLength(2);
  });
});

describe("setup warnings", () => {
  it("every calendar warning has a message and a hint, and per-account ones name the account", async () => {
    const a = (await consent(ctx, fake, OPS, {}, { scopes: MAIL_ONLY })).account!;
    const b = (await consent(ctx, fake, WYNN)).account!;
    ctx.db.run("UPDATE accounts SET calendar_status = 'error', calendar_error = 'Google returned HTTP 500' WHERE id = ?", b.id);
    const ws: SetupWarning[] = calendarWarnings();
    expect(ws.map((w) => [w.code, w.severity, w.accountId])).toEqual([
      ["calendar_sync_failing", "error", b.id],
      ["calendar_scope_missing", "info", a.id],
    ]);
    expect(ws[0]!.message).toBe(`Google Calendar sync for ${WYNN} is failing: Google returned HTTP 500`);
    expect(ws[1]!.message).toBe(`Google Calendar isn't added to ${OPS} yet, so agents can't use its calendar. Its mail is unaffected.`);
    for (const w of ws) {
      expect(w.message.length).toBeGreaterThan(20);
      expect(w.hint.length).toBeGreaterThan(20);
    }
    ctx.settings.setState("calendar.setup", { enabled: false });
    cal.disableApi(true);
    await ctx.calendar.check();
    ctx.db.run("DELETE FROM grants");
    for (const w of [...calendarWarnings(), ...ctx.google.setupWarnings().filter((x) => x.code === "calendar_not_added")]) {
      expect(w.message).toBeTruthy();
      expect(w.hint).toBeTruthy();
      if (w.code === "calendar_api_disabled") expect(w.url).toBe(ACTIVATION_URL);
    }
    expect(calendarWarnings().map((w) => w.code)).toEqual(["calendar_api_disabled", "calendar_not_added"]);
  });

  it("the not-added notice names the gcloud command and the enable link for the project", async () => {
    await connectFakeAccount(ctx, fake, OPS);
    ctx.settings.setState("calendar.setup", { enabled: false });
    const [w] = calendarWarnings();
    expect(w!.url).toBeUndefined();
    expect(w!.hint).toContain("gcloud services enable calendar-json.googleapis.com --project=fake-project");
    expect(w!.hint).toContain("https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com&project=fake-project");
  });
});
