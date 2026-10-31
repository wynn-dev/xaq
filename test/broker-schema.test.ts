// Migration 8: the broker tables and the approvals rebuild. An install at
// migration 7 keeps every row, index and cascade; a fresh install gets the same schema; the CHECKs hold.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONNECTION_SLUG_RE, EXPOSED_TOOL_NAME_RE, type McpCallApproval } from "../shared/types.ts";
import { Db } from "../server/db/index.ts";
import { MIGRATIONS } from "../server/db/schema.ts";
import type { IngestService } from "../server/ingest/index.ts";
import { createAppContext, stopServices } from "../server/wire.ts";
import { testConfig } from "./helpers.ts";
import { FakeGoogle, fakeAccounts } from "./mail-fakes.ts";

const T = "2026-01-01T00:00:00.000Z";
const LATER = "2099-01-01T00:00:00.000Z";

type Rows = Record<string, unknown>[];
const plain = (rows: unknown[]): Rows => rows.map((r) => ({ ...(r as Record<string, unknown>) }));

/** Every row of every table (rowid included), keyed by table. */
function snapshot(db: DatabaseSync): Map<string, Rows> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return new Map(tables.map(({ name }) => [name, plain(db.prepare(`SELECT rowid AS _rowid, * FROM "${name}" ORDER BY rowid`).all())]));
}

const mailPayload = (subject: string) =>
  JSON.stringify({ to: [{ name: null, email: "a@example.com" }], cc: [], bcc: [], subject, body: "Hello", threadId: null, attachments: [], reason: "asked" });
const calendarPayload = JSON.stringify({
  to: [{ name: null, email: "bob@partner.test" }],
  cc: [],
  bcc: [],
  subject: "Sync",
  body: "",
  threadId: null,
  attachments: [],
  reason: null,
  calendar: {
    calendarId: "wynn@example.com",
    calendarName: null,
    eventId: "evt0001",
    change: { summary: "Sync" },
    before: null,
    etag: null,
    response: null,
    notifyAttendees: true,
    notified: ["bob@partner.test"],
  },
});

