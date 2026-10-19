// The MCP broker as an AppContext service (docs/MCP-BROKER.md). It holds one ToolSource per connection, the
// tool registry, the policy's call path and the connector, and owns the lifecycle and the kill switch.
//
// The parts come from other workstreams (server/broker/types.ts lists who builds what). The policy runtime
// (server/broker/policy) is built here and supplies calls, get_call_status, approved-call execution and the kill
// switch; the credential store falls back to a plain table store. Parts not wired yet (catalog registry, upstream
// connector) are inert stubs: no tools, probes that report "not available". Tests pass fakes through
// createBrokerService(ctx, parts).
//
// Everything is behind Settings.brokerUpstreams (off by default): with it off, `view` is null, /mcp lists
// only the native tools, connection events are invisible and /api/connections answers 404.

import {
  type AccessLevel,
  type Connection,
  type ConnectionAuthType,
  type ConnectionProbe,
  type ConnectionView,
  type EventType,
  isPresetEventType,
  type MailEvent,
  type McpCallApproval,
  type StartConnectInput,
  type StartConnectResult,
} from "../../shared/types.ts";
import type { AppContext, Lifecycle } from "../context.ts";
import { now } from "../db/index.ts";
import { type ConnectionHookHost, connectionHookUrl } from "../integrations/hooks.ts";
import { type UpgradeResult, type UpgradeStore, upgradeToExtensions, usedBy } from "../extensions/bootstrap.ts";
import { OFFICIAL_NAMES } from "../extensions/registry.ts";
import { type ExtensionPin, extensionStore, LISTENER_ORDER, type SqliteExtensionStore } from "../extensions/store.ts";
import { boundPreset, presetSource, presets, reloadPresets, snapshotPreset, useExtensionStore } from "../integrations/index.ts";
import { removeConnectionState } from "../extensions/host/spawn.ts";
import { googleConnectionState, googleConnectionView, googleTokenDeps, isGooglePreset, syncGoogleConnections } from "../extensions/google-auth.ts";
import { forgetHandedTokens } from "../extensions/handed-tokens.ts";
import { loopbackUrl } from "../urls.ts";
import { conflict, errorMessage, notFound } from "../util/errors.ts";
import { type ConnectionGrantRef, connectionGrantsOf } from "./access.ts";
import { brokerConnections, Catalog, CatalogRegistry, connectionGrants, SqliteCatalogStore } from "./catalog/index.ts";
import { nativeDepsFor, registerNativeFlows, upstreamConnector } from "./connector.ts";
import { type BrokerPassthrough, createPassthrough } from "./passthrough.ts";
import { upstreams } from "./upstream/runtime.ts";
import { type BrokerPolicyRuntime, brokerPolicyOf, createBrokerPolicyRuntime } from "./policy/index.ts";
import { isExpired } from "./policy/store.ts";
import { type ReachabilityDeps, type WebhookReachability, reachabilityCache } from "./reachability.ts";
import { pinExistingAgentsDirect } from "./search/mode.ts";
import {
  type BrokerCalls,
  type CredentialStore,
  type IntegrationEvent,
  type IntegrationPreset,
  type NativeSourceDeps,
  type RegisteredTool,
  SourceError,
  type ToolRegistry,
  type ToolResult,
  type ToolSource,
} from "./types.ts";

// ───────────── Parts other workstreams provide ─────────────

/** StartConnectResult without the view (the API adds the fresh ConnectionView on "connected"). */
export type ConnectOutcome = Exclude<StartConnectResult, { status: "connected" }> | { status: "connected" };

/** The upstream runtime's entry points (server/broker/upstream/*), adapted in server/broker/connector.ts. */
export interface Connector {
  /** Probes an MCP URL: reachable, which auth, blocked by the SSRF guard. Never stores anything. */
  probe(input: { url: string; privateTarget: string | null }, signal: AbortSignal): Promise<ConnectionProbe>;
  /** Starts connecting: stores a static header, or begins OAuth and returns the authorize URL. */
  startConnect(connection: Connection, input: StartConnectInput, signal: AbortSignal): Promise<ConnectOutcome>;
  /** The ToolSource for a remote_http connection. */
  createSource(connection: Connection): ToolSource;
  /** Paste mode: finishes a sign-in from the landing URL the user copied. */
  finishFromUrl?(raw: string): Promise<{ status: "connected"; connectionId: string } | { status: "error"; message: string; connectionId: null }>;
  /** Drops the pooled session and fetch (URL or allow edited, reconnect, kill, delete). */
  invalidate?(connectionId: string): Promise<void>;
  /** Closes the session, stops refreshing and deletes every credential (URL edit). */
  disconnect?(connectionId: string): Promise<void>;
}

