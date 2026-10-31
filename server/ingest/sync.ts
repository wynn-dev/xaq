import type { EventType } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { now } from "../db/index.ts";
import { type AccountRow, updateRow } from "../google/accounts.ts";
import { TEST_EMAIL_HEADER } from "../google/testmail.ts";
import { type GmailClient, GoogleApiError, type GmailHistoryRecord, type GmailMessage } from "../google/types.ts";

export const HISTORY_TYPES = ["messageAdded", "labelAdded", "labelRemoved"];
const METADATA_HEADERS = ["From", "To", "Cc", "Subject", "Date", TEST_EMAIL_HEADER];

/** The console's setup test email (POST /api/accounts/:id/test-email), addressed to the account itself. */
const isTestEmail = (msg: GmailMessage) =>
  (msg.labelIds ?? []).includes("INBOX") && !!msg.payload?.headers?.some((h) => h.name.toLowerCase() === TEST_EMAIL_HEADER.toLowerCase());
/** New messages with these labels produce no events. */
const SKIP_NEW = ["DRAFT", "SPAM", "CHAT"];
/**
 * Label churn that isn't interesting as label.added/removed: drafts being saved, SENT (reported as
 * message.sent), and Gmail's automatic classification (IMPORTANT, CATEGORY_*).
 */
const skipLabelChange = (l: string) => l === "DRAFT" || l === "SENT" || l === "IMPORTANT" || l.startsWith("CATEGORY_");
/** Bounded resync window after a history gap. */
const RESYNC_QUERY = "newer_than:2d";
const RESYNC_MAX = 100;

const isNotFound = (err: unknown) => err instanceof GoogleApiError && err.status === 404;

/**
 * One sync pass over an account: turns Gmail history records (or a list of recent messages) into
 * events. Thread label unions are cached for the pass.
 */
export class SyncPass {
  emitted = 0;
  private readonly gmail: GmailClient;
  private readonly threadLabels = new Map<string, Promise<string[]>>();
  private readonly seen = new Set<string>();
  /** Messages added during this pass: their labels are already in message.received. */
  private readonly added = new Set<string>();
  /** Spam rescue ("Not spam" = SPAM removed + INBOX added, in either order): new to agents. */
  private readonly inboxAdded = new Set<string>();
  private readonly spamRemoved = new Set<string>();

  constructor(
    private readonly ctx: AppContext,
    private readonly account: AccountRow,
  ) {
    this.gmail = ctx.google.gmail(account.id);
  }

  async processRecord(r: GmailHistoryRecord): Promise<void> {
    for (const { message } of r.messagesAdded ?? []) {
      this.added.add(message.id);
      if (message.labelIds?.some((l) => SKIP_NEW.includes(l))) continue;
      const meta = await this.fetch(message.id);
      if (meta) await this.newMessage(meta);
    }
    for (const [type, changes] of [
      ["label.added", r.labelsAdded],
      ["label.removed", r.labelsRemoved],
    ] as const) {
      for (const { message, labelIds } of changes ?? []) {
        if (this.added.has(message.id)) continue;
        // A sent draft gains SENT outside a messagesAdded record: still a send (deduped if already seen).
        if (type === "label.added" && labelIds.includes("SENT")) {
          const meta = await this.fetch(message.id);
          if (meta) await this.newMessage(meta);
        }
        // Only a spam rescue counts as newly received; un-archive, snooze or restore from trash don't.
        if (type === "label.added" && labelIds.includes("INBOX")) this.inboxAdded.add(message.id);
        if (type === "label.removed" && labelIds.includes("SPAM")) this.spamRemoved.add(message.id);
        const changed = labelIds.filter((l) => !skipLabelChange(l));
        if (!changed.length || message.labelIds?.includes("DRAFT")) continue;
        const meta = await this.fetch(message.id);
        if (!meta || meta.labelIds?.includes("DRAFT")) continue;
        this.emit(type, meta, await this.threadLabelIds(meta), `${message.id}:${type}:${r.id}`, changed);
      }
    }
  }

  /** Emits message.received for messages rescued from spam so far (call after each page). */
  async flushRescued(): Promise<void> {
    for (const id of this.inboxAdded) {
      if (!this.spamRemoved.has(id)) continue;
      this.inboxAdded.delete(id);
      this.spamRemoved.delete(id);
      const meta = await this.fetch(id);
      if (meta?.labelIds?.includes("INBOX")) await this.newMessage(meta);
    }
  }