/** A database as the last pre-broker release left it (migrations 1–7), with live mail and calendar data. */
function preBrokerDb(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  MIGRATIONS.slice(0, 7).forEach((sql, i) => {
    raw.exec(sql);
    raw.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(i + 1, T);
  });
  const run = (sql: string, ...params: (string | number | null)[]) => raw.prepare(sql).run(...params);
  run("INSERT INTO settings (key, value) VALUES ('setup.verifiedAt', ?)", JSON.stringify(T));
  const account = `INSERT INTO accounts (id, email, status, refresh_token_enc, access_token_enc, access_expires_at, scopes, history_id, created_at, calendar_status)
    VALUES (?, ?, 'active', ?, 'v1:at', ?, '["https://www.googleapis.com/auth/gmail.modify"]', '42', ?, ?)`;
  run(account, "acc_1", "wynn@example.com", "v1:rt1", T, T, null);
  run(account, "acc_2", "ops@example.com", "v1:rt2", T, T, "api_disabled");
  const agent = "INSERT INTO agents (id, name, key_prefix, key_hash, created_at, origin, last_mcp_at) VALUES (?, ?, 'aib_x', ?, ?, ?, ?)";
  run(agent, "agt_hermes", "Hermes", "h1", T, "paired", T);
  run(agent, "agt_codex", "Codex", "h2", T, "key", null);
  const grant = `INSERT INTO grants (id, agent_id, account_id, capabilities, send_mode, created_at, calendar_write_mode) VALUES (?, ?, ?, ?, 'approval', ?, 'approval')`;
  run(grant, "grt_1", "agt_hermes", "acc_1", '["read","send","calendar.read","calendar.write"]', T);
  run(grant, "grt_2", "agt_hermes", "acc_2", '["read","send"]', T);
  run(grant, "grt_3", "agt_codex", "acc_1", '["read"]', T);
  // Ids deliberately out of rowid order, and created_at ties: the list orders by (created_at, rowid).
  const approval = `INSERT INTO approvals (id, agent_id, account_id, kind, status, draft_id, payload, decided_at, decision_note, sent_message_id, error, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  run(approval, "apr_z_mail", "agt_hermes", "acc_1", "send", "pending", "r-1", mailPayload("First"), null, null, null, null, T, LATER);
  // A pruned row leaves a rowid gap: the rebuild must keep rowids, not renumber them.
  run(approval, "apr_pruned", "agt_hermes", "acc_1", "send", "expired", "r-x", mailPayload("Old"), T, null, null, null, T, T);
  run(approval, "apr_a_cal", "agt_hermes", "acc_1", "calendar.create", "pending", "", calendarPayload, null, null, null, null, T, LATER);
  run(approval, "apr_m_ops", "agt_hermes", "acc_2", "reply", "pending", "r-2", mailPayload("Ops"), null, null, null, "Sending failed temporarily (x).", T, LATER);
  run(approval, "apr_b_sent", "agt_hermes", "acc_1", "forward", "sent", "r-0", mailPayload("Done"), T, "ok", "m-sent", null, T, LATER);
  run(approval, "apr_c_codex", "agt_codex", "acc_1", "send", "rejected", "r-9", mailPayload("No"), T, "cancelled: x", null, null, T, LATER);
  run("DELETE FROM approvals WHERE id = 'apr_pruned'");
  run(
    `INSERT INTO events (id, type, account_id, gmail_message_id, label_ids, message, dedupe_key, created_at, calendar_id, calendar_event)
     VALUES (?, ?, 'acc_1', ?, '["INBOX"]', ?, ?, ?, ?, ?)`,
    "evt_1",
    "message.received",
    "m1",
    '{"id":"m1"}',
    "acc_1:m1:message.received",
    T,
    null,
    null,
  );
  run(
    `INSERT INTO events (id, type, account_id, label_ids, dedupe_key, created_at, calendar_id, calendar_event) VALUES ('evt_2', 'calendar.event_created', 'acc_1', '[]', 'k2', ?, 'wynn@example.com', '{"id":"e1"}')`,
    T,
  );
  run("INSERT INTO sent_threads (account_id, gmail_thread_id, last_sent_at) VALUES ('acc_1', 't1', ?)", T);
  run("INSERT INTO calendar_sync (account_id, calendar_id, sync_token, updated_at) VALUES ('acc_1', 'wynn@example.com', 'tok', ?)", T);
  run("INSERT INTO calendar_event_state (account_id, calendar_id, event_id, fingerprint, summary, updated_at) VALUES ('acc_1', 'wynn@example.com', 'e1', 'f', '{}', ?)", T);
  run("INSERT INTO agent_cursors (agent_id, acked_seq, updated_at) VALUES ('agt_hermes', 1, ?)", T);
  run("INSERT INTO listener_cursors (agent_id, consumer, acked_seq, updated_at, start_seq) VALUES ('agt_hermes', 'default', 2, ?, 0)", T);
  run(
    "INSERT INTO pairings (id, device_code_hash, user_code, name, status, agent_id, created_at, expires_at) VALUES ('par_1', 'd', 'K7QM-2XPD', 'Hermes', 'approved', 'agt_hermes', ?, ?)",
    T,
    LATER,
  );
  run("INSERT INTO oauth_states (state, code_verifier, redirect_uri, created_at) VALUES ('st', 'cv', 'http://localhost/oauth/callback', ?)", T);
  run("INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES ('th', ?, ?)", T, LATER);
  const audit = "INSERT INTO audit_log (ts, actor_type, actor_id, action, account_id, target, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
  run(audit, T, "agent", "agt_hermes", "send_message", "acc_1", "apr_z_mail", "ok", '{"mode":"approval"}');
  run(audit, T, "admin", null, "approval.approve", "acc_1", "apr_b_sent", "ok", null);
  raw.close();
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xaq-broker-mig-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("migration 8 on an install at migration 7", () => {
  it("keeps every row of every table, approvals included (same ids, rowids and values; new columns NULL)", () => {
    const path = join(dir, "db.sqlite");
    preBrokerDb(path);
    const before = new DatabaseSync(path);
    const was = snapshot(before);
    const approvalIndexes = before.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approvals' AND sql IS NOT NULL").all();
    before.close();
    expect(was.get("approvals")).toHaveLength(5);
    expect(plain(approvalIndexes)).toEqual([{ name: "approvals_status" }]);

    const db = new Db(path);
    expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM _migrations")!.v).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(8);
    db.close();

    const after = new DatabaseSync(path, { readOnly: true });
    try {
      const now = snapshot(after);
      for (const [table, rows] of was) {
        if (table === "_migrations") continue;
        // Migration 13 drops webhooks (their tables), Gmail watches and Calendar push channels (their columns).
        if (table === "webhooks" || table === "deliveries") {
          expect(now.has(table)).toBe(false);
        } else if (table === "accounts" || table === "calendar_sync") {
          const kept = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "watch_expires_at" && !k.startsWith("channel_")));
          expect([table, now.get(table)]).toEqual([table, rows.map(kept)]);
        } else if (table === "approvals") {
          expect(now.get(table)).toEqual(rows.map((r) => ({ ...r, connection_id: null, tool_call: null })));
        } else if (table === "events" || table === "oauth_states") {
          // events.connection_id (migration 8); oauth_states.connection_id (migration 9, upstream OAuth).
          expect(now.get(table)).toEqual(rows.map((r) => ({ ...r, connection_id: null })));
        } else {
          expect([table, now.get(table)]).toEqual([table, rows]);
        }
      }
      expect(now.get("_migrations")!.slice(0, 7)).toEqual(was.get("_migrations"));
      for (const table of ["connections", "connection_credentials", "upstream_tools", "connection_grants", "approval_rules"]) {
        expect([table, now.get(table)]).toEqual([table, []]);
      }
      // No leftovers of the rebuild.
      expect(after.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%approvals_new%'").all()).toEqual([]);

      expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(plain(after.prepare("PRAGMA integrity_check").all())).toEqual([{ integrity_check: "ok" }]);

      // Same indexes plus the connection one; same foreign keys and cascades plus the connection one.
      const indexes = plain(after.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approvals' AND sql IS NOT NULL ORDER BY name").all());
      expect(indexes).toEqual([{ name: "approvals_connection" }, { name: "approvals_status" }]);
      expect(plain(after.prepare("PRAGMA index_info(approvals_status)").all()).map((c) => c.name)).toEqual(["status", "created_at"]);
      const fks = plain(after.prepare("PRAGMA foreign_key_list(approvals)").all()).map((f) => [f.from, f.table, f.to, f.on_delete]);
      expect(fks.sort()).toEqual([
        ["account_id", "accounts", "id", "CASCADE"],
        ["agent_id", "agents", "id", "CASCADE"],
        ["connection_id", "connections", "id", "CASCADE"],
      ]);
      const cols = plain(after.prepare("PRAGMA table_info(approvals)").all());
      const notNull = Object.fromEntries(cols.map((c) => [c.name, c.notnull]));
      expect(notNull).toMatchObject({ account_id: 0, draft_id: 0, connection_id: 0, tool_call: 0, agent_id: 1, kind: 1, payload: 1, created_at: 1, expires_at: 1 });
      expect(cols.find((c) => c.name === "status")).toMatchObject({ notnull: 1, dflt_value: "'pending'" });

      // events: connection_id added and indexed (no rebuild); account_id stays NOT NULL.
      const eventCols = Object.fromEntries(plain(after.prepare("PRAGMA table_info(events)").all()).map((c) => [c.name, c.notnull]));
      expect(eventCols).toMatchObject({ account_id: 1, connection_id: 0 });
      expect(plain(after.prepare("PRAGMA index_info(events_connection_seq)").all()).map((c) => c.name)).toEqual(["connection_id", "seq"]);
    } finally {
      after.close();
    }

    // Reopening doesn't run it again.
    const again = new Db(path);
    expect(again.get<{ n: number }>("SELECT COUNT(*) AS n FROM _migrations WHERE version = 8")!.n).toBe(1);
    expect(again.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals")!.n).toBe(5);
    again.close();
  });

  it("serves, cancels, rejects and approves the migrated approvals, and the account and agent cascades still delete them", async () => {
    const config = testConfig();
    preBrokerDb(config.dbPath);
    const google = new FakeGoogle();
    const ctx = createAppContext(config, {
      google: () => google.service(),
      accounts: (c) => fakeAccounts(c),
      ingest: () => ({ kick: () => {} }) as unknown as IngestService,
    });
    try {
      const gmail1 = google.gmail("acc_1");
      gmail1.drafts.set("r-1", { id: "r-1", raw: Buffer.from("To: a@example.com\r\n\r\nHello").toString("base64url"), threadId: null });
      google.gmail("acc_2").drafts.set("r-2", { id: "r-2", raw: "eA", threadId: null });

      // Same list, same order (created_at ties broken by the kept rowids), same fields.
      const all = ctx.mail.listApprovals();
      expect(all.map((a) => a.id)).toEqual(["apr_c_codex", "apr_b_sent", "apr_m_ops", "apr_a_cal", "apr_z_mail"]);
      expect(ctx.mail.listApprovals("pending").map((a) => a.id)).toEqual(["apr_m_ops", "apr_a_cal", "apr_z_mail"]);
      expect(ctx.mail.getApproval("apr_z_mail")).toMatchObject({
        kind: "send",
        status: "pending",
        accountId: "acc_1",
        accountEmail: "wynn@example.com",
        agentName: "Hermes",
        draftId: "r-1",
        connectionId: null,
        subject: "First",
        reason: "asked",
      });
      const cal = ctx.mail.getApproval("apr_a_cal")!;
      expect(cal).toMatchObject({ kind: "calendar.create", draftId: "", accountId: "acc_1", calendar: { calendarId: "wynn@example.com", eventId: "evt0001" } });
      expect(ctx.mail.getApproval("apr_b_sent")).toMatchObject({ status: "sent", sentMessageId: "m-sent", decisionNote: "ok", decidedAt: T });
      expect(ctx.mail.getApproval("apr_m_ops")).toMatchObject({ error: "Sending failed temporarily (x)." });

      // Removing the agent's access to acc_2 cancels its pending approval there, as before.
      ctx.policy.deleteGrant("agt_hermes", "acc_2");
      expect(ctx.mail.getApproval("apr_m_ops")).toMatchObject({ status: "rejected", decisionNote: expect.stringMatching(/^cancelled: /) });

      // A migrated mail approval still sends on approve.
      const sent = await ctx.mail.approve("apr_z_mail");
      expect(sent).toMatchObject({ status: "sent", sentMessageId: expect.any(String) });
      expect(gmail1.sent).toHaveLength(1);
      expect(await ctx.mail.reject("apr_a_cal")).toMatchObject({ status: "rejected" });

      // Deleting a Google account still deletes its approvals (and grants, calendar state) by cascade.
      await ctx.accounts.remove("acc_1");
      expect(ctx.db.all<{ id: string }>("SELECT id FROM approvals ORDER BY id").map((r) => r.id)).toEqual(["apr_m_ops"]);
      expect(ctx.db.all("SELECT id FROM grants WHERE account_id = 'acc_1'")).toEqual([]);
      expect(ctx.db.all("SELECT * FROM calendar_sync")).toEqual([]);

      // And deleting the agent deletes the rest.
      ctx.policy.deleteAgent("agt_hermes");
      expect(ctx.db.all("SELECT id FROM approvals")).toEqual([]);
      expect(ctx.db.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      await stopServices(ctx);
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("rolls back as a whole when the rebuild can't complete, leaving the install at migration 7", () => {
    const path = join(dir, "db.sqlite");
    preBrokerDb(path);
    // Simulate a name clash mid-migration: the rebuild's CREATE fails after the broker tables were created.
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE approvals_new (x INTEGER)");
    raw.close();
    expect(() => new Db(path)).toThrow(/approvals_new already exists/);
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      expect(check.prepare("SELECT MAX(version) AS v FROM _migrations").get()).toEqual({ v: 7 });
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'connections'").all()).toEqual([]);
      expect(check.prepare("SELECT COUNT(*) AS n FROM approvals").get()).toEqual({ n: 5 });
    } finally {
      check.close();
    }
  });
});

// ───────────────────────────── Fresh database ─────────────────────────────

let db: Db;
const insert = {
  agent(id = "agt_1") {
    db.run("INSERT INTO agents (id, name, key_prefix, key_hash, created_at) VALUES (?, ?, 'aib_x', ?, ?)", id, id, `h-${id}`, T);
  },
  account(id = "acc_1") {
    db.run("INSERT INTO accounts (id, email, refresh_token_enc, created_at) VALUES (?, ?, 'v1:x', ?)", id, `${id}@example.com`, T);
  },
  connection(patch: Record<string, string | null> = {}) {
    const row = { id: "con_1", kind: "remote_http", slug: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", created_at: T, updated_at: T, ...patch };
    const cols = Object.keys(row);
    db.run(`INSERT INTO connections (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...Object.values(row));
  },
  tool(patch: Record<string, string | number | null> = {}) {
    const row = {
      connection_id: "con_1",
      name: "notion-search",
      exposed_name: "notion__notion-search",
      definition: '{"inputSchema":{"type":"object"}}',
      pin_hash: "a".repeat(64),
      class_source: "annotation",
      read: 1,
      first_seen_at: T,
      updated_at: T,
      ...patch,
    };
    const cols = Object.keys(row);
    db.run(`INSERT INTO upstream_tools (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...Object.values(row));
  },
  grant(level = "ask", agent = "agt_1", connection = "con_1") {
    db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", agent, connection, level, T, T);
  },
  rule(id = "rul_1", path: string | null = null, value: string | null = null) {
    db.run("INSERT INTO approval_rules (id, agent_id, connection_id, tool, target_path, target_value, created_at) VALUES (?, 'agt_1', 'con_1', 'notion-delete-pages', ?, ?, ?)", id, path, value, T);
  },
  mcpApproval(id = "apr_1", patch: Record<string, string | null> = {}) {
    const row = {
      id,
      agent_id: "agt_1",
      account_id: null,
      connection_id: "con_1",
      kind: "mcp.call",
      draft_id: null,
      payload: '{"reason":null}',
      tool_call: JSON.stringify({ tool: "notion-delete-pages", exposedName: "notion__notion-delete-pages", args: '{"page_id":"p1"}', argsSha256: "b".repeat(64), pinHash: "a".repeat(64) }),
      created_at: T,
      expires_at: LATER,
      ...patch,
    };
    const cols = Object.keys(row);
    db.run(`INSERT INTO approvals (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...Object.values(row));
  },
};
const count = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
const CHECK = /CHECK constraint failed/;
const UNIQUE = /UNIQUE constraint failed/;

