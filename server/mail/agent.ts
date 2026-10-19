// Agent-facing mail actions. Every method resolves the agent's grant for the account, enforces the
// action-side guardrails (capabilities, label scope, send rules) and returns structured data that
// server/mcp formats for the agent. Denials throw PolicyDenied; bad input throws ToolError.

import type { Account, Address, Approval, Attachment, Capability, GmailLabel, GoogleApproval, Grant, MessageSummary } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import type { GmailClient, GmailMessage, GmailPart, GmailThread, ParsedMessage } from "../google/types.ts";
import { UPLOAD_MAX_BYTES } from "../google/gmail.ts";
import { isOutcomeUnknown, rejectedBeforeProcessing } from "../google/http.ts";
import { AccountNeedsReauthError, GoogleApiError } from "../google/types.ts";
import {
  assertRecipientsAllowed,
  CAPABILITY_HELP,
  inScope,
  notAccessible,
  querySyntaxError,
  reserveSend,
  scopedSearch,
  threadLabels,
} from "../policy/enforce.ts";
import type { AgentPrincipal } from "../policy/types.ts";
import { PolicyDenied } from "../util/errors.ts";
import { matchesGlob } from "../util/glob.ts";
import { Approvals, type ApprovalPayload, draftFingerprint } from "./approvals.ts";
import { AttachmentError, type AttachmentInput, attachmentMeta, type OutgoingAttachment, prepareAttachments } from "./attachments.ts";
import { type BuiltContent, formatAddresses } from "./content.ts";
import { contentPool } from "./pool.ts";

/** Input problems the agent can fix (wrong arguments, ambiguous account, …). */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Filled in by actions so the MCP layer can audit what a call touched. Keep `detail` small. */
export interface ToolTrace {
  accountId?: string | null;
  target?: string | null;
  detail: Record<string, unknown>;
  /** Releases a send-cap reservation; the MCP layer calls it after recording the audit entry. */
  release?: () => void;
}

export interface Access {
  grant: Grant;
  account: Account;
  gmail: GmailClient;
}

export interface ThreadSummary {
  id: string;
  subject: string;
  from: Address | null;
  date: string;
  messageCount: number;
  labelIds: string[];
  snippet: string;
  hasAttachments: boolean;
}

export interface RenderedMessage {
  summary: MessageSummary;
  content: BuiltContent;
}

export type SendOutcome =
  | { status: "sent"; messageId: string; threadId: string }
  | { status: "draft_created"; draftId: string; message: string }
  | { status: "pending_approval"; approvalId: string; expiresAt: string; message: string };

export interface ComposeArgs {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  body: string;
  /** Files to attach (validated by prepareAttachments). */
  attachments?: AttachmentInput[];
}

type Target = { threadId?: string; messageId?: string };

