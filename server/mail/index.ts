import type { MessageContent } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { errorMessage, notFound } from "../util/errors.ts";
import { Approvals } from "./approvals.ts";
import { closeAttachmentParser } from "./extract/sandbox.ts";
import { closeContentPool, contentPool } from "./pool.ts";
import type { MailService } from "./types.ts";

const EXPIRY_INTERVAL_MS = 60_000;

export function createMailService(ctx: AppContext): MailService {
  const approvals = new Approvals(ctx);
  let timer: NodeJS.Timeout | undefined;

  const expire = () =>
    approvals.expireOverdue().catch((err) => ctx.log.warn("Approval expiry failed", { error: errorMessage(err) }));

  return {
    async messageContent(accountId: string, messageId: string): Promise<MessageContent> {
      const account = ctx.accounts.get(accountId);
      if (!account) throw notFound("Account");
      const msg = await ctx.google.gmail(accountId).getMessage(messageId, "full");
      // Webhook bodies use the background lane so they can't starve interactive MCP reads.
      const { totalChars: _total, ...content } = await contentPool(ctx).content(
        ctx.google.mime.parse(msg),
        { accountEmail: account.email, maxChars: ctx.settings.get().maxBodyChars },
        "background",
      );
      return content;
    },

    listApprovals: (status) => approvals.list(status),
    getApproval: (id) => approvals.get(id),
    approve: (id, note) => approvals.approve(id, note),
    reject: (id, note) => approvals.reject(id, note),
    expireApprovals: () => approvals.expireOverdue(),
    prune: (beforeIso) => approvals.prune(beforeIso),

    start() {
      approvals.recoverInterrupted();
      void expire();
      timer = setInterval(() => void expire(), EXPIRY_INTERVAL_MS);
      timer.unref();
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await closeContentPool(ctx);
      await closeAttachmentParser(ctx);
    },
  };
}
