// The catalog: fetches each connection's tool list, cleans, classifies, hashes and stores it. A changed or new tool is simply used: the only trace is one audit entry with the old
// and new definition hash (the owner removed the hold on 2026-10-16). Behind the `brokerUpstreams` setting: pass
// `enabled` and attach() is a no-op while it's off.

import type { AuditInput } from "../../audit.ts";
import type { IntegrationPreset, ToolClass, ToolDef, ToolListing, ToolSource } from "../types.ts";
import { classifyTool } from "./classify.ts";
import { type CleanStats, cleanInstructions, cleanToolDef, ToolRefused } from "./clean.ts";
import { canonicalize, sha256Hex } from "./jcs.ts";
import { candidateKey, exposedName, fold, type NameRefusal, nativeNames } from "./names.ts";
import { type ToolSignal, toolSignals } from "./signals.ts";
import type { CatalogState, CatalogStore, PinnedTool } from "./store.ts";

/** `sha256(JCS(cleaned {name, title, description, inputSchema, outputSchema, annotations}))`, hex. */
export function pinHash(def: ToolDef): string {
  const { name, title, description, inputSchema, outputSchema, annotations } = def;
  return sha256Hex(canonicalize({ name, title, description, inputSchema, outputSchema, annotations }));
}

/** A tool that disappeared from the upstream: policy fails its pending approvals closed and drops its allow rules. */
export interface ToolRemovedEvent {
  connectionId: string;
  name: string;
  exposedName: string | null;
  pinHash: string | null;
}

export interface CatalogConnection {
  slug: string;
  preset: Pick<IntegrationPreset, "classify"> | null;
}

export interface CatalogDeps {
  store: CatalogStore;
  /** The connection's current slug and preset; null when it no longer exists. */
  connection(connectionId: string): CatalogConnection | null;
  /** Every broker connection (for cross-reference signals). */
  connections(): { id: string; slug: string }[];
  audit(input: AuditInput): void;
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
  now?: () => Date;
  /** Refresh period without a server TTL, and the cap on one (default 10 min). */
  defaultTtlMs?: number;
  /** Floor on a server's ttlMs (default 30 s). */
  minTtlMs?: number;
  /** Coalescing window for list_changed (default 1 s). */
  debounceMs?: number;
  /** Abort a listing after this long (default 60 s). */
  timeoutMs?: number;
  /** The `brokerUpstreams` setting (default off). Absent: on. */
  enabled?: () => boolean;
}

export interface RefreshOutcome {
  ok: boolean;
  first: boolean;
  /** Tools stored by the first listing. */
  pinned: string[];
  /** Tools that appeared after the first listing: usable at once. */
  added: string[];
  /** Tools whose definition hash changed: the new definition is used at once. */
  changed: string[];
  removed: string[];
  /** Tools not stored: a name that can't be exposed, or one already taken (native or another connection). */
  refused: NameRefusal[];
  /** The server instructions changed (the new text is served at once). */
  instructionsChanged: boolean;
  error?: string;
}

interface Entry {
  source: ToolSource;
  timer: ReturnType<typeof setTimeout> | null;
  debounce: ReturnType<typeof setTimeout> | null;
  inflight: Promise<RefreshOutcome> | null;
  again: boolean;
  abort: AbortController | null;
  closed: boolean;
}

const MAX_TOOLS = 1000;
const DEF_FIELDS: (keyof ToolDef)[] = ["name", "title", "description", "inputSchema", "outputSchema", "annotations"];

