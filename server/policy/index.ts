import { z } from "zod";
import { type AccessLevel, type Agent, type AgentOrigin, type AgentWithKey, type CreateAgentInput, type Grant, type GrantInput, isCalendarEventType, isConnectionEventType } from "../../shared/types.ts";
import { listenersOf } from "../agentapi/listeners.ts";
import { ADMIN_ACTOR } from "../api/util.ts";
import { canSeeConnectionEvent } from "../broker/access.ts";
import type { BusEvents } from "../bus.ts";
import type { AppContext } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { bool, type Db, json, now } from "../db/index.ts";
import { badRequest, notFound } from "../util/errors.ts";
import { newId, randomToken } from "../util/ids.ts";
import { Approvals } from "../mail/approvals.ts";
import { CALENDAR_GRANT_DEFAULTS, type GrantRow, parseGrantInput, toGrant } from "./grants.ts";
import { calendarInScope } from "./calendar.ts";
import type { AgentPrincipal, PolicyService } from "./types.ts";

export const API_KEY_PREFIX = "aib_";

/**
 * The connection grants a new agent gets: with `inherit`, every "All agents" connection at its level_default; then
 * the explicit choices on top ("none" leaves one out). Without `inherit` (pairing), only the explicit choices.
 * Unknown connection ids are refused.
 */
function connectionGrantsFor(db: Db, explicit: { connectionId: string; level: AccessLevel | "none" }[], inherit: boolean): { connectionId: string; level: AccessLevel }[] {
  const out = new Map<string, AccessLevel>();
  if (inherit) {
    for (const r of db.all<{ id: string; level_default: AccessLevel }>("SELECT id, level_default FROM connections WHERE all_agents = 1")) out.set(r.id, r.level_default);
  }
  for (const c of explicit) {
    if (!db.get("SELECT 1 AS x FROM connections WHERE id = ?", c.connectionId)) throw badRequest(`Unknown connection ${c.connectionId}`);
    if (!["full", "ask", "read", "none"].includes(c.level)) throw badRequest(`Unknown access level ${String(c.level)}`);
    if (c.level === "none") out.delete(c.connectionId);
    else out.set(c.connectionId, c.level);
  }
  return [...out].map(([connectionId, level]) => ({ connectionId, level }));
}
/** 32 base32 chars = 160 bits of entropy. */
const KEY_RANDOM_CHARS = 32;
/** `last_used_at` and `last_mcp_at` are written at most this often per agent (the first write is immediate). */
const LAST_USED_THROTTLE_MS = 60_000;
/**
 * Account-level events, visible regardless of label or calendar scope: with `read`, or for
 * account.auth_failed also with `calendar.read` (sync.gap is about mail only).
 */
const ACCOUNT_EVENTS = new Set(["account.auth_failed", "sync.gap"]);

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  key_hash: string;
  disabled: number;
  origin: string;
  last_used_at: string | null;
  last_mcp_at: string | null;
  created_at: string;
}

const agentFields = z.object({
  name: z.string().trim().min(1, "Name is required").max(80, "Name must be at most 80 characters"),
  description: z.string().trim().max(500).nullable().optional(),
  disabled: z.boolean().optional(),
});

function parseAgentFields(input: unknown) {
  const r = agentFields.partial({ name: true }).safeParse(input);
  if (!r.success) throw badRequest(z.prettifyError(r.error));
  return r.data;
}

export const newApiKey = (): string => API_KEY_PREFIX + randomToken(KEY_RANDOM_CHARS);

