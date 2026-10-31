import type { ActorType, AuditEntry, AuditOutcome, Page } from "../shared/types.ts";
import type { Bus } from "./bus.ts";
import { type Db, json, now } from "./db/index.ts";

export interface AuditInput {
  actorType: ActorType;
  actorId?: string | null;
  /** MCP tool name or console action, e.g. "send_message", "agent.create", "account.connect". */
  action: string;
  accountId?: string | null;
  target?: string | null;
  outcome: AuditOutcome;
  /** Required for denials: the guardrail that blocked it ("allow_to", "read_only", …). */
  reason?: string | null;
  durationMs?: number | null;
  /** Small, non-sensitive context. Never message bodies, keys or tokens. */
  detail?: Record<string, unknown> | null;
}

/**
 * SQL condition for an MCP tool call in audit_log: an agent actor and an action without a "." (tool
 * names are like "send_message"; "pairing.key_delivered" and console actions have a dot). The same
 * rule as isMcpToolAction in shared/types.ts (used by the console). `t` is the table alias, if any.
 *
 * Every outcome counts, including calls rejected before a tool ran (unknown tool, invalid arguments,
 * a malformed tools/call): those are recorded with outcome "error" (see rejectedCall in
 * server/mcp/server.ts), so the Overview's "Tool calls" counts them. Anything that needs proof that
 * an agent works (anyAgentVerified, the wizard's checks) adds `outcome = 'ok'`.
 */
export function mcpToolCallSql(t?: string): string {
  const c = t ? `${t}.` : "";
  return `${c}actor_type = 'agent' AND instr(${c}action, '.') = 0`;
}

export interface AuditQuery {
  agentId?: string;
  accountId?: string;
  outcome?: AuditOutcome;
  action?: string;
  /** Opaque cursor from a previous page. */
  cursor?: string | null;
  limit?: number;
}

interface AuditRow {
  id: number;
  ts: string;
  actor_type: ActorType;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  account_id: string | null;
  target: string | null;
  outcome: AuditOutcome;
  reason: string | null;
  duration_ms: number | null;
  detail: string | null;
}

const SELECT = `SELECT a.*, CASE a.actor_type WHEN 'agent' THEN ag.name WHEN 'admin' THEN 'admin' ELSE NULL END AS actor_name
  FROM audit_log a LEFT JOIN agents ag ON a.actor_type = 'agent' AND ag.id = a.actor_id`;

const toEntry = (r: AuditRow): AuditEntry => ({
  id: r.id,
  ts: r.ts,
  actorType: r.actor_type,
  actorId: r.actor_id,
  actorName: r.actor_name,
  action: r.action,
  accountId: r.account_id,
  target: r.target,
  outcome: r.outcome,
  reason: r.reason,
  durationMs: r.duration_ms,
  detail: json.parse<Record<string, unknown> | null>(r.detail, null),
});

/** Append-only audit log. Every agent tool call and every admin mutation is recorded. */
export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly bus: Bus,
  ) {}

  record(input: AuditInput): AuditEntry {
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO audit_log (ts, actor_type, actor_id, action, account_id, target, outcome, reason, duration_ms, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      now(),
      input.actorType,
      input.actorId ?? null,
      input.action,
      input.accountId ?? null,
      input.target ?? null,
      input.outcome,
      input.reason ?? null,
      input.durationMs ?? null,
      input.detail ? json.str(input.detail) : null,
    );
    const entry = toEntry(this.db.get<AuditRow>(`${SELECT} WHERE a.id = ?`, lastInsertRowid)!);
    this.bus.emit("audit", entry);
    return entry;
  }

  /** Newest first. */
  list(q: AuditQuery = {}): Page<AuditEntry> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const add = (clause: string, value: string | number) => {
      where.push(clause);
      params.push(value);
    };
    if (q.agentId) add("a.actor_id = ?", q.agentId);
    if (q.accountId) add("a.account_id = ?", q.accountId);
    if (q.outcome) add("a.outcome = ?", q.outcome);
    if (q.action) add("a.action = ?", q.action);
    const before = Number(q.cursor);
    if (q.cursor && Number.isInteger(before)) add("a.id < ?", before);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const rows = this.db.all<AuditRow>(
      `${SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.id DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const items = rows.slice(0, limit).map(toEntry);
    return { items, nextCursor: rows.length > limit ? String(items.at(-1)!.id) : null };
  }

  /** Deletes entries older than `beforeIso`. Returns the number removed. */
  prune(beforeIso: string): number {
    return this.db.run("DELETE FROM audit_log WHERE ts < ?", beforeIso).changes;
  }
}
