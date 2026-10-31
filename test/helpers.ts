// The test harness: a wired context on a temp database (testContext); the HTTP app on it with a claimed console
// (harness); and the in-process Google (test/fake-google.ts) with the real policy: mailTestContext,
// calendarTestContext, grants, MCP clients and tool calls.

import type { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Account, GrantInput, IngestStatus, MailEvent } from "../shared/types.ts";
import { CALENDAR_SCOPES, MAIL_SCOPES } from "../shared/google-scopes.ts";
import { AgentCalendar } from "../server/calendar/agent.ts";
import { createCalendarService } from "../server/calendar/index.ts";
import type { AppEnv } from "../server/api/util.ts";
import { type AppOptions, createApp } from "../server/app.ts";
import { readSetupToken } from "../server/auth/setup-token.ts";
import type { CalendarService } from "../server/calendar/types.ts";
import { type Config, loadConfig } from "../server/config.ts";
import type { AppContext } from "../server/context.ts";
import type { EventsService, FeedOptions, FeedResult } from "../server/events/types.ts";
import type { AccountsService, GoogleService } from "../server/google/types.ts";
import type { IngestService } from "../server/ingest/index.ts";
import { AgentMail, ToolError, type ToolTrace } from "../server/mail/agent.ts";
import { buildMcpServer } from "../server/mcp/server.ts";
import { PolicyDenied } from "../server/util/errors.ts";
import { createAppContext, type ServiceOverrides, stopServices } from "../server/wire.ts";
import { calendarInfoOf, FakeCalendarClient, fakeGoogle, FakeGoogleService } from "./fake-google.ts";

/** A config rooted in a fresh temp data dir. Pass `google` to point at test/fake-google.ts. */
export function testConfig(patch: Partial<Config> = {}): Config {
  const dataDir = mkdtempSync(join(tmpdir(), "xaq-test-"));
  return { ...loadConfig({ dataDir, host: "127.0.0.1", port: 0 }, "0.0.0-test"), ...patch };
}

/** A fully wired context on a temp database. Call `dispose()` in afterEach/afterAll. */
export function testContext(overrides: ServiceOverrides = {}, patch: Partial<Config> = {}) {
  const ctx: AppContext = createAppContext(testConfig(patch), overrides);
  return {
    ctx,
    async dispose() {
      await stopServices(ctx);
      rmSync(ctx.config.dataDir, { recursive: true, force: true });
    },
  };
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string | null;
  status: Account["status"];
  /** "active" gives the account Google Calendar (Account.calendar); NULL = mail only. */
  calendar_status: string | null;
  created_at: string;
}

/** Accounts repo over the real accounts table. */
export function fakeAccounts(ctx: AppContext): AccountsService {
  const toAccount = (r: AccountRow): Account => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    status: r.status,
    lastError: null,
    historyId: null,
    lastSyncAt: null,
    createdAt: r.created_at,
    refreshTokenExpiresAt: null,
    refreshTokenExpiryKind: null,
    workspaceDomain: null,
    grantedScopes: null,
    calendar: r.calendar_status === "active" ? { status: "active", missingScopes: [], lastSyncAt: null, error: null } : null,
  });
  const get = (id: string) => {
    const r = ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
    return r ? toAccount(r) : null;
  };
  return {
    list: () => ctx.db.all<AccountRow>("SELECT * FROM accounts").map(toAccount),
    get,
    require: (id) => get(id)!,
    getByEmail: (email) => {
      const r = ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE email = ?", email);
      return r ? toAccount(r) : null;
    },
    setStatus: (id, status) => {
      ctx.db.run("UPDATE accounts SET status = ? WHERE id = ?", status, id);
      return get(id)!;
    },
    remove: async (id) => {
      ctx.db.run("DELETE FROM accounts WHERE id = ?", id);
    },
  };
}

/** Event feed fake: serves `events` filtered by the agent's visibility, records acks. */
export class FakeEvents {
  events: MailEvent[] = [];
  acked = new Map<string, number>();
  feedCalls: FeedOptions[] = [];

  service(ctx: AppContext): EventsService {
    const feed = (agentId: string, opts: FeedOptions = {}): FeedResult => {
      this.feedCalls.push(opts);
      const ackedSeq = this.acked.get(agentId) ?? 0;
      const after = opts.after ?? ackedSeq;
      const events = this.events
        .filter((e) => e.seq > after)
        .filter((e) => !opts.types || opts.types.includes(e.type))
        .filter((e) => !opts.accountIds || opts.accountIds.includes(e.accountId))
        .filter((e) => ctx.policy.canSeeEvent(agentId, { accountId: e.accountId, type: e.type }))
        .slice(0, opts.limit ?? 50);
      const result: FeedResult & { hasMore: boolean } = { events, cursor: events.at(-1)?.seq ?? after, ackedSeq, hasMore: false };
      return result;
    };
    const service: Pick<EventsService, "feed" | "wait" | "ack"> = {
      feed,
      wait: async (agentId, opts) => feed(agentId, opts),
      ack: (agentId, seq) => {
        this.acked.set(agentId, seq);
        return { ackedSeq: seq };
      },
    };
    return service as EventsService;
  }
}

export const grantInput = (accountId: string, patch: Partial<GrantInput> = {}): GrantInput => ({ accountId, level: "read", allowTo: [], ...patch });

// ───────────── The app over HTTP ─────────────

