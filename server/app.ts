import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ApiError } from "../shared/types.ts";
import { agentApiRoutes } from "./agentapi/index.ts";
import { bearer } from "./agentapi/auth.ts";
import { CALENDAR_PUSH_PATH } from "./calendar/push.ts";
import { CONNECTION_HOOK_BODY_LIMIT, CONNECTION_HOOKS_PREFIX, type ConnectionHookHost, brokerUpstreamsOn, connectionHookRoutes } from "./integrations/hooks.ts";
import { accountsApi } from "./api/accounts.ts";
import { agentsApi } from "./api/agents.ts";
import { connectionsApi } from "./api/connections.ts";
import { approvalsApi } from "./api/approvals.ts";
import { smokeApi } from "./api/smoke.ts";
import { auditApi } from "./api/audit.ts";
import { authApi, authPublicApi } from "./api/auth.ts";
import { brokerApprovalsApi } from "./api/broker-approvals.ts";
import { eventsApi } from "./api/events.ts";
import { extensionsApi } from "./api/extensions.ts";
import { googleApi } from "./api/google.ts";
import { oauthRoutes } from "./api/oauth.ts";
import { connectionOAuthRoutes } from "./broker/upstream/callback.ts";
import { overviewApi } from "./api/overview.ts";
import { pairingsApi } from "./api/pairings.ts";
import { settingsApi } from "./api/settings.ts";
import { setupApi, setupPublicApi } from "./api/setup.ts";
import { healthRoutes, systemApi } from "./api/system.ts";
import type { AppEnv } from "./api/util.ts";
import { webhooksApi } from "./api/webhooks.ts";
import { csrfGuard, currentSetupToken, requireAdmin } from "./auth/index.ts";
import type { AppContext } from "./context.ts";
import { contentSecurityPolicy, inlineScriptHashes } from "./csp.ts";
import { MCP_AGENT_BODY_LIMIT, mcpRoutes } from "./mcp/index.ts";
import { renderSkill } from "./skill/index.ts";
import { HttpError, PolicyDenied } from "./util/errors.ts";

export interface AppOptions {
  /** Built console directory. Defaults to dist/web next to the running module. */
  webDir?: string;
  /** Inbound webhooks for native presets (POST /hooks/connections/:id); 404 without it or with brokerUpstreams off. */
  connectionHooks?: ConnectionHookHost;
}

/**
 * dist/web relative to the running module: the bundle (dist/cli.js) and source runs
 * (server/app.ts via tsx) both resolve to <package root>/dist/web.
 */
export const DEFAULT_WEB_DIR = resolve(import.meta.dirname, "..", "dist", "web");

const API_BODY_LIMIT = 1024 * 1024;
const AUTH_BODY_LIMIT = 16 * 1024;
const AUTH_PATHS = ["/api/setup/claim", "/api/setup/verify-token", "/api/auth/login", "/api/auth/password"];
/** /mcp without a valid agent key; with one, MCP_AGENT_BODY_LIMIT (server/mcp/index.ts). */
const MCP_BODY_LIMIT = 4 * 1024 * 1024;
const AGENT_BODY_LIMIT = 64 * 1024;
/** Calendar push notifications have no body. */
const PUSH_BODY_LIMIT = 4 * 1024;

/** Extensions served as files; any other path (even with a dot, e.g. /accounts/me@example.com) is a console route. */
const ASSET_EXTENSIONS = new Set([
  ".js", ".mjs", ".css", ".map", ".json", ".webmanifest", ".txt", ".xml",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".wasm",
]);

/** Paths the console's index.html fallback must never answer. */
const SERVER_PREFIXES = ["/api", "/agent", "/mcp", "/oauth", "/google", "/hooks", "/skill.md", "/health"];
const isServerPath = (path: string) => SERVER_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));

const withMcp = new WeakSet<object>();

/** Whether the MCP endpoint is implemented (the placeholder router has no routes). */
export const hasMcp = (app: object): boolean => withMcp.has(app);

