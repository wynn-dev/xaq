# xaq

[![CI](https://github.com/wynn-dev/xaq/actions/workflows/ci.yml/badge.svg)](https://github.com/wynn-dev/xaq/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/xaq-cli)](https://www.npmjs.com/package/xaq-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A self-hosted MCP broker for AI agents. One small server holds all your credentials (Notion, WHOOP, T3 Code, any MCP
server, Gmail and Google Calendar) and gives each agent a single MCP endpoint with only the tools it's allowed. Risky actions
(deleting, sending, publishing, payments) can wait for your one-tap approval, and every call is audited.

```sh
npx xaq-cli
```

Open the link it prints and pick what to connect first: Notion, another MCP server, or Gmail and Calendar.
Pre-made connections (Notion, T3 Code, WHOOP, Brightspace) are extensions: the console installs the one you pick
from the official registry, then connects it. Only Gmail and Calendar need a Google Cloud project; everything else
is a few clicks. The console then connects your first agent. Requires Node.js 22.13 or newer (code extensions such
as WHOOP need 22.23.2, 24.18.1 or 26.5.1 or newer on those lines).

For Gmail, Google Calendar is supported too (optional). It needs the Calendar API enabled in your Google Cloud project, the
Calendar scopes on the consent screen, Calendar added to each account, and `calendar.read` (and, to make changes,
`calendar.write`) on the agent's grant. The console's setup covers all of it; existing installs use Overview → "Add
Google Calendar". Details: [Events and webhooks](docs/reference.md#events-and-webhooks).

Agents can attach files they have, or another message's attachment, to drafts, replies, forwards and new mail.
Details: [Attachments](docs/reference.md#attachments).

## Extensions

Integrations are extensions: the console's Extensions page installs one from the official
[xaq-extensions](https://github.com/wynn-dev/xaq-extensions) registry, pinned to a commit and an integrity hash, and
updates (shows the change, asks first; nothing updates on its own) or removes it. A GitHub URL, another git URL or a
local directory works too, as a third-party extension, after a warning: a `code` extension runs on your machine with
network access. Node's permission model limits its files, child processes and workers, not its network. Details: [Extensions](docs/reference.md#extensions).

![Overview](docs/screenshots/overview.png)


## More

- [Reference](docs/reference.md): features, configuration, running as a service or behind a proxy, security model,
  events, data and backups, development
- [Waking local agents with `xaq listen`](docs/listen.md), e.g. `npx xaq-cli listen --recipe claude-code`

## License

[MIT](LICENSE)
