// BrokerPolicy: the level, the tool's risk, the
// "always allow" rules and the per-agent caps on risky calls. Never runs the call.

import type { Db } from "../../db/index.ts";
import type { SettingsStore } from "../../settings.ts";
import type { BrokerPolicy, CallDecision, RegisteredTool } from "../types.ts";
import { atPointer } from "./canonical.ts";
import { connectionLabel, reconnectMessage } from "./errors.ts";
import { brokerLimits, connectionInfo, rulesAllow, rulesFor } from "./store.ts";

/**
 * Audit detail flag on broker calls that count toward the risky caps: risky calls that ran, were queued for
 * approval, or have an unknown outcome. Denials and calls that provably never reached the upstream don't count.
 */
export const RISKY_COUNTED = "riskyCounted";

/** Risky calls by this agent since `sinceIso` that count toward the caps (from the audit log). */
export function riskyCallsSince(db: Db, agentId: string, sinceIso: string): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_log
       WHERE actor_type = 'agent' AND actor_id = ? AND ts >= ? AND json_extract(detail, '$.${RISKY_COUNTED}') = 1`,
      agentId,
      sinceIso,
    )?.n ?? 0
  );
}

/** Risky calls checked but not yet audited, per database (= app context), per agent. */
const inFlightByDb = new WeakMap<Db, Map<string, number>>();

export interface BrokerPolicyImpl extends BrokerPolicy {
  /**
   * Holds a risky-call slot for the agent until the call's outcome is in the audit log (then call the
   * release). Take it synchronously right after an allow/ask from `decide`, so concurrent calls can't all
   * pass the cap check before any of them is recorded.
   */
  reserveRisky(agentId: string): () => void;
}

export function createBrokerPolicy(deps: { db: Db; settings: SettingsStore }): BrokerPolicyImpl {
  const { db, settings } = deps;
  let inFlight = inFlightByDb.get(db);
  if (!inFlight) inFlightByDb.set(db, (inFlight = new Map()));
  const counts = inFlight;

  const deny = (reason: string, message: string): CallDecision => ({ kind: "deny", reason, message });

  function capExceeded(agentId: string, at = Date.now()): string | null {
    const limits = brokerLimits(settings);
    const pending = counts.get(agentId) ?? 0;
    for (const w of [
      { cap: limits.riskyPerHour, ms: 3_600_000, label: "hour" },
      { cap: limits.riskyPerDay, ms: 86_400_000, label: "24 hours" },
    ]) {
      if (w.cap === null) continue;
      const used = riskyCallsSince(db, agentId, new Date(at - w.ms).toISOString()) + pending;
      if (used >= w.cap) {
        return `Limit reached: ${used} of ${w.cap} risky tool calls (deleting, sending, publishing, paying) in the last ${w.label}. Nothing was sent. Try again later, or ask the owner to raise the limit.`;
      }
    }
    return null;
  }

  function decide(agentId: string, tool: RegisteredTool, args: Record<string, unknown>): CallDecision {
    const conn = connectionInfo(db, tool.connectionId);
    if (!conn) return deny("unknown_connection", `${tool.exposedName} is no longer available: its connection was removed.`);
    if (conn.status === "disabled") {
      return deny("connection_disabled", `${conn.name} is turned off in xaq, so its tools can't be used. Nothing was sent. Only the owner can turn it back on.`);
    }
    // Expired (T3: 30 days, no refresh) counts even before the sweep marks it: never a 401 mid-task.
    const label = connectionLabel(conn, settings.publicUrl());
    if (conn.status === "needs_reauth" || label.expired) return deny(label.expired ? "expired" : "needs_reauth", reconnectMessage(label));

    switch (tool.level) {
      case "read":
        // The registry lists read tools only at this level; a non-read tool here is a bug or a race.
        if (!tool.cls.read || tool.cls.risky) {
          return deny("read_only", `You have read-only access to ${conn.name}, and ${tool.exposedName} can change things there. Nothing was sent.`);
        }
        return { kind: "allow" };
      case "full":
      case "ask": {
        if (!tool.cls.risky) return { kind: "allow" };
        const capped = capExceeded(agentId);
        if (capped) return deny("rate_limit", capped);
        if (tool.level === "full") return { kind: "allow" };
        const rule = rulesAllow(rulesFor(db, agentId, tool.connectionId, tool.def.name), (pointer) => atPointer(args, pointer));
        return rule ? { kind: "allow", ruleId: rule.id } : { kind: "ask" };
      }
      default:
        return deny("no_access", `You don't have access to ${conn.name}.`);
    }
  }

  function reserveRisky(agentId: string): () => void {
    counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (counts.get(agentId) ?? 1) - 1;
      if (n > 0) counts.set(agentId, n);
      else counts.delete(agentId);
    };
  }

  return { decide, reserveRisky };
}
