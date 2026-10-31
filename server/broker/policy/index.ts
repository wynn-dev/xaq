// Broker policy, calls and mcp.call approvals (docs/MCP-BROKER.md "Access and approvals", "Upstream output is
// untrusted", "Security model"). BrokerPolicyRuntime.call is the single entry point for running an upstream tool: resolve,
// validate against the pin, decide, then run (wrapped, scrubbed, audited) or queue an approval and return
// `pending_approval` at once.

import type { Approval, ApprovalRule, McpCallApproval, McpCallApprovalDetail, McpCallApprovalView, McpCallApproveInput, McpCallResult } from "../../../shared/types.ts";
import type { AppContext } from "../../context.ts";
import { sha256 } from "../../crypto.ts";
import { bool, json, now } from "../../db/index.ts";
import { CANCELLED_PREFIX } from "../../mail/approvals.ts";
import { cleanLine } from "../../mail/content.ts";
import { badRequest, conflict, errorMessage, notFound } from "../../util/errors.ts";
import type { CatalogRegistry } from "../catalog/registry.ts";
import type { CredentialStore } from "../credentials/store.ts";
import type { Refresher } from "../credentials/refresher.ts";
import type { RegisteredTool, ToolResult, ToolSource } from "../types.ts";
import { SourceError } from "../types.ts";
import { fingerprint, redactArgs } from "./audit.ts";
import { argumentPaths, atPointer, canonicalJson, isPointer } from "./canonical.ts";
import { createBrokerPolicy, type BrokerPolicyImpl, RISKY_COUNTED } from "./decide.ts";
import { connectionLabel, describeFailure, type DescribedFailure } from "./errors.ts";
import { connectionSecrets, makeScrubber, type OutputSignals, processResult, resultBytes, type Scrubber } from "./output.ts";
import {
  addRule,
  brokerLimits,
  connectionInfo,
  deleteRule,
  deleteRulesForGrant,
  deleteRulesForTool,
  getRule,
  insertMcpCall,
  listRules,
  type McpCallRow,
  mcpCallRow,
  rulesAllow,
  rulesFor,
  transition,
  updateToolCall,
} from "./store.ts";
import { MAX_ARGS_BYTES, validateArgs, validateOutput } from "./validate.ts";

export { canonicalJson } from "./canonical.ts";

/** Live tool sources per connection (the upstream manager's pool, or a native integration). */
export interface SourceProvider {
  /** The connection's source, connecting if needed; null when it has none (not set up). */
  source(connectionId: string): ToolSource | null | Promise<ToolSource | null>;
  /** Closes and forgets the connection's source (kill switch). Idempotent. */
  close(connectionId: string): Promise<void>;
}

/** `approval.requested`: for the owner (webhooks, the listener, Hermes texting the link). Never the arguments. */
export interface ApprovalRequestedEvent {
  type: "approval.requested";
  approvalId: string;
  agentId: string;
  agentName: string;
  connectionId: string;
  connectionSlug: string;
  connectionName: string;
  /** The upstream's tool name and the exposed `<slug>__<tool>`. */
  tool: string;
  exposedName: string;
  /** `<publicUrl>/approve/<id>`: the one-tap approve page. */
  url: string;
  expiresAt: string;
}

/**
 * Who sees `approval.requested` (wire into policy.canSeeEvent once events carry connection events):
 * - the agent that asked, everywhere (its feed, its listener, its webhooks): it's about its own call;
 * - any webhook explicitly subscribed to `approval.requested`: webhooks are configured by the owner, and the event
 *   holds no arguments or content, only who asked for what and the link (admin-facing, like a notification).
 * Other agents' feeds and listeners never see it.
 */
export function approvalEventVisible(viewerAgentId: string, ev: Pick<ApprovalRequestedEvent, "agentId">, via: "feed" | "listener" | "webhook"): boolean {
  return via === "webhook" || ev.agentId === viewerAgentId;
}

export interface BrokerPolicyDeps {
  registry: Pick<CatalogRegistry, "forAgent" | "resolve">;
  sources: SourceProvider;
  credentials: Pick<CredentialStore, "tokens" | "header" | "client" | "clear">;
  refresher?: Pick<Refresher, "untrack">;
  /** Delivers `approval.requested` (events outbox → webhooks and the listener). Must not throw. */
  onApprovalRequested?: (ev: ApprovalRequestedEvent) => void;
}