  /** Emits message.sent / message.received (+ thread.reply_received) for a metadata-format message. */
  async newMessage(msg: GmailMessage): Promise<void> {
    const labels = msg.labelIds ?? [];
    if (labels.some((l) => SKIP_NEW.includes(l))) return;
    const threadLabels = await this.threadLabelIds(msg);
    if (labels.includes("SENT")) {
      this.ctx.db.run(
        `INSERT INTO sent_threads (account_id, gmail_thread_id, last_sent_at) VALUES (?, ?, ?)
         ON CONFLICT(account_id, gmail_thread_id) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
        this.account.id,
        msg.threadId,
        now(),
      );
      this.emit("message.sent", msg, threadLabels, `${msg.id}:message.sent`);
      // Self-addressed mail is normally only a send; the setup test email also counts as received so
      // the operator sees it reach webhooks and listeners filtered on message.received (the default).
      if (isTestEmail(msg)) this.emit("message.received", msg, threadLabels, `${msg.id}:message.received`);
      return;
    }
    this.emit("message.received", msg, threadLabels, `${msg.id}:message.received`);
    const sentInto =
      threadLabels.includes("SENT") ||
      this.ctx.db.get("SELECT 1 AS x FROM sent_threads WHERE account_id = ? AND gmail_thread_id = ?", this.account.id, msg.threadId);
    if (sentInto) this.emit("thread.reply_received", msg, threadLabels, `${msg.id}:thread.reply_received`);
  }

  /** format=metadata; null when the message was deleted meanwhile. */
  async fetch(id: string): Promise<GmailMessage | null> {
    try {
      return await this.gmail.getMessage(id, "metadata", METADATA_HEADERS);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Union of labels across the message's thread (label filters are thread-level). */
  threadLabelIds(msg: GmailMessage): Promise<string[]> {
    let p = this.threadLabels.get(msg.threadId);
    if (!p) {
      p = this.gmail.getThread(msg.threadId, "minimal").then(
        (t) => [...new Set([...(msg.labelIds ?? []), ...(t.messages ?? []).flatMap((m) => m.labelIds ?? [])])],
        (err: unknown) => {
          if (isNotFound(err)) return msg.labelIds ?? [];
          throw err;
        },
      );
      this.threadLabels.set(msg.threadId, p);
    }
    return p.then((labels) => [...new Set([...labels, ...(msg.labelIds ?? [])])]);
  }

  private emit(type: EventType, msg: GmailMessage, threadLabelIds: string[], key: string, labelIds?: string[]): void {
    const dedupeKey = `${this.account.id}:${key}`;
    if (this.seen.has(dedupeKey)) return;
    this.seen.add(dedupeKey);
    const ev = this.ctx.events.emit({
      type,
      accountId: this.account.id,
      message: this.ctx.google.mime.summarize(msg),
      threadLabelIds,
      ...(labelIds ? { labelIds } : {}),
      dedupeKey,
    });
    if (ev) this.emitted++;
  }
}

const aborted = () => Object.assign(new Error("Sync stopped"), { name: "AbortError" });

/** a > b for Gmail history ids (numeric strings). */
export function historyNewer(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return false;
  }
}

/**
 * Processes history after the account's cursor page by page, advancing the stored cursor to the last
 * fully processed record (a failure or stop resumes there) and finally to the mailbox's current
 * historyId. Throws GoogleApiError 404 when the cursor is too old.
 */
export async function syncHistory(ctx: AppContext, account: AccountRow, signal?: AbortSignal): Promise<number> {
  const gmail = ctx.google.gmail(account.id);
  const start = account.history_id!;
  const pass = new SyncPass(ctx, account);
  let saved = start;
  let done: string | null = null;
  const save = (historyId: string) => {
    if (!historyNewer(historyId, saved)) return;
    saved = historyId;
    updateRow(ctx, account.id, { history_id: historyId });
  };
  let pageToken: string | undefined;
  try {
    do {
      const page = await gmail.listHistory({ startHistoryId: start, pageToken, maxResults: 500, historyTypes: HISTORY_TYPES });
      for (const r of page.history) {
        if (signal?.aborted) throw aborted();
        await pass.processRecord(r);
        done = r.id;
      }
      await pass.flushRescued();
      if (done) save(done);
      pageToken = page.nextPageToken ?? undefined;
      if (!pageToken) save(page.historyId);
    } while (pageToken);
  } finally {
    if (done) save(done);
  }
  updateRow(ctx, account.id, { last_sync_at: now() }, pass.emitted > 0);
  return pass.emitted;
}

/**
 * Bounded resync: emits events for recent messages (dedupe drops the ones already seen), resets the
 * cursor to the mailbox's current historyId and emits sync.gap.
 */
export async function boundedResync(
  ctx: AppContext,
  account: AccountRow,
  reason: "history_expired" | "manual",
  signal?: AbortSignal,
): Promise<number> {
  const gmail = ctx.google.gmail(account.id);
  // Profile first: anything that arrives during the listing is picked up by the next history sync.
  const profile = await gmail.getProfile();
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmail.listMessages({ q: RESYNC_QUERY, maxResults: RESYNC_MAX - ids.length, pageToken });
    ids.push(...page.messages.map((m) => m.id));
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken && ids.length < RESYNC_MAX);
  const pass = new SyncPass(ctx, account);
  for (const id of ids.reverse()) {
    if (signal?.aborted) throw aborted();
    const meta = await pass.fetch(id);
    if (meta) await pass.newMessage(meta);
  }
  ctx.events.emit({
    type: "sync.gap",
    accountId: account.id,
    detail: {
      reason,
      since: account.last_sync_at,
      previousHistoryId: account.history_id,
      resyncedMessages: ids.length,
      window: RESYNC_QUERY,
    },
    // A manual resync always reports; an expired cursor reports once per incident.
    dedupeKey: `${account.id}:sync.gap:${reason}:${reason === "manual" ? Date.now() : `${account.history_id ?? ""}:${profile.historyId}`}`,
  });
  updateRow(ctx, account.id, { history_id: String(profile.historyId), last_sync_at: now() }, true);
  ctx.log.child("ingest").info("Resynced recent messages", { email: account.email, reason, messages: ids.length, events: pass.emitted });
  return pass.emitted;
}
