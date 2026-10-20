// `xaq smoke google-workspace` (server/smoke): the admin-only endpoints it uses (server/api/smoke.ts), shared by
// the daemon and the CLI. Everything here is scoped to a smoke run: the agent's name is the run's marker, and a
// draft may be read or deleted only when that agent created it and its subject carries the marker.
//
//   POST /api/smoke/agents          SmokeAgentInput          → AgentWithKey (the run's temporary agent)
//   POST /api/smoke/drafts/inspect  SmokeDraftInput          → SmokeDraftView
//   POST /api/smoke/drafts/delete   SmokeDraftInput          → { deleted: true }
//   POST /api/smoke/leftovers       SmokeLeftoversInput      → SmokeLeftovers
//   POST /api/smoke/sweep           {}                       → SmokeSweep (earlier runs' leftovers)

/** A run's marker: `xaq-smoke-<UTC timestamp>`, e.g. xaq-smoke-20261019T203000Z. Names the agent and the folder. */
export const SMOKE_NAME_RE = /^xaq-smoke-\d{8}T\d{6}Z$/;

/** The UTC timestamp a marker carries: 2026-10-19T20:30:00.123Z → 20261019T203000Z. */
export function smokeStamp(at: Date): string {
  return at.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

export const smokeName = (at: Date): string => `xaq-smoke-${smokeStamp(at)}`;

/** The draft's subject starts with this, so the daemon can tell the run's draft from any other. */
export const smokeSubjectPrefix = (name: string): string => `[${name}]`;

export interface SmokeAgentInput {
  /** The marker (SMOKE_NAME_RE). */
  name: string;
  /** The Gmail account: read + draft only, drafts addressed to its own address. */
  accountId: string;
  /** The google-workspace connection, granted at "ask". */
  connectionId: string;
}

export interface SmokeDraftInput {
  /** The run's agent (its name is the marker). */
  agentId: string;
  accountId: string;
  draftId: string;
  /** The draft ids the command created (its ledger): draftId must be one of them. */
  ledger: string[];
}

export interface SmokeDraftView {
  draftId: string;
  subject: string;
  /** Every recipient (To, Cc, Bcc), lower-cased addresses. */
  recipients: string[];
  attachments: { filename: string; mimeType: string; size: number }[];
}

export interface SmokeLeftoversInput {
  /** The run's agent; null when it was never created (the other checks still run). */
  agentId: string | null;
  accountId: string;
  /** Drafts the run recorded. The daemon adds every draft the agent created according to the audit log. */
  draftIds: string[];
}

export interface SmokeLeftovers {
  /** The run's agent still exists. */
  agent: boolean;
  /** The agent's per-agent settings (tool mode) are still stored. */
  agentSettings: boolean;
  /** Drafts (the ledger's and the audit log's) that still exist in Gmail. */
  drafts: string[];
  /** Other agents named like a smoke run (an earlier run that couldn't clean up). */
  otherSmokeAgents: { id: string; name: string }[];
}

/**
 * POST /api/smoke/sweep: what earlier runs left, at the start of a run. Their agents are deleted and their temp dirs
 * taken out of attachmentDirs; drafts they made that still exist are only reported, for the owner to check.
 */
export interface SmokeSweep {
  deletedAgents: { id: string; name: string }[];
  /** attachmentDirs entries named xaq-smoke-… that were removed. */
  removedDirs: string[];
  drafts: { draftId: string; account: string; agent: string }[];
}

/** An attachmentDirs entry a smoke run added: its last segment starts with xaq-smoke-. */
export const isSmokeDir = (dir: string): boolean => /(^|[\\/])xaq-smoke-[^\\/]*[\\/]?$/.test(dir);