/** get_call_status, registered as an MCP tool by the endpoint (`server/mcp`). */
export const GET_CALL_STATUS_TOOL = {
  name: "get_call_status",
  title: "Get call status",
  description:
    "Check on a tool call that is waiting for the owner's approval (it returned pending_approval and an approval_id). " +
    "Says pending, rejected, expired, or done with the call's result. Only your own calls.",
  inputSchema: {
    type: "object",
    properties: { approval_id: { type: "string", description: "The approval_id from the pending_approval answer (apr_…)." } },
    required: ["approval_id"],
    additionalProperties: false,
  },
} as const;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const EMPTY_CALL: McpCallApprovalDetail = { tool: "", exposedName: "", args: "", argsSha256: "", pinHash: "" };
const parseCall = (row: McpCallRow) => json.parse<McpCallApprovalDetail>(row.tool_call, EMPTY_CALL);

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Invisible, bidi, tag and control characters as \u escapes (valid inside JSON strings), so the card shows them. */
const INVISIBLE_DISPLAY =
  // oxlint-disable-next-line no-control-regex, no-misleading-character-class
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB]|\uDB40[\uDC00-\uDDEF]/g;
/** Newlines stay (pretty JSON); everything else in INVISIBLE_DISPLAY becomes \\uXXXX (both halves of a surrogate pair). */
export const showInvisible = (s: string) =>
  s.replace(INVISIBLE_DISPLAY, (m) => Array.from({ length: m.length }, (_, i) => `\\u${m.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase()}`).join(""));

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

