// The ToolSource of a code extension's connection (docs/EXTENSIONS.md "The code-extension host"): one child per
// connection under Node's permission model, MCP over stdio with xaq as the client (@modelcontextprotocol/client,
// docs/adr/0001), and the extension-to-host requests:
// - request `xaq/credentials/get`, params `{}` → `{ accessToken, expiresAt }` for this connection only (anything in
//   params is refused: there's no way to name another connection). Refresh stays in core (deps.accessToken).
// - notification `xaq/events/emit` `{ type, dedupeKey, data }`: only the manifest's `code.events` types; anything
//   else is dropped and logged. Rate-limited.
// - notification `xaq/log` `{ level, msg, meta }`: rate-limited and redacted.
// Lifecycle: started when the source is created (the broker creates it for an active connection), stopped with
// SIGTERM then SIGKILL on close; a crash restarts it with backoff, and repeated crashes mark the connection `error`
// with the last stderr lines, redacted. The integrity is re-checked before every start.

import { Client, ProtocolError, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { z } from "zod";
import { untilAborted } from "../../broker/credentials/refresher.ts";
import { scrubText } from "../../broker/credentials/scrub.ts";
import {
  type PromptDef,
  type PromptResult,
  type PromptSource,
  type ResourceDef,
  type ResourceReadResult,
  type ResourceTemplateDef,
  SourceError,
  type ToolCallContext,
  type ToolListing,
  type ToolResult,
  type ToolSource,
} from "../../broker/types.ts";
import { toDef, toResult } from "../../broker/upstream/source.ts";
import { errorMessage } from "../../util/errors.ts";
import { childArgs, childEnv, codeExtensionNodeProblem, ensureStateDir, entryPath, XAQ_EXT_PROTOCOL } from "./spawn.ts";
import { ChildTransport } from "./transport.ts";
import { type CodeManifest, codeManifestOf, type CodeSourceDeps, DEFAULT_LIMITS, type HostLimits, type InstalledExtension } from "./types.ts";

/** JSON-RPC error code of a refused `xaq/credentials/get` (needs re-auth, or no credential). */
export const CREDENTIALS_ERROR = -32010;

type State = "idle" | "starting" | "running" | "backoff" | "failed" | "closed";

interface Live {
  client: Client;
  transport: ChildTransport;
  startedAt: number;
}

/** A token bucket for the child's logs and events. */
class Bucket {
  private tokens: number;
  private at = Date.now();
  dropped = 0;
  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
  ) {
    this.tokens = burst;
  }
  take(): boolean {
    const t = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.perSecond);
    this.at = t;
    if (this.tokens < 1) {
      this.dropped++;
      return false;
    }
    this.tokens--;
    return true;
  }
}

const LogParams = z.object({ level: z.unknown().optional(), msg: z.unknown().optional(), meta: z.unknown().optional() }).loose();
const EventParams = z.object({ type: z.unknown().optional(), dedupeKey: z.unknown().optional(), data: z.unknown().optional() }).loose();
/** `{}` only (the SDK may add `_meta`): a connection id or anything else in params is refused. */
const CredentialParams = z.object({ _meta: z.unknown().optional() }).strict();

