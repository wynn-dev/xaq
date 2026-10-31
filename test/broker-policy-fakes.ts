// In-process fakes for the broker policy tests: a DB-backed ToolRegistry over upstream_tools + connection_grants
// (the catalog's job in production), a scripted ToolSource and an in-memory CredentialStore.

import type {
  AccessLevel,
  CredentialStore,
  RegisteredTool,
  StoredTokens,
  ToolCallContext,
  ToolDef,
  ToolRegistry,
  ToolResult,
  ToolSource,
} from "../server/broker/types.ts";
import type { AppContext } from "../server/context.ts";
import { sha256 } from "../server/crypto.ts";
import { now } from "../server/db/index.ts";
import { newId } from "../server/util/ids.ts";

export function addConnection(ctx: AppContext, slug: string, name = slug): string {
  const id = newId("con");
  const t = now();
  ctx.db.run(
    "INSERT INTO connections (id, kind, slug, name, url, auth_type, level_default, status, created_at, updated_at) VALUES (?, 'remote_http', ?, ?, ?, 'header', 'full', 'active', ?, ?)",
    id,
    slug,
    name,
    `https://${slug}.example.com/mcp`,
    t,
    t,
  );
  return id;
}

export interface ToolSpec {
  name: string;
  risky?: boolean;
  read?: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  targetPath?: string;
  description?: string;
}

export function addTool(ctx: AppContext, connectionId: string, slug: string, spec: ToolSpec): string {
  const def = { description: spec.description ?? spec.name, inputSchema: spec.inputSchema ?? { type: "object" }, ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}) };
  const pin = sha256(JSON.stringify({ name: spec.name, ...def }));
  const t = now();
  ctx.db.run(
    `INSERT INTO upstream_tools (connection_id, name, exposed_name, definition, pin_hash, risky, read, class_source, state, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'preset', 'active', ?, ?)`,
    connectionId,
    spec.name,
    `${slug}__${spec.name}`,
    JSON.stringify(def),
    pin,
    spec.risky ? 1 : 0,
    spec.read ? 1 : 0,
    t,
    t,
  );
  return pin;
}

export function grant(ctx: AppContext, agentId: string, connectionId: string, level: AccessLevel): void {
  const t = now();
  ctx.db.run(
    `INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (agent_id, connection_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`,
    agentId,
    connectionId,
    level,
    t,
    t,
  );
}

/** Like the catalog's registry: granted connections, read level lists read tools only. */
export class DbRegistry implements ToolRegistry {
  /** Tests flip this to see that the policy denies non-read tools at the read level on its own. */
  filterRead = true;

  constructor(private readonly ctx: AppContext) {}

  forAgent(agentId: string): RegisteredTool[] {
    const rows = this.ctx.db.all<{
      connection_id: string;
      slug: string;
      name: string;
      exposed_name: string;
      definition: string;
      pin_hash: string;
      risky: number;
      read: number;
      level: AccessLevel;
    }>(
      `SELECT t.connection_id, c.slug, t.name, t.exposed_name, t.definition, t.pin_hash, t.risky, t.read, g.level
       FROM upstream_tools t JOIN connections c ON c.id = t.connection_id
       JOIN connection_grants g ON g.connection_id = t.connection_id AND g.agent_id = ?
       WHERE t.state = 'active' ORDER BY t.exposed_name`,
      agentId,
    );
    return rows
      .filter((r) => !this.filterRead || r.level !== "read" || r.read === 1)
      .map((r) => {
        const d = JSON.parse(r.definition) as Omit<ToolDef, "name">;
        return {
          exposedName: r.exposed_name,
          connectionId: r.connection_id,
          slug: r.slug,
          def: { name: r.name, ...d },
          cls: { risky: r.risky === 1, read: r.read === 1, source: "preset" },
          level: r.level,
          pinHash: r.pin_hash,
        };
      });
  }

  resolve(agentId: string, exposedName: string): RegisteredTool | null {
    return this.forAgent(agentId).find((t) => t.exposedName === exposedName) ?? null;
  }
}

export type Handler = (name: string, args: Record<string, unknown>, ctx: ToolCallContext) => ToolResult | Promise<ToolResult>;

export class FakeSource implements ToolSource {
  calls: { name: string; args: Record<string, unknown>; json: string }[] = [];
  closed = 0;
  handler: Handler = (name) => ({ content: [{ type: "text", text: `ran ${name}` }] });

  constructor(readonly connectionId: string) {}

  async listTools() {
    return { tools: [] };
  }

  async callTool(name: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    this.calls.push({ name, args, json: JSON.stringify(args) });
    return this.handler(name, args, ctx);
  }

  async close() {
    this.closed++;
  }
}

export class FakeSources {
  readonly map = new Map<string, FakeSource>();
  closed: string[] = [];

  add(connectionId: string): FakeSource {
    const s = new FakeSource(connectionId);
    this.map.set(connectionId, s);
    return s;
  }

  source(connectionId: string): FakeSource | null | Promise<FakeSource | null> {
    return this.map.get(connectionId) ?? null;
  }

  async close(connectionId: string) {
    this.closed.push(connectionId);
    await this.map.get(connectionId)?.close();
    this.map.delete(connectionId);
  }
}

export class MemoryCredentials implements CredentialStore {
  headers = new Map<string, { name: string; value: string }>();
  tokenMap = new Map<string, StoredTokens>();
  cleared: string[] = [];

  header(id: string) {
    return this.headers.get(id) ?? null;
  }
  setHeader(id: string, name: string, value: string) {
    this.headers.set(id, { name, value });
  }
  tokens(id: string) {
    return this.tokenMap.get(id) ?? null;
  }
  saveTokens(id: string, tokens: StoredTokens) {
    this.tokenMap.set(id, tokens);
    return true;
  }
  clients = new Map<string, Record<string, unknown>>();
  client(id: string) {
    return this.clients.get(id) ?? null;
  }
  setClient(id: string, client: Record<string, unknown>) {
    this.clients.set(id, client);
  }
  markNeedsReauth() {}
  clear(id: string) {
    this.cleared.push(id);
    this.headers.delete(id);
    this.tokenMap.delete(id);
  }
}
