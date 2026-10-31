// Mail domain contract (agent mail actions, content cleaning, approvals). Owned by the policy + MCP + mail work area.
// Members marked FROZEN are used by other domains: do not rename or change them. Adding members is fine.

import type { Approval, ApprovalStatus, MessageContent } from "../../shared/types.ts";
import type { Lifecycle } from "../context.ts";

export interface MailService extends Lifecycle {
  /**
   * FROZEN. Cleaned, markdown-converted body with signals, honoring Settings.maxBodyChars. Used for
   * listener payloads with a body (visibility is checked by the caller, not here).
   */
  messageContent(accountId: string, messageId: string): Promise<MessageContent>;

  listApprovals(status?: ApprovalStatus): Approval[];
  getApproval(id: string): Approval | null;
  /** Sends the draft; the approval ends as "sent" or "failed". Emits bus "approval". */
  approve(id: string, note?: string | null): Promise<Approval>;
  /** Deletes the draft; the approval ends as "rejected". Emits bus "approval". */
  reject(id: string, note?: string | null): Promise<Approval>;
  /** Marks overdue pending approvals expired and deletes their drafts. Returns how many. */
  expireApprovals(): Promise<number>;
  /** Deletes decided approvals (sent, rejected, failed, expired) decided before `beforeIso`. Returns how many. */
  prune(beforeIso: string): number;
}
