// In-memory fakes of the Google domain (GmailClient, MimeTools, labels) and the accounts repo for the
// policy/MCP/mail tests. Shapes follow server/google/types.ts and the Gmail REST API.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Account, Address, GmailLabel, GrantInput, MailEvent } from "../shared/types.ts";
import type { AppContext } from "../server/context.ts";
import type { EventsService, FeedOptions, FeedResult } from "../server/events/types.ts";
import {
  type AccountsService,
  type ComposeInput,
  type GmailClient,
  type GmailDraft,
  type GmailMessage,
  type GmailPart,
  type GmailThread,
  GoogleApiError,
  type GoogleService,
  type MimeTools,
  type ParsedMessage,
} from "../server/google/types.ts";
import type { IngestService } from "../server/ingest/index.ts";
import { buildMcpServer } from "../server/mcp/server.ts";
import { testContext } from "./helpers.ts";

export interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  from: Address;
  to: Address[];
  cc?: Address[];
  replyTo?: Address[];
  subject: string;
  date?: string;
  text?: string;
  html?: string;
  messageId?: string;
  references?: string[];
  authResults?: string;
  attachments?: { id: string; filename: string; mimeType: string; data: Buffer }[];
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const fmt = (a: Address) => (a.name ? `"${a.name}" <${a.email}>` : a.email);

export const SYSTEM_LABELS: GmailLabel[] = ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT"].map((id) => ({
  id,
  name: id,
  type: "system",
}));

export class FakeGmail implements GmailClient {
  readonly messages = new Map<string, FakeMessage>();
  readonly drafts = new Map<string, { id: string; raw: string; threadId: string | null }>();
  readonly sent: { raw: string; threadId: string | null; id: string }[] = [];
  readonly queries: (string | undefined)[] = [];
  readonly searchLabelIds: (string[] | undefined)[] = [];
  labels: GmailLabel[] = [...SYSTEM_LABELS];
  /** Returned by listThreads, to test pagination. */
  nextPageToken: string | null = null;
  /** Errors thrown (once each) by the next sendDraft calls. */
  sendDraftErrors: Error[] = [];
  private seq = 0;

  constructor(readonly accountId: string) {}

  add(m: FakeMessage): this {
    this.messages.set(m.id, { cc: [], ...m });
    return this;
  }

