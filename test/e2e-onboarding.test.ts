// E2E: the first-run wizard path over the console API, as a zero-context user takes it: claim → import
// the downloaded client JSON (first without the redirect URI) → connect Gmail (External app in Testing)
// → setup warnings → send the test email and watch it arrive as events and at a webhook.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Account, GoogleClientImportResult, SetupState, TestEmailResult, WebhookWithSecret } from "../shared/types.ts";
import { HAS_AGENTS } from "./e2e/features.ts";
import { FAKE_CLIENT, grant, mailbox, type Stack, startStack } from "./e2e/harness.ts";
import { startWebhookReceiver, type WebhookReceiver } from "./e2e/webhook-receiver.ts";
import { waitFor } from "./e2e/wait.ts";

let s: Stack;
let rx: WebhookReceiver;

beforeAll(async () => {
  rx = await startWebhookReceiver();
  s = await startStack();
  await s.admin.claim(s.setupToken()!);
  await s.admin.patch("/api/settings", { publicUrl: s.url, pollIntervalSeconds: 5 });
});
afterAll(async () => {
  await s.close();
  await rx.close();
});

const clientJson = (redirectUris: string[]) =>
  JSON.stringify({
    web: {
      client_id: FAKE_CLIENT.clientId,
      project_id: FAKE_CLIENT.projectId,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_secret: FAKE_CLIENT.clientSecret,
      redirect_uris: redirectUris,
      javascript_origins: [s.url],
    },
  });

describe("onboarding wizard", () => {
  let account: Account;

  it("imports the client JSON and flags a missing redirect URI until it is registered", async () => {
    const redirectUri = `${s.url}/oauth/callback`;
    s.fake.registeredRedirectUris = [`${s.url}/oauth/callback/`]; // what Google has: the trailing slash typo
    const first = await s.admin.post<GoogleClientImportResult>("/api/google/client/import", { json: clientJson([`${s.url}/oauth/callback/`]), appType: "external" });
    expect(first).toMatchObject({ clientId: FAKE_CLIENT.clientId, hasSecret: true, projectId: FAKE_CLIENT.projectId, appType: "external", redirectUri });
    expect(first.warnings.map((w) => w.code)).toEqual(["redirect_uri_missing"]);
    expect(first.warnings[0]!.message).toContain(redirectUri);
    expect(first.check).toMatchObject({ clientId: "ok", redirectUri: "missing", secret: "ok" });
    let state = await s.admin.get<SetupState>("/api/setup/state");
    expect(state.googleClientConfigured).toBe(true);
    expect(state.warnings.map((w) => w.code)).toEqual(["redirect_uri_missing"]);

    s.fake.registeredRedirectUris = [redirectUri];
    const fixed = await s.admin.post<GoogleClientImportResult>("/api/google/client/import", { json: clientJson([redirectUri]) });
    expect(fixed.warnings).toEqual([]);
    expect(fixed.appType).toBe("external"); // kept when omitted
    state = await s.admin.get<SetupState>("/api/setup/state");
    expect(state.warnings).toEqual([]);
  });

  it("detects Testing mode and the Workspace domain on connect", async () => {
    s.fake.refreshTokenTtl = 604_800;
    const email = mailbox("wizard");
    s.fake.addAccount(email, { workspaceDomain: "acme.test" });
    account = await s.connectAccount(email);
    expect(account.workspaceDomain).toBe("acme.test");
    const expires = Date.parse(account.refreshTokenExpiresAt!);
    expect(Math.abs(expires - (Date.now() + 604_800_000))).toBeLessThan(60_000);

    const state = await s.admin.get<SetupState>("/api/setup/state");
    expect(state.complete).toBe(true);
    const testing = state.warnings.find((w) => w.code === "testing_mode")!;
    expect(testing).toMatchObject({ severity: "warning", accountId: account.id, url: `https://console.cloud.google.com/auth/audience?project=${FAKE_CLIENT.projectId}` });
    expect(testing.message).toContain(email);
    expect(testing.hint).toMatch(/Publish app/);
    // External app, every account in one Workspace: Internal is suggested.
    expect(state.warnings.find((w) => w.code === "app_type_mismatch")).toMatchObject({ severity: "info" });
    // Health is unaffected by warnings.
    expect(await (await fetch(`${s.url}/health`)).json()).toMatchObject({ status: "ok", setupComplete: true });
  });

  it.runIf(HAS_AGENTS)("sends a test email that arrives as events and at a message.received webhook", async () => {
    const { agent } = await s.createAgent("wizard-agent", [grant(account.id, { level: "read" })]);
    await s.admin.post<WebhookWithSecret>("/api/webhooks", {
      agentId: agent.id,
      name: "first webhook",
      url: `${rx.url}/first`,
      eventTypes: ["message.received"],
      filter: {},
      includeBody: false,
      enabled: true,
    });
    const sent = await s.admin.post<TestEmailResult>(`/api/accounts/${account.id}/test-email`);
    expect(sent.messageId).toBeTruthy();
    const received = await s.waitForEvent((e) => e.type === "message.received" && e.message?.id === sent.messageId);
    expect(received.message).toMatchObject({ subject: "xaq test: your setup works", from: { email: account.email } });
    expect((await s.events({ accountId: account.id })).some((e) => e.type === "message.sent" && e.message?.id === sent.messageId)).toBe(true);
    const hook = await waitFor(() => rx.at("/first").find((h) => h.json?.data.message?.id === sent.messageId), { what: "test email webhook" });
    expect(hook.json!.type).toBe("message.received");
  });
});