export function createApp(ctx: AppContext, opts: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Make sure the setup link exists before anyone needs it.
  currentSetupToken(ctx);

  // Hashes of index.html's inline scripts; set once the console is wired up below.
  let consoleHashes: () => string[] = () => [];
  app.use("*", async (c, next) => {
    await next();
    try {
      c.res.headers.set("Content-Security-Policy", contentSecurityPolicy(consoleHashes()));
      c.res.headers.set("X-Frame-Options", "DENY");
      c.res.headers.set("X-Content-Type-Options", "nosniff");
      c.res.headers.set("Referrer-Policy", "no-referrer");
    } catch {
      // Immutable headers (a proxied Response): leave them as they are.
    }
  });

  app.onError((err, c) => errorResponse(ctx, err, c));
  app.notFound((c) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return apiError(c, 404, "not_found", "No such API route");
    return c.text("Not found", 404);
  });

  // The WHOOP setup's optional Tailscale Funnel exposes only the hooks path on its own port. The real fence is
  // tailscaled's mount: it serves nothing else on that port (server/broker/reachability.ts). This is only a backstop,
  // and a weak one, since the Host it compares is whatever the client sent: tailscaled marks Funnel traffic with
  // Tailscale-Funnel-Request (and drops a client-sent one), and Funnel traffic for any host:port but the public URL's
  // (whose owner chose to funnel the console) only reaches the hooks.
  const bareHost = (h: string) => h.toLowerCase().replace(/:(443|80)$/, "");
  app.use("*", async (c, next) => {
    if (c.req.header("tailscale-funnel-request") && !c.req.path.startsWith(`${CONNECTION_HOOKS_PREFIX}/`)) {
      let publicHost: string | null = null;
      try {
        publicHost = bareHost(new URL(ctx.settings.publicUrl()).host);
      } catch {
        // No usable public URL: nothing is the funnelled console.
      }
      if (bareHost(c.req.header("host") ?? "") !== publicHost) return c.text("Not found", 404);
    }
    await next();
  });

  // ── Public ──
  // The rest of the body is never read, so the connection can't be reused: say so, or a keep-alive client
  // sends its next request on a socket that is about to close.
  const tooLarge = (c: Context) => {
    c.header("Connection", "close");
    return apiError(c, 413, "payload_too_large", "Request body is too large");
  };
  const limit = (maxSize: number) => bodyLimit({ maxSize, onError: tooLarge });
  for (const path of AUTH_PATHS) app.use(path, limit(AUTH_BODY_LIMIT));
  app.use("/api/*", limit(API_BODY_LIMIT));
  // Large bodies only for a valid agent key: anyone else is cut off at 4 MB before more is buffered.
  const mcpLimit = limit(MCP_BODY_LIMIT);
  const mcpAgentLimit = limit(MCP_AGENT_BODY_LIMIT);
  // ("/mcp/*" also matches /mcp itself.)
  app.use("/mcp/*", (c, next) => {
    const key = c.req.path === "/mcp" ? bearer(c.req.header("authorization")) : null;
    return (key && ctx.policy.authenticate(key) ? mcpAgentLimit : mcpLimit)(c, next);
  });
  app.use("/agent/*", limit(AGENT_BODY_LIMIT));
  app.use(CALENDAR_PUSH_PATH, limit(PUSH_BODY_LIMIT));
  app.use(`${CONNECTION_HOOKS_PREFIX}/*`, limit(CONNECTION_HOOK_BODY_LIMIT));
  app.use("/api/*", csrfGuard());
  app.route("/", healthRoutes(ctx));
  app.route("/api", setupPublicApi(ctx));
  app.route("/api", authPublicApi(ctx));
  app.get("/skill.md", (c) => {
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    return c.body(renderSkill(ctx.settings.publicUrl()));
  });
  app.route("/", oauthRoutes(ctx));
  // Upstream connections' sign-ins (MCP broker); 404 while the brokerUpstreams setting is off.
  app.route("/", connectionOAuthRoutes(ctx));
  // Google-facing: verified by channel id + X-Goog-Channel-Token, outside the admin session and CSRF guard.
  app.post(CALENDAR_PUSH_PATH, (c) => c.body(null, ctx.calendar.handlePush(c.req.raw.headers) as 204));
  // Provider-facing (WHOOP): verified by the preset's signature check, outside the admin session and CSRF guard.
  app.route("/", connectionHookRoutes({ enabled: () => brokerUpstreamsOn(ctx.settings), host: () => opts.connectionHooks ?? ctx.broker.hooks, log: ctx.log }));
  const mcp = mcpRoutes(ctx);
  if (mcp.routes.length) withMcp.add(app);
  app.route("/", mcp);
  // Bearer/public JSON: outside the /api cookie session and CSRF guard.
  app.route("/", agentApiRoutes(ctx));

  // ── Admin console API ──
  app.use("/api/*", requireAdmin(ctx));
  // brokerApprovalsApi before approvalsApi: it answers /approvals/:id for mcp.call and passes the rest on.
  // connectionsApi before brokerApprovalsApi: its /connections/:id/kill runs the service's kill (hooks first).
  for (const api of [setupApi, authApi, settingsApi, systemApi, googleApi, accountsApi, agentsApi, connectionsApi, brokerApprovalsApi, approvalsApi, webhooksApi, eventsApi, auditApi, overviewApi, pairingsApi, extensionsApi, smokeApi]) {
    app.route("/api", api(ctx));
  }

  // ── Console ──
  if (ctx.config.dev) app.get("*", (c) => (isServerPath(c.req.path) ? c.notFound() : devPage(c)));
  else consoleHashes = serveConsole(app, opts.webDir ?? DEFAULT_WEB_DIR);

  return app;
}

