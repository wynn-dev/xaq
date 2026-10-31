import { EventEmitter } from "node:events";
import type { Account, Agent, AuditEntry, MailEvent, PairingRequest, Settings } from "../shared/types.ts";

/**
 * In-process notifications. Fired *after* the change is committed to the database, so listeners
 * can read it back. Used by the console SSE stream, `wait_for_events` and the
 * ingest loop (settings changes). Listeners must not throw.
 */
export interface BusEvents {
  /** A new event row was committed. */
  event: [MailEvent];
  audit: [AuditEntry];
  /** An account was connected or its status/sync state changed. */
  account: [Account];
  settings: [Settings];
  /**
   * An agent's access changed: live listener streams re-check the key/grants and close on revocation.
   * Emitted by policy on update (incl. disable), key rotation, deletion and grant upsert/delete.
   */
  agent: [{ agentId: string; reason: "updated" | "key_rotated" | "deleted" | "grant_changed" }];
  pairing: [PairingRequest];
  /**
   * The agent as the console shows it, after its state changed: listener connect/disconnect/ack,
   * key use (lastUsedAt/lastMcpAt writes) and access changes. Coalesced per agent (policy.publishAgent).
   * Sent to the console stream as `{ kind: "agent" }`.
   */
  agentState: [Agent];
}

export type Bus = EventEmitter<BusEvents>;

export function createBus(): Bus {
  const bus = new EventEmitter<BusEvents>();
  // Every SSE client and pending wait_for_events call adds a listener.
  bus.setMaxListeners(0);
  return bus;
}
