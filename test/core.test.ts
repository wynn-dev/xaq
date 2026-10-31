import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../server/db/index.ts";
import { MIGRATIONS } from "../server/db/schema.ts";
import { matchesAnyGlob, matchesGlob } from "../server/util/glob.ts";
import { testContext } from "./helpers.ts";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

describe("settings", () => {
  it("returns defaults and validates updates", () => {
    const t = testContext();
    dispose = t.dispose;
    const s = t.ctx.settings;
    expect(s.get().pollIntervalSeconds).toBe(30);
    expect(s.update({ publicUrl: "https://mail.example.com/" }).publicUrl).toBe("https://mail.example.com");
    expect(() => s.update({ publicUrl: "not a url" })).toThrow(/full URL/);
    expect(() => s.update({ pollIntervalSeconds: 1 })).toThrow(/Poll interval/);
    s.setState("admin.passwordHash", "x");
    expect(s.getState("admin.passwordHash")).toBe("x");
  });
});

describe("audit", () => {
  it("records, emits and pages newest first", () => {
    const t = testContext();
    dispose = t.dispose;
    const seen: string[] = [];
    t.ctx.bus.on("audit", (e) => seen.push(e.action));
    for (let i = 0; i < 5; i++) t.ctx.audit.record({ actorType: "admin", action: `a${i}`, outcome: "ok" });
    t.ctx.audit.record({ actorType: "system", action: "x", outcome: "denied", reason: "rate_limit" });
    expect(seen).toHaveLength(6);
    const p1 = t.ctx.audit.list({ limit: 4 });
    expect(p1.items.map((e) => e.action)).toEqual(["x", "a4", "a3", "a2"]);
    expect(p1.items[1]!.actorName).toBe("admin");
    const p2 = t.ctx.audit.list({ limit: 4, cursor: p1.nextCursor });
    expect(p2.items.map((e) => e.action)).toEqual(["a1", "a0"]);
    expect(p2.nextCursor).toBeNull();
    expect(t.ctx.audit.list({ outcome: "denied" }).items[0]!.reason).toBe("rate_limit");
  });
});

