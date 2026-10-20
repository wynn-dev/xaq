// /api/connections: the MCP broker's connections admin API (docs/MCP-BROKER.md, routes in shared/types.ts).
// Console session + CSRF like every /api router (server/app.ts). 404 while Settings.brokerUpstreams is off.
// Credentials never cross this boundary: a static header goes in through /connect and is never returned.

import { z } from "zod";
import {
  ACCESS_LEVELS,
  type AccessLevel,
  CONNECTION_KINDS,
  CONNECTION_SLUG_RE,
  type Connection,
  type ConnectionAuthType,
  type ConnectionGrant,
  type ConnectionKind,
  type ConnectionView,
  type GoogleApiCheckView,
  type PresetView,
  type StartConnectResult,
} from "../../shared/types.ts";
import { checkGoogleApis, googleSetupContext, isGooglePreset } from "../extensions/google-auth.ts";
import { extensionConsentConnection } from "../google/oauth.ts";
import { exposedName } from "../broker/catalog/index.ts";
import { connectionView, getConnection, listConnections, notifyAgent } from "../broker/service.ts";
import { Approvals } from "../mail/approvals.ts";
import { connectionHookUrl } from "../integrations/hooks.ts";
import type { WebhookReachability } from "../broker/reachability.ts";
import { presetServerSlug, presetServerUrl } from "../integrations/user-server.ts";
import type { IntegrationPreset, PresetAuth } from "../broker/types.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { canonicalPrivateTarget, originKey, PrivateTargetError, validateUpstreamUrl } from "../broker/upstream/fetch.ts";
import { badRequest, conflict, errorMessage, HttpError, notFound } from "../util/errors.ts";
import { newId, randomToken } from "../util/ids.ts";
import { ADMIN_ACTOR, readBody, router } from "./util.ts";

/** A preset that takes no webhooks: no webhook step, no Funnel offer, no reachability check. */
const NO_WEBHOOKS: WebhookReachability = { reach: "unknown", webhookBase: null, funnel: null, reason: "no preset takes webhooks" };

/** The upstream runtime's URL rule (http(s), no userinfo): the same check the connect flow applies. */
const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .superRefine((u, issues) => {
    try {
      validateUpstreamUrl(u);
    } catch (err) {
      issues.addIssue({ code: "custom", message: errorMessage(err) });
    }
  });
const slug = z.string().trim().regex(CONNECTION_SLUG_RE, "Slug must be 1-24 lowercase letters, digits or dashes");
const name = z.string().trim().min(1, "Name is required").max(100, "Name must be at most 100 characters");
const level = z.enum(ACCESS_LEVELS);

const createSchema = z
  .object({
    preset: z.string().min(1).max(64).optional(),
    url: httpUrl.optional(),
    name: name.optional(),
    slug: slug.optional(),
    levelDefault: level.optional(),
    agentIds: z.array(z.string().min(1)).max(1000).optional(),
  })
  .strict();

const patchSchema = z
  .object({ name: name.optional(), slug: slug.optional(), url: httpUrl.optional(), levelDefault: level.optional(), allAgents: z.boolean().optional() })
  .strict();
const grantsSchema = z.object({ grants: z.array(z.object({ agentId: z.string().min(1), level })).max(1000) }).strict();
const privateTargetSchema = z.object({ allow: z.boolean() }).strict();
const probeSchema = z.object({ url: httpUrl, connectionId: z.string().optional() }).strict();
const finishSchema = z.object({ url: z.string().trim().min(1).max(8192) }).strict();
const googleApisSchema = z.object({ account: z.string().trim().min(1).max(320) }).strict();
const connectSchema = z
  .object({
    // Surrounding whitespace is never part of a header value (HTTP strips it); a line break would split the header.
    header: z
      .object({
        name: z.string().trim().regex(/^[A-Za-z0-9-]{1,100}$/, "Header name must be letters, digits or dashes"),
        value: z.string().trim().min(1).max(8192).regex(/^[^\r\n\0]*$/, "The header value can't contain a line break"),
      })
      .strict()
      .optional(),
    inputs: z.record(z.string().max(100), z.string().max(8192)).optional(),
  })
  .strict();