export interface BrokerParts {
  /** Catalog (server/broker/catalog/*). */
  registry: ToolRegistry;
  /** Policy and approvals (server/broker/policy/*): the single call path. */
  calls: BrokerCalls;
  /** get_call_status(approval_id), from the policy workstream. */
  callStatus(agentId: string, approvalId: string): ToolResult | Promise<ToolResult>;
  /**
   * Runs an mcp.call approval already claimed ("approved"): re-checks agent, grant, pin and args hash, forwards
   * the stored bytes and records the outcome on the approval (sent with the result, back to pending, or failed
   * with an unknown outcome). Approvals.approve calls it after claiming. Default: the policy runtime.
   */
  runApprovedCall?(approval: McpCallApproval): Promise<void>;
  connector: Connector;
  /** Native presets' source dependencies (credential store + token refresher). */
  nativeDeps?(connection: Connection): NativeSourceDeps;
  /**
   * Drops cached per-agent tool views after connections, slugs, grants or pins changed. Default: the catalog
   * registry's invalidate (whole cache, or one agent's view).
   */
  invalidate?(scope: InvalidateScope): void;
  /** Kill switch extras, run before the credentials are cleared (e.g. RFC 7009 revoke needs the token). */
  onKill?: ((connectionId: string) => void | Promise<void>)[];
  /** The preset registry; default server/integrations presets(). */
  presets?: () => IntegrationPreset[];
  /** The credential store. Default: the upstream runtime's (server/broker/credentials). */
  credentials?: CredentialStore;
  /** DNS and the Tailscale CLI for the webhook reachability check (tests: fakes, no network). */
  reachability?: Partial<ReachabilityDeps>;
}

/** What changed: one agent's grants, one connection (slug, URL, pins, kill), or everything. */
export type InvalidateScope = { agentId: string } | { connectionId: string } | "all";

export interface BrokerOptions {
  /** How often the native-preset event poll checks which connections are due (each polls every pollIntervalMs). Default 60 s. */
  pollTickMs?: number;
}

// ───────────── The service ─────────────

/** What one agent gets from the broker on /mcp. */
export interface AgentBrokerView {
  /** The agent's connection grants (any level), by slug. */
  connections: ConnectionGrantRef[];
  /** Tools from ToolRegistry.forAgent: levels applied. */
  tools: RegisteredTool[];
}

export interface BrokerService extends Lifecycle {
  /** Settings.brokerUpstreams. */
  enabled(): boolean;
  /** null while the broker is off. */
  view(agentId: string): AgentBrokerView | null;
  calls: BrokerCalls;
  callStatus(agentId: string, approvalId: string): Promise<ToolResult>;
  canRunApprovedCalls(): boolean;
  runApprovedCall(approval: McpCallApproval): Promise<void>;
  /** The policy runtime (also reachable as brokerPolicyOf(ctx)). */
  policy: BrokerPolicyRuntime;
  /** A connection grant changed level (admin API): the policy re-checks pending calls. */
  onGrantChanged(agentId: string, connectionId: string): void;
  /** A connection grant was removed: pending calls cancelled, "always allow" rules deleted. */
  onGrantRemoved(agentId: string, connectionId: string): void;
  /** The connection's source, created on first use; null when the connection is missing or disabled, or the broker is off. */
  source(connectionId: string): ToolSource | null;
  connector: Connector;
  presets(): IntegrationPreset[];
  /** Closes the connection's source (after its URL or credential changed); the next use builds a new one. */
  reload(connectionId: string): Promise<void>;
  /** Kill switch: disable, run onKill, then the policy's kill (cancel pending calls, clear credentials, close the source). Audited. */
  kill(connectionId: string, reason: string): Promise<void>;
  /** The kill switch, then the row (grants, pins, rules and approvals cascade). Audited. */
  remove(connectionId: string): Promise<void>;
  invalidate(scope: InvalidateScope): void;
  /** The tool catalog (W5). */
  catalog: Catalog;
  /** (Re)starts the catalog's tool listing for a connection (create, connect, URL change); no-op while off or disabled. */
  attach(connectionId: string): void;
  /** Emits a connection event (connection.*, approval.requested, `<preset>.*`) through the events outbox. */
  emitConnectionEvent(e: { type: EventType; connectionId: string; dedupeKey: string; detail?: Record<string, unknown> }): MailEvent | null;
  /** Inbound webhooks of native presets (POST /hooks/connections/:id, server/integrations/hooks.ts). */
  hooks: ConnectionHookHost;
  /**
   * The connection's inbound webhook URL, or null when nothing public reaches this install (server/broker/reachability.ts).
   * From the last check: null until one has finished.
   */
  webhookUrl(connectionId: string): string | null;
  /** Whether providers can reach the webhook URL, and the optional Tailscale Funnel step (cached, bounded). */
  webhookReachability(): Promise<WebhookReachability>;
  /**
   * Polls every due native connection once, webhooks or not (the reconciliation poll: a delivery that failed while
   * this install was offline is found here; presets drop what their webhooks already announced). Returns the number
   * of events emitted.
   */
  pollEvents(at?: number): Promise<number>;
  /** Upstream prompts and resources for /mcp (server/broker/passthrough.ts), every connection kind. */
  passthrough: BrokerPassthrough;
  /**
   * The startup upgrade to extensions (server/extensions/bootstrap.ts): connections of the Notion, T3 Code and WHOOP
   * presets are bound to those extensions, and missing ones install in the background; once one is installed its
   * connections are re-listed under its risk map. start() runs it with the registered extension store.
   */
  upgradeExtensions(store: UpgradeStore, pins?: readonly ExtensionPin[]): UpgradeResult;
}