export const MAX_RECIPIENTS = 50;
/** Binary attachments larger than this are not returned inline. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Total size of original attachments carried by a forward. */
const MAX_FORWARD_BYTES = 20 * 1024 * 1024;
/** System labels agents may not add/remove via modify_labels (trash has its own capability; the rest are Gmail-managed). */
const PROTECTED_LABELS = new Set(["TRASH", "SPAM", "DRAFT", "SENT", "CHAT"]);
/** System labels shown to label-scoped agents (they're needed for search and organizing). */
const SCOPED_VISIBLE_SYSTEM = new Set(["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "STARRED", "IMPORTANT", "UNREAD"]);
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const SUMMARY_HEADERS = ["From", "To", "Cc", "Subject", "Date"];

/** How long a label name that wasn't found (even fresh) is remembered as missing. */
const LABEL_MISS_TTL_MS = 30_000;
const labelMisses = new WeakMap<AppContext, Map<string, Map<string, number>>>();

/** Per account: lower-cased label name/id → time until which it's known to be missing. */
function recentLabelMisses(ctx: AppContext, accountId: string): Map<string, number> {
  let byAccount = labelMisses.get(ctx);
  if (!byAccount) labelMisses.set(ctx, (byAccount = new Map()));
  let misses = byAccount.get(accountId);
  if (!misses) byAccount.set(accountId, (misses = new Map()));
  const now = Date.now();
  for (const [k, until] of misses) if (until <= now) misses.delete(k);
  return misses;
}

const DRAFT_ONLY_MESSAGE = "Saved as a draft; a human will review and send it from Gmail.";

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface AttachmentPart {
  partId: string;
  attachmentId: string | null;
  data: string | null;
  filename: string;
  mimeType: string;
  size: number;
}

/** Attachment parts with their stable partId (Gmail's attachmentId changes on every fetch). */
function attachmentParts(msg: GmailMessage): AttachmentPart[] {
  const out: AttachmentPart[] = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    if (p.filename && p.partId && (p.body?.attachmentId || p.body?.data)) {
      out.push({
        partId: p.partId,
        attachmentId: p.body.attachmentId ?? null,
        data: p.body.data ?? null,
        filename: p.filename,
        mimeType: p.mimeType,
        size: p.body.size ?? 0,
      });
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(msg.payload);
  return out;
}

/** A message's attachments as agents see them: Gmail's per-fetch attachment ids replaced by stable part ids. */
function listedAttachments(msg: GmailMessage, list: Attachment[]): Attachment[] {
  const parts = attachmentParts(msg);
  return list.map((x) => ({ ...x, id: parts.find((p) => p.attachmentId === x.id)?.partId ?? x.id }));
}

const header = (m: GmailMessage | undefined, name: string): string | null =>
  m?.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

const disallowed = (grant: Grant, list: Address[]) =>
  grant.allowTo.length ? list.filter((x) => !grant.allowTo.some((g) => matchesGlob(x.email, g))) : [];

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

const prefixSubject = (prefix: "Re" | "Fwd", subject: string) => {
  const s = subject.trim();
  const re = prefix === "Re" ? /^re:/i : /^(fwd?|fw):/i;
  return re.test(s) ? s : `${prefix}: ${s}`.trim();
};

export class AgentMail {
  private readonly labelCache = new Map<string, Promise<GmailLabel[]>>();
  private readonly approvals: Approvals;

  constructor(
    private readonly ctx: AppContext,
    readonly principal: AgentPrincipal,
    readonly trace: ToolTrace = { detail: {} },
  ) {
    this.approvals = new Approvals(ctx);
  }

  // ───────────── Access resolution ─────────────

  /** Grants joined with their accounts (grants on deleted accounts are skipped). */
  accessible(): { grant: Grant; account: Account }[] {
    return this.ctx.policy
      .grants(this.principal.agentId)
      .map((grant) => ({ grant, account: this.ctx.accounts.get(grant.accountId) }))
      .filter((x): x is { grant: Grant; account: Account } => x.account !== null);
  }

  /** Picks the account for an action. `account` is an email or account id, optional when exactly one account qualifies. */
  resolve(account: string | undefined, cap: Capability): Access {
    const all = this.accessible();
    const capable = all.filter((x) => x.grant.capabilities.includes(cap));
    const list = (xs: typeof all) => xs.map((x) => x.account.email).join(", ");
    let match: (typeof all)[number] | undefined;
    if (account?.trim()) {
      const key = account.trim().toLowerCase();
      match = all.find((x) => x.account.id.toLowerCase() === key || x.account.email.toLowerCase() === key);
      if (!match) {
        throw new PolicyDenied(
          "capability",
          `You have no access to the account "${account}".` + (capable.length ? ` Accounts you can use for this: ${list(capable)}.` : ""),
        );
      }
      this.trace.accountId = match.account.id;
      if (!match.grant.capabilities.includes(cap)) {
        throw new PolicyDenied(
          "capability",
          `Your access to ${match.account.email} does not include permission to ${CAPABILITY_HELP[cap]}.` +
            (capable.length ? ` Accounts where you can: ${list(capable)}.` : ""),
        );
      }
    } else if (capable.length === 1) {
      match = capable[0]!;
    } else if (!capable.length) {
      throw new PolicyDenied("capability", `You don't have permission to ${CAPABILITY_HELP[cap]} on any account.`);
    } else {
      throw new ToolError("account_required", `You have access to several accounts; pass "account" as one of: ${list(capable)}.`);
    }
    this.trace.accountId = match.account.id;
    if (match.account.status === "needs_reauth") {
      throw new ToolError(
        "needs_reauth",
        `The Gmail account ${match.account.email} needs to be reconnected. Ask the operator to reconnect it in the xaq console.`,
      );
    }
    return { ...match, gmail: this.ctx.google.gmail(match.account.id) };
  }

  labels(a: Access): Promise<GmailLabel[]> {
    let p = this.labelCache.get(a.account.id);
    if (!p) {
      p = this.ctx.google.labels(a.account.id);
      this.labelCache.set(a.account.id, p);
      p.catch(() => this.labelCache.delete(a.account.id));
    }
    return p;
  }

  /** Bypasses the Google label cache (a label created in Gmail a moment ago). */
  private labelsFresh(a: Access): Promise<GmailLabel[]> {
    const p = this.ctx.google.labels(a.account.id, { fresh: true });
    this.labelCache.set(a.account.id, p);
    p.catch(() => this.labelCache.delete(a.account.id));
    return p;
  }

  /**
   * Labels, refetched once (fresh) when one of `wanted` (ids or names) is missing, unless that name was
   * already missing from a fresh list moments ago (so repeated misses don't hammer Gmail).
   */
  private async labelsHaving(a: Access, wanted: string[]): Promise<GmailLabel[]> {
    const matches = (list: GmailLabel[], key: string) => list.some((l) => l.id === key || l.name.toLowerCase() === key.toLowerCase());
    const list = await this.labels(a);
    const misses = recentLabelMisses(this.ctx, a.account.id);
    const missing = wanted.filter((k) => !matches(list, k.trim()));
    if (!missing.length || missing.every((k) => misses.has(k.trim().toLowerCase()))) return list;
    const fresh = await this.labelsFresh(a);
    const until = Date.now() + LABEL_MISS_TTL_MS;
    for (const k of missing) if (!matches(fresh, k.trim())) misses.set(k.trim().toLowerCase(), until);
    return fresh;
  }

  /** Labels for display only: falls back to raw ids on failure. */
  private async labelsSafe(a: Access): Promise<GmailLabel[] | null> {
    try {
      return await this.labels(a);
    } catch {
      return null;
    }
  }

  private maxChars(): number {
    return this.ctx.settings.get().maxBodyChars;
  }

  // ───────────── Label scope ─────────────

  /** Gmail 404/400 on an id is reported exactly like an out-of-scope id. */
  private async fetchById<T>(what: "Thread" | "Message", id: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GoogleApiError && (err.status === 404 || err.status === 400)) throw new ToolError("not_found", notAccessible(what, id));
      throw err;
    }
  }

  private assertThreadLabels(a: Access, labelIds: string[], what: "Thread" | "Message", id: string): void {
    if (!inScope(a.grant.labelScope, labelIds)) throw new PolicyDenied("label_scope", notAccessible(what, id));
  }

  /** Loads the thread's labels (format=minimal) and denies when out of scope. No-op for whole-mailbox grants. */
  async assertThreadInScope(a: Access, threadId: string, what: "Thread" | "Message" = "Thread", id = threadId): Promise<void> {
    if (a.grant.labelScope === null) return;
    const thread = await this.fetchById(what, id, () => a.gmail.getThread(threadId, "minimal"));
    this.assertThreadLabels(a, threadLabels(thread), what, id);
  }

  private async loadMessage(a: Access, messageId: string, format: "full" | "minimal"): Promise<GmailMessage> {
    const msg = await this.fetchById("Message", messageId, () => a.gmail.getMessage(messageId, format));
    await this.assertThreadInScope(a, msg.threadId, "Message", messageId);
    return msg;
  }

  private async resolveTarget(a: Access, t: Target): Promise<{ kind: "thread" | "message"; id: string }> {
    if (!!t.threadId === !!t.messageId) throw new ToolError("invalid_arguments", "Pass exactly one of thread_id or message_id.");
    if (t.threadId) {
      this.trace.target = t.threadId;
      await this.assertThreadInScope(a, t.threadId);
      return { kind: "thread", id: t.threadId };
    }
    this.trace.target = t.messageId!;
    if (a.grant.labelScope !== null) await this.loadMessage(a, t.messageId!, "minimal");
    return { kind: "message", id: t.messageId! };
  }

  // ───────────── Read ─────────────

  async listLabels(account: string | undefined): Promise<{ account: Account; labels: GmailLabel[]; scope: string[] | null }> {
    const a = this.resolveAny(account, ["read", "organize"]);
    const scope = a.grant.labelScope;
    const all = await this.labels(a);
    const labels = scope === null ? all : all.filter((l) => scope.includes(l.id) || SCOPED_VISIBLE_SYSTEM.has(l.id));
    return { account: a.account, labels, scope };
  }

  /** Like resolve, accepting any of several capabilities. */
  private resolveAny(account: string | undefined, caps: Capability[]): Access {
    let lastErr: unknown;
    for (const cap of caps) {
      try {
        return this.resolve(account, cap);
      } catch (err) {
        if (!(err instanceof PolicyDenied)) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async searchThreads(
    account: string | undefined,
    query: string,
    maxResults = 10,
    pageToken?: string,
  ): Promise<{ account: Account; threads: ThreadSummary[]; nextPageToken: string | null; hidden: number; labels: GmailLabel[] | null }> {
    const a = this.resolve(account, "read");
    const syntax = querySyntaxError(query);
    if (syntax) throw new ToolError("invalid_query", `${syntax} Fix the query and try again.`);
    const scope = a.grant.labelScope;
    // A scope label missing from the cached list may have just been created: look again once.
    const search = scopedSearch(query, scope, scope === null ? [] : await this.labelsHaving(a, scope));
    this.trace.detail = { queryLength: query.length, scoped: scope !== null };
    const labels = await this.labelsSafe(a);
    if (search === null) return { account: a.account, threads: [], nextPageToken: null, hidden: 0, labels };
    const res = await a.gmail.listThreads({ q: search.q || undefined, labelIds: search.labelIds, maxResults, pageToken: pageToken || undefined });
    let failed = 0;
    const threads = await mapLimit(res.threads, 5, (t) =>
      a.gmail.getThread(t.id, "metadata", SUMMARY_HEADERS).catch(() => {
        failed++;
        return null;
      }),
    );
    // Defense in depth: the scoped search should already exclude these.
    const visible = threads.filter((t): t is GmailThread => t !== null && inScope(scope, threadLabels(t)));
    const hidden = res.threads.length - visible.length;
    this.trace.detail.results = visible.length;
    if (hidden) this.trace.detail.filtered = hidden - failed;
    if (failed) this.trace.detail.failed = failed;
    return { account: a.account, threads: visible.map((t) => this.summarizeThread(t)), nextPageToken: res.nextPageToken, hidden, labels };
  }

  private summarizeThread(t: GmailThread): ThreadSummary {
    const msgs = t.messages ?? [];
    const first = msgs[0] ? this.ctx.google.mime.summarize(msgs[0]) : null;
    const last = msgs.at(-1) ? this.ctx.google.mime.summarize(msgs.at(-1)!) : null;
    return {
      id: t.id,
      subject: first?.subject ?? "",
      from: last?.from ?? null,
      date: last?.date ?? "",
      messageCount: msgs.length,
      labelIds: threadLabels(t),
      snippet: last?.snippet ?? t.snippet ?? "",
      hasAttachments: msgs.some((m) => this.ctx.google.mime.summarize(m).hasAttachments),
    };
  }

  private async render(a: Access, msg: GmailMessage): Promise<RenderedMessage> {
    const parsed = this.ctx.google.mime.parse(msg);
    const content = await contentPool(this.ctx).content(parsed, { accountEmail: a.account.email, maxChars: this.maxChars() });
    content.attachments = listedAttachments(msg, content.attachments);
    return { summary: parsed.summary, content };
  }

  async getThread(account: string | undefined, threadId: string) {
    const a = this.resolve(account, "read");
    this.trace.target = threadId;
    const thread = await this.fetchById("Thread", threadId, () => a.gmail.getThread(threadId, "full"));
    this.assertThreadLabels(a, threadLabels(thread), "Thread", threadId);
    const messages = await Promise.all((thread.messages ?? []).map((m) => this.render(a, m)));
    this.trace.detail = { messages: messages.length };
    return { account: a.account, threadId, messages, labels: await this.labelsSafe(a), maxChars: this.maxChars() };
  }

  async getMessage(account: string | undefined, messageId: string) {
    const a = this.resolve(account, "read");
    this.trace.target = messageId;
    const msg = await this.loadMessage(a, messageId, "full");
    return { account: a.account, message: await this.render(a, msg), labels: await this.labelsSafe(a), maxChars: this.maxChars() };
  }

  /**
   * The attachments of one message or of every message in a thread (exactly one of the two ids): the same files and
   * attachment ids get_message/get_thread list, with the message each belongs to. Metadata only, never content.
   */
  async listAttachments(account: string | undefined, target: { messageId?: string; threadId?: string }) {
    const a = this.resolve(account, "read");
    if (!!target.threadId === !!target.messageId) throw new ToolError("invalid_arguments", "Pass exactly one of thread_id or message_id.");
    let messages: GmailMessage[];
    if (target.threadId) {
      const threadId = target.threadId;
      this.trace.target = threadId;
      const thread = await this.fetchById("Thread", threadId, () => a.gmail.getThread(threadId, "full"));
      this.assertThreadLabels(a, threadLabels(thread), "Thread", threadId);
      messages = thread.messages ?? [];
    } else {
      this.trace.target = target.messageId!;
      messages = [await this.loadMessage(a, target.messageId!, "full")];
    }
    const items = messages.flatMap((msg) => {
      const summary = this.ctx.google.mime.summarize(msg);
      return listedAttachments(msg, this.ctx.google.mime.parse(msg).attachments).map((x) => ({ ...x, messageId: msg.id, from: summary.from, date: summary.date }));
    });
    this.trace.detail = { messages: messages.length, attachments: items.length };
    return { account: a.account, threadId: target.threadId ?? null, messageId: target.messageId ?? null, messageCount: messages.length, attachments: items };
  }

  /**
   * `attachmentId` is the part id shown by get_message/get_thread (or an attachment id Gmail lists for this
   * message right now). Anything else is not found: unlisted ids are never passed to Gmail.
   */
  async getAttachment(account: string | undefined, messageId: string, attachmentId: string) {
    const a = this.resolve(account, "read");
    this.trace.target = messageId;
    const msg = await this.loadMessage(a, messageId, "full");
    const parts = attachmentParts(msg);
    const part = parts.find((p) => p.partId === attachmentId) ?? parts.find((p) => p.attachmentId === attachmentId);
    if (!part) {
      const listed = parts.map((p) => `${p.partId} (${p.filename})`).join(", ");
      throw new ToolError(
        "not_found",
        listed ? `Message ${messageId} has no attachment ${attachmentId}. Its attachments: ${listed}.` : `Message ${messageId} has no attachments.`,
      );
    }
    const raw = part.attachmentId
      ? (await this.fetchById("Message", messageId, () => a.gmail.getAttachment(messageId, part.attachmentId!))).data
      : part.data!;
    const data = Buffer.from(raw, "base64url");
    this.trace.detail = { size: data.length, mimeType: part.mimeType };
    return {
      account: a.account,
      from: this.ctx.google.mime.summarize(msg).from?.email ?? null,
      filename: part.filename || "attachment",
      mimeType: part.mimeType || "application/octet-stream",
      data,
      maxChars: this.maxChars(),
    };
  }

  // ───────────── Compose / send ─────────────

  private recipients(value: string | string[] | undefined, field: string): Address[] {
    const parts = value === undefined ? [] : Array.isArray(value) ? value : [value];
    const out: Address[] = [];
    for (const part of parts) {
      if (!part.trim()) continue;
      const parsed = this.ctx.google.mime.parseAddresses(part);
      if (!parsed.length) throw new ToolError("invalid_recipient", `Could not read the ${field} address "${part}".`);
      for (const addr of parsed) {
        if (!EMAIL.test(addr.email)) throw new ToolError("invalid_recipient", `"${addr.email}" in ${field} is not a valid email address.`);
        out.push({ name: addr.name || null, email: addr.email.trim() });
      }
    }
    return out;
  }

  private from(a: Access): Address {
    return { name: a.account.displayName, email: a.account.email };
  }

  /** Threading headers so a new message lands in an existing thread. */
  private async threadingHeaders(a: Access, threadId: string): Promise<{ inReplyTo: string | null; references: string[] }> {
    const thread = await this.fetchById("Thread", threadId, () => a.gmail.getThread(threadId, "metadata", ["Message-ID", "References"]));
    this.assertThreadLabels(a, threadLabels(thread), "Thread", threadId);
    const last = thread.messages?.at(-1);
    const messageId = header(last, "Message-ID");
    const refs = (header(last, "References") ?? "").split(/\s+/).filter(Boolean);
    return { inReplyTo: messageId, references: messageId ? [...refs, messageId] : refs };
  }

  async createDraft(account: string | undefined, args: ComposeArgs & { threadId?: string }): Promise<{ draftId: string; threadId: string | null }> {
    const a = this.resolve(account, "draft");
    const to = this.recipients(args.to, "to");
    const cc = this.recipients(args.cc, "cc");
    const bcc = this.recipients(args.bcc, "bcc");
    const files = this.attachments(args.attachments, args.body);
    const threading = args.threadId ? await this.threadingHeaders(a, args.threadId) : { inReplyTo: null, references: [] };
    const raw = this.checkEncodedSize(
      await this.ctx.google.mime.compose({ from: this.from(a), to, cc, bcc, subject: args.subject, text: args.body, ...threading, attachments: files }),
    );
    const draft = await a.gmail.createDraft(raw, args.threadId ?? null);
    this.trace.target = draft.id;
    this.trace.detail = { recipients: to.length + cc.length + bcc.length, threaded: !!args.threadId, ...(files.length ? { attachments: attachmentMeta(files) } : {}) };
    return { draftId: draft.id, threadId: draft.message?.threadId ?? args.threadId ?? null };
  }

  /** The agent's files, checked and decoded (nothing reaches Google when one is refused). */
  private attachments(input: AttachmentInput[] | undefined, body: string): OutgoingAttachment[] {
    try {
      return prepareAttachments(input, Buffer.byteLength(body));
    } catch (err) {
      if (err instanceof AttachmentError) throw new ToolError(err.code, err.message);
      throw err;
    }
  }

  /** Backstop for the encoded message: Gmail's upload endpoint takes at most 35 MB (the 25 MB check comes first). */
  private checkEncodedSize(raw: string): string {
    const bytes = Math.floor((raw.length * 3) / 4);
    if (bytes > UPLOAD_MAX_BYTES) {
      throw new ToolError("too_large", `The message is ${(bytes / 1048576).toFixed(1)} MB once encoded; Gmail accepts at most 35 MB. Send fewer or smaller files.`);
    }
    return raw;
  }

  private denyReplyOnly(a: Access): never {
    const draft = a.grant.capabilities.includes("draft") ? " or create_draft to save a draft for a human to send" : "";
    throw new PolicyDenied(
      "reply_only",
      `Your access to ${a.account.email} only allows replies inside threads you can see. Use reply with a message_id from such a thread${draft}.`,
    );
  }

  async sendMessage(account: string | undefined, args: ComposeArgs & { reason?: string }): Promise<SendOutcome> {
    const a = this.resolve(account, "send");
    if (a.grant.replyOnly) this.denyReplyOnly(a);
    const to = this.recipients(args.to, "to");
    const cc = this.recipients(args.cc, "cc");
    const bcc = this.recipients(args.bcc, "bcc");
    const files = this.attachments(args.attachments, args.body);
    return this.deliver(a, "send", {
      to,
      cc,
      bcc,
      subject: args.subject,
      body: args.body,
      threadId: null,
      reason: args.reason ?? null,
      attachments: files.length ? async () => files : undefined,
    });
  }

  async reply(
    account: string | undefined,
    args: { messageId: string; body: string; replyAll?: boolean; reason?: string; attachments?: AttachmentInput[] },
  ): Promise<SendOutcome> {
    const a = this.resolve(account, "send");
    this.trace.target = args.messageId;
    // Cheap checks before loading the original.
    const files = this.attachments(args.attachments, args.body);
    const src = await this.loadMessage(a, args.messageId, "full");
    // A draft isn't a message anyone sent: replying to one would let an agent pick arbitrary recipients.
    if (src.labelIds?.includes("DRAFT")) throw new ToolError("draft_source", "That message is a draft; reply to a message that was actually sent or received.");
    const p = this.ctx.google.mime.parse(src);
    const self = a.account.email.toLowerCase();
    // Replying to the account's own sent message continues to its recipients (like Gmail); only for real SENT mail.
    const ownSent = p.summary.from?.email.toLowerCase() === self && !!src.labelIds?.includes("SENT");
    const to = ownSent ? p.summary.to : p.replyTo.length ? p.replyTo : p.summary.from ? [p.summary.from] : [];
    const cc = args.replyAll ? [...(ownSent ? [] : p.summary.to), ...p.summary.cc] : [];
    const seen = new Set([self]);
    const dedupe = (list: Address[]) =>
      list.filter((x) => {
        const key = x.email.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const toList = dedupe(to);
    const ccList = dedupe(cc);
    if (!toList.length && !ccList.length) throw new ToolError("no_recipients", "This message has no one to reply to (it only involves this account).");
    const recipients = [...toList, ...ccList];
    // Reply-only needs no extra recipient check here: drafts are refused above, so every recipient comes
    // from a message that was actually sent or received in this thread.
    const hint =
      args.replyAll && !disallowed(a.grant, toList).length
        ? "Retry with reply_all: false to answer only the sender, or use send_message for the allowed recipients."
        : undefined;
    assertRecipientsAllowed(
      a.grant,
      recipients.map((x) => x.email),
      hint,
    );
    return this.deliver(a, "reply", {
      to: toList.length ? toList : ccList,
      cc: toList.length ? ccList : [],
      bcc: [],
      subject: prefixSubject("Re", p.summary.subject),
      body: args.body,
      threadId: src.threadId,
      inReplyTo: p.messageId,
      references: p.messageId ? [...p.references.filter((r) => r !== p.messageId), p.messageId] : p.references,
      reason: args.reason ?? null,
      attachments: files.length ? async () => files : undefined,
    });
  }

  async forward(
    account: string | undefined,
    args: { messageId: string; to: string | string[]; body?: string; includeAttachments?: boolean; reason?: string },
  ): Promise<SendOutcome> {
    const a = this.resolve(account, "send");
    if (a.grant.replyOnly) this.denyReplyOnly(a);
    this.trace.target = args.messageId;
    const to = this.recipients(args.to, "to");
    // Cheap checks before loading the original.
    assertRecipientsAllowed(a.grant, to.map((x) => x.email));
    const src = await this.loadMessage(a, args.messageId, "full");
    const p = this.ctx.google.mime.parse(src);
    const original = await contentPool(this.ctx).content(p, { accountEmail: a.account.email, maxChars: 0 });
    const quoted = [
      "---------- Forwarded message ---------",
      `From: ${formatAddresses(p.summary.from ? [p.summary.from] : [])}`,
      `Date: ${p.headers.date ?? p.summary.date}`,
      `Subject: ${p.summary.subject}`,
      `To: ${formatAddresses(p.summary.to)}`,
      ...(p.summary.cc.length ? [`Cc: ${formatAddresses(p.summary.cc)}`] : []),
      "",
      original.body,
    ].join("\n");
    const body = args.body?.trim() ? `${args.body.trimEnd()}\n\n${quoted}` : quoted;
    return this.deliver(a, "forward", {
      to,
      cc: [],
      bcc: [],
      subject: prefixSubject("Fwd", p.summary.subject),
      body,
      threadId: null,
      reason: args.reason ?? null,
      attachments: args.includeAttachments ? () => this.loadAttachments(a, p) : undefined,
    });
  }

  private async loadAttachments(a: Access, p: ParsedMessage) {
    const total = p.attachments.reduce((n, x) => n + x.size, 0);
    if (total > MAX_FORWARD_BYTES) {
      throw new ToolError("too_large", `The original attachments total ${Math.round(total / 1048576)} MB; forwards can carry at most 20 MB. Forward without include_attachments.`);
    }
    return mapLimit(p.attachments, 3, async (x) => {
      const r = await a.gmail.getAttachment(p.summary.id, x.id);
      return { filename: x.filename || "attachment", contentType: x.mimeType, content: Buffer.from(r.data, "base64url") };
    });
  }

  /** Recipient allowlist, send caps, then the grant's send mode. */
  private async deliver(
    a: Access,
    kind: GoogleApproval["kind"],
    m: {
      to: Address[];
      cc: Address[];
      bcc: Address[];
      subject: string;
      body: string;
      threadId: string | null;
      inReplyTo?: string | null;
      references?: string[];
      reason: string | null;
      attachments?: () => Promise<{ filename: string; contentType?: string; content: Buffer }[]>;
    },
  ): Promise<SendOutcome> {
    const all = [...m.to, ...m.cc, ...m.bcc];
    if (!m.to.length) throw new ToolError("no_recipients", "Add at least one recipient in to.");
    if (all.length > MAX_RECIPIENTS) throw new ToolError("too_many_recipients", `At most ${MAX_RECIPIENTS} recipients per message.`);
    this.trace.detail = {
      mode: a.grant.sendMode,
      recipients: all.length,
      domains: [...new Set(all.map((x) => domainOf(x.email)))].slice(0, 10),
    };
    assertRecipientsAllowed(
      a.grant,
      all.map((x) => x.email),
    );
    // Synchronous check-and-reserve: no await between the cap check and taking the slot.
    this.trace.release = reserveSend(this.ctx.db, a.grant);
    const attachments = m.attachments ? await m.attachments() : [];
    // Names, types, sizes and sha256 only: never the content.
    if (attachments.length) this.trace.detail.attachments = attachmentMeta(attachments);
    const raw = this.checkEncodedSize(await this.ctx.google.mime.compose({
      from: this.from(a),
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
      subject: m.subject,
      text: m.body,
      inReplyTo: m.inReplyTo ?? null,
      references: m.references ?? [],
      attachments,
    }));

    if (a.grant.sendMode === "direct") {
      const sent = await this.uncertain(() => a.gmail.send(raw, m.threadId), "sent");
      this.trace.target = sent.id;
      try {
        this.ctx.ingest.kick(a.account.id);
      } catch {
        // ingest.kick never throws once implemented; tolerate placeholders.
      }
      return { status: "sent", messageId: sent.id, threadId: sent.threadId };
    }

    const draft = await this.uncertain(() => a.gmail.createDraft(raw, m.threadId), "saved as a draft");
    if (a.grant.sendMode === "draft_only") {
      this.trace.target = draft.id;
      return { status: "draft_created", draftId: draft.id, message: DRAFT_ONLY_MESSAGE };
    }

    let fingerprint: string;
    try {
      fingerprint = draftFingerprint((await a.gmail.getDraft(draft.id)).message);
    } catch (err) {
      await a.gmail.deleteDraft(draft.id).catch(() => {});
      throw err;
    }
    const payload: ApprovalPayload = {
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
      subject: m.subject,
      body: m.body,
      threadId: m.threadId,
      attachments: attachmentMeta(attachments, false),
      reason: m.reason,
      fingerprint,
    };
    const approval = this.approvals.create({ agentId: this.principal.agentId, accountId: a.account.id, kind, draftId: draft.id, payload });
    this.trace.target = approval.id;
    return {
      status: "pending_approval",
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      message: "Queued for human approval; nothing has been sent yet. Check later with get_send_status.",
    };
  }

  /**
   * Runs the Gmail write that sends (or saves) mail. A failure that may have happened after Gmail accepted
   * it (5xx, a timeout or reset: status 0) is recorded as "maybeSent", which counts toward the send caps, and
   * the agent is told to check before retrying. Only a connection that never reached Google is a clean failure.
   */
  private async uncertain<T>(fn: () => Promise<T>, what: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const ambiguous =
        err instanceof GoogleApiError
          ? (err.status === 0 || err.status >= 500 || isOutcomeUnknown(err)) && !rejectedBeforeProcessing(err)
          : !(err instanceof AccountNeedsReauthError);
      if (!ambiguous) throw err;
      this.trace.detail.maybeSent = true;
      throw new ToolError(
        "send_uncertain",
        `The connection to Gmail failed, so the message may or may not have been ${what}. Check (search_threads with in:sent or in:drafts) before retrying.`,
      );
    }
  }

  /** Read-only: an overdue pending request is reported as expired (the expiry timer records it). */
  sendStatus(approvalId: string): Approval {
    this.trace.target = approvalId;
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.agentId !== this.principal.agentId) {
      throw new ToolError("not_found", `No send request ${approvalId} was found for you.`);
    }
    this.trace.accountId = approval.accountId;
    if (approval.status === "pending" && Date.parse(approval.expiresAt) <= Date.now()) return { ...approval, status: "expired" };
    return approval;
  }

  // ───────────── Organize / trash ─────────────

  private async resolveLabelIds(a: Access, names: string[], mode: "add" | "remove"): Promise<string[]> {
    if (!names.length) return [];
    const scope = a.grant.labelScope;
    // A name we don't know may be a label created in Gmail since the cache was filled: look again once.
    const all = await this.labelsHaving(a, names);
    const find = (list: GmailLabel[], key: string) => list.find((l) => l.id === key) ?? list.find((l) => l.name.toLowerCase() === key.toLowerCase());
    // Scoped agents only see (and may name) their scope labels and common system labels.
    const labels = scope === null ? all : all.filter((l) => scope.includes(l.id) || SCOPED_VISIBLE_SYSTEM.has(l.id));
    return names.map((n) => {
      const key = n.trim();
      const label = find(labels, key);
      // Scoped agents may add only their own scope labels: any other label (INBOX included) can be another
      // grant's scope, so adding it would hand the thread to that grant. Read state goes through mark_read.
      const addable = () => all.filter((l) => scope!.includes(l.id)).map((l) => l.name).join(", ") || "(none)";
      if (!label && scope !== null) {
        // Same answer whether or not the label exists outside the scope.
        throw new PolicyDenied("label_scope", `"${key}" isn't a label you can use. Labels you can add: ${addable()}.`);
      }
      if (!label) {
        const sample = labels.filter((l) => l.type === "user").slice(0, 30).map((l) => l.name);
        throw new ToolError("unknown_label", `No label named "${key}". Existing labels include: INBOX, STARRED, IMPORTANT, UNREAD${sample.length ? ", " + sample.join(", ") : ""}.`);
      }
      if (PROTECTED_LABELS.has(label.id)) {
        throw new ToolError(
          "protected_label",
          label.id === "TRASH" ? "Use the trash tool to move mail to the trash." : `The ${label.id} label can't be changed with modify_labels.`,
        );
      }
      if (mode === "add" && scope !== null && !scope.includes(label.id)) {
        throw new PolicyDenied("label_scope", `You can't add the ${label.name} label. Labels you can add: ${addable()}.`);
      }
      return label.id;
    });
  }

  async modifyLabels(account: string | undefined, t: Target, add: string[] = [], remove: string[] = []) {
    const a = this.resolve(account, "organize");
    if (!add.length && !remove.length) throw new ToolError("invalid_arguments", "Pass labels to add and/or remove.");
    const target = await this.resolveTarget(a, t);
    const addIds = await this.resolveLabelIds(a, add, "add");
    const removeIds = await this.resolveLabelIds(a, remove, "remove");
    this.trace.detail = { kind: target.kind, add: addIds, remove: removeIds };
    const labelIds =
      target.kind === "thread"
        ? threadLabels(await a.gmail.modifyThread(target.id, addIds, removeIds))
        : ((await a.gmail.modifyMessage(target.id, addIds, removeIds)).labelIds ?? []);
    return { account: a.account, target, labelIds, labels: await this.labelsSafe(a) };
  }

  async archive(account: string | undefined, threadId: string) {
    const a = this.resolve(account, "organize");
    await this.resolveTarget(a, { threadId });
    await a.gmail.modifyThread(threadId, [], ["INBOX"]);
    return { account: a.account, threadId };
  }

  async markRead(account: string | undefined, t: Target, read = true) {
    const a = this.resolve(account, "organize");
    const target = await this.resolveTarget(a, t);
    const [add, remove] = read ? [[], ["UNREAD"]] : [["UNREAD"], []];
    if (target.kind === "thread") await a.gmail.modifyThread(target.id, add, remove);
    else await a.gmail.modifyMessage(target.id, add, remove);
    this.trace.detail = { kind: target.kind, read };
    return { account: a.account, target, read };
  }

  async trash(account: string | undefined, t: Target) {
    const a = this.resolve(account, "trash");
    const target = await this.resolveTarget(a, t);
    if (target.kind === "thread") await a.gmail.trashThread(target.id);
    else await a.gmail.trashMessage(target.id);
    this.trace.detail = { kind: target.kind };
    return { account: a.account, target };
  }

  // ───────────── Events ─────────────

  /** Account filter for the event feed: the resolved account id, or undefined for all readable accounts. */
  eventAccountIds(account: string | undefined): string[] | undefined {
    if (!account?.trim()) return undefined;
    return [this.resolve(account, "read").account.id];
  }
}