describe("migration 8 on a fresh database", () => {
  beforeEach(() => {
    db = new Db(join(dir, "fresh.sqlite"));
    insert.agent();
  });
  afterEach(() => db.close());

  it("creates the broker tables with the documented columns and defaults", () => {
    expect(db.get<{ v: number }>("SELECT MAX(version) AS v FROM _migrations")!.v).toBe(MIGRATIONS.length);
    const cols = (t: string) => db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
    expect(cols("connections")).toEqual([
      "id",
      "owner_id",
      "kind",
      "preset",
      "slug",
      "name",
      "url",
      "auth_type",
      "level_default",
      "private_target",
      "status",
      "status_reason",
      "expires_at",
      "protocol",
      "protocol_checked_at",
      "tools_cached_at",
      "instructions_hash",
      "events_cursor",
      "created_at",
      "updated_at",
      "all_agents", // migration 10
      "google_account_id", // migration 12
    ]);
    expect(cols("connection_credentials")).toEqual([
      "connection_id",
      "header_name_enc",
      "header_value_enc",
      "oauth_issuer_enc",
      "oauth_client_enc",
      "access_token_enc",
      "refresh_token_enc",
      "expires_at",
      "scope",
      "pkce_verifier_enc",
      "discovery_enc",
      "created_at",
      "updated_at",
      "issued_at", // migration 9
    ]);
    expect(cols("events")).toContain("connection_id");
    expect(cols("connection_grants")).toEqual(["agent_id", "connection_id", "level", "created_at", "updated_at"]);
    expect(cols("approval_rules")).toEqual(["id", "agent_id", "connection_id", "tool", "target_path", "target_value", "created_at"]);
    insert.connection();
    expect(db.get("SELECT owner_id, preset, auth_type, level_default, private_target, status FROM connections")).toEqual({
      owner_id: null,
      preset: null,
      auth_type: "none",
      level_default: "ask",
      private_target: null,
      status: "active",
    });
    insert.tool();
    expect(db.get("SELECT risky, read, state, held_reason FROM upstream_tools")).toEqual({ risky: 0, read: 1, state: "active", held_reason: null });
    // A connection event: account_id is '' (still NOT NULL), connection_id carries the connection.
    db.run("INSERT INTO events (id, type, account_id, connection_id, dedupe_key, created_at) VALUES ('evt_c', 'connection.auth_failed', '', 'con_1', 'con_1:auth', ?)", T);
    expect(() => db.run("INSERT INTO events (id, type, account_id, connection_id, dedupe_key, created_at) VALUES ('evt_n', 'x', NULL, 'con_1', 'k', ?)", T)).toThrow(/NOT NULL/);
    expect(db.get("SELECT account_id, connection_id FROM events WHERE connection_id = 'con_1'")).toEqual({ account_id: "", connection_id: "con_1" });
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("deleting a connection deletes its credential, tools, grants, allow rules and approvals; deleting an agent deletes its grants, rules and approvals", () => {
    insert.agent("agt_2");
    insert.connection();
    insert.connection({ id: "con_2", slug: "t3-forge", url: "http://100.104.249.49:3773/mcp", private_target: "http://100.104.249.49:3773", auth_type: "oauth" });
    db.run("INSERT INTO connection_credentials (connection_id, access_token_enc, created_at, updated_at) VALUES ('con_1', 'v1:a', ?, ?), ('con_2', 'v1:b', ?, ?)", T, T, T, T);
    insert.tool();
    insert.tool({ connection_id: "con_2", name: "list_threads", exposed_name: "t3-forge__list_threads" });
    insert.grant("ask");
    insert.grant("full", "agt_2");
    insert.grant("read", "agt_1", "con_2");
    insert.rule();
    insert.mcpApproval("apr_1");
    insert.mcpApproval("apr_2", { connection_id: "con_2" });

    db.run("DELETE FROM connections WHERE id = 'con_1'");
    expect([count("connection_credentials"), count("upstream_tools"), count("connection_grants"), count("approval_rules"), count("approvals")]).toEqual([1, 1, 1, 0, 1]);
    expect(db.get("SELECT connection_id FROM connection_grants")).toEqual({ connection_id: "con_2" });

    db.run("DELETE FROM agents WHERE id = 'agt_1'");
    expect([count("connection_grants"), count("approvals"), count("connections"), count("upstream_tools")]).toEqual([0, 0, 1, 1]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("reads an mcp.call approval as McpCallApproval (no account, no draft); approving goes through the broker", async () => {
    const config = testConfig();
    db.close();
    const ctx = createAppContext(config, { google: () => new FakeGoogle().service(), accounts: (c) => fakeAccounts(c) });
    db = ctx.db;
    try {
      insert.agent();
      insert.connection();
      insert.mcpApproval();
      const a = ctx.mail.getApproval("apr_1") as McpCallApproval;
      expect(a).toMatchObject({
        kind: "mcp.call",
        accountId: null,
        accountEmail: null,
        draftId: null,
        connectionId: "con_1",
        call: { tool: "notion-delete-pages", exposedName: "notion__notion-delete-pages", args: '{"page_id":"p1"}' },
      });
      expect(a.calendar).toBeUndefined();
      // The broker's runner (M1 PR 7) re-checks first: the agent has no grant on the connection, so it's cancelled, never run.
      expect(await ctx.mail.approve("apr_1")).toMatchObject({ status: "rejected" });
    } finally {
      await stopServices(ctx);
      rmSync(config.dataDir, { recursive: true, force: true });
      db = new Db(":memory:"); // for afterEach
    }
  });
});

describe("migration 8 constraints", () => {
  beforeEach(() => {
    db = new Db(":memory:");
    insert.agent();
  });
  afterEach(() => db.close());

  it("slugs are [a-z0-9-]{1,24}, unique, and agree with CONNECTION_SLUG_RE", () => {
    const good = ["notion", "t3-forge", "a", "0", "x".repeat(24), "-a-"];
    const bad = ["", "Notion", "has_underscore", "a.b", "with space", "x".repeat(25), "café", "a__b", "a/b"];
    good.forEach((slug, i) => {
      expect(CONNECTION_SLUG_RE.test(slug)).toBe(true);
      insert.connection({ id: `con_g${i}`, slug });
    });
    bad.forEach((slug, i) => {
      expect(CONNECTION_SLUG_RE.test(slug)).toBe(false);
      expect(() => insert.connection({ id: `con_b${i}`, slug }), slug).toThrow(CHECK);
    });
    expect(() => insert.connection({ id: "con_dup", slug: "notion" })).toThrow(UNIQUE);
  });

  it("checks kind, preset, auth_type, level_default, status, the url for remote_http and the private-target shape", () => {
    let n = 0;
    const tryInsert = (patch: Record<string, string | null>) => insert.connection({ id: `con_${++n}`, slug: `s${n}`, ...patch });
    for (const kind of ["native_whoop", "stdio", "native_google"]) tryInsert({ kind, url: null });
    expect(() => tryInsert({ kind: "sse" })).toThrow(CHECK);
    expect(() => tryInsert({ kind: "remote_http", url: null })).toThrow(CHECK);
    // No CHECK on preset: the code validates it against the preset registry, so new presets need no rebuild.
    for (const preset of ["notion", "whoop", "github"]) tryInsert({ preset });
    for (const auth_type of ["none", "header", "oauth"]) tryInsert({ auth_type });
    expect(() => tryInsert({ auth_type: "basic" })).toThrow(CHECK);
    for (const level_default of ["full", "ask", "read"]) tryInsert({ level_default });
    expect(() => tryInsert({ level_default: "write" })).toThrow(CHECK);
    for (const status of ["active", "needs_reauth", "error", "disabled"]) tryInsert({ status });
    expect(() => tryInsert({ status: "paused" })).toThrow(CHECK);
    for (const private_target of ["http://127.0.0.1:8787", "http://100.104.249.49:3773", "http://macbook.tailb10092.ts.net:443", "https://localhost:3000"]) {
      tryInsert({ private_target });
    }
    const bad = [
      ...["http://127.0.0.1", "http://127.0.0.1:8787/mcp", "ftp://x:1", "http://user@host:1", "http://:80", "127.0.0.1:80", "http://h:80?x", "http://h:8a"],
      // Canonicalised in code; the CHECK refuses the characters that could hide a different host.
      ...["https://[::1]:3000", "http://h\\x:80", "http://127.0.0.1\\@evil:80", "http://h%2e:80", "http://h\tx:80", "http://h\nx:80", "http://h\u0001:80", "http://h\u007f:80"],
    ];
    for (const private_target of bad) {
      expect(() => tryInsert({ private_target }), JSON.stringify(private_target)).toThrow(CHECK);
    }
  });

  it("exposed names are unique across connections, [A-Za-z0-9_-] and at most 64; (connection, name) is unique", () => {
    insert.connection();
    insert.connection({ id: "con_2", slug: "other" });
    insert.tool();
    expect(() => insert.tool({ connection_id: "con_2", name: "x", exposed_name: "notion__notion-search" })).toThrow(UNIQUE);
    expect(() => insert.tool({ exposed_name: "notion__other" })).toThrow(UNIQUE); // same (connection, name)
    const max = `notion__${"x".repeat(56)}`;
    expect(EXPOSED_TOOL_NAME_RE.test(max)).toBe(true);
    insert.tool({ name: "long", exposed_name: max });
    for (const exposed_name of [`${max}x`, "notion__a.b", "notion__a b", "", "notion__é"]) {
      expect(EXPOSED_TOOL_NAME_RE.test(exposed_name)).toBe(false);
      expect(() => insert.tool({ name: `n-${exposed_name}`, exposed_name }), exposed_name).toThrow(CHECK);
    }
  });

  it("tool classes and the hold state are consistent", () => {
    insert.connection();
    let n = 0;
    const tool = (patch: Record<string, string | number | null>) => insert.tool({ name: `t${++n}`, exposed_name: `notion__t${n}`, ...patch });
    expect(() => tool({ risky: 1, read: 1 })).toThrow(CHECK);
    expect(() => tool({ risky: 2, read: 0 })).toThrow(CHECK);
    expect(() => tool({ class_source: "llm" })).toThrow(CHECK);
    expect(() => tool({ class_source: null })).toThrow(/NOT NULL/);
    for (const class_source of ["preset", "annotation", "heuristic"]) tool({ class_source });
    // Held because it changed: the old pin stays served... until the candidate is accepted.
    tool({ state: "held", held_reason: "changed", candidate_definition: "{}", candidate_hash: "c".repeat(64) });
    // Held because it's new: nothing pinned yet.
    tool({ state: "held", held_reason: "new", definition: null, pin_hash: null, candidate_definition: "{}", candidate_hash: "c".repeat(64) });
    expect(() => tool({ state: "held", held_reason: "new", candidate_definition: "{}", candidate_hash: "c" })).toThrow(CHECK); // new, yet pinned
    expect(() => tool({ state: "held", held_reason: "changed" })).toThrow(CHECK); // no candidate
    expect(() => tool({ state: "held", held_reason: null, candidate_definition: "{}", candidate_hash: "c" })).toThrow(CHECK);
    expect(() => tool({ state: "held", held_reason: "renamed", candidate_definition: "{}", candidate_hash: "c" })).toThrow(CHECK);
    expect(() => tool({ state: "active", held_reason: "changed" })).toThrow(CHECK);
    expect(() => tool({ state: "active", candidate_definition: "{}", candidate_hash: "c" })).toThrow(CHECK);
    expect(() => tool({ state: "active", definition: null, pin_hash: null })).toThrow(CHECK);
    expect(() => tool({ pin_hash: null })).toThrow(CHECK);
    expect(() => tool({ state: "paused" })).toThrow(CHECK);
  });

  it("grant levels are full | ask | read, one grant per agent and connection", () => {
    insert.connection();
    insert.agent("agt_2");
    insert.agent("agt_3");
    insert.grant("full");
    insert.grant("ask", "agt_2");
    insert.grant("read", "agt_3");
    expect(() => insert.grant("ask")).toThrow(UNIQUE);
    db.run("DELETE FROM connection_grants WHERE agent_id = 'agt_3'");
    for (const level of ["none", "write", "", "ASK"]) expect(() => insert.grant(level, "agt_3"), level).toThrow(CHECK);
    expect(() => insert.grant("ask", "agt_nope")).toThrow(/FOREIGN KEY/);
    expect(() => insert.grant("ask", "agt_3", "con_nope")).toThrow(/FOREIGN KEY/);
  });

  it("allow rules: a target needs both path and value, and the same rule can't be added twice", () => {
    insert.connection();
    insert.rule("rul_1");
    expect(() => insert.rule("rul_2")).toThrow(UNIQUE); // same tool, no target
    insert.rule("rul_3", "/page_id", '"p1"');
    insert.rule("rul_4", "/page_id", '"p2"');
    expect(() => insert.rule("rul_5", "/page_id", '"p1"')).toThrow(UNIQUE);
    expect(() => insert.rule("rul_6", "/page_id", null)).toThrow(CHECK);
    expect(() => insert.rule("rul_7", null, '"p1"')).toThrow(CHECK);
  });

  it("approvals: mail and calendar kinds still need an account and a draft id; mcp.call needs a connection and its call, nothing else", () => {
    insert.account();
    insert.connection();
    const google = (patch: Record<string, string | null>) => {
      const row = { id: "apr_g", agent_id: "agt_1", account_id: "acc_1", connection_id: null, kind: "send", draft_id: "r-1", payload: "{}", tool_call: null, created_at: T, expires_at: LATER, ...patch };
      const cols = Object.keys(row);
      db.run(`INSERT INTO approvals (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...Object.values(row));
    };
    google({ id: "apr_mail" });
    google({ id: "apr_cal", kind: "calendar.create", draft_id: "" });
    expect(() => google({ account_id: null })).toThrow(CHECK);
    expect(() => google({ draft_id: null })).toThrow(CHECK);
    expect(() => google({ connection_id: "con_1" })).toThrow(CHECK);
    expect(() => google({ tool_call: "{}" })).toThrow(CHECK);
    insert.mcpApproval("apr_mcp");
    expect(() => insert.mcpApproval("apr_x", { connection_id: null })).toThrow(CHECK);
    expect(() => insert.mcpApproval("apr_x", { tool_call: null })).toThrow(CHECK);
    expect(() => insert.mcpApproval("apr_x", { account_id: "acc_1" })).toThrow(CHECK);
    expect(() => insert.mcpApproval("apr_x", { draft_id: "" })).toThrow(CHECK);
    expect(() => insert.mcpApproval("apr_x", { connection_id: "con_nope" })).toThrow(/FOREIGN KEY/);
    expect(db.get("SELECT status FROM approvals WHERE id = 'apr_mcp'")).toEqual({ status: "pending" });
  });
});
