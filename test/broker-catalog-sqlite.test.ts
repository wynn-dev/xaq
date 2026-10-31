import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "../server/db/index.ts";
import type { AuditInput } from "../server/audit.ts";
import { brokerConnections, Catalog, CatalogRegistry, CatalogStore, connectionGrants, pinHash } from "../server/broker/catalog/index.ts";
import type { ToolDef } from "../server/broker/types.ts";

const T = "2026-10-16T12:00:00.000Z";
const tool = (name: string, extra: Partial<ToolDef> = {}): ToolDef => ({ name, description: `Does ${name}`, inputSchema: { type: "object" }, ...extra });

describe("CatalogStore on migration 8", () => {
  let db: Db;
  beforeEach(() => {
    db = new Db(":memory:");
    const con = (id: string, slug: string) =>
      db.run(
        "INSERT INTO connections (id, kind, slug, name, url, created_at, updated_at) VALUES (?, 'remote_http', ?, ?, 'https://mcp.example.com/mcp', ?, ?)",
        id,
        slug,
        slug,
        T,
        T,
      );
    con("con_a", "alpha");
    con("con_b", "beta");
    db.run("INSERT INTO agents (id, name, key_prefix, key_hash, created_at) VALUES ('agt_1', 'A', 'aib_x', 'h1', ?)", T);
    db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES ('agt_1', 'con_a', 'read', ?, ?)", T, T);
  });
  afterEach(() => db.close());

  const make = () => {
    const audits: AuditInput[] = [];
    const store = new CatalogStore(db);
    const catalog = new Catalog({
      store,
      connection: (id) => {
        const c = brokerConnections(db).find((x) => x.id === id);
        return c ? { slug: c.slug, preset: null } : null;
      },
      connections: () => brokerConnections(db),
      audit: (a) => audits.push(a),
    });
    const registry = new CatalogRegistry({ store, connections: () => brokerConnections(db), grants: (a) => connectionGrants(db, a) });
    catalog.onChange(() => registry.invalidate());
    return { store, catalog, registry, audits };
  };

  it("stores every listed tool as active within the schema's CHECKs; a change replaces the definition in place", () => {
    const { store, catalog, registry } = make();
    catalog.applyListing("con_a", { tools: [tool("get_page", { annotations: { readOnlyHint: true } }), tool("delete_page")], instructions: "Hi" });
    expect(db.get("SELECT tools_cached_at AS t, instructions_hash AS h FROM connections WHERE id = 'con_a'")).toMatchObject({ t: expect.any(String), h: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(registry.forAgent("agt_1").map((t) => t.exposedName)).toEqual(["alpha__get_page"]);

    const changed = tool("get_page", { annotations: { readOnlyHint: true }, title: "Get" });
    const out = catalog.applyListing("con_a", { tools: [changed, tool("delete_page"), tool("new_one")], instructions: "Hi" });
    expect(out).toMatchObject({ changed: ["get_page"], added: ["new_one"] });
    const rows = db.all<{ name: string; state: string; held_reason: string | null; candidate_hash: string | null; pin_hash: string }>(
      "SELECT name, state, held_reason, candidate_hash, pin_hash FROM upstream_tools WHERE connection_id = 'con_a' ORDER BY name",
    );
    expect(rows.map((r) => [r.name, r.state, r.held_reason, r.candidate_hash])).toEqual([
      ["delete_page", "active", null, null],
      ["get_page", "active", null, null],
      ["new_one", "active", null, null],
    ]);
    expect(rows.find((r) => r.name === "get_page")!.pin_hash).toBe(pinHash(changed));
    expect(registry.resolve("agt_1", "alpha__get_page")!.def.title).toBe("Get");
    // The stored definition has no name (the row has it); it round-trips to the same hash.
    const back = store.get("con_a", "delete_page")!;
    expect(back.def).toEqual({ name: "delete_page", description: "Does delete_page", inputSchema: { type: "object" } });
    expect(back.cls).toEqual({ risky: true, read: false, source: "heuristic" });

    catalog.applyListing("con_a", { tools: [tool("get_page")] });
    expect(store.tools("con_a").map((t) => t.name)).toEqual(["get_page"]);
    catalog.close();
  });

  it("after a restart, the next listing isn't a first connect and restores the instructions", () => {
    const one = make();
    one.catalog.applyListing("con_a", { tools: [tool("a")], instructions: "Pinned text" });
    one.catalog.close();
    const two = make();
    expect(two.catalog.instructions("con_a")).toBeNull();
    const out = two.catalog.applyListing("con_a", { tools: [tool("a"), tool("b")], instructions: "Pinned text" });
    expect(out.first).toBe(false);
    expect(out).toMatchObject({ added: ["b"], instructionsChanged: false });
    expect(two.catalog.instructions("con_a")).toBe("Pinned text");
    two.catalog.forget("con_a");
    expect(two.store.state("con_a")!.refreshedAt).toBeNull();
    expect(two.store.tools("con_a")).toEqual([]);
  });

  describe("upgrade from a version with the tool-change hold", () => {
    const before = tool("get_page", { annotations: { readOnlyHint: true } });
    const after = tool("get_page", { annotations: { readOnlyHint: true }, description: "Gets a page by id" });
    const added = tool("delete_page");
    const stored = (d: ToolDef) => {
      const { name: _n, ...rest } = d;
      return JSON.stringify(rest);
    };
    /** Rows exactly as the older version wrote them: one held as changed, one held as new, one active. */
    const seedHeld = () => {
      const ins = (name: string, def: string | null, hash: string | null, read: number, state: string, reason: string | null, cand: string | null, candHash: string | null) =>
        db.run(
          `INSERT INTO upstream_tools (connection_id, name, exposed_name, definition, pin_hash, risky, read, class_source, state, held_reason,
             candidate_definition, candidate_hash, first_seen_at, updated_at) VALUES ('con_a', ?, ?, ?, ?, 0, ?, 'annotation', ?, ?, ?, ?, ?, ?)`,
          name,
          `alpha__${name}`,
          def,
          hash,
          read,
          state,
          reason,
          cand,
          candHash,
          T,
          T,
        );
      ins("get_page", stored(before), pinHash(before), 1, "held", "changed", stored(after), pinHash(after));
      ins("delete_page", null, null, 0, "held", "new", stored(added), pinHash(added));
      ins("other", stored(tool("other")), pinHash(tool("other")), 0, "active", null, null, null);
      db.run("UPDATE connections SET tools_cached_at = ? WHERE id = 'con_a'", T);
      db.run("UPDATE connection_grants SET level = 'full' WHERE agent_id = 'agt_1' AND connection_id = 'con_a'");
    };

    it("a tool held before the upgrade works after it: releaseLegacyHolds uses the waiting definition and audits it", () => {
      seedHeld();
      const { catalog, registry, audits } = make();
      expect(catalog.releaseLegacyHolds()).toBe(2);
      expect(db.get<{ n: number }>("SELECT count(*) AS n FROM upstream_tools WHERE state = 'held' OR held_reason IS NOT NULL OR candidate_hash IS NOT NULL")!.n).toBe(0);
      expect(registry.forAgent("agt_1").map((t) => t.exposedName)).toEqual(["alpha__delete_page", "alpha__get_page", "alpha__other"]);
      const got = registry.resolve("agt_1", "alpha__get_page")!;
      expect(got.def.description).toBe("Gets a page by id");
      expect(got.pinHash).toBe(pinHash(after));
      // Re-classified from what it is now: delete_page is risky.
      expect(registry.resolve("agt_1", "alpha__delete_page")!.cls).toMatchObject({ risky: true, read: false });
      expect(audits.filter((a) => a.action === "connection.tool_changed").map((a) => a.detail)).toEqual([
        { connectionId: "con_a", tool: "delete_page", previousHash: null, hash: pinHash(added), fields: ["name", "description", "inputSchema"], releasedHold: true },
        { connectionId: "con_a", tool: "get_page", previousHash: pinHash(before), hash: pinHash(after), fields: ["description"], releasedHold: true },
      ]);
      // Idempotent.
      expect(catalog.releaseLegacyHolds()).toBe(0);
    });

    it("a held row the release missed is never hidden, and the next listing replaces it", () => {
      seedHeld();
      const { catalog, registry } = make();
      // Served with its stored definition meanwhile (the held flag is ignored); a held-as-new row has none yet.
      expect(registry.forAgent("agt_1").map((t) => t.exposedName)).toEqual(["alpha__get_page", "alpha__other"]);
      const out = catalog.applyListing("con_a", { tools: [after, added, tool("other")] });
      expect(out).toMatchObject({ ok: true, first: false, changed: ["delete_page", "get_page"], added: [] });
      expect(db.get<{ n: number }>("SELECT count(*) AS n FROM upstream_tools WHERE state = 'held'")!.n).toBe(0);
      expect(registry.forAgent("agt_1").map((t) => t.exposedName)).toEqual(["alpha__delete_page", "alpha__get_page", "alpha__other"]);
      expect(registry.resolve("agt_1", "alpha__get_page")!.def.description).toBe("Gets a page by id");
    });
  });

  it("renames on a slug edit and refuses a sanitised duplicate instead of breaking the UNIQUE index", () => {
    const { catalog, registry } = make();
    catalog.applyListing("con_a", { tools: [tool("x")] });
    db.run("UPDATE connections SET slug = 'gamma' WHERE id = 'con_a'");
    registry.invalidate();
    expect(registry.forAgent("agt_1")).toEqual([]); // x isn't a read tool; check names via the table instead
    const out = catalog.applyListing("con_a", { tools: [tool("x"), tool("a.b"), tool("a_b")] });
    expect(out.refused).toEqual([{ connectionId: "con_a", name: "a_b", reason: "collision", with: "gamma__a_b" }]);
    expect(db.all("SELECT name AS n, exposed_name AS e FROM upstream_tools ORDER BY n")).toEqual([
      { n: "a.b", e: "gamma__a_b" },
      { n: "x", e: "gamma__x" },
    ]);
  });
});