  private toGmail(m: FakeMessage, format: string): GmailMessage {
    const base: GmailMessage = { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds], snippet: (m.text ?? m.subject).slice(0, 80) };
    if (format === "minimal") return base;
    const headers = [
      { name: "From", value: fmt(m.from) },
      { name: "To", value: m.to.map(fmt).join(", ") },
      ...(m.cc?.length ? [{ name: "Cc", value: m.cc.map(fmt).join(", ") }] : []),
      ...(m.replyTo?.length ? [{ name: "Reply-To", value: m.replyTo.map(fmt).join(", ") }] : []),
      { name: "Subject", value: m.subject },
      { name: "Date", value: m.date ?? "Tue, 14 Oct 2026 09:00:00 +0000" },
      { name: "Message-ID", value: m.messageId ?? `<${m.id}@mail.example>` },
      ...(m.references?.length ? [{ name: "References", value: m.references.join(" ") }] : []),
      ...(m.authResults ? [{ name: "Authentication-Results", value: m.authResults }] : []),
    ];
    const alt: GmailPart[] = [];
    if (m.text !== undefined) alt.push({ partId: "0.0", mimeType: "text/plain", body: { size: m.text.length, data: b64(m.text) } });
    if (m.html !== undefined) alt.push({ partId: "0.1", mimeType: "text/html", body: { size: m.html.length, data: b64(m.html) } });
    const attachments: GmailPart[] = (m.attachments ?? []).map((a, i) => ({
      partId: String(i + 1),
      mimeType: a.mimeType,
      filename: a.filename,
      body: { attachmentId: a.id, size: a.data.length },
    }));
    return {
      ...base,
      payload: {
        mimeType: "multipart/mixed",
        headers,
        body: { size: 0 },
        parts: [{ partId: "0", mimeType: "multipart/alternative", body: { size: 0 }, parts: alt }, ...attachments],
      },
    };
  }

  private need(id: string): FakeMessage {
    const m = this.messages.get(id);
    if (!m) throw new GoogleApiError(404, "Requested entity was not found.", "notFound");
    return m;
  }

  private threadMessages(id: string): FakeMessage[] {
    const msgs = [...this.messages.values()].filter((m) => m.threadId === id);
    if (!msgs.length) throw new GoogleApiError(404, "Requested entity was not found.", "notFound");
    return msgs;
  }

  async getProfile() {
    return { emailAddress: "", messagesTotal: this.messages.size, threadsTotal: 0, historyId: "1" };
  }

  async listMessages() {
    return { messages: [...this.messages.values()].map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: null, resultSizeEstimate: this.messages.size };
  }

  /** Ignores the query and label filter (records them) so post-filtering is exercised. */
  async listThreads(p: { q?: string; labelIds?: string[]; maxResults?: number; pageToken?: string }) {
    this.queries.push(p.q);
    this.searchLabelIds.push(p.labelIds);
    const ids = [...new Set([...this.messages.values()].map((m) => m.threadId))].slice(0, p.maxResults ?? 100);
    return { threads: ids.map((id) => ({ id, snippet: "", historyId: "1" })), nextPageToken: this.nextPageToken, resultSizeEstimate: ids.length };
  }

  async getMessage(id: string, format = "full") {
    return this.toGmail(this.need(id), format);
  }

  async getThread(id: string, format: "full" | "metadata" | "minimal" = "full"): Promise<GmailThread> {
    return { id, messages: this.threadMessages(id).map((m) => this.toGmail(m, format)) };
  }

  async getAttachment(messageId: string, attachmentId: string) {
    const a = this.need(messageId).attachments?.find((x) => x.id === attachmentId);
    if (!a) throw new GoogleApiError(404, "Attachment not found", "notFound");
    return { data: a.data.toString("base64url"), size: a.data.length };
  }

  async listLabels() {
    return this.labels.map((l) => ({ ...l }));
  }

  async modifyMessage(id: string, add: string[], remove: string[]) {
    const m = this.need(id);
    m.labelIds = [...new Set([...m.labelIds.filter((l) => !remove.includes(l)), ...add])];
    return this.toGmail(m, "minimal");
  }

  async modifyThread(id: string, add: string[], remove: string[]) {
    for (const m of this.threadMessages(id)) await this.modifyMessage(m.id, add, remove);
    return this.getThread(id, "minimal");
  }

  async trashMessage(id: string) {
    return this.modifyMessage(id, ["TRASH"], ["INBOX"]);
  }

  async trashThread(id: string) {
    return this.modifyThread(id, ["TRASH"], ["INBOX"]);
  }

  async send(raw: string, threadId?: string | null) {
    const id = `sent${++this.seq}`;
    this.sent.push({ raw, threadId: threadId ?? null, id });
    return { id, threadId: threadId ?? `t-${id}`, labelIds: ["SENT"] };
  }

  async createDraft(raw: string, threadId?: string | null): Promise<GmailDraft> {
    const id = `r-${++this.seq}`;
    this.drafts.set(id, { id, raw, threadId: threadId ?? null });
    return { id, message: { id: `dm${this.seq}`, threadId: threadId ?? `t-dm${this.seq}`, labelIds: ["DRAFT"] } };
  }

  async getDraft(id: string): Promise<GmailDraft> {
    const d = this.drafts.get(id);
    if (!d) throw new GoogleApiError(404, "Draft not found", "notFound");
    // Real drafts.get returns the full message; the body here mirrors the raw so edits change it.
    return { id, message: { id: `dm-${id}`, threadId: d.threadId ?? "t", payload: { mimeType: "text/plain", headers: [], body: { size: d.raw.length, data: d.raw } } } };
  }

  async sendDraft(id: string) {
    const err = this.sendDraftErrors.shift();
    if (err) throw err;
    const d = this.drafts.get(id);
    if (!d) throw new GoogleApiError(404, "Draft not found", "notFound");
    this.drafts.delete(id);
    return this.send(d.raw, d.threadId);
  }

  async deleteDraft(id: string) {
    if (!this.drafts.delete(id)) throw new GoogleApiError(404, "Draft not found", "notFound");
  }

  listHistory(): never {
    throw new Error("not used");
  }
  watch(): never {
    throw new Error("not used");
  }
  stopWatch(): never {
    throw new Error("not used");
  }
}

