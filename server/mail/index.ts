import type { MessageContent } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { notFound } from "../util/errors.ts";
import { closeAttachmentParser } from "./extract/sandbox.ts";
import { closeContentPool, contentPool } from "./pool.ts";
import type { MailService } from "./types.ts";

export function createMailService(ctx: AppContext): MailService {
  return {
    async messageContent(accountId: string, messageId: string): Promise<MessageContent> {
      const account = ctx.accounts.get(accountId);
      if (!account) throw notFound("Account");
      const msg = await ctx.google.gmail(accountId).getMessage(messageId, "full");
      // Listener bodies use the background lane so they can't starve interactive MCP reads.
      const { totalChars: _total, ...content } = await contentPool(ctx).content(
        ctx.google.mime.parse(msg),
        { accountEmail: account.email, maxChars: ctx.settings.get().maxBodyChars },
        "background",
      );
      return content;
    },

    async stop() {
      await closeContentPool(ctx);
      await closeAttachmentParser(ctx);
    },
  };
}
