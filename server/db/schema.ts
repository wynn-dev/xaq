// Ordered migrations. Append only — never edit a shipped migration.
// Conventions: ids are prefixed TEXT, timestamps are ISO-8601 TEXT (UTC), JSON is TEXT,
// booleans are INTEGER 0/1, secrets are AES-GCM ciphertext TEXT (see server/crypto.ts).

export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  );

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    last_error TEXT,
    refresh_token_enc TEXT NOT NULL,
    access_token_enc TEXT,
    access_expires_at TEXT,
    scopes TEXT NOT NULL DEFAULT '[]',
    history_id TEXT,
    watch_expires_at TEXT,
    last_sync_at TEXT,
    created_at TEXT NOT NULL
  );

  -- Pending OAuth flows (state → PKCE verifier). Short-lived.
  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    reauth_account_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    disabled INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE grants (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    capabilities TEXT NOT NULL,           -- JSON Capability[]
    label_scope TEXT,                     -- JSON string[] | NULL (= whole mailbox)
    send_mode TEXT NOT NULL DEFAULT 'draft_only',
    allow_to TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
    reply_only INTEGER NOT NULL DEFAULT 0,
    max_sends_per_hour INTEGER,
    max_sends_per_day INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (agent_id, account_id)
  );

  -- Agent event-feed cursor for the MCP pull tools (list_events / wait_for_events / ack_events).
  CREATE TABLE agent_cursors (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    acked_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    account_id TEXT NOT NULL,
    gmail_message_id TEXT,
    gmail_thread_id TEXT,
    label_ids TEXT NOT NULL DEFAULT '[]',  -- JSON: message labels at event time (used for scope + filters)
    message TEXT,                          -- JSON MessageSummary | NULL
    changed_label_ids TEXT,                -- JSON string[] for label.added/removed
    detail TEXT,                           -- JSON
    dedupe_key TEXT NOT NULL UNIQUE,       -- e.g. "acc_x:msgid:message.received" — Pub/Sub is at-least-once
    created_at TEXT NOT NULL
  );
  CREATE INDEX events_account_seq ON events(account_id, seq);
  CREATE INDEX events_thread ON events(account_id, gmail_thread_id);
  CREATE INDEX events_created ON events(created_at);

  -- Threads the account has sent into; drives thread.reply_received.
  CREATE TABLE sent_threads (
    account_id TEXT NOT NULL,
    gmail_thread_id TEXT NOT NULL,
    last_sent_at TEXT NOT NULL,
    PRIMARY KEY (account_id, gmail_thread_id)
  );

  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    secret_prefix TEXT NOT NULL,
    event_types TEXT NOT NULL,   -- JSON EventType[]
    filter TEXT NOT NULL DEFAULT '{}', -- JSON WebhookFilter
    include_body INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_seq INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_status_code INTEGER,
    last_error TEXT,
    last_response TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (webhook_id, event_seq)
  );
  CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
  CREATE INDEX deliveries_webhook ON deliveries(webhook_id, created_at);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    draft_id TEXT NOT NULL,
    payload TEXT NOT NULL,       -- JSON {to,cc,bcc,subject,body,threadId,attachments,reason}
    decided_at TEXT,
    decision_note TEXT,
    sent_message_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX approvals_status ON approvals(status, created_at);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    account_id TEXT,
    target TEXT,
    outcome TEXT NOT NULL,
    reason TEXT,
    duration_ms INTEGER,
    detail TEXT
  );
  CREATE INDEX audit_ts ON audit_log(ts);
  CREATE INDEX audit_actor ON audit_log(actor_id, ts);
  `,

  /* 2: device-flow pairing + listener cursors */ `
  CREATE TABLE pairings (
    id TEXT PRIMARY KEY,
    device_code_hash TEXT NOT NULL UNIQUE, -- sha256 of the CLI's polling secret
    user_code TEXT NOT NULL,               -- shown in the terminal and the console, e.g. "K7QM-2XPD"
    name TEXT NOT NULL,
    description TEXT,
    requested TEXT NOT NULL DEFAULT '{}',  -- JSON
    client TEXT NOT NULL DEFAULT '{}',     -- JSON
    ip TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    api_key_enc TEXT,                      -- set on approval, wiped once delivered to the CLI
    last_poll_at TEXT,
    decided_at TEXT,
    decision_note TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX pairings_status ON pairings(status, created_at);
  CREATE INDEX pairings_user_code ON pairings(user_code);

  -- Server-side cursor per agentinbox-listen consumer (MCP ack_events keeps using agent_cursors).
  CREATE TABLE listener_cursors (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    consumer TEXT NOT NULL,
    acked_seq INTEGER NOT NULL DEFAULT 0,
    client TEXT NOT NULL DEFAULT '{}',
    connected INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, consumer)
  );
  `,
  /* 3: onboarding diagnostics on accounts */ `
  -- When Google said the refresh token expires (refresh_token_expires_in); NULL = long-lived.
  ALTER TABLE accounts ADD COLUMN refresh_expires_at TEXT;
  -- Why it expires: 'testing' (initial lifetime ~7 days: External app in Testing) or 'time_based'
  -- (any other lifetime, e.g. time-based access the user chose on the consent screen). NULL = unknown.
  ALTER TABLE accounts ADD COLUMN refresh_expiry_kind TEXT;
  -- id_token "hd" claim: Workspace domain, '' = personal (non-Workspace) Google account, NULL = not known (connected before this migration).
  ALTER TABLE accounts ADD COLUMN workspace_domain TEXT;
  `,
  /* 4: where each listener consumer started */ `
  -- Seq the consumer's cursor started at when it was created (the head, or 0 for start=beginning):
  -- mail at or below it predates the listener (what \`listen --backfill\` replays). NULL = created
  -- before this migration, or by an ack (unknown).
  ALTER TABLE listener_cursors ADD COLUMN start_seq INTEGER;
  `,
  /* 5: MCP use apart from listen; how each agent was added */ `
  -- Last authenticated request to /mcp; throttled like last_used_at (first write immediate).
  ALTER TABLE agents ADD COLUMN last_mcp_at TEXT;
  -- 'paired' (approved from \`agentinbox connect\`: the key lives in a profile on that machine) or
  -- 'key' (created in the console, key copied by hand).
  ALTER TABLE agents ADD COLUMN origin TEXT NOT NULL DEFAULT 'key';
  -- Backfill: a kept approved pairing, or a listener (\`listen\` runs on a pairing's profile), means paired.
  UPDATE agents SET origin = 'paired'
    WHERE id IN (SELECT agent_id FROM pairings WHERE status = 'approved' AND agent_id IS NOT NULL)
       OR id IN (SELECT agent_id FROM listener_cursors);
  `,
  /* 6: keep existing installs verified */ `
  -- SetupState.verified now needs a successful tool call in the audit log (pruned after the retention
  -- period) or a listener ack, and is remembered in setup.verifiedAt once seen. Installs where an agent
  -- already reached /mcp counted as verified before: remember that, so the setup guide doesn't come back.
  INSERT OR IGNORE INTO settings (key, value)
    SELECT 'setup.verifiedAt', json_quote(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE EXISTS (SELECT 1 FROM agents WHERE last_mcp_at IS NOT NULL);
  `,
  /* 7: Google Calendar (docs/calendar.md). Additive only: mail keeps working untouched. */ `
  -- Grants: calendar.read / calendar.write live in grants.capabilities; existing grants have neither (mail-only).
  ALTER TABLE grants ADD COLUMN calendar_scope TEXT;   -- JSON string[] of calendar ids | NULL (= every calendar)
  ALTER TABLE grants ADD COLUMN calendar_write_mode TEXT NOT NULL DEFAULT 'approval'; -- 'direct' | 'approval'

  -- Accounts: granted scopes are already in accounts.scopes (JSON, since migration 1).
  -- NULL = derive from scopes (missing calendar scopes → not_granted, else active); 'api_disabled' | 'error'
  -- when a probe or sync said so (cleared by the next success).
  ALTER TABLE accounts ADD COLUMN calendar_status TEXT;
  ALTER TABLE accounts ADD COLUMN calendar_error TEXT;
  ALTER TABLE accounts ADD COLUMN calendar_synced_at TEXT;

  -- Events: calendar.* events carry a CalendarEventSummary instead of a message.
  ALTER TABLE events ADD COLUMN calendar_id TEXT;       -- for calendar scopes and filters
  ALTER TABLE events ADD COLUMN calendar_event TEXT;    -- JSON CalendarEventSummary | NULL

  -- Incremental sync cursor (and optional push channel) per synced calendar.
  CREATE TABLE calendar_sync (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    calendar_id TEXT NOT NULL,
    name TEXT,
    access_role TEXT,
    is_primary INTEGER NOT NULL DEFAULT 0,
    sync_token TEXT,                 -- events.list nextSyncToken; NULL = needs a (baseline) full sync
    baseline_at TEXT,                -- when the last full sync finished: events created before it aren't "new"
    last_sync_at TEXT,
    last_error TEXT,
    channel_id TEXT,                 -- events.watch channel (push), NULL when polling only
    channel_resource_id TEXT,
    channel_token_hash TEXT,         -- sha256 of the X-Goog-Channel-Token we chose
    channel_expires_at TEXT,
    channel_verified_at TEXT,        -- Google's "sync" notification reached us (the address is reachable)
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, calendar_id)
  );
  CREATE UNIQUE INDEX calendar_sync_channel ON calendar_sync(channel_id) WHERE channel_id IS NOT NULL;

  -- Last seen version of events on synced calendars, to tell created / updated (what changed) / cancelled
  -- apart and to replay a 410 full resync as changes. Upcoming and recurring events only (pruned after end).
  CREATE TABLE calendar_event_state (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    calendar_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,       -- digest of the material fields (CalendarEventChange)
    summary TEXT NOT NULL,           -- JSON CalendarEventSummary as last seen
    description_hash TEXT,
    ends_at TEXT,                    -- NULL for recurring series (kept while the series lives)
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, calendar_id, event_id)
  );
  CREATE INDEX calendar_event_state_ends ON calendar_event_state(ends_at);

  -- Calendar approvals reuse the approvals table: kind 'calendar.*', draft_id '' (no Gmail draft),
  -- payload JSON {calendar: CalendarApprovalDetail, reason, …}, sent_message_id = the Google event id once applied.

  -- Existing installs (an account was connected before this upgrade) add Calendar explicitly with the
  -- console's "Add Google Calendar" flow; fresh installs get it by default (no row = enabled).
  INSERT OR IGNORE INTO settings (key, value)
    SELECT 'calendar.setup', '{"enabled":false}'
    WHERE EXISTS (SELECT 1 FROM accounts);
  `,
  /* 8: MCP broker (docs/MCP-BROKER.md, M1 PR 2). New tables, events.connection_id and the approvals rebuild; nothing reads them yet. */ `
  -- One upstream with its credential. Gmail/Calendar stay in accounts (M1 doesn't move them).
  CREATE TABLE connections (
    id TEXT PRIMARY KEY,                       -- con_…
    owner_id TEXT,                             -- NULL = the install's single owner (real multi-user is M4)
    -- remote_http in M1. native_whoop (M2) and stdio (M4) are reserved, and native_google too (Gmail/Calendar
    -- as a connection kind, docs "Code impact"): CHECKs can't be widened without rebuilding a table that
    -- other tables reference.
    kind TEXT NOT NULL CHECK (kind IN ('remote_http', 'native_whoop', 'stdio', 'native_google')),
    -- The preset id (notion, whoop, …) or NULL for a custom server. Deliberately no CHECK: presets are validated
    -- in code against the registry, so adding one never needs a rebuild of this table.
    preset TEXT,
    -- Operator-chosen; tools are exposed as <slug>__<tool>. No "_" in a slug, so the split is unambiguous.
    slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 24 AND slug NOT GLOB '*[^a-z0-9-]*'),
    name TEXT NOT NULL,
    url TEXT,                                  -- the MCP endpoint; required for remote_http
    auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none', 'header', 'oauth')),
    -- What agents may do by default (Wynn's model): full | ask (risky tools wait for approval) | read.
    level_default TEXT NOT NULL DEFAULT 'ask' CHECK (level_default IN ('full', 'ask', 'read')),
    -- Admin-only private-target allow: the exact scheme://host:port the admin entered, or NULL (off).
    -- Editing the URL clears it.
    -- (No path, query, userinfo, blanks, backslash, percent-encoding, brackets or control characters; ends in
    -- the port.) The code canonicalises it, and the guard itself validates host and ranges.
    private_target TEXT CHECK (private_target IS NULL OR (
      (private_target GLOB 'http://?*:[0-9]*' OR private_target GLOB 'https://?*:[0-9]*')
      AND private_target NOT GLOB '*://*[/?#@ ]*' AND private_target NOT GLOB '*[^0-9]'
      AND private_target NOT GLOB '*[\\%[]*'
      AND private_target NOT GLOB '*[' || char(1) || '-' || char(31) || char(127) || ']*'
    )),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_reauth', 'error', 'disabled')),
    status_reason TEXT,
    -- When the credential stops working without a human (no refresh grant, or a hard cap such as Notion's
    -- 180 days): drives the "expires in N days" warnings. NULL = not known to expire.
    expires_at TEXT,
    -- Negotiated protocol era and transport, cached (see the SDK ADR), and when it was last negotiated: the
    -- cache expires from protocol_checked_at (the expiry is the code's).
    protocol TEXT,
    protocol_checked_at TEXT,
    tools_cached_at TEXT,                      -- last successful tools/list
    instructions_hash TEXT,                    -- sha256 of the server's instructions, pinned separately from tools
    events_cursor TEXT,                        -- native presets: where the event poll resumes (e.g. WHOOP without a webhook URL)
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (kind <> 'remote_http' OR url IS NOT NULL)
  );

  -- The connection's secrets, one row per connection. *_enc columns are AES-GCM ciphertext (server/crypto.ts)
  -- and are never logged or sent to the console or agents.
  CREATE TABLE connection_credentials (
    connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
    -- auth_type 'header': the static header injected on every request (e.g. Authorization: Bearer …).
    header_name_enc TEXT,
    header_value_enc TEXT,
    -- auth_type 'oauth'. The issuer is the authorization server's exact issuer (checked on every flow). The
    -- client is the registration (pre-registered, metadata document or DCR): JSON {client_id, client_secret?, …}.
    oauth_issuer_enc TEXT,
    oauth_client_enc TEXT,
    access_token_enc TEXT,
    refresh_token_enc TEXT,                    -- rotated with a compare-and-swap, saved before it's used
    expires_at TEXT,                           -- access token expiry
    scope TEXT,                                -- granted scopes, space-separated (the union after insufficient_scope)
    -- An authorization in flight (cleared when it completes): the PKCE verifier and the discovery result
    -- (JSON: resource metadata, authorization server metadata, resource, redirect URI).
    pkce_verifier_enc TEXT,
    discovery_enc TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Each upstream tool as pinned. Agents only ever see the pinned definition. A changed hash or a tool that
  -- wasn't there at connect is held until the owner accepts the candidate.
  CREATE TABLE upstream_tools (
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                        -- the upstream's own name
    -- <slug>__<name> as listed to agents: [A-Za-z0-9_-], at most 64 (clients prepend mcp__<server>__).
    exposed_name TEXT NOT NULL UNIQUE CHECK (length(exposed_name) BETWEEN 1 AND 64 AND exposed_name NOT GLOB '*[^A-Za-z0-9_-]*'),
    -- JSON {title, description, inputSchema, outputSchema, annotations}; NULL only for a held new tool.
    definition TEXT,
    pin_hash TEXT,                             -- sha256(JCS({name, title, description, inputSchema, outputSchema, annotations}))
    -- Risk classes (risky = irreversible; read = listed at the read-only level) and where they came from.
    risky INTEGER NOT NULL DEFAULT 0 CHECK (risky IN (0, 1)),
    read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
    class_source TEXT NOT NULL CHECK (class_source IN ('preset', 'annotation', 'heuristic')),
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'held')),
    held_reason TEXT CHECK (held_reason IS NULL OR held_reason IN ('changed', 'new')),
    candidate_definition TEXT,                 -- JSON, same shape as definition: what accepting would pin
    candidate_hash TEXT,
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (connection_id, name),
    CHECK (risky = 0 OR read = 0),
    CHECK ((definition IS NULL) = (pin_hash IS NULL)),
    CHECK ((candidate_definition IS NULL) = (candidate_hash IS NULL)),
    -- IS, not =: a NULL comparison would make the CHECK pass.
    CHECK (
      (state = 'active' AND held_reason IS NULL AND candidate_hash IS NULL AND pin_hash IS NOT NULL)
      OR (state = 'held' AND held_reason IS 'changed' AND candidate_hash IS NOT NULL AND pin_hash IS NOT NULL)
      OR (state = 'held' AND held_reason IS 'new' AND candidate_hash IS NOT NULL AND pin_hash IS NULL)
    )
  );

  -- Per agent × connection access. No row = no access. There are no per-tool grant modes.
  CREATE TABLE connection_grants (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    level TEXT NOT NULL CHECK (level IN ('full', 'ask', 'read')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, connection_id)
  );
  CREATE INDEX connection_grants_connection ON connection_grants(connection_id);

  -- "Always allow this": a matching call by this agent never asks again. Optionally only for one target:
  -- an argument (JSON Pointer into the arguments) and its canonical JSON value.
  CREATE TABLE approval_rules (
    id TEXT PRIMARY KEY,                       -- rul_…
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,                        -- upstream tool name (upstream_tools.name), stable across slug edits
    target_path TEXT,
    target_value TEXT,
    created_at TEXT NOT NULL,
    CHECK ((target_path IS NULL) = (target_value IS NULL))
  );
  CREATE UNIQUE INDEX approval_rules_match ON approval_rules(agent_id, connection_id, tool, COALESCE(target_path, ''), COALESCE(target_value, ''));
  CREATE INDEX approval_rules_connection ON approval_rules(connection_id);

  -- Approvals, rebuilt: SQLite can't drop NOT NULL. account_id and draft_id become nullable (an mcp.call
  -- has neither), connection_id and tool_call are added. Same ids, rowids (list order), indexes and
  -- cascades; nothing references approvals, so dropping it cascades nowhere.
  -- tool_call (mcp.call only): JSON {tool, exposedName, args (the exact canonical bytes, as a string),
  -- argsSha256, pinHash, result (once executed)}.
  CREATE TABLE approvals_new (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    draft_id TEXT,
    payload TEXT NOT NULL,       -- JSON {to,cc,bcc,subject,body,threadId,attachments,reason,…}
    tool_call TEXT,
    decided_at TEXT,
    decision_note TEXT,
    sent_message_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    -- Mail and calendar kinds keep exactly the invariant they had (an account and a draft id, '' for
    -- calendar); only mcp.call goes through a connection.
    CHECK (
      (kind = 'mcp.call' AND account_id IS NULL AND draft_id IS NULL AND connection_id IS NOT NULL AND tool_call IS NOT NULL)
      OR (kind <> 'mcp.call' AND account_id IS NOT NULL AND draft_id IS NOT NULL AND connection_id IS NULL AND tool_call IS NULL)
    )
  );
  INSERT INTO approvals_new (rowid, id, agent_id, account_id, kind, status, draft_id, payload, decided_at, decision_note, sent_message_id, error, created_at, expires_at)
    SELECT rowid, id, agent_id, account_id, kind, status, draft_id, payload, decided_at, decision_note, sent_message_id, error, created_at, expires_at
    FROM approvals ORDER BY rowid;
  DROP TABLE approvals;
  ALTER TABLE approvals_new RENAME TO approvals;
  CREATE INDEX approvals_status ON approvals(status, created_at);
  CREATE INDEX approvals_connection ON approvals(connection_id);

  -- Events from connections (connection.auth_failed, connection.tool_changed, approval.requested, whoop.*) carry
  -- their connection here. account_id stays NOT NULL: connection events store '' there. Additive, no rebuild.
  ALTER TABLE events ADD COLUMN connection_id TEXT;
  CREATE INDEX events_connection_seq ON events(connection_id, seq) WHERE connection_id IS NOT NULL;
  `,
  /* 9: broker upstream OAuth (M1 PRs 3/4). Additive columns only. */ `
  -- When the stored access token was issued: proactive refresh runs at expires_at - max(60 s, 10 % of the lifetime).
  ALTER TABLE connection_credentials ADD COLUMN issued_at TEXT;
  -- An upstream connection's authorization in flight (/oauth/connections/callback): state -> connection. NULL for
  -- Google's flow. code_verifier is '' for these rows: the verifier is kept encrypted, keyed by state, in
  -- connection_credentials.pkce_verifier_enc.
  ALTER TABLE oauth_states ADD COLUMN connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE;
  `,
  /* 10: broker "All agents" (new-user walk). Additive. */ `
  -- 1: every agent gets this connection at level_default, including agents created later (console, pairing).
  -- NULL: only the agents picked (connection_grants). Per-agent levels still live in connection_grants.
  ALTER TABLE connections ADD COLUMN all_agents INTEGER CHECK (all_agents IS NULL OR all_agents = 1);
  `,
  /* 11: extensions (docs/EXTENSIONS.md). Additive: a new table. */ `
  -- One row per installed extension: what it was installed from and exactly what was installed. Its files are in
  -- <dataDir>/extensions/<name>/<first 16 hex of the integrity digest>/, read-only (server/extensions/store.ts).
  -- source: a registry name, a GitHub or other repository URL, or an absolute directory. commit_sha: the resolved
  -- commit (NULL for a directory). integrity: sha256-<base64> over the canonical listing (server/extensions/integrity.ts).
  -- manifest: xaq-extension.json as installed. official: from wynn-dev/xaq-extensions at the indexed or pinned commit.
  CREATE TABLE extensions (
    name TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 32),
    kind TEXT NOT NULL CHECK (kind IN ('remote', 'code')),
    version TEXT NOT NULL,
    source TEXT NOT NULL,
    commit_sha TEXT CHECK (commit_sha IS NULL OR length(commit_sha) = 40),
    integrity TEXT NOT NULL,
    manifest TEXT NOT NULL,
    official INTEGER NOT NULL CHECK (official IN (0, 1)),
    installed_at TEXT NOT NULL
  );
  `,
  /* 12: code extensions with a Google account (docs/EXTENSIONS.md "Google accounts for code extensions"). Additive. */ `
  -- The connected Google account a connection of an extension with "code.auth": { "type": "google" } works as, picked
  -- in its setup. Its tokens stay the account's (accounts.refresh_token_enc): the connection only gets downscoped
  -- access tokens. NULL for every other connection, and once the account is removed from xaq (it then needs setup).
  ALTER TABLE connections ADD COLUMN google_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;
  `,
  /* 13: one permission model (full or read, plus the recipient allowlist); no approvals. */ `
  -- Grants: any write capability (draft, send, organize, trash, calendar.write) becomes full, the rest read.
  -- The recipient allowlist (allow_to) stays; label and calendar scopes, send modes, reply-only and send caps go.
  ALTER TABLE grants ADD COLUMN level TEXT NOT NULL DEFAULT 'read' CHECK (level IN ('full', 'read'));
  UPDATE grants SET level = 'full'
    WHERE EXISTS (SELECT 1 FROM json_each(grants.capabilities) WHERE value IN ('draft', 'send', 'organize', 'trash', 'calendar.write'));
  ALTER TABLE grants DROP COLUMN capabilities;
  ALTER TABLE grants DROP COLUMN label_scope;
  ALTER TABLE grants DROP COLUMN send_mode;
  ALTER TABLE grants DROP COLUMN reply_only;
  ALTER TABLE grants DROP COLUMN max_sends_per_hour;
  ALTER TABLE grants DROP COLUMN max_sends_per_day;
  ALTER TABLE grants DROP COLUMN calendar_scope;
  ALTER TABLE grants DROP COLUMN calendar_write_mode;

  -- Connection levels: ask becomes full. A column's own CHECK goes with it, so swap the columns.
  ALTER TABLE connection_grants RENAME COLUMN level TO level_old;
  ALTER TABLE connection_grants ADD COLUMN level TEXT NOT NULL DEFAULT 'full' CHECK (level IN ('full', 'read'));
  UPDATE connection_grants SET level = CASE level_old WHEN 'read' THEN 'read' ELSE 'full' END;
  ALTER TABLE connection_grants DROP COLUMN level_old;
  ALTER TABLE connections RENAME COLUMN level_default TO level_default_old;
  ALTER TABLE connections ADD COLUMN level_default TEXT NOT NULL DEFAULT 'full' CHECK (level_default IN ('full', 'read'));
  UPDATE connections SET level_default = CASE level_default_old WHEN 'read' THEN 'read' ELSE 'full' END;
  ALTER TABLE connections DROP COLUMN level_default_old;

  DROP TABLE approvals;
  DROP TABLE approval_rules;
  DELETE FROM events WHERE type = 'approval.requested';
  DELETE FROM settings WHERE key = 'broker.policy';
  UPDATE settings SET value = json_remove(value, '$.approvalTtlHours') WHERE key = 'settings' AND json_valid(value);
  `,
];