export function parseAddressList(value: string | null | undefined): Address[] {
  if (!value) return [];
  const out: Address[] = [];
  for (const part of value.match(/(?:"[^"]*"|[^,])+/g) ?? []) {
    const s = part.trim();
    if (!s) continue;
    const m = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(s);
    out.push(m ? { name: m[1]?.trim() || null, email: m[2]!.trim() } : { name: null, email: s });
  }
  return out;
}

const headerMap = (msg: GmailMessage) => Object.fromEntries((msg.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));

function walk(part: GmailPart | undefined, fn: (p: GmailPart) => void) {
  if (!part) return;
  fn(part);
  for (const p of part.parts ?? []) walk(p, fn);
}

export class FakeMime implements MimeTools {
  readonly composed: ComposeInput[] = [];

  summarize(msg: GmailMessage) {
    const h = headerMap(msg);
    let hasAttachments = false;
    walk(msg.payload, (p) => {
      if (p.filename) hasAttachments = true;
    });
    return {
      id: msg.id,
      threadId: msg.threadId,
      from: parseAddressList(h.from)[0] ?? null,
      to: parseAddressList(h.to),
      cc: parseAddressList(h.cc),
      subject: h.subject ?? "",
      snippet: msg.snippet ?? "",
      date: h.date ? new Date(h.date).toISOString() : "",
      labelIds: msg.labelIds ?? [],
      hasAttachments,
    };
  }

  parse(msg: GmailMessage): ParsedMessage {
    const h = headerMap(msg);
    let text: string | null = null;
    let html: string | null = null;
    const attachments: ParsedMessage["attachments"] = [];
    walk(msg.payload, (p) => {
      if (p.filename && p.body.attachmentId) attachments.push({ id: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType, size: p.body.size });
      else if (p.mimeType === "text/plain" && p.body.data) text = Buffer.from(p.body.data, "base64url").toString("utf8");
      else if (p.mimeType === "text/html" && p.body.data) html = Buffer.from(p.body.data, "base64url").toString("utf8");
    });
    return {
      summary: this.summarize(msg),
      headers: h,
      messageId: h["message-id"] ?? null,
      inReplyTo: h["in-reply-to"] ?? null,
      references: (h.references ?? "").split(/\s+/).filter(Boolean),
      replyTo: parseAddressList(h["reply-to"]),
      text,
      html,
      attachments,
      authenticationResults: h["authentication-results"] ?? null,
    };
  }

  async compose(input: ComposeInput): Promise<string> {
    this.composed.push(input);
    const { attachments, ...rest } = input;
    return b64(JSON.stringify({ ...rest, attachments: (attachments ?? []).map((a) => ({ filename: a.filename, size: a.content.length })) }));
  }

  parseAddresses(value: string | null | undefined) {
    return parseAddressList(value);
  }
}

/** Decodes a raw message produced by FakeMime.compose. */
export const decodeRaw = (raw: string) =>
  JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Omit<ComposeInput, "attachments"> & { attachments: { filename: string; size: number }[] };

export class FakeGoogle {
  readonly mime = new FakeMime();
  readonly clients = new Map<string, FakeGmail>();
  /** Simulates the google label cache: served instead of the live list unless `{ fresh: true }` is passed. */
  readonly staleLabels = new Map<string, GmailLabel[]>();
  readonly labelCalls: ({ fresh?: boolean } | null)[] = [];

  gmail(accountId: string): FakeGmail {
    let c = this.clients.get(accountId);
    if (!c) {
      c = new FakeGmail(accountId);
      this.clients.set(accountId, c);
    }
    return c;
  }

  service(): GoogleService {
    return new Proxy({} as GoogleService, {
      get: (target, prop) => {
        if (prop === "mime") return this.mime;
        if (prop === "gmail") return (id: string) => this.gmail(id);
        if (prop === "labels") {
          return async (id: string, opts?: { fresh?: boolean }) => {
            this.labelCalls.push(opts ?? null);
            const stale = this.staleLabels.get(id);
            return (stale && !opts?.fresh ? stale : this.gmail(id).labels).map((l) => ({ ...l }));
          };
        }
        return Reflect.get(target, prop);
      },
    });
  }
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string | null;
  status: Account["status"];
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
    calendar: null,
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
        .filter((e) =>
          ctx.policy.canSeeEvent(agentId, { accountId: e.accountId, type: e.type, threadLabelIds: e.message?.labelIds ?? [], calendarEvent: e.calendarEvent ?? null }),
        )
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

export const ALL_CAPS: GrantInput["capabilities"] = ["read", "draft", "send", "organize", "trash"];

export const grantInput = (accountId: string, patch: Partial<GrantInput> = {}): GrantInput => ({
  accountId,
  capabilities: ["read"],
  labelScope: null,
  sendMode: "direct",
  allowTo: [],
  replyOnly: false,
  maxSendsPerHour: null,
  maxSendsPerDay: null,
  ...patch,
});

/** A context with fake Google, accounts, ingest and events, plus helpers. */
export function mailTestContext() {
  const google = new FakeGoogle();
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
