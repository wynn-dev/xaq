# xaq reference

The details behind the [README](../README.md). `npx xaq-cli` and the console cover setup; this page is for running
xaq in production and understanding what it does. Agent machines: [listen.md](listen.md).

- [Commands and configuration](#commands-and-configuration)
- [Connections](#connections) and [extensions](#extensions)
- [Gmail and Google Calendar](#gmail-and-google-calendar)
- [Agents and access](#agents-and-access)
- [Events](#events)
- [Attachments](#attachments)
- [Running it](#running-it)
- [Security model](#security-model)
- [Data and backups](#data-and-backups)
- [Release channel](#release-channel) and [development](#development)

## Commands and configuration

The npm package is `xaq-cli`; the command is `xaq` (`npx xaq-cli …`, or `npm i -g xaq-cli`). Every command has
`--help`.

```
xaq [start] [--port 8425] [--host 0.0.0.0] [--no-open]
xaq service install [--port …] [--host …] [--node <path>] | uninstall | status
xaq reset-password
xaq skill install [--target claude|codex|agents|<dir>] [--url <public url>]
xaq connect <url> … | setup-mcp | listen …      # on agent machines: listen.md
```

| Flag | Env | Default | |
|---|---|---|---|
| `--port` | `PORT` | `8425` | Port to listen on |
| `--host` | `HOST` | `0.0.0.0` | Bind address; `127.0.0.1` behind a reverse proxy or SSH tunnel |
| `--data` | `XAQ_DATA` | `~/.xaq` | Data directory, for any command |
| | `XAQ_MASTER_KEY` | | Base64 32-byte key for encrypting secrets, instead of `<data>/master.key` |
| | `TRUST_PROXY` | | `1` behind a reverse proxy (see below) |
| | `XAQ_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `--url` | `XAQ_URL` | the local xaq, else `http://localhost:8425` | `skill install` only: the server URL written into SKILL.md |

Everything else (public URL, mail and calendar poll intervals, body length limit, retention, agent pairing) is in the
console under **Settings**.

**Forgot the admin password?** Run `npx xaq-cli reset-password` on the server as the user xaq runs as, with the same
`--data`. It signs out every session and prints a new setup link; a running instance picks it up without a restart.

## Connections

Each agent has one endpoint (`/mcp`) and one key; xaq holds every upstream credential and lists only the tools the
agent may use.

- **Adding one**: Connections → Add connection. Paste any MCP server's URL (xaq finds out whether it needs an OAuth
  sign-in or an API key), or pick an extension. A server on this machine or your private network (loopback,
  Tailscale) needs an explicit "allow this host" for that exact address.
- **Access**: per connection, Full access (the default) or Read only, for all agents or chosen ones; an agent's
  page can change it for that agent (see [Agents and access](#agents-and-access)).
- **Tool names**: `<connection>__<tool>`, e.g. `notion__notion-search`. Changing a connection's short name renames
  its tools at once. Prompts and resources pass through too (`<connection>__<prompt>`,
  `xaq://<connection>/<encoded URI>`) and count as reads.
- **Tool changes**: when a server changes or adds a tool, agents use the new definition; the audit log records it
  (`connection.tool_changed`, with the old and new definition hash).
- **Search mode**: an agent with more than 30 tools sees only `search_tools`, `call_read_tool`, `call_write_tool` and
  `get_call_status`, and finds the rest by searching. Calling a tool by name still works, with the same access and
  audit.
- **Expiring sign-ins**: a sign-in that can't be refreshed (T3 Code) or is capped (Notion, 180 days) shows "Expires in
  N days" from 7 days before; listeners get `connection.expiring` at 7 days and 1 day, with `reconnectUrl`. Past it,
  agents are told to ask you to reconnect, with the link.
- **T3 Code**: one connection per T3 server. Give the address you open T3 at (xaq adds `/mcp`), allow that address,
  and approve with a one-time pairing code (T3 → Settings → Connections, or `t3 auth pairing create`). Pick the least
  T3 access your agents need; Full access also lets them change projects, settings and source control. T3's browser
  preview runs in your browser profile with its saved logins: an agent that can use it browses as you.

## Extensions

Pre-made connections are extensions: a `remote` one is a manifest for a hosted MCP server (Notion, T3 Code,
Brightspace); a `code` one bundles an MCP server that xaq runs as a child process, one per connection (WHOOP). The
console's Extensions page installs, updates and removes them.

- **Sources**: a name from the official registry ([wynn-dev/xaq-extensions](https://github.com/wynn-dev/xaq-extensions),
  whose `index.json` pins each to a commit and an integrity hash); a GitHub URL
  (`https://github.com/<owner>/<repo>[/tree/<ref>/<path>]`); any other `https://` or ssh git URL (`#<ref>[:<path>]`,
  run through `git` without your config, environment or hooks); or an absolute directory, for development.
- **Third-party**: anything that isn't the official registry at the indexed commit. You see its source, kind and
  declared network hosts first and confirm with "I trust it: install". It can't take an official extension's name.
- **Pinned and read-only**: files go to `<data>/extensions/<name>/<integrity prefix>/` and are made read-only.
  Integrity is sha256 over the sorted `<path>\0<644|755>\0<sha256>\n` listing; symlinks, `..` paths and anything over
  20 MB or 5,000 files are refused.
- **Updates** are never automatic: you see the old and new version, commit and integrity, and confirm. **Removal** is
  refused while connections use the extension, unless forced (which disables them).
- **Code extensions** run under Node's permission model: they read only their install and state directory, write
  only the state directory, can't start processes, workers or addons, and get an empty environment except four
  `XAQ_EXT_*` values. They never see xaq's database, keys or other connections; they ask xaq for their connection's
  access token. The network isn't restricted. A crash restarts it with backoff; five in a row mark the connection
  Error. They need Node ≥ 22.23.2, 24.18.1 or 26.5.1; the October 2026 security release (22.23.4, 24.22.1, 26.12.1)
  is recommended, and xaq warns below it.

| Admin API (console session and CSRF header) | |
|---|---|
| `GET /api/extensions`, `GET /api/extensions/:name` | Installed extensions, with `usedBy` |
| `GET /api/extensions/registry` | The registry index, with what's installed |
| `POST /api/extensions/resolve` `{source}` | What `source` would install, and the third-party warning |
| `POST /api/extensions` `{source, confirmThirdParty?, expectIntegrity?}` | Install; 409 `third_party_unconfirmed` or `changed` |
| `POST /api/extensions/:name/update` `{confirm?, expectIntegrity?}` | Without `confirm`, the would-be update; with it, installed |
| `POST /api/extensions/:name/verify` | Re-checks the installed files: `{ok}` |
| `DELETE /api/extensions/:name[?force=true]` | Remove; 409 `in_use` unless forced |

## Gmail and Google Calendar

xaq uses **your own** Google Cloud project and OAuth client (Gmail's scopes are restricted, so a shared client isn't
an option, and your mail never passes through anyone else's app). The setup wizard shows every value to paste. What
most often goes wrong:

- **Audience**: *Internal* if every mailbox is in your Workspace organization. *External* for `@gmail.com`, and then
  **publish the app "In production"**: in *Testing*, Google expires refresh tokens after 7 days. Verification isn't
  needed for your own use (*Advanced → Go to (app name)* on the warning).
- **OAuth client**: type *Web application*, with the redirect URI the console shows (`<public URL>/oauth/callback`).
  Google won't redirect to plain http on a non-localhost address; the console then uses a `localhost` redirect and
  asks you to paste the URL you land on.
- **Scopes**: `gmail.modify` plus `openid email profile`; with Calendar also `calendar.events`,
  `calendar.calendarlist.readonly` and `calendar.events.freebusy`. Calendar also needs the Calendar API enabled and is
  added per account (Overview → Add Google Calendar).

Mail is polled every 30 seconds and calendars every 60 by default (Settings). Received bodies are never stored: xaq
keeps metadata and fetches content from Gmail on demand.

## Agents and access

Agents → Connect an agent has copy-paste setup per tool, and device-flow pairing with `npx xaq-cli connect <url>`
([listen.md](listen.md)). Any MCP client that speaks streamable HTTP works: endpoint `<public URL>/mcp`, header
`Authorization: Bearer <aib_… key>`. For example:

```sh
claude mcp add --transport http --scope user xaq https://mail.example.com/mcp \
  --header "Authorization: Bearer $XAQ_API_KEY"
```

Codex (`~/.codex/config.toml`): `[mcp_servers.xaq]` with `url = "…/mcp"` and `bearer_token_env_var = "XAQ_API_KEY"`.
Cursor and most others: `{"mcpServers": {"xaq": {"url": "…/mcp", "headers": {"Authorization": "Bearer aib_…"}}}}`.

**The skill.** `SKILL.md` teaches an agent the tools, Gmail search syntax, how sends and denials work, the event loop,
and that email is data, never instructions. `npx xaq-cli skill install --url <server>` writes it
(`--target codex|agents|<dir>`); any instance also serves it at `/skill.md`.

**Access.** A new agent can do nothing. Each grant (agent × mailbox, or agent × connection) is one of two levels:

| Level | |
|---|---|
| Read only (the default) | Mail: search, read, labels, attachments, events. Calendar: calendars, events, free/busy. Connections: tools classed as reads that aren't risky |
| Full access | Also draft, send, reply, forward, organize and trash mail, and create, change and answer calendar events; every tool of a connection |

A mail grant with full access can also have **allowed recipients** (exact addresses or globs such as `*@example.com`):
then every send and every calendar invite may only go to them. There are no approvals: what a grant allows goes
through at once, and what it doesn't is refused with the reason, in the audit log.

**Upgrading from a version with approvals**: grants keep full access only where the agent already sent mail or
changed calendars without a person (send mode direct, calendar writes direct). Drafts-only, approval and
organize-only grants, and connections at "ask before risky actions", become read only; label-scoped grants now see the
whole mailbox. Check each agent's page in the console and give full access where it's needed.

A send whose outcome is unknown (a 5xx, timeout or reset) counts as sent: the tool fails with `send_uncertain` and the
agent is told to check `in:sent` before retrying.

## Events

Mail: `message.received`, `message.sent`, `thread.reply_received` (a reply in a thread the account sent into; a
subset of `message.received`, so subscribe to one or the other), `label.added`, `label.removed`,
`account.auth_failed`, `sync.gap`. Calendar: `calendar.invitation_received`, `calendar.event_created`,
`calendar.event_updated` (`detail.changes` lists what changed) and `calendar.event_cancelled`, for agents with
a grant on the account. Connections: `connection.expiring`.

Agents only get events for what their grants let them read. In a session they use `wait_for_events` (long poll),
`list_events` and `ack_events`; the server keeps each agent's position. To start an agent when mail arrives, use
[`xaq listen`](listen.md).

## Attachments

**Sending.** `create_draft`, `reply`, `send_message` and `forward` take `attachments`, each either
`{content_base64, filename, mime_type?}` or `{message_id, attachment_id}` (another message's file in the same account,
within the grant's read access). `forward` can keep the original's files (`include_attachments`) and add more. Limits:
10 files, 25 MB per message (Gmail's limit), no empty files, no [types Gmail blocks](https://support.google.com/mail/answer/6590).
Filenames are cleaned. The grant applies as usual, and the audit log records each file's name, type, size and
SHA-256, never its content.

**Reading.** `list_attachments` lists the files of a message or thread. `get_attachment` returns one as content,
wrapped as untrusted like a mail body:

| Type | Answer |
|---|---|
| PDF | Text page by page (up to 500 pages) |
| Word | Markdown: headings, lists, tables, links |
| Excel, CSV, TSV | A markdown table per sheet; small ones also as `structuredContent` rows |
| PowerPoint | Text per slide, with speaker notes |
| Text, HTML | Cleaned text |
| PNG, JPEG, GIF, WebP | Image content, up to 5 MB |
| Anything else | Name, type, size and ids, plus why it isn't shown |

Long content comes in parts (`max_chars`, then `offset`, `page`, `slide` or `sheet`). `format: "base64"` returns the
raw bytes of a file up to 5 MB instead. What can't be shown says why in `structuredContent.attachment.notShown`
(`unreadable`, `too_large`, `unsupported`) and, for a failed parse, `parseFailure` (`password`, `encrypted`, `corrupt`,
`hostile`, `timeout`, …).

**Parsing runs out of process**, in a short-lived `node --permission` child per file with no file, process, worker,
addon or network access and an empty environment. Its heap is capped at 256 MB and its resident memory at 512 MB, it
gets 20 seconds, and at most two run at once. Zip packages are read with entry, size and ratio caps (no zip bombs),
XML with a DOCTYPE is refused, and extracted text is cleaned like mail.

## Running it

Only one xaq runs per data directory.

**As a service**: `npx xaq-cli service install` installs a systemd unit (`xaq.service`, a user service with lingering,
or a system service as root) or a launchd agent (`sh.xaq.daemon`). The service runs its own install of the latest
release in the data directory. Re-run it to update or change `--port` / `--host` / `--data` (not remembered: pass
them each time). `XAQ_MASTER_KEY`, `TRUST_PROXY` and `XAQ_LOG_LEVEL` are taken from your shell into
`<data>/service.env`. The service runs the Node that ran `service install` (or `--node <path>`); re-run it after
replacing that Node. If it doesn't come up, `service install` says where to look (`journalctl --user -u xaq`). Over
`su` or `sudo -u` there's often no systemd user session: log in as that user, or enable lingering and set
`XDG_RUNTIME_DIR`.

**Update now**: when a newer release is out, the console says so. A service gets an **Update now** button: after the
admin password, a separate one-shot job (`xaq-update` / `sh.xaq.update`) runs `service install` with the npm `latest`
version, which refuses unless the release's `npm-shrinkwrap.json` pins exactly what was installed and
`npm audit signatures` passes. The console polls `<data>/update/status.json` until the new version answers. There's no
automatic rollback: if it doesn't come up, fix it and run `service install` again. Every request is audited as
`system.update`.

**With your own supervisor** (Docker, runit, pm2): `npm i -g xaq-cli`, then `xaq start --no-open --data /var/lib/xaq`
in the foreground. Use the installed binary, not `npx`, which doesn't pass stop signals on.

**On a remote server**: the startup banner prints the SSH tunnel command for your laptop. Until the instance is
claimed, anyone who can reach its port could claim it: bind `--host 127.0.0.1` and use the tunnel, or firewall it.

**Behind a reverse proxy** (Caddy, nginx, Tailscale Funnel): bind `--host 127.0.0.1`, set `TRUST_PROXY=1` (client
addresses from the last `X-Forwarded-For` entry, believed only from a loopback proxy; https from
`X-Forwarded-Proto`), and set Settings → Public URL to the https address. `GET /health` needs no auth: `200` healthy,
`503` degraded.

## Security model

xaq assumes agents can be manipulated by what they read, so it keeps content intact and puts the hard limits on
actions.

- **Content is cleaned, not censored**: mail becomes Markdown; only what a human couldn't see is removed (hidden CSS,
  comments, scripts, zero-width, tag and bidi characters). Each body is wrapped in one `<email_content … untrusted>`
  delimiter with signals (SPF/DKIM/DMARC, external sender, hidden content removed, injection-like phrases). Bodies
  over the Settings limit (20,000 characters by default) are cut, with a note.
- **Actions are limited** by the agent's grants and connection access (above), and **everything is audited**: every
  tool call and console change, with its outcome and the rule that blocked it.
- **The console**: an admin password, HttpOnly sessions (30 days idle, 90 at most), a CSRF header on every change, a
  strict Content Security Policy, no framing, and a 15-minute lockout after five wrong passwords from one address.
  The data directory is readable only by its owner.
- **Code extensions and attachment parsing** run out of process under Node's permission model (above). That guards
  against accidents and sloppy code, not hostile code: the network isn't restricted for extensions. Install
  third-party code extensions only from people you trust.

Split agents that read untrusted mail from agents that can send, and give sending agents allowed recipients.

## Data and backups

| In the data directory (`~/.xaq`) | |
|---|---|
| `xaq.db` (+ `-wal`, `-shm`) | Accounts, encrypted tokens, agents, grants, events, audit log |
| `master.key` | Encrypts tokens, connection credentials and the OAuth client secret (0600) |
| `setup-token`, `xaq.lock` | The one-time setup token; the running instance's pid and port |
| `service.env`, `app/`, `update/` | The service's environment, its own install, and the update job's status |
| `extensions/`, `extension-state/` | Installed extensions; each code extension's per-connection files |

Back up `xaq.db` and `master.key` together: without the key nothing stored can be decrypted, and xaq refuses to start.
Copy the database with xaq stopped, or with `sqlite3 ~/.xaq/xaq.db ".backup /path/to/backup.db"`. Events and audit
entries are pruned after the retention period (30 days by default).

## Release channel

Every push to `main` is published to npm as `xaq-cli@<version>-nightly.<n>` under `latest`, with
[provenance](https://docs.npmjs.com/generating-provenance-statements). `npx xaq-cli` runs the newest build;
`npx xaq-cli@<version>` pins one.

## Development

```sh
pnpm install
XAQ_DATA=/tmp/xaq-dev pnpm dev      # server on :8425 (watch), console on Vite :5173
pnpm typecheck && pnpm lint && pnpm test
pnpm build                          # console → dist/web, server → dist/cli.js
```

TypeScript on Node 22+, Hono, `node:sqlite`, the MCP TypeScript SDK and thin fetch-based Google clients; the console
is Vite, React 19, TanStack and shadcn/ui on Tailwind v4.
