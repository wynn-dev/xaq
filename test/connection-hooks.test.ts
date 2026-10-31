// The generic inbound-webhook route for native presets (server/integrations/hooks.ts). WHOOP, its only user, left
// core (a code extension now, with no webhooks), so it's exercised here with a small signed test preset.

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.ts";
import type { IntegrationEvent, IntegrationPreset } from "../server/broker/types.ts";
import type { AppContext } from "../server/context.ts";
import { type ConnectionHookHost, HOOK_DEDUPE_TTL_MS, connectionHookRoutes, connectionHookUrl } from "../server/integrations/hooks.ts";
import { createLogger } from "../server/util/log.ts";
import { testContext } from "./helpers.ts";

const silent = { info() {}, warn() {} };
const SECRET = "acme-client-secret";
const TOLERANCE_MS = 2 * 3_600_000;

type Msg = { headers: Record<string, string>; rawBody: Buffer };
const post = (app: { request: (path: string, init: RequestInit) => Response | Promise<Response> }, path: string, msg: Msg) =>
  app.request(path, { method: "POST", headers: msg.headers, body: new Uint8Array(msg.rawBody) });

/** A signed delivery: HMAC-SHA256 over timestamp + body with the app's client secret. */
function webhook(body: { id: string; trace: string; member?: number }, o: { secret?: string; timestamp?: number } = {}): Msg {
  const rawBody = Buffer.from(JSON.stringify({ member: 1, ...body }));
  const ts = String(o.timestamp ?? Date.now());
  const sig = createHmac("sha256", o.secret ?? SECRET).update(ts).update(rawBody).digest("base64");
  return { headers: { "content-type": "application/json", "x-acme-signature": sig, "x-acme-timestamp": ts }, rawBody };
}

function acmePreset(now: () => number): IntegrationPreset {
  return {
    id: "acme",
    displayName: "Acme",
    slug: "acme",
    kind: "native",
    auth: { type: "user_app", authorizeUrl: "https://acme.example/auth", tokenUrl: "https://acme.example/token", scopes: [], clientIdInput: "client_id", clientSecretInput: "client_secret" },
    classify: () => null,
    setupSteps: () => [],
    events: {
      types: ["acme.thing_updated"],
      async handleWebhook(req, deps) {
        const ts = req.headers["x-acme-timestamp"] ?? "";
        const want = createHmac("sha256", deps.clientSecret).update(ts).update(req.rawBody).digest("base64");
        if (req.headers["x-acme-signature"] !== want || Math.abs(now() - Number(ts)) > TOLERANCE_MS) return null;
        const body = JSON.parse(req.rawBody.toString("utf8")) as { id: string; trace: string; member: number };
        // Another member of the same app: verified, but nothing for this connection.
        if (body.member !== (deps as { client?: { member?: number } | null }).client?.member) return [];
        return [{ type: "acme.thing_updated", connectionId: deps.connectionId, dedupeKey: `acme:${body.trace}`, data: { id: body.id } }];
      },
    },
  };
}

/** A host serving one connection, `conn1`, of member 1. */
function acmeHost(emitted: IntegrationEvent[], now: () => number = Date.now): ConnectionHookHost & { failEmits: number } {
  const preset = acmePreset(now);
  const host = {
    failEmits: 0,
    webhookTarget: (id: string) =>
      id === "conn1"
        ? {
            preset,
            clientSecret: SECRET,
            client: { client_id: "acme-id", client_secret: SECRET, member: 1 },
            deps: { connectionId: id, fetch: globalThis.fetch, log: silent, accessToken: async () => "unused" },
          }
        : null,
    emit: (events: IntegrationEvent[]) => {
      if (host.failEmits > 0) {
        host.failEmits--;
        throw new Error("outbox unavailable");
      }
      emitted.push(...events);
    },
  };
  return host;
}

