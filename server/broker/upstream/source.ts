import {
  type AuthProvider,
  type CallToolResult,
  Client,
  type FetchLike,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Tool,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { errorMessage } from "../../util/errors.ts";
import type { Logger } from "../../util/log.ts";
import { type Refresher, untilAborted } from "../credentials/refresher.ts";
import type { CredentialStore } from "../credentials/store.ts";
import {
  type PromptDef,
  type PromptResult,
  type PromptSource,
  type RefreshFn,
  type ResourceDef,
  type ResourceReadResult,
  type ResourceTemplateDef,
  SourceError,
  type ToolCallContext,
  type ToolDef,
  type ToolListing,
  type ToolResult,
  type ToolSource,
} from "../types.ts";
import { type ConnectionRow, formatVerdict, parseVerdict, type ProtocolVerdict } from "./connection.ts";
import { parseWwwAuthenticate } from "./discovery.ts";
import { originKey } from "./fetch.ts";

/** Per-call timeout (docs/MCP-BROKER.md "Transports"). */
export const CALL_TIMEOUT_MS = 60_000;
/** A cached legacy verdict is re-probed after this long (a server may have upgraded; the SDK can't tell). */
const VERDICT_TTL_MS = 24 * 3600_000;

export interface RemoteSourceDeps {
  connectionId: string;
  /** The current row; throws SourceError when the connection can't be used (disabled, needs_reauth). */
  connection: () => ConnectionRow & { url: string };
  fetch: FetchLike;
  store: CredentialStore;
  refresher: Refresher;
  /** OAuth connections: the refresh exchange. */
  refresh: RefreshFn | null;
  saveVerdict(v: string | null): void;
  log: Logger;
  clientInfo: { name: string; version: string };
  callTimeoutMs?: number;
}

interface Live {
  client: Client;
  verdict: ProtocolVerdict;
}

/** Walks `cause` chains for our own SourceError (thrown by the guarded fetch inside the SDK). */
function findSourceError(err: unknown): SourceError | null {
  for (let e: unknown = err, i = 0; e && i < 8; e = (e as { cause?: unknown }).cause, i++) {
    if (e instanceof SourceError) return e;
  }
  return null;
}

/**
 * ToolSource for a `remote_http` connection, on @modelcontextprotocol/client v2 (docs/adr/0001-mcp-client-sdk.md):
 * - Streamable HTTP with `versionNegotiation: auto` (2026 stateless or 2025 sessions), falling back to legacy
 *   HTTP+SSE when the POST is a non-MCP 404/405; the verdict is cached on the connection row;
 * - every request through the connection's guarded fetch; credentials injected here (static header, or an
 *   AuthProvider over the broker's single-flight Refresher), only towards the MCP URL's origin; the agent's
 *   own Authorization header never reaches this layer;
 * - no client capabilities declared; 60 s per call; the caller's AbortSignal cancels upstream.
 * One pooled client per connection (and credential: the runtime drops the source on reconnect).
 */
export class RemoteToolSource implements ToolSource {
  readonly connectionId: string;
  private live: Promise<Live> | null = null;
  private lastToken: string | undefined;
  private insufficientScope: string | null = null;
  private closed = false;
  /** The auth type the session was opened with: its requests carried that kind of credential (or none). */
  private openedAs: ConnectionRow["auth_type"] | null = null;

  constructor(private readonly deps: RemoteSourceDeps) {
    this.connectionId = deps.connectionId;
  }

  /** The fetch the SDK uses: the guarded fetch plus the static header (same origin only), watching 401/403. */
  private sdkFetch(conn: ConnectionRow & { url: string }): FetchLike {
    const origin = originKey(conn.url);
    return async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const headers = new Headers(init?.headers);
      if (originKey(url) !== origin) headers.delete("authorization");
      else if (conn.auth_type === "header") {
        const h = this.deps.store.header(conn.id);
        if (h) headers.set(h.name, h.value);
      }
      const res = await this.deps.fetch(url, { ...init, headers });
      if (res.status === 403) {
        const w = parseWwwAuthenticate(res.headers.get("www-authenticate"));
        if (w.error === "insufficient_scope") this.insufficientScope = w.scope ?? "";
      }
      return res;
    };
  }

  private authProvider(conn: ConnectionRow): AuthProvider | undefined {
    if (conn.auth_type !== "oauth") return undefined;
    const refresh = this.deps.refresh;
    if (!refresh) throw new SourceError("needs_reauth", `${conn.name} isn't signed in`);
    return {
      token: async () => {
        this.lastToken = await this.deps.refresher.accessToken(conn.id, refresh, AbortSignal.timeout(30_000));
        return this.lastToken;
      },
      // The transport retries once after this; a second 401 is a SdkHttpError (ClientHttpAuthentication).
      onUnauthorized: async () => {
        await this.deps.refresher.accessToken(conn.id, refresh, AbortSignal.timeout(30_000), { rejected: this.lastToken ?? "" });
      },
    };
  }

  private newClient(mode: "auto" | "legacy"): Client {
    // No capabilities: upstreams can't ask for elicitation, sampling or roots.
    return new Client(this.deps.clientInfo, { capabilities: {}, versionNegotiation: { mode } });
  }

  private async open(signal: AbortSignal): Promise<Live> {
    const conn = this.deps.connection();
    this.openedAs = conn.auth_type;
    const fetch = this.sdkFetch(conn);
    const authProvider = this.authProvider(conn);
    const url = new URL(conn.url);
    // The cached verdict skips the probe; it expires (a legacy server may have upgraded, and the SDK can't tell).
    const fresh = conn.protocol_checked_at && Date.now() - Date.parse(conn.protocol_checked_at) < VERDICT_TTL_MS;
    const cached = fresh ? parseVerdict(conn.protocol) : null;

    const viaSse = async (): Promise<Live> => {
      const client = this.newClient("legacy");
      await client.connect(new SSEClientTransport(url, { fetch, authProvider }), { signal, timeout: this.timeout });
      return { client, verdict: { transport: "sse", version: client.getNegotiatedProtocolVersion() ?? "2024-11-05" } };
    };

    if (cached?.transport === "sse") return this.remember(await viaSse());
    const client = this.newClient("auto");
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { fetch, authProvider }), {
        signal,
        timeout: this.timeout,
        ...(cached?.transport === "streamable" && !cached.modern ? { prior: { kind: "legacy" as const } } : {}),
      });
    } catch (err) {
      await client.close().catch(() => {});
      // A non-MCP 404/405 on the POST: a legacy HTTP+SSE server.
      if (err instanceof SdkHttpError && (err.status === 404 || err.status === 405) && !/-32\d{3}/.test(err.message)) return this.remember(await viaSse());
      throw err;
    }
    const version = client.getNegotiatedProtocolVersion() ?? "2025-11-25";
    return this.remember({ client, verdict: { transport: "streamable", version, modern: client.getProtocolEra() === "modern" } });
  }

  private remember(live: Live): Live {
    this.deps.saveVerdict(formatVerdict(live.verdict));
    return live;
  }

  private get timeout(): number {
    return this.deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
  }

  private async client(signal: AbortSignal): Promise<Live> {
    if (this.closed) throw new SourceError("unavailable", "This connection was closed");
    if (!this.live) {
      // Shared by concurrent callers: its own deadline, not the first caller's signal.
      const p = this.open(AbortSignal.timeout(this.timeout));
      this.live = p;
      p.catch(() => {
        if (this.live === p) this.live = null;
      });
    }
    return untilAborted(this.live, signal);
  }

  private async drop(): Promise<void> {
    const p = this.live;
    this.live = null;
    if (p) await p.then((l) => l.client.close()).catch(() => {});
  }

  /** Runs `op` on the pooled client; a lost 2025 session (404 after connect) reconnects once. */
  private async run<T>(signal: AbortSignal, op: (c: Client) => Promise<T>): Promise<T> {
    this.insufficientScope = null;
    try {
      let live: Live;
      try {
        live = await this.client(signal);
      } catch (err) {
        // A stale cached verdict: forget it and probe once more.
        if (this.deps.connection().protocol && !(findSourceError(err) || err instanceof UnauthorizedError) && !signal.aborted) {
          this.deps.saveVerdict(null);

          live = await this.client(signal);
        } else throw err;
      }
      try {
        return await op(live.client);
      } catch (err) {
        if (err instanceof SdkHttpError && err.status === 404 && live.verdict.transport === "streamable" && !live.verdict.modern) {
          await this.drop();
          return await op((await this.client(signal)).client);
        }
        throw err;
      }
    } catch (err) {
      throw this.mapError(err, signal);
    }
  }

  private mapError(err: unknown, signal: AbortSignal): unknown {
    if (signal.aborted) return signal.reason ?? err;
    let conn: ConnectionRow & { url: string };
    try {
      conn = this.deps.connection();
    } catch (gone) {
      // The connection went needs_reauth/disabled/away meanwhile: still drop the session, then say why.
      void this.drop();
      return findSourceError(gone) ?? gone;
    }
    const own = findSourceError(err);
    if (own) return own;
    const authFailed = this.insufficientScope !== null || err instanceof UnauthorizedError || (err instanceof SdkError && err.code === SdkErrorCode.ClientHttpAuthentication);
    // A refusal of a credential that is no longer the saved one says nothing about the saved one: the session was
    // dropped (a Connect saves the credential, then invalidates the source) or opened with another auth type (the first
    // listing of a just-created connection, sent without the key its Connect saves meanwhile). Never needs_reauth: the
    // listing that follows the Connect uses the new credential.
    if (authFailed && (this.closed || this.openedAs !== conn.auth_type)) {
      void this.drop();
      return new SourceError("unavailable", `${conn.name}'s credential changed while a request was in flight; the next one uses the new one`);
    }
    if (this.insufficientScope !== null) {
      const reason = `${conn.name} needs more access${this.insufficientScope ? ` (scope ${this.insufficientScope})` : ""}; widening it needs the owner to reconnect`;
      this.recordScope(this.insufficientScope);
      this.deps.store.markNeedsReauth(conn.id, reason);
      return new SourceError("needs_reauth", reason);
    }
    if (err instanceof UnauthorizedError || (err instanceof SdkError && err.code === SdkErrorCode.ClientHttpAuthentication)) {
      void this.drop();
      const reason =
        conn.auth_type === "header" ? `${conn.name} rejected the saved API key or token` : `${conn.name} rejected the sign-in even after a refresh`;
      if (conn.auth_type !== "none") this.deps.store.markNeedsReauth(conn.id, reason);
      return new SourceError("needs_reauth", reason);
    }
    if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return new SourceError("timeout", `${conn.name} didn't answer within ${this.timeout / 1000}s`);
    if (err instanceof SdkHttpError) {
      if (err.status === 429) {
        const ra = Number(err.data.retryAfter ?? err.data["retry-after"] ?? NaN);
        return new SourceError("rate_limited", `${conn.name} is rate limiting requests`, Number.isFinite(ra) ? ra * 1000 : undefined);
      }
      void this.drop();
      return new SourceError(err.status >= 500 ? "unavailable" : "protocol", `${conn.name} answered HTTP ${err.status}`);
    }
    if (err instanceof SdkError) {
      void this.drop();
      return new SourceError(err.code === SdkErrorCode.ConnectionClosed || err.code === SdkErrorCode.SendFailed ? "unavailable" : "protocol", `${conn.name}: ${err.message}`);
    }
    void this.drop();
    return new SourceError("unavailable", `${conn.name} is unreachable: ${errorMessage(err)}`);
  }

  /** insufficient_scope: keep the union of the scopes so the reconnect asks for all of them. */
  private recordScope(scope: string): void {
    const t = this.deps.store.tokens(this.connectionId);
    if (!t || !scope) return;
    const union = [...new Set([...(t.scope ?? "").split(/\s+/), ...scope.split(/\s+/)].filter(Boolean))].join(" ");
    this.deps.store.saveTokens(this.connectionId, { ...t, scope: union }, t.refreshToken);
  }

  async listTools(signal: AbortSignal): Promise<ToolListing> {
    return this.run(signal, async (c) => {
      const res = await c.listTools(undefined, { signal, timeout: this.timeout, cacheMode: "refresh" });
      const ttl = (res as { ttlMs?: unknown }).ttlMs;
      const instructions = c.getInstructions();
      return {
        tools: res.tools.map(toDef),
        ...(instructions ? { instructions } : {}),
        ...(typeof ttl === "number" && ttl >= 0 ? { ttlMs: ttl } : {}),
      };
    });
  }

  async callTool(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    const res = await this.run(ctx.signal, (c) => c.callTool({ name, arguments: args }, { signal: ctx.signal, timeout: this.timeout }));
    ctx.auditDetail.upstreamMs = Date.now() - started;
    return toResult(res);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.drop();
  }

  /** Prompts and resources (docs/EXTENSIONS.md "Prompts and resources"): empty when the server doesn't declare them. */
  readonly prompts: PromptSource = {
    listPrompts: (signal) =>
      this.run(signal, async (c) => (c.getServerCapabilities()?.prompts ? ((await c.listPrompts(undefined, { signal, timeout: this.timeout, cacheMode: "refresh" })).prompts as PromptDef[]) : [])),
    getPrompt: (name, args, signal) => this.run(signal, async (c) => (await c.getPrompt({ name, arguments: args }, { signal, timeout: this.timeout })) as PromptResult),
    listResources: (signal) =>
      this.run(signal, async (c) =>
        c.getServerCapabilities()?.resources ? ((await c.listResources(undefined, { signal, timeout: this.timeout, cacheMode: "refresh" })).resources as ResourceDef[]) : [],
      ),
    listResourceTemplates: (signal) =>
      this.run(signal, async (c) =>
        c.getServerCapabilities()?.resources
          ? ((await c.listResourceTemplates(undefined, { signal, timeout: this.timeout, cacheMode: "refresh" })).resourceTemplates as ResourceTemplateDef[])
          : [],
      ),
    readResource: (uri, signal) => this.run(signal, async (c) => (await c.readResource({ uri }, { signal, timeout: this.timeout, cacheMode: "refresh" })) as ResourceReadResult),
  };
}

export function toDef(t: Tool): ToolDef {
  return {
    name: t.name,
    ...(t.title ? { title: t.title } : {}),
    description: t.description ?? "",
    inputSchema: t.inputSchema as Record<string, unknown>,
    ...(t.outputSchema ? { outputSchema: t.outputSchema as Record<string, unknown> } : {}),
    ...(t.annotations ? { annotations: t.annotations } : {}),
  };
}

export function toResult(r: CallToolResult): ToolResult {
  if ((r as { resultType?: string }).resultType === "input_required") {
    return { content: [{ type: "text", text: "The upstream asked for more input, which the broker doesn't support." }], isError: true };
  }
  return {
    content: (r.content ?? []) as ToolResult["content"],
    ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
    ...(r.isError ? { isError: true } : {}),
  };
}
