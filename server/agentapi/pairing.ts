import { randomInt } from "node:crypto";
import { z } from "zod";
import type { AgentTool, PairingPoll, PairingStart } from "../../shared/agent-api.ts";
import type { Agent, ApprovePairingInput, PairingRequest, PairingStatus } from "../../shared/types.ts";
import type { AuditInput } from "../audit.ts";
import { ADMIN_ACTOR } from "../api/util.ts";
import { clientKey } from "../auth/lockout.ts";
import type { BusEvents } from "../bus.ts";
import type { AppContext } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { json } from "../db/index.ts";
import { grantInputSchema } from "../policy/grants.ts";
import { badRequest, HttpError, notFound } from "../util/errors.ts";
import { newId, randomToken } from "../util/ids.ts";

export interface PairingOptions {
  clock?: () => number;
  /** How long a code stays valid. Default 10 minutes. */
  ttlMs?: number;
  /** Minimum seconds between polls. Default 3. */
  intervalSeconds?: number;
  /** After approval the CLI always gets at least this long to collect the key. Default 2 minutes. */
  collectGraceMs?: number;
  /** Global cap on pending requests. Default 20. */
  maxPending?: number;
  /** Pending requests per source (IPv4 address or IPv6 /64). Default 3. */
  maxPendingPerSource?: number;
}

/** No 0/O, 1/I/L: easy to read aloud and compare. */
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** 48 base32 chars = 240 bits. */
const DEVICE_CODE_CHARS = 48;
/** Slack for client timers and network jitter before a poll counts as too fast. */
const POLL_JITTER_MS = 250;
/** RFC 8628: each slow_down adds 5 s to the interval the client must keep. */
const SLOW_DOWN_STEP_S = 5;
const MAX_INTERVAL_S = 60;

export const PAIRING_STATUSES: PairingStatus[] = ["pending", "approved", "denied", "expired"];
const AGENT_TOOLS = ["claude-code", "codex", "cursor", "hermes", "other"] as const satisfies readonly AgentTool[];

/**
 * Requester-supplied text is shown to the approving human: drop control and format characters
 * (ANSI escapes, BEL, newlines, zero-width, bidi overrides, tag characters) so it can't disguise itself.
 */
export const cleanText = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim();
const text = (max: number, label = "Text") => z.string().transform(cleanText).pipe(z.string().max(max, `${label} must be at most ${max} characters`));

export const pairingStartSchema = z.object({
  name: z.string().transform(cleanText).pipe(z.string().min(1, "Name is required").max(80, "Name must be at most 80 characters")),
  description: text(500, "Description").nullable().optional(),
  /** Informational only: approval never pre-fills grants from it. */
  requested: z
    .object({
      accounts: z.array(text(320).pipe(z.string().min(1))).max(50).optional(),
      reason: text(500, "Reason").optional(),
    })
    .optional(),
  client: z
    .object({
      hostname: text(255).optional(),
      platform: text(50).optional(),
      tool: z.enum(AGENT_TOOLS).catch("other").optional(),
      version: text(50).optional(),
    })
    .optional(),
});

export const pollSchema = z.object({ deviceCode: z.string().min(1).max(200) });

export const approveSchema = z.object({
  /** The code shown in the agent's terminal, typed by the human: proves they approve that request. */
  userCode: z.string().min(1, "Type the code shown in the agent's terminal").max(20),
  name: z.string().transform(cleanText).pipe(z.string().min(1).max(80)).optional(),
  // May be empty: an install with only connections (Notion, WHOOP…) pairs agents without Gmail.
  grants: z.array(grantInputSchema).max(100),
  connections: z
    .array(z.object({ connectionId: z.string().min(1).max(64), level: z.enum(["full", "read", "none"]) }))
    .max(100)
    .optional(),
}) satisfies z.ZodType<ApprovePairingInput>;

export const denySchema = z.object({ note: text(500, "Note").nullable().optional() });