function extract(args: unknown): { recipients: string[]; urls: string[] } {
  const recipients = new Set<string>();
  const urls = new Set<string>();
  const walk = (v: unknown) => {
    if (recipients.size >= 50 && urls.size >= 50) return;
    if (typeof v === "string") {
      for (const m of v.match(EMAIL) ?? []) if (recipients.size < 50) recipients.add(m);
      for (const m of v.match(URL_RE) ?? []) if (urls.size < 50) urls.add(m);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(args);
  return { recipients: [...recipients], urls: [...urls] };
}

interface Executed {
  result: ToolResult;
  signals: OutputSignals | null;
  failure: DescribedFailure | null;
  sourceDetail: Record<string, unknown>;
}

export class BrokerPolicyRuntime {
  readonly policy: BrokerPolicyImpl;
  private readonly log;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: BrokerPolicyDeps,
  ) {
    this.policy = createBrokerPolicy({ db: ctx.db, settings: ctx.settings });
    this.log = ctx.log.child("broker.policy");
  }

  /** Startup: approved calls that never finished (the process died mid-call) end with an unknown outcome. */
  start(): void {
    this.recoverInterrupted();
  }

  private scrubberFor(connectionId: string): Scrubber {
    return makeScrubber(connectionSecrets(this.deps.credentials, connectionId));
  }

  // ───────────── Calls ─────────────

  async call(agentId: string, exposedName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const started = Date.now();
    const tool = this.deps.registry.resolve(agentId, exposedName);
    if (!tool) {
      this.ctx.audit.record({ actorType: "agent", actorId: agentId, action: "unknown_tool", outcome: "error", reason: "unknown_tool", detail: { broker: true, tool: cleanLine(exposedName).slice(0, 64) } });
      return text(`${cleanLine(exposedName).slice(0, 64)} isn't a tool you can use. List your tools again: it may have been removed, or your access changed.`, true);
    }
    const conn = connectionInfo(this.ctx.db, tool.connectionId);
    const scrubber = this.scrubberFor(tool.connectionId);
    const base = {
      broker: true,
      connectionId: tool.connectionId,
      slug: tool.slug,
      tool: tool.def.name,
      pinHash: tool.pinHash,
      level: tool.level,
      risky: tool.cls.risky,
    };
    const record = (outcome: "ok" | "denied" | "error", reason: string | null, detail: Record<string, unknown>) =>
      this.ctx.audit.record({ actorType: "agent", actorId: agentId, action: exposedName, target: tool.connectionId, outcome, reason, durationMs: Date.now() - started, detail: { ...base, ...detail } });

    let bytes: string;
    try {
      if (!isPlainObject(args)) throw new TypeError("Arguments must be an object");
      bytes = canonicalJson(args);
      if (Buffer.byteLength(bytes) > MAX_ARGS_BYTES) throw new RangeError(`Arguments are too large (over ${MAX_ARGS_BYTES / 1024 / 1024} MB). Nothing was sent`);
    } catch (err) {
      record("error", "invalid_arguments", {});
      return text(`Invalid arguments for ${exposedName}: ${(err as Error).message}.`, true);
    }
    const fp = fingerprint(bytes);
    const valid = validateArgs(tool.pinHash, tool.def.inputSchema, args);
    if (!valid.ok) {
      record("error", "invalid_arguments", { ...fp });
      return text(`Invalid arguments for ${exposedName}: ${valid.message}. Nothing was sent.`, true);
    }

    const decision = this.policy.decide(agentId, tool, args);
    if (decision.kind === "deny") {
      record("denied", decision.reason, { ...fp, decision: "deny" });
      return text(decision.message, true);
    }
    // Risky calls take a cap slot until their outcome is audited (checked synchronously in decide).
    const release = tool.cls.risky ? this.policy.reserveRisky(agentId) : () => {};
    const fullArgs = tool.cls.risky ? redactArgs(args, scrubber) : {};
    try {
      if (decision.kind === "ask") {
        const approval = this.queue(agentId, tool, bytes, fp.argsSha256);
        record("ok", null, { ...fp, ...fullArgs, decision: "ask", approvalId: approval.id, [RISKY_COUNTED]: true });
        return text(
          `pending_approval: ${exposedName} needs the owner's approval before it runs, and it hasn't run yet. ` +
            `approval_id: ${approval.id}. Don't call this tool again for the same action: it would only queue a second request. ` +
            `Ask your user to approve: ${this.ctx.settings.publicUrl()}/approve/${approval.id} . ` +
            `Carry on with other work and check with get_call_status (approval_id "${approval.id}"). ` +
            `If nobody answers, it expires at ${approval.expiresAt}.`,
        );
      }
      const ran = await this.execute(tool.connectionId, conn?.name ?? tool.slug, tool, args, { agentId, signal });
      const counted = tool.cls.risky && (!ran.failure || ran.failure.maybeRan);
      const detail = {
        ...fp,
        ...fullArgs,
        decision: "allow",
        ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
        resultBytes: resultBytes(ran.result),
        isError: ran.result.isError === true,
        ...(ran.signals ? { signals: ran.signals } : {}),
        ...(ran.failure ? { maybeRan: ran.failure.maybeRan } : {}),
        ...(Object.keys(ran.sourceDetail).length ? { source: ran.sourceDetail } : {}),
        ...(counted ? { [RISKY_COUNTED]: true } : {}),
      };
      if (ran.failure) record("error", ran.failure.reason, detail);
      else record(ran.result.isError ? "error" : "ok", ran.result.isError ? "tool_error" : null, detail);
      return ran.result;
    } finally {
      release();
    }
  }

  /**
   * Runs one call on the connection's source and post-processes the answer. Never throws. The scrubber is built
   * after the call, so a token refreshed (rotated) during it is scrubbed too. Getting the source may await (a
   * connect, a refresh): the connection is re-checked afterwards, so a kill in that window stops the call.
   */
  private async execute(connectionId: string, connectionName: string, tool: RegisteredTool, args: Record<string, unknown>, opts: { agentId: string; signal: AbortSignal }): Promise<Executed> {
    const sourceDetail: Record<string, unknown> = {};
    let raw: ToolResult;
    try {
      const source = await this.deps.sources.source(connectionId);
      if (!source) throw new SourceError("unavailable", "the connection isn't set up");
      const conn = connectionInfo(this.ctx.db, connectionId);
      if (!conn || conn.status === "disabled") {
        const failure: DescribedFailure = { reason: "connection_disabled", message: `${connectionName} was turned off in xaq, so the call wasn't sent.`, maybeRan: false };
        return { result: text(failure.message, true), signals: null, failure, sourceDetail };
      }
      raw = await source.callTool(tool.def.name, args, { agentId: opts.agentId, connectionId, signal: opts.signal, auditDetail: sourceDetail });
    } catch (err) {
      const scrubber = this.scrubberFor(connectionId);
      // Read after the failure: a 401 without a refresh token has just marked the connection expired.
      const now = connectionInfo(this.ctx.db, connectionId);
      const failure = describeFailure(err, now ? connectionLabel(now, this.ctx.settings.publicUrl()) : connectionName, scrubber);
      if (failure.reason === "internal") this.log.warn("Upstream call failed", { connection: connectionId, tool: tool.def.name, error: scrubber.scrub(errorMessage(err)).text });
      return { result: text(failure.message, true), signals: null, failure, sourceDetail };
    }
    try {
      const { result, signals } = processResult(raw, {
        source: `${tool.slug}/${tool.def.name}`,
        scrubber: this.scrubberFor(connectionId),
        maxChars: this.ctx.settings.get().maxBodyChars,
        validateStructured: (v) => validateOutput(tool.pinHash, tool.def.outputSchema, v),
      });
      return { result, signals, failure: null, sourceDetail };
    } catch (err) {
      // The call ran; only reading its answer failed.
      this.log.warn("Processing an upstream result failed", { connection: connectionId, tool: tool.def.name, error: this.scrubberFor(connectionId).scrub(errorMessage(err)).text });
      const failure: DescribedFailure = { reason: "internal", message: `${connectionName} answered, but xaq couldn't read the answer. The call ran: check before trying again.`, maybeRan: true };
      return { result: text(failure.message, true), signals: null, failure, sourceDetail };
    }
  }

  // ───────────── Approvals ─────────────

  private queue(agentId: string, tool: RegisteredTool, bytes: string, argsSha256: string): Approval {
    const limits = brokerLimits(this.ctx.settings);
    const id = insertMcpCall(this.ctx.db, {
      agentId,
      connectionId: tool.connectionId,
      call: { tool: tool.def.name, exposedName: tool.exposedName, args: bytes, argsSha256, pinHash: tool.pinHash, result: null },
      reason: null,
      ttlHours: limits.approvalTtlHours,
    });
    const approval = this.emit(id);
    const conn = connectionInfo(this.ctx.db, tool.connectionId);
    try {
      this.deps.onApprovalRequested?.({
        type: "approval.requested",
        approvalId: id,
        agentId,
        agentName: approval.agentName,
        connectionId: tool.connectionId,
        connectionSlug: tool.slug,
        connectionName: conn?.name ?? tool.slug,
        tool: tool.def.name,
        exposedName: tool.exposedName,
        url: `${this.ctx.settings.publicUrl()}/approve/${id}`,
        expiresAt: approval.expiresAt,
      });
    } catch (err) {
      this.log.warn("approval.requested delivery failed", { approval: id, error: String(err) });
    }
    return approval;
  }

  private emit(id: string): Approval {
    const a = this.ctx.mail.getApproval(id);
    if (!a) throw notFound("Approval");
    this.ctx.bus.emit("approval", a);
    return a;
  }

  /**
   * The tool this approval would run, as the agent can reach it now, looked up by the stored connection id and
   * upstream tool name (never by the exposed name: a slug edit could point that at another connection).
   */
  private currentTool(agentId: string, connectionId: string, toolName: string): RegisteredTool | null {
    return this.deps.registry.forAgent(agentId).find((t) => t.connectionId === connectionId && t.def.name === toolName) ?? null;
  }

  /** Why the stored call can't run now (the TOCTOU re-check), or null. */
  private blockedReason(row: McpCallRow, call: McpCallApprovalDetail): string | null {
    const agent = this.ctx.db.get<{ disabled: number }>("SELECT disabled FROM agents WHERE id = ?", row.agent_id);
    if (!agent) return "the agent was deleted";
    if (bool(agent.disabled)) return "the agent is disabled";
    const conn = connectionInfo(this.ctx.db, row.connection_id);
    if (!conn) return "the connection was removed";
    if (conn.status === "disabled") return `${conn.name} is turned off`;
    const tool = this.currentTool(row.agent_id, row.connection_id, call.tool);
    if (!tool) return `the agent can no longer use ${call.tool} on ${conn.name} (its access changed, or the tool was removed)`;
    if (tool.level === "read") return `the agent now has read-only access to ${conn.name}`;
    if (tool.pinHash !== call.pinHash) return `${call.tool}'s definition changed after the agent asked`;
    if (sha256(call.args) !== call.argsSha256) return "the stored arguments don't match the fingerprint taken when the agent asked";
    let args: unknown;
    try {
      args = JSON.parse(call.args);
    } catch {
      return "the stored arguments aren't valid JSON";
    }
    if (!isPlainObject(args)) return "the stored arguments aren't an object";
    const valid = validateArgs(tool.pinHash, tool.def.inputSchema, args);
    if (!valid.ok) return `the stored arguments no longer match ${call.tool}'s schema`;
    return null;
  }

  private requireRow(id: string): McpCallRow {
    const row = mcpCallRow(this.ctx.db, id);
    if (!row) throw notFound("Approval");
    return row;
  }

  private notPending(id: string) {
    const fresh = mcpCallRow(this.ctx.db, id);
    return conflict(`This request is already ${fresh?.status ?? "gone"}`, "Only pending requests can be approved or rejected.");
  }

  private adminAudit(action: string, row: McpCallRow, call: McpCallApprovalDetail, outcome: "ok" | "error", started: number, detail: Record<string, unknown> = {}) {
    this.ctx.audit.record({
      actorType: "admin",
      actorId: null,
      action,
      target: row.id,
      outcome,
      durationMs: Date.now() - started,
      detail: { broker: true, agentId: row.agent_id, kind: "mcp.call", connectionId: row.connection_id, tool: call.tool, exposedName: call.exposedName, pinHash: call.pinHash, argsSha256: call.argsSha256, ...detail },
    });
  }

  /** The approval card: the exact bytes, escaped for display, with recipients, URLs and the target first. */
  detail(id: string): McpCallApprovalView | null {
    const approval = this.ctx.mail.getApproval(id);
    if (!approval || approval.kind !== "mcp.call") return null;
    const call = approval.call;
    const conn = connectionInfo(this.ctx.db, approval.connectionId);
    const tool = this.currentTool(approval.agentId, approval.connectionId, call.tool);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(call.args);
    } catch {
      // Shown as bytes only; approve refuses it.
    }
    const targetPath = tool?.cls.targetPath && isPointer(tool.cls.targetPath) ? tool.cls.targetPath : null;
    const targetValue = targetPath ? atPointer(parsed, targetPath) : undefined;
    return {
      approval,
      connection: conn ? { id: conn.id, slug: conn.slug, name: conn.name, status: conn.status } : null,
      tool: tool
        ? {
            exposedName: tool.exposedName,
            name: tool.def.name,
            title: tool.def.title ?? tool.def.annotations?.title ?? null,
            risky: tool.cls.risky,
            read: tool.cls.read,
            targetPath,
            level: tool.level,
            pinMatches: tool.pinHash === call.pinHash,
          }
        : null,
      argsDisplay: showInvisible(call.args),
      pretty: showInvisible(parsed === null ? call.args : JSON.stringify(parsed, null, 2)),
      ...extract(parsed),
      target: targetPath && targetValue !== undefined ? { path: targetPath, value: targetValue } : null,
      argumentPaths: argumentPaths(parsed),
      argsIntact: sha256(call.args) === call.argsSha256,
    };
  }

  /**
   * Approves and runs an mcp.call (the console's approve, and the one-tap page). `alwaysAllow` also creates the
   * rule for this agent and tool (optionally only for this call's target) once the re-checks pass.
   */
  async approve(id: string, input: McpCallApproveInput = {}): Promise<Approval> {
    const started = Date.now();
    this.expireOverdue();
    const row = this.requireRow(id);
    if (row.status !== "pending") throw this.notPending(id);
    const call = parseCall(row);
    const blocked = this.blockedReason(row, call);
    if (blocked) {
      this.cancel([row], blocked);
      throw conflict(`This call can no longer be run: ${blocked}.`, "It was cancelled; nothing was sent.");
    }
    const rules = input.alwaysAllow ? this.ruleTargets(row, call, input.alwaysAllow) : null;
    if (!transition(this.ctx.db, id, "pending", "approved", input.note)) throw this.notPending(id);
    this.emit(id);
    if (rules) {
      for (const r of rules) {
        const rule = addRule(this.ctx.db, r);
        this.ctx.audit.record({ actorType: "admin", actorId: null, action: "approval_rule.create", target: rule.id, outcome: "ok", detail: { approvalId: id, agentId: rule.agentId, connectionId: rule.connectionId, tool: rule.tool, targetPath: rule.targetPath } });
      }
    }
    await this.runApprovedCall(this.ctx.mail.getApproval(id) as McpCallApproval, started);
    if (rules) await this.approveCoveredBy(row, call);
    return this.emit(id);
  }

  /**
   * "Never asks twice": after "always allow" created rules, the agent's other pending calls to the same tool that
   * the rules now cover are approved and run too (each with its own re-checks; one that fails them is cancelled).
   */
  private async approveCoveredBy(row: McpCallRow, call: McpCallApprovalDetail): Promise<void> {
    const rules = rulesFor(this.ctx.db, row.agent_id, row.connection_id, call.tool);
    const covered = this.pendingFor("agent_id = ? AND connection_id = ? AND id <> ?", row.agent_id, row.connection_id, row.id).filter((r) => {
      const c = parseCall(r);
      if (c.tool !== call.tool) return false;
      let args: unknown;
      try {
        args = JSON.parse(c.args);
      } catch {
        return false;
      }
      return rulesAllow(rules, (pointer) => atPointer(args, pointer)) !== null;
    });
    await Promise.allSettled(
      covered.map((r) =>
        this.approve(r.id, { note: `approved by an "always allow" rule (with ${row.id})` }).catch((err) => {
          this.log.info("A pending call covered by a new rule couldn't be approved", { approval: r.id, error: errorMessage(err) });
        }),
      ),
    );
  }

  /** The rules "always allow" creates: one for the tool, or one per target value (every id of an array target). */
  private ruleTargets(row: McpCallRow, call: McpCallApprovalDetail, opts: NonNullable<McpCallApproveInput["alwaysAllow"]>) {
    const base = { agentId: row.agent_id, connectionId: row.connection_id, tool: call.tool };
    if (!opts.target) return [{ ...base, targetPath: null, targetValue: null }];
    const tool = this.currentTool(row.agent_id, row.connection_id, call.tool);
    const path = opts.targetPath ?? tool?.cls.targetPath;
    if (!path || !isPointer(path)) throw badRequest("Pick the argument to allow (a JSON Pointer such as /page_id): this tool has no target of its own.");
    const value = atPointer(JSON.parse(call.args), path);
    if (value === undefined) throw badRequest(`This call has no ${path} argument to allow.`);
    const values = Array.isArray(value) ? value : [value];
    if (!values.length) throw badRequest(`${path} is empty in this call: there's no target to allow.`);
    if (values.length > 100) throw badRequest(`${path} has too many values to allow one by one.`);
    return values.map((v) => ({ ...base, targetPath: path, targetValue: canonicalJson(v) }));
  }

  /**
   * Runs an approval that's already claimed (status "approved"): the re-checks (agent, level, pin, argument hash),
   * then the stored bytes go to the stored connection and upstream tool. The result is stored (wrapped,
   * truncated, scrubbed) for get_call_status. A call that may have run but didn't answer ends "failed" with an
   * unknown outcome and is never retried; one that provably never left (re-auth, rate limit, blocked) goes back
   * to pending. Used by approve() above and by server/mail/approvals.ts approve() for mcp.call.
   *
   * Claiming: callers first move the row pending → approved (the human's decision, atomic). This method then
   * claims the run itself with a compare-and-swap on `tool_call.attemptedAt` (NULL → now, only while
   * "approved"): it is the single gate to the upstream, so two paths (or two calls of this hook) can never
   * forward the same approval twice. A run that provably never left clears attemptedAt with the row back to pending.
   */
  async runApprovedCall(approval: McpCallApproval, started = Date.now()): Promise<void> {
    const claimed =
      this.ctx.db.run(
        `UPDATE approvals SET tool_call = json_set(tool_call, '$.attemptedAt', ?)
         WHERE id = ? AND kind = 'mcp.call' AND status = 'approved' AND json_extract(tool_call, '$.attemptedAt') IS NULL`,
        now(),
        approval.id,
      ).changes > 0;
    if (!claimed) return;
    const row = this.requireRow(approval.id);
    const call = parseCall(row);
    const blocked = this.blockedReason(row, call);
    if (blocked) {
      if (transition(this.ctx.db, row.id, "approved", "rejected", `${CANCELLED_PREFIX}${blocked}`)) this.adminAudit("approval.cancel", row, call, "ok", started, { note: blocked });
      return;
    }
    const tool = this.currentTool(row.agent_id, row.connection_id, call.tool)!;
    const conn = connectionInfo(this.ctx.db, row.connection_id);
    const args = JSON.parse(call.args) as Record<string, unknown>;
    // Approved calls aren't tied to the approver's request: the source's own timeout bounds them.
    const ran = await this.execute(row.connection_id, conn?.name ?? tool.slug, tool, args, { agentId: row.agent_id, signal: new AbortController().signal });
    const detail = {
      argsBytes: Buffer.byteLength(call.args),
      resultBytes: resultBytes(ran.result),
      isError: ran.result.isError === true,
      ...(ran.signals ? { signals: ran.signals } : {}),
      ...(ran.failure ? { error: ran.failure.reason, maybeRan: ran.failure.maybeRan } : {}),
    };
    if (!ran.failure) {
      const result: McpCallResult = { content: ran.result.content, ...(ran.result.structuredContent !== undefined ? { structuredContent: ran.result.structuredContent } : {}), ...(ran.result.isError ? { isError: true } : {}) };
      updateToolCall(this.ctx.db, row.id, { result });
      this.ctx.db.run("UPDATE approvals SET status = 'sent', error = NULL WHERE id = ? AND status = 'approved'", row.id);
      this.adminAudit("approval.approve", row, call, ran.result.isError ? "error" : "ok", started, detail);
    } else if (!ran.failure.maybeRan) {
      updateToolCall(this.ctx.db, row.id, { attemptedAt: null });
      this.ctx.db.run(
        "UPDATE approvals SET status = 'pending', decided_at = NULL, error = ? WHERE id = ? AND status = 'approved'",
        `${ran.failure.message} Approve again once that's fixed.`,
        row.id,
      );
      this.adminAudit("approval.approve", row, call, "error", started, detail);
    } else {
      updateToolCall(this.ctx.db, row.id, { outcomeUnknown: true });
      this.ctx.db.run("UPDATE approvals SET status = 'failed', error = ? WHERE id = ? AND status = 'approved'", ran.failure.message, row.id);
      this.adminAudit("approval.approve", row, call, "error", started, detail);
    }
  }

  reject(id: string, note?: string | null): Approval {
    const started = Date.now();
    this.expireOverdue();
    const row = this.requireRow(id);
    if (!transition(this.ctx.db, id, "pending", "rejected", note)) throw this.notPending(id);
    this.adminAudit("approval.reject", row, parseCall(row), "ok", started);
    return this.emit(id);
  }

  /** Pending mcp.call approvals past their expiry become "expired". */
  expireOverdue(): number {
    const due = this.ctx.db.all<McpCallRow>("SELECT * FROM approvals WHERE kind = 'mcp.call' AND status = 'pending' AND expires_at <= ?", now());
    let n = 0;
    for (const row of due) {
      if (!transition(this.ctx.db, row.id, "pending", "expired")) continue;
      n++;
      this.ctx.audit.record({ actorType: "system", action: "approval.expire", target: row.id, outcome: "ok", detail: { broker: true, agentId: row.agent_id, connectionId: row.connection_id } });
      this.emit(row.id);
    }
    return n;
  }

  /** Approved calls without a result were interrupted: "failed" with an unknown outcome, never retried. */
  recoverInterrupted(olderThanMs = 0): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.ctx.db.all<McpCallRow>("SELECT * FROM approvals WHERE kind = 'mcp.call' AND status = 'approved' AND decided_at <= ? ORDER BY rowid", cutoff);
    for (const row of rows) {
      updateToolCall(this.ctx.db, row.id, { outcomeUnknown: true });
      this.ctx.db.run(
        "UPDATE approvals SET status = 'failed', error = ? WHERE id = ? AND status = 'approved'",
        "The approved call was interrupted before xaq got an answer, so it may or may not have run. It won't be retried automatically.",
        row.id,
      );
      this.ctx.audit.record({ actorType: "system", action: "approval.recover", target: row.id, outcome: "ok", detail: { broker: true, connectionId: row.connection_id, outcomeUnknown: true } });
      this.emit(row.id);
    }
    return rows.length;
  }

  private cancel(rows: McpCallRow[], why: string): number {
    let n = 0;
    for (const row of rows) {
      if (!transition(this.ctx.db, row.id, "pending", "rejected", `${CANCELLED_PREFIX}${why}`)) continue;
      n++;
      this.ctx.audit.record({ actorType: "system", action: "approval.cancel", target: row.id, outcome: "ok", detail: { broker: true, agentId: row.agent_id, connectionId: row.connection_id, note: why } });
      this.emit(row.id);
    }
    return n;
  }

  private pendingFor(where: string, ...params: string[]): McpCallRow[] {
    return this.ctx.db.all<McpCallRow>(`SELECT * FROM approvals WHERE kind = 'mcp.call' AND status = 'pending' AND ${where} ORDER BY rowid`, ...params);
  }

  /**
   * Call after an agent's connection grant changed (level lowered): pending approvals the agent's access no
   * longer allows are cancelled.
   */
  onGrantChanged(agentId: string, connectionId: string): number {
    const blocked = this.pendingFor("agent_id = ? AND connection_id = ?", agentId, connectionId).filter((r) => this.blockedReason(r, parseCall(r)) !== null);
    return this.cancel(blocked, "the agent's access to this connection changed");
  }

  /** Call after an agent's connection grant was removed: its pending approvals are cancelled and its rules deleted. */
  onGrantRemoved(agentId: string, connectionId: string): { cancelled: number; rulesDeleted: number } {
    const cancelled = this.cancel(this.pendingFor("agent_id = ? AND connection_id = ?", agentId, connectionId), "the agent's access to this connection was removed");
    return { cancelled, rulesDeleted: deleteRulesForGrant(this.ctx.db, agentId, connectionId) };
  }

  /** Call when a tool disappears upstream: its rules are deleted (a tool that comes back starts fresh), its pending calls cancelled. */
  onToolRemoved(connectionId: string, toolName: string): { cancelled: number; rulesDeleted: number } {
    const rows = this.pendingFor("connection_id = ?", connectionId).filter((r) => parseCall(r).tool === toolName);
    return { cancelled: this.cancel(rows, `${toolName} was removed from the connection`), rulesDeleted: deleteRulesForTool(this.ctx.db, connectionId, toolName) };
  }

  /** The agent's view of one of its own calls (get_call_status). */
  getCallStatus(agentId: string, approvalId: string): ToolResult {
    this.expireOverdue();
    const id = typeof approvalId === "string" ? approvalId.trim() : "";
    const row = id ? mcpCallRow(this.ctx.db, id) : null;
    if (!row || row.agent_id !== agentId) return text(`No tool call request ${cleanLine(id).slice(0, 40) || "(empty)"} of yours exists. Use the approval_id from the pending_approval answer.`, true);
    const call = parseCall(row);
    const note = row.decision_note ? cleanLine(row.decision_note, 300) : null;
    const name = call.exposedName;
    switch (row.status) {
      case "pending":
        return text(`pending: ${name} is waiting for the owner's approval and hasn't run. Check again later; it expires at ${row.expires_at}.${row.error ? ` Last attempt: ${cleanLine(row.error, 300)}` : ""}`);
      case "approved":
        return text(`running: the owner approved ${name} and it's running now. Check again in a moment.`);
      case "rejected":
        if (note?.startsWith(CANCELLED_PREFIX)) return text(`cancelled: ${note.slice(CANCELLED_PREFIX.length)}. ${name} didn't run.`, true);
        return text(`rejected: the owner rejected ${name}${note ? ` (${note})` : ""}. It didn't run. Don't retry it unless your user asks.`, true);
      case "expired":
        return text(`expired: nobody approved ${name} in time, so it didn't run. Call the tool again if it's still needed.`, true);
      case "sent": {
        const r = call.result ?? { content: [] };
        return {
          content: [{ type: "text", text: `done: the owner approved ${name} and it ran. Its result follows.` }, ...(r.content as ToolResult["content"])],
          ...(r.isError ? { isError: true } : {}),
        };
      }
      case "failed":
        if (call.outcomeUnknown) {
          return text(`outcome unknown: the approved call to ${name} was interrupted, so it may or may not have run. xaq won't retry it. Check before calling it again. ${row.error ? cleanLine(row.error, 300) : ""}`.trim(), true);
        }
        return text(`failed: ${row.error ? cleanLine(row.error, 300) : `${name} failed`}`, true);
      default:
        return text(`${row.status}: ${name}.`);
    }
  }

  // ───────────── Rules ─────────────

  listRules(q: { agentId?: string; connectionId?: string } = {}): ApprovalRule[] {
    return listRules(this.ctx.db, q);
  }

  deleteRule(id: string): void {
    const rule = getRule(this.ctx.db, id);
    if (!rule || !deleteRule(this.ctx.db, id)) throw notFound("Rule");
    this.ctx.audit.record({ actorType: "admin", actorId: null, action: "approval_rule.delete", target: id, outcome: "ok", detail: { agentId: rule.agentId, connectionId: rule.connectionId, tool: rule.tool, targetPath: rule.targetPath } });
  }

  // ───────────── Kill switch ─────────────

  /** One-click kill: disables the connection, cancels its pending approvals, deletes its credentials and closes its source. */
  async killConnection(id: string): Promise<void> {
    const conn = connectionInfo(this.ctx.db, id);
    if (!conn) throw notFound("Connection");
    this.ctx.db.run("UPDATE connections SET status = 'disabled', status_reason = ?, updated_at = ? WHERE id = ?", "killed by the owner", now(), id);
    const cancelled = this.cancel(this.pendingFor("connection_id = ?", id), `${conn.name} was shut off by the owner`);
    let cleared = true;
    try {
      this.deps.credentials.clear(id);
    } catch (err) {
      cleared = false;
      this.log.error("Kill switch: clearing credentials failed", { connection: id, error: String(err) });
    }
    this.deps.refresher?.untrack(id);
    try {
      await this.deps.sources.close(id);
    } catch (err) {
      this.log.warn("Kill switch: closing the source failed", { connection: id, error: String(err) });
    }
    this.ctx.audit.record({ actorType: "admin", actorId: null, action: "connection.kill", target: id, outcome: cleared ? "ok" : "error", detail: { connectionId: id, cancelled, credentialsCleared: cleared } });
  }
}

/** The runtime for this app context. The broker service wiring (W7) attaches it; the admin API reads it. */
const runtimes = new WeakMap<object, BrokerPolicyRuntime>();

export function createBrokerPolicyRuntime(ctx: AppContext, deps: BrokerPolicyDeps): BrokerPolicyRuntime {
  const rt = new BrokerPolicyRuntime(ctx, deps);
  runtimes.set(ctx, rt);
  return rt;
}

export const brokerPolicyOf = (ctx: AppContext): BrokerPolicyRuntime | null => runtimes.get(ctx) ?? null;
