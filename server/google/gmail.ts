import { randomBytes } from "node:crypto";
import type { AppContext } from "../context.ts";
import type { RequestOptions } from "./runtime.ts";
import { googleRuntime } from "./runtime.ts";
import {
  type GmailClient,
  type GmailDraft,
  type GmailFormat,
  type GmailHistoryRecord,
  type GmailLabelRaw,
  type GmailMessage,
  type GmailThread,
  GoogleApiError,
  type ListParams,
} from "./types.ts";

/** Gmail quota units per method (https://developers.google.com/gmail/api/reference/quota). */
const COST = {
  getProfile: 1,
  "messages.list": 5,
  "messages.get": 5,
  "messages.modify": 5,
  "messages.trash": 5,
  "messages.send": 100,
  "attachments.get": 5,
  "threads.list": 10,
  "threads.get": 10,
  "threads.modify": 10,
  "threads.trash": 10,
  "labels.list": 1,
  "drafts.create": 10,
  "drafts.get": 7,
  "drafts.send": 100,
  "drafts.delete": 10,
  "history.list": 2,
} as const;

/** Uploads take longer: 30 s + 1 s per 256 KB of raw message, capped at 10 minutes. */
const uploadTimeout = (raw: string) => Math.min(600_000, 30_000 + Math.ceil(raw.length / 262_144) * 1000);

/**
 * Raw messages (base64url characters) up to this size go in the JSON body (`{raw}`); larger ones through
 * the /upload/ endpoint. Google documents no size limit for `raw` in a JSON request, and Gmail has
 * answered "Request payload size exceeds the limit: 1048576 bytes" there, so only small messages use it.
 */
export const JSON_RAW_MAX_CHARS = 512 * 1024;
/**
 * Largest message the /upload/ endpoint of messages.send and drafts.create accepts: "maxSize": "36700160"
 * (35 MB) in Gmail's discovery document. It counts the encoded RFC 822 message.
 */
export const UPLOAD_MAX_BYTES = 36_700_160;

