// Mail domain contract (agent mail actions, content cleaning). Owned by the policy + MCP + mail work area.
// Members marked FROZEN are used by other domains: do not rename or change them. Adding members is fine.

import type { MessageContent } from "../../shared/types.ts";
import type { Lifecycle } from "../context.ts";

export interface MailService extends Lifecycle {
  /**
   * FROZEN. Cleaned, markdown-converted body with signals, honoring Settings.maxBodyChars. Used for
   * listener payloads with a body (visibility is checked by the caller, not here).
   */
  messageContent(accountId: string, messageId: string): Promise<MessageContent>;
}
