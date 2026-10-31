import type {
  AccessLevel,
  Agent,
  ConnectionGrant,
  ConnectionProbe,
  ConnectionView,
  CreateConnectionInput,
  GoogleApiCheckView,
  PresetView,
  StartConnectInput,
  StartConnectResult,
} from "../../shared/types.ts";
import { AdminApiError, type AdminChannel } from "./admin.ts";

/**
 * The admin connections API (server/api/connections.ts, DTOs in shared/types.ts) as the CLI uses it. While the
 * `brokerUpstreams` setting is off every /api/connections route answers 404; the CLI says so in plain words.
 */

export type { ConnectionProbe, ConnectionView, PresetView, StartConnectResult };

/** The routes aren't there: an older daemon, or brokerUpstreams is off. */
export class BrokerOffError extends Error {
  constructor() {
    super(
      "This xaq doesn't have connections turned on yet (the brokerUpstreams setting), or is older than this CLI. " +
        "Update it, turn connections on in the console's Settings, then run this again.",
    );
    this.name = "BrokerOffError";
  }
}

const enc = encodeURIComponent;

export class ConnectionsApi {
  constructor(readonly channel: AdminChannel) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.channel.request<T>(method, path, body);
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 404 && err.code === "not_found" && path.startsWith("/api/connections")) throw new BrokerOffError();
      throw err;
    }
  }

  list(): Promise<ConnectionView[]> {
    return this.call("GET", "/api/connections");
  }
  presets(): Promise<PresetView[]> {
    return this.call("GET", "/api/connections/presets");
  }
  /** With `connectionId`, the probe uses that connection's private-target allow (when it covers the URL). */
  probe(url: string, connectionId?: string): Promise<ConnectionProbe> {
    return this.call("POST", "/api/connections/probe", connectionId ? { url, connectionId } : { url });
  }
  create(input: CreateConnectionInput): Promise<ConnectionView> {
    return this.call("POST", "/api/connections", input);
  }
  get(id: string): Promise<ConnectionView> {
    return this.call("GET", `/api/connections/${enc(id)}`);
  }
  /** A Google extension's "Check again": is each of its Google APIs on in the project, checked as `account`? */
  googleApis(presetId: string, account: string): Promise<GoogleApiCheckView[]> {
    return this.call("POST", `/api/connections/presets/${enc(presetId)}/google-apis`, { account });
  }
  /** Stores a static header (and connects), or starts OAuth and returns the authorize URL. */
  connect(id: string, input: StartConnectInput = {}): Promise<StartConnectResult> {
    return this.call("POST", `/api/connections/${enc(id)}/connect`, input);
  }
  /** The admin-only private-target allow, pinned server-side to the URL's exact scheme://host:port. */
  allowPrivateTarget(id: string, allow: boolean): Promise<ConnectionView> {
    return this.call("PUT", `/api/connections/${enc(id)}/private-target`, { allow });
  }
  /** The kill switch: disabled at once, pending calls cancelled, credentials deleted. */
  kill(id: string): Promise<void> {
    return this.call("POST", `/api/connections/${enc(id)}/kill`, {});
  }
  /** PATCH: a new slug renames the exposed tools (`<slug>__<tool>`). */
  update(id: string, patch: { slug?: string; name?: string }): Promise<ConnectionView> {
    return this.call("PATCH", `/api/connections/${enc(id)}`, patch);
  }
  remove(id: string): Promise<void> {
    return this.call("DELETE", `/api/connections/${enc(id)}`);
  }
  async bySlug(slug: string): Promise<ConnectionView> {
    const all = await this.list();
    const found = all.find((c) => c.slug === slug);
    if (!found) throw new Error(`No connection "${slug}". ${all.length ? `There are: ${all.map((c) => c.slug).join(", ")}.` : "There are none yet."}`);
    return found;
  }
  grants(id: string): Promise<ConnectionGrant[]> {
    return this.call("GET", `/api/connections/${enc(id)}/grants`);
  }
  /** The full list: agents not in it lose access. */
  setGrants(id: string, grants: { agentId: string; level: AccessLevel }[]): Promise<ConnectionGrant[]> {
    return this.call("PUT", `/api/connections/${enc(id)}/grants`, { grants });
  }
  agents(): Promise<Agent[]> {
    return this.channel.request("GET", "/api/agents");
  }

  /** Paste mode: the address the browser landed on after approving (the daemon checks state and issuer). */
  async finish(url: string): Promise<StartConnectResult> {
    try {
      return await this.call<StartConnectResult>("POST", "/api/connections/finish", { url });
    } catch (err) {
      // A refused sign-in is a 400 carrying a StartConnectResult, not the usual error envelope.
      const body = err instanceof AdminApiError ? (err.body as StartConnectResult | null) : null;
      if (body?.status === "error") return body;
      throw err;
    }
  }
}
