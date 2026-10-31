# Waking local agents: `xaq connect` and `xaq listen`

`xaq listen` runs on the agent's own machine (a laptop behind NAT is fine). It keeps an **outbound** connection to the
xaq daemon, so there are no open ports, and runs a local command for each new email. By default only incoming mail
(`message.received`) wakes it; mail the account sends doesn't. The daemon never executes anything.

```
 xaq daemon ──(event stream over HTTPS, opened by the laptop)──▶ xaq listen ──▶ claude -p … / your script
```

The package is `xaq-cli`; every example works without installing (`npx xaq-cli …`), or `npm i -g xaq-cli` and use
`xaq …`. One pairing per machine.

## Quick start

```sh
# 1. Pair this machine's agent. A human approves the code in the console.
npx xaq-cli connect https://mail.example.com --tool claude-code --setup-mcp

# 2. Try it in the foreground (Ctrl-C stops it), then send a test email from the console's "Check that it works" step.
npx xaq-cli listen --recipe claude-code

# 3. Keep it running in the background (systemd user service / launchd agent). This saves the flags.
npx xaq-cli listen service install --recipe claude-code
npx xaq-cli listen status
```

`--recipe claude-code` runs Claude Code confined to the xaq tools (no shell, no file or web tools, no other MCP
servers, project settings ignored) in a private working directory, and asks it to triage: act or tell you only when
the mail matters, otherwise reply `[SILENT]`. Its reply only lands in the listener's log. Any other agent runs through
`--exec '<command>'`; confine it as far as its CLI allows, and prefer draft-only grants.

## `connect`

```
xaq connect <daemon-url> [--name <name>] [--tool claude-code|codex|cursor|hermes|other] [--account <email>]…
            [--capabilities read,draft,calendar.read] [--reason <text>] [--setup-mcp] [--log <file>] [--insecure] [--force]
```

It shows a short code and a console link; someone with console access checks the code and approves, choosing the
mailboxes, capabilities and send mode (`--account` and `--capabilities` are only a request). The key is handed over
once, written to `~/.config/xaq/profiles/default.json` (0600) and never printed; `connect` then prints the access
actually granted and the next steps for `--tool`. `--force` replaces the pairing and keeps the listener settings and
cursor. `--log` also writes the output to a file (created 0600). Exit codes: 0 approved, 2 denied, 3 expired, 4
already consumed, 130 cancelled, 1 error.

`--setup-mcp` (or later `xaq setup-mcp [--dry-run]`) registers the MCP server in Claude Code without the key ever
being shown: `claude mcp add-json --scope user xaq` with a header helper (`~/.config/xaq/bin/mcp-header.mjs`) that
reads the key from the profile. `~/.claude.json` is backed up first. Other tools: point their MCP client at
`<daemon>/mcp` with `Authorization: Bearer <key>` (the `apiKey` field of the profile).

## `listen`

```
xaq listen [--recipe claude-code | --exec <command>] [--types <list>] [--not-from <glob>]… [--all-categories]
           [--include-body] [--dry-run] [--backfill]
xaq listen status
xaq listen service install [same settings flags] | uninstall | status
```

| Flag | |
|---|---|
| `--recipe claude-code` | The built-in, confined Claude Code command. |
| `--exec <command>` | Run this via `/bin/sh` for each event. |
| `--types <list>` | Comma-separated event types, or `all`. Default `message.received`. `thread.reply_received` is a subset of `message.received`: don't combine them, or each reply runs twice. `calendar.*` need `calendar.read`. |
| `--not-from <glob>` | Skip senders matching this glob, e.g. `'*@github.com'` (repeatable). |
| `--all-categories` | Don't skip Gmail's Promotions, Social and Forums tabs (skipped by default). |
| `--include-body` | Include the cleaned message body (calendar: the description). |
| `--dry-run` | Print matching events (and why others are skipped); run nothing, move no cursor. |
| `--backfill` | Run the mail from before the listener started through the command once, oldest first, then exit. Safe next to the running listener (own cursor and lock). |

The settings flags (all but `--dry-run` and `--backfill`) replace the saved settings as a whole for that run;
`listen service install` saves them, and `listen` without any uses the saved ones. Skipped events are acknowledged
and never run anything. `listen status` shows the pairing, the settings in use, the service, the key's access and
recent events. Plain http to a non-loopback, non-Tailscale daemon needs `connect --insecure` (a loud warning on
every start).

### What the command gets

- **stdin** and the 0600 file `$XAQ_EVENT_FILE`: `{ "notice": "…untrusted…", "event": <webhook payload> }`. Bodies are
  wrapped in `<email_content from="…" untrusted>` (`<calendar_content organizer="…" untrusted>` for calendar
  descriptions); subjects, names, filenames and labels are cleaned so nothing can forge those delimiters.
- **Environment**: only plain ids (`XAQ_EVENT_ID`, `XAQ_EVENT_TYPE`, `XAQ_EVENT_SEQ`, `XAQ_ACCOUNT`, `XAQ_THREAD_ID`,
  `XAQ_MESSAGE_ID`, `XAQ_CALENDAR_ID`, `XAQ_CALENDAR_EVENT_ID`). Event text never reaches the command line or the
  environment, and the listener's own `XAQ_*` variables are removed.

Exit 0 means done. A failure or a 300 s timeout (the whole process group is killed) is retried with backoff, 5 attempts
in all, then logged and skipped. Up to 2 events run at once; the daemon's cursor only moves past events that finished,
so delivery is at-least-once: dedupe on `XAQ_EVENT_ID`. The listener reconnects on its own, waits out reversible
refusals (agent disabled, no read access), and exits with code 78 when the key is revoked (the service doesn't
restart on 78): run `connect <url> --force`, then restart it.

### Running as a service

`listen service install` stages a stable install in `~/.local/share/xaq/app` (not the npx cache), writes one systemd
user unit (`xaq-listen-default`) or launchd agent (`sh.xaq.listen.default`) that captures this shell's `PATH`, starts
it, and checks that the service manager runs it; if the new listener doesn't start, the previous unit, install and
settings are put back. Re-run it to update. Set `XAQ_LOG_LEVEL=debug` before installing for a debug log.

## Files

| What | Where |
|---|---|
| Pairing and saved settings | `~/.config/xaq/profiles/default.json` (0600) |
| Log (rotated at 5 MB), status, lock | `~/.local/state/xaq/listen/default/` (`listen.log`, `status.json`, `listen.lock`; `one-off.log` for `--dry-run` / `--backfill`) |
| Command working directory | `~/.local/state/xaq/listen/default/work` (0700) |
| Claude Code MCP config for the recipe (no key) | `~/.config/xaq/mcp/default.claude.json` |
| Service install | `~/.local/share/xaq/app` |

`XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_DATA_HOME` move them, on macOS too.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Refusing plain http to …` | Use https or the daemon's Tailscale address, or an SSH tunnel (`ssh -N -L <port>:localhost:<port> <server>`, then `connect http://localhost:<port>`). |
| `Access revoked` (exit 78) | Run `npx xaq-cli connect <url> --force`, then restart the listener. |
| `Another listener is already running` | The service is running it: `listen service status`, or stop it first. `listen --backfill` runs next to it. |
| The service can't find `claude` | Re-run `listen service install` from a shell where it works. |
| The agent runs for newsletters | Add `--not-from '*@example.com'`; check with `listen --dry-run`. |
| Disconnects every ~45 s | A proxy is buffering the event stream; make it pass `text/event-stream` through unbuffered. |