export const CSRF = { "x-xaq-csrf": "1" };
export const PASSWORD = "correct horse battery";

export function fakeIngest(status: Partial<IngestStatus> = {}): () => IngestService {
  return () => ({ status: () => ({ running: true, lastPullAt: null, lastError: null, ...status }) }) as unknown as IngestService;
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

// ───────────── In-process Google, real policy ─────────────

/** A context with fake Google, accounts, ingest and events, plus helpers. */
export function mailTestContext() {
  const google = new FakeGoogleService();
  const events = new FakeEvents();
  const kicks: (string | undefined)[] = [];
  const t = testContext({
    google: () => google.service(),
    accounts: (ctx) => fakeAccounts(ctx),
    events: (ctx) => events.service(ctx),
    ingest: () => ({ kick: (id?: string) => void kicks.push(id) }) as unknown as IngestService,
  });
  const { ctx } = t;
  const addAccount = (id: string, email: string, status: Account["status"] = "active") => {
    ctx.db.run(
      "INSERT INTO accounts (id, email, display_name, status, refresh_token_enc, created_at) VALUES (?, ?, ?, ?, 'x', ?)",
      id,
      email,
      "Test User",
      status,
      new Date().toISOString(),
    );
    return google.gmail(id);
  };
  const addAgent = (name: string, grants: GrantInput[]) => ctx.policy.createAgent({ name, grants });
  return { ...t, google, events, kicks, addAccount, addAgent };
}

/** An SDK client connected in-process to the agent's MCP server. */
export async function connectAgent(ctx: AppContext, agentId: string, name = "agent") {
  const server = buildMcpServer(ctx, { agentId, name });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    const content = r.content as { type: string; text?: string }[];
    return { isError: !!r.isError, text: content.map((c) => c.text ?? "").join("\n"), content };
  };
  return { client, call, close: () => client.close() };
}

/**
 * A wired context with fake Gmail and Calendar, the real accounts repo and policy, and the real calendar
 * service with sync stubbed out (kicks recorded) and `calendars` answered from the fake's list.
 */
export function calendarTestContext() {
  const google = new FakeGoogleService();
  const fakes = new Map<string, FakeCalendarClient>();
  const kicks: [string | undefined, string | undefined][] = [];
  const t = testContext({
    google: () => {
      const base = google.service();
      return new Proxy(base, {
        get: (target, prop) => (prop === "calendar" ? (id: string) => fakes.get(id)! : Reflect.get(target, prop)),
      }) as GoogleService;
    },
    ingest: () => ({ kick: () => {} }) as unknown as IngestService,
    calendar: (ctx): CalendarService => ({
      ...createCalendarService(ctx),
      kick: (accountId, calendarId) => void kicks.push([accountId, calendarId]),
      calendars: async (accountId) => (await fakes.get(accountId)!.listCalendars()).map(calendarInfoOf),
    }),
  });
  const { ctx } = t;

  /** An account; `calendar: false` leaves it mail-only (no calendar scopes granted). */
  const addAccount = (id: string, email: string, opts: { calendar?: boolean } = {}) => {
    const scopes = opts.calendar === false ? MAIL_SCOPES : [...MAIL_SCOPES, ...CALENDAR_SCOPES];
    ctx.db.run(
      "INSERT INTO accounts (id, email, display_name, status, refresh_token_enc, scopes, created_at) VALUES (?, ?, 'Me', 'active', 'x', ?, ?)",
      id,
      email,
      JSON.stringify(scopes),
      new Date().toISOString(),
    );
    const fake = new FakeCalendarClient(id, email);
    fakes.set(id, fake);
    google.gmail(id);
    return fake;
  };

  return { ...t, google, fakes, kicks, addAccount };
}

export interface ToolCall<T> {
  value?: T;
  error?: unknown;
  outcome: "ok" | "denied" | "error";
  reason: string | null;
  detail: Record<string, unknown>;
}

/**
 * Runs an action the way an MCP tool handler does (server/mcp/server.ts register): one trace, the audit
 * entry recorded under `action`, then the send-cap reservation released.
 */
export async function tool<T>(
  ctx: AppContext,
  agentId: string,
  action: string,
  fn: (cal: AgentCalendar, mail: AgentMail) => Promise<T>,
): Promise<ToolCall<T>> {
  const trace: ToolTrace = { detail: {} };
  const principal = { agentId, name: "agent" };
  let r: ToolCall<T>;
  try {
    const value = await fn(new AgentCalendar(ctx, principal, trace), new AgentMail(ctx, principal, trace));
    r = { value, outcome: "ok", reason: null, detail: trace.detail };
  } catch (error) {
    const outcome = error instanceof PolicyDenied ? "denied" : "error";
    const reason = error instanceof PolicyDenied ? error.reason : error instanceof ToolError ? error.code : "internal";
    r = { error, outcome, reason, detail: trace.detail };
  }
  ctx.audit.record({
    actorType: "agent",
    actorId: agentId,
    action,
    accountId: trace.accountId ?? null,
    target: trace.target ?? null,
    outcome: r.outcome,
    reason: r.reason,
    detail: Object.keys(trace.detail).length ? trace.detail : null,
  });
  return r;
}

/** The error message of a failed call (for asserting plain-words denials). */
export const messageOf = (r: ToolCall<unknown>): string => (r.error instanceof Error ? r.error.message : "");