export function createPolicyService(ctx: AppContext): PolicyService {
  const { db } = ctx;
  // Pending approvals are cancelled whenever the agent loses the right to send them.
  const approvals = new Approvals(ctx);

  const grantsOf = (agentId: string): Grant[] =>
    db.all<GrantRow>("SELECT * FROM grants WHERE agent_id = ? ORDER BY created_at, rowid", agentId).map(toGrant);

  const toAgent = (r: AgentRow): Agent => ({
    id: r.id,
    name: r.name,
    description: r.description,
    keyPrefix: r.key_prefix,
    disabled: bool(r.disabled),
    origin: r.origin === "paired" ? "paired" : "key",
    lastUsedAt: r.last_used_at,
    lastMcpAt: r.last_mcp_at,
    createdAt: r.created_at,
    grants: grantsOf(r.id),
    listeners: listenersOf(db, r.id),
  });

  const row = (id: string) => db.get<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
  const requireRow = (id: string) => {
    const r = row(id);
    if (!r) throw notFound("Agent");
    return r;
  };

  const requireAccount = (accountId: string) => {
    if (!db.get("SELECT 1 FROM accounts WHERE id = ?", accountId)) throw notFound(`Account ${accountId}`);
  };

  const writeGrant = (agentId: string, g: GrantInput): Grant => {
    requireAccount(g.accountId);
    // Omitted calendar fields keep the stored values (an older client must never widen the calendar scope).
    const prev = db.get<GrantRow>("SELECT * FROM grants WHERE agent_id = ? AND account_id = ?", agentId, g.accountId);
    const calendarScope = g.calendarScope !== undefined ? g.calendarScope : prev ? toGrant(prev).calendarScope : CALENDAR_GRANT_DEFAULTS.calendarScope;
    const calendarWriteMode = g.calendarWriteMode ?? (prev ? toGrant(prev).calendarWriteMode : CALENDAR_GRANT_DEFAULTS.calendarWriteMode);
    db.run(
      `INSERT INTO grants (id, agent_id, account_id, capabilities, label_scope, send_mode, allow_to, reply_only,
         max_sends_per_hour, max_sends_per_day, calendar_scope, calendar_write_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, account_id) DO UPDATE SET
         capabilities = excluded.capabilities, label_scope = excluded.label_scope, send_mode = excluded.send_mode,
         allow_to = excluded.allow_to, reply_only = excluded.reply_only,
         max_sends_per_hour = excluded.max_sends_per_hour, max_sends_per_day = excluded.max_sends_per_day,
         calendar_scope = excluded.calendar_scope, calendar_write_mode = excluded.calendar_write_mode`,
      newId("grt"),
      agentId,
      g.accountId,
      json.str(g.capabilities),
      g.labelScope === null ? null : json.str(g.labelScope),
      g.sendMode,
      json.str(g.allowTo),
      g.replyOnly ? 1 : 0,
      g.maxSendsPerHour,
      g.maxSendsPerDay,
      calendarScope === null ? null : json.str(calendarScope),
      calendarWriteMode,
      now(),
    );
    return toGrant(db.get<GrantRow>("SELECT * FROM grants WHERE agent_id = ? AND account_id = ?", agentId, g.accountId)!);
  };

  /** Calendar sync only runs for calendars some grant reads: start it now instead of at the next pass. */
  const kickCalendar = (accountId: string) => {
    try {
      ctx.calendar.kick(accountId);
    } catch (err) {
      ctx.log.debug("Calendar kick failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };

  /** The grant reads calendars it didn't before (calendar.read added, or the calendar scope widened). */
  const readsMore = (prev: Grant | null, next: Grant) => {
    if (!prev?.capabilities.includes("calendar.read")) return true;
    if (prev.calendarScope === null) return false;
    return next.calendarScope === null || next.calendarScope.some((id) => !prev.calendarScope!.includes(id));
  };

  const grantSummary = (g: GrantInput) => ({
    capabilities: g.capabilities,
    sendMode: g.sendMode,
    ...(g.calendarWriteMode !== undefined ? { calendarWriteMode: g.calendarWriteMode } : {}),
    ...(g.calendarScope !== undefined ? { calendarScope: g.calendarScope === null ? null : g.calendarScope.length } : {}),
    labelScope: g.labelScope,
    allowTo: g.allowTo.length,
    replyOnly: g.replyOnly,
    maxSendsPerHour: g.maxSendsPerHour,
    maxSendsPerDay: g.maxSendsPerDay,
  });

  /** Live listener streams re-check access on this (after the change is committed). */
  const changed = (agentId: string, reason: BusEvents["agent"][0]["reason"]) => {
    try {
      ctx.bus.emit("agent", { agentId, reason });
    } catch (err) {
      ctx.log.error("Bus listener failed", { error: err instanceof Error ? err.message : String(err) });
    }
    if (reason === "deleted") {
      clearTimeout(pushes.get(agentId)?.timer);
      pushes.delete(agentId);
      mcpWrittenAt.delete(agentId);
    } else {
      publishAgent(agentId);
    }
  };

  // bus "agentState": per agent, when the last one went out and the one scheduled next.
  const pushes = new Map<string, { last: number; timer?: ReturnType<typeof setTimeout> }>();
  let stopped = false;
  const publishAgent = (agentId: string, minIntervalMs = 0) => {
    if (stopped) return;
    let p = pushes.get(agentId);
    if (!p) pushes.set(agentId, (p = { last: 0 }));
    // Already scheduled: that one reads the agent when it fires, so it carries this change too.
    if (p.timer) return;
    const entry = p;
    // Delay 0 still defers to the next macrotask, so changes made together (auth + MCP use) go out once.
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.last = Date.now();
      try {
        const r = row(agentId);
        if (r) ctx.bus.emit("agentState", toAgent(r));
        else pushes.delete(agentId);
      } catch (err) {
        ctx.log.debug("Agent update not published", { error: err instanceof Error ? err.message : String(err) });
      }
    }, Math.max(0, entry.last + minIntervalMs - Date.now()));
    entry.timer.unref?.();
  };

  /**
   * When this process last wrote (or found fresh) each agent's last_mcp_at: /mcp is hit on every tool
   * call, so within the window markMcpUse skips the UPDATE (and the WAL write lock) entirely.
   */
  const mcpWrittenAt = new Map<string, number>();

  /** Writes `column` = now unless it was written within the throttle window; true if it was written. */
  const touchColumn = (column: "last_used_at" | "last_mcp_at", agentId: string): boolean => {
    const ts = Date.now();
    const cutoff = new Date(ts - LAST_USED_THROTTLE_MS).toISOString();
    return (
      db.run(`UPDATE agents SET ${column} = ? WHERE id = ? AND (${column} IS NULL OR ${column} <= ?)`, new Date(ts).toISOString(), agentId, cutoff).changes > 0
    );
  };

  return {
    stop() {
      stopped = true;
      for (const p of pushes.values()) clearTimeout(p.timer);
      pushes.clear();
    },

    publishAgent,

    markMcpUse(agentId) {
      const ts = Date.now();
      if (ts - (mcpWrittenAt.get(agentId) ?? -Infinity) < LAST_USED_THROTTLE_MS) return;
      // Written now, or written recently by an earlier run: either way nothing to do for a while.
      // (A recent write from an earlier run means the next one may come up to a window late.)
      mcpWrittenAt.set(agentId, ts);
      if (touchColumn("last_mcp_at", agentId)) publishAgent(agentId);
    },

    authenticate(apiKey: string): AgentPrincipal | null {
      if (typeof apiKey !== "string" || !apiKey.startsWith(API_KEY_PREFIX) || apiKey.length > 200) return null;
      const r = db.get<AgentRow>("SELECT * FROM agents WHERE key_hash = ?", sha256(apiKey));
      if (!r || bool(r.disabled)) return null;
      if ((!r.last_used_at || Date.now() - Date.parse(r.last_used_at) >= LAST_USED_THROTTLE_MS) && touchColumn("last_used_at", r.id)) {
        publishAgent(r.id);
      }
      return { agentId: r.id, name: r.name };
    },

    listAgents() {
      return db.all<AgentRow>("SELECT * FROM agents ORDER BY created_at, rowid").map(toAgent);
    },

    getAgent(id) {
      const r = row(id);
      return r ? toAgent(r) : null;
    },

    createAgent(input: CreateAgentInput, opts: { origin?: AgentOrigin; inheritAllAgents?: boolean } = {}): AgentWithKey {
      const fields = parseAgentFields(input);
      if (!fields.name) throw badRequest("Name is required");
      const grants = (input.grants ?? []).map(parseGrantInput);
      const seen = new Set<string>();
      for (const g of grants) {
        if (seen.has(g.accountId)) throw badRequest(`Only one grant per account (duplicate ${g.accountId})`);
        seen.add(g.accountId);
      }
      const connections = connectionGrantsFor(db, input.connections ?? [], opts.inheritAllAgents !== false);
      const apiKey = newApiKey();
      const id = newId("agt");
      db.tx(() => {
        db.run(
          "INSERT INTO agents (id, name, description, key_prefix, key_hash, disabled, origin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
          id,
          fields.name!,
          fields.description || null,
          apiKey.slice(0, 8),
          sha256(apiKey),
          opts.origin ?? "key",
          now(),
        );
        for (const g of grants) writeGrant(id, g);
        const t = now();
        for (const c of connections) {
          db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", id, c.connectionId, c.level, t, t);
        }
      });
      // A brand-new agent has no cached tool view or pending calls; the registry is told anyway.
      if (connections.length) ctx.broker?.invalidate({ agentId: id });
      for (const g of grants) if (g.capabilities.includes("calendar.read")) kickCalendar(g.accountId);
      ctx.audit.record({
        ...ADMIN_ACTOR,
        action: "agent.create",
        target: id,
        outcome: "ok",
        detail: { name: fields.name, grants: grants.map((g) => g.accountId), ...(connections.length ? { connections: connections.map((c) => `${c.connectionId}:${c.level}`) } : {}) },
      });
      return { agent: toAgent(requireRow(id)), apiKey };
    },

    updateAgent(id, patch) {
      requireRow(id);
      const fields = parseAgentFields(patch);
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (fields.name !== undefined) {
        sets.push("name = ?");
        params.push(fields.name);
      }
      if (fields.description !== undefined) {
        sets.push("description = ?");
        params.push(fields.description || null);
      }
      if (fields.disabled !== undefined) {
        sets.push("disabled = ?");
        params.push(fields.disabled ? 1 : 0);
      }
      if (sets.length) db.run(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`, ...params, id);
      if (fields.disabled) approvals.cancelForAgent(id, null, "the agent was disabled");
      ctx.audit.record({ ...ADMIN_ACTOR, action: "agent.update", target: id, outcome: "ok", detail: { fields: Object.keys(fields) } });
      changed(id, "updated");
      return toAgent(requireRow(id));
    },

    rotateKey(id) {
      requireRow(id);
      const apiKey = newApiKey();
      db.run("UPDATE agents SET key_prefix = ?, key_hash = ? WHERE id = ?", apiKey.slice(0, 8), sha256(apiKey), id);
      ctx.audit.record({ ...ADMIN_ACTOR, action: "agent.rotate_key", target: id, outcome: "ok" });
      changed(id, "key_rotated");
      return { agent: toAgent(requireRow(id)), apiKey };
    },

    deleteAgent(id) {
      const r = requireRow(id);
      approvals.cancelForAgent(id, null, "the agent was deleted");
      db.run("DELETE FROM agents WHERE id = ?", id);
      // Its tool-mode setting (server/broker/search/mode.ts) lives in the settings table, outside the cascade.
      db.run("DELETE FROM settings WHERE key = ?", `broker.search:${id}`);
      ctx.audit.record({ ...ADMIN_ACTOR, action: "agent.delete", target: id, outcome: "ok", detail: { name: r.name } });
      changed(id, "deleted");
    },

    upsertGrant(agentId, accountId, input) {
      requireRow(agentId);
      const raw = { ...(input as object), accountId };
      if ((input as { accountId?: unknown }).accountId && (input as { accountId?: unknown }).accountId !== accountId) {
        throw badRequest("The grant's accountId does not match the URL");
      }
      const g = parseGrantInput(raw);
      const row = db.get<GrantRow>("SELECT * FROM grants WHERE agent_id = ? AND account_id = ?", agentId, accountId);
      const prev = row ? toGrant(row) : null;
      const grant = writeGrant(agentId, g);
      if (grant.capabilities.includes("calendar.read") && readsMore(prev, grant)) kickCalendar(accountId);
      if (!g.capabilities.includes("send")) approvals.cancelForAgent(agentId, accountId, "the agent's send permission was removed", "mail");
      if (!g.capabilities.includes("calendar.write")) approvals.cancelForAgent(agentId, accountId, "the agent's calendar.write permission was removed", "calendar");
      ctx.audit.record({ ...ADMIN_ACTOR, action: "grant.upsert", accountId, target: agentId, outcome: "ok", detail: grantSummary(g) });
      changed(agentId, "grant_changed");
      return grant;
    },

    deleteGrant(agentId, accountId) {
      requireRow(agentId);
      const { changes } = db.run("DELETE FROM grants WHERE agent_id = ? AND account_id = ?", agentId, accountId);
      if (!changes) throw notFound("Grant");
      approvals.cancelForAgent(agentId, accountId, "the agent's access to this account was removed");
      ctx.audit.record({ ...ADMIN_ACTOR, action: "grant.delete", accountId, target: agentId, outcome: "ok" });
      changed(agentId, "grant_changed");
    },

    grant(agentId, accountId) {
      const r = db.get<GrantRow>("SELECT * FROM grants WHERE agent_id = ? AND account_id = ?", agentId, accountId);
      return r ? toGrant(r) : null;
    },

    grants: grantsOf,

    canSeeEvent(agentId, ev, via = "feed") {
      if (isConnectionEventType(ev.type)) return !!ev.connectionId && canSeeConnectionEvent(db, ctx.settings.get().brokerUpstreams, agentId, ev, via);
      const r = db.get<GrantRow & { disabled: number }>(
        "SELECT g.*, a.disabled FROM grants g JOIN agents a ON a.id = g.agent_id WHERE g.agent_id = ? AND g.account_id = ?",
        agentId,
        ev.accountId,
      );
      if (!r || bool(r.disabled)) return false;
      const g = toGrant(r);
      if (ACCOUNT_EVENTS.has(ev.type)) return g.capabilities.includes("read") || (ev.type === "account.auth_failed" && g.capabilities.includes("calendar.read"));
      if (isCalendarEventType(ev.type)) {
        const calendarId = ev.calendarEvent?.calendarId;
        return g.capabilities.includes("calendar.read") && !!calendarId && calendarInScope(g, calendarId);
      }
      if (!g.capabilities.includes("read")) return false;
      if (g.labelScope === null) return true;
      return ev.threadLabelIds.some((id) => g.labelScope!.includes(id));
    },
  };
}
