// Broker policy and calls (docs/MCP-BROKER.md "Access", "Upstream output is untrusted", "Security model").
// BrokerCalls.call is the single entry point for running an upstream tool: resolve, validate against the pin,
// decide, then run (wrapped, scrubbed, audited).

import type { AppContext } from "../../context.ts";
import { now } from "../../db/index.ts";
import { cleanLine } from "../../mail/content.ts";
import { errorMessage, notFound } from "../../util/errors.ts";
import type { BrokerCalls, BrokerPolicy, CredentialStore, RegisteredTool, ToolRegistry, ToolResult, ToolSource, TokenRefresher } from "../types.ts";
import { SourceError } from "../types.ts";
import { canonicalize } from "../catalog/jcs.ts";
import { fingerprint, redactArgs } from "./audit.ts";
import { createBrokerPolicy } from "./decide.ts";
import { connectionLabel, describeFailure, type DescribedFailure } from "./errors.ts";
import { connectionSecrets, makeScrubber, type OutputSignals, processResult, resultBytes, type Scrubber } from "./output.ts";
import { connectionInfo } from "./store.ts";
import { MAX_ARGS_BYTES, validateArgs, validateOutput } from "./validate.ts";

/** Live tool sources per connection (the upstream manager's pool, or a native integration). */
export interface SourceProvider {
  /** The connection's source, connecting if needed; null when it has none (not set up). */
  source(connectionId: string): ToolSource | null | Promise<ToolSource | null>;
  /** Closes and forgets the connection's source (kill switch). Idempotent. */
  close(connectionId: string): Promise<void>;
}

export interface BrokerPolicyDeps {
  registry: ToolRegistry;
  sources: SourceProvider;
  credentials: CredentialStore;
  refresher?: Pick<TokenRefresher, "untrack">;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

interface Executed {
  result: ToolResult;
  signals: OutputSignals | null;
  failure: DescribedFailure | null;
  sourceDetail: Record<string, unknown>;
}

export class BrokerPolicyRuntime implements BrokerCalls {
  readonly policy: BrokerPolicy;
  private readonly log;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: BrokerPolicyDeps,
  ) {
    this.policy = createBrokerPolicy({ db: ctx.db, settings: ctx.settings });
    this.log = ctx.log.child("broker.policy");
  }

  private enabled(): boolean {
    return this.ctx.settings.get().brokerUpstreams === true;
  }

  private scrubberFor(connectionId: string): Scrubber {
    return makeScrubber(connectionSecrets(this.deps.credentials, connectionId));
  }

  // ───────────── Calls ─────────────

  async call(agentId: string, exposedName: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const started = Date.now();
    if (!this.enabled()) return text("Upstream connections are turned off on this xaq.", true);
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
      bytes = canonicalize(args);
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

    const decision = this.policy.decide(tool);
    if (decision.kind === "deny") {
      record("denied", decision.reason, { ...fp, decision: "deny" });
      return text(decision.message, true);
    }
    // Risky calls keep their (redacted) arguments in the audit log.
    const fullArgs = tool.cls.risky ? redactArgs(args, scrubber) : {};
    const ran = await this.execute(tool.connectionId, conn?.name ?? tool.slug, tool, args, { agentId, signal });
    const detail = {
      ...fp,
      ...fullArgs,
      decision: "allow",
      resultBytes: resultBytes(ran.result),
      isError: ran.result.isError === true,
      ...(ran.signals ? { signals: ran.signals } : {}),
      ...(ran.failure ? { maybeRan: ran.failure.maybeRan } : {}),
      ...(Object.keys(ran.sourceDetail).length ? { source: ran.sourceDetail } : {}),
    };
    if (ran.failure) record("error", ran.failure.reason, detail);
    else record(ran.result.isError ? "error" : "ok", ran.result.isError ? "tool_error" : null, detail);
    return ran.result;
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

  // ───────────── Kill switch ─────────────

  /** One-click kill: disables the connection, deletes its credentials and closes its source. */
  async killConnection(id: string): Promise<void> {
    const conn = connectionInfo(this.ctx.db, id);
    if (!conn) throw notFound("Connection");
    this.ctx.db.run("UPDATE connections SET status = 'disabled', status_reason = ?, updated_at = ? WHERE id = ?", "killed by the owner", now(), id);
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
    this.ctx.audit.record({ actorType: "admin", actorId: null, action: "connection.kill", target: id, outcome: cleared ? "ok" : "error", detail: { connectionId: id, credentialsCleared: cleared } });
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
