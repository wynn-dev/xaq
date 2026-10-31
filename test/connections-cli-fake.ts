import type { Connection, ConnectionProbe, StartConnectInput } from "../shared/types.ts";
import { type AdminChannel, openAdminChannel } from "../server/connections-cli/admin.ts";
import { ConnectionsApi } from "../server/connections-cli/api.ts";
import { type ConnectOutcome, createBrokerService } from "../server/broker/service.ts";
import type { IntegrationPreset } from "../server/broker/types.ts";
import { upstreams as upstreamRuntime, type UpstreamRuntimeOptions } from "../server/broker/upstream/runtime.ts";
import { harness, type Harness } from "./platform-helpers.ts";

/**
 * A real daemon (createApp: the real /api/connections, admin auth and CSRF) reached
 * through the CLI's real admin channel (a one-time session in its DB). Only the upstream side is fake: the
 * connector answers probes and connects from the tables below, and remembers what it was given.
 */
export interface FakeUpstreams {
  /** Probe answers by URL (default: reachable, no auth). `privateTarget` is what the API passed through. */
  probe: (url: string, privateTarget: string | null) => ConnectionProbe;
  /** Connect outcome by connection (default: connected). */
  connect: (conn: Connection, input: StartConnectInput) => ConnectOutcome;
  connects: { slug: string; input: StartConnectInput; privateTarget: string | null }[];
  /** Paste mode: the URLs POSTed to /api/connections/finish. A `state=ok` one finishes the last sign-in started. */
  finishes: string[];
  /** What a successful finish does to the connection (default: active with 3 tools). */
  finish: (connectionId: string) => void;
  probes: { url: string; privateTarget: string | null }[];
}

export interface Daemon {
  h: Harness;
  api: ConnectionsApi;
  channel: AdminChannel;
  upstreams: FakeUpstreams;
  agents: { hermes: string; claude: string };
  /** Marks a connection as having tools (what a working connect leaves behind), by slug. */
  giveTools(slug: string, n?: number): void;
  dispose(): Promise<void>;
}

const NOTION: IntegrationPreset = {
  id: "notion",
  displayName: "Notion",
  slug: "notion",
  kind: "remote_http",
  url: "https://mcp.notion.com/mcp",
  auth: { type: "mcp_oauth" },
  classify: () => null,
  setupSteps: () => [{ id: "connect", title: "Connect Notion", body: "Approve access and pick a workspace." }],
};

/**
 * `upstream`: the real upstream runtime (connector, credential store, remote sources) with these options (a fake DNS
 * and a `dial` to a fake MCP server on loopback) instead of the fake connector; `upstreams` is then unused.
 */
export async function startDaemon(opts: { presets?: IntegrationPreset[]; upstream?: UpstreamRuntimeOptions } = {}): Promise<Daemon> {
  let giveTools: Daemon["giveTools"] = () => {};
  // What a working connect does to the row (the credential store's markActive).
  let markActive = (_id: string) => {};
  const upstreams: FakeUpstreams = {
    probe: () => ({ reachable: true, auth: "none", message: "It answered without a sign-in." }),
    connect: (conn) => {
      giveTools(conn.slug);
      markActive(conn.id);
      return { status: "connected" };
    },
    connects: [],
    probes: [],
    finishes: [],
    finish: (id) => {
      const slug = h.ctx.db.get<{ slug: string }>("SELECT slug FROM connections WHERE id = ?", id)!.slug;
      giveTools(slug);
      markActive(id);
    },
  };
  let lastAuthorize: string | null = null;
  const real = opts.upstream;
  const h = harness({
    broker: (ctx) =>
      real
        ? // Registered first, so the broker's own upstreams(ctx) gets this runtime.
          (upstreamRuntime(ctx, real), createBrokerService(ctx, { presets: () => opts.presets ?? [NOTION] }))
        : createBrokerService(ctx, {
        presets: () => opts.presets ?? [NOTION],
        connector: {
          async probe(input) {
            upstreams.probes.push(input);
            return upstreams.probe(input.url, input.privateTarget);
          },
          async startConnect(conn, input) {
            upstreams.connects.push({ slug: conn.slug, input, privateTarget: conn.privateTarget });
            const out = upstreams.connect(conn, input);
            if (out.status === "authorize") lastAuthorize = conn.id;
            return out;
          },
          async finishFromUrl(raw) {
            upstreams.finishes.push(raw);
            if (new URL(raw).searchParams.get("state") !== "ok" || !lastAuthorize) {
              return { status: "error" as const, message: "This sign-in link has expired or was already used.", connectionId: null };
            }
            const id = lastAuthorize;
            upstreams.finish(id);
            return { status: "connected" as const, connectionId: id };
          },
          createSource: (c) => ({ connectionId: c.id, listTools: async () => ({ tools: [] }), callTool: async () => ({ isError: true, content: [] }), close: async () => {} }),
        },
      }),
  });
  await h.claim();
  markActive = (id) => h.ctx.db.run("UPDATE connections SET status = 'active', status_reason = NULL WHERE id = ? AND status <> 'disabled'", id);
  const hermes = h.ctx.policy.createAgent({ name: "Hermes", grants: [] }).agent.id;
  const claude = h.ctx.policy.createAgent({ name: "Claude Code on mac", grants: [] }).agent.id;
  const channel = openAdminChannel({
    dataDir: h.ctx.config.dataDir,
    instance: { pid: 1, host: "0.0.0.0", port: 8425, startedAt: "" },
    fetch: ((url: string, init: RequestInit) => {
      const u = new URL(url);
      return h.request(`${u.pathname}${u.search}`, init);
    }) as typeof fetch,
  });
  giveTools = (slug, n = 3) => {
      const c = h.ctx.db.get<{ id: string }>("SELECT id FROM connections WHERE slug = ?", slug)!;
      for (let i = 0; i < n; i++) {
        h.ctx.db.run(
          "INSERT OR IGNORE INTO upstream_tools (connection_id, name, exposed_name, definition, pin_hash, risky, read, class_source, state, first_seen_at, updated_at) VALUES (?, ?, ?, '{\"inputSchema\":{}}', ?, 0, 1, 'heuristic', 'active', ?, ?)",
          c.id,
          `tool${i}`,
          `${slug}__tool${i}`,
          `h${i}`,
          new Date().toISOString(),
          new Date().toISOString(),
        );
      }
  };
  return {
    h,
    api: new ConnectionsApi(channel),
    channel,
    upstreams,
    agents: { hermes, claude },
    giveTools,
    async dispose() {
      channel.close();
      await h.dispose();
    },
  };
}

/** Every hostname resolves to a public address (TEST-NET-3), so tests never touch DNS. */
export const publicLookup = async () => [{ address: "203.0.113.10", family: 4 }];
