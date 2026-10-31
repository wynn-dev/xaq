import type { MessageContent, MessageSummary } from "../shared/types.ts";
import type { AppContext } from "../server/context.ts";
import type { MailService } from "../server/mail/types.ts";

export function addAccount(ctx: AppContext, id: string, email: string): void {
  ctx.db.run(
    "INSERT INTO accounts (id, email, display_name, status, refresh_token_enc, created_at) VALUES (?, ?, 'Test', 'active', 'x', ?)",
    id,
    email,
    new Date().toISOString(),
  );
}

/** Mail fake: only messageContent. Message ids starting with "fail" throw, "big" ones get a 1 MB body. */
export function fakeMail(): () => MailService {
  return () =>
    ({
      async messageContent(_accountId: string, messageId: string): Promise<MessageContent> {
        if (messageId.startsWith("fail")) throw new Error("Gmail is down");
        return {
          body: messageId.startsWith("big") ? "x".repeat(1_000_000) : `Body of ${messageId}`,
          truncated: false,
          attachments: [],
          signals: { hiddenContentRemoved: false, suspiciousInstructions: [], auth: null, external: true },
        };
      },
    }) as unknown as MailService;
}

const message = (id: string, labelIds: string[]): MessageSummary => ({
  id,
  threadId: `t_${id}`,
  from: { name: "Alice", email: "alice@example.com" },
  to: [{ name: null, email: "me@example.com" }],
  cc: [],
  subject: `Subject ${id}`,
  snippet: "hi",
  date: new Date().toISOString(),
  labelIds,
  hasAttachments: false,
});

/** Emits a message.received event and returns its seq. */
export function emitMessage(ctx: AppContext, accountId: string, id: string, labelIds = ["INBOX"], type: "message.received" | "message.sent" = "message.received"): number {
  const ev = ctx.events.emit({ type, accountId, message: message(id, labelIds), dedupeKey: `${accountId}:${id}:${type}` });
  if (!ev) throw new Error("duplicate event");
  return ev.seq;
}

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** Minimal SSE reader over a fetch Response. */
export class SseReader {
  readonly frames: SseFrame[] = [];
  ended = false;
  private buffer = "";
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private pending: Promise<void> | null = null;

  constructor(res: Response) {
    this.reader = res.body!.getReader();
  }

  private pump(): Promise<void> {
    this.pending ??= this.reader.read().then(({ value, done }) => {
      this.pending = null;
      if (done) {
        this.ended = true;
        return;
      }
      this.buffer += this.decoder.decode(value, { stream: true });
      const parts = this.buffer.split("\n\n");
      this.buffer = parts.pop()!;
      for (const part of parts) {
        const frame: SseFrame = {};
        for (const line of part.split("\n")) {
          if (line.startsWith(":")) frame.comment = line.slice(1).trim();
          else if (line.startsWith("id: ")) frame.id = line.slice(4);
          else if (line.startsWith("event: ")) frame.event = line.slice(7);
          else if (line.startsWith("data: ")) frame.data = frame.data === undefined ? line.slice(6) : `${frame.data}\n${line.slice(6)}`;
        }
        this.frames.push(frame);
      }
    });
    return this.pending;
  }

  /** Reads until `pred` holds (or the stream ends); throws after `timeoutMs`. */
  async until(pred: (frames: SseFrame[]) => boolean, timeoutMs = 2000): Promise<SseFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (!pred(this.frames)) {
      if (this.ended) throw new Error(`stream ended; frames: ${JSON.stringify(this.frames)}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out; frames: ${JSON.stringify(this.frames)}`);
      await Promise.race([this.pump(), new Promise((r) => setTimeout(r, left))]);
    }
    return this.frames;
  }

  /** Reads until the server closes the stream. */
  async end(timeoutMs = 2000): Promise<SseFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ended) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`stream still open; frames: ${JSON.stringify(this.frames)}`);
      await Promise.race([this.pump(), new Promise((r) => setTimeout(r, left))]);
    }
    return this.frames;
  }

  mail(): { seq: number; payload: { type: string; timestamp: string; data: Record<string, unknown> & { seq: number } } }[] {
    return this.frames.filter((f) => f.event === "mail").map((f) => ({ seq: Number(f.id), payload: JSON.parse(f.data!) }));
  }

  cancel(): void {
    this.reader.cancel().catch(() => {});
  }
}