/** "k7qm 2xpd", "K7QM-2XPD" and "k7qm2xpd" compare equal. */
const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

interface PairingRow {
  id: string;
  device_code_hash: string;
  user_code: string;
  name: string;
  description: string | null;
  requested: string;
  client: string;
  ip: string | null;
  status: PairingStatus;
  agent_id: string | null;
  api_key_enc: string | null;
  last_poll_at: string | null;
  decided_at: string | null;
  decision_note: string | null;
  delivered_at: string | null;
  created_at: string;
  expires_at: string;
}

const toPairing = (r: PairingRow): PairingRequest => ({
  id: r.id,
  userCode: r.user_code,
  name: r.name,
  description: r.description,
  requested: json.parse(r.requested, {}),
  client: json.parse(r.client, {}),
  ip: r.ip,
  status: r.status,
  agentId: r.agent_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
});

export interface PairingService {
  /** Base poll interval in seconds. */
  readonly intervalSeconds: number;
  /** Which pending cap a new request from this source would exceed, if any. `local` sources skip the global cap. */
  capReached(source: string, local?: boolean): "global" | "source" | null;
  start(input: z.infer<typeof pairingStartSchema>, ip: string): PairingStart;
  /** Unknown device codes return null (the caller counts them toward the per-IP lockout). */
  poll(deviceCode: string): PairingPoll | null;
  list(status?: PairingStatus): PairingRequest[];
  get(id: string): PairingRequest | null;
  approve(id: string, input: z.infer<typeof approveSchema>): Agent;
  deny(id: string, note?: string | null): PairingRequest;
  /**
   * Expires overdue pending requests, and approved requests whose key was never collected: their
   * key is wiped and the agent created on approval is deleted (unless an admin has since rotated
   * its key and taken it over), so no undelivered credential lingers. Also prunes decided requests
   * older than the retention period. Returns how many expired.
   */
  sweep(): number;
  /** Bus "agent" listener: an admin rotating, editing or deleting the agent before the CLI collected the key. */
  onAgentChange(change: BusEvents["agent"][0]): void;
}