const EVENT_TYPE_RE = /^[a-z0-9-]{1,24}\.[a-z0-9_]{1,64}$/;
const DEDUPE_RE = /^[\x21-\x7e]{1,200}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export class CodeToolSource implements ToolSource {
  readonly connectionId: string;
  readonly prompts: PromptSource;
  private readonly limits: HostLimits;
  private readonly manifest: CodeManifest | null;
  private state: State = "idle";
  private live: Live | null = null;
  private starting: Promise<Live> | null = null;
  private failure: string | null = null;
  private crashes = 0;
  private backoffTimer: NodeJS.Timeout | null = null;
  private backoffUntil = 0;
  private inflight = 0;
  /** The last access token handed to the child: redacted from its logs and stderr. */
  private lastToken: string | null = null;
  private readonly logBucket: Bucket;
  private readonly eventBucket: Bucket;

  constructor(
    private readonly ext: InstalledExtension,
    private readonly deps: CodeSourceDeps,
  ) {
    this.connectionId = deps.connectionId;
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.manifest = codeManifestOf(ext.manifest);
    this.logBucket = new Bucket(this.limits.logBurst, this.limits.logPerSecond);
    this.eventBucket = new Bucket(this.limits.eventBurst, this.limits.eventPerSecond);
    this.prompts = {
      listPrompts: (signal) => this.listPrompts(signal),
      getPrompt: (name, args, signal) => this.getPrompt(name, args, signal),
      listResources: (signal) => this.listResources(signal),
      listResourceTemplates: (signal) => this.listResourceTemplates(signal),
      readResource: (uri, signal) => this.readResource(uri, signal),
    };
  }

  /** The child's pid while it runs (tests). */
  get pid(): number | null {
    return this.live?.transport.pid ?? null;
  }

  get status(): { state: State; failure: string | null; crashes: number } {
    return { state: this.state, failure: this.failure, crashes: this.crashes };
  }

  // ───────────── Lifecycle ─────────────

  /** Starts the child now (the extension's own timers run while it's up). Errors are recorded, not thrown. */
  start(): void {
    if (this.state !== "idle") return;
    this.ensure().catch(() => {});
  }

  /** Resolves once the child is up (tests and callers that want to wait for the first start). */
  async ready(): Promise<void> {
    await this.ensure();
  }

  private redact(text: string, max = 500): string {
    return scrubText(text, [this.lastToken], max);
  }

  /** The running child, starting it if needed. */
  private async ensure(): Promise<Live> {
    switch (this.state) {
      case "closed":
        throw new SourceError("unavailable", "This connection was closed");
      case "failed":
        throw new SourceError("unavailable", this.failure ?? "The extension isn't running");
      case "backoff":
        throw new SourceError("unavailable", `The ${this.ext.name} extension is restarting after a crash; try again in ${Math.max(1, Math.ceil((this.backoffUntil - Date.now()) / 1000))} s`);
      case "running":
        return this.live!;
      case "starting":
        return this.starting!;
      default:
        break;
    }
    this.state = "starting";
    const p = this.spawnChild();
    this.starting = p;
    try {
      const live = await p;
      if (this.state !== "starting") {
        // Closed while starting.
        await this.stop(live);
        throw new SourceError("unavailable", "This connection was closed");
      }
      this.live = live;
      this.state = "running";
      this.failure = null;
      this.deps.setError?.(null);
      return live;
    } catch (err) {
      if (this.state === "starting") this.crashed(`it didn't start: ${this.redact(errorMessage(err), 200)}`, this.lastTransport);
      throw err instanceof SourceError ? err : new SourceError("unavailable", `The ${this.ext.name} extension didn't start: ${this.redact(errorMessage(err), 200)}`);
    } finally {
      this.starting = null;
    }
  }

  /** The transport of the last spawn (for a failed start's stderr). */
  private lastTransport: ChildTransport | null = null;

  /** Refuses to start for good (no restart): bad manifest, integrity mismatch, bad entry. */
  private refuse(reason: string): never {
    this.state = "failed";
    this.failure = reason;
    this.deps.setError?.(reason);
    this.deps.log.warn("Code extension refused to start", { connection: this.connectionId, extension: this.ext.name, reason });
    throw new SourceError("unavailable", reason);
  }

  private async spawnChild(): Promise<Live> {
    if (this.ext.kind !== "code" || !this.manifest) this.refuse(`${this.ext.name} isn't a code extension xaq can run`);
    // Node releases with known permission-model bypasses never run extension code (spawn.ts lists them).
    const nodeProblem = codeExtensionNodeProblem(this.deps.nodeVersion);
    if (nodeProblem) this.refuse(nodeProblem);
    // Re-checked before every start: files changed since install never run.
    let intact = false;
    try {
      intact = this.deps.verify() === true;
    } catch {
      intact = false;
    }
    if (!intact) {
      this.refuse(`The ${this.ext.name} extension's files don't match what was installed (integrity check failed), so it wasn't started. Reinstall or update it.`);
    }
    let entry = "";
    try {
      entry = entryPath(this.ext.installDir, this.manifest!.entry);
      ensureStateDir(this.deps.stateDir);
    } catch (err) {
      this.refuse(`The ${this.ext.name} extension can't start: ${errorMessage(err)}`);
    }
    const l = this.limits;
    const transport: ChildTransport = new ChildTransport({
      command: this.deps.execPath ?? process.execPath,
      args: childArgs(this.ext.installDir, this.deps.stateDir, entry),
      env: childEnv({ name: this.ext.name, connectionId: this.connectionId, stateDir: this.deps.stateDir }),
      cwd: this.deps.stateDir,
      maxMessageBytes: l.maxMessageBytes,
      maxStderrLine: l.maxStderrLine,
      stderrLines: l.stderrLines,
      killAfterMs: l.killAfterMs,
      onExit: (info) => this.onExit(transport, info),
    });
    this.lastTransport = transport;
    transport.onerror = (err) => {
      if (this.logBucket.take()) this.deps.log.warn("Code extension transport", { connection: this.connectionId, extension: this.ext.name, error: this.redact(err.message, 200) });
    };
    // No client capabilities: the extension can't ask for sampling, elicitation or roots.
    const client = new Client({ name: "xaq", version: XAQ_EXT_PROTOCOL }, { capabilities: {}, versionNegotiation: { mode: "legacy" } });
    this.installHostHandlers(client);
    // The whole start (spawn, initialize, initialized) has one deadline: a child that dies or stalls at any point of
    // the handshake fails the start instead of leaving it pending.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SourceError("timeout", `The ${this.ext.name} extension didn't start within ${Math.round(l.startTimeoutMs / 1000)} s`)), l.startTimeoutMs);
    });
    try {
      await Promise.race([client.connect(transport, { timeout: l.startTimeoutMs, signal: AbortSignal.timeout(l.startTimeoutMs) }), deadline]);
    } catch (err) {
      transport.kill();
      await Promise.allSettled([transport.close(), client.close()]);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return { client, transport, startedAt: Date.now() };
  }

  private onExit(transport: ChildTransport, info: { code: number | null; signal: NodeJS.Signals | null; reason: string | null }): void {
    if (this.live?.transport !== transport) return;
    const ranFor = Date.now() - this.live.startedAt;
    this.live = null;
    if (this.state !== "running") return;
    if (ranFor >= this.limits.stableAfterMs) this.crashes = 0;
    const how = info.reason ?? (info.signal ? `it was killed by ${info.signal}` : `it exited with code ${info.code}`);
    this.crashed(how, transport);
  }

  /** A crash (or a failed start): restart with backoff, or give up after maxCrashes in a row. */
  private crashed(how: string, transport: ChildTransport | null): void {
    this.crashes++;
    const tail = (transport?.stderrTail() ?? []).map((line) => this.redact(line, this.limits.maxStderrLine));
    this.deps.log.warn("Code extension stopped unexpectedly", {
      connection: this.connectionId,
      extension: this.ext.name,
      how,
      crashes: this.crashes,
      ...(tail.length ? { stderr: tail.slice(-5) } : {}),
    });
    if (this.crashes >= this.limits.maxCrashes) {
      const last = tail.slice(-5).join(" | ");
      this.state = "failed";
      this.failure = this.redact(`The ${this.ext.name} extension stopped ${this.crashes} times in a row (${how}) and won't be restarted until the connection is reloaded.${last ? ` Last output: ${last}` : ""}`, 1000);
      this.deps.setError?.(this.failure);
      return;
    }
    const delay = Math.min(this.limits.restartMaxMs, this.limits.restartBaseMs * 2 ** (this.crashes - 1));
    this.state = "backoff";
    this.backoffUntil = Date.now() + delay;
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      if (this.state !== "backoff") return;
      this.state = "idle";
      this.ensure().catch(() => {});
    }, delay);
    this.backoffTimer.unref();
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
    const live = this.live;
    this.live = null;
    const starting = this.starting;
    if (live) await this.stop(live);
    else if (starting) {
      // Still starting: stop that child now (it may be wedged mid-handshake), then give the start a bounded moment.
      this.lastTransport?.kill();
      await Promise.race([starting.catch(() => {}), new Promise((r) => setTimeout(r, this.limits.killAfterMs).unref())]);
    }
  }

  private async stop(live: Live): Promise<void> {
    // SIGTERM, then SIGKILL after killAfterMs (the transport), whatever the client's own close does.
    await Promise.allSettled([live.transport.close(), live.client.close()]);
  }

  // ───────────── Extension → host ─────────────

  private installHostHandlers(client: Client): void {
    client.setRequestHandler("xaq/credentials/get", { params: CredentialParams }, async () => {
      let accessToken: string;
      try {
        accessToken = await this.deps.accessToken(AbortSignal.timeout(30_000));
      } catch (err) {
        throw new ProtocolError(CREDENTIALS_ERROR, `needs_reauth: ${scrubText(errorMessage(err), [], 200)}`, { reason: "needs_reauth" });
      }
      this.lastToken = accessToken;
      const expiresAt = this.deps.tokenExpiresAt?.() ?? null;
      return { accessToken, expiresAt };
    });
    client.setNotificationHandler("xaq/events/emit", { params: EventParams }, (p) => this.onEmit(p));
    client.setNotificationHandler("xaq/log", { params: LogParams }, (p) => this.onLog(p));
  }

  private onEmit(p: { type?: unknown; dedupeKey?: unknown; data?: unknown }): void {
    const allowed = this.manifest?.events ?? [];
    const type = typeof p.type === "string" ? p.type : "";
    const drop = (why: string) => {
      if (this.logBucket.take()) this.deps.log.warn("Dropped an event from a code extension", { connection: this.connectionId, extension: this.ext.name, type: scrubText(type, [], 80), why });
    };
    if (!EVENT_TYPE_RE.test(type) || !allowed.includes(type)) return drop("type not in the manifest's events");
    if (typeof p.dedupeKey !== "string" || !DEDUPE_RE.test(p.dedupeKey)) return drop("bad dedupeKey");
    const data = p.data === undefined ? {} : p.data;
    if (!isPlainObject(data)) return drop("data isn't an object");
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(data));
    } catch {
      return drop("data isn't JSON");
    }
    if (size > this.limits.maxEventBytes) return drop("data too large");
    if (!this.eventBucket.take()) return drop("rate limited");
    try {
      this.deps.emit({ type, connectionId: this.connectionId, dedupeKey: p.dedupeKey, data });
    } catch (err) {
      this.deps.log.warn("A code extension's event failed", { connection: this.connectionId, extension: this.ext.name, error: errorMessage(err) });
    }
  }

  private onLog(p: { level?: unknown; msg?: unknown; meta?: unknown }): void {
    if (!this.logBucket.take()) return;
    const level = p.level === "warn" || p.level === "warning" || p.level === "error" ? "warn" : "info";
    const msg = this.redact(typeof p.msg === "string" ? p.msg : String(p.msg ?? ""), 500);
    let meta: string | undefined;
    if (p.meta !== undefined) {
      try {
        meta = this.redact(JSON.stringify(p.meta) ?? "", 1000);
      } catch {
        meta = "[unserializable]";
      }
    }
    const dropped = this.logBucket.dropped;
    this.logBucket.dropped = 0;
    this.deps.log[level](`[${this.ext.name}] ${msg}`, { connection: this.connectionId, extension: this.ext.name, ...(meta ? { meta } : {}), ...(dropped ? { dropped } : {}) });
  }

  // ───────────── Host → extension ─────────────

  /** Runs `op` on the live client: limited concurrency, mapped errors. */
  private async run<T>(signal: AbortSignal, timeout: number, op: (c: Client) => Promise<T>): Promise<T> {
    if (this.inflight >= this.limits.maxConcurrent) {
      throw new SourceError("rate_limited", `Too many calls to ${this.ext.name} at once (at most ${this.limits.maxConcurrent}); try again shortly`, 1000);
    }
    this.inflight++;
    try {
      // A start that takes its time never holds the caller past its own signal (or its slot past that).
      const live = await untilAborted(this.ensure(), signal);
      return await op(live.client);
    } catch (err) {
      throw this.mapError(err, signal, timeout);
    } finally {
      this.inflight--;
    }
  }

  private mapError(err: unknown, signal: AbortSignal, timeout: number): unknown {
    if (signal.aborted) return signal.reason ?? err;
    if (err instanceof SourceError) return err;
    if (err instanceof SdkError) {
      if (err.code === SdkErrorCode.RequestTimeout) return new SourceError("timeout", `${this.ext.name} didn't answer within ${Math.round(timeout / 1000)} s`);
      if (err.code === SdkErrorCode.ConnectionClosed || err.code === SdkErrorCode.SendFailed || err.code === SdkErrorCode.NotConnected) {
        return new SourceError("unavailable", `The ${this.ext.name} extension stopped during the call`);
      }
      return new SourceError("protocol", `${this.ext.name}: ${this.redact(err.message, 300)}`);
    }
    if (err instanceof ProtocolError) return new SourceError("protocol", `${this.ext.name}: ${this.redact(err.message, 300)}`);
    return new SourceError("unavailable", `${this.ext.name}: ${this.redact(errorMessage(err), 300)}`);
  }

  async listTools(signal: AbortSignal): Promise<ToolListing> {
    const t = this.limits.listTimeoutMs;
    return this.run(signal, t, async (c) => {
      if (!c.getServerCapabilities()?.tools) return { tools: [] };
      const res = await c.listTools(undefined, { signal, timeout: t, cacheMode: "refresh" });
      const instructions = c.getInstructions();
      return { tools: res.tools.map(toDef), ...(instructions ? { instructions } : {}) };
    });
  }

  async callTool(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    const t = this.limits.callTimeoutMs;
    const started = Date.now();
    const res = await this.run(ctx.signal, t, (c) => c.callTool({ name, arguments: args }, { signal: ctx.signal, timeout: t }));
    ctx.auditDetail.upstreamMs = Date.now() - started;
    return toResult(res);
  }

  private async listPrompts(signal: AbortSignal): Promise<PromptDef[]> {
    const t = this.limits.listTimeoutMs;
    return this.run(signal, t, async (c) =>
      c.getServerCapabilities()?.prompts ? ((await c.listPrompts(undefined, { signal, timeout: t, cacheMode: "refresh" })).prompts as PromptDef[]) : [],
    );
  }

  private async getPrompt(name: string, args: Record<string, string>, signal: AbortSignal): Promise<PromptResult> {
    const t = this.limits.callTimeoutMs;
    return this.run(signal, t, async (c) => (await c.getPrompt({ name, arguments: args }, { signal, timeout: t })) as PromptResult);
  }

  private async listResources(signal: AbortSignal): Promise<ResourceDef[]> {
    const t = this.limits.listTimeoutMs;
    return this.run(signal, t, async (c) =>
      c.getServerCapabilities()?.resources ? ((await c.listResources(undefined, { signal, timeout: t, cacheMode: "refresh" })).resources as ResourceDef[]) : [],
    );
  }

  private async listResourceTemplates(signal: AbortSignal): Promise<ResourceTemplateDef[]> {
    const t = this.limits.listTimeoutMs;
    return this.run(signal, t, async (c) =>
      c.getServerCapabilities()?.resources
        ? ((await c.listResourceTemplates(undefined, { signal, timeout: t, cacheMode: "refresh" })).resourceTemplates as ResourceTemplateDef[])
        : [],
    );
  }

  private async readResource(uri: string, signal: AbortSignal): Promise<ResourceReadResult> {
    const t = this.limits.callTimeoutMs;
    return this.run(signal, t, async (c) => (await c.readResource({ uri }, { signal, timeout: t, cacheMode: "refresh" })) as ResourceReadResult);
  }
}

/**
 * The ToolSource for one connection of a code extension; starts its child at once. presetFromManifest calls this
 * for `kind: "code"`, usually through codeExtensionSource (server/extensions/host/index.ts), which fills stateDir,
 * emit and verify from the broker's deps.
 */
export function createCodeSource(ext: InstalledExtension, deps: CodeSourceDeps): CodeToolSource {
  const s = new CodeToolSource(ext, deps);
  s.start();
  return s;
}
