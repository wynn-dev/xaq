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

From the terminal on the same machine: install an extension first, `npx xaq-cli ext add notion` (or `t3code`,
`whoop`, `brightspace`), then `npx xaq-cli connections add notion` (`t3code --url http://<your T3 server>:3773`, or
any MCP server URL),
and `npx xaq-cli import --from hermes` (also `claude-code`, `cursor`, `codex`) to move an agent's existing MCP
servers behind the broker. Details: [Connections](docs/reference.md#connections-mcp-broker).

For Gmail, Google Calendar is supported too (optional). It needs the Calendar API enabled in your Google Cloud project, the
Calendar scopes on the consent screen, Calendar added to each account, and `calendar.read` (and, to make changes,
`calendar.write`) on the agent's grant. The console's setup covers all of it; existing installs use Overview → "Add
Google Calendar". Details: [docs/calendar.md](docs/calendar.md).

Agents can attach files to drafts, replies, forwards and new mail: bytes they have, a file from a directory you allow
on xaq's machine (off by default: Settings → Attachments from files, or `npx xaq-cli settings attachment-dirs add <dir>`),
another message's attachment, or a Google Drive file (with the agent granted the account's Google Workspace connection, and Drive enabled for the account). Gmail's 25 MB per message
applies. Details: [Attachments](docs/reference.md#attachments).

## Extensions

Integrations are extensions: `npx xaq-cli ext add notion` installs one from the official
[xaq-extensions](https://github.com/wynn-dev/xaq-extensions) registry, pinned to a commit and an integrity hash, and
`ext list`, `ext update` (shows the change, asks first; nothing updates on its own) and `ext remove` manage them, as
does the console's Extensions page. A GitHub URL, another git URL or a local directory works too, as a third-party
extension, after a warning: a `code` extension runs on your machine with network access. Node's permission model
limits its files, child processes and workers, not its network. Details: [Extensions](docs/reference.md#extensions).

![Overview](docs/screenshots/overview.png)

## Live check

There is no test account, so `smoke google-workspace` checks Gmail attachments and the Google Workspace extension
on the real one, end to end. Run it on xaq's machine while xaq is running:

```sh
npx xaq-cli smoke google-workspace --scratch
```

It prints its plan and asks first. It starts by removing what earlier runs left behind, and lists anything it can't
remove for you to check. Existing files and mail are only read; it prints their names and the email's subject,
never their content, and it never fetches an attachment that would be saved to disk. Every write goes into one new Drive folder, `xaq-smoke-<UTC timestamp>`, and the only
mail is one draft to the account itself, which is never sent. A temporary agent makes the calls through `/mcp`, so
risky ones go through approval, and the command approves its own. At the end the draft is deleted, the folder goes
to the Drive trash, and the agent and the temporary settings are removed, also after a failure, Ctrl-C, SIGTERM or
SIGHUP. You get a
PASS/FAIL table and a "Left behind" list, which should say nothing. Details:
[Live check](docs/reference.md#live-check-smoke-google-workspace).

## More

- [Reference](docs/reference.md): features, configuration, running as a service or behind a proxy, security model,
  webhooks, data and backups, development
- [Waking local agents with `xaq listen`](docs/listen.md), e.g. `npx xaq-cli listen --recipe claude-code`
- [Screenshots](docs/screenshots/README.md)

## License

[MIT](LICENSE)