/** A media upload body: the message alone (uploadType=media), or JSON metadata plus the message (multipart). */
export function uploadBody(bytes: Buffer, metadata: object | null): { uploadType: "media" | "multipart"; contentType: string; data: Buffer } {
  if (!metadata) return { uploadType: "media", contentType: "message/rfc822", data: bytes };
  let boundary: string;
  do boundary = `aib_${randomBytes(16).toString("hex")}`;
  while (bytes.includes(boundary));
  const head =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`;
  return {
    uploadType: "multipart",
    contentType: `multipart/related; boundary=${boundary}`,
    data: Buffer.concat([Buffer.from(head), bytes, Buffer.from(`\r\n--${boundary}--`)]),
  };
}

const listQuery = (p: ListParams) => ({
  q: p.q || undefined,
  labelIds: p.labelIds?.length ? p.labelIds : undefined,
  maxResults: p.maxResults,
  pageToken: p.pageToken,
  includeSpamTrash: p.includeSpamTrash,
});

export function createGmailClient(ctx: AppContext, accountId: string): GmailClient {
  const rt = googleRuntime(ctx);
  const call = <T>(method: keyof typeof COST, path: string, opts: Omit<RequestOptions, "cost"> = {}) =>
    rt.request<T>(accountId, ctx.config.google.gmailBase, `/gmail/v1/users/me${path}`, { ...opts, cost: COST[method] });
  const id = encodeURIComponent;
  /**
   * messages.send / drafts.create: `{raw}` JSON for small messages, otherwise the message bytes through
   * /upload/ (multipart when there is metadata such as a threadId, else uploadType=media).
   */
  const write = <T>(
    method: "messages.send" | "drafts.create",
    path: string,
    raw: string,
    json: object,
    metadata: object | null,
    opts: Omit<RequestOptions, "cost">,
  ): Promise<T> => {
    const timeoutMs = uploadTimeout(raw);
    if (raw.length <= JSON_RAW_MAX_CHARS) return call<T>(method, path, { ...opts, method: "POST", body: json, timeoutMs });
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.length > UPLOAD_MAX_BYTES) {
      // Never sent: a clean failure.
      return Promise.reject(new GoogleApiError(400, `The message is ${(bytes.length / 1048576).toFixed(1)} MB encoded; Gmail accepts at most 35 MB`, "uploadTooLarge"));
    }
    const upload = uploadBody(bytes, metadata);
    return rt.request<T>(accountId, ctx.config.google.gmailBase, `/upload/gmail/v1/users/me${path}`, {
      ...opts,
      method: "POST",
      query: { uploadType: upload.uploadType },
      rawBody: { contentType: upload.contentType, data: upload.data },
      timeoutMs,
      cost: COST[method],
    });
  };

  return {
    accountId,
    getProfile: () => call("getProfile", "/profile"),
    async listMessages(p) {
      const r = await call<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(
        "messages.list",
        "/messages",
        { query: listQuery(p) },
      );
      return { messages: r?.messages ?? [], nextPageToken: r?.nextPageToken ?? null, resultSizeEstimate: r?.resultSizeEstimate ?? 0 };
    },
    async listThreads(p) {
      const r = await call<{ threads?: { id: string; snippet: string; historyId: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(
        "threads.list",
        "/threads",
        { query: listQuery(p) },
      );
      return { threads: r?.threads ?? [], nextPageToken: r?.nextPageToken ?? null, resultSizeEstimate: r?.resultSizeEstimate ?? 0 };
    },
    getMessage: (messageId: string, format: GmailFormat = "full", metadataHeaders?: string[]) =>
      call<GmailMessage>("messages.get", `/messages/${id(messageId)}`, { query: { format, metadataHeaders } }),
    getThread: (threadId: string, format: Exclude<GmailFormat, "raw"> = "full", metadataHeaders?: string[]) =>
      call<GmailThread>("threads.get", `/threads/${id(threadId)}`, { query: { format, metadataHeaders } }),
    async getAttachment(messageId, attachmentId, opts = {}) {
      // The JSON carries the bytes base64url-encoded (4/3 of them) next to a few small fields.
      const maxResponseBytes = opts.maxBytes === undefined ? undefined : Math.ceil(opts.maxBytes / 3) * 4 + 1024;
      const r = await call<{ data?: string; size?: number }>("attachments.get", `/messages/${id(messageId)}/attachments/${id(attachmentId)}`, {
        maxResponseBytes,
      });
      return { data: r?.data ?? "", size: r?.size ?? 0 };
    },
    async listLabels() {
      const r = await call<{ labels?: GmailLabelRaw[] }>("labels.list", "/labels");
      return r?.labels ?? [];
    },
    modifyMessage: (messageId, add, remove) =>
      call<GmailMessage>("messages.modify", `/messages/${id(messageId)}/modify`, {
        method: "POST",
        body: { addLabelIds: add, removeLabelIds: remove },
      }),
    modifyThread: (threadId, add, remove) =>
      call<GmailThread>("threads.modify", `/threads/${id(threadId)}/modify`, {
        method: "POST",
        body: { addLabelIds: add, removeLabelIds: remove },
      }),
    trashMessage: (messageId) => call<GmailMessage>("messages.trash", `/messages/${id(messageId)}/trash`, { method: "POST" }),
    trashThread: (threadId) => call<GmailThread>("threads.trash", `/threads/${id(threadId)}/trash`, { method: "POST" }),
    send: (raw, threadId) =>
      write<GmailMessage>("messages.send", "/messages/send", raw, { raw, ...(threadId ? { threadId } : {}) }, threadId ? { threadId } : null, {
        idempotent: false,
      }),
    createDraft: (raw, threadId) =>
      write<GmailDraft>(
        "drafts.create",
        "/drafts",
        raw,
        { message: { raw, ...(threadId ? { threadId } : {}) } },
        threadId ? { message: { threadId } } : null,
        { idempotent: false, ambiguousHint: "A draft may have been created: check Drafts in Gmail before retrying." },
      ),
    getDraft: (draftId) => call<GmailDraft>("drafts.get", `/drafts/${id(draftId)}`, { query: { format: "full" } }),
    sendDraft: (draftId) => call<GmailMessage>("drafts.send", "/drafts/send", { method: "POST", body: { id: draftId }, idempotent: false }),
    async deleteDraft(draftId) {
      await call<void>("drafts.delete", `/drafts/${id(draftId)}`, { method: "DELETE" });
    },
    async listHistory(p) {
      const r = await call<{ history?: GmailHistoryRecord[]; nextPageToken?: string; historyId: string }>("history.list", "/history", {
        query: {
          startHistoryId: p.startHistoryId,
          pageToken: p.pageToken,
          maxResults: p.maxResults,
          historyTypes: p.historyTypes,
        },
      });
      return { history: r?.history ?? [], nextPageToken: r?.nextPageToken ?? null, historyId: String(r?.historyId ?? p.startHistoryId) };
    },
  };
}
