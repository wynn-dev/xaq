# MCP broker: plan

Status: **decided; building.** Written and decided 2026-10-16. Every decision is recorded below; the
[question list](#decisions-on-the-questions-wynn-2026-10-16-go) has the answers. Research sources are linked inline. The
code map refers to main at e2fe0c5.

## Goal

agentinbox grows from a Gmail/Calendar broker into an **MCP broker**:

- **One endpoint per agent.** It unifies all of that agent's MCP servers.
- **Pre-made integrations**, starting with **Notion** and **WHOOP**. Gmail and Calendar stay as the built-in native
  integration. *(2026-10: pre-made integrations are now extensions, [EXTENSIONS.md](EXTENSIONS.md). WHOOP is a code
  extension, so the native WHOOP described below has left core.)*
- **The broker holds every upstream credential.** Agents never see them.
- **Each agent gets only the tools it's allowed.**
- **Existing machinery is reused:** the audit log, signed webhooks and the listener relay.

Why: today Hermes has 7 separate MCP entries (agentinbox, whoop, brightspace, hearloom, 3× T3). Each has its own auth,
timeouts and re-login dance: 30-day OAuth with no refresh, and a 401 re-auth by hand. None of them share an audit log.

### DECIDED (Wynn, 2026-10-16)

1. **Rename: yes, now. The name is `xaq`** (Wynn owns xaq.sh). The npm names `xaq` and `@xaq` are taken: `xaq` is an
   empty 0.0.0 from 2021. So the package is **`xaq-cli` with the bin `xaq`** (`npx xaq-cli`, then `xaq …`), unless Wynn
   disputes the squatted name. The repo becomes `wynn-dev/xaq`; Adri renames it on GitHub when the code is ready. See
   [Rename](#rename).
2. **A public product for anyone from day one,** not just Wynn and Hermes. Multi-user setup, the integrations' own
   OAuth apps and self-serve setup through the CLI and console are milestone-1 concerns.
3. **WHOOP is a native integration on the WHOOP API.** Anyone connects their own account. It does not go through
   Wynn's whoop.weish.me dashboard.
4. **Hermes dogfoods it.** Once milestone 1 works, Hermes moves its MCPs onto the broker endpoint. Milestone 1
   therefore covers remote HTTP upstreams with OAuth (like the T3 servers) and with bearer tokens.

### Also DECIDED (2026-10-16, via Adri)

5. **No stdio in M1 (question 3).** Every Hermes upstream is remote Streamable HTTP, so stdio upstreams wait for M4.
6. **Keys and data directory (question 7).** Every agent key keeps the `aib_` prefix, including new ones after the
   rename. Existing installs keep `~/.agentinbox`, with no automatic move.

### Hermes's upstreams today (from `~/.hermes/config.yaml` on Wynn's Mac)

| Entry | URL | Auth | In the broker |
|---|---|---|---|
| agentinbox | `https://macbook.tailb10092.ts.net/mcp` | `aib_` bearer | Becomes the broker endpoint itself (native tools) |
| whoop | `https://whoop.weish.me/api/mcp` | static bearer | M1: a generic bearer connection; M2: replaced by the native WHOOP integration |
| brightspace | `http://127.0.0.1:8787/mcp` | static bearer | M1 bearer connection, private-target allow (loopback) |
| hearloom | `http://127.0.0.1:3000/mcp` | static bearer | M1 bearer connection, private-target allow (loopback) |
| t3code-macbook | `http://127.0.0.1:3773` | OAuth | M1 OAuth connection, private-target allow (loopback) |
| forge | `http://100.104.249.49:3773` | OAuth | M1 OAuth connection, private-target allow (Tailscale CGNAT) |
| t3code-worldstream | `100.91.67.127` | OAuth | Retired around 10-19; not migrated |

**The T3 servers' OAuth** (probed read-only on forge, 2026-10-16):
- **Discovery is standard.** A 401 carries `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
- **Resource:** `http://100.104.249.49:3773/mcp`, with scopes `orchestration:read` and `orchestration:operate`.
- **Authorization server:** the same origin, over plain http. It offers DCR at `/oauth/mcp/register`, public clients
  (`token_endpoint_auth_methods_supported: ["none"]`), PKCE S256 and the RFC 9207 `iss` parameter.
- **No refresh:** `grant_types_supported` is only `["authorization_code"]`. T3 issues no refresh tokens, and that's
  the real cause of Hermes's 30-day manual re-auth. No broker can refresh these tokens.

For T3, the broker's job is therefore:
- to warn with dates ("t3 forge expires in 7 days / 1 day");
- to make re-auth one click (Reconnect) with no reconfiguration;
- to keep the expiry from ever surfacing as a 401 in the middle of a task.

Getting T3 to issue refresh tokens is question 10.

**Discovery has to be strict.** `/.well-known/openid-configuration` on the same server answers 200 with the T3 web
app's HTML (an SPA fallback). Discovery must require `application/json`, parse it, and check `issuer`. A 200 alone
proves nothing.

Four of the six that move are on loopback or Tailscale's CGNAT range (100.64.0.0/10), and three speak plain `http`.
So the SSRF guard needs the [private-target allow](#private-targets) below, or M1's Hermes goal can't be reached.

## Architecture

```
agent (Claude Code, Codex, Cursor, Hermes, any MCP client)
   │  one endpoint: POST /mcp, Authorization: Bearer aib_… (per agent, as today)
   ▼
broker ──── policy (grants: full or read) ── audit ── events/webhooks/listen
   │
   ├── native: Gmail, Calendar (unchanged tool names)
   ├── native: WHOOP (WHOOP API v2)
   └── upstream connections (MCP client pool)
         ├── remote Streamable HTTP / legacy HTTP+SSE  (auth: none | static header | OAuth)
         └── local stdio (admin-only, pinned command, env-injected secrets)
```

### Connections (upstreams)

A **connection** is one upstream with its credential. It has:
- a kind: `native_google` (today's accounts), `native_whoop`, `remote_http` or `stdio`;
- an operator-chosen **slug** (`notion`, `t3-forge`, …);
- a status: `active`, `needs_reauth`, `error` or `disabled`;
- a cached, pinned tool catalog.

**Remote HTTP upstreams.** The broker is an MCP client to them, following the spec's authorization rules
([spec auth](https://modelcontextprotocol.io/specification/draft/basic/authorization)):

- **Discovery.**
  - On a 401, read `resource_metadata` from `WWW-Authenticate`. Otherwise fall back to
    `/.well-known/oauth-protected-resource`, per RFC 9728.
  - Then fetch the authorization server's metadata (RFC 8414, with OIDC as a fallback), with an exact issuer check.
  - Refuse an authorization server that doesn't advertise PKCE S256.
- **Client registration, in this order:**
  1. a pre-registered client (a preset ships the client ID, or the user pastes it);
  2. a Client ID Metadata Document, when the install has a public https URL to host it;
  3. Dynamic Client Registration (deprecated in 2026-07-28, but what Notion's hosted MCP offers today);
  4. ask the user.

  Registrations are stored per issuer and never re-registered casually: Notion says re-registering orphans the
  earlier grants ([Notion](https://developers.notion.com/guides/mcp/build-mcp-client.md)).
- **The authorization flow.**
  - PKCE S256, `state` checked by us (the TS SDK doesn't), `iss` checked (RFC 9207).
  - `resource` (RFC 8707) is sent on both the authorize and token requests.
  - `offline_access` is requested whenever the server advertises it.
  - It reuses today's Google machinery: the `oauth_states` table, the popup and `BroadcastChannel` callback page,
    and the direct-vs-paste callback mode. The callback lives on a new path, `/oauth/connections/callback`, so
    Google's registered redirect URI never changes.
- **Tokens.** An SQLite-backed `OAuthClientProvider`, encrypted with the existing AES-GCM `Crypto`. Refresh follows
  today's `TokenManager`: one refresh in flight per connection, and a compare-and-swap on the rotated refresh token,
  which is saved before it's used. On top of that:
  - **Proactive refresh:** at `expires_at` minus max(60 s, 10 % of the lifetime). A background sweep keeps idle
    connections from losing rotating refresh tokens; the SDK only refreshes on a 401.
  - **Reactive refresh:** on a 401, refresh once and retry once. On `invalid_grant` or `invalid_client`, mark
    `needs_reauth`, emit `connection.auth_failed` (mirroring `account.auth_failed`), and stop retrying.
  - **No refresh token, or a hard cap** (Notion's hosted MCP: 8 h access tokens, rotating refresh tokens, a 180-day
    cap and a 30-day idle limit): show "expires in N days" at 7 days and 1 day, and send the same events. Nobody
    finds out from a 401 in the middle of a task.
  - **`insufficient_scope`:** store the union of the scopes, then mark `needs_reauth` with the reason. Widening a
    scope always needs a human.
  - **While a connection needs re-auth:** its tools stay listed, and calls return `isError`: "the owner must
    reconnect *Notion* in agentinbox (Connections → Reconnect)".
- **Static header auth** (bearer or API key): stored encrypted, injected per request, never logged.
- **Transports.** It talks to both protocol generations. The 2026-07-28 revision is stateless: it removed
  `initialize`, `Mcp-Session-Id` and server-initiated requests, and deprecated DCR, sampling, roots and logging
  ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). 2025-era servers keep pooled
  sessions per (connection, credential), and HTTP+SSE is a fallback. Each call has a 60 s timeout, and cancellation
  propagates from the downstream request's abort signal.
- **Outbound fetch is pinned and SSRF-guarded.** It reuses the webhook guard `resolveTarget`, through an undici
  `Agent` whose `lookup` is pinned. It applies to the upstream URL and to every discovered OAuth URL, with redirects
  re-checked hop by hop (CVE-2025-6514 was an `authorization_endpoint` RCE,
  [NVD](https://nvd.nist.gov/vuln/detail/CVE-2025-6514)). Loopback, private and CGNAT hosts are blocked unless a
  connection has a private-target allow (next).

<a id="private-targets"></a>**Private-target allow (admin-only, per connection).** Local and tailnet MCP servers are a
legitimate case, and they're most of Hermes's list. A connection may carry an allow that is:
- **admin-only:** set in the console (password and CSRF) or by the local CLI, never through the agent API or pairing;
- **pinned to the exact `scheme://host:port`** the admin entered. The DNS-pinned IP must still match after every
  resolution. It covers that connection's own upstream URL and its discovered OAuth endpoints, and only when they're on
  that same host. An authorization server elsewhere goes through the normal guard. A redirect to any other private
  target is refused;
- **explicit about ranges:** loopback (`127.0.0.0/8`, `::1`), RFC 1918, CGNAT `100.64.0.0/10` (Tailscale) and ULA
  `fc00::/7`. Link-local and cloud metadata (`169.254.0.0/16`, `fd00:ec2::254`) are never allowed;
- **http on the allowed host only:** plain `http` is accepted for that host, both for the MCP URL and for its own OAuth
  endpoints. On loopback, and on a tailnet (which WireGuard already encrypts), that's acceptable. On public hosts
  https stays mandatory;
- **off by default and visible:** the Add connection dialog offers it only after the probe hits the block. It explains
  that a "connection to a server on this machine or your private network" can reach other services there, and the
  connection row shows a "private network" badge;
- **audited:** granting and revoking the allow are audit entries, and editing the URL clears it.

The webhook allowlist (`Settings.webhookAllowlist`) stays separate: allowing a host for one connection mustn't open
it to webhooks, or the reverse.

**stdio upstreams.** Only the console admin can add one, and the console shows the full command, arguments and
environment keys, untruncated.
- Pinned package versions are required: no `@latest`.
- Spawn uses `shell: false` with a minimal `env` (PATH plus the configured secrets). It never inherits
  `process.env`, which may hold the master key, and `cwd` is outside the data directory.
- Lifecycle: close stdin, wait, SIGTERM, then SIGKILL. The process is restarted with backoff if it dies.
- Changing the command makes it a new connection, which needs a new review.

**Upstream client capabilities in v1:** none. Elicitation, sampling and roots are not declared, so upstreams can't
ask for them. Resources and prompts aren't proxied in v1.

### Tools: namespacing, catalog, tool changes

- **Names.**
  - Upstream tools are exposed as `<slug>__<tool>`, using only `[A-Za-z0-9_-]`.
  - The broker-side name is at most 64 characters, because Claude Code prepends `mcp__<server>__` and drops anything
    over 128 ([Claude Code](https://code.claude.com/docs/en/mcp)).
  - No dots: Copilot CLI rejects them, and agentinbox's own "no dot = tool call" audit query relies on it.
  - The operator chooses the slug; the upstream never does.
  - **Native tools keep their current unprefixed names,** so existing agents, Hermes routes and SKILL.md keep
    working. Slugs that collide with native names or each other are refused.
- **Catalog.** `tools/list` is fetched with pagination when the connection is made, again when the TTL the server
  gives (`ttlMs`) expires, on a timer, and on `list_changed` for 2025-era sessions. It's cached per
  (connection, credential).
- **Definition hashes and tool changes.** Each tool's hash is `sha256(JCS({name, title, description, inputSchema,
  outputSchema, annotations}))`, and the server's `instructions` are hashed separately.
  - **No review gate at setup.** Every tool is stored on connect and is available at once, subject to the
    connection's access level.
  - **No hold on change (changed by the owner on 2026-10-16).** The plan was to pin on connect, then hold a changed or
    new tool and ping the owner until they accepted it. The owner removed that for every integration and generic MCP
    upstream alike. When a tool's description or input schema changes, or a new tool appears, the new definition is
    simply used and the tool keeps working under its name: nothing goes on hold, nobody is pinged, and there's no
    accept or review step. The only trace is one silent audit entry per tool (`connection.tool_changed` with the old
    and new hash and the fields that differ, `connection.tool_added` for a new tool,
    `connection.instructions_changed` for the instructions), visible in the console's audit log. No event, webhook,
    listener message, notice or badge.
  - A changed tool is re-classified from its new definition, so access levels apply exactly as for any tool. A
    schema change that makes a read tool risky takes it off Read only; that's not a hold.
  - Arguments are validated against the current `inputSchema` (ajv) before they're forwarded.
  - On upgrade, tools an older version left on hold are released at startup: the definition that was waiting is
    used, with the same audit entry. The hold columns of `upstream_tools` stay in the schema, unused.
- **Descriptions shown to agents** are cleaned and capped: ANSI escapes, tag characters, zero-width and bidi
  characters are stripped, about 1 KB per tool and 256 characters per parameter. The connection page lists suspicious
  signs as information, never as a gate: `<IMPORTANT>`, "don't tell the user", file paths, other servers' tool names,
  catch-all parameters (`context`, `sidenote`) and base64 blobs.

### Access

One permission model for everything: each agent's access to each Google account and each connection is **Full
access** or **Read only**. No row = no access. Nothing waits for approval.

| Level | Connection tools listed |
|---|---|
| **Full access** (the default for a new connection) | all |
| **Read only** | read tools only; other tools aren't listed or callable |

**Agents:** the connect dialog also asks which agents get the connection, defaulting to all of them. Each agent's
page shows its connections with the same choice plus "no access", so one agent can have a different level. That's
stored as a `connection_grants` row per agent × connection with a `level`. There are no per-tool grant modes. A
Google account grant is the same choice (`grants.level`) plus one extra rule, a recipient allowlist for sends and
calendar guests.

**What counts as risky: irreversible actions only.** Deleting, sending mail or messages, publishing or sharing outside,
and payments. Risky tools are never reads. Classification, in this order:

1. **Pre-made integrations say so themselves.** Each extension's manifest ships a risk map (`risk.tools`: exact tool
   names, each `read`, `write` or `risky`; see [EXTENSIONS.md](EXTENSIONS.md)). The risky ones:
   - Notion: `notion-delete-pages`, `notion-delete-databases`, and anything that shares or publishes outside the
     workspace;
   - Gmail: sending (already native);
   - WHOOP: none, since everything is read;
   - T3 Code: deleting a project or scheduled task, project and environment settings, schedules, and, in the browser
     preview (the user's profile, saved logins), running page JavaScript and uploading local files (see [T3 Code](#t3-code-the-users-own-server-30-days-no-refresh)).
2. **Generic MCP servers with annotations:** `destructiveHint: true` is risky, and `readOnlyHint: true` is a read
   tool.
3. **Generic MCP servers, either way** (the code's single source is `CLASSIFICATION_WORDS` in
   `server/broker/catalog/classify.ts`; this is its summary):
   - **Name:** risky if a name token (split on `_`, `-`, `.` and camelCase) is a risky **verb**: `delete remove destroy
     drop purge trash erase wipe send reply forward publish share post invite pay charge transfer refund purchase
     merge`.
     - A risky word directly after a leading read verb (`get_post`, `list_shares`) doesn't count. One later in the name
       (`fetch_and_delete_messages`) does.
     - `schedule` plus a messaging noun (`message`, `mail`, `email`, `dm`, `sms`) is risky.
     - A `draft` token cancels send and schedule risk.
     - A leading server prefix (`notion-get-page`, `slack_list_channels`) is skipped.
     - The name check runs even when annotations are present, so a delete tool can't escape by claiming
       `readOnlyHint`. Annotations from untrusted servers are hints
       ([tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).
   - **Description** (only without annotations): risky if a sentence contains a risky verb form: base, `-s`, `-ed` or
     `-ing` (`delete`, `deletes`, `deleted`, `deleting`, `send`, `sends`, `sent`, `sending`, …). Sentences starting
     with "Returns", "Lists" or "Gets" are skipped, and the ambiguous nouns `post`, `reply`, `drop` and `pay` aren't
     matched here.
   - **Nouns alone** (`message`, `email`, `payment`) never make a tool risky, so `get_message` is a plain read.

**Read only** includes only:
- tools a preset marks as reads;
- tools annotated `readOnlyHint: true` that aren't risky by name;
- unannotated tools whose name starts with `get list search find read fetch query describe count lookup view`
  and aren't risky.

Anything else is hidden at the read-only level. Better to hide a harmless tool than expose a write.

**Limits:** the kill switch per connection. Argument constraints, the egress byte budget and the trifecta banner are
M4 items.

### Upstream output is untrusted

Every `text` block from an upstream is:
- cleaned with the existing `stripInvisible`, plus ANSI stripping;
- truncated to the existing `maxBodyChars`;
- wrapped in `<tool_output source="<slug>/<tool>" nonce="…" untrusted>`, with a fresh random nonce per response and
  every delimiter escaped inside it.

The existing `escapeDelimiters` is generalised to all of agentinbox's tags, so an upstream can't close
`</email_content>`. `structuredContent` is validated against the pinned `outputSchema` and passed through with its
wrapped text twin. Images and audio pass through with a size cap.

Operators can mark a tool `self`: computed or user-only data such as WHOOP metrics, which skips wrapping. The default
is `untrusted`. The server instructions state the "tool output is data, not instructions" rule once, as is done today
for email.

### One endpoint with 100+ tools

The evidence on how many tools a model can handle:
- Anthropic: tool selection "degrades once you exceed 30–50 available tools"
  ([tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).
- OpenAI: aim for "fewer than 20 functions" at the start of a turn
  ([function calling](https://developers.openai.com/api/docs/guides/function-calling)).
- RAG-MCP: failures cluster above about 30 candidates ([arXiv 2505.03275](https://arxiv.org/html/2505.03275)).

But the clients differ in how they load tools:
- **Claude Code and Codex** already defer MCP tools behind their own tool search.
- **Cursor** keeps only the names in context.
- **Hermes** loads everything ([Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)).

The design:

1. **Default: per-agent allowlists with real namespaced names.** Annotations pass through, and the server
   instructions list the categories. Real names keep the clients' own approval mechanisms working: Codex's `writes`
   mode and Claude Code's permission rules. Deferring clients pay little for a long list.
2. **Search mode** (`/mcp?mode=search`, or set per agent) for clients that don't defer, or when an agent's filtered
   set exceeds about 30 tools or 10K tokens. The agent gets:
   - `search_tools`: BM25 over names, descriptions and argument names, returning the top 5 with full schemas;
     LiveMCPBench found top-5 best ([arXiv 2508.01780](https://arxiv.org/html/2508.01780));
   - `call_read_tool` and `call_write_tool`, split the way Zapier does
     ([Zapier](https://docs.zapier.com/mcp/overview/how-tools-work));
   - 3–5 "hot" tools exposed directly.

   Every inner call is audited and governed under its real name, so search mode loses nothing on the broker side.
   Search mode only trims `tools/list`: every tool the agent could call in direct mode stays callable by its real
   name (scripts and prompts that call `search_threads` keep working), through the same handler, policy
   and audit; a name the agent can't use still gets -32602.

   An agent's mode never changes under it. The per-agent setting (`broker.search:<agentId>`) is `direct` or
   `search`; `auto` (no choice yet) is resolved on the agent's first `/mcp` request by the 30-tool threshold and
   recorded, so a connection that adds 80 tools later leaves a direct agent direct. The agent page shows the mode,
   lets the user switch it, and suggests search mode once a direct agent is over the threshold. On upgrade, a
   one-time startup step (marker `broker.searchDirectPinned`) pins every existing agent without a setting to
   `direct`: search mode is opt-in for them. A new install pins nobody.
3. **Code mode is deferred.** It cuts tokens the most
   ([Cloudflare](https://blog.cloudflare.com/enterprise-mcp/),
   [Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)), but it needs a sandbox and hides each
   inner call from the policy.
4. **Toolset groups are configuration only.** Turning groups on at runtime through `list_changed` breaks Codex, which
   ignores it ([codex#37417](https://github.com/openai/codex/issues/37417)).

### Agents' own auth

The agent-side `aib_` keys stay. Claude Code, Codex, Cursor and Hermes all support static headers for remote MCP
servers ([Claude Code](https://code.claude.com/docs/en/mcp), [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Cursor](https://cursor.com/docs/context/mcp), [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)).
Making agentinbox an OAuth authorization server for agents is deferred. It would bring audience validation,
per-client consent and the confused-deputy rules with it. Upstream tokens never go to agents, and `aib_` keys never go
upstream: the spec forbids token passthrough.

### Events from integrations

The events outbox, webhooks, SSE stream and listener relay are generalised:
- Event types become open-ended under a prefix: `<integration>.<event>` and `connection.auth_failed`, next to today's
  closed mail and calendar enum.
- Events carry `connection_id` where they used to carry `account_id`.
- `canSeeEvent` gains a branch for connection grants.
- A listener stream for an agent without Gmail access must work. Today the stream refuses it with `no_read_grant`.

## Pre-made integrations

**Presets became extensions (2026-10-16, [EXTENSIONS.md](EXTENSIONS.md)).**
- **Where they live:** Notion, T3 Code and Brightspace are remote extensions in
  [wynn-dev/xaq-extensions](https://github.com/wynn-dev/xaq-extensions): a manifest each, with no code. WHOOP becomes
  a code extension. Core keeps only the generic machinery: remote MCP OAuth, a same-origin issuer, user-named
  servers, the private-target allow, expiry and lifetime caps, `user_app` OAuth, and events.
- **How they load:** an installed extension's `xaq-extension.json` becomes an `IntegrationPreset` through
  `presetFromManifest` (`server/extensions/manifest.ts`), so the broker, policy, catalog and console are unchanged.
  `presets()` (`server/integrations/index.ts`) lists the installed extensions, then whatever is still in core, and is
  rebuilt on install, update and remove.
- **Binding:** `connections.preset` holds the extension's name, which binds the connection to the extension.
- **Upgrading needs no new sign-in:** existing Notion, T3 Code and WHOOP connections are bound at startup, and a
  missing extension installs in the background from `server/extensions/bootstrap.json`. Until then, Notion and T3
  Code connections run under core's data snapshot of those two official manifests. The snapshot keeps the same risk
  rules, setup copy and sign-in rules, so Reconnect works. It serves bound connections only and is never offered for
  new ones. Any other bound remote connection runs on the generic rules, and Reconnect waits for the install.
- **Third-party extensions** can make tools stricter than the generic rules, never looser.

The sections below describe each integration's design. Their data (URL, auth, setup copy, risk table) is now the
extension's manifest.

### Notion: proxy the hosted MCP, with a native fallback

| | Hosted MCP (`mcp.notion.com/mcp`) | Archived OSS server + internal token | Native REST tools |
|---|---|---|---|
| User steps | **2**: Connect, then approve and pick a workspace | 4, and only a workspace owner can create the token | 4–5 |
| Access | Everything the user can see in the workspace (the broker filters per tool) | Per page | Per page |
| Credential | 8 h access token, rotating refresh token, reconnect within 180 days and after 30 idle days | Never expires | Never expires (internal token) |
| Tools | About 60, maintained by Notion, markdown output, labelled read/write | 24, raw JSON; officially no longer maintained | Whatever we write |
| Maintenance for us | Refresh logic only | Package deprecated | High: the API changes often |

Sources: [Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp),
[build-mcp-client](https://developers.notion.com/guides/mcp/build-mcp-client.md),
[tools](https://developers.notion.com/guides/mcp/mcp-supported-tools),
[notion-mcp-server](https://github.com/makenotion/notion-mcp-server).

**Recommendation: the hosted MCP through DCR.** It advertises DCR and Client ID Metadata Documents with public
clients (`token_endpoint_auth_methods_supported` includes `none`), so **no install registers an app**. That makes a
public product possible without a shared secret.

**Extension contents** (`extensions/notion/xaq-extension.json`, formerly the core preset):
- the URL;
- slug `notion`;
- read/write classes taken from Notion's own labels;
- risky (asks first at the default level): deleting pages or databases, and sharing or publishing outside the
  workspace;
- a "Reconnect before day 180" warning.

**Fallback,** for people who need per-page access or whose Enterprise workspace blocks MCP clients: a small native
REST tool set on an internal token. It goes later, and only if asked for.

### WHOOP: native, each user's own app

*Superseded (2026-10): WHOOP is now a code extension ([EXTENSIONS.md](EXTENSIONS.md)) that reads the API live, with no
events, polling or webhooks. Core keeps only the generic `user_app` OAuth (`server/broker/upstream/user-app.ts`). This
section records the M2 design.*

The official v2 API ([WHOOP API](https://developer.whoop.com/api/), [OAuth](https://developer.whoop.com/docs/developing/oauth)):
- **Scopes:** `read:recovery|cycles|workout|sleep|profile|body_measurement`, plus `offline` for a refresh token.
- **Tokens:** 1 h access tokens. Refresh tokens rotate and are single-use. Refreshing needs the client secret, and
  there's no PKCE.
- **Rate limit:** 100 requests a minute and 10,000 a day.
- **Webhooks:** `recovery|sleep|workout.updated|deleted`, HMAC-SHA256 signed with the client secret.

**A shared project app can't work** ([app approval](https://developer.whoop.com/docs/developing/app-approval)):
- the client secret is needed for the token exchange, refresh and webhook verification, and can't ship in open source;
- Sandbox caps an app at 10 members;
- an app has one fixed webhook URL;
- redirect URIs must match exactly.

So **each user registers their own app** (within Sandbox's 10 members, no review). The console guides it in 5 steps:
1. open the developer dashboard (deep link);
2. create a team;
3. create an app: the wizard shows the scopes to tick and a copy button for the redirect URI;
4. paste the client ID and secret, which are checked live;
5. Connect and approve.

Webhooks are optional, so no step needs them. An optional webhook step appears only when the internet can reach the
install, and an https public URL alone doesn't prove that. Most self-hosted installs use Tailscale `serve` on an
https `*.ts.net` name, which only the tailnet reaches. `server/broker/reachability.ts` classifies the URL as public,
private or unknown, and never calls a third-party prober:
- **The host:** loopback, private or CGNAT IPs, `localhost`, `.local` and bare names are private.
- **DNS:** only private, CGNAT or loopback answers mean private.
- **`*.ts.net`:** read-only `tailscale serve status --json`, because MagicDNS answers 100.x locally even with Funnel
  on.

The webhook URL is `/hooks/connections/whoop`, the same for the app before the connection exists. The client
secret's signature picks the connection.

On a tailnet-only `*.ts.net` install with the Tailscale CLI, the wizard instead offers an optional, clearly warned
Funnel step for the webhook path only, on a separate Funnel port:
`tailscale funnel --bg --https=8443 --set-path=/hooks/connections http://127.0.0.1:<port>/hooks/connections`.
- **The port:** 10000 when the console uses 8443.
- **Why nothing else is served:** tailscaled serves nothing else on that port, and the daemon also refuses Funnel
  traffic outside `/hooks/connections/` on any host:port but the public URL's.
- **Who runs it:** the daemon never changes the Tailscale config; it only shows the command. Once the command has
  run, the step shows the `https://<host>:8443/hooks/connections/whoop` URL to paste into WHOOP.

There's no 30-day wall: one refresh worker per connection keeps the token alive indefinitely and saves each rotated
refresh token atomically. Wynn's current 30-day re-login most likely comes from his dashboard's own MCP bearer, not
from WHOOP.

**Tools, all reads, so no approvals:**
- `whoop__get_recovery`
- `whoop__get_sleep`
- `whoop__get_cycles`
- `whoop__get_workouts`
- `whoop__get_profile`
- `whoop__get_body`
- `whoop__get_today`: the most useful one; a summary of today's recovery, last night's sleep, strain and HRV

All take date ranges and handle pagination, and output is compact text plus `structuredContent`.

**Events (as designed for M2; the WHOOP extension emits none):** recovery, sleep and workout updates would go through the existing outbox, webhooks and listener.
They come from a poll every 15 minutes, which needs nothing but the OAuth connection.
- **Cost:** about 290 requests a day, under 3% of WHOOP's 10,000.
- **Timeliness:** WHOOP scores a sleep or workout minutes after it ends.

Optional WHOOP webhooks bring events within seconds, with dedupe on `trace_id` and a reconciliation poll:
- **The poll never stops.** A webhook that fails while the install is offline (past WHOOP's hour of retries) is
  found by the next poll.
- **No double announcements.** The poll skips a record a webhook already announced, unless WHOOP updated it after
  the push. That memory isn't persisted, so after a restart the worst case is a few duplicates, never a lost event.

This gives a "morning recovery is in" trigger for Hermes.

One thing to verify at build time: whether WHOOP accepts an `http://localhost` redirect. Guides disagree. The fallback
is an https public URL, or paste mode with `https://localhost`.

### T3 Code: the user's own server, 30 days, no refresh

As built (the `t3code` extension, `extensions/t3code/xaq-extension.json` in xaq-extensions, formerly the core preset
`server/integrations/t3code/`), on the generic MCP OAuth upstream, checked against a live
`t3@nightly 0.1.1-nightly.20261016.3218` on 2026-10-16:

- **OAuth is standard.** Discovery at `/.well-known/oauth-protected-resource[/mcp]` and
  `/.well-known/oauth-authorization-server`; DCR at `/oauth/mcp/register` (public client, `none`; the `client_id` is
  a signed, stateless token, so registering again orphans nothing); PKCE S256; `iss` on the redirect. T3 accepts
  `resource` (its own MCP URL) and refuses any other with `invalid_target`, so no special handling.
- **No refresh token.** `expires_in` is 2,592,000 (30 days). xaq records it as the connection's `expires_at`. The
  manifest's `reconnectPolicy.tokenLifetimeCapDays: 30` caps it: `expires_at` is never later than 30 days after the
  sign-in, and is 30 days out when a server doesn't send `expires_in`.
- **Scopes follow T3's own approval page, not the request.** The page asks for a one-time pairing code and an access
  level: Read only grants `orchestration:read`; Supervised (Limited on older versions) adds `orchestration:operate`;
  Full access adds `settings:write` and `source-control:write`. T3 also refuses project changes unless the client has
  Full access. xaq accepts whatever comes back, stores it (`connection_credentials.scope`), audits it on connect and
  shows it on the connection page. The setup recommends Supervised. The manifest names `settings:write` and
  `source-control:write` as `remote.auth.broadScopes`, and the connection page warns when a sign-in granted any of
  them (core doesn't know T3's scope names).
- **The pairing code** comes from T3 → Settings → Connections, `t3 auth pairing create` on T3's machine, or the
  `Token:` line `t3 serve` prints (also the `#token=` part of its `Pairing URL`). The setup steps say so.
- **One connection per server.** The preset has no URL (`userServer`): the user gives the address, `/mcp` is added to
  a bare origin, the name defaults to `host:port` and the slug to `t3-<host>` (`t3-100-104-249-49`, `t3-forge`).
  Connection names are now unique per owner (case-insensitive) for every connection: a default name gets ` (2)`, a
  chosen one that's taken is a 409.
- **Plain http only on private addresses.** T3 usually runs on http over Tailscale or on loopback. That goes through
  the existing admin-only private-target allow, pinned to `scheme://host:port`, with no new mechanism. The guard
  re-checks every hop, so the MCP URL, the 401's `resource_metadata` URL, the issuer, every endpoint and every
  redirect get http only on that one allowed origin and only when it resolves to loopback, RFC 1918, CGNAT or ULA.
  A hostname that resolves publicly needs https. On top of that, the preset sets `sameOriginIssuer`: the issuer, the
  authorization, token and registration endpoints and the resource must all be on the server's own origin, so the
  page that takes the pairing code is never on another host, even an https one.
- **Expiry.** Generic, and T3 is its first user. `connection.expiring` is emitted at 7 days and 1 day, with a
  `reconnectUrl` to the connection's console page. Past `expires_at`, or after a 401 with no refresh token, the
  connection is Expired: status `needs_reauth`, `expires_at` moved to then, `expired: true` in the view, and
  `connection.auth_failed` with `expired: true`. The policy refuses calls to it even before the sweep runs, so the
  agent gets "The T3 Code connection '<name>' expired; ask your user to reconnect it in xaq at <link>", never a
  401. Reconnect runs a new sign-in on the same connection and keeps its name, slug, agents and levels.
- **Risk table.** The manifest's `risk.tools` covers all 83 tools (carried over exactly from the core preset's
  `tools.ts`):
  - **Reads (free):** projects, threads, queues, environment, worktrees, schedules, pull requests, devices.
  - **Normal writes:** thread launch, send, interrupt and the rest of a thread's life; creating, cloning and handing
    off to worktrees; pull-request bookkeeping; opening, navigating, clicking and typing in previews; devices. T3
    marks almost all of these `destructiveHint`, so without the table the annotation rule would ask before nearly
    everything.
  - **Risky:** deleting a project or scheduled task, project and environment settings, schedules (persistent
    unattended turns, webhook URLs), `preview_evaluate` (JavaScript in a page, returning up to 64 KB) and
    `preview_upload` (local files to a web page).

  **Decision: T3 access is close to acting as the user on that machine.** A launched thread runs whatever T3's
  access level allows (commands and file edits, up to Full access), and the owner decided thread launch is a normal
  write. T3's browser preview runs in the user's own browser profile on T3's machine, with its saved logins (by
  default), so preview tools browse websites as the user. We keep the other `preview_*` actions as normal writes on
  the same reasoning: the T3 access level is the real limit, and asking before every click would make the preview
  unusable. Only the two that move data out as the user ask: `preview_evaluate` (arbitrary JavaScript in a signed-in
  page, whose result comes back to the agent) and `preview_upload`. The setup step and the connection page say
  plainly that previews use the browser profile and its saved logins.

  `t3_thread_send`, `t3_thread_send_attachments` and `t3_thread_merge_back` are exempt from the name check by exact
  name (`nameCheckExempt`), because their `send`/`merge` stays inside T3. Unknown tools fall back to the generic
  rules: T3's annotations, then the verb list, which catches a future `t3_thread_delete` or `t3_worktree_remove`.
- **Contract additions (additive, optional):** `IntegrationPreset.userServer`, `IntegrationPreset.nameCheckExempt`
  and `CredentialStore.markNeedsReauth(…, { expired })`. With the move to extensions, these were added too:
  `reconnectPolicy.tokenLifetimeCapDays` and `PresetAuth` `mcp_oauth.broadScopes`.

## Setup UX (no external docs)

The bar: the CLI wizard and console guide every step end to end, with deep links and copy buttons.

- **First run, with Google optional (recommended).** The current wizard requires Google Cloud before anything else.
  A public broker needs a first step that asks what to connect: Notion, WHOOP, a custom MCP server, or Gmail and
  Calendar (which take today's eight-step Google path). Someone who only wants Notion and WHOOP is done in a few
  minutes.
- **Add connection** (console, Connections page):
  - **Presets** (Notion, WHOOP, Google) run their own guided flows.
  - **Custom:** paste a URL. The broker probes it and shows what it found ("OAuth via auth.example.com, supports
    automatic registration", or "needs an API key"), then shows the right button or field. stdio: an admin form with
    a command preview and the version-pinning check.
  - Then **one choice**: full access (preselected) or read only, plus which agents get it.
    Done. There's no tool review step.
- **Import from a client config, for Hermes dogfooding and migrations.**
  - `npx agentinbox-cli import --from hermes` (also `claude-code`, `cursor`, `codex`) reads that client's MCP config.
    For Hermes that's `~/.hermes/config.yaml` `mcp_servers`.
  - It creates one connection per server, moving the credentials into the broker. OAuth ones get a "Reconnect"
    button, because their tokens live in the client.
  - Then `setup-mcp --tool hermes` replaces the separate entries with the single broker entry, keeping a backup.
  - A dry run comes first and prints exactly what will change.
- **CLI.** `npx agentinbox-cli connections add notion|whoop|<url>` runs interactively in the terminal: it opens the
  browser for OAuth (or uses paste mode over SSH) and asks the one access question. `connections list|reconnect|disable`.
  Writing the broker's database needs the admin, so the CLI talks to the local daemon's admin API with a one-time
  local token. **As built (server/connections-cli/admin.ts):** whoever can write the data directory already holds
  `master.key` and the database (`reset-password` relies on the same thing). So the CLI inserts a one-time
  `admin_sessions` row, of which only sha256(token) is stored. The row has a 15-minute hard limit: its `created_at` is
  set so that the sliding refresh can never extend it. The CLI sends that token as the session cookie, plus the CSRF
  header, to the daemon's own `/api` on loopback, and deletes the row when the command exits. Nothing new listens,
  and no token file sits on disk. The daemon's `requireAdmin`, audit and rate limits apply unchanged. Paste mode POSTs
  the address the browser landed on to `/api/connections/finish`.
- **Every failure names its fix in the UI:** `needs_reauth` → Reconnect, an expiring cap → a dated reminder, a 429 →
  retry-after, an SSRF block → "allow this host in Settings".

## Existing gateways: what to borrow, what to avoid

Teardown from primary sources (READMEs, docs, source), as of 2026-10-16.

| Project | Naming | Upstream credentials | Per-client scoping | Policy / human in the loop | Large tool lists |
|---|---|---|---|---|---|
| [Docker mcp-gateway](https://github.com/docker/mcp-gateway) | Unprefixed with collision checks (case-folded, reserved names); prefix opt-in | Keychain or credential helper; background OAuth refresh with retries | Profiles with `server.tool` allowlists | `before:exec` interceptor | `mcp-find`/`mcp-add` (agents add servers to themselves), code mode |
| [IBM ContextForge](https://github.com/IBM/mcp-context-forge) | `{gateway}-{tool}` | OAuth code and client-credentials flows, encrypted at rest, RFC 8707 `resource` with an omit switch | Virtual servers, teams, RBAC | 40+ plugins; no approval plugin | Lookup cache only |
| [MetaMCP](https://github.com/metatool-ai/metamcp) | `server__tool` | Bearer, or an OAuth sessions table | Namespaces mapped to endpoints, overrides | Middleware | None |
| [1mcp](https://github.com/1mcp-app/agent) | `server_1mcp_tool` | OAuth dashboard | Tags and presets (tags double as scopes) | None | Lazy `tool_list`/`tool_schema`/`tool_invoke` |
| [agentgateway](https://agentgateway.dev/docs/standalone/latest/documentation/mcp/spec-compatibility/) | `target_tool` | Backend auth, token exchange (RFC 8693) | CEL rules on tool name and claims; denied tools filtered from lists | ExtMCP pass, mutate or deny | None; translates between protocol versions |
| [ToolHive vMCP](https://github.com/stacklok/toolhive) | Conflict strategies | Token exchange, encrypted secrets | Filtering, description overrides | Elicitation steps in workflows | `find_tool`/`call_tool` over SQLite FTS5 (session-bound, so clients fall back to the 2025 protocol) |
| [Obot](https://github.com/obot-platform/obot) | Composite servers | OAuth on the user's behalf | Catalog access policies | Filter webhooks (HMAC-signed) that reject or mutate | Catalog search |
| [MCPJungle](https://github.com/mcpjungle/MCPJungle) | `server__tool` | No upstream OAuth | Deny-by-default client allowlist, tool groups | None | Tool groups |
| [Lasso](https://github.com/lasso-security/mcp-gateway) | Two meta-tools only | Env passthrough | None | Secret and PII masking; description scan at load only | Meta-tools |
| [TBXark mcp-proxy](https://github.com/TBXark/mcp-proxy) | Per-server path | Auth-code OAuth with refresh; persists the registered client ID | Allow/block filters | None | None |

Also reviewed: Microsoft mcp-gateway (Kubernetes and Entra only), Agent Router (formerly Envoy AI Gateway), Unla,
sparfenyuk mcp-proxy. mcp-router reached end of life on 2026-09-18.

**Borrowed:**
- `server__tool` naming with Docker's collision checks, re-run on every reload;
- deny by default, with ungranted tools removed from `tools/list` **and** enforced on every call path, including
  search mode (Docker treats a bypass as a vulnerability);
- FTS5-backed search meta-tools that stay stateless and grant-scoped (ToolHive's session-bound version forces clients
  back to the 2025 protocol);
- an encrypted OAuth store that **persists the registered client ID** (TBXark: losing it makes every refresh fail
  silently), refreshes in the background with backoff, and lets `resource` be omitted per connection;
- denials returned as `isError` tool results;
- the SSRF guard on upstream URLs;
- secret scanning of arguments and results on by default, and logging the shape of the arguments rather than their
  values for reads (Docker);
- debounced `list_changed` handling.

**Avoided:**
- enterprise sprawl (ContextForge needs Postgres and Redis; Microsoft's gateway needs Kubernetes);
- **agents adding servers to themselves** (Docker's `mcp-add`): only the human adds connections;
- forwarding the agent's own `Authorization` header upstream;
- approvals that depend on client elicitation (60 s timeouts, and MRTR changes the mechanism);
- REST-to-MCP conversion, LLM routing and A2A, which are out of scope;
- depending on single-maintainer or end-of-life projects.

**Gaps none of them fill, which agentinbox's existing strengths cover:**
- durable human approvals with exact arguments;
- signed webhooks for tool calls and approval decisions;
- relaying upstream domain events to agents through the listener;
- argument-level grants without an external policy server;
- tool-definition pinning with re-review on drift (no longer a goal: the owner removed the hold on 2026-10-16; a
  change is only audited, see "Tools: namespacing, catalog, tool changes").

That last one isn't documented by any project reviewed (the teardown's code search was cut short by a rate limit, so
treat it as "not documented" rather than proven absent).

**Hosted platforms** (Composio, Pipedream Connect, Klavis Strata, Smithery, Cloudflare MCP Portals, Zapier, Arcade,
Merge) all converge on the same patterns:
- credentials held by the platform and keyed by a user;
- an auth failure answered with **a connect URL inside the tool result** (Pipedream, Smithery, Klavis, Zapier);
- per-session or per-agent allowlists;
- search-first meta-tools for large catalogs.

**Borrowed:**
- the connect-URL-in-`isError` pattern;
- Zapier's read/write split of the execute tools;
- Klavis's progressive discovery (the top-5-with-schemas variant);
- Cloudflare's per-portal tool curation and URL-selected mode.

**Avoided:**
- approvals that depend on client elicitation (Composio's needs clients that support it, and Hermes declines URL-mode
  elicitation);
- runtime toolset enablement through `list_changed`;
- one shared hosted OAuth app (impossible here for WHOOP; unnecessary for Notion).

Only Composio documents per-call human approval, so agentinbox's approvals with exact arguments are a real
differentiator.

Sources: [Composio](https://docs.composio.dev/kb/guide/mcp-tool-router-sessions),
[Pipedream](https://pipedream.com/docs/connect/mcp/developers), [Klavis](https://www.klavis.ai/docs/concepts/strata),
[Smithery](https://smithery.ai/docs/use/connect), [Cloudflare](https://developers.cloudflare.com/changelog/post/2025-08-26-mcp-server-portals/),
[Zapier](https://docs.zapier.com/mcp/overview/how-tools-work), [Arcade](https://docs.arcade.dev/en/guides/mcp-gateways),
[Merge](https://docs.merge.dev/merge-agent-handler/how-it-works).

## Security model

Detection can't be relied on. In MCPTox, tool poisoning succeeded 36.5 % of the time on average across 20 model
setups, and no model refused more than 3 % of attacks ([arXiv 2508.14925](https://arxiv.org/abs/2508.14925)). So the
controls are enforced in code, on the action side, as agentinbox already does for mail
([OWASP LLM06](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)).

| Threat | Real example | Mitigation | When |
|---|---|---|---|
| Injection flowing across tools (untrusted output driving a write elsewhere) | GitHub MCP toxic flow ([Invariant](https://invariantlabs.ai/blog/mcp-github-vulnerability)); WhatsApp JSON breakout | Nonce-wrapped untrusted output; provenance flags; trifecta banner; writes and egress to approval by default | v1 |
| | | Session taint: after untrusted output, egress calls escalate to approval for N minutes (CaMeL-style; [arXiv 2503.18813](https://arxiv.org/abs/2503.18813), [design patterns](https://arxiv.org/abs/2506.08837)) | later |
| Tool poisoning and rug pulls | `<IMPORTANT>` `add` tool reading `~/.ssh` ([Invariant](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks)); [line jumping](https://blog.trailofbits.com/2025/04/21/jumping-the-line-how-mcp-servers-can-attack-you-before-you-ever-use-them/); postmark-mcp 1.0.16 BCC'ing all mail ([BleepingComputer](https://www.bleepingcomputer.com/news/security/unofficial-postmark-mcp-npm-silently-stole-users-emails/)) | Definition hashes audited on every change (no hold, owner's decision of 2026-10-16), cleaned descriptions, informational signals, pinned stdio versions | v1 |
| Cross-server shadowing | A description rewriting another server's `send_email` | Operator-chosen slugs, collision checks, flagging descriptions that name other servers' tools, per-agent grants | v1 |
| Token exfiltration and confused deputy | Token passthrough and SSRF ([MCP security](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)); CVE-2025-6514 | No passthrough; encrypted per-connection credentials; scrubbing of exact token strings and `Bearer …` from results and errors; one pinned, guarded fetch; https only for authorization URLs, except on a connection's own admin-allowed private host | v1 |
| stdio as a code-execution surface | Spec "local MCP server compromise" | Admin-only; full command shown; pinned versions; `shell: false`; minimal env; no `process.env` inheritance | v1 |
| | | bubblewrap or `systemd-run` sandbox, network namespace | later |
| Approval bypass | Arguments hidden past a scrollbar; "always allow" fatigue; lying annotations | Exact-bytes approvals with hash re-check; the name check applies even with annotations; "always allow" scoped to agent, tool and optionally target; caps on risky calls | v1 |
| | | Egress byte budget, near-duplicate egress detection | later |
| Incident response | Postmark victims couldn't tell what was sent | Audit per call: agent, connection, tool, pinned hash, decision, args hash and size, result size, signals, duration. Full arguments kept only for writes and egress, with secrets redacted. One-click kill per connection (disable, cancel pending, kill the process, RFC 7009 revoke, delete the credential). An incident view per connection and time window | v1 |
| | | Hash-chained audit rows | later |

**Out of scope, stated plainly in the docs:** a malicious upstream can still misuse data **inside its own service**,
as postmark-mcp did, and a stdio server's own network access can't be controlled without a sandbox. The broker limits
what reaches an upstream, and who can call it. It doesn't vouch for the upstream.

## Code impact (from the code map)

**Reused as is:**
- the stateless per-request `buildMcpServer` with its `register()` audit and error wrapper;
- `auditRejections`, `AuditLog`, `Crypto`;
- the OAuth pieces: PKCE, `oauth_states`, the callback page and `callbackMode`;
- the token refresh pattern: single-flight with compare-and-swap, `needs_reauth`;
- the `Approvals` state machine;
- the events outbox with webhooks, SSE and the listener;
- `resolveTarget`;
- `stripInvisible`, `wrapUntrusted`, `truncateText`;
- the console's OAuth popup host and dialog-host patterns.

**Forced refactors (each one a milestone item):**
1. A `connections` table, with Google as a native kind. The `accounts` table stays and is linked to it.
2. `connection_grants` (agent × connection, level) and `approval_rules` beside the native `grants`, plus a
   `decideTool()` in policy.
3. Rebuilding the approvals table: `account_id` and `draft_id` become nullable, and a generic payload is added.
4. Opening the closed enums: `TOOL_NAMES`, `EVENT_TYPES`, `ApprovalKind`, `UntrustedTag`, `describeError`.
5. An upstream client runtime: the SDK client pool, stdio supervision, the catalog cache and the pinned fetch.

**SDK:** agentinbox pins `@modelcontextprotocol/sdk ^1.32`. The 2026-07-28 version negotiation (`versionNegotiation:
'auto'`) and the gateway guide are documented for the v2 `@modelcontextprotocol/client` package
([protocol versions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md),
[gateway](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/advanced/gateway.md)). Milestone 1
starts with a one-day spike to decide whether to move to v2.

**Risks to existing users:**
- native tool names and SKILL.md must not change;
- the "no dot = tool call" queries (Overview counts, `anyAgentVerified`, send caps) must keep working;
- the migrations must keep pending approvals and cascades;
- the `/oauth/callback` path and Google's redirect URI must not change;
- the `/mcp` body limits stay as they are.

## Milestones

Each milestone is one merge train: tier L (two reviewers plus a security review) where it touches auth, credentials,
grants or migrations. It ships as a nightly and is done when every item under "Done when" holds.

### M0: Rename (as soon as the name is final)

**Scope:** see [Rename](#rename). It goes first so that every later migration and doc uses the final name.

**Done when:**
- the new package publishes nightlies;
- an existing install (Wynn's: nightly, 2 accounts, Pub/Sub, a Hermes listener) upgrades with one command and loses no
  mail;
- the old `agentinbox-cli` prints the move and keeps working;
- the repo, README, console and CLI all carry the new name.

### M1: Broker core (smallest useful)

**Scope:**
- the SDK spike;
- the `connections` model;
- remote HTTP upstreams (Streamable HTTP in both generations, plus SSE) with auth none, static header or OAuth
  (pre-registered, DCR, or a metadata document), proactive refresh and `needs_reauth`;
- the pinned SSRF-guarded fetch;
- the catalog with definition hashes (a changed or new tool is used at once and audited; the hold was removed on 2026-10-16);
- `<slug>__<tool>` namespacing;
- connection grants with the three levels and risk classification;
- `mcp.call` approvals: pending returned at once, `get_call_status`, exact arguments, "always allow" rules, the
  one-tap approve page;
- untrusted output wrapping and token scrubbing;
- the audit fields;
- the one-click kill;
- `connection.auth_failed` events and a listener stream for agents without Gmail;
- console: Connections, Add connection (custom URL plus the **Notion preset**) with the one access choice, the
  approval card with "always allow", the one-tap approve page, the allow-rule list, and
  first run with Google optional;
- CLI: `connections add|list|reconnect|disable` and `import --from hermes|claude-code|cursor|codex`;
- docs and SKILL.md.

No stdio in M1 (decision 5): every Hermes upstream is remote HTTP. The **private-target allow** is in M1, because
four of Hermes's six upstreams are on loopback or Tailscale.

**Done when:**
1. An E2E test against fake upstream MCP servers covers:
   - OAuth with DCR and refresh rotation;
   - a 401 refresh followed by `needs_reauth`;
   - a bearer server;
   - a 2025 session server and a 2026 stateless server;
   - a changed or new tool that keeps working, with one audit entry and no ping (was: held, pinged, accepted);
   - the three levels, risk classification and an approval forwarding the exact bytes;
   - "always allow" not asking twice;
   - pending returned at once;
   - an SSRF block;
   - native Gmail and Calendar tools unchanged.
2. Notion connects through the preset on a real workspace. An agent reads and edits without being asked, and a delete
   asks through the one-tap page.
3. Hermes on Wynn's install has **one** MCP entry, the broker. It serves agentinbox's native tools plus brightspace,
   hearloom, t3code-macbook and forge through the private-target allow, and whoop as a generic bearer connection
   until M2. t3code-worldstream is retired and isn't migrated.
4. One fresh-persona walk passes: a new user with Notion only, no Google.

**M1 merge train**, in order. Each PR is off the latest main and runs behind a `brokerUpstreams` setting, off by default,
until PR 8, so existing users see nothing half-built:

| # | PR | Tier |
|---|---|---|
| 1 | SDK spike, written up as a short ADR: stay on v1.32 or move to the v2 client, decided by a 2025 session server and a 2026 stateless server in the fake | M |
| 2 | Schema (migration 8): `connections`, `connection_credentials`, `upstream_tools` (pins), `connection_grants`, `approval_rules`; rebuild `approvals` with nullable `account_id`/`draft_id` and a generic payload; `owner_id` columns. Existing data is untouched, and there's an upgrade test from main's DB | L |
| 3 | Upstream runtime: the pinned, guarded fetch with the private-target allow, the client pool (both protocol generations plus SSE), timeouts and cancellation, strict discovery, static-header auth | L |
| 4 | OAuth to upstreams: an SQLite `OAuthClientProvider` (pre-registered, DCR, client ID metadata document), PKCE, `state` and `iss` checks, `resource`, proactive and reactive refresh, `needs_reauth` and expiry warnings, `connection.auth_failed`, the `/oauth/connections/callback` route | L, plus a security review |
| 5 | Catalog and pinning: list with TTL, hashing, an audit entry on a changed or new tool (the hold, `connection.tool_changed` event and accept step were removed on 2026-10-16), cleaned descriptions, informational signals, namespacing and collision checks | L |
| 6 | Policy and approvals: the levels, risk classification (presets, annotations, the word list), `decideTool`, caps, `mcp.call` with pending at once and exact bytes, `get_call_status`, `approval_rules` (always allow), output wrapping, token scrubbing, the audit fields, the kill switch | L, plus a security review |
| 7 | MCP endpoint aggregation: upstream tools on `/mcp` next to the unchanged native ones, the instructions, a listener stream without Gmail, the events | L |
| 8 | Console: Connections, Add connection (custom URL plus the Notion preset) with the one access choice, agent access levels, the approval card with "always allow", the one-tap `/approve/<id>` page, the allow-rule list, the private-target allow UX, first run with Google optional. The feature flag is removed here | L (approvals) |
| 9 | CLI: `connections add/list/reconnect/disable` and `import --from hermes/claude-code/cursor/codex`, with a dry run | M |
| 10 | E2E (done-when #1), docs, SKILL.md; then the Notion check and the Hermes migration on Wynn's install; then the persona walk | M |

### M2: WHOOP native

*Superseded (2026-10): see the WHOOP section above; the native integration was removed when WHOOP became a code
extension.*

**Scope:** the guided per-user app setup, the WHOOP tools, the refresh worker, webhooks or polling, and the
`whoop.*` events.

**Done when:**
- an E2E test against a fake WHOOP covers OAuth, refresh rotation, the webhook signature, polling and the events;
- a real WHOOP account connects and `whoop__get_today` returns data;
- a listener receives the integration's events;
- one persona walk of WHOOP setup passes;
- Hermes's old `whoop` entry is removed.

### M3: Search mode for big toolsets

**Scope:** `?mode=search` and the per-agent setting: `search_tools` (top 5 with schemas), `call_read_tool` and
`call_write_tool`, hot tools, auditing under real names, and an automatic suggestion above about 30 tools.

**Done when:**
- an eval on a 100-tool fake catalog picks the right tool at least as often as listing every tool;
- Hermes runs in search mode with every tool reachable;
- approvals still hold for calls made through `call_write_tool`.

### M4: Hardening and the rest (each item ships alone)

- session taint (egress escalates to approval after untrusted reads);
- stdio upstreams (admin-only, pinned versions, minimal env), with a bubblewrap or `systemd-run` sandbox;
- near-duplicate egress detection;
- hash-chained audit rows;
- resources and prompts passthrough;
- URL-mode elicitation shown as approval cards;
- the native Notion REST fallback;
- Gmail/Calendar grants moved to the same three-level model;
- argument constraints, an egress byte budget and the lethal-trifecta warning;
- more presets (GitHub, Linear, Slack: only proxies of their hosted MCPs, no native code);
- multi-user (see question 1).

## Rename

Planned now and executed when the name is final. `<new>` is `xaq`: the package `xaq-cli`, the bin `xaq`, the repo `wynn-dev/xaq`, and the data directory
`~/.xaq` for new installs.

- **npm:** publish `<new>` (or `<new>-cli` if the bare name is taken; check it first) with a `bin` of `<new>`. Keep
  the `agentinbox` bin as an alias for a release cycle.
- **The old package:** publish one last `agentinbox-cli` major, a shim that depends on `<new>`, prints "agentinbox is
  now <new>: run `npx <new> …`", then runs it. Then `npm deprecate agentinbox-cli` with the same message. The nightly
  workflow moves to the new package, which needs a trusted publisher registered for it.
- **The repo:** GitHub rename `wynn-dev/agentinbox` → `wynn-dev/<new>`. Old URLs redirect; update the badges and
  links.
- **The data directory (DECIDED):** new installs use `~/.<new>`. If `~/.<new>` doesn't exist and `~/.agentinbox` does,
  keep using `~/.agentinbox` and say so once. There's no automatic move: it would put `master.key` at risk.
- **Environment variables:** read `<NEW>_*` first, then `AGENTINBOX_*` (MASTER_KEY, DATA, GOOGLE_* bases).
- **Agent keys (DECIDED):** every key keeps the `aib_` prefix, existing and new.
- **Services:** `service install` on the new name detects the old launchd label (`com.unlaboredlabs.agentinbox*`) or
  systemd unit, boots it out (waiting for it to unload, as #48 does), installs the new one, and rolls back on failure.
  The listener profiles move the same way. This is the one place where a rename can cost mail, so it needs an E2E
  test and a walk on a real Mac.
- **Agent configs:** `setup-mcp` already rewrites the entries. The server name stays `agentinbox` for existing configs
  unless the user re-runs setup; Hermes routes confined with `mcp-agentinbox` keep working. The skill and server
  instructions use the new name.
- **Console and docs:** branding, page titles, the setup-token page, README and SKILL.md.

## Decisions on the questions (Wynn, 2026-10-16: GO)

All questions are decided. Building proceeds M0 → M1 → M2 → M3.

1. **Multi-user:** each person self-hosts their own: a single owner per install, with many agents. The schema
   carries `owner_id` from M1, so real multi-user can come in M4 without a rewrite.
2. **No hosted piece run by the project.** Notion uses automatic registration, and WHOOP uses each user's own app.
3. **No stdio in M1** (decision 5): every Hermes upstream is remote HTTP.
4. **Google optional on first run:** yes, the recommendation. Adri's relay grouped "Q4" with approvals, but in this list Q4 is the Google question; tell the lead if that was meant otherwise.
5. **Access** ([Access](#access)): one choice per connection, full access or read only (approvals and the "ask"
   level were removed on 2026-10-31); risky means irreversible only; no review gate at setup, and no hold on a
   change: a changed tool keeps working and is only audited.
7. **Keys and data directory** (decision 6): `aib_` for every key; `~/.agentinbox` kept, with no automatic move.
8. **Search mode:** on automatically for a new agent with more than about 30 tools when it first connects. Real
   names are kept below that, and for agents that existed before search mode. The mode then changes only when the
   user changes it.
9. **Order:** M2 WHOOP, then M3 search mode. If Hermes has more than about 50 tools after M1, M3 comes first.
10. **T3 refresh tokens:** dated warnings and one-click Reconnect in M1, and a request to T3 Code to add the
    `refresh_token` grant.