describe("migration 5", () => {
  it("backfills agent origin from kept pairings and listeners, defaulting to key", () => {
    const dir = mkdtempSync(join(tmpdir(), "xaq-mig-"));
    try {
      const path = join(dir, "db.sqlite");
      const raw = new DatabaseSync(path);
      raw.exec("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      MIGRATIONS.slice(0, 4).forEach((sql, i) => {
        raw.exec(sql);
        raw.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(i + 1, "2026-01-01T00:00:00.000Z");
      });
      const t = "2026-01-01T00:00:00.000Z";
      for (const id of ["agt_paired", "agt_listener", "agt_key", "agt_denied"]) {
        raw.prepare("INSERT INTO agents (id, name, key_prefix, key_hash, created_at) VALUES (?, ?, 'aib_x', ?, ?)").run(id, id, `h_${id}`, t);
      }
      const pairing = (id: string, status: string, agentId: string) =>
        raw
          .prepare(
            "INSERT INTO pairings (id, device_code_hash, user_code, name, status, agent_id, created_at, expires_at) VALUES (?, ?, ?, 'x', ?, ?, ?, ?)",
          )
          .run(id, `d_${id}`, `U_${id}`, status, agentId, t, t);
      pairing("prq_1", "approved", "agt_paired");
      pairing("prq_2", "denied", "agt_denied");
      raw.prepare("INSERT INTO listener_cursors (agent_id, consumer, updated_at) VALUES ('agt_listener', 'default', ?)").run(t);
      raw.close();

      const db = new Db(path);
      const origins = Object.fromEntries(db.all<{ id: string; origin: string }>("SELECT id, origin FROM agents").map((r) => [r.id, r.origin]));
      expect(origins).toEqual({ agt_paired: "paired", agt_listener: "paired", agt_key: "key", agt_denied: "key" });
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE last_mcp_at IS NULL")!.n).toBe(4);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migration 6", () => {
  const upTo5 = (dir: string, withMcp: boolean) => {
    const path = join(dir, "db.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    MIGRATIONS.slice(0, 5).forEach((sql, i) => {
      raw.exec(sql);
      raw.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(i + 1, "2026-01-01T00:00:00.000Z");
    });
    raw
      .prepare("INSERT INTO agents (id, name, key_prefix, key_hash, created_at, last_mcp_at) VALUES ('agt_1', 'a', 'aib_x', 'h', ?, ?)")
      .run("2026-01-01T00:00:00.000Z", withMcp ? "2026-01-02T00:00:00.000Z" : null);
    raw.close();
    return path;
  };

  it("keeps an install verified where an agent already reached /mcp (its audit rows may be pruned)", () => {
    const dir = mkdtempSync(join(tmpdir(), "xaq-mig-"));
    try {
      const db = new Db(upTo5(dir, true));
      const v = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'setup.verifiedAt'");
      expect(Date.parse(JSON.parse(v!.value) as string)).not.toBeNaN();
      db.close();
      const fresh = new Db(upTo5(mkdtempSync(join(dir, "b-")), false));
      expect(fresh.get("SELECT 1 FROM settings WHERE key = 'setup.verifiedAt'")).toBeUndefined();
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migrations 14 to 16", () => {
  it("drop the settings of removed features and tools left on hold, keep the rest, and never widen a connection grant", () => {
    const dir = mkdtempSync(join(tmpdir(), "xaq-mig-"));
    try {
      const path = join(dir, "db.sqlite");
      const raw = new DatabaseSync(path);
      raw.exec("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      MIGRATIONS.slice(0, 13).forEach((sql, i) => {
        raw.exec(sql);
        raw.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(i + 1, "2026-01-01T00:00:00.000Z");
      });
      const put = raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
      put.run("settings", JSON.stringify({ pollIntervalSeconds: 45, attachmentDirs: ["/tmp"], attachmentSaveDir: "/x", brokerUpstreams: true }));
      raw.exec("INSERT INTO connections (id, owner_id, kind, slug, name, url, auth_type, created_at, updated_at) VALUES ('con_a', 'owner', 'remote_http', 'a', 'A', 'https://a.example', 'none', 'T', 'T')");
      raw.exec("INSERT INTO connections (id, owner_id, kind, slug, name, url, auth_type, level_default, created_at, updated_at) VALUES ('con_b', 'owner', 'remote_http', 'b', 'B', 'https://b.example', 'none', 'full', 'T', 'T')");
      const agent = raw.prepare("INSERT INTO agents (id, name, key_prefix, key_hash, created_at) VALUES (?, ?, 'aib_x', ?, 'T')");
      const access = raw.prepare("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, ?, 'T', 'T')");
      for (const [id, level] of [["agt_ask", "ask"], ["agt_full", "full"], ["agt_read", "read"]] as const) {
        agent.run(id, id, `h_${id}`);
        access.run(id, "con_a", level);
      }
      const tool = raw.prepare(
        "INSERT INTO upstream_tools (connection_id, name, exposed_name, definition, pin_hash, risky, read, class_source, state, held_reason, candidate_definition, candidate_hash, first_seen_at, updated_at) VALUES ('con_a', ?, ?, ?, ?, 0, 0, 'annotation', ?, ?, ?, ?, 'T', 'T')",
      );
      tool.run("kept", "a__kept", "{}", "h1", "active", null, null, null);
      tool.run("changed", "a__changed", "{}", "h2", "held", "changed", "{}", "h3");
      tool.run("new", "a__new", null, null, "held", "new", "{}", "h4");
      for (const key of ["broker.search:agt_1", "broker.defaultOnApplied", "broker.searchDirectPinned", "setup.verifiedAt"]) put.run(key, '"2026-01-01"');
      raw.close();

      const db = new Db(path);
      expect(JSON.parse(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'settings'")!.value)).toEqual({ pollIntervalSeconds: 45 });
      expect(db.all<{ key: string }>("SELECT key FROM settings WHERE key != 'settings'").map((r) => r.key)).toEqual(["setup.verifiedAt"]);
      expect(db.all<{ name: string }>("SELECT name FROM upstream_tools").map((r) => r.name)).toEqual(["kept"]);
      // Ask before risky calls becomes read only, not full access.
      expect(db.all("SELECT agent_id AS a, level FROM connection_grants ORDER BY agent_id")).toEqual([
        { a: "agt_ask", level: "read" },
        { a: "agt_full", level: "full" },
        { a: "agt_read", level: "read" },
      ]);
      expect(db.all("SELECT id, level_default AS d FROM connections ORDER BY id")).toEqual([
        { id: "con_a", d: "read" },
        { id: "con_b", d: "full" },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("glob", () => {
  it("matches address globs case-insensitively", () => {
    expect(matchesGlob("Bob@Example.com", "*@example.com")).toBe(true);
    expect(matchesGlob("bob@example.com.evil", "*@example.com")).toBe(false);
    expect(matchesGlob("a+b@x.io", "a+b@x.io")).toBe(true);
    expect(matchesAnyGlob("c@y.io", ["a@x.io", "*@y.io"])).toBe(true);
  });
});