/** A Google extension's auth reads "oauth": its access is an OAuth grant on the bound account. */
const authTypeOf = (a: PresetAuth): ConnectionAuthType => (a.type === "none" ? "none" : a.type === "header" ? "header" : "oauth");

/**
 * The canonical private-target allow for a connection URL (`scheme://host:port`, explicit port), by the upstream
 * guard's own rule (canonicalPrivateTarget); 400 when the host can't be allowed (e.g. an IPv6 literal).
 */
export function exactOrigin(url: string): string {
  try {
    return canonicalPrivateTarget(originKey(url));
  } catch (err) {
    throw badRequest(err instanceof PrivateTargetError ? err.message : "That URL can't be allowed", "Use a hostname or an IPv4 address.");
  }
}

/** Names are unique per owner (case-insensitive). NULL owner = the install's single owner. */
const nameTaken = (ctx: AppContext, name: string, ownerId: string | null, exceptId: string | null = null): boolean =>
  !!ctx.db.get("SELECT 1 FROM connections WHERE lower(name) = lower(?) AND owner_id IS ? AND id IS NOT ?", name, ownerId, exceptId);

/** A free default name: `base`, else `base (2)`, `base (3)`… */
function freeName(ctx: AppContext, base: string, ownerId: string | null): string {
  if (!nameTaken(ctx, base, ownerId)) return base;
  for (let i = 2; ; i++) if (!nameTaken(ctx, `${base} (${i})`, ownerId)) return `${base} (${i})`;
}

/** A free slug from a host or preset slug: lowercase, dashes, at most 24, suffixed -2, -3… on collision. */
function freeSlug(ctx: AppContext, base: string): string {
  const root = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "") || "mcp";
  const taken = (s: string) => !!ctx.db.get("SELECT 1 FROM connections WHERE slug = ?", s);
  if (!taken(root)) return root;
  for (let i = 2; ; i++) if (!taken(`${root}-${i}`)) return `${root}-${i}`;
}