export class Catalog {
  private readonly entries = new Map<string, Entry>();
  private readonly signalsByTool = new Map<string, ToolSignal[]>();
  private readonly removedListeners: ((e: ToolRemovedEvent) => void)[] = [];
  private readonly changeListeners: ((connectionId: string) => void)[] = [];
  private readonly defaultTtl: number;
  private readonly minTtl: number;
  private readonly debounceMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: CatalogDeps) {
    this.defaultTtl = deps.defaultTtlMs ?? 10 * 60_000;
    this.minTtl = Math.min(deps.minTtlMs ?? 30_000, this.defaultTtl);
    this.debounceMs = deps.debounceMs ?? 1000;
    this.timeoutMs = deps.timeoutMs ?? 60_000;
  }

  /**
   * Policy hook: a tool left the upstream (or the connection's pins were forgotten). Policy fails the tool's pending
   * approvals closed and deletes its approval_rules, so a tool that comes back inherits nothing.
   * Called after the commit, once per tool.
   */
  onToolRemoved(fn: (e: ToolRemovedEvent) => void): void {
    this.removedListeners.push(fn);
  }

  /** Any change to a connection's pinned tools (the registry invalidates its cache). */
  onChange(fn: (connectionId: string) => void): void {
    this.changeListeners.push(fn);
  }

  /** Starts tracking a source: refreshes now, then on TTL expiry / timer. Replaces an earlier source. */
  attach(source: ToolSource): Promise<RefreshOutcome> {
    this.detach(source.connectionId);
    if (this.deps.enabled && !this.deps.enabled()) return Promise.resolve(failed("disabled"));
    const e: Entry = { source, timer: null, debounce: null, inflight: null, again: false, abort: null, closed: false };
    this.entries.set(source.connectionId, e);
    return this.refresh(source.connectionId);
  }

  /** Stops refreshing (disable, delete, shutdown). Pinned tools stay. Doesn't close the source (its owner does). */
  detach(connectionId: string): void {
    const e = this.entries.get(connectionId);
    if (!e) return;
    e.closed = true;
    if (e.timer) clearTimeout(e.timer);
    if (e.debounce) clearTimeout(e.debounce);
    e.abort?.abort();
    this.entries.delete(connectionId);
  }

  close(): void {
    for (const id of [...this.entries.keys()]) this.detach(id);
  }

  /** The list_changed hook: coalesced, then one refresh. */
  requestRefresh(connectionId: string): void {
    const e = this.entries.get(connectionId);
    if (!e || e.debounce) return;
    e.debounce = setTimeout(() => {
      e.debounce = null;
      if (!e.closed) void this.refresh(connectionId);
    }, this.debounceMs);
    e.debounce.unref?.();
  }

  /** Refreshes now; one at a time per connection (a request during a refresh runs once more after it). */
  refresh(connectionId: string): Promise<RefreshOutcome> {
    const e = this.entries.get(connectionId);
    if (!e) return Promise.resolve(failed("not_attached"));
    if (e.inflight) {
      e.again = true;
      return e.inflight;
    }
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    const run = async () => {
      let out: RefreshOutcome;
      let ttl: number | undefined;
      do {
        e.again = false;
        const r = await this.listOnce(e);
        out = r.outcome;
        ttl = r.ttlMs;
      } while (e.again && !e.closed);
      return { out, ttl };
    };
    e.inflight = run().then(
      ({ out, ttl }) => {
        e.inflight = null;
        this.schedule(e, ttl);
        return out;
      },
      (err: unknown) => {
        e.inflight = null;
        this.schedule(e, undefined);
        return failed(err instanceof Error ? err.message : String(err));
      },
    );
    return e.inflight;
  }

  private schedule(e: Entry, ttlMs: number | undefined): void {
    if (e.closed) return;
    const ttl = typeof ttlMs === "number" && Number.isFinite(ttlMs) ? ttlMs : this.defaultTtl;
    const ms = Math.min(Math.max(ttl, this.minTtl), this.defaultTtl);
    e.timer = setTimeout(() => {
      e.timer = null;
      if (!e.closed) void this.refresh(e.source.connectionId);
    }, ms);
    e.timer.unref?.();
  }

  private async listOnce(e: Entry): Promise<{ outcome: RefreshOutcome; ttlMs?: number }> {
    const id = e.source.connectionId;
    const ac = new AbortController();
    e.abort = ac;
    // Raced against the abort, so a source that ignores its signal can't wedge `inflight`.
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(ac.signal.reason instanceof Error ? ac.signal.reason : new Error("Listing tools was aborted"));
      if (ac.signal.aborted) fail();
      else ac.signal.addEventListener("abort", fail, { once: true });
    });
    aborted.catch(() => {});
    const timer = setTimeout(() => ac.abort(new Error("Listing tools timed out")), this.timeoutMs);
    timer.unref?.();
    let listing: ToolListing;
    try {
      listing = await Promise.race([e.source.listTools(ac.signal), aborted]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!e.closed) this.recordError(id, message);
      return { outcome: failed(message) };
    } finally {
      clearTimeout(timer);
      if (e.abort === ac) e.abort = null;
    }
    if (e.closed) return { outcome: failed("detached") };
    try {
      const outcome = this.applyListing(id, listing);
      return { outcome, ttlMs: outcome.ok ? listing.ttlMs : undefined };
    } catch (err) {
      // E.g. a constraint the checks above missed: nothing was committed (one transaction); retried on the timer.
      const message = err instanceof Error ? err.message : String(err);
      this.recordError(id, message);
      return { outcome: failed(message) };
    }
  }

  private recordError(connectionId: string, message: string): void {
    const state = this.deps.store.state(connectionId) ?? emptyState(connectionId);
    this.deps.store.setState({ ...state, lastError: message.slice(0, 500) });
    this.deps.log?.warn("broker catalog: listing tools failed", { connectionId, error: message.slice(0, 200) });
  }

  /**
   * Stores a listing (synchronous; exposed for tests and for sources that push their list). Every listed tool is
   * active. A changed definition hash, or a tool that wasn't there before, is used as is: one audit entry records
   * it (old and new hash), with no event, notification or accept step.
   */
  applyListing(connectionId: string, listing: ToolListing): RefreshOutcome {
    const conn = this.deps.connection(connectionId);
    if (!conn) return failed("unknown_connection");
    const { store } = this.deps;
    if (!listing || typeof listing !== "object" || !Array.isArray(listing.tools)) {
      this.recordError(connectionId, "The server's tool list wasn't a list; the pinned tools are kept");
      return failed("invalid_listing");
    }
    const now = (this.deps.now?.() ?? new Date()).toISOString();
    const out: RefreshOutcome = { ok: true, first: false, pinned: [], added: [], changed: [], removed: [], refused: [], instructionsChanged: false };
    const signals = new Map<string, ToolSignal[]>();

    // Valid, unique names only (the first of duplicates wins), cleaned and hashed. A definition that can't be served
    // safely refuses just that tool (it's treated as absent), never the whole refresh.
    const listed = new Map<string, Prepared>();
    const seen = new Set<string>();
    for (const t of listing.tools) {
      if (seen.size >= MAX_TOOLS) break;
      if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name || t.name.length > 256 || seen.has(t.name)) continue;
      seen.add(t.name);
      try {
        const { def, stats } = cleanToolDef(t);
        listed.set(t.name, { def, stats, hash: pinHash(def) });
      } catch (err) {
        const reason = err instanceof ToolRefused ? err.reason : "not_json";
        out.refused.push({ connectionId, name: t.name, reason: "invalid_definition", detail: reason });
        signals.set(t.name, [{ kind: "refused", detail: reason }]);
        this.deps.log?.warn("broker catalog: tool definition refused", { connectionId, reason });
      }
    }

    // A listing that would remove every pin (empty, or only unusable tools) is treated as a failure: an upstream
    // glitch mustn't wipe the pins and, through onToolRemoved, the allow rules.
    const pinnedBefore = store.tools(connectionId);
    if (pinnedBefore.length > 0 && !pinnedBefore.some((t) => listed.has(t.name))) {
      this.recordError(connectionId, "The server listed none of the pinned tools; the pinned tools are kept");
      return { ...failed("empty_listing"), refused: out.refused };
    }

    const otherSlugs = this.deps
      .connections()
      .filter((c) => c.id !== connectionId)
      .map((c) => c.slug);
    const otherRows = store.allTools().filter((t) => t.connectionId !== connectionId);
    const otherToolNames = [...nativeNames(), ...otherRows.flatMap((t) => [t.name, t.exposedName])];

    const audits: { action: string; target: string | null; detail: Record<string, unknown> }[] = [];
    const removed: ToolRemovedEvent[] = [];
    let changed = false;

    store.tx(() => {
      const state = store.state(connectionId) ?? emptyState(connectionId);
      const first = state.refreshedAt === null;
      out.first = first;
      const existing = new Map(store.tools(connectionId).map((t) => [t.name, t]));

      // Gone from the upstream: removed first, so a newcomer may reuse the exposed name in the same listing.
      for (const row of [...existing.values()]) {
        if (listed.has(row.name)) continue;
        changed = true;
        store.remove(connectionId, row.name);
        existing.delete(row.name);
        out.removed.push(row.name);
        removed.push({ connectionId, name: row.name, exposedName: row.exposedName, pinHash: row.pinHash });
      }

      // Names taken (case-folded): native tools and other connections' tools. This connection's known tools claim
      // theirs first, so a newcomer can't take an established name.
      const taken = new Map<string, string>([...nativeNames()].map((n) => [n, n]));
      for (const t of otherRows) taken.set(fold(t.exposedName), t.exposedName);
      const order = [...listed.keys()].sort((a, b) => Number(existing.has(b)) - Number(existing.has(a)) || (a < b ? -1 : a > b ? 1 : 0));

      for (const name of order) {
        const { def, stats, hash } = listed.get(name)!;
        const row = existing.get(name);
        const wanted = exposedName(conn.slug, name);
        const clash = wanted ? taken.get(fold(wanted)) : undefined;
        // A known tool keeps its stored name if its new one (after a slug edit) is taken.
        const exposed = wanted && !clash ? wanted : (row?.exposedName ?? null);
        if (!exposed) {
          signals.set(name, [{ kind: "refused", detail: wanted ? "collision" : "invalid_name" }]);
          out.refused.push({ connectionId, name, reason: wanted ? "collision" : "invalid_name", ...(clash ? { with: clash } : {}) });
          continue;
        }
        taken.set(fold(exposed), exposed);
        signals.set(name, toolSignals(def, stats, { otherSlugs, otherToolNames }));

        if (!row) {
          changed = true;
          store.upsert({ connectionId, name, exposedName: exposed, def, pinHash: hash, cls: storedClass(def, conn.preset), firstSeenAt: now, updatedAt: now });
          if (first) out.pinned.push(name);
          else {
            out.added.push(name);
            audits.push({ action: "connection.tool_added", target: exposed, detail: { tool: name, hash } });
          }
          continue;
        }

        if (row.pinHash === hash && row.def) {
          // Unchanged. Derived columns (exposed name, classification) refreshed.
          const next: PinnedTool = { ...row, exposedName: exposed, cls: storedClass(row.def, conn.preset) };
          if (JSON.stringify(next) !== JSON.stringify(row)) {
            changed = true;
            store.upsert({ ...next, updatedAt: now });
          }
          continue;
        }

        // Changed (or a row without a definition, left by a version that held new tools): the new definition is
        // used under the same name, re-classified, so the normal risky and read rules apply to what it is now.
        changed = true;
        store.upsert({ ...row, exposedName: exposed, def, pinHash: hash, cls: storedClass(def, conn.preset), updatedAt: now });
        out.changed.push(name);
        audits.push({ action: "connection.tool_changed", target: exposed, detail: { tool: name, previousHash: row.pinHash, hash, fields: changedFields(row.def, def) } });
      }

      // Server instructions: stored on the first listing; a later change is used at once and audited.
      const instr = cleanInstructions(listing.instructions);
      const iHash = instr === null ? null : sha256Hex(instr);
      const nextState: CatalogState = {
        ...state,
        instructions: instr,
        instructionsHash: iHash,
        refreshedAt: now,
        lastError: null,
        ttlMs: typeof listing.ttlMs === "number" && Number.isFinite(listing.ttlMs) ? listing.ttlMs : null,
      };
      if (!first && iHash !== state.instructionsHash) {
        out.instructionsChanged = true;
        audits.push({ action: "connection.instructions_changed", target: null, detail: { previousHash: state.instructionsHash, hash: iHash } });
      }
      // A first listing with nothing to store (an empty server, or every tool refused) doesn't use up the first
      // connect: the tools it lists later count as the first ones, not as added.
      if (first && out.pinned.length === 0) nextState.refreshedAt = null;
      store.setState(nextState);
    });

    // Side effects after the commit.
    if (out.first && out.pinned.length) {
      this.audit("connection.tools_pinned", connectionId, null, { connectionId, count: out.pinned.length });
    }
    for (const a of audits) this.audit(a.action, connectionId, a.target, a.detail);
    for (const r of removed) {
      this.audit("connection.tool_removed", connectionId, r.exposedName, { connectionId, tool: r.name });
      for (const fn of this.removedListeners) this.safe(() => fn(r));
    }
    const prefix = `${connectionId}\u0000`;
    for (const k of [...this.signalsByTool.keys()]) if (k.startsWith(prefix)) this.signalsByTool.delete(k);
    for (const [name, sig] of signals) this.signalsByTool.set(candidateKey(connectionId, name), sig);
    if (changed || out.instructionsChanged) this.changed(connectionId);
    return out;
  }

  /** Informational signals per tool name of a connection, from the last listing (in memory). */
  signals(connectionId: string): Map<string, ToolSignal[]> {
    const out = new Map<string, ToolSignal[]>();
    const prefix = `${connectionId}\u0000`;
    for (const [k, v] of this.signalsByTool) if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v);
    return out;
  }

  /** The server instructions served for a connection (from the last listing). */
  instructions(connectionId: string): string | null {
    return this.deps.store.state(connectionId)?.instructions ?? null;
  }

  /**
   * Upgrade from a version with the tool-change hold: every tool still held is released, its waiting definition
   * (if any) becomes the one used, re-classified, with one audit entry per tool. Idempotent; returns how many.
   */
  releaseLegacyHolds(): number {
    const held = this.deps.store.legacyHeld();
    if (!held.length) return 0;
    const released: { tool: PinnedTool; previousHash: string | null; fields: string[] }[] = [];
    const now = (this.deps.now?.() ?? new Date()).toISOString();
    this.deps.store.tx(() => {
      for (const h of held) {
        const def = h.candidateDef ?? h.tool.def;
        const hash = h.candidateDef ? h.candidateHash : h.tool.pinHash;
        if (!def || !hash) {
          // Nothing usable stored: drop the row; the next listing adds the tool again.
          this.deps.store.remove(h.tool.connectionId, h.tool.name);
          continue;
        }
        const conn = this.deps.connection(h.tool.connectionId);
        const tool: PinnedTool = { ...h.tool, def, pinHash: hash, cls: storedClass(def, conn?.preset ?? null), updatedAt: now };
        this.deps.store.upsert(tool);
        released.push({ tool, previousHash: h.tool.pinHash, fields: changedFields(h.tool.def, def) });
      }
    });
    for (const { tool, previousHash, fields } of released) {
      this.audit("connection.tool_changed", tool.connectionId, tool.exposedName, { tool: tool.name, previousHash, hash: tool.pinHash, fields, releasedHold: true });
    }
    for (const id of new Set(held.map((h) => h.tool.connectionId))) this.changed(id);
    return held.length;
  }

  /** Drops a connection's pins and state (its URL changed or it was deleted): the next listing is a first connect. */
  forget(connectionId: string): void {
    this.detach(connectionId);
    const tools = this.deps.store.tools(connectionId);
    this.deps.store.forget(connectionId);
    for (const t of tools) {
      const r = { connectionId, name: t.name, exposedName: t.exposedName, pinHash: t.pinHash };
      for (const fn of this.removedListeners) this.safe(() => fn(r));
    }
    this.changed(connectionId);
  }

  private changed(connectionId: string): void {
    for (const fn of this.changeListeners) this.safe(() => fn(connectionId));
  }

  private audit(action: string, connectionId: string, target: string | null, detail: Record<string, unknown>): void {
    this.safe(() => this.deps.audit({ actorType: "system", action, target, outcome: "ok", detail: { connectionId, ...detail } }));
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.deps.log?.warn("broker catalog: listener failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

interface Prepared {
  def: ToolDef;
  stats: CleanStats;
  hash: string;
}

/** The classification as stored (upstream_tools has no target_path; the registry asks the preset for it). */
function storedClass(def: ToolDef, preset: CatalogConnection["preset"]): ToolClass {
  const { risky, read, source } = classifyTool(def, preset);
  return { risky, read, source };
}

function failed(error: string): RefreshOutcome {
  return { ok: false, first: false, pinned: [], added: [], changed: [], removed: [], refused: [], instructionsChanged: false, error };
}

/** Top-level definition fields that differ (all of them for a tool with no previous definition). */
function changedFields(before: ToolDef | null, after: ToolDef): string[] {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  return DEF_FIELDS.filter((f) => canonicalize(a[f] ?? null) !== canonicalize(b[f] ?? null));
}

function emptyState(connectionId: string): CatalogState {
  return {
    connectionId,
    instructions: null,
    instructionsHash: null,
    refreshedAt: null,
    lastError: null,
    ttlMs: null,
  };
}
