// Ingest domain contract. Owned by the Google + ingest work area.
// Members marked FROZEN are used by other domains: do not rename or change them. Adding members is fine.

import type { Account, IngestStatus } from "../../shared/types.ts";
import type { Lifecycle } from "../context.ts";

export interface IngestService extends Lifecycle {
  /** FROZEN. */
  status(): IngestStatus;
  /** Records the baseline historyId and starts syncing. Called by google.completeConnect. */
  onAccountConnected(accountId: string): Promise<void>;
  /** Bounded resync (recent messages), resets the history cursor, emits sync.gap. */
  resync(accountId: string): Promise<Account>;
  pause(accountId: string): Promise<Account>;
  resume(accountId: string): Promise<Account>;
  /** FROZEN. Process new history now, e.g. right after an agent sent mail. Never throws. */
  kick(accountId?: string): void;
}
