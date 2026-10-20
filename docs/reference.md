# xaq reference

Everything here is optional reading: `npx xaq-cli` and the console it links to cover setup. This page is for
running xaq in production, scripting it, and understanding what it does.

- [Features](#features)
- [Commands and configuration](#commands-and-configuration)
- [Google Cloud setup in brief](#google-cloud-setup-in-brief)
- [Connecting agents by hand](#connecting-agents-by-hand)
- [Events and webhooks](#events-and-webhooks)
- [Running it](#running-it): [as a service](#as-a-service), [with your own supervisor](#with-your-own-supervisor),
  [on a remote server](#on-a-remote-server), [behind a reverse proxy](#behind-a-reverse-proxy)
- [Security model](#security-model)
- [Data and backups](#data-and-backups)
- [Release channel](#release-channel)
- [Development](#development)

## Features

- **One place for credentials.** Connect Gmail and Google Workspace accounts once. Refresh tokens are encrypted at rest.
  Agents only ever see an `aib_…` key.
- **MCP for every agent.** Streamable HTTP at `/mcp`: `search_threads`, `get_thread`, `reply`, `send_message`,
  `modify_labels`, `wait_for_events` and more. Each agent sees only the tools its grants allow. Drafts, replies, forwards
  and new messages can carry files: bytes the agent has, a file from a directory you allow on xaq's machine, another
  message's attachment, or a Google Drive file (see [Attachments](#attachments)).
- **Real-time delivery.** New mail, replies to threads you sent into, and label changes arrive within seconds through
  Gmail push via a Pub/Sub *pull* subscription (no public URL needed), or within the poll interval (30 seconds by
  default) by polling with zero extra setup.
  [`xaq listen`](listen.md) wakes agents on a laptop behind NAT. Google Calendar invitations and changes arrive
  the same way (polled every 60 seconds by default) for agents with `calendar.read`.
- **Webhooks.** Filter by account, label, sender, recipient, subject, attachments or calendar. Payloads are signed per
  [Standard Webhooks](https://www.standardwebhooks.com), retried with backoff, logged, and replayable.
- **Guardrails that don't degrade content.** Per agent and mailbox: capabilities, label scope, send mode (direct,
  draft-only or human approval), recipient allowlists, reply-only and send caps. Email content is cleaned, not censored.
- **A web console.** Guided Google setup, connect snippets for Claude Code, Codex, Cursor and Hermes, an approvals inbox,
  live events, delivery logs and the audit trail.
- **A ready-made agent skill.** `SKILL.md` teaches agents to use the tools well and to treat email as data.

## Connections (MCP broker)

Besides Gmail and Calendar, xaq brokers other MCP servers. Each agent still has one endpoint (`/mcp`) and one
key; the broker holds every upstream credential and lists only the tools the agent is allowed. Design and decisions:
[MCP-BROKER.md](MCP-BROKER.md).

- **Add one**: in the console, Connections → Add connection (it offers the official extensions that aren't installed
  yet, with an Install button); or on the daemon's machine, `npx xaq-cli ext add notion` first, then
  `npx xaq-cli connections add notion` (or `connections add <url>` for any MCP server). Pre-made connections are
  **extensions** from
  [wynn-dev/xaq-extensions](https://github.com/wynn-dev/xaq-extensions) ([EXTENSIONS.md](EXTENSIONS.md)): Notion
  (its hosted MCP, two clicks), T3 Code (below), Brightspace (your own
  [Brightspace MCP server](https://github.com/wynn-dev/brightspace-mcp-server): its address and its bearer token;
  every tool reads) and WHOOP (a code extension: install it with `npx xaq-cli ext add whoop` or from Extensions in
  the console, then add it the same way; the console walks you through your own WHOOP developer app, no public URL
  is needed, and agents read live from the WHOOP API). Connections made before extensions keep working as they are:
  xaq binds them to their extension at startup and installs a missing one in the background, with no new sign-in.
  Until it's installed, Notion and T3 Code connections keep the same rules and can still reconnect (core keeps a
  copy of those two extensions' manifests for them); a WHOOP connection reads "Needs the whoop extension".
  - **Optional webhooks:** a preset whose provider sends webhooks offers them only when the internet can reach this
    install; on a tailnet-only install (Tailscale `serve` on a `*.ts.net` name) it offers an optional Tailscale Funnel
    command that exposes only the webhook path, on its own port. No built-in preset uses webhooks today.

  - **T3 Code**: one connection per T3 server. Give the address you open T3 at (`http://100.x.y.z:3773` on
    Tailscale, `http://127.0.0.1:3773` locally; xaq adds `/mcp`), allow that exact address (plain http is accepted
    only on loopback, private, Tailscale CGNAT and unique-local addresses), then approve on T3's own page with a
    one-time pairing code: T3 → Settings → Connections, `t3 auth pairing create` on T3's machine, or the Token line
    `t3 serve` prints. Pick the least T3 access your agents need: Read only, or Supervised (Limited on older T3); Full
    access also lets agents add and change projects, T3's settings and source control. The connection shows the
    scopes T3 granted, and warns when they include Full access's `settings:write` or `source-control:write`. Names default to the server's `host:port` (editable; names are unique), slugs to
    `t3-<host>`. T3's sign-in lasts 30 days and can't be refreshed: xaq warns 7 days and 1 day before
    (`connection.expiring`, with a Reconnect link), and once it expires agents get "The T3 Code connection '<name>'
    expired; ask your user to reconnect it in xaq at <link>" instead of a failure. Reconnect takes a new pairing code
    and keeps the name, agents and access levels. Asks before (at "Ask before risky actions"): deleting a project or
    scheduled task, project and environment settings, schedules, and running JavaScript in or uploading local files
    to a page in T3's browser preview; starting, messaging and stopping threads go straight through. T3's browser
    preview runs in your browser profile on T3's machine, with its saved logins: an agent that can use it browses
    websites as you.

  Any other server: paste its URL; xaq finds out whether it needs an OAuth
  sign-in or an API key. Servers on this machine or your private network (loopback, Tailscale) need an explicit
  "allow this host" for that exact address.
- **Expiring sign-ins**: a server that issues no refresh token (T3) or caps the sign-in (Notion, 180 days) shows
  "Expires in N days" from 7 days before, and `connection.expiring` events go to webhooks and listeners at 7 days and
  1 day, with `reconnectUrl`. Past it the connection is Expired (`expired: true`; status `needs_reauth`), as it is
  after a 401 when there's no refresh token; agents are told to ask you to reconnect, with the link.
- **One choice per connection**: Full access, Ask before risky actions (default), or Read only, for all agents or
  chosen ones; each agent's page can change it. Risky means irreversible: deleting, sending, publishing or sharing
  outside, payments. Everything else goes straight through.
- **Approvals**: a risky call returns `pending_approval` at once with a link to a one-tap approve page; the agent
  checks back with `get_call_status`. "Always allow this" (for that agent and tool, optionally only that target)
  means it never asks twice; the rules are listed on the agent's page.
- **Tool changes**: if a server later changes or adds a tool, agents simply use the new definition under the same
  name: nothing is held and nothing asks you. Access levels, approvals and "always allow" rules apply as usual (a
  change that makes a tool risky makes it ask). The audit log records each change (`connection.tool_changed`, with
  the old and new definition hash).
- **Tool names**: `<connection>__<tool>`, e.g. `notion__notion-search`. To change a connection's short name: the
  connection's page → Change short name, or `npx xaq-cli connections rename <name> --slug <new> [--name <display
  name>]`. The exposed tool names follow at once and approval rules carry over, but anything that calls the old
  `<old>__<tool>` names stops working until it uses the new ones.
- **Prompts and resources**: `/mcp` also passes each connection's prompts and resources through, in both tool-list
  modes. Prompts are `<connection>__<prompt>`. Resources are `xaq://<connection>/<the original URI, percent-encoded>`,
  named `<connection>__<name>`; resource templates work the same way. They count as reads: an agent sees them with
  any access level on the connection. Each `prompts/get` and `resources/read` is in the audit log (actions
  `prompts/get` and `resources/read`), and the connection's secrets are scrubbed from what comes back.
- **Extensions**: pre-built connections are extensions ([EXTENSIONS.md](EXTENSIONS.md)). A *remote* extension is a
  proxied MCP server. A *code* extension (WHOOP) is a Node file that xaq runs as a child process, one per connection,
  under Node's permission model: it can read only its own install and its own state directory, can write only that
  state directory, can't start processes, workers or native addons, and gets an empty environment except four
  `XAQ_EXT_*` values (and `TZ`, `LANG`). It never sees xaq's database, `master.key`, other connections, the client
  secret or the refresh token: it asks xaq for this connection's access token. The network is **not** restricted,
  which is why extensions from outside the official registry come with a warning. A crash restarts it with backoff;
  five crashes in a row mark the connection Error with its last output (secrets redacted). Code extensions need Node
  ≥ 22.23.2, ≥ 24.18.1 or ≥ 26.5.1 (older releases have permission-model bypasses); on an older Node the connection
  says so and nothing runs, while xaq itself and remote extensions work from 22.13.
- **Search mode**: the tool list shows only `search_tools`, `call_read_tool`, `call_write_tool` and `get_call_status`;
  the agent finds the rest by searching. Calling a tool by its name still works, with the same access, approvals and
  audit. A new agent gets search mode if it has more than about 30 tools the first time it connects. After that its
  mode changes only when you change it (agent page → Tool list), never because a connection added tools. Agents
  created before search mode keep every tool listed. Any agent can ask for it with `/mcp?mode=search`.
- **Import**: `npx xaq-cli import --from hermes|claude-code|cursor|codex [--dry-run]` moves a client's remote
  MCP servers into connections and replaces them with the single xaq entry, after a backup. Entries that don't
  work yet (an OAuth sign-in to finish, a rejected key) stay in the client until they do.
- **Turn it off**: Settings → Connections (MCP broker).

## Extensions

Integrations come as extensions ([EXTENSIONS.md](EXTENSIONS.md)): a manifest-only `remote` one (Notion, T3 Code) or
a `code` one with a bundled MCP server that xaq runs out of process (WHOOP). Official extensions come from
[wynn-dev/xaq-extensions](https://github.com/wynn-dev/xaq-extensions); its `index.json` pins each to a commit and an
integrity hash, and xaq installs exactly that.

```
xaq ext add <name | github-url | git-url[#ref[:path]] | ./dir> [--yes] [--data …]
xaq ext list [--data …]
xaq ext update <name> [--yes] [--data …]
xaq ext remove <name> [--force] [--yes] [--data …]
```

- **Sources**: a registry name (`notion`); a GitHub URL (`https://github.com/<owner>/<repo>[/tree/<ref>/<path>]`,
  fetched as the tarball of the resolved commit); any other `https://` or ssh git URL, through the `git` CLI (`#<ref>`,
  `#<ref>:<path>`; `http://`, `git://` and URLs with credentials in them are refused); or a directory on xaq's
  machine, for development (the CLI resolves `./dir` and `~/dir` where you run it; the console and the API take an
  absolute path). git runs without your git config or environment, and without hooks. GitHub refs are resolved through its
  API without signing in (60 requests an hour per address; xaq says when that's used up).
- **Third-party**: anything that isn't the official registry at the indexed commit. Before it's installed you see
  its source, its kind, its declared network hosts and, for a `code` one, that it runs on your machine with network
  access; the CLI needs a yes (or `--yes`), the console a click on "I trust it: install". A third-party extension
  can't use an official extension's name (`notion`, `t3code`, `whoop`, `brightspace`, or any in the registry).
- **Pinned and read-only**: files go to `<data>/extensions/<name>/<first 16 hex of the integrity>/` (fetched into a
  temp directory, checked, then renamed into place) and are made read-only. Integrity is sha256 over the sorted
  listing of `<path>\0<644|755>\0<sha256>\n` lines; symlinks, `..` paths and anything over 20 MB or 5,000 files are
  refused.
- **Updates**: never automatic. `ext update` shows the old and new version, commit and integrity and installs only
  on confirmation; an update that changed after you saw it is refused.
- **Removal**: refused while connections use the extension; `--force` disables them first (their credentials stay
  until you remove the connections).
- **Console**: Extensions lists what's installed (version, commit, source, official or third-party, used by),
  browses the registry, updates with the diff shown, and adds from a URL with the same warning.

Admin API (console session and the CSRF header, like every `/api` route; the CLI uses it through its local admin
session):

| Route | |
|---|---|
| `GET /api/extensions` | Installed extensions, with `usedBy` |
| `GET /api/extensions/registry` | The registry index, with what's installed |
| `POST /api/extensions/resolve` `{source}` | What `source` would install and the third-party warning; installs nothing |
| `POST /api/extensions` `{source, confirmThirdParty?, expectIntegrity?}` | Install. 409 `third_party_unconfirmed` (with `warnings`) until confirmed; 409 `changed` when `expectIntegrity` no longer matches |
| `GET /api/extensions/:name` | One extension |
| `POST /api/extensions/:name/update` `{confirm?, expectIntegrity?}` | Without `confirm`, the would-be update (`from`, `to`, `warnings`); with it, installed. `update: null` when up to date |
| `POST /api/extensions/:name/verify` | Re-checks the installed files' integrity: `{ok}` |
| `DELETE /api/extensions/:name[?force=true]` | Remove. 409 `in_use` (with `usedBy`) unless forced |

## Live check: `smoke google-workspace`

An end-to-end check of Gmail attachments and the `google-workspace` extension on the real, connected account. You
run it on xaq's machine while xaq is running. It is safe by construction: it reads anything, writes only into a new
scratch folder plus ONE draft to the account itself, and removes both again.

```
xaq smoke google-workspace --scratch [--account <email>] [--connection <slug>] [--json] [--yes] [--data …]
```

- **`--scratch` is required.** Without it the command refuses and creates nothing. It prints the plan, then asks
  (or takes `--yes`).
- **`--account`, `--connection`**: the Gmail account and the google-workspace connection. Each defaults to the only
  one (the account defaults to the one the connection is signed in as). If Workspace isn't connected, isn't
  working or lacks one of its Google permissions, the command says so and prints the console page that fixes it.
  Connections must be on (Settings), and xaq must have the `attachmentDirs` setting.
- **A temporary agent** `xaq-smoke-<UTC timestamp>` runs it, through `/mcp` like any agent; its key is held in
  memory only. The agent gets the account with `read` and `draft` only (draft-only send mode, no send, organize or
  trash) and the Workspace connection at "ask", so risky calls really wait for approval. It inherits nothing else and
  lists every tool directly. It is deleted when the run ends, also after a failure or Ctrl-C.

What it does, in order (tool names as the extension lists them; agents see `<slug>__<name>`):

1. **Reads.** These print names, the subject, kinds and sizes, never content.
   - Drive: `drive_search` for the newest Doc, Sheet and Slides file, then `drive_list_folder` on the top of My
     Drive. For each file: `drive_get`, then `docs_read`, `sheets_read` or `slides_read`, then `drive_export` (as
     markdown, csv or text).
   - Gmail: `search_threads` (`has:attachment`) and `get_thread`/`get_message` pick ONE email with attachments.
     Then `list_attachments`, and `get_attachment` extracts each attachment.
2. **Scratch folder.** `drive_create_folder` creates `xaq-smoke-<ts>` at the top of My Drive. If that fails, nothing
   is written.
3. **Docs.** `docs_create` from markdown, in the folder. Then `docs_append`, `docs_replace_text` (exactly 2 matches),
   `docs_comment_add`, and `docs_read` and `docs_comments_list` to check the markers and the comment.
4. **Sheets.** `sheets_create` in the folder, `sheets_write` A1:C2, `sheets_append_rows` (2 rows), then
   `sheets_read`, which must give back exactly those cells.
5. **Slides.**
   - `slides_create` from an outline, in the folder. Then `slides_add_slide` and `slides_replace_text` (exactly 2
     matches).
   - `drive_upload` puts a PNG the command makes itself into the folder. `slides_insert_image` with that
     `driveFileId` must be refused. Slides fetches images without credentials, the PNG is private, and nothing is
     ever shared. The deck must stay unchanged, and the table says "Drive image (private): refused as expected".
     An insert fails the step.
   - `slides_insert_image` from a fixed public https image must insert it. `slides_read` then checks the text and
     the image.
   - `slides_delete_slide` must come back pending. The command approves it and checks that the slide is gone.
6. **Draft.**
   - The command writes a file into a new temp dir and adds that dir to `attachmentDirs`.
   - `create_draft` makes ONE draft addressed to the account's own address. It has two attachments: the temp file
     (`{ path }`) and the scratch doc as PDF (`{ drive_file_id, export_as: "pdf" }`).
   - The daemon checks the draft: the recipient, 2 attachments, names and sizes. Then it deletes the draft.
7. **Cleanup, always.**
   - The draft is deleted, if a step before didn't delete it.
   - `drive_trash` on the scratch folder comes back pending; the command approves it, and `drive_get` confirms the
     folder is in the trash. Drive keeps it there for 30 days.
   - The agent is deleted, `attachmentDirs` is restored and the temp dir is removed.

**Guards, in code:**
- Before every write, the target must be the scratch folder itself, or a file this run created whose parents
  (`drive_get`) include the folder. This covers files passed as arguments too, such as `driveFileId` and the
  draft's `drive_file_id`.
- A create call whose new file isn't in the folder is never written to again, and it's reported.
- Tools outside the run's list are refused, `docs_overwrite` for one.
- The draft must be addressed to exactly the account's own address, with no Cc, no Bcc and no thread. Its local
  attachment must come from the run's temp dir.
- The command approves a pending call only after checking that it is its own: the agent, the connection, the tool
  and the exact arguments.
- A ledger of everything created drives the cleanup and the leftover check.

**Report:** a PASS/FAIL table per tool and step, then **Left behind**, which should say "nothing". The leftover check
looks for:
- the folder or any of its files not in the trash;
- the draft still in Gmail;
- the agent or its settings still stored;
- `attachmentDirs` not as before;
- the temp dir still on disk;
- an earlier run's `xaq-smoke-*` agent.

`--json` prints the same as JSON on stdout (the progress goes to stderr). The exit code is 0 only when every step
passed and nothing was left behind. It is 130 after Ctrl-C, 1 otherwise. A step skipped because the account has no
such file or email also makes the exit code non-zero.

**Ctrl-C:** the first press lets the current call finish, starts no new step, then cleans up and reports. A second
press quits at once and lists what may be left.

Admin API used only by this command (console session and CSRF header, like every `/api` route). Each draft route
acts only on a draft that the run's agent created (per the audit log), that is in the ledger the command sends,
and whose subject starts with `[xaq-smoke-<ts>]`. A delete also requires the draft to be addressed only to the
account itself.

| Route | |
|---|---|
| `POST /api/smoke/agents` `{name, accountId, connectionId}` | The temporary agent (`name` must be `xaq-smoke-<UTC timestamp>`) → `AgentWithKey` |
| `POST /api/smoke/drafts/inspect` `{agentId, accountId, draftId, ledger}` | The draft's subject, recipients and attachments (names, types, sizes) |
| `POST /api/smoke/drafts/delete` `{agentId, accountId, draftId, ledger}` | Deletes it (Gmail `drafts.delete`) |
| `POST /api/smoke/leftovers` `{agentId, accountId, draftIds}` | Whether the agent, its settings or the drafts still exist, plus any other `xaq-smoke-*` agents |

## Commands and configuration

The npm package is `xaq-cli`; the command it provides is `xaq`. Use `npx xaq-cli …` for one-off
runs, or `npm i -g xaq-cli` and then `xaq …`. Every command has `--help`.

```
xaq [start] [--port 8425] [--host 0.0.0.0] [--data ~/.xaq] [--no-open] [--dev]
xaq service install [--port …] [--host …] [--data …]
xaq service uninstall [--data …]
xaq service status
xaq reset-password [--data …] [--port …] [--host …]
xaq skill install [--target claude|codex|agents|<dir>] [--url <public url>]
xaq skill print [--url <public url>]
xaq connections add|list|reconnect|rename|disable|remove …   # see Connections
xaq ext add|list|update|remove …                             # see Extensions
xaq smoke google-workspace --scratch [--account …] [--connection …] [--json] [--yes]   # see Live check
xaq settings attachment-dirs list|add <dir>|remove <dir>     # see Attachments
xaq connect <url> … / setup-mcp / listen …   # on agent machines, see listen.md
```

| Flag | Env | Default | |
|---|---|---|---|
| `--port` | `PORT` | `8425` | Port to listen on |
| `--host` | `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` behind a reverse proxy or SSH tunnel |
| `--data` | `XAQ_DATA` | `~/.xaq` | Data directory |
| | `XAQ_MASTER_KEY` | | Base64 32-byte key for encrypting secrets, instead of `<data>/master.key` |
| | `TRUST_PROXY` | | `1` behind a reverse proxy: client IPs from `X-Forwarded-For`, https from `X-Forwarded-Proto` |
| | `TRUST_PROXY_HOPS` | `1` | Number of proxies in front of xaq (which `X-Forwarded-For` entry, from the right, is the client) |
| | `TRUST_PROXY_FROM` | loopback | Other proxy addresses whose forwarding headers are believed: comma-separated IPs or CIDRs (IPv4 or IPv6) |
| | `XAQ_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `--url` | `XAQ_URL` | the xaq running on this machine, else `http://localhost:8425` | `skill` commands only: the server URL written into SKILL.md |

Everything else (public URL, ingest mode, poll interval, body size limit, retention, approval expiry, webhook allowlist,
agent pairing, the directories agents may attach files from) is set in the console under **Settings**.

<!-- rename-xaq: keep-start -->
Installs from before the rename to xaq keep working unchanged: every `XAQ_*` variable is also read under its old
name (`AGENTINBOX_DATA`, `AGENTINBOX_MASTER_KEY`, …) when the new one isn't set, and while `~/.xaq` doesn't exist an
existing `~/.agentinbox` stays the default data directory (xaq says so once at startup; nothing is moved). A `~/.xaq`
counts as xaq's only when it holds its files (`xaq.db`, `agentinbox.db`, `master.key` or the lock); one that belongs
to another program called xaq is skipped when `~/.agentinbox` exists, and otherwise only gets xaq's files added
beside its own (nothing of it is changed, renamed or deleted, not even its permissions). See
[Upgrading from agentinbox](../README.md#upgrading-from-agentinbox).
<!-- rename-xaq: keep-end -->

**Forgot the admin password?** Run `npx xaq-cli reset-password` on the server, as the user xaq runs as
(`sudo` for a system service) and with the same `--data`. It signs out all sessions and prints a new setup link (for the
running instance's address; pass `--port`/`--host` if it isn't running); a running instance picks it up without a
restart. On an instance that hasn't been claimed yet, it prints the first-run
link instead.

## Google Cloud setup in brief

The console's setup wizard shows every step with the exact values to paste. xaq uses **your own** Google Cloud
project and OAuth client: Gmail's read scopes are restricted, so a shared client isn't an option, and this way your mail
never passes through anyone else's app. The parts that most often go wrong:

- **Consent screen audience.** *Internal* if every mailbox is in your Google Workspace organization (no review, no
  expiry). *External* for `@gmail.com` accounts, and then **publish the app to "In production"**: left in *Testing*,
  Google expires refresh tokens after **7 days** and accounts silently disconnect. Google's verification isn't needed
  for your own use: on consent, click *Advanced → Go to (app name)* past the "unverified app" warning.
- **OAuth client** must be of type *Web application*, with the redirect URI the console shows
  (`<public URL>/oauth/callback`). Google won't redirect to plain HTTP on a non-localhost address; the console then uses
  a `localhost` redirect URI and asks you to paste the URL you land on.
- **Scopes.** Each connected account grants `gmail.modify` plus `openid email profile`, and with Google Calendar on
  `calendar.events`, `calendar.calendarlist.readonly` and `calendar.events.freebusy`, nothing more.
- **Real-time delivery (Pub/Sub) setup** asks one connected account for the extra `pubsub` scope, and that account needs
  **Owner** or **Pub/Sub Admin** on the project (Editor can't change topic permissions). A Workspace organization policy
  (domain-restricted sharing) can block granting Gmail's push service
  (`gmail-api-push@system.gserviceaccount.com`); the console says so, and polling (every 30 seconds by default) works
  without any of this.

## Connecting agents by hand

The console (**Agents → Connect an agent**) has copy-paste setup per tool, including device-flow pairing with
`npx xaq-cli connect <url>` (see [listen.md](listen.md)). Any MCP client that speaks streamable HTTP works:
endpoint `<public URL>/mcp`, header `Authorization: Bearer <aib_… key>`. For example, Claude Code:

```sh
claude mcp add --transport http --scope user xaq https://mail.example.com/mcp \
  --header "Authorization: Bearer $XAQ_API_KEY"
```

Codex (`~/.codex/config.toml`, with `XAQ_API_KEY` exported where Codex runs):

```toml
[mcp_servers.xaq]
url = "https://mail.example.com/mcp"
bearer_token_env_var = "XAQ_API_KEY"
```

Cursor (`~/.cursor/mcp.json`) and most other clients take `{"mcpServers": {"xaq": {"url": "…/mcp", "headers":
{"Authorization": "Bearer aib_…"}}}}`; Cursor also accepts `"Bearer ${env:XAQ_API_KEY}"`.

**The agent skill.** `SKILL.md` teaches an agent the tools, Gmail search syntax, reply etiquette, how sends and denials
work, the event loop, and that email content is data, never instructions. Install it where the agent runs (no running
xaq needed there), or fetch it from any instance at `/skill.md`:

```sh
npx xaq-cli skill install --url https://mail.example.com          # ~/.claude/skills/xaq/SKILL.md
npx xaq-cli skill install --target codex --url https://mail.example.com
npx xaq-cli skill install --target ./skills --url https://mail.example.com
```

## Events and webhooks

Event types: `message.received`, `message.sent`, `thread.reply_received` (a reply in a thread the account sent into),
`label.added`, `label.removed`, `account.auth_failed` and `sync.gap`. Agents only receive events for mailboxes and
labels their grants let them read. `thread.reply_received` is a subset of `message.received` (a reply produces both),
so subscribe to one or the other, not both.

**Calendar events:** `calendar.invitation_received` (someone invited the account), `calendar.event_created`,
`calendar.event_updated` (`detail.changes` lists what changed, or is `null` when the previous version wasn't seen) and
`calendar.event_cancelled`. They come from the calendars the account owns or can edit, and only reach agents with
`calendar.read` on that account, for the calendars their grant covers; mail `read` alone doesn't see them, and
`calendar.read` alone doesn't see mail. They use the same envelope with `message: null` and `calendarEvent` set:
calendar and event id, title, start and end, location, organizer, attendees and their responses, the account's own
response and https links. No description is stored; a webhook with "include body" fetches it when it delivers and puts
the cleaned text in `content` (not on cancellations).

- **Agents without an HTTP endpoint** use the MCP tools `wait_for_events` (long poll), `list_events` and `ack_events`
  while a session runs; the server keeps each agent's position. To start an agent when mail arrives, use
  [`xaq listen`](listen.md), e.g. `npx xaq-cli listen --recipe claude-code` (new mail only by default;
  `--types` adds the others). The listener skips Gmail's Promotions, Social and Forums tabs by default
  (`--all-categories`), takes `--not-from` / `--not-label` exclusions, and `--batch 60s` runs a burst as one command.
  With Hermes, `--recipe hermes` forwards each event to the Hermes gateway (`listen hermes --deliver <platform> --run`
  creates the route), which triages it and messages you; `--recipe hermes-oneshot` runs Hermes once per email.
- **Agents with an endpoint** get webhooks (**Webhooks** in the console), optionally with the cleaned message body.
  Webhooks list their event types, so existing ones never start receiving calendar events. For calendar events the
  filter's `calendarIds` keeps only those calendars (the primary calendar's id is the account's email address; mail
  events ignore it), and `from`, `to` and `subject` match the organizer, any attendee and the event title; label and
  attachment criteria apply to mail only. A delivery succeeds on a `2xx` within 10 seconds (redirects aren't
  followed); failures are retried 8 times with growing delays (30 s up to 12 h, about a day in total) before they're
  marked dead, and any delivery can be replayed.

**Verifying webhooks.** Each request carries `webhook-id`, `webhook-timestamp` and `webhook-signature` headers (`v1,` +
base64 HMAC-SHA256 of `{webhook-id}.{webhook-timestamp}.{body}`). Verify them with any
[Standard Webhooks library](https://github.com/standard-webhooks/standard-webhooks) and the `whsec_…` secret shown when
you create the webhook:

```js
import { Webhook } from "standardwebhooks";

const wh = new Webhook(process.env.XAQ_WEBHOOK_SECRET);
const payload = wh.verify(rawBody, request.headers); // throws if the signature or timestamp is bad
```

A dependency-free Node version is in the [skill](../server/skill/SKILL.md#webhooks). `webhook-id` is the delivery id:
it stays the same across retries and replays of one webhook. To dedupe across webhooks, use the event id `data.id`.

Webhooks may target public `https` URLs and, through the default allowlist (`localhost`, `127.0.0.0/8`, `::1`),
loopback. Other private addresses (a LAN host, `n8n.internal`) must be added to the webhook allowlist in **Settings** as a
hostname, `*.suffix`, IP or CIDR. Plain `http` works only for loopback and allowlisted hosts.

## Running it

Only one xaq runs per data directory; a second one refuses to start.

### As a service

```sh
npx xaq-cli service install
```

Installs a background service that starts at boot: systemd on Linux (`xaq.service`: a user service with lingering
enabled, or a system service when run as root) and launchd on macOS (`sh.xaq.daemon`). The service runs its own copy of xaq (the latest npm release),
installed in the data directory, so it never depends on the npx cache; if that install fails, the running service is
left as it was. Re-run `service install` to update; `service status` and `service uninstall` do what you'd expect, and
uninstalling keeps your data. `--port`, `--host` and `--data` aren't remembered: pass the same ones each time (the
startup banner prints the command with the flags you used). `XAQ_MASTER_KEY`, `TRUST_PROXY`, `TRUST_PROXY_HOPS`,
`TRUST_PROXY_FROM` and `XAQ_LOG_LEVEL` are taken from your shell and remembered in `<data>/service.env` (set one
to an empty value to remove it).

When a newer version is published, the console shows **Update available** with the exact command to run.

The unit runs the Node.js binary you installed it with; if you remove or replace that Node, run `service install`
again. If the service doesn't come up, `service install` rolls back and prints where to look (`systemctl --user status
xaq`, `journalctl --user -u xaq`). Over `su` or `sudo -u` there is often no systemd user session: log in
as that user directly, or enable lingering and set `XDG_RUNTIME_DIR=/run/user/$(id -u)` first.

<!-- rename-xaq: keep-start -->
A service installed by agentinbox (launchd `com.unlaboredlabs.agentinbox`, systemd `agentinbox.service`) is replaced
by `service install`: it is stopped, and waited for until it is gone, before the xaq one starts on the same data
directory (the one the old service used, unless you pass `--data`); if the new one doesn't come up, the old one is
put back exactly as it was. `service status` and `service uninstall` find either name.
<!-- rename-xaq: keep-end -->

A service that hasn't been claimed yet doesn't print its setup token to the journal. Get the link with
`npx xaq-cli reset-password --data <dir>`.

### With your own supervisor

For Docker, runit, supervisord, pm2 and the like, install the command and run it in the foreground:

```sh
npm i -g xaq-cli
xaq start --no-open --data /var/lib/xaq
```

Use the installed `xaq` binary rather than `npx`: npx doesn't pass stop signals on, so xaq wouldn't shut
down cleanly.

### On a remote server

Over SSH, the startup banner prints the tunnel command to run on your laptop, for example
`ssh -L 8425:localhost:8425 you@server` (your usual ssh host or alias works too); then open the printed `localhost`
setup link in your laptop's browser. Until
the instance is claimed, anyone who can reach its port could claim it first: start it with `--host 127.0.0.1` and use
the tunnel, or firewall the port. The banner warns when the port is reachable on a public address.

### Behind a reverse proxy

xaq serves plain HTTP. To expose it beyond your network, put it behind a TLS-terminating proxy (Caddy, nginx,
Tailscale Funnel) and:

- bind it to localhost: `--host 127.0.0.1`
- set `TRUST_PROXY=1`, so lockouts apply per client and cookies are marked `Secure` on https. The client address is
  taken from the right end of `X-Forwarded-For`; with more than one proxy in front, set `TRUST_PROXY_HOPS` to their
  number. Forwarding headers are believed only from a proxy on the same host (loopback); if the proxy runs on another
  machine, list its address in `TRUST_PROXY_FROM` (for example `10.0.0.5` or `10.0.0.0/24`; `/0` is refused). The
  proxy must append to (or overwrite) `X-Forwarded-For`; one that passes the header through unchanged lets clients
  choose their own address
- set **Settings → Public URL** to the https address, so MCP snippets, the skill and the OAuth redirect use it

`GET /health` (or `/api/health`) needs no auth and suits uptime monitors: `200` when healthy, `503` when degraded (for
example when an account needs to be reconnected or ingest is failing). It reports only a status, the version and
whether setup is complete.

## Security model

xaq assumes agents can be manipulated by the mail they read. So it keeps content intact and puts the hard limits
on actions.

**Content is cleaned, not censored.** Agents get full-fidelity mail converted to Markdown, with links and tables. Only
what a human reader couldn't see is removed: hidden CSS (`display:none`, zero-size, transparent or same-colour text),
HTML comments, scripts and styles, zero-width characters, Unicode tag characters and bidi overrides. Each body is
wrapped in one `<email_content … untrusted>` delimiter and comes with signals: SPF/DKIM/DMARC results, an
external-sender flag, whether hidden content was removed, and phrases typical of prompt injection. Signals are
informational; nothing is withheld because of them. Very long bodies are cut at 20,000 characters by default
(Settings), with a note saying so.

**Actions are strictly controlled.** A new agent can do nothing. Each grant (agent × mailbox) sets:

| Control | |
|---|---|
| Capabilities | `read` (search, read, attachments, events), `draft`, `send`, `organize` (labels, archive, read state), `trash` |
| Label scope | Confine the agent to threads carrying certain labels. Searches are rewritten and fetches by id are checked; anything outside looks "not found". |
| Send mode | `draft_only` (default: a Gmail draft for a human to send), `approval` (queued in the console; approving sends it) or `direct` |
| Allowed recipients | Exact addresses or globs such as `*@example.com` |
| Reply only | No new messages or forwards; replies only, inside threads the agent can see, to people already in the conversation. The reply goes to the message's Reply-To or From, which the sender chooses: use Allowed recipients to limit who can be written to. |
| Send caps | Per rolling hour and 24 hours, counting sends that became drafts or approvals too |

**A send whose outcome is unknown counts as sent.** When Gmail answers a send with a 5xx, times out or resets the
connection, the message may have gone out: the tool fails with `send_uncertain`, the attempt counts toward the send
caps, and the agent is told to look in `in:sent` (or `in:drafts`) before retrying. A request that never reached Google,
a rate limit and any other error Google answers with (a 4xx) are clean failures, safe to retry.

**Everything is audited.** Every tool call and every console change is recorded with its outcome, and denials name the
guardrail that blocked them.

**The console** is protected by an admin password (set through the one-time setup link), HttpOnly session cookies that
expire after 30 days of inactivity (90 at most), a CSRF header on every API change, request size limits, a Content
Security Policy that allows only the console's own scripts, and a 15-minute lockout after five wrong passwords (or 30
attempts) from one address. When failures pile up across many addresses, every sign-in attempt is slowed down instead.
It never allows being framed. The data directory and database are readable only by their owner.

**Code extensions run outside xaq's process** (see Extensions under Connections above): Node's permission model confines
their files and forbids child processes, workers and addons; `node:sqlite` (which would ignore those rules) is
switched off; a preload stops them sending signals (so they can't open xaq's debugger or kill processes), and xaq
ignores SIGUSR1 itself; the environment is built from scratch; credentials are handed out as short-lived access
tokens for that one connection. It's a guard against accidents and sloppy code, not a jail for hostile code: the
network isn't restricted, and only OS-level isolation (a separate user or container) closes the signal route fully.
They need a patched Node (≥ 22.23.2, 24.18.1 or 26.5.1). Install third-party code extensions only from people you
trust.

Recommendations: split agents that read untrusted mail from agents that can send; prefer `draft_only` or `approval`;
use allowlists for anything that sends directly.

### Attachments

`create_draft`, `reply`, `send_message` and `forward` take an optional `attachments` array. Each item is exactly one
of four sources:

| Item | Source |
|---|---|
| `{content_base64, filename, mime_type?}` | The bytes, base64-encoded inside the MCP tool call |
| `{path, filename?, mime_type?}` | A file on xaq's own machine, inside a directory the owner allowed (below). Off by default |
| `{message_id, attachment_id}` | An attachment of another message in the same account, with the ids `get_message` / `get_thread` show. Needs `read` on the grant, and the message must be in its label scope |
| `{drive_file_id, export_as?}` | A Google Drive file of the account. Google Docs, Sheets, Slides and Drawings are exported, as PDF unless `export_as` says otherwise (Docs: `pdf`, `docx`, `txt`, `md`; Sheets: `pdf`, `xlsx`, `csv` (first sheet); Slides: `pdf`, `pptx`, `txt`; Drawings: `pdf`); other files are attached as they are. Needs two things. First, the agent's own grant (any level) on a Google Workspace connection bound to the same Google account; mail access alone isn't enough, or any agent that can send could mail out any Drive file. Without it: "This agent has no access to Google Drive for <account>: grant it the Google Workspace connection." Second, the account's Drive read access (`drive.readonly`, through the Google Workspace extension's Drive opt-in); without it: "Drive isn't enabled for <account>: install the google-workspace extension and enable Drive in xaq (Connections → Google Workspace)". The connection is bound by its Google setup (the account it works as). Drive is read with an access token limited to `drive.readonly`, never the account's full token |

`forward` keeps `include_attachments` (the original's files) and can add new ones next to them. Every file is checked
before anything is sent, and the agent gets a plain-words error otherwise:

| Check | |
|---|---|
| Count | At most 10 files per message (a forward's original files don't count) |
| Size | 25 MB per message, body and files together, before encoding: Gmail's sending limit ("up to 25 MB in attachments", [Gmail help](https://support.google.com/mail/answer/6584)). The encoded message must also fit the 35 MB (`36700160` bytes) that the Gmail API's upload endpoint for `messages.send` and `drafts.create` accepts (xaq sends anything over 512 KB that way). 25 MB of files is about 34 MB encoded, so in practice only a long body can reach it: quoted-printable can double a text body. Sizes are checked before downloading wherever the source says (base64 length, the file's size on disk, Gmail's part size, Drive's `size`), and each download is cut off at what still fits, so nothing larger is ever held in memory. The composed message is then counted exactly. The error names the file and the sizes; for a Drive file it gives the file's Drive link to put in the body instead, and for an agent that can use Drive it suggests sharing from Drive |
| Content | Standard or url-safe base64; empty files are refused |
| Type | `mime_type` must be `type/subtype` (default: the source's type, else from the extension, else `application/octet-stream`); [file types Gmail blocks](https://support.google.com/mail/answer/6590) (`.exe`, `.js`, `.bat`, `.msi`, `.iso`, …, also gzipped) are refused, whatever the source. Gmail may still refuse archives that contain them |
| Filename | Path removed; control, zero-width, bidi and tag characters stripped; delimiter tags defused; at most 120 characters with the extension kept; `attachment` (plus the type's extension) when nothing is left |

**Files from a path** are a security boundary: an agent must never be able to mail xaq's own secrets or arbitrary
files.

- Off until the owner lists directories under **Settings → Attachments from files**, or with
  `npx xaq-cli settings attachment-dirs add <dir>` (`list`, `remove`) on xaq's machine. Only the admin can change the
  list (it's the `attachmentDirs` setting of `PATCH /api/settings`); no agent tool can. A directory must exist when it's
  added. It can't be or contain your home directory or `/`. It also can't be, contain or sit inside any of the
  refused places below. Pick a narrow folder such as `~/Documents/xaq-outbox`.
- The path must be absolute and inside an allowed directory, both as given and after resolving symlinks and `..`
  (a symlink is followed only when it stays inside).
- These are refused even inside an allowed directory:
  - xaq's own directories: the data directory (and `~/.xaq`, `~/.agentinbox`), and the CLI's config, state and data
    directories, both where `XDG_*` points and at their default locations, so a daemon started by launchd or
    systemd covers the profiles too;
  - service files: all of `~/Library/LaunchAgents`, and the systemd unit directories;
  - the agent tools' directories and the MCP configs `setup-mcp` writes with agent keys: `~/.codex`, `~/.cursor`,
    `~/.claude` and `~/.claude.json`, and the Hermes home. Their `*.xaq-backup-*` copies are refused too;
  - credential stores: `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.gnupg`, `~/Library/Keychains`, `~/.kube`, `~/.docker`,
    `~/.netrc`, `~/.npmrc`;
  - files named `master.key`, `*.db` (and SQLite's `-wal`, `-shm`, `-journal`), `.env` (`.env.*`), `id_*`, `*.pem`,
    `*.key`, `.netrc`, `.npmrc`, `.pgpass`, `.claude.json`, `.mcp.json` or `*.xaq-backup-*`, anywhere.
- Regular files only: no directories, FIFOs or devices, and no hard-linked files (a hard link can make any file look
  like it's in an allowed directory). The file is opened without following a final symlink and without blocking. The
  open file must be the very file that was checked (same device and inode). On Linux its actual path
  (`/proc/self/fd`) must also still pass every check, so swapping the file between the check and the open fails.
- Errors name the path the agent gave and sizes, never contents. They never say where a symlink leads: anything
  refused through a symlink, including a missing target, gets the same answer.

The grant applies unchanged: a draft needs `draft`, a send needs `send` and goes through its send mode, recipient
allowlist, reply-only rule and caps. An approval card lists each file's name, type, size and source (the path that was
read, the source message, or the Drive file's name and id and the export format), and approving sends the draft that
carries them. The audit log records the same plus each file's SHA-256, never its content; a refused attempt records
what was asked for (the path, message or Drive id).

Messages whose raw form is over 512 KB are sent to Gmail through its `/upload/` endpoint (`uploadType=media`, or
`multipart` with the `threadId` for replies), since Google documents no size limit for the JSON `raw` field and has
refused such bodies at 1 MB. This also applies to forwards with their original attachments.

`/mcp` reads at most 4 MB of request body, except for requests whose `Authorization` header carries a valid agent key
(checked before the body is read), which may send up to 36 MB, enough for 25 MB of files in base64.

## Data and backups

Everything lives in the data directory (`~/.xaq` by default):

| File | |
|---|---|
| `xaq.db` | SQLite database (plus `-wal` and `-shm` files): accounts, encrypted tokens, agents, grants, events, deliveries, approvals, audit log |
| `master.key` | Encrypts Google tokens, webhook secrets and the OAuth client secret (mode 0600) |
| `setup-token` | The one-time setup token, until the instance is claimed |
| `xaq.lock` | Marks the running instance (pid and port) |
| `service.env` | Environment the service was installed with, possibly including `XAQ_MASTER_KEY` (mode 0600; `service install` only) |
| `xaq.log` | Service output on macOS (launchd); on Linux use `journalctl --user -u xaq` (or without `--user` for a system service) |
| `app/` | The service's own install (`service install` only) |
| `extensions/` | Installed extensions, one read-only directory per pinned version |
| `extension-state/<extension>/<connection>/` | A code extension's own files for one connection (mode 0700), deleted with the connection |

<!-- rename-xaq: keep-start -->
A data directory created before the rename keeps its file names: `agentinbox.db`, `agentinbox.lock` and
`agentinbox.log` (and usually lives in `~/.agentinbox`).
<!-- rename-xaq: keep-end -->

Back up `xaq.db` and `master.key` together: without the key, stored secrets can't be decrypted, and xaq
refuses to start rather than create a new one. Keep the key somewhere safer than the database backup, or supply it via
`XAQ_MASTER_KEY`. The database runs in WAL mode, so don't just copy the file while xaq is running: stop
it first (`systemctl --user stop xaq`), or take a consistent copy with
`sqlite3 ~/.xaq/xaq.db ".backup /path/to/backup.db"`.

Received mail bodies are never stored; xaq keeps metadata (ids, headers, labels, snippets) and fetches content
from Gmail on demand. The only bodies in the database are those of sends queued for approval. Events, deliveries,
audit entries and decided approvals (with their bodies) are pruned after the retention period set in **Settings** (30
days by default).

## Release channel

Every push to `main` (a quick second merge can supersede the first) is published to npm as
`xaq-cli@<version>-nightly.<n>` under the `latest` tag, built by GitHub Actions with npm trusted publishing and
[provenance](https://docs.npmjs.com/generating-provenance-statements). `npx xaq-cli` therefore runs the newest
build of `main`, and `service install` always installs `latest`. To stay on one build, run it pinned in the foreground:
`npx xaq-cli@<version>`.

## Development

```sh
pnpm install
XAQ_DATA=/tmp/xaq-dev pnpm dev
```

`pnpm dev` runs the server on `:8425` in watch mode (API, MCP and OAuth only) and the console on Vite at `:5173`, which
proxies to it. Open the Vite URL; the printed setup link already points there.

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm build           # console → dist/web, server → dist/cli.js
node dist/cli.js     # run the build
```

Stack: TypeScript on Node 22+, Hono on `@hono/node-server`, `node:sqlite`, the MCP TypeScript SDK, and thin fetch-based
Google clients (no `googleapis`, so `npx` stays fast). The console is Vite, React 19, TanStack Router / Query / Table /
Form and shadcn/ui on Tailwind v4.