export function connectionsApi(ctx: AppContext) {
  const app = router();
  const approvals = new Approvals(ctx);
  const audit = (action: string, target: string, detail: Record<string, unknown> | null = null) =>
    ctx.audit.record({ ...ADMIN_ACTOR, action, target, outcome: "ok", detail });

  // Everything here is the unreleased broker: invisible until the setting is on.
  const gate = async (_c: unknown, next: () => Promise<void>) => {
    if (!ctx.broker.enabled()) throw new HttpError(404, "not_found", "No such API route");
    await next();
  };
  app.use("/connections", gate);
  app.use("/connections/*", gate);

  const requireConnection = (id: string): Connection => {
    const c = getConnection(ctx, id);
    if (!c) throw notFound("Connection");
    return c;
  };
  const view = (id: string): ConnectionView => connectionView(ctx, requireConnection(id), Date.now(), ctx.broker.presets());
  /** The connection a pasted Google callback address is for (a pending extension consent's state), or null. */
  const googleConsentFor = (raw: string): string | null => {
    try {
      const text = raw.trim();
      const u = new URL(text.startsWith("?") ? `http://localhost/oauth/callback${text}` : text);
      const id = extensionConsentConnection(ctx, u.searchParams.get("state") ?? "");
      return id && getConnection(ctx, id) ? id : null;
    } catch {
      return null;
    }
  };
  const grantsOf = (connectionId: string): ConnectionGrant[] =>
    ctx.db
      .all<{ agent_id: string; level: AccessLevel; created_at: string; updated_at: string }>(
        "SELECT agent_id, level, created_at, updated_at FROM connection_grants WHERE connection_id = ? ORDER BY created_at, agent_id",
        connectionId,
      )
      .map((r) => ({ agentId: r.agent_id, connectionId, level: r.level, createdAt: r.created_at, updatedAt: r.updated_at }));
  const requireAgents = (ids: string[]) => {
    const missing = ids.filter((id) => !ctx.db.get("SELECT 1 FROM agents WHERE id = ?", id));
    if (missing.length) throw badRequest(`Unknown agent ${missing.join(", ")}`);
  };
  const presetView = (p: IntegrationPreset, reach: WebhookReachability): PresetView => {
    const publicUrl = ctx.settings.publicUrl();
    const steps = p.setupSteps({
      // A Google extension's steps name the project, the app type and the connected accounts (google-setup.ts).
      google: isGooglePreset(p) ? googleSetupContext(ctx) : null,
      publicUrl,
      redirectUri: `${publicUrl}/oauth/connections/callback`,
      // The preset's URL (POST /hooks/connections/<preset id>): no connection exists yet while choosing a preset, and
      // the route finds the connection by its signature. Only when the internet can reach it.
      webhookUrl: reach.webhookBase ? connectionHookUrl(reach.webhookBase, p.id) : null,
      funnel: reach.funnel
        ? { port: reach.funnel.port, command: reach.funnel.command, offCommand: reach.funnel.offCommand, webhookUrl: connectionHookUrl(reach.funnel.origin, p.id) }
        : null,
    });
    return {
      id: p.id,
      displayName: p.displayName,
      slug: p.slug,
      kind: p.kind,
      url: p.url ?? null,
      authType: authTypeOf(p.auth),
      setupSteps: steps.map((s) => ({ ...s })),
      reconnectPolicy: p.reconnectPolicy ?? null,
      official: p.official !== false,
      userServer: p.userServer ? { defaultPath: p.userServer.defaultPath } : null,
    };
  };

  app.get("/connections", (c) => {
    const presets = ctx.broker.presets();
    return c.json<ConnectionView[]>(listConnections(ctx).map((x) => connectionView(ctx, x, Date.now(), presets)));
  });

  app.get("/connections/presets", async (c) => {
    const presets = ctx.broker.presets();
    // The reachability check (DNS, the Tailscale CLI) only for a preset that takes webhooks: none does today.
    const reach: WebhookReachability = presets.some((p) => p.events?.handleWebhook) ? await ctx.broker.webhookReachability() : NO_WEBHOOKS;
    return c.json<PresetView[]>(presets.map((p) => presetView(p, p.events?.handleWebhook ? reach : NO_WEBHOOKS)));
  });

  // A Google extension's "Check again": is each of its APIs on in the project, checked as the picked account. The probe
  // token is downscoped (the extension's granted scopes, or only identity before consent): never the account's own.
  app.post("/connections/presets/:id/google-apis", async (c) => {
    const preset = ctx.broker.presets().find((p) => p.id === c.req.param("id"));
    if (!isGooglePreset(preset)) throw notFound("Google extension");
    const { account } = await readBody(c, googleApisSchema);
    return c.json<GoogleApiCheckView[]>(await checkGoogleApis(ctx, preset, account));
  });

  app.post("/connections/probe", async (c) => {
    const body = await readBody(c, probeSchema);
    const conn = body.connectionId ? requireConnection(body.connectionId) : null;
    // The allow only covers the exact origin it was granted for (the guard re-checks it too).
    const privateTarget = conn?.privateTarget && conn.url && originKey(conn.url) === originKey(body.url) ? conn.privateTarget : null;
    return c.json(await ctx.broker.connector.probe({ url: body.url, privateTarget }, c.req.raw.signal));
  });

  app.post("/connections", async (c) => {
    const body = await readBody(c, createSchema);
    const preset = body.preset ? (ctx.broker.presets().find((p) => p.id === body.preset) ?? null) : null;
    if (body.preset && !preset) throw badRequest(`The ${body.preset} integration isn't available in this version`);
    // A preset whose server the user names (T3 Code): one connection per server, at the URL given.
    const userServer = preset?.userServer ?? null;
    if (userServer && !body.url) throw badRequest(`Enter the address of your ${preset!.displayName} server`, "For example http://100.101.102.103:3773 on Tailscale.");
    const url = userServer ? presetServerUrl(body.url!, userServer.defaultPath) : (preset?.url ?? body.url ?? null);
    if (!preset && !url) throw badRequest("Pass a url, or a preset");
    // A code extension's connection runs a stdio child (server/extensions/host). Connections from before extensions
    // keep their `native_whoop` kind; the broker treats every non-remote kind alike.
    const kind: ConnectionKind = preset?.kind === "native" ? "stdio" : "remote_http";
    if (!(CONNECTION_KINDS as readonly string[]).includes(kind)) throw badRequest(`The ${preset!.id} integration isn't available in this version`);
    if (kind === "remote_http" && !url) throw badRequest("This integration has no URL");
    const slugBase = userServer ? presetServerSlug(preset!.slug, url!) : (preset?.slug ?? new URL(url!).hostname.split(".").find((p) => p !== "mcp" && p !== "www") ?? "mcp");
    const chosenSlug = body.slug ?? freeSlug(ctx, slugBase);
    if (ctx.db.get("SELECT 1 FROM connections WHERE slug = ?", chosenSlug)) throw conflict(`The slug ${chosenSlug} is taken`, "Pick another: tools are named <slug>__<tool>.");
    // Names are unique per owner (the single owner today): a default one gets " (2)", a chosen one that's taken is refused.
    const ownerId: string | null = null;
    if (body.name !== undefined && nameTaken(ctx, body.name, ownerId)) throw conflict(`You already have a connection named ${body.name}`, "Give this one another name.");
    const chosenName = body.name ?? freeName(ctx, userServer ? new URL(url!).host : (preset?.displayName ?? new URL(url!).hostname), ownerId);
    const agentIds = body.agentIds ?? ctx.db.all<{ id: string }>("SELECT id FROM agents ORDER BY created_at").map((a) => a.id);
    requireAgents(agentIds);
    const levelDefault = body.levelDefault ?? "ask";
    const id = newId("con");
    const t = now();
    // A Google extension's connection has no access until an account is picked and allowed (Connect does both).
    const pending = isGooglePreset(preset) ? `Pick the Google account ${preset.displayName} works as, and allow its access: Connect.` : null;
    ctx.db.tx(() => {
      ctx.db.run(
        `INSERT INTO connections (id, kind, preset, slug, name, url, auth_type, level_default, all_agents, status, status_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        kind,
        preset?.id ?? null,
        chosenSlug,
        chosenName,
        url,
        preset ? authTypeOf(preset.auth) : "none",
        levelDefault,
        // "All agents" (no agentIds): agents created later get it too (policy.createAgent).
        body.agentIds === undefined ? 1 : null,
        pending ? "needs_reauth" : "active",
        pending,
        t,
        t,
      );
      for (const agentId of new Set(agentIds)) {
        ctx.db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", agentId, id, levelDefault, t, t);
      }
    });
    ctx.broker.invalidate("all");
    ctx.broker.attach(id);
    audit("connection.create", id, { slug: chosenSlug, preset: preset?.id ?? null, agents: agentIds.length, level: levelDefault });
    for (const agentId of new Set(agentIds)) notifyAgent(ctx, agentId);
    return c.json<ConnectionView>(view(id), 201);
  });

  app.get("/connections/:id", (c) => c.json<ConnectionView>(view(c.req.param("id"))));

  app.patch("/connections/:id", async (c) => {
    const id = c.req.param("id");
    const before = requireConnection(id);
    const body = await readBody(c, patchSchema);
    const changed: string[] = [];
    const granted: string[] = [];
    let credentialsCleared = false;
    let cancelled = 0;
    ctx.db.tx(() => {
      const t = now();
      if (body.name !== undefined && body.name !== before.name) {
        if (nameTaken(ctx, body.name, before.ownerId, id)) throw conflict(`You already have a connection named ${body.name}`, "Give this one another name.");
        ctx.db.run("UPDATE connections SET name = ?, updated_at = ? WHERE id = ?", body.name, t, id);
        changed.push("name");
      }
      if (body.allAgents !== undefined && body.allAgents !== before.allAgents) {
        ctx.db.run("UPDATE connections SET all_agents = ?, updated_at = ? WHERE id = ?", body.allAgents ? 1 : null, t, id);
        changed.push("allAgents");
      }
      if (body.allAgents === true && !before.allAgents) {
        // Turning "All agents" on: every agent without access gets it now (at the default level); existing
        // per-agent levels stay. Only on the off→on change, so a repeat never re-grants agents set to No access.
        const level = body.levelDefault ?? before.levelDefault;
        for (const { id: agentId } of ctx.db.all<{ id: string }>(
          "SELECT id FROM agents WHERE id NOT IN (SELECT agent_id FROM connection_grants WHERE connection_id = ?)",
          id,
        )) {
          ctx.db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", agentId, id, level, t, t);
          granted.push(agentId);
        }
      }
      if (body.levelDefault !== undefined && body.levelDefault !== before.levelDefault) {
        ctx.db.run("UPDATE connections SET level_default = ?, updated_at = ? WHERE id = ?", body.levelDefault, t, id);
        changed.push("levelDefault");
      }
      if (body.slug !== undefined && body.slug !== before.slug) {
        if (ctx.db.get("SELECT 1 FROM connections WHERE slug = ? AND id <> ?", body.slug, id)) throw conflict(`The slug ${body.slug} is taken`);
        ctx.db.run("UPDATE connections SET slug = ?, updated_at = ? WHERE id = ?", body.slug, t, id);
        // Exposed names follow the slug, by the catalog's rule (sanitised, cut to 64 with a hash suffix); the
        // registry recomputes them from the slug anyway. Approval rules keep the upstream name, so they survive.
        const tools = ctx.db.all<{ name: string }>("SELECT name FROM upstream_tools WHERE connection_id = ?", id);
        // Two passes so a rename can't collide with this connection's own old names midway.
        for (const tool of tools) ctx.db.run("UPDATE upstream_tools SET exposed_name = ? WHERE connection_id = ? AND name = ?", `x_renaming_${randomToken(20)}`, id, tool.name);
        for (const tool of tools) {
          const exposed = exposedName(body.slug, tool.name);
          if (!exposed) throw badRequest(`With the slug ${body.slug}, the tool ${tool.name.slice(0, 64)} can't be named; pick another slug`);
          try {
            ctx.db.run("UPDATE upstream_tools SET exposed_name = ? WHERE connection_id = ? AND name = ?", exposed, id, tool.name);
          } catch {
            throw conflict(`With the slug ${body.slug}, the tool name ${exposed} is already taken; pick another slug`);
          }
        }
        changed.push("slug");
      }
      if (body.url !== undefined && body.url !== before.url) {
        if (before.kind !== "remote_http" || before.preset) throw badRequest("Only custom MCP connections have an editable URL", "Add a new connection instead.");
        // A new URL is a new server: the old credentials must never be sent to it. They're deleted, the
        // connection needs reconnecting, its cached negotiation and expiry go, the private-target allow (granted
        // for the old host) goes, and pending calls (approved against the old server) are cancelled.
        ctx.db.run(
          `UPDATE connections SET url = ?, private_target = NULL, status = 'needs_reauth', status_reason = 'URL changed; reconnect',
             expires_at = NULL, protocol = NULL, protocol_checked_at = NULL, updated_at = ? WHERE id = ?`,
          body.url,
          t,
          id,
        );
        credentialsCleared = !!ctx.db.get("SELECT 1 AS x FROM connection_credentials WHERE connection_id = ?", id);
        // Sign-ins started for the old server can't complete (finishConnect also checks the origin).
        ctx.db.run("DELETE FROM oauth_states WHERE connection_id = ?", id);
        cancelled = approvals.cancelForConnection(id, null, `${before.name}'s URL changed`);
        changed.push("url");
      }
    });
    if (changed.includes("url")) {
      // The runtime's disconnect: closes the session, stops the refresher and deletes every credential.
      if (ctx.broker.connector.disconnect) await ctx.broker.connector.disconnect(id);
      else ctx.db.run("DELETE FROM connection_credentials WHERE connection_id = ?", id);
      ctx.broker.catalog.detach(id);
      await ctx.broker.reload(id);
      if (before.privateTarget) audit("connection.private_target.revoke", id, { target: before.privateTarget, why: "url_changed" });
    }
    if (changed.includes("slug") || changed.includes("url")) ctx.broker.invalidate({ connectionId: id });
    for (const agentId of granted) ctx.broker.invalidate({ agentId });
    for (const agentId of granted) notifyAgent(ctx, agentId);
    if (changed.length || granted.length) {
      audit("connection.update", id, { changed, ...(granted.length ? { granted } : {}), ...(changed.includes("url") ? { credentialsCleared, cancelled } : {}) });
    }
    return c.json<ConnectionView>(view(id));
  });

  app.delete("/connections/:id", async (c) => {
    await ctx.broker.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  // Mounted before the policy's own /connections/:id/kill (server/api/broker-approvals.ts): the service runs the
  // onKill hooks (a revoke needs the token) before the policy clears the credentials.
  app.post("/connections/:id/kill", async (c) => {
    const id = c.req.param("id");
    requireConnection(id);
    await ctx.broker.kill(id, "killed by the owner");
    return c.body(null, 204);
  });

  app.post("/connections/:id/connect", async (c) => {
    const id = c.req.param("id");
    const conn = requireConnection(id);
    const body = await readBody(c, connectSchema);
    const r = await ctx.broker.connector.startConnect(conn, body, c.req.raw.signal);
    await ctx.broker.reload(id);
    if (r.status === "connected") ctx.broker.attach(id);
    audit("connection.connect", id, { status: r.status, header: !!body.header });
    if (r.status === "connected") {
      ctx.broker.invalidate({ connectionId: id });
      return c.json<StartConnectResult>({ status: "connected", connection: view(id) });
    }
    return c.json<StartConnectResult>(r);
  });

  // Paste mode (no direct callback to this install): the landing URL the user copied after approving.
  app.post("/connections/finish", async (c) => {
    const { url } = await readBody(c, finishSchema);
    // A Google extension's consent lands on Google's own callback: the account flow finishes it, then the connection.
    const googleConnection = googleConsentFor(url);
    if (googleConnection) {
      try {
        await ctx.google.completeConnectFromUrl(url);
      } catch (err) {
        // Partly granted is still connected (what was ticked works); the view says what's missing.
        if (!(err instanceof HttpError && err.code === "oauth_extension_not_granted")) {
          return c.json<StartConnectResult>({ status: "error", message: err instanceof HttpError && err.hint ? `${err.message} ${err.hint}` : errorMessage(err) }, 400);
        }
      }
      // The consent's onDone bound the account and re-listed the tools (server/extensions/google-auth.ts).
      const v = view(googleConnection);
      if (v.status !== "active") return c.json<StartConnectResult>({ status: "error", message: v.statusReason ?? `${v.name} didn't get access.` }, 400);
      return c.json<StartConnectResult>({ status: "connected", connection: v });
    }
    const finish = ctx.broker.connector.finishFromUrl;
    if (!finish) throw new HttpError(404, "not_found", "No such API route");
    const r = await finish(url);
    if (r.status === "error") return c.json<StartConnectResult>({ status: "error", message: r.message }, 400);
    ctx.broker.invalidate({ connectionId: r.connectionId });
    ctx.broker.attach(r.connectionId);
    return c.json<StartConnectResult>({ status: "connected", connection: view(r.connectionId) });
  });

  app.get("/connections/:id/grants", (c) => {
    const id = c.req.param("id");
    requireConnection(id);
    return c.json<ConnectionGrant[]>(grantsOf(id));
  });

  app.put("/connections/:id/grants", async (c) => {
    const id = c.req.param("id");
    requireConnection(id);
    const body = await readBody(c, grantsSchema);
    const next = new Map(body.grants.map((g) => [g.agentId, g.level]));
    requireAgents([...next.keys()]);
    const before = new Map(grantsOf(id).map((g) => [g.agentId, g.level]));
    const removed = [...before.keys()].filter((a) => !next.has(a));
    const changed = [...next].filter(([a, l]) => before.get(a) !== l).map(([a]) => a);
    ctx.db.tx(() => {
      const t = now();
      for (const agentId of removed) ctx.db.run("DELETE FROM connection_grants WHERE agent_id = ? AND connection_id = ?", agentId, id);
      for (const [agentId, lvl] of next) {
        ctx.db.run(
          `INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, connection_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at WHERE level <> excluded.level`,
          agentId,
          id,
          lvl,
          t,
          t,
        );
      }
    });
    // Fresh tool views first, then the policy cancels pending calls and deletes "always allow" rules of removed
    // grants, and re-checks changed ones.
    for (const agentId of new Set([...removed, ...changed])) ctx.broker.invalidate({ agentId });
    for (const agentId of removed) ctx.broker.onGrantRemoved(agentId, id);
    for (const agentId of changed.filter((a) => before.has(a))) ctx.broker.onGrantChanged(agentId, id);
    if (removed.length || changed.length) audit("connection.grants", id, { removed, changed });
    for (const agentId of new Set([...removed, ...changed])) notifyAgent(ctx, agentId);
    return c.json<ConnectionGrant[]>(grantsOf(id));
  });

  app.put("/connections/:id/private-target", async (c) => {
    const id = c.req.param("id");
    const conn = requireConnection(id);
    const { allow } = await readBody(c, privateTargetSchema);
    if (allow && !conn.url) throw badRequest("This connection has no URL to allow");
    const target = allow ? exactOrigin(conn.url!) : null;
    if (target !== conn.privateTarget) {
      ctx.db.run("UPDATE connections SET private_target = ?, updated_at = ? WHERE id = ?", target, now(), id);
      await ctx.broker.reload(id);
      audit(allow ? "connection.private_target.allow" : "connection.private_target.revoke", id, { target: target ?? conn.privateTarget });
    }
    return c.json<ConnectionView>(view(id));
  });

  // "Refresh tools": list the upstream's tools again now (a changed tool is used at once and audited).
  app.post("/connections/:id/refresh", async (c) => {
    const id = c.req.param("id");
    const conn = requireConnection(id);
    if (conn.status === "disabled") throw conflict(`${conn.name} is disabled`, "Reconnect it first.");
    // Refresh alone when it's attached (attaching again would abort a listing in progress); attach only if not.
    let r = await ctx.broker.catalog.refresh(id);
    if (!r.ok && r.error === "not_attached") {
      ctx.broker.attach(id);
      r = await ctx.broker.catalog.refresh(id);
    }
    ctx.broker.invalidate({ connectionId: id });
    audit("connection.refresh", id, { ok: r.ok, added: r.added.length, changed: r.changed.length, removed: r.removed.length });
    return c.json({ ok: r.ok, error: r.error ?? null, connection: view(id) });
  });

  return app;
}