describe("POST /hooks/connections/:id", () => {
  let ctx: AppContext;
  let dispose: () => Promise<void>;
  let emitted: IntegrationEvent[];
  let host: ReturnType<typeof acmeHost>;

  beforeEach(() => {
    ({ ctx, dispose } = testContext());
    emitted = [];
    host = acmeHost(emitted);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await dispose();
  });

  it("verifies, emits and answers 204, outside admin auth and CSRF; a retry isn't emitted twice", async () => {
    const app = createApp(ctx, { connectionHooks: host });
    const msg = webhook({ id: "thing-1", trace: "trace-1" });
    expect((await post(app, "/hooks/connections/conn1", msg)).status).toBe(204);
    expect(emitted).toEqual([{ type: "acme.thing_updated", connectionId: "conn1", dedupeKey: "acme:trace-1", data: { id: "thing-1" } }]);
    expect((await post(app, "/hooks/connections/conn1", msg)).status).toBe(204);
    expect(emitted).toHaveLength(1);
  });

  it("a failed emit answers 500 and doesn't mark the delivery, so the provider's retry is delivered", async () => {
    const app = createApp(ctx, { connectionHooks: host });
    const msg = webhook({ id: "s", trace: "trace-retry" });
    host.failEmits = 1;
    expect((await post(app, "/hooks/connections/conn1", msg)).status).toBe(500);
    expect(emitted).toEqual([]);
    expect((await post(app, "/hooks/connections/conn1", msg)).status).toBe(204);
    expect(emitted.map((e) => e.dedupeKey)).toEqual(["acme:trace-retry"]);
  });

  it("another member of the same app: acknowledged (204) but nothing emitted or marked delivered", async () => {
    const delivered: string[] = [];
    const app = createApp(ctx, { connectionHooks: { ...host, delivered: (id) => void delivered.push(id) } });
    expect((await post(app, "/hooks/connections/conn1", webhook({ id: "theirs", trace: "t-other", member: 777 }))).status).toBe(204);
    expect(emitted).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it("401 on a bad signature or a stale timestamp; nothing emitted", async () => {
    const app = createApp(ctx, { connectionHooks: host });
    expect((await post(app, "/hooks/connections/conn1", webhook({ id: "a", trace: "t" }, { secret: "forged" }))).status).toBe(401);
    expect((await post(app, "/hooks/connections/conn1", webhook({ id: "a", trace: "t" }, { timestamp: Date.now() - 3 * 3_600_000 }))).status).toBe(401);
    expect(emitted).toEqual([]);
  });

  it("404 for an unknown connection or without a host", async () => {
    const msg = webhook({ id: "a", trace: "t" });
    expect((await post(createApp(ctx, { connectionHooks: host }), "/hooks/connections/other", msg)).status).toBe(404);
    expect((await post(createApp(ctx), "/hooks/connections/conn1", msg)).status).toBe(404);
    expect(emitted).toEqual([]);
  });

  it("refuses bodies over 16 KB", async () => {
    const app = createApp(ctx, { connectionHooks: host });
    const res = await app.request("/hooks/connections/conn1", { method: "POST", body: "x".repeat(17 * 1024), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(413);
    expect(emitted).toEqual([]);
  });

  it("/hooks/connections/<preset id>: the signature picks the connection, and marks it delivered", async () => {
    const delivered: string[] = [];
    const conn1 = host.webhookTarget("conn1")!;
    const conn2 = { ...conn1, clientSecret: "another-apps-secret", deps: { ...conn1.deps, connectionId: "conn2" } };
    const app = createApp(ctx, {
      connectionHooks: { ...host, presetWebhookTargets: (id) => (id === "acme" ? [conn2, conn1] : []), delivered: (id) => void delivered.push(id) },
    });
    const msg = webhook({ id: "thing", trace: "trace-p" });
    expect((await post(app, "/hooks/connections/acme", msg)).status).toBe(204);
    expect(emitted).toEqual([expect.objectContaining({ connectionId: "conn1", dedupeKey: "acme:trace-p" })]);
    expect(delivered).toEqual(["conn1"]);
    expect((await post(app, "/hooks/connections/acme", webhook({ id: "a", trace: "t" }, { secret: "forged" }))).status).toBe(401);
    expect((await post(app, "/hooks/connections/notion", msg)).status).toBe(404);
    expect(delivered).toEqual(["conn1"]);
  });

  it("Funnel traffic on another host:port than the public URL's only reaches the hooks", async () => {
    ctx.settings.update({ publicUrl: "https://box.tail1234.ts.net" });
    const app = createApp(ctx, { connectionHooks: host });
    const funnel = { "tailscale-funnel-request": "?1", host: "box.tail1234.ts.net:8443" };
    for (const path of ["/", "/api/system", "/mcp", "/agent/v1/events", "/hooks/connections"]) {
      const res = await app.request(path, { headers: funnel });
      expect(res.status, path).toBe(404);
    }
    const msg = webhook({ id: "f", trace: "trace-f" });
    expect((await post(app, "/hooks/connections/conn1", { ...msg, headers: { ...msg.headers, ...funnel } })).status).toBe(204);
    // The owner funnelled the console itself (the public URL's host): not fenced.
    expect((await app.request("/api/system", { headers: { "tailscale-funnel-request": "?1", host: "box.tail1234.ts.net" } })).status).toBe(401);
    expect((await app.request("/api/system", { headers: { "tailscale-funnel-request": "?1", host: "BOX.tail1234.ts.net:443" } })).status).toBe(401); // default port
    ctx.settings.update({ publicUrl: "https://box.tail1234.ts.net:443" });
    expect((await app.request("/api/system", { headers: { "tailscale-funnel-request": "?1", host: "box.tail1234.ts.net" } })).status).toBe(401);
  });

  it("builds the webhook URL from the public URL", () => {
    expect(connectionHookUrl("https://inbox.example.com/", "conn1")).toBe("https://inbox.example.com/hooks/connections/conn1");
  });
});

describe("hook route dedupe memory", () => {
  it("is per connection and expires after its TTL (longer than a 2 h signature window)", async () => {
    let t = Date.parse("2026-10-16T12:00:00Z");
    const now = () => t;
    const emitted: IntegrationEvent[] = [];
    const host = acmeHost(emitted, now);
    const routes = connectionHookRoutes({ host: () => host, log: createLogger("test"), now });
    expect(HOOK_DEDUPE_TTL_MS).toBeGreaterThan(TOLERANCE_MS);

    expect((await post(routes, "/hooks/connections/conn1", webhook({ id: "a", trace: "z" }, { timestamp: t }))).status).toBe(204);
    t += 90 * 60_000; // a late retry, still inside the signature window
    expect((await post(routes, "/hooks/connections/conn1", webhook({ id: "a", trace: "z" }, { timestamp: t }))).status).toBe(204);
    expect(emitted).toHaveLength(1);
    t += HOOK_DEDUPE_TTL_MS;
    expect((await post(routes, "/hooks/connections/conn1", webhook({ id: "a", trace: "z" }, { timestamp: t }))).status).toBe(204);
    expect(emitted).toHaveLength(2);
  });
});