/** Serves the built console; returns the CSP hashes of index.html's inline scripts (re-read when the file changes). */
function serveConsole(app: Hono<AppEnv>, webDir: string): () => string[] {
  const index = join(webDir, "index.html");
  if (!existsSync(index)) {
    app.get("*", (c) => (isServerPath(c.req.path) ? c.notFound() : missingBuildPage(c, webDir)));
    return () => [];
  }
  let cached = { mtimeMs: -1, hashes: [] as string[] };
  const hashes = () => {
    try {
      const { mtimeMs } = statSync(index);
      if (mtimeMs !== cached.mtimeMs) cached = { mtimeMs, hashes: inlineScriptHashes(readFileSync(index, "utf8")) };
    } catch {
      // Removed while running: keep the last known hashes.
    }
    return cached.hashes;
  };
  const assets = serveStatic<AppEnv>({ root: webDir });
  const assetsDir = join(webDir, "assets") + sep;
  app.use("*", async (c, next) => {
    if (isServerPath(c.req.path)) return next();
    const res = await assets(c, next);
    if (res instanceof Response) {
      // Vite fingerprints everything under assets/; the rest (index.html, favicon) must revalidate.
      const hashed = join(webDir, c.req.path).startsWith(assetsDir);
      res.headers.set("Cache-Control", hashed ? "public, max-age=31536000, immutable" : "no-cache");
    }
    return res;
  });
  app.get("*", (c) => {
    const path = c.req.path;
    // Client routes get index.html; a missing file (e.g. a stale /assets/x.js) is a real 404.
    if (isServerPath(path) || path.startsWith("/assets/") || ASSET_EXTENSIONS.has(extname(path).toLowerCase())) return c.notFound();
    c.header("Cache-Control", "no-cache");
    return c.html(readFileSync(index, "utf8"));
  });
  return hashes;
}

function errorResponse(ctx: AppContext, err: Error, c: Context): Response {
  if (err instanceof HttpError) return c.json(err.toJSON(), err.status as 400);
  if (err instanceof PolicyDenied) return apiError(c, 403, "policy_denied", err.message);
  if (err instanceof z.ZodError) return apiError(c, 400, "bad_request", z.prettifyError(err));
  if (err instanceof HTTPException) return err.res ? err.getResponse() : apiError(c, err.status, "http_error", err.message || "Request failed");
  if (err instanceof SyntaxError && /JSON/i.test(err.message)) return apiError(c, 400, "bad_request", "Request body must be valid JSON");
  ctx.log.error(`${c.req.method} ${c.req.path} failed`, { error: err.message, stack: err.stack });
  return apiError(c, 500, "internal", "Something went wrong. Check the xaq logs for details.");
}

function apiError(c: Context, status: number, code: string, message: string): Response {
  return c.json<ApiError>({ error: { code, message } }, status as 400);
}

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 2rem; line-height: 1.55; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  code { font-family: ui-monospace, monospace; padding: .1rem .35rem; border-radius: .3rem; background: color-mix(in srgb, CanvasText 10%, transparent); }
  p { margin: .5rem 0; opacity: .85; }
</style></head><body><main>${body}</main></body></html>`;

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

function missingBuildPage(c: Context, webDir: string): Response {
  c.header("Cache-Control", "no-store");
  return c.html(
    page(
      "xaq: console not built",
      `<h1>The web console hasn't been built</h1>
<p>xaq is running, but there is no console build in <code>${escapeHtml(webDir)}</code>.</p>
<p>From a source checkout, run <code>pnpm build</code> and restart, or use <code>pnpm dev</code> for development.</p>
<p>The API (<code>/api</code>), MCP endpoint (<code>/mcp</code>) and <code>/health</code> work as usual.</p>`,
    ),
    503,
  );
}

function devPage(c: Context): Response {
  const url = new URL(c.req.url);
  const target = `http://localhost:5173${url.pathname}${url.search}`;
  return c.html(
    page(
      "xaq (dev)",
      `<h1>xaq is running in dev mode</h1>
<p>The console is served by Vite: open <a href="${escapeHtml(target)}">${escapeHtml(target)}</a>.</p>`,
    ),
  );
}
