// Persistence of the catalog: `upstream_tools` (migration 8) plus the catalog columns of `connections`
// (tools_cached_at, instructions_hash).
//
// upstream_tools' hold columns (state, held_reason, candidate_definition, candidate_hash) are unused since the
// tool-change hold was removed: every write stores an active row (migration 15 deleted the held ones).

import { type Db, json } from "../../db/index.ts";
import type { ClassSource, ToolAnnotations, ToolClass, ToolDef } from "../types.ts";

/** One upstream tool of a connection: its current definition and that definition's hash. */
export interface PinnedTool {
  connectionId: string;
  /** The upstream's own name (what `callTool` gets). */
  name: string;
  /** `<slug>__<name>` (unique across connections; tools that can't be named aren't stored). */
  exposedName: string;
  /** The cleaned definition in use. null only for a row an older version left held as a new tool. */
  def: ToolDef | null;
  /** `pinHash(def)`: compared on every listing, a difference is audited (connection.tool_changed). */
  pinHash: string | null;
  /** Classification of `def`. `targetPath` isn't stored: the preset gives it. */
  cls: ToolClass;
  firstSeenAt: string;
  updatedAt: string;
}

/** Per-connection catalog state. Only `refreshedAt` and `instructionsHash` are persisted (columns of `connections`). */
export interface CatalogState {
  connectionId: string;
  /** Cleaned server instructions from the last listing (in memory: restored by the next listing after a restart). */
  instructions: string | null;
  instructionsHash: string | null;
  /** Last successful listing; null before the first one (the next one is the "first connect"). */
  refreshedAt: string | null;
  lastError: string | null;
  ttlMs: number | null;
}

interface ToolRow {
  connection_id: string;
  name: string;
  exposed_name: string;
  definition: string | null;
  pin_hash: string | null;
  risky: number;
  read: number;
  class_source: ClassSource;
  state: "active" | "held";
  held_reason: "changed" | "new" | null;
  candidate_definition: string | null;
  candidate_hash: string | null;
  first_seen_at: string;
  updated_at: string;
}

/** upstream_tools.definition: the definition without its name (the row has it). */
type StoredDefinition = Omit<ToolDef, "name" | "description"> & { description?: string };

function toStored(def: ToolDef | null): string | null {
  if (!def) return null;
  const { name: _name, ...rest } = def;
  return json.str(rest);
}

function fromStored(name: string, v: string | null): ToolDef | null {
  if (v === null) return null;
  const d = json.parse<StoredDefinition | null>(v, null);
  if (!d) return null;
  const out: ToolDef = { name, description: d.description ?? "", inputSchema: d.inputSchema ?? { type: "object" } };
  if (d.title !== undefined) out.title = d.title;
  if (d.outputSchema !== undefined) out.outputSchema = d.outputSchema;
  if (d.annotations !== undefined) out.annotations = d.annotations as ToolAnnotations;
  return out;
}

const toTool = (r: ToolRow): PinnedTool => ({
  connectionId: r.connection_id,
  name: r.name,
  exposedName: r.exposed_name,
  def: fromStored(r.name, r.definition),
  pinHash: r.pin_hash,
  cls: { risky: r.risky === 1, read: r.read === 1, source: r.class_source },
  firstSeenAt: r.first_seen_at,
  updatedAt: r.updated_at,
});

/** The real store, on migration 8's tables. The in-memory parts of CatalogState live here too. Writes always store an active row. */
export class CatalogStore {
  private readonly volatile = new Map<string, Omit<CatalogState, "connectionId" | "refreshedAt" | "instructionsHash">>();

  constructor(private readonly db: Db) {}

  tools(connectionId: string): PinnedTool[] {
    return this.db.all<ToolRow>("SELECT * FROM upstream_tools WHERE connection_id = ? ORDER BY name", connectionId).map(toTool);
  }
  allTools(): PinnedTool[] {
    return this.db.all<ToolRow>("SELECT * FROM upstream_tools ORDER BY connection_id, name").map(toTool);
  }
  get(connectionId: string, name: string): PinnedTool | null {
    const r = this.db.get<ToolRow>("SELECT * FROM upstream_tools WHERE connection_id = ? AND name = ?", connectionId, name);
    return r ? toTool(r) : null;
  }
  upsert(t: PinnedTool): void {
    this.db.run(
      `INSERT INTO upstream_tools (connection_id, name, exposed_name, definition, pin_hash, risky, read, class_source, state,
         held_reason, candidate_definition, candidate_hash, first_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, name) DO UPDATE SET exposed_name = excluded.exposed_name, definition = excluded.definition,
         pin_hash = excluded.pin_hash, risky = excluded.risky, read = excluded.read, class_source = excluded.class_source,
         state = excluded.state, held_reason = excluded.held_reason, candidate_definition = excluded.candidate_definition,
         candidate_hash = excluded.candidate_hash, updated_at = excluded.updated_at`,
      t.connectionId,
      t.name,
      t.exposedName,
      toStored(t.def),
      t.pinHash,
      t.cls.risky ? 1 : 0,
      t.cls.read && !t.cls.risky ? 1 : 0,
      t.cls.source,
      "active",
      null,
      null,
      null,
      t.firstSeenAt,
      t.updatedAt,
    );
  }
  remove(connectionId: string, name: string): void {
    this.db.run("DELETE FROM upstream_tools WHERE connection_id = ? AND name = ?", connectionId, name);
  }
  state(connectionId: string): CatalogState | null {
    const c = this.db.get<{ tools_cached_at: string | null; instructions_hash: string | null }>(
      "SELECT tools_cached_at, instructions_hash FROM connections WHERE id = ?",
      connectionId,
    );
    if (!c) return null;
    const v = this.volatile.get(connectionId);
    return {
      connectionId,
      refreshedAt: c.tools_cached_at,
      instructionsHash: c.instructions_hash,
      instructions: v?.instructions ?? null,
      lastError: v?.lastError ?? null,
      ttlMs: v?.ttlMs ?? null,
    };
  }
  setState(s: CatalogState): void {
    this.db.run(
      "UPDATE connections SET tools_cached_at = ?, instructions_hash = ? WHERE id = ?",
      s.refreshedAt,
      s.instructionsHash,
      s.connectionId,
    );
    const { connectionId, refreshedAt: _r, instructionsHash: _h, ...rest } = s;
    this.volatile.set(connectionId, rest);
  }
  forget(connectionId: string): void {
    this.db.tx(() => {
      this.db.run("DELETE FROM upstream_tools WHERE connection_id = ?", connectionId);
      this.db.run("UPDATE connections SET tools_cached_at = NULL, instructions_hash = NULL WHERE id = ?", connectionId);
    });
    this.volatile.delete(connectionId);
  }
  tx<T>(fn: () => T): T {
    return this.db.tx(fn);
  }
}