export function createPairingService(ctx: AppContext, opts: PairingOptions = {}): PairingService {
  const { db } = ctx;
  const clock = opts.clock ?? Date.now;
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const intervalSeconds = opts.intervalSeconds ?? 3;
  const graceMs = opts.collectGraceMs ?? 2 * 60_000;
  const maxPending = opts.maxPending ?? 20;
  const maxPerSource = opts.maxPendingPerSource ?? 3;
  const iso = (ms = clock()) => new Date(ms).toISOString();
  /** Interval each pairing must keep after slow_down responses (in memory; resets to the base on restart). */
  const intervals = new Map<string, number>();

  const row = (id: string) => db.get<PairingRow>("SELECT * FROM pairings WHERE id = ?", id);
  const publish = (id: string) => {
    const r = row(id);
    if (!r) return;
    try {
      ctx.bus.emit("pairing", toPairing(r));
    } catch (err) {
      ctx.log.error("Bus listener failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };
  const audit = (r: PairingRow, input: Omit<AuditInput, "target">) =>
    ctx.audit.record({ target: r.id, ...input, detail: { userCode: r.user_code, name: r.name, ...input.detail } });
  const urls = () => {
    const base = ctx.settings.publicUrl();
    return { mcpUrl: `${base}/mcp`, skillUrl: `${base}/skill.md`, base };
  };
  /** The stored key is still the agent's current key (no rotation since approval). */
  const keyIsCurrent = (r: PairingRow): boolean => {
    if (!r.agent_id || !r.api_key_enc) return false;
    const agent = db.get<{ key_hash: string }>("SELECT key_hash FROM agents WHERE id = ?", r.agent_id);
    try {
      return !!agent && agent.key_hash === sha256(ctx.crypto.decrypt(r.api_key_enc));
    } catch {
      return false;
    }
  };

  function newUserCode(): string {
    for (;;) {
      let s = "";
      for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
      const code = `${s.slice(0, 4)}-${s.slice(4)}`;
      if (!db.get("SELECT 1 FROM pairings WHERE user_code = ? AND status IN ('pending', 'approved')", code)) return code;
    }
  }

  function sweep(): number {
    const t = iso();
    let expired = 0;
    for (const r of db.all<PairingRow>("SELECT * FROM pairings WHERE status = 'pending' AND expires_at <= ?", t)) {
      if (!db.run("UPDATE pairings SET status = 'expired' WHERE id = ? AND status = 'pending'", r.id).changes) continue;
      expired++;
      audit(r, { actorType: "system", action: "pairing.expired", outcome: "ok", detail: { reason: "not_approved" } });
      publish(r.id);
    }
    // Approved, but the CLI never came back for the key: remove the credential and, unless an admin
    // took the agent over (rotated its key), the agent itself.
    for (const r of db.all<PairingRow>("SELECT * FROM pairings WHERE status = 'approved' AND api_key_enc IS NOT NULL AND expires_at <= ?", t)) {
      const deleteAgent = keyIsCurrent(r);
      db.tx(() => {
        db.run("UPDATE pairings SET status = 'expired', api_key_enc = NULL WHERE id = ?", r.id);
        if (deleteAgent) db.run("DELETE FROM agents WHERE id = ?", r.agent_id);
      });
      expired++;
      audit(r, {
        actorType: "system",
        action: "pairing.expired",
        outcome: "ok",
        detail: { reason: "key_not_collected", keyCollected: false, agentDeleted: deleteAgent ? r.agent_id : null },
      });
      if (deleteAgent) ctx.bus.emit("agent", { agentId: r.agent_id!, reason: "deleted" });
      publish(r.id);
    }
    for (const id of intervals.keys()) {
      if (!db.get("SELECT 1 FROM pairings WHERE id = ? AND (status = 'pending' OR api_key_enc IS NOT NULL)", id)) intervals.delete(id);
    }
    const before = iso(clock() - ctx.settings.get().retentionDays * 86_400_000);
    db.run("DELETE FROM pairings WHERE status IN ('denied', 'expired', 'approved') AND api_key_enc IS NULL AND created_at < ?", before);
    return expired;
  }

  function requirePending(id: string): PairingRow {
    sweep();
    const r = row(id);
    if (!r) throw notFound("Pairing request");
    if (r.status !== "pending") {
      throw new HttpError(409, "conflict", `This pairing request is already ${r.status}`, "Run `npx xaq-cli connect` again to start a new one.");
    }
    return r;
  }

  /** Wipes an undelivered key, e.g. once the agent was deleted or taken over in the console. */
  function withdrawKey(r: PairingRow, status: "approved" | "expired", reason: string): void {
    // Taken over: stays approved and counts as handled (later polls say "consumed"), so the sweep leaves the agent alone.
    const changes =
      status === "approved"
        ? db.run("UPDATE pairings SET api_key_enc = NULL, delivered_at = ? WHERE id = ? AND api_key_enc IS NOT NULL", iso(), r.id).changes
        : db.run("UPDATE pairings SET api_key_enc = NULL, status = 'expired' WHERE id = ? AND api_key_enc IS NOT NULL", r.id).changes;
    if (!changes) return;
    intervals.delete(r.id);
    audit(r, {
      actorType: "system",
      action: status === "expired" ? "pairing.expired" : "pairing.key_withdrawn",
      outcome: "ok",
      detail: { reason, agentId: r.agent_id },
    });
    publish(r.id);
  }

  return {
    intervalSeconds,

    capReached(source, local = false) {
      const ips = db.all<{ ip: string | null }>("SELECT ip FROM pairings WHERE status = 'pending' AND expires_at > ?", iso());
      if (!local && ips.length >= maxPending) return "global";
      return ips.filter((r) => clientKey(r.ip ?? "") === source).length >= maxPerSource ? "source" : null;
    },

    start(input, ip) {
      const deviceCode = randomToken(DEVICE_CODE_CHARS);
      const userCode = newUserCode();
      const id = newId("par");
      const t = clock();
      const expiresAt = iso(t + ttlMs);
      db.run(
        `INSERT INTO pairings (id, device_code_hash, user_code, name, description, requested, client, ip, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        id,
        sha256(deviceCode),
        userCode,
        input.name,
        input.description || null,
        json.str(input.requested ?? {}),
        json.str(input.client ?? {}),
        ip,
        iso(t),
        expiresAt,
      );
      audit(row(id)!, { actorType: "system", action: "pairing.requested", outcome: "ok", detail: { ip, tool: input.client?.tool ?? null, hostname: input.client?.hostname ?? null } });
      publish(id);
      return {
        deviceCode,
        userCode,
        verificationUrl: `${urls().base}/approvals?pairing=${userCode}`,
        expiresAt,
        interval: intervalSeconds,
      };
    },

    poll(deviceCode) {
      const found = db.get<PairingRow>("SELECT * FROM pairings WHERE device_code_hash = ?", sha256(deviceCode));
      if (!found) return null;
      const t = clock();
      const interval = intervals.get(found.id) ?? intervalSeconds;
      const tooFast = !!found.last_poll_at && t - Date.parse(found.last_poll_at) < interval * 1000 - POLL_JITTER_MS;
      db.run("UPDATE pairings SET last_poll_at = ? WHERE id = ?", iso(t), found.id);
      if (tooFast) {
        const next = Math.min(interval + SLOW_DOWN_STEP_S, MAX_INTERVAL_S);
        intervals.set(found.id, next);
        return { status: "slow_down", interval: next };
      }
      if (found.expires_at <= iso(t)) sweep();
      const r = row(found.id)!;
      switch (r.status) {
        case "pending":
          return { status: "pending" };
        case "denied":
          return { status: "denied", note: r.decision_note };
        case "expired":
          return { status: "expired" };
        case "approved":
          break;
      }
      if (r.delivered_at) return { status: "consumed" };
      if (!r.api_key_enc) return { status: "expired" };
      if (!keyIsCurrent(r)) {
        // Deleted or rotated in the console before the CLI collected it: the stored key is dead.
        withdrawKey(r, "expired", r.agent_id && db.get("SELECT 1 FROM agents WHERE id = ?", r.agent_id) ? "key_rotated" : "agent_deleted");
        return { status: "expired" };
      }
      // Exactly once: only the poll that clears the ciphertext gets the key.
      const claimed = db.run("UPDATE pairings SET api_key_enc = NULL, delivered_at = ? WHERE id = ? AND api_key_enc IS NOT NULL", iso(t), r.id).changes;
      if (!claimed) return { status: "consumed" };
      intervals.delete(r.id);
      const agent = db.get<{ id: string; name: string }>("SELECT id, name FROM agents WHERE id = ?", r.agent_id!)!;
      const apiKey = ctx.crypto.decrypt(r.api_key_enc);
      ctx.audit.record({ actorType: "agent", actorId: agent.id, action: "pairing.key_delivered", target: r.id, outcome: "ok", detail: { userCode: r.user_code } });
      publish(r.id);
      const { mcpUrl, skillUrl } = urls();
      return { status: "approved", apiKey, agent: { id: agent.id, name: agent.name }, mcpUrl, skillUrl };
    },

    list(status) {
      sweep();
      const rows = status
        ? db.all<PairingRow>("SELECT * FROM pairings WHERE status = ? ORDER BY created_at DESC, id LIMIT 200", status)
        : db.all<PairingRow>("SELECT * FROM pairings ORDER BY created_at DESC, id LIMIT 200");
      return rows.map(toPairing);
    },

    get(id) {
      const r = row(id);
      return r ? toPairing(r) : null;
    },

    approve(id, input) {
      const r = requirePending(id);
      if (normalizeCode(input.userCode) !== normalizeCode(r.user_code)) {
        audit(r, { ...ADMIN_ACTOR, action: "pairing.approved", outcome: "denied", reason: "user_code_mismatch" });
        throw new HttpError(
          409,
          "user_code_mismatch",
          "That code doesn't match this pairing request",
          "Type the code shown in the agent's terminal. If it shows a different code, deny this request: someone else may have started it.",
        );
      }
      // Something to grant: a mailbox, or a connection at read or more (the card's choices are all there is).
      if (!input.grants.length && !(input.connections ?? []).some((c) => c.level !== "none")) {
        throw badRequest("Choose something for this agent: a mailbox or a connection", "Give it access to a Gmail account or to a connection on the approval card.");
      }
      const seen = new Set<string>();
      for (const g of input.grants) {
        if (seen.has(g.accountId)) throw badRequest(`Only one grant per account (duplicate ${g.accountId})`);
        seen.add(g.accountId);
      }
      const t = clock();
      const agentId = db.tx(() => {
        const { agent, apiKey } = ctx.policy.createAgent(
          { name: input.name ?? r.name, description: r.description, grants: input.grants, connections: input.connections },
          // Only what the approver saw and chose: no "All agents" inheritance behind the card.
          { origin: "paired", inheritAllAgents: false },
        );
        const changes = db.run(
          `UPDATE pairings SET status = 'approved', agent_id = ?, api_key_enc = ?, decided_at = ?, expires_at = ?
           WHERE id = ? AND status = 'pending'`,
          agent.id,
          ctx.crypto.encrypt(apiKey),
          iso(t),
          iso(Math.max(Date.parse(r.expires_at), t + graceMs)),
          id,
        ).changes;
        if (!changes) throw new HttpError(409, "conflict", "This pairing request was decided meanwhile");
        return agent.id;
      });
      audit(r, {
        ...ADMIN_ACTOR,
        action: "pairing.approved",
        outcome: "ok",
        detail: {
          agentId,
          grants: input.grants.map((g) => ({ accountId: g.accountId, level: g.level })),
          connections: (input.connections ?? []).filter((c) => c.level !== "none").map((c) => ({ connectionId: c.connectionId, level: c.level })),
        },
      });
      publish(id);
      return ctx.policy.getAgent(agentId)!;
    },

    deny(id, note) {
      const r = requirePending(id);
      db.run("UPDATE pairings SET status = 'denied', decided_at = ?, decision_note = ? WHERE id = ?", iso(), note || null, id);
      audit(r, { ...ADMIN_ACTOR, action: "pairing.denied", outcome: "ok" });
      intervals.delete(id);
      publish(id);
      return toPairing(row(id)!);
    },

    sweep,

    onAgentChange({ agentId, reason }) {
      if (reason === "deleted") {
        // agent_id is already NULL (ON DELETE SET NULL): any approved row still holding a key lost its agent.
        for (const r of db.all<PairingRow>("SELECT * FROM pairings WHERE status = 'approved' AND api_key_enc IS NOT NULL AND (agent_id IS NULL OR agent_id = ?)", agentId)) {
          withdrawKey(r, "expired", "agent_deleted");
        }
      } else if (reason === "key_rotated" || reason === "updated") {
        // The admin took the agent over (new key, or edited it): the pairing's key must not be handed out later.
        for (const r of db.all<PairingRow>("SELECT * FROM pairings WHERE status = 'approved' AND api_key_enc IS NOT NULL AND agent_id = ?", agentId)) {
          withdrawKey(r, "approved", reason === "key_rotated" ? "key_rotated" : "agent_updated");
        }
      }
    },
  };
}
