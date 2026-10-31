// The policy/MCP/mail test harness: in-process Google (test/fake-google.ts), the accounts repo, events and grants.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Account, GrantInput, MailEvent } from "../shared/types.ts";
import type { AppContext } from "../server/context.ts";
import type { EventsService, FeedOptions, FeedResult } from "../server/events/types.ts";
import type { AccountsService } from "../server/google/types.ts";
import type { IngestService } from "../server/ingest/index.ts";
import { buildMcpServer } from "../server/mcp/server.ts";
import { FakeGoogleService } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

export { decodeRaw, type FakeGmail, FakeGoogleService as FakeGoogle } from "./fake-google.ts";

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
      // `hasMore` is additive in the events contract (feat/events-webhooks); harmless before it lands.
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
