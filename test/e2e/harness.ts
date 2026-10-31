// End-to-end harness: the real server (startServer on port 0, temp data dir) wired to the in-memory
// fake Google, driven over real HTTP the way the console (admin API) and agents (MCP) use it. Nothing here reaches into services except `kick()` (ingest.kick, to avoid
// waiting for the 5 s minimum poll interval) and `ctx` for diagnostics.
//
//   const s = await startStack();
//   const [acc] = await s.bootstrap({ accounts: ["me@acme.test"] });
//   const { apiKey } = await s.createAgent("bot", [grant(acc.id, { capabilities: ["read"] })]);
//   const agent = await s.agent(apiKey);
//   s.fake.deliver("me@acme.test", { from: "a@b.test", subject: "Hi", text: "Hello" });
//   await s.waitForEvent((e) => e.message?.subject === "Hi");
//   await s.close();

import "./env.ts";
import "./features.ts"; // E2E_REQUIRE check
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, loadConfig } from "../../server/config.ts";
import type { AppContext } from "../../server/context.ts";
import { type RunningServer, startServer } from "../../server/server.ts";
import type { ServiceOverrides } from "../../server/wire.ts";
import type {
  Account,
  AgentWithKey,
  ApiError,
  ConnectAccountResponse,
  ExtraScopeName,
  GrantInput,
  MailEvent,
  Page,
  Settings,
} from "../../shared/types.ts";
import { FAKE_CLIENT, type FakeGoogle, startFakeGoogle } from "../fake-google.ts";
import { resilientFetch } from "./fetch.ts";
import { type Agent, connectAgent } from "./mcp.ts";
import { openSse, type SseStream } from "./sse.ts";
import { waitFor } from "./wait.ts";

export { FAKE_CLIENT };
export const PASSWORD = "correct horse battery staple";
export const VERSION = "0.0.0-e2e";

// ───────────── Admin (console) client ─────────────

/** A non-2xx console API response. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
    readonly path: string,
  ) {
    super(`${path} → HTTP ${status}: ${body?.error.code ?? "?"}: ${body?.error.message ?? ""}${body?.error.hint ? ` (hint: ${body.error.hint})` : ""}`);
  }
  get code(): string | undefined {
    return this.body?.error.code;
  }
}

export interface RequestOptions {
  method?: string;
  json?: unknown;
  headers?: Record<string, string>;
  /** Send the CSRF header (default true, like the console's fetch wrapper). */
  csrf?: boolean;
  /** Send the session cookie (default true). */
  cookie?: boolean;
}

/** Drives /api exactly like the browser console: session cookie + `x-xaq-csrf: 1`. */
export class AdminClient {
  cookie: string | null = null;

  constructor(private readonly base: () => string) {}

  get url(): string {
    return this.base();
  }

  /** Raw request (no status check). Captures a new session cookie when the server sets one. */
  async request(path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
    if (opts.csrf !== false) headers["x-xaq-csrf"] = "1";
    if (opts.cookie !== false && this.cookie) headers.cookie = this.cookie;
    if (opts.json !== undefined) headers["content-type"] = "application/json";
    const res = await resilientFetch(`${this.base()}${path}`, {
      method: opts.method ?? (opts.json !== undefined ? "POST" : "GET"),
      headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
      redirect: "manual",
    });
    const set = res.headers.get("set-cookie");
    if (set?.startsWith("aib_session=")) {
      const pair = set.split(";")[0]!;
      this.cookie = pair === "aib_session=" ? null : pair;
    }
    return res;
  }