const UNAVAILABLE = "Integrations aren't available in this build of xaq yet.";
const unavailable = (): ToolResult => ({ isError: true, content: [{ type: "text", text: UNAVAILABLE }] });

/** Inert parts, for tests that don't want the catalog or the upstream runtime. */
export function stubParts(): Pick<BrokerParts, "registry" | "connector"> {
  return {
    registry: { forAgent: () => [], resolve: () => null },
    connector: {
      probe: async () => ({ reachable: false, auth: "unknown", message: UNAVAILABLE }),
      startConnect: async () => ({ status: "error", message: UNAVAILABLE }),
      createSource: (c) => unavailableSource(c.id),
    },
  };
}

function unavailableSource(connectionId: string, message = UNAVAILABLE): ToolSource {
  return {
    connectionId,
    listTools: async () => {
      throw new SourceError("unavailable", message);
    },
    callTool: async () => ({ isError: true, content: [{ type: "text", text: message }] }),
    close: async () => {},
  };
}

export function createBrokerService(ctx: AppContext, given: Partial<BrokerParts> = {}, opts: BrokerOptions = {}): BrokerService {
  const log = ctx.log.child("broker");
  const sources = new Map<string, ToolSource>();
  const enabled = () => ctx.settings.get().brokerUpstreams;
  const presetList = () => (given.presets ?? presets)();
  // A connection's preset: the installed extension (or a core preset), else the bootstrap snapshot of an official one
  // it was bound to before the upgrade (server/integrations/index.ts). New connections pick from presetList() only.
  const presetFor = (presetId: string | null) => (presetId ? (presetList().find((p) => p.id === presetId) ?? snapshotPreset(presetId)) : null);

  // The upstream runtime (W3/W4): credential store, refresher, connect flow, remote sources. Created here, first,
  // so its connection events go to the outbox; native OAuth flows are registered before start() runs.
  const up = upstreams(ctx, {
    emit: (e) => {
      try {
        ctx.events.emit({ type: e.type, connectionId: e.connectionId, dedupeKey: e.dedupeKey, detail: e.detail });
      } catch (err) {
        log.error(`${e.type} event failed`, { error: errorMessage(err) });
      }
    },
  });
  registerNativeFlows(up, presetFor);
  const credentials = given.credentials ?? up.store;

  // The catalog (W5): stored definitions and the per-agent registry over upstream_tools. A changed upstream tool is
  // used at once; the catalog only audits it (no event, no hold).
  const store = new SqliteCatalogStore(ctx.db);
  const catalog = new Catalog({
    store,
    connection: (id) => {
      const c = getConnection(ctx, id);
      return c ? { slug: c.slug, preset: presetFor(c.preset) } : null;
    },
    connections: () => brokerConnections(ctx.db).map((c) => ({ id: c.id, slug: c.slug })),
    audit: (input) => ctx.audit.record(input),
    log,
    enabled,
  });
  const catalogRegistry = new CatalogRegistry({
    store,
    connections: () => brokerConnections(ctx.db),
    grants: (agentId) => connectionGrants(ctx.db, agentId),
    preset: (id) => presetFor(getConnection(ctx, id)?.preset ?? null),
  });
  catalog.onChange(() => catalogRegistry.invalidate());
  // A disabled (killed) connection's tools aren't listed; resolve still finds them, so a direct call gets the
  // policy's clear "turned off" answer. needs_reauth ones stay listed (calls say how to reconnect).
  const disabledIds = () => new Set(ctx.db.all<{ id: string }>("SELECT id FROM connections WHERE status = 'disabled'").map((r) => r.id));
  const visibleRegistry: ToolRegistry = {
    forAgent: (agentId) => {
      const off = disabledIds();
      const all = catalogRegistry.forAgent(agentId);
      return off.size ? all.filter((t) => !off.has(t.connectionId)) : all;
    },
    resolve: (agentId, name) => catalogRegistry.resolve(agentId, name),
  };
  const base = { registry: visibleRegistry, connector: upstreamConnector(ctx, up, presetFor), ...given };
  const invalidate = (scope: InvalidateScope) => {
    if (given.invalidate) return given.invalidate(scope);
    if (typeof scope === "object" && "agentId" in scope) catalogRegistry.invalidateAgent(scope.agentId);
    else catalogRegistry.invalidate();
  };

  // The policy runtime (W6): BrokerCalls, get_call_status, approved calls, grant hooks and the kill switch.
  const policy = createBrokerPolicyRuntime(ctx, {
    registry: base.registry,
    sources: { source: (id) => service.source(id), close: (id) => closeSource(id) },
    credentials,
    refresher: up.refresher,
    onApprovalRequested: (ev) => {
      try {
        const { type, connectionId, ...detail } = ev;
        ctx.events.emit({ type, connectionId, dedupeKey: `${type}:${ev.approvalId}`, detail });
      } catch (err) {
        log.error("approval.requested event failed", { error: errorMessage(err) });
      }
    },
  });
  // A tool that left the upstream: its pending calls fail closed and its allow rules go.
  // The runtime registered for this context (brokerPolicyOf): this one, unless a test attached its own.
  const rt = (): BrokerPolicyRuntime => brokerPolicyOf(ctx) ?? policy;
  catalog.onToolRemoved((e) => void rt().onToolRemoved(e.connectionId, e.name));
  const parts: BrokerParts = {
    calls: { call: (agentId, name, args, signal) => rt().call(agentId, name, args, signal) },
    callStatus: (agentId, id) => rt().getCallStatus(agentId, id),
    runApprovedCall: (approval) => rt().runApprovedCall(approval),
    ...base,
  };

  const closeSource = async (connectionId: string) => {
    const s = sources.get(connectionId);
    sources.delete(connectionId);
    await s?.close().catch((err: unknown) => log.warn("Closing a tool source failed", { connection: connectionId, error: errorMessage(err) }));
    // The runtime pools remote sessions too: drop its entry, or the next source would be the closed one.
    await parts.connector.invalidate?.(connectionId).catch((err: unknown) => log.warn("Dropping an upstream session failed", { connection: connectionId, error: errorMessage(err) }));
  };
  const closeAll = async () => {
    await Promise.all([...sources.keys()].map(closeSource));
  };

  function createSource(c: Connection): ToolSource {
    if (c.kind === "remote_http") return parts.connector.createSource(c);
    const preset = presetOf(c);
    if (!preset) return unavailableSource(c.id, c.preset ? missingExtensionMessage(c.preset) : UNAVAILABLE);
    if (!preset.createSource) return unavailableSource(c.id);
    return preset.createSource(parts.nativeDeps?.(c) ?? defaultNativeDeps(c));
  }

  /**
   * The runtime's deps plus what code extensions use (server/extensions/host): the outbox (the preset's own `<id>.*`
   * types for this connection only), the data directory, and the connection's `error` status.
   */
  const defaultNativeDeps = (c: Connection): NativeSourceDeps => ({
    ...nativeDepsFor(ctx, up, c),
    // A Google extension's tokens come from its bound account, downscoped (never the runtime's credential store).
    ...(() => {
      const preset = presetOf(c);
      return isGooglePreset(preset) ? googleTokenDeps(ctx, c.id, preset) : {};
    })(),
    dataDir: ctx.config.dataDir,
    emit: (e) => {
      const conn = getConnection(ctx, c.id);
      // A disabled (killed) connection emits nothing, even from a child that hasn't stopped yet.
      if (!conn || conn.status === "disabled" || !enabled()) {
        log.warn("Dropped an event from a disabled connection", { connection: c.id, type: e.type.slice(0, 80) });
        return;
      }
      const preset = presetOf(conn);
      if (preset) emitIntegrationEvents(conn, preset, [e]);
    },
    setError: (reason) => {
      if (reason === null) {
        ctx.db.run("UPDATE connections SET status = 'active', status_reason = NULL, updated_at = ? WHERE id = ? AND status = 'error'", now(), c.id);
        return;
      }
      ctx.db.run("UPDATE connections SET status = 'error', status_reason = ?, updated_at = ? WHERE id = ? AND status IN ('active', 'error')", reason.slice(0, 1000), now(), c.id);
    },
  });

  /**
   * Catalog listing per connection. The catalog gets a proxy that resolves the live source on every listing, so a
   * reconnect (which replaces the pooled session) never leaves it on a closed one.
   */
  const attach = (connectionId: string) => {
    if (!enabled() || !service.source(connectionId)) return;
    const live = (): ToolSource => {
      const s = service.source(connectionId);
      if (!s) throw new SourceError("unavailable", "The connection is disabled or the broker is off");
      return s;
    };
    void catalog.attach({
      connectionId,
      listTools: (signal) => live().listTools(signal),
      callTool: (name, args, callCtx) => live().callTool(name, args, callCtx),
      close: async () => {},
    });
  };
  const attachAll = () => {
    for (const c of listConnections(ctx)) if (c.status !== "disabled") attach(c.id);
  };
  let wasOn = false;
  const onSettings = (s: { brokerUpstreams: boolean }) => {
    if (s.brokerUpstreams && !wasOn) attachAll();
    if (!s.brokerUpstreams && wasOn) {
      catalog.close();
      void closeAll();
    }
    wasOn = s.brokerUpstreams;
  };

  const presetOf = (c: Connection): IntegrationPreset | null => presetFor(c.preset);

  const onAccount = () => {
    try {
      syncGoogleConnections(ctx, presetFor);
    } catch (err) {
      log.warn("Couldn't update Google extension connections", { error: errorMessage(err) });
    }
  };

  /** The client registration (e.g. WHOOP's pasted client id and secret). */
  const clientRecord = (connectionId: string): Record<string, unknown> | null => credentials.client(connectionId);

  /** Native preset events into the outbox: only the preset's own `<id>.*` types, only for that connection. */
  function emitIntegrationEvents(connection: Connection, preset: IntegrationPreset, events: IntegrationEvent[]): number {
    let n = 0;
    for (const e of events) {
      if (e.connectionId !== connection.id || !e.type.startsWith(`${preset.id}.`) || !isPresetEventType(e.type)) {
        log.warn("Dropped an integration event", { connection: connection.id, type: e.type.slice(0, 80) });
        continue;
      }
      if (ctx.events.emit({ type: e.type, connectionId: connection.id, dedupeKey: `${connection.id}:${e.dedupeKey}`, detail: e.data })) n++;
    }
    return n;
  }

  const reach = reachabilityCache({
    publicUrl: () => ctx.settings.publicUrl(),
    localOrigin: () => loopbackUrl(ctx.config.host, ctx.config.port),
    deps: parts.reachability,
  });
  /** Last verified webhook delivery for the connection's member (memory only), for the console's status. */
  const lastDelivery = new Map<string, number>();

  const hooks: ConnectionHookHost = {
    webhookTarget(connectionId) {
      const c = getConnection(ctx, connectionId);
      if (!c || c.status === "disabled" || c.status === "needs_reauth") return null;
      const preset = presetOf(c);
      if (!preset?.events?.handleWebhook || preset.auth.type !== "user_app") return null;
      const secret = clientRecord(connectionId)?.[preset.auth.clientSecretInput];
      if (typeof secret !== "string" || !secret) return null;
      return { preset, deps: parts.nativeDeps?.(c) ?? defaultNativeDeps(c), clientSecret: secret, client: clientRecord(connectionId) };
    },
    presetWebhookTargets(presetId) {
      if (!presetFor(presetId)) return [];
      return listConnections(ctx)
        .filter((c) => c.preset === presetId)
        .flatMap((c) => hooks.webhookTarget(c.id) ?? []);
    },
    // Status only: the poll keeps running regardless (the preset drops what webhooks already announced), so a
    // delivery that fails while this install is offline is still found by the next poll.
    delivered(connectionId) {
      lastDelivery.set(connectionId, Date.now());
    },
    emit(events) {
      const byConnection = new Map<string, IntegrationEvent[]>();
      for (const e of events) byConnection.set(e.connectionId, [...(byConnection.get(e.connectionId) ?? []), e]);
      for (const [id, list] of byConnection) {
        const c = getConnection(ctx, id);
        const preset = c ? presetOf(c) : null;
        if (c && preset) emitIntegrationEvents(c, preset, list);
      }
    },
  };

  function webhookUrl(connectionId: string): string | null {
    const base = reach.current().webhookBase;
    return base ? connectionHookUrl(base, connectionId) : null;
  }

  const lastPoll = new Map<string, number>();
  let polling = false;
  async function pollEvents(at = Date.now()): Promise<number> {
    if (polling || !enabled()) return 0;
    polling = true;
    let emitted = 0;
    try {
      let checked = false;
      for (const c of listConnections(ctx)) {
        if (c.kind === "remote_http" || c.status === "disabled" || c.status === "needs_reauth") continue;
        const preset = presetOf(c);
        const poll = preset?.events?.poll;
        if (!preset || !poll) continue;
        // Only once there's something to poll (no DNS or CLI call otherwise); bounded and cached.
        if (!checked) {
          checked = true;
          await reach.check();
        }
        const interval = preset.events?.pollIntervalMs ?? 15 * 60_000;
        if (at - (lastPoll.get(c.id) ?? 0) < interval) continue;
        lastPoll.set(c.id, at);
        try {
          const cursor = ctx.db.get<{ events_cursor: string | null }>("SELECT events_cursor FROM connections WHERE id = ?", c.id)?.events_cursor ?? null;
          const r = await poll(cursor, parts.nativeDeps?.(c) ?? defaultNativeDeps(c));
          emitted += emitIntegrationEvents(c, preset, r.events);
          ctx.db.run("UPDATE connections SET events_cursor = ? WHERE id = ?", r.cursor, c.id);
        } catch (err) {
          log.warn("Integration event poll failed", { connection: c.id, error: errorMessage(err) });
        }
      }
    } finally {
      polling = false;
    }
    return emitted;
  }
  let pollTimer: NodeJS.Timeout | null = null;
  let unwatchExtensions: (() => void) | null = null;
  let extensions: SqliteExtensionStore | null = null;

  /** Re-lists connections after their extension changed: cached views drop, native sources are rebuilt, and listing
   * re-classifies the pinned tools under the extension's risk map (or the generic rules, once it's gone). */
  function relist(connectionIds: string[]): void {
    invalidate("all");
    for (const id of connectionIds) {
      const c = getConnection(ctx, id);
      if (!c || c.status === "disabled") continue;
      void (c.kind === "remote_http" ? Promise.resolve() : closeSource(id)).then(() => catalog.refresh(id)).catch(() => {});
    }
  }

  /**
   * The extension of the connections a forced removal disabled is back (installed again): each one returns to `active`
   * when its credentials are still there (nothing was cleared: no sign-in needed), else to `needs_reauth` (Reconnect).
   * Only connections disabled by that removal, still bound to the name; a kill or a manual disable stays.
   */
  function reenableAfterReinstall(name: string): void {
    const reason = extensionRemovedReason(name);
    for (const id of usedBy(ctx.db, name)) {
      const c = getConnection(ctx, id);
      if (!c || c.status !== "disabled" || c.statusReason !== reason) continue;
      const preset = presetOf(c);
      const signedIn = isGooglePreset(preset)
        ? !googleConnectionState(ctx, id, preset).problem
        : c.authType === "none" || (c.authType === "header" ? !!credentials.header(id) : !!credentials.tokens(id));
      ctx.db.run(
        "UPDATE connections SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?",
        signedIn ? "active" : "needs_reauth",
        signedIn ? null : `Reconnect ${c.name}: its sign-in is gone`,
        now(),
        id,
      );
      ctx.audit.record({ actorType: "system", action: "connection.enable", target: id, outcome: "ok", reason: `its extension ${name} was installed again`, detail: { slug: c.slug, signedIn } });
      if (enabled()) attach(id);
    }
  }

  /**
   * A forced extension removal: its connections are disabled; for a third-party name also unbound (preset cleared),
   * so a later extension of that name can't take them over. Credentials stay until the connections are removed.
   */
  function disableBound(connectionIds: string[], reason: string, opts: { unbind: boolean }): void {
    for (const id of connectionIds) {
      const c = getConnection(ctx, id);
      if (!c) continue;
      if (opts.unbind) ctx.db.run("UPDATE connections SET preset = NULL, updated_at = ? WHERE id = ?", now(), id);
      if (c.status === "disabled") continue;
      ctx.db.run("UPDATE connections SET status = 'disabled', status_reason = ?, updated_at = ? WHERE id = ?", reason, now(), id);
      catalog.detach(id);
      void closeSource(id);
      ctx.audit.record({ actorType: "system", action: "connection.disable", target: id, outcome: "ok", reason, detail: { slug: c.slug } });
    }
    if (connectionIds.length) invalidate("all");
  }

  const service: BrokerService = {
    enabled,
    policy,
    onGrantChanged: (agentId, connectionId) => void rt().onGrantChanged(agentId, connectionId),
    onGrantRemoved: (agentId, connectionId) => void rt().onGrantRemoved(agentId, connectionId),

    view(agentId) {
      if (!enabled()) return null;
      const connections = connectionGrantsOf(ctx.db, agentId);
      return { connections, tools: connections.length ? parts.registry.forAgent(agentId) : [] };
    },

    calls: {
      call: (agentId, exposedName, args, signal) => (enabled() ? parts.calls.call(agentId, exposedName, args, signal) : Promise.resolve(unavailable())),
    },

    async callStatus(agentId, approvalId) {
      return parts.callStatus(agentId, approvalId);
    },

    canRunApprovedCalls: () => !!parts.runApprovedCall,

    async runApprovedCall(approval) {
      if (!parts.runApprovedCall) throw conflict("Tool call requests can't be approved by this version.", "Update xaq, or reject the request.");
      return parts.runApprovedCall(approval);
    },

    source(connectionId) {
      if (!enabled()) return null;
      const c = getConnection(ctx, connectionId);
      if (!c || c.status === "disabled") return null;
      // Remote sources are pooled by the upstream runtime, which drops and rebuilds them on reconnect, URL or
      // allow edits: never cached here, so nothing keeps using a closed session.
      if (c.kind === "remote_http") return createSource(c);
      const existing = sources.get(connectionId);
      if (existing) return existing;
      const s = createSource(c);
      sources.set(connectionId, s);
      return s;
    },

    connector: parts.connector,
    presets: () => (parts.presets ?? presets)(),
    reload: closeSource,

    async kill(connectionId, reason) {
      const c = getConnection(ctx, connectionId);
      if (!c) throw notFound("Connection");
      // Disabled first, so nothing new starts; then the hooks, which may still need the credentials (a revoke).
      ctx.db.run("UPDATE connections SET status = 'disabled', status_reason = ?, updated_at = ? WHERE id = ?", reason, now(), connectionId);
      catalog.detach(connectionId);
      invalidate({ connectionId });
      for (const hook of parts.onKill ?? []) {
        try {
          await hook(connectionId);
        } catch (err) {
          log.warn("A kill switch hook failed", { connection: connectionId, error: errorMessage(err) });
        }
      }
      // The policy's kill: cancel pending calls, clear credentials, untrack refresh, close the source. Audited.
      await rt().killConnection(connectionId);
      ctx.db.run("UPDATE connections SET status_reason = ? WHERE id = ?", reason, connectionId);
      await closeSource(connectionId);
      forgetHandedTokens(connectionId);
    },

    async remove(connectionId) {
      const c = getConnection(ctx, connectionId);
      if (!c) throw notFound("Connection");
      const agents = ctx.db.all<{ agent_id: string }>("SELECT agent_id FROM connection_grants WHERE connection_id = ?", connectionId);
      await this.kill(connectionId, "deleted");
      ctx.db.run("DELETE FROM connections WHERE id = ?", connectionId);
      // A code extension's per-connection state goes with the connection (its source is closed by now).
      try {
        removeConnectionState(ctx.config.dataDir, connectionId);
      } catch (err) {
        log.warn("Deleting a connection's extension state failed", { connection: connectionId, error: errorMessage(err) });
      }
      invalidate("all");
      ctx.audit.record({ actorType: "admin", actorId: null, action: "connection.delete", target: connectionId, outcome: "ok", detail: { slug: c.slug } });
      for (const { agent_id } of agents) notifyAgent(ctx, agent_id);
    },

    invalidate,
    catalog,
    attach,

    emitConnectionEvent(e) {
      return ctx.events.emit({ type: e.type, connectionId: e.connectionId, dedupeKey: e.dedupeKey, detail: e.detail });
    },

    hooks,
    webhookUrl,
    webhookReachability: () => reach.check(),
    pollEvents,
    passthrough: createPassthrough({
      db: ctx.db,
      source: (id) => service.source(id),
      credentials,
      audit: (input) => ctx.audit.record(input),
      log: ctx.log.child("mcp"),
    }),

    upgradeExtensions(store, pins) {
      return upgradeToExtensions({
        db: ctx.db,
        store,
        ...(pins ? { pins } : {}),
        log,
        onInstalled: (_ext, connectionIds) => relist(connectionIds),
      });
    },

    start() {
      // Agents from before search mode keep their full tool list (once per install; docs/MCP-BROKER.md).
      try {
        const pinned = pinExistingAgentsDirect(ctx.db, ctx.settings);
        if (pinned) ctx.log.child("broker").info("Kept the full tool list for existing agents", { agents: pinned });
      } catch (err) {
        ctx.log.error("Couldn't keep the full tool list for existing agents", { error: errorMessage(err) });
      }
      // Tools an older version left on hold (the hold was removed on 2026-10-16) become usable now.
      try {
        const released = catalog.releaseLegacyHolds();
        if (released) log.info("Released tools held for a change by an older version", { tools: released });
      } catch (err) {
        log.error("Couldn't release tools held by an older version", { error: errorMessage(err) });
      }
      // Extensions (docs/EXTENSIONS.md): presets() reads the installed ones; the store asks us which connections use
      // one, disables them on a forced removal, and reloads presets() after every change. Then the startup upgrade:
      // connections of the former core presets are bound, and missing extensions install in the background.
      try {
        extensions = extensionStore(ctx);
        useExtensionStore(extensions);
        extensions.setHooks({
          usedBy: (name) => usedBy(ctx.db, name),
          onRemove: (ext, o) => {
            // Official names stay bound (no third party can install under them, and re-adding the extension must bring
            // its rules back, say Notion's gate on spawning agents); any other name is unbound too.
            if (o.force) disableBound(o.usedBy, extensionRemovedReason(ext.name), { unbind: !ext.official && !OFFICIAL_NAMES.includes(ext.name) });
          },
          // setHooks registers at LISTENER_ORDER.presets: presets() is rebuilt first...
          onChange: () => reloadPresets(),
        });
        // ...then, at LISTENER_ORDER.restart, the extension's connections are re-listed under the new preset: native
        // (code) sources close, so the next use starts the new code after its integrity check.
        unwatchExtensions?.();
        unwatchExtensions = extensions.onChange(
          (change) => {
            const name = change.to?.name ?? change.from?.name;
            // Reinstalled after a forced removal: its connections (still bound: official names stay bound) come back.
            if (change.to && !change.from) reenableAfterReinstall(change.to.name);
            relist(name ? usedBy(ctx.db, name) : []);
          },
          { order: LISTENER_ORDER.restart },
        );
        service.upgradeExtensions(extensions);
      } catch (err) {
        log.error("Couldn't load extensions", { error: errorMessage(err) });
      }
      policy.start();
      ctx.bus.on("settings", onSettings);
      // Google extensions' connections follow their accounts (consent, scopes backfilled, needs_reauth, reconnect).
      ctx.bus.on("account", onAccount);
      onAccount();
      wasOn = enabled();
      if (wasOn) attachAll();
      pollTimer = setInterval(() => void pollEvents(), opts.pollTickMs ?? 60_000);
      pollTimer.unref();
    },

    async stop() {
      unwatchExtensions?.();
      unwatchExtensions = null;
      // This context's store goes with it (tests run several contexts in one process).
      if (extensions && presetSource() === extensions) useExtensionStore(null);
      catalog.close();
      ctx.bus.off("settings", onSettings);
      ctx.bus.off("account", onAccount);
      if (pollTimer) clearInterval(pollTimer);
      await closeAll();
    },
  };
  return service;
}

