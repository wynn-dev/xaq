// Agent-facing HTTP API under /agent/v1. Used by `npx xaq-cli connect` (device-flow pairing)
// and `npx xaq-cli listen` (outbound event stream that wakes local agents).
//
// Routes:
//   POST /agent/v1/pairings                  PairingStartInput → PairingStart          (public; rate-limited)
//   POST /agent/v1/pairings/poll             { deviceCode }    → PairingPoll           (public; ≥ `interval` s apart)
//   GET  /agent/v1/me                        → AgentSelf                                (bearer aib_ key)
//   GET  /agent/v1/events/stream             → text/event-stream                        (bearer aib_ key)
//        ?consumer=<name>&after=<seq>&types=a,b&include_body=1&start=now|beginning
//        Each event:  `id: <seq>` `event: mail` `data: <EventPayload JSON>`; `: ping` comments every 15 s;
//        `event: revoked` `data: {"reason": …}` then close when the key, agent or grant stops being valid.
//        Resumes after max(after, Last-Event-ID, the consumer's acked cursor). A consumer seen for the
//        first time starts at the head (newest event the agent can see: only new mail), or at 0 with
//        `start=beginning` (honored only for a new consumer). Consumer names: 1-100 of [A-Za-z0-9._-].
//   POST /agent/v1/events/ack                { consumer, seq } → { ackedSeq }          (bearer aib_ key)
//
// Requests must not carry Origin or Sec-Fetch-* headers (browsers are refused), POST bodies must be
// `Content-Type: application/json`, and the Host must be one this daemon answers to (DNS-rebinding guard).
// `after`, Last-Event-ID and acks are capped at the newest event the agent can see.
//
// Access errors on /me and the stream (and the matching `revoked` reasons):
//   reversible (keep the key, retry later):  403 agent_disabled, 403 no_read_grant (stream only)
//   permanent (pair again):                  401 unauthorized (unknown or rotated key; revoked reasons
//                                            key_rotated and agent_deleted)
//
// Pairing (approved design): the CLI starts a pairing and shows `userCode` + `verificationUrl`; a human
// approves that exact code in the console (choosing the access, read by default). Only then is
// the API key generated; it is handed to the polling CLI exactly once and written to a 0600 file.
// Codes are short-lived and single-use; requests, approvals, denials, expiry and key delivery are audited.

import type { AccessLevel } from "./types.ts";

/** The agent tools the CLI and the console know (recipes, connect commands). */
export const AGENT_TOOLS = ["claude-code", "codex", "cursor", "hermes", "other"] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

export interface PairingStartInput {
  /** Human-readable agent name, e.g. "Hermes on wynn-mbp". */
  name: string;
  description?: string | null;
  /** What the agent asks for. The human decides in the console. */
  requested?: {
    accounts?: string[]; // account emails
    reason?: string;
  };
  client?: { hostname?: string; platform?: string; tool?: AgentTool; version?: string };
}

export interface PairingStart {
  /** Secret the CLI polls with. Never shown to the human. */
  deviceCode: string;
  /** Short code the human matches in the console, e.g. "K7QM-2XPD". */
  userCode: string;
  /** Console page that opens this request. */
  verificationUrl: string;
  expiresAt: string;
  /** Minimum seconds between polls. */
  interval: number;
}

export type PairingPoll =
  | { status: "pending" }
  /**
   * Polled faster than the current interval (RFC 8628): `interval` is the previous one + 5 s and is
   * enforced for this pairing from now on, so keep polling at least that far apart.
   */
  | { status: "slow_down"; interval: number }
  | {
      status: "approved";
      /** Delivered exactly once; later polls return "consumed". */
      apiKey: string;
      agent: { id: string; name: string };
      mcpUrl: string;
      skillUrl: string;
    }
  | { status: "denied"; note: string | null }
  | { status: "expired" }
  | { status: "consumed" };

export interface AgentSelf {
  id: string;
  name: string;
  grants: {
    accountId: string;
    accountEmail: string;
    level: AccessLevel;
    /** Recipient allowlist for sends and calendar attendees; empty = anyone. */
    allowTo: string[];
  }[];
  /**
   * This agent's listener consumers (absent from older daemons). `startSeq`: where the cursor started
   * when the consumer was created (mail at or below it predates that listener; what `listen --backfill`
   * replays); null when unknown (created before the daemon recorded it).
   */
  consumers?: { consumer: string; startSeq: number | null; ackedSeq: number; connected: boolean }[];
  /**
   * MCP broker connections this agent may use (absent from older daemons): the
   * connection's name, its tool prefix (`<slug>__`) and this agent's level. Nothing else about the connection.
   */
  connections?: { name: string; slug: string; level: AccessLevel }[];
  mcpUrl: string;
  skillUrl: string;
  /** Newest event seq this agent can see: where a new consumer starts ("from now on"). */
  headSeq: number;
}
