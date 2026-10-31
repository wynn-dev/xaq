import type { Hono } from "hono";
import type { AppEnv } from "../server/api/util.ts";
import { type AppOptions, createApp } from "../server/app.ts";
import { readSetupToken } from "../server/auth/setup-token.ts";
import type { GoogleService } from "../server/google/types.ts";
import type { IngestService } from "../server/ingest/types.ts";
import type { ServiceOverrides } from "../server/wire.ts";
import type { IngestStatus, PubsubState } from "../shared/types.ts";
import { testContext } from "./helpers.ts";

export const CSRF = { "x-xaq-csrf": "1" };
export const PASSWORD = "correct horse battery";

/** Minimal google fake: only what the platform routes read. */
export function fakeGoogle(view: { clientId?: string | null; hasSecret?: boolean; projectId?: string | null } = {}): () => GoogleService {
  const pubsub: PubsubState = { mode: "poll", topic: null, subscription: null, lastError: null, lastMessageAt: null, principalAccountId: null, principalEmail: null, pendingPrincipalAccountId: null, pendingPrincipalEmail: null };
  return () =>
    ({
      clientView: () => ({
        clientId: view.clientId ?? null,
        hasSecret: view.hasSecret ?? false,
        projectId: view.projectId ?? null,
        appType: view.clientId ? "external" : null,
        redirectUri: "http://localhost:8425/oauth/callback",
        callbackMode: "direct",
      }),
      pubsubState: () => pubsub,
    }) as unknown as GoogleService;
}

export function fakeIngest(status: Partial<IngestStatus> = {}): () => IngestService {
  return () => ({ status: () => ({ mode: "poll", running: true, lastPullAt: null, lastError: null, ...status }) }) as unknown as IngestService;
}

export interface Harness {
  app: Hono<AppEnv>;
  ctx: ReturnType<typeof testContext>["ctx"];
  dispose: () => Promise<void>;
  /** `peer` is the socket address the request comes from (default loopback, like a local reverse proxy). */
  request: (path: string, init?: RequestInit & { cookie?: string; json?: unknown; peer?: string }) => Promise<Response>;
  setupToken: () => string | null;
  /** Claims the instance and returns the session cookie ("aib_session=…"). */
  claim: () => Promise<string>;
}

export function harness(overrides: ServiceOverrides = {}, opts: AppOptions = {}): Harness {
  const t = testContext({ google: fakeGoogle(), ingest: fakeIngest(), ...overrides });
  const app = createApp(t.ctx, opts);
  const request: Harness["request"] = (path, init = {}) => {
    const { cookie, json, peer = "127.0.0.1", ...rest } = init;
    const headers = new Headers(rest.headers);
    if (cookie) headers.set("cookie", cookie);
    if (json !== undefined) headers.set("content-type", "application/json");
    const bindings = { incoming: { socket: { remoteAddress: peer } } };
    return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }, bindings));
  };
  const setupToken = () => readSetupToken(t.ctx.config.dataDir);
  return {
    app,
    ctx: t.ctx,
    dispose: t.dispose,
    request,
    setupToken,
    async claim() {
      const res = await request("/api/setup/claim", { method: "POST", headers: CSRF, json: { token: setupToken(), password: PASSWORD } });
      if (res.status !== 204) throw new Error(`claim failed: ${res.status} ${await res.text()}`);
      return sessionCookie(res)!;
    },
  };
}

/** Response JSON, loosely typed for assertions. */
// oxlint-disable-next-line typescript/no-explicit-any
export const json = (res: Response): Promise<any> => res.json();

export function sessionCookie(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  return raw ? raw.split(";")[0]! : null;
}