/** Live streams re-check access (accessProblem counts connection grants) and the console refreshes the agent. */
export function notifyAgent(ctx: AppContext, agentId: string): void {
  try {
    ctx.bus.emit("agent", { agentId, reason: "grant_changed" });
  } catch (err) {
    ctx.log.error("Bus listener failed", { error: errorMessage(err) });
  }
  ctx.policy.publishAgent(agentId);
}

// ───────────── Connections table (migration 8) ─────────────

interface ConnectionRow {
  id: string;
  owner_id: string | null;
  kind: Connection["kind"];
  preset: Connection["preset"];
  slug: string;
  name: string;
  url: string | null;
  auth_type: ConnectionAuthType;
  level_default: AccessLevel;
  all_agents: number | null;
  private_target: string | null;
  status: Connection["status"];
  status_reason: string | null;
  expires_at: string | null;
  protocol: string | null;
  tools_cached_at: string | null;
  instructions_hash: string | null;
  created_at: string;
  updated_at: string;
}

function toConnection(r: ConnectionRow): Connection {
  return {
    id: r.id,
    ownerId: r.owner_id,
    kind: r.kind,
    preset: r.preset,
    slug: r.slug,
    name: r.name,
    url: r.url,
    authType: r.auth_type,
    levelDefault: r.level_default,
    allAgents: r.all_agents === 1,
    privateTarget: r.private_target,
    status: r.status,
    statusReason: r.status_reason,
    expiresAt: r.expires_at,
    protocol: r.protocol,
    toolsCachedAt: r.tools_cached_at,
    instructionsHash: r.instructions_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getConnection(ctx: Pick<AppContext, "db">, id: string): Connection | null {
  const r = ctx.db.get<ConnectionRow>("SELECT * FROM connections WHERE id = ?", id);
  return r ? toConnection(r) : null;
}

export function listConnections(ctx: Pick<AppContext, "db">): Connection[] {
  return ctx.db.all<ConnectionRow>("SELECT * FROM connections ORDER BY created_at, rowid").map(toConnection);
}

const DAY_MS = 86_400_000;

/** The status reason of a connection a forced extension removal disabled (reenableAfterReinstall matches it). */
export const extensionRemovedReason = (name: string) => `its extension ${name} was removed`;

/** What a connection says when its preset's extension isn't installed (a code connection can't run without it). */
export const missingExtensionMessage = (name: string) => `Needs the ${name} extension. Install it with \`xaq ext add ${name}\`, or from Extensions in the console.`;

/**
 * The list/get shape: tool count, agents and days to expiry. With `presets`, a non-remote connection whose preset
 * (extension) isn't installed reads as `error` with missingExtensionMessage, not `active` with failing calls. A
 * remote one keeps working as a generic MCP connection meanwhile (docs/EXTENSIONS.md "Migration").
 */
export function connectionView(ctx: Pick<AppContext, "db">, c: Connection, at = Date.now(), presets?: readonly IntegrationPreset[]): ConnectionView {
  if (presets && c.kind !== "remote_http" && c.preset && c.status !== "disabled" && !presets.some((p) => p.id === c.preset)) {
    c = { ...c, status: "error", statusReason: missingExtensionMessage(c.preset) };
  }
  const total = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM upstream_tools WHERE connection_id = ?", c.id)!.n;
  const agents = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM connection_grants WHERE connection_id = ?", c.id)!.n;
  const expiresInDays = c.expiresAt ? Math.max(0, Math.floor((Date.parse(c.expiresAt) - at) / DAY_MS)) : null;
  const preset = c.preset ? boundPreset(c.preset) : null;
  // A Google extension's connection: its account and access, live (an account removed or needing a reconnect shows at
  // once, even before the stored status catches up).
  const google = isGooglePreset(preset) ? googleConnectionState(ctx, c.id, preset) : null;
  if (google?.problem && c.status === "active") c = { ...c, status: "needs_reauth", statusReason: google.problem };
  // Scopes aren't secret (the token is): the plaintext column, as granted by the last sign-in.
  const scope =
    c.authType === "oauth" && !google ? ctx.db.get<{ scope: string | null }>("SELECT scope FROM connection_credentials WHERE connection_id = ? AND access_token_enc IS NOT NULL", c.id)?.scope : null;
  const grantedScopes = google ? (google.account ? [...google.granted] : null) : typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : null;
  const expired = c.status !== "disabled" && isExpired(c, at);
  const auth = preset?.auth;
  const broadScopes = auth?.type === "mcp_oauth" && auth.broadScopes?.length ? [...auth.broadScopes] : null;
  const scopeNotes = auth?.type === "mcp_oauth" && auth.scopeNotes?.length ? auth.scopeNotes.map((n) => ({ ...n })) : null;
  return { ...c, tools: { total }, expiresInDays, expired, grantedScopes, broadScopes, scopeNotes, agents, ...(google ? { google: googleConnectionView(google) } : {}) };
}