  /** Request that throws ApiFailure on non-2xx; returns parsed JSON (or undefined for 204). */
  async call<T>(method: string, path: string, json?: unknown, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, { ...opts, method, json });
    const text = await res.text();
    if (!res.ok) {
      let body: ApiError | null = null;
      try {
        body = JSON.parse(text) as ApiError;
      } catch {
        // not JSON
      }
      throw new ApiFailure(res.status, body, `${method} ${path}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get = <T>(path: string) => this.call<T>("GET", path);
  post = <T>(path: string, json: unknown = {}) => this.call<T>("POST", path, json);
  put = <T>(path: string, json: unknown) => this.call<T>("PUT", path, json);
  patch = <T>(path: string, json: unknown) => this.call<T>("PATCH", path, json);
  del = (path: string) => this.call<void>("DELETE", path);

  /** Resolves with the ApiFailure a call is expected to produce (fails if it succeeds). */
  async failure(p: Promise<unknown>): Promise<ApiFailure> {
    try {
      await p;
    } catch (err) {
      if (err instanceof ApiFailure) return err;
      throw err;
    }
    throw new Error("Expected the request to fail, but it succeeded");
  }

  async claim(token: string, password = PASSWORD): Promise<void> {
    await this.call("POST", "/api/setup/claim", { token, password });
    if (!this.cookie) throw new Error("claim succeeded but no session cookie was set");
  }

  /** Console live stream (SSE) with this session. */
  stream(): Promise<SseStream> {
    return openSse(`${this.base()}/api/events/stream`, this.cookie ? { cookie: this.cookie } : {});
  }
}

// ───────────── Grants ─────────────

/** A full GrantInput with conservative defaults (read only, whole mailbox, draft_only). */
export function grant(accountId: string, patch: Partial<GrantInput> = {}): GrantInput {
  return {
    accountId,
    capabilities: ["read"],
    labelScope: null,
    sendMode: "draft_only",
    allowTo: [],
    replyOnly: false,
    maxSendsPerHour: null,
    maxSendsPerDay: null,
    ...patch,
  };
}

// ───────────── Stack ─────────────

export interface StackOptions {
  /** Share one fake Google between stacks (not closed by this stack). */
  fake?: FakeGoogle;
  /** Reuse a data dir (restart scenarios); otherwise a fresh temp dir that close() removes. */
  dataDir?: string;
  /** Service overrides passed to startServer (keep them real). */
  overrides?: ServiceOverrides;
}

export interface BootstrapOptions {
  /** Fake mailboxes to connect through the real OAuth flow, in order. */
  accounts?: (string | { email: string; name?: string })[];
  settings?: Partial<Settings>;
  /** false: connect mail-only, as installs from before Google Calendar did (PATCH /api/google/calendar first). */
  calendar?: boolean;
}

export class Stack {
  readonly admin: AdminClient;
  private running: RunningServer | null = null;
  private port = 0;

  private constructor(
    readonly fake: FakeGoogle,
    readonly dataDir: string,
    private readonly ownsFake: boolean,
    private readonly ownsDir: boolean,
  ) {
    this.admin = new AdminClient(() => this.url);
  }

  static async start(opts: StackOptions = {}): Promise<Stack> {
    const fake = opts.fake ?? (await startFakeGoogle());
    const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "xaq-e2e-"));
    const stack = new Stack(fake, dataDir, !opts.fake, !opts.dataDir);
    try {
      await stack.startServer(opts.overrides);
    } catch (err) {
      await stack.close();
      throw err;
    }
    return stack;
  }

  get server(): RunningServer {
    if (!this.running) throw new Error("server is not running");
    return this.running;
  }
  get url(): string {
    return this.server.url;
  }
  get ctx(): AppContext {
    return this.server.ctx;
  }
  get config(): Config {
    return this.server.ctx.config;
  }
  get isRunning(): boolean {
    return this.running !== null;
  }

  /** Starts the real server on this stack's data dir (same port as before when restarting). */
  async startServer(overrides?: ServiceOverrides): Promise<void> {
    if (this.running) return;
    const config = loadConfig({ dataDir: this.dataDir, host: "127.0.0.1", port: this.port }, VERSION);
    config.google = this.fake.google;
    this.running = await startServer({ config, overrides, webDir: join(this.dataDir, "no-web-build") });
    this.port = this.running.ctx.config.port;
  }

  async stopServer(): Promise<void> {
    const r = this.running;
    this.running = null;
    await r?.close();
  }

  async restart(overrides?: ServiceOverrides): Promise<void> {
    await this.stopServer();
    await this.startServer(overrides);
  }

  async close(): Promise<void> {
    await this.stopServer().catch(() => {});
    if (this.ownsFake) await this.fake.close().catch(() => {});
    if (this.ownsDir) rmSync(this.dataDir, { recursive: true, force: true });
  }

  setupToken(): string | null {
    try {
      return readFileSync(join(this.dataDir, "setup-token"), "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * First-run setup through the console API: claim with the setup token, configure the fake OAuth
   * client, connect accounts. Returns the connected accounts.
   */
  async bootstrap(opts: BootstrapOptions = {}): Promise<Account[]> {
    const token = this.setupToken();
    if (!token) throw new Error("no setup token in the data dir (already claimed?)");
    await this.admin.claim(token);
    await this.admin.put("/api/google/client", { ...FAKE_CLIENT, appType: "internal" });
    // Pin the public URL to the loopback IP: deterministic direct callbacks without relying on how
    // "localhost" resolves on this machine.
    await this.admin.patch("/api/settings", { publicUrl: this.url, pollIntervalSeconds: 5, ...opts.settings });
    if (opts.calendar === false) await this.admin.patch("/api/google/calendar", { enabled: false });
    const accounts: Account[] = [];
    for (const a of opts.accounts ?? []) {
      const spec = typeof a === "string" ? { email: a } : a;
      accounts.push(await this.connectAccount(spec.email, { name: spec.name }));
    }
    return accounts;
  }

  /**
   * Connects (or reconnects) a fake mailbox through the console API and the real OAuth flow: POST
   * /api/accounts/connect → the fake consent screen → redirect to /oauth/callback (direct mode), or
   * POST /api/accounts/connect/complete with the landed-on URL (paste mode).
   */
  async connectAccount(email: string, opts: { name?: string; reauthAccountId?: string; scopes?: ExtraScopeName[] } = {}): Promise<Account> {
    this.fake.addAccount(email, { name: opts.name });
    const start = await this.admin.post<ConnectAccountResponse>("/api/accounts/connect", {
      ...(opts.reauthAccountId ? { reauthAccountId: opts.reauthAccountId } : {}),
      ...(opts.scopes ? { scopes: opts.scopes } : {}),
    });
    this.fake.consentAs(email);
    const consent = await fetch(start.authUrl, { redirect: "manual" });
    const location = consent.headers.get("location");
    if (consent.status !== 302 || !location) throw new Error(`fake consent failed: HTTP ${consent.status} ${await consent.text()}`);
    if (start.callbackMode === "paste") return this.admin.post<Account>("/api/accounts/connect/complete", { url: location });
    const cb = await resilientFetch(location);
    const html = await cb.text();
    if (cb.status !== 200 || !html.includes("Account connected")) throw new Error(`OAuth callback failed: HTTP ${cb.status}\n${html.slice(0, 500)}`);
    const accounts = await this.admin.get<Account[]>("/api/accounts");
    const account = accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (!account) throw new Error(`${email} missing from /api/accounts after the callback`);
    return account;
  }

  createAgent(name: string, grants: GrantInput[] = [], description?: string): Promise<AgentWithKey> {
    return this.admin.post<AgentWithKey>("/api/agents", { name, description, grants });
  }

  /** An MCP client for an agent key. Closed by the caller. */
  agent(apiKey: string): Promise<Agent> {
    return connectAgent(this.url, apiKey);
  }

  /** Processes new Gmail history now instead of waiting for the poll interval. */
  kick(accountId?: string): void {
    this.ctx.ingest.kick(accountId);
  }

  /** Polls Google Calendar now instead of waiting for calendarPollSeconds (15 s at least). */
  kickCalendar(accountId?: string): void {
    this.ctx.calendar.kick(accountId);
  }

  async events(query: { accountId?: string; type?: string } = {}): Promise<MailEvent[]> {
    const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => !!e[1]));
    return (await this.admin.get<Page<MailEvent>>(`/api/events?${qs}`)).items;
  }

  /**
   * Waits until GET /api/events lists an event matching `pred`. It kicks ingest every
   * half second (pass `kick: false` to rely on the real poll loop); with `calendar`, it kicks the
   * calendar sync instead (calendar.* events).
   */
  async waitForEvent(pred: (e: MailEvent) => boolean, opts: { accountId?: string; timeout?: number; kick?: boolean; calendar?: boolean; what?: string } = {}): Promise<MailEvent> {
    let lastKick = 0;
    return waitFor(
      async () => {
        if (opts.kick ?? true) {
          if (Date.now() - lastKick > 500) {
            lastKick = Date.now();
            if (opts.calendar) this.kickCalendar(opts.accountId);
            else this.kick(opts.accountId);
          }
        }
        return (await this.events({ accountId: opts.accountId })).find(pred);
      },
      { timeout: opts.timeout ?? 8000, interval: 100, what: opts.what ?? "event in /api/events" },
    );
  }
}

export const startStack = (opts?: StackOptions) => Stack.start(opts);

/** Header value from a format=full Gmail message (fake inspection). */
export function gmailHeader(msg: { payload?: { headers?: { name: string; value: string }[] } }, name: string): string | undefined {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

let seq = 0;
/** Unique mailbox address per test, so tests sharing one stack never see each other's mail. */
export const mailbox = (tag: string) => `${tag}-${process.pid}-${++seq}@acme.test`;
