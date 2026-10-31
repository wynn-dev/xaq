// Shared types of the MCP broker: tool sources (remote MCP servers and code extensions), presets,
// registered tools and stored tokens.

/** One choice per connection (and per agent × connection): Wynn's model. FROZEN. */
export type AccessLevel = "full" | "ask" | "read";

/** Where a tool's risk classification came from. FROZEN. */
export type ClassSource = "preset" | "annotation" | "heuristic";

/** Upstream tool annotations (MCP spec). Untrusted hints: they can mark a tool risky or read-only, never safe by name. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool definition as the source reports it (upstream or native), before cleaning and pinning. FROZEN. */
export interface ToolDef {
  /** The source's own name (exposed to agents as `<slug>__<name>`). */
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

/** Classification used by levels and approvals. FROZEN. */
export interface ToolClass {
  /** Irreversible: delete, send, publish/share externally, payments. Asks at the "ask" level. */
  risky: boolean;
  /** Listed at the "read" level. */
  read: boolean;
  source: ClassSource;
  /**
   * JSON Pointer (RFC 6901) into the call's arguments naming the target, offered for "always allow … for this
   * target" (e.g. `/page_ids`). Not dot paths: `{"a.b": x}` vs `{a: {b: y}}` must never be confused. The value may
   * be an array of ids; a rule matches only when every element is covered.
   */
  targetPath?: string;
}

/** A content block of a tool result (MCP CallToolResult content; kept SDK-agnostic). */
export type ContentBlock = { type: string; [key: string]: unknown };

/** A tool call's result as returned to the agent. FROZEN. */
export interface ToolResult {
  content: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Context for one call into a source. */
export interface ToolCallContext {
  agentId: string;
  connectionId: string;
  signal: AbortSignal;
  /** Non-sensitive audit detail the source may add (never arguments or secrets). */
  auditDetail: Record<string, unknown>;
}

/** The live tool list of a source (input to pinning). */
export interface ToolListing {
  tools: ToolDef[];
  /** Server instructions, if any (hashed and cleaned like descriptions). */
  instructions?: string;
  /** How long the listing may be cached (2026-07-28 `ttlMs`), if the source says. */
  ttlMs?: number;
}

/**
 * Tools of one connection: an upstream MCP server (proxied) or a native integration (e.g. WHOOP).
 * Errors: throw `SourceError` (below) for auth/availability problems; a tool-level failure is a ToolResult with
 * `isError: true`. FROZEN.
 */
export interface ToolSource {
  readonly connectionId: string;
  listTools(signal: AbortSignal): Promise<ToolListing>;
  callTool(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult>;
  /** Releases sessions/processes. Idempotent. */
  close(): Promise<void>;
  /**
   * Additive (extensions): the upstream's prompts and resources, passed
   * through /mcp. Optional: a source without them (or whose server doesn't declare the capability) has none. Errors as
   * for listTools (SourceError).
   */
  prompts?: PromptSource;
}

/** A prompt as the upstream lists it (MCP Prompt, SDK-agnostic). */
export interface PromptDef {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** A resource as the upstream lists it (MCP Resource, SDK-agnostic). */
export interface ResourceDef {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

/** A resource template as the upstream lists it (MCP ResourceTemplate, SDK-agnostic). */
export interface ResourceTemplateDef {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** prompts/get's result (MCP GetPromptResult): messages whose content blocks pass through. */
export interface PromptResult {
  description?: string;
  messages: { role: "user" | "assistant"; content: ContentBlock }[];
}

/** resources/read's result (MCP ReadResourceResult). */
export interface ResourceReadResult {
  contents: ({ uri: string; mimeType?: string } & ({ text: string } | { blob: string }))[];
}

/** Prompts and resources of one source (all "read" class). */
export interface PromptSource {
  listPrompts(signal: AbortSignal): Promise<PromptDef[]>;
  getPrompt(name: string, args: Record<string, string>, signal: AbortSignal): Promise<PromptResult>;
  listResources(signal: AbortSignal): Promise<ResourceDef[]>;
  listResourceTemplates(signal: AbortSignal): Promise<ResourceTemplateDef[]>;
  readResource(uri: string, signal: AbortSignal): Promise<ResourceReadResult>;
}

/** Why a source couldn't serve a call. `needs_reauth` also flips the connection's status (the credential store). FROZEN. */
export type SourceErrorCode = "needs_reauth" | "unavailable" | "timeout" | "blocked_target" | "rate_limited" | "protocol";

export class SourceError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

/** One step of a guided setup, rendered by both the console and the CLI wizard. */
export interface SetupStep {
  id: string;
  title: string;
  /** Plain words; no markdown beyond `code`. */
  body: string;
  link?: { label: string; url: string };
  /** A value to copy into another site (e.g. the redirect URI). */
  copy?: { label: string; value: string };
  /**
   * A value the user pastes back (e.g. a client ID/secret). Secrets are stored encrypted, never echoed. Additive
   * (Google extensions): `choices`, the values to pick from (the connected Google accounts), rendered as a choice.
   */
  input?: { key: string; label: string; secret?: boolean; pattern?: string; placeholder?: string; choices?: SetupChoice[] };
  /** Additive (Google extensions, rendered by core): Google APIs to turn on, each with its console page. */
  apis?: { service: string; label: string; url: string }[];
  /** Additive: the step has a "Check again" (google_apis: POST /api/connections/presets/:id/google-apis). */
  check?: "google_apis";
}

/** One value of a SetupStep input with choices. */
export interface SetupChoice {
  value: string;
  label: string;
  /** Shown next to it ("already has this access", "needs reconnecting"). */
  note?: string;
  /** Can't be picked now (an account that needs reconnecting first). */
  disabled?: boolean;
}

/** What a preset needs to know about the install to describe its setup. */
export interface SetupContext {
  publicUrl: string;
  /** Redirect URI for upstream OAuth (/oauth/connections/callback on this install). */
  redirectUri: string;
  /**
   * Inbound webhook URL, or null when nothing public reaches this install (server/broker/reachability.ts). Presets
   * poll either way (with webhooks it's the reconciliation poll), so a webhook step is always optional.
   */
  webhookUrl: string | null;
  /**
   * The optional Tailscale Funnel step: the install is tailnet-only on a *.ts.net name and the Tailscale CLI is
   * there. `command` exposes only the webhook path on `port`; once run, webhooks go to `webhookUrl`.
   */
  funnel?: { port: number; command: string; offCommand: string; webhookUrl: string } | null;
  /**
   * Additive (Google extensions): the install's Google Cloud project ID (null until the Google step of the setup
   * wizard is done), its OAuth app type, and xaq's connected Google accounts with the scopes each granted.
   */
  google?: {
    projectId: string | null;
    appType: "internal" | "external" | null;
    accounts: { id: string; email: string; needsReauth: boolean; scopes: readonly string[] }[];
  } | null;
}

/** OAuth facts for a preset whose provider needs the user's own app (WHOOP) or a known DCR server (Notion). */
export type PresetAuth =
  | { type: "none" }
  | { type: "header"; headerName: string; prefix?: string }
  /**
   * Remote MCP OAuth discovered from the server; registration by DCR or a metadata document (Notion). Additive, from
   * an extension manifest: `broadScopes`, granted scopes that mean broad access (T3's Full access; the console warns),
   * and `scopeNotes`, what a granted scope means, in priority order (the console shows the first granted one's note).
   */
  | { type: "mcp_oauth"; broadScopes?: readonly string[]; scopeNotes?: readonly { scope: string; note: string }[] }
  /**
   * Additive (official code extensions): the connection is
   * bound to one of xaq's connected Google accounts (connections.google_account_id) and gets access tokens downscoped
   * to `scopes`, added to the account by incremental consent. `apis` must be on in the user's Cloud project.
   */
  | { type: "google"; scopes: readonly string[]; apis: readonly { service: string; label: string }[] }
  /** Provider OAuth with the user's own app (WHOOP): fixed endpoints, client secret, no PKCE. */
  | {
      type: "user_app";
      authorizeUrl: string;
      tokenUrl: string;
      scopes: string[];
      /** Setup inputs that hold the client id / secret. */
      clientIdInput: string;
      clientSecretInput: string;
      /**
       * Additive (extensions): sent as `scope` on every refresh request when set (WHOOP: "offline", which its docs
       * require to renew the refresh token). Unset: no `scope`, the originally granted scope (RFC 6749 §6).
       */
      refreshScope?: string;
    };

/** A pre-made integration. Remote presets are proxied MCP servers; native ones provide their own ToolSource. FROZEN. */
export interface IntegrationPreset {
  id: string;
  displayName: string;
  /** Default connection slug (`[a-z0-9-]{1,24}`). */
  slug: string;
  kind: "remote_http" | "native";
  /** Remote presets: the MCP URL. */
  url?: string;
  auth: PresetAuth;
  /** The preset's own classification for a tool; null falls back to annotations + the generic heuristic. */
  classify(tool: ToolDef): ToolClass | null;
  setupSteps(ctx: SetupContext): SetupStep[];
  /** Native presets: build the tool source. `tokens` yields a fresh access token (refresh handled by the store). */
  createSource?(deps: NativeSourceDeps): ToolSource;
  /** Native presets with inbound events. */
  events?: NativeEvents;
  /**
   * Shown as dated warnings (e.g. Notion: 180-day cap, 30-day idle). `tokenLifetimeCapDays` (additive): a credential
   * without a refresh token lasts at most this long from its sign-in, and this long when the server doesn't say
   * (T3 Code: 30).
   */
  reconnectPolicy?: { maxLifetimeDays?: number; idleDays?: number; tokenLifetimeCapDays?: number };
  /**
   * Additive (T3 Code): a remote preset with no fixed `url`, where the user names the server (one connection per
   * server). `defaultPath` is appended when only an origin is given; with `sameOriginIssuer` the authorization server
   * must be that server's own origin (the approval page the user types a pairing code into is never elsewhere).
   */
  userServer?: { defaultPath: string; sameOriginIssuer: boolean };
  /**
   * Additive (T3 Code): exact tool names whose risky-verb name match is a reviewed false positive (`t3_thread_send`
   * posts to one of T3's own threads). `classify`'s answer is final for these names only: a new or renamed tool still
   * gets the name check.
   */
  nameCheckExempt?: readonly string[];
  /**
   * Additive (extensions): from the official registry (or core). A third-party preset can only make tools stricter
   * than the generic rules, and the picker marks it. Undefined counts as official (core presets).
   */
  official?: boolean;
}

export interface NativeSourceDeps {
  connectionId: string;
  accessToken(signal: AbortSignal): Promise<string>;
  fetch: typeof fetch;
  log: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
  /**
   * Additive (code extensions, server/extensions/host): the broker's wiring supplies these; a preset that doesn't
   * need them ignores them.
   * - `tokenExpiresAt`: epoch ms of the current access token's expiry (after `accessToken`), null when unknown.
   * - `emit`: an IntegrationEvent into the events outbox (only the preset's own `<id>.*` types for this connection
   *   get through, as for native events).
   * - `dataDir`: the install's data directory (code extensions keep per-connection state under it).
   * - `setError`: marks the connection `error` with a reason shown in the console (null clears an error this source
   *   set, back to `active`).
   */
  tokenExpiresAt?(): number | null;
  emit?(e: IntegrationEvent): void;
  dataDir?: string;
  setError?(reason: string | null): void;
}

/** An event a native integration emits (e.g. `example.item_updated`), delivered through the events outbox. */
export interface IntegrationEvent {
  /** `<preset>.<name>`, e.g. `example.item_updated`. */
  type: string;
  connectionId: string;
  /** Dedupe key unique per occurrence (e.g. WHOOP trace_id). */
  dedupeKey: string;
  /** Small, non-secret data; content an agent fetches with tools. */
  data: Record<string, unknown>;
}

export interface NativeEvents {
  /** Event types this preset may emit. */
  types: string[];
  /** Verifies and parses an inbound webhook; null when the signature is bad (respond 401, emit nothing). */
  handleWebhook?(req: { headers: Record<string, string>; rawBody: Buffer }, deps: NativeSourceDeps & { clientSecret: string }): Promise<IntegrationEvent[] | null>;
  /** Polling fallback without a public URL; returns new events since `cursor` and the next cursor. */
  poll?(cursor: string | null, deps: NativeSourceDeps): Promise<{ events: IntegrationEvent[]; cursor: string | null }>;
  pollIntervalMs?: number;
}

/** A tool as an agent sees it: pinned, cleaned, classified, with the agent's level applied. FROZEN. */
export interface RegisteredTool {
  /** `<slug>__<name>`. */
  exposedName: string;
  connectionId: string;
  slug: string;
  /** The pinned, cleaned definition. */
  def: ToolDef;
  cls: ToolClass;
  /** This agent's level for the connection. */
  level: AccessLevel;
  pinHash: string;
}

/** The policy's verdict on one call. FROZEN. */
export type CallDecision =
  /** `ruleId`: the "always allow" rule that let a risky call through at the "ask" level (audit). */
  | { kind: "allow"; ruleId?: string }
  | { kind: "ask" }
  | { kind: "deny"; reason: string; message: string };

export interface BrokerPolicy {
  /** Level + risk + "always allow" rules + caps. Never runs the call. */
  decide(agentId: string, tool: RegisteredTool, args: Record<string, unknown>): CallDecision;
}

/** OAuth tokens as stored (encrypted at rest). */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms; null when the provider didn't say. */
  expiresAt: number | null;
  scope: string | null;
  issuer: string | null;
  /** Epoch ms when the access token was issued (for the 10 %-of-lifetime refresh window). Additive. */
  issuedAt?: number | null;
}

/** Exchanges the current tokens for new ones; throws `SourceError("needs_reauth")` on invalid_grant/invalid_client. */
export type RefreshFn = (current: StoredTokens, signal: AbortSignal) => Promise<StoredTokens>;
