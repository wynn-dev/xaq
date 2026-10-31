# Follow-ups

Known non-blocking issues from the onboarding sweep (fresh-persona walks p9–p15, Oct 2026). v1 shipped as
`agentinbox-cli@0.1.0-nightly.32` (main f76dc0b) with these open.

## Wording and layout
- Setup step 8's "Setup complete" panel prints "Stop the one in your terminal first (Ctrl-C)" twice: once under the
  listener service command and once under the agentinbox service command. Each line means a different process, so
  name it in each one ("Stop the listener…" / "Stop agentinbox…").
- Step 8's "Keep agentinbox itself running" command includes the daemon's `--data` path. That's correct, but it
  looks odd when the data directory is a temp dir, as in the demo.
- Overview → Recent events: the "address · from Sender" line wraps onto two lines in the narrow card.
- Docs screenshots have no shot of step 8's completed view when the step is revisited.

## Behaviour
- `connect` prints `skill install … --url <url>` without shell-quoting the URL. A URL containing `'` or spaces
  breaks that printed command (the console quotes it).
- A listener's local filters (`--from`, `--label`, `--subject`) run only on the agent's machine. Events that the
  filters skip are still acknowledged, so the console shows them as "Delivered to …".
- Agent page → Recent tool calls filters the last 50 audit rows on the client. An agent with 50+ non-tool
  entries would wrongly show "No tool calls yet". Filter on the server instead.
- The service unit (`service install`, `listen service install`) records `process.execPath`, so upgrading or
  removing a version-managed Node (fnm, nvm, Homebrew keg) breaks the service. Install prints a warning; reuse
  `helperNode()` from `server/listen/mcpheader.ts`.
- `listen --types all` is saved as the expanded list, so event types added later won't reach that profile.
- Migration 6 backfills "setup verified" from `last_mcp_at`, which a bare `claude mcp list` health check sets, so
  an install upgraded between step 7 and step 8 counts as verified.

## Unverified against real Google (the demo uses a fake)
- Whether Google rejects a redirect URI that differs only by a trailing slash, and whether the client check
  catches it.
- Whether enabling `pubsub.googleapis.com` needs a billing account. Step 2 enables only Gmail to stay safe, and
  step 6 warns.
- The real unverified-app and Gmail-permission consent screens, and how Gmail labels the self-sent test email.

## Open decisions (Wynn)
- **Forums in the listener's default category skip.** Shipped default: Promotions, Social and Forums are skipped.
  Proposed: drop Forums from the default (Workspace Google Groups and team lists land there, and Gmail sets the
  label even with inbox tabs off), and have the console say "skipped by listener filter" instead of "Delivered to …"
  for events a listener skipped. Undecided; the default stays as shipped until Wynn decides.

## Calendar + listener-recipe round (Oct 2026)
- The calendar scheduler runs two SQL queries per second, even on mail-only installs.
- An RSVP retry after a 5xx can email the organizer twice.
- Calendar policy retry messages have edge cases; switch them to `isOutcomeUnknown` from the Calendar client.
- Calendar setup tests use their own fakes rather than the shared fake Calendar API in `test/fake-google.ts`.
- Removing an account waits behind the push-channel reconcile.
- Listener: `python3` is required, and on macOS the Xcode `python3` stub is a trap.
- Listener: any loopback `/webhooks/<name>` path gets the wrapped body, not only Hermes routes.
- Listener: Homebrew's `/usr/local/bin` (group-writable) is rejected as the service node.
- Listener: Hermes plugin and native toolsets can still be added to a confined `mcp-agentinbox` route by hand.
- The daemon's own `service install` still records the shell's node (see the service-unit item above).

## Calendar round: reviews and walks (Oct 2026)

### #44 grant editor (grants review)
- Calendar scope picker compares raw Google calendar ids with the server's lowercased stored ids; a mixed-case id
  would show the grant narrower than it is (`calendar-scope-picker.tsx:64`, `server/calendar/setup.ts:225`).
- "Only some" with nothing ticked, then calendar access removed: Save is allowed and the server 400s while the picker
  is disabled (`src/lib/grants.ts:138`).
- An unreadable stored `calendar_scope` becomes `[]`, so saving even a mail-only grant 400s with a confusing error.
- Switching "Only some" → "Every calendar" → "Only some" loses the ticked calendars.
- "Only some calendars" copy doesn't say free/busy lookups for any address stay allowed.
- Grant summary shows "N allowed recipients" on a calendar-read-only grant.

### #44 console agents UI (UX review)
- Events view `grantSees` lets calendar.read-only grants see `sync.gap`; server `canSeeEvent` doesn't
  (`src/components/events/calendar-event.ts:18`).
- Events view compares calendar scope by exact string; the server lowercases (`calendar-event.ts:21`).
- A temporary apply failure returns `pending` + error, but the toast says "Applied to Google Calendar" and the card
  hides `a.error` (mail path has the same issue: "Approved and sent").
- RSVP card: "Comment to the organizer" understates who sees it (all invitees); the guest list is hidden.
- Overview attention says "N messages are waiting" and "(no subject)" for calendar approvals.
- Update approvals show "" (cleared location/description) as empty / "(empty body)" instead of "removed".

### #42 MCP calendar (security review)
- `escapeDelimiters` (`server/mail/content.ts:119`) lets close-tag lookalikes through: markdown-escaped
  `</_calendar\_content_\>`, `<\/calendar_content>`, fullwidth `＜／calendar_content＞`. Allow `[\\_*/\s]` between `<`
  and the name; affects `email_content` too (pre-existing).
- `update_calendar_event` accepts `time_zone` without start/end, then policy rejects it; make schema and policy agree
  (`server/mcp/calendar.ts:376`).
- Event titles in lists can imitate the metadata line (`Standup · event_id: X · You organize it`); quote or label
  titles (`server/mcp/format.ts`).
- `calendar_bad_request`/`calendar_forbidden` pass Google's error text verbatim; clip it with `cleanLine`
  (`server/mcp/server.ts:134`).

### #42 MCP calendar (correctness review)
- `calendar_id` description says default "primary"; B's default is primary-if-in-scope, else the only scoped calendar,
  else `calendar_required`.
- `get_free_busy` description/SKILL.md: defaults to "your calendars" but a null scope queries only primary;
  "colleagues' addresses" is denied under a scoped grant.
- Pending calendar approval message says "check with get_send_status" twice (`agent.ts:577` + `formatCalendarWrite`).
- `describeCalendarError` maps 403 `rateLimitExceeded`/`userRateLimitExceeded` to `calendar_forbidden`; should be
  "wait and retry".
- No test covers moving a recurring series on update (patch without `timeZone` should keep the existing one).
- `formatWhen` drops the end weekday for multi-day timed events when `e.end` is empty (cosmetic).
- `summary` max length is 500 in the MCP schema and 1024 in B.

### #43 Add Google Calendar UI
- `offersMailOnly` (`src/components/accounts/connect-attempt.ts`): with Calendar on, a "Grant Pub/Sub" consent also
  asks for Calendar; under an admin block the mail-only button isn't offered though the server accepts
  `{mailOnly:true, scopes:["pubsub"]}`.
- Paste-callback mode: Add Calendar errors like `oauth_calendar_not_granted` stay inside `PasteCallback`; after
  closing, the result says "sign-in didn't finish".
- A mail-only account behind an admin Calendar block is asked for Calendar on every reconnect; the error should
  suggest Settings → Turn off.
- `step-project.tsx` `EnableApis`: the Gmail `CloudLink` lacks a `disabledReason`.
- Calendar dialog API step shows the `api_disabled` title whenever any consent result exists, not only that account's.
- "New: Google Calendar" notice shows on Overview for a new install that switched Calendar off in the wizard.
- A failed post-consent check derives its result line from possibly stale cached setup state.
- Accounts page title still says "Gmail accounts"; the wizard says "Google accounts".
- Event detail row (`calendarRows` in `src/components/events/event-row.tsx`) shows console-local time labelled with
  the event zone (a 14:00 Tokyo event reads "7:00 AM (Asia/Tokyo)" from Berlin).

### #46 Calendar G
- `test/webhooks-delivery.test.ts` "caps in-flight requests per webhook" is timing-sensitive (failed once under
  full-suite load).
- The listener SSE stream sends calendar events in frames named `event: mail`; rename to `calendar` or document it.
- `test/fake-google.ts` logs only request pathnames; tests can't assert `syncToken` query params or If-Match headers
  directly.
- The upgrade E2E rewinds a migrated DB to the old schema; an old-release fixture DB would be more faithful.
- `test/e2e-calendar.test.ts:359`: the "evented exactly once" check can't fail (`events.dedupe_key` is UNIQUE); count
  what a pre-upgrade listener/webhook receives instead.
- `test/e2e-calendar.test.ts:252`: the `/hooks/mail` "stays empty" check is vacuous; use a mail-only agent with
  `--types all`.
- Calendar E2E lacks `respond_to_invitation`, search, `get_free_busy` and a negative calendar-scope case for
  listener/webhook.
- `--not-from` doesn't skip calendar events while `--from` matches the organizer (`server/listen/event.ts:28`).
- `--types all --label X` lets every calendar event through; label criteria are ignored for calendar events.
- `cleanCalendarEvent` doesn't clean `iCalUID` (sender-controlled via ICS import) (`server/listen/event.ts:50`).
- A status-0 timeout on token refresh is reported as "maybe sent" though the send never left
  (`server/mail/agent.ts:709`).
- Unreachable network/host on an already-open connection could be "maybe sent" for sends
  (`server/google/http.ts:113`).

### New-install walk (Priya)
- `docs/reference.md` Features list omits the calendar MCP tools; "Google Cloud setup in brief" omits enabling the
  Calendar API.
- Claim page says only "connecting Gmail and your first agent".
- Step 3: Data access section is "Optional" before an audience is chosen, "Recommended" after.
- Step 6 doesn't say Calendar is polled every 60 s whatever is chosen there.
- Step 7 intro: "the AI tool that will read your mail".
- Access summary (step 8, agent page): "Can read; can't change or send anything · … writes need your approval"
  contradicts itself.
- Step 8/listener copy doesn't say calendar invitations don't wake the agent by default (needs `--types`).
- Overview/Approvals tile say "1 message" for a calendar approval (`src/components/overview/attention.tsx:58`).
- Toasts still Gmail-only: "Mail starts syncing now." (`connect-host.tsx:412`, `accounts.tsx:30`), "Your agents can
  use Gmail now." (`get-started.tsx:91`).
- `list_calendar_events` requires `time_min`/`time_max`; an agent's first bare call fails.
- Sidebar: "Gmail for your agents", "Gmail accounts".
- Persona walks: headless shell needs a font (`FONTCONFIG_FILE`) or every screen renders blank.

### Upgrade walk (Wynn, from nightly.34)
- Console/Overview rows say "Delivered to <agent>" for events the listener skipped
  (`src/components/events/event-row.tsx:132`); pending Wynn's call (show "skipped by listener filter").
- Forwards to Hermes-looking URLs changed from `{type,timestamp,data}` to `{type,notice,event}`; route
  prompts/`--script` filters reading fields break silently (docs/listen.md "Upgrading an existing listener" now says
  so).
- The console shows the listener's CLI version but doesn't flag an outdated one.
- The new server's startup log says nothing about the migration or Calendar.
- Wizard final step says "open an agent, then Access → Calendar"; the UI is Mailbox access → Edit → Calendar.
- The Apply toast for a newly created event says it "is updated" (`approval-card.tsx:44`).
- Overview "Mail events" count includes `calendar.event_created`.
- The listener's "Access changed" note after `calendar.read` doesn't say calendar events need `--types`.
- Agent page shows "Last used 26 seconds ago" next to "Not called yet": the listener's key use counts as "used".
- `listen hermes` only knows the route names `agentinbox`/`agentinbox-<profile>`; it can't adopt or confine an
  existing custom route.
- The listener's unconfined-route warning only checks `/webhooks/<name>` routes in the current Hermes home;
  `/p/<profile>/webhooks/<name>` routes aren't looked up.
- `listen … --save` while the profile's service runs saves the profile, then stops on the profile lock; the service
  keeps its old settings until `listen service install`.

### #47 walk fixes (review)
- `server/listen/hermes.ts:247`: the debug line includes the JSON parse error text; Node 24 can quote a file snippet, so an unquoted `whsec_…` could leak ~10 chars into the 0600 log (same as `verifyRoute` before). Log only the error name and position.
- `server/listen/options.ts:327`: the "now skipped by default" note fires on every start for any profile on the default (fresh ones too), not only profiles saved before the default.
- `src/components/approvals/pairing.tsx:319`: presets say "No calendar access" while `presetGrant` keeps calendar caps carried over from Custom ("Plus calendar: …" below).
- `server/listen/hermes.ts:252`: the placeholder regex misses `{ __raw__ }` with spaces (only matters if Hermes accepts that).
- `server/listen/admin.ts:81`: `listen status` reads HERMES_HOME from the calling shell, which may differ from the service's.
- `docs/listen.md` Upgrading: says a placeholder-free route "that runs its own --script or fires a cron job" gets no warning; the code needs only the placeholder-free prompt.
- `server/skill/SKILL.md:49` still says Read only covers "get events" (same mail-vs-calendar ambiguity as the old pairing copy).

### #48 launchd bootstrap race (review)
- `bootstrapLaunchd` prints nothing while it waits for launchd to unload the old job (up to 30 s, plus retries); a "waiting for launchd…" line would help.
- No test covers the unload budget expiring ("still loaded and wouldn't unload"), and no listener test covers the new backoff.
- `server/listen/service.ts`: `const why = commandFailure;` is a leftover alias.

### #50 mail attachments
- A valid key can send a 36 MB `/mcp` body even when that agent has no draft or send grant; consider a capability-aware or per-agent concurrency limit.
- Peak memory for a 25 MB send is several copies of the file (~150–200 MB); stream the composer output.
- The 512 KB switch to Gmail's `/upload/` endpoint is a guess (Google doesn't document the JSON `raw` limit); check against real Gmail.
- Workspace accounts can have admin-set or 50 MB limits; the fixed 25 MB cap ignores them.
- `create_draft` doesn't echo the cleaned filenames back to the agent.
- Forwarded original filenames aren't run through the new filename cleaning.
- `formatSize` uses MiB while the 25 MB cap is decimal ("23.8 MB" for a file just over the cap).
- SKILL.md: an empty filename becomes `attachment.<ext>` when the type is known, not `attachment`.
- `uploadTimeout`: a full 25 MB message gets ~161 s (needs ~1.7 Mbit/s upload); slower links report "may have been sent".
- No test for a timeout/status 0 on the `/upload/` path, or a threaded reply/send through multipart end to end.
- `server/mcp/index.ts` keeps its own `bearer` helper; `app.ts` uses the one in `agentapi/auth.ts`.
- A near-25 MB message with lots of `\uXXXX`-escaped non-ASCII body text can exceed the 36 MiB MCP limit (413 instead of the plain-words size error).
- Any valid key gets the 36 MB body limit (read-only agents too); one request peaks at ~250–300 MB and concurrency is unlimited. Limit large bodies to agents with a draft or send grant, or cap concurrent large requests.
- `mime_type` isn't compared with the extension (an `.html` file can be labelled `application/pdf`).
- Look-alike dots (U+FF0E) in filenames pass the blocklist (Gmail's own content check is the backstop).
- `draftFingerprint` doesn't hash attachment bytes, so a same-size swap made in the Gmail UI wouldn't be caught (pre-existing; no agent tool can do it).
- Attachment filenames: only strictly valid encoded-words are refused; a client tolerating spaces inside one (`=?UTF-8?Q?evil .exe?=`) might show `evil .exe`. Refusing any name with `=?` … `?=` would close it.

## MCP broker build (Oct 2026)

### Notion preset (#54)
- Enable the proxy smoke test once the fake upstream is on main, and check the real delete-tool argument names against a live `tools/list`.
- Notion's tool page has no read/write labels; only the two delete tools carry `destructiveHint`. The table follows the descriptions.
- `notion-update-data-source` (drops omitted options) and `notion-update-folder remove_files` count as edits, not risky; confirm with Wynn.
- `notion-spawn-session` / `notion-send-message-to-session` (Notion's own agents) count as edits.
- `notion-ai-search` is unlisted but callable by name upstream; the broker only exposes listed tools.

### Schema (#53)
- `AccessLevel` and `ToolAnnotations` are defined in both `shared/types.ts` and `server/broker/types.ts` (the shared copy adds an index signature); keep one source of truth and re-export it.
- `UpstreamToolDefinition.description` is optional while `ToolDef.description` is required; `McpCallResult.content` is `unknown[]` vs `ToolResult.content: ContentBlock[]`. Align them.
- A connection mid-OAuth has no status of its own (it uses `needs_reauth` plus a reason).
- `CredentialStore.clear()` wipes the client registration too, so a reconnect re-registers via DCR (Notion warns that this orphans earlier grants).
- `owner_id` exists only on `connections`; add it to agents and the other tables before multi-user (M4).
- Schema: the `?? ""` and empty-object fallbacks for `connection_id`/`tool_call` in `mail/approvals.ts:93` hide corrupt rows; throw instead.
- Connection URLs are stored plaintext and shown in the DTO; capability URLs with tokens in path or query need care.

### Notion (#54 review)
- `notion-update-data-source` silently drops omitted select/status options; it's an edit under the rule, but document it.
- The `targetPath` candidate names are guesses; check them against the live `inputSchema`.
- The console path in the setup text ("Settings, Notion MCP, Manage workspace clients") is unconfirmed.
- Connections owned by a workspace admin expose only 24 tools (no delete, restore, sidebar or Skill tools).
- The plan says Notion labels tools read/write; it doesn't. The classes come from our own reading of each tool.

### Search mode (#58)
- Delete orphaned `broker.search:<agentId>` settings rows when an agent is deleted.
- Console control for the hot list (the mode has one on the agent page, with the suggestion above about 30 tools).
- An agent created with the CLI before the daemon's first start is pinned to direct by the upgrade step, like an existing one.
- The plan's "10K tokens" trigger isn't implemented; only the tool count is.
- The done-when "at least as often as listing every tool" needs a model-in-the-loop eval; the offline eval measures retrieval only.
- `INSTRUCTIONS` says "Start with list_accounts", which is hidden in search mode (reachable through search).
- `search_tools` returns a JSON text block; add `structuredContent`.
- The eval's top-5 is 92.9 %, one task above the bar; misses are a Notion database insert, "open GitHub issue 123" and "file a bug".

### WHOOP (#57)
- With webhooks live, the poll and the webhook use different dedupe keys, so one change can produce two events.
- Confirm the ±5 min signature tolerance against WHOOP's real retries.
- Check with a real account whether WHOOP accepts an `http://localhost` redirect.
- One webhook URL per WHOOP app: connections sharing an app would cross-deliver; check the WHOOP user id per connection.
- Date-only arguments are read as UTC days; use the user's local day.
- Call `DELETE /v2/user/access` on disconnect.
- A WHOOP 403 is a tool error with a reconnect hint, not `needs_reauth`.
- `private_target` rejects `[`, so IPv6 literals (e.g. `https://[::1]:3000`) can't be private targets; allow canonical bracketed IPv6 later.

### SDK spike (#55)
- The fake answers 2026 notifications with 202 before checking headers; it doesn't enforce `token_endpoint_auth_method` or `scope` on refresh; it doesn't check `x-mcp-header` parameter headers.
- ADR 0001: reword the claims about -32022 retry, `x-mcp-header` mirroring and MRTR (untested), and the v1 column (from an uncommitted harness).
- `docs/MCP-BROKER.md` M1 row 4 still says "SQLite `OAuthClientProvider`"; the ADR uses a broker-owned `AuthProvider` with its own token requests.

### Catalog (#59)
- Signals, instruction text and the last error are in memory only (schema has columns for `tools_cached_at` and `instructions_hash` only).
- Changes past the 1 KB description cap aren't detected (the hash covers the cleaned text).
- A connection restored from the DB is re-pinned only when something re-attaches it.

### Policy (#61, UX review)
- Requeue error text is owner-facing but shown to the agent in `get_call_status`; split the wording.
- A call that provably never left goes back to pending without a new event and keeps its original expiry; retry after `retryAfter` or extend the expiry.
- The outcome-unknown text after a timeout repeats itself and says "interrupted".
- The cancelled text (e.g. after a pin change) doesn't say whether to call again; the cap denial doesn't say when the window frees up.
- Rules filter on `created_at` vs the grant and `first_seen_at`; grant writers must preserve `created_at` on level changes, timestamps must be ISO, and `listRules` can show ignored rules.
- With `brokerUpstreams` off, approving an `mcp.call` says "Update agentinbox"; it should say upstream connections are off.
- Target values are matched exactly, so the same Notion page id with or without dashes, or as a URL, asks again.
- Classifier: adjectival participles in descriptions ("paid workspaces", "were deleted", "removed") cause false positives (~30 % on unannotated Notion); consider sentence-initial verbs only.
- Classifier: `reply` in names makes GitHub inconsistent (`add_reply_to_pull_request_comment` asks; `add_issue_comment` doesn't).
- Filesystem `edit_file` / `move_file` ask because the server annotates them destructive (follows the plan, UX cost).
- Public publishing judgment calls go through: `create_gist public:true`, `create_repository private:false`. Decide whether these count as "publish externally".
- Stripe `finalize_invoice` (can charge) and Twilio-style `CreateMessage` (sends SMS) aren't caught; candidates for presets.

### Rename (#60)
- Detect an old job that is loaded but has no plist (via `launchctl print`) and give a clear error.
- Listener rollback: stop the new listener before `swap.restore()`.
- `scripts/rename-xaq.mjs`: list new `process.env.AGENTINBOX_*` uses in non-hand-written files for review, instead of renaming them without a fallback.
- `server/api/system.ts:154` comment says "~/.xaq" where it means `~/.agentinbox`; add `rename-xaq: keep` markers to lines like it.
- `server/listen/recipes.ts` texts say "xaq tools" for old profiles still named `agentinbox` (cosmetic).

### Policy (#61, security review)
- Scrubbing doesn't cover URL-encoded, JSON-escaped (`\/`) or base64 tokens, tokens split across blocks, or image/blob data.
- `output.ts`: `mimeType` and `uri` are cleaned but not delimiter-escaped.
- `stripInvisible` keeps U+034F, so `<͏/email_content>` passes unescaped (predates the PR; affects mail too).
- `structuredContent` strings are escaped but not nonce-wrapped.
- 2019-09 schemas compile with Ajv2020; draft-04 schemas fail closed (those tools are unusable). Document it.
- "Exact bytes" means the exact JSON value: `JSON.parse` reorders integer-like keys before re-serialising.
- `blockedReason` doesn't check that `brokerUpstreams` is still on.

### Console (#65)
- No `connection` stream message: the Connections page polls every 60 s.
- The agent step's text still talks about mail on the Notion/WHOOP/custom path.
- No link back to the "what to connect" choice once Gmail & Calendar is picked.

### Upstream (#62, correctness review)
- `startConnect` stores a new registration (or pasted pre-registered client) before consent; an abandoned Reconnect can break refresh. Store it in `finishConnect`.
- Discovery treats the MCP origin as the authorization server when there's no protected-resource document; the draft spec says abort or use pre-configured values. A failing `resource_metadata` URL still falls back to well-known.
- A cached 2026 verdict isn't passed back as `prior`; the verdict expiry uses `Date.now()`, not the injected clock.
- Pooled clients aren't re-checked for `disabled`/`needs_reauth` (relies on `invalidate()`); after `invalid_grant` each call retries the dead refresh token.
- Two calls seeing a lost session can race and close each other's fresh session.
- Notion's 30-day `idleDays` isn't implemented; the `connection.expiring` dedupe lives in `audit_log` (pruning re-sends warnings).
- A pasted pre-registered client is used even when the issuer changed; `probe` leaves an unclosed session on 2025 no-auth servers.

### Endpoint (#63, agent-facing review)
- `get_call_status` is listed for any connection grant, even full/read only; it disappears once the last grant is removed while results are still stored.
- `connectionGrantsOf` doesn't filter disabled connections (they appear in instructions); `visibleConnectionIds` doesn't filter disabled agents.
- `brokerInstructions` says tools are "prefixed with its name"; the prefix is the slug.
- Catalog: a risky verb straight after a read prefix is exempt (`fetch_delete_messages` is a read); unlikely from honest servers.
- Catalog: `cleanSchema` tests the raw key against `description`, so a zero-width-split `description` key skips the 256 cap (still stripped, under 32 KB).
- Catalog: when every stored tool comes back refused (invalid definitions), the old definitions keep being served and nothing is audited; record a `connection.tool_changed`-style audit entry, or drop them. (No hold exists since 2026-10-16.)
- The doc says bare `pay` isn't matched in descriptions; the code includes it (stricter). Fix the doc.
- The `readOnlyHint` residual risk is undocumented; the description check is skipped when only `readOnlyHint: false` is set; names are classified raw, not cleaned.
- Upstream: the 16 MiB body cap counts across a whole long-lived SSE stream (legacy HTTP+SSE carries every result on one GET).
- Upstream: `source.ts:237,240` puts the SDK's error message into `SourceError` unscrubbed (BrokerCalls scrubs errors; keep it that way).
- Upstream: `canonicalPrivateTarget` accepts trailing-dot hosts (`localhost.:80`), cosmetic.
- Upstream: `insufficientScope` is shared across concurrent calls (a race can blame the wrong call); the undici Agent pool evicts its oldest at 16 (can close a live SSE stream).
- Plan doc says the DNS-pinned IP must still match after every resolution; the code accepts any allowed-range IP for the allowed host. Align them.
- `slack_complete_file_upload` gets through if Slack annotates it (the description check is skipped); needs a Slack preset that marks it risky when a channel is set.
- Unannotated Notion descriptions trigger on base verbs used otherwise ("share that parent", "Send the raw archive bytes"); the Notion preset decides by name, so the impact is low.
- `slack_get_file_upload_url` is listed at the read level when unannotated (harmless alone); `slack_update_canvas` asks because of "wipes" in a warning sentence.
- `probe` on a bare origin (e.g. forge's T3 without `/mcp`) answers `{auth:"none"}` because `POST /` is a 404; report a non-MCP 404 instead. The plan's Hermes table lists T3 URLs without `/mcp`.

### Endpoint (#63, correctness/security reviews)
- `EventType` collapses to `${string}.${string}`: `Record<EventType,…>` no longer forces labels for native types and typos compile; use `Record<NativeEventType | BrokerEventType, …>`.
- `filter-builder.tsx:22`: toggling a type in the console drops non-native types already on a webhook; `listen --types all` means native only; `list_events`/`wait_for_events` enums are native-only; `/api/events` error lists native types only.
- PUT private-target on an IPv6 URL returns 500 (the CHECK forbids `[`); return a clear 400.
- PUT private-target reads `conn.url` before `await readBody` (a concurrent PATCH can pin the old origin).
- `approval.requested` via webhook ignores the webhook agent's disabled flag at delivery; it's visible to any enabled agent's webhook (requester name, tool, approve link).
- `emitIntegrationEvents` doesn't check `preset.events.types.includes(e.type)`.
- Creating from a native preset with a `url` stores the unused URL.
- The approvals path has no `brokerUpstreams` check (fails later because `source()` is null).
- A slug PATCH doesn't call `notifyAgent`.
- Upstream: every Connect on a never-signed-in connection registers a new DCR client; concurrent Connects leave an unused client behind (harmless).
- Upstream: `setPending`/`pending()` in `store.ts` and the `discovery_enc` column have no callers left.
- Upstream: add a test for the full step-up sequence (401 scope → 403 insufficient_scope → reconnect with the union), with and without `scope` in the token response.
- Console: grants are a read-modify-write per connection; concurrent edits can lose an update (add a per-agent PATCH or a version check).
- Console: `GetStartedPage` shows the chooser instead of the error when the setup-state query fails.
- Console: `McpCallCard` shows "changed kind; reload" if `brokerUpstreams` is turned off while an `mcp.call` is pending.
- Console: on mobile the sha256 line is truncated; after a 409 the done screen can say "Approved, and always allowed" when no rule was made.
- Console: the private-network allow shows the hostname, not the resolved IP; for a public name resolving to a private address, show both.
- `/mcp` advertises `readOnlyHint: cls.read`, so unannotated get/list/find tools are advertised read-only (clients may auto-approve them); they're non-risky anyway. Document it, or set true only for preset- or annotation-sourced reads.
- After a kill, the connection's tools stay listed and the instructions still say "full access"; add "(turned off)".
- No test for the handler-install fallback (hide `_requestHandlers`, check native tools still list).
- A URL edit runs `cancelForConnection` inside `db.tx`, so bus emits and audit writes happen inside the transaction (fragile).
- After an interrupted call, the text says "may or may not have run" even when the source was closed locally and the call never left.
- A header or OAuth connect re-activates a killed connection (Reconnect undoes Kill); document it.
- Header or no-auth connect re-activates a killed connection while `runtime.startConnect` refuses disabled ones; make it consistent (Reconnect deliberately re-enables; document it).
- Event `detail` sent to agents isn't delimiter-escaped (`format.ts:427`) beyond `cleanLine`; `approval.requested` deliveries to a now-disabled agent's webhook still go out (`access.ts:53`).
- Console UX: for a generic share/send tool, "Always allow" defaults to "Any call"; defaulting to the recipients is safer. "Only for these 2 items" doesn't list them.
- Console UX: on a phone the pinned button area covers about half the screen; the sidebar shows "Get started 0/8" before a path is chosen; closing the OAuth pop-up leaves "Waiting for Notion…" spinning; the expiry badge rounds up; the sidebar tagline still says "Gmail for your agents".

### CLI (#66)
- `/kill` deletes credentials and there's no enable route; turning a connection back on is console-only.
- OAuth servers needing a pasted client ID: the connect input has no field, so the CLI points to the console.
- The preset view doesn't expose a header preset's header name or prefix (the CLI defaults to `Authorization` or takes `--header`).
- Claude Code removals run one `claude mcp remove` per entry after the add (not atomic; a failure leaves a duplicate, never a gap).
- Import leaves old secrets in `~/.hermes/.env` and prints which can go.
- `test/webhooks-delivery.test.ts` "caps in-flight requests per webhook" flakes under full-suite load.
- API: a new or unfinished OAuth connection is `active` until consent; add a real "not signed in"/pending status (the console infers it today from "never listed tools").
- Console: with `opener` null, the callback page can't close itself; on a console origin different from `publicUrl` the BroadcastChannel can't reach it either, so the pop-up stays open until focus/close.
- Console: `finishPasted` doesn't check the returned connection is the one being signed in (pasting another sign-in's address shows "connected" for the other).
- Console: after a network failure on `/connect`, "Try again" retries without the typed key (start over with Reconnect).
- Search: `brokerSearchable` skips the `listableTools`/`nameOk` filter, so a tool with an invalid schema is hidden in direct mode but searchable/callable in search mode (policy still applies).
- Search: an agent with connections, no visible tools and 5 hot tools gets 6 direct tools (`get_call_status` always added).
- Import: a retired server that still answers (t3code-worldstream) gets a pending connection forever and its Hermes entry is never removed; add `--skip <name>` or a per-entry choice.
- Import: re-running right after a reconnect can still show 0 tools (entry removed only on a later run).
- Import: every new connection logs "listing tools failed … private address" because the catalog lists before the allow is set; set the allow at create time.
- `upsertYamlServer` still ends the block at a column-0 comment, so a `setup-mcp --tool hermes` re-run refuses (safely) when the old agentinbox entry contains a column-0 comment; use `mcpServersBlock` for `end`.
- `cutEntries` drops comment lines at the very end of the block when the last entry is removed (comment loss only).
- Static `platforms.webhook.extra.routes` detection, and t3code-worldstream: the import still creates a pending connection for a retired server that answers; add a per-entry skip.
- CLI: when the browser fails to open (e.g. `open` uses its bundled `xdg-open`), nothing says so; the command just waits after printing the link.

### Rename (#60, delta review)
- `serviceInstallInput` carries `PORT`/`HOST` over only from the old agentinbox unit; a later plain `npx xaq-cli service install` resets to `0.0.0.0:8425` (pre-existing behaviour). Carry them from the installed xaq unit too.
- The script renamed "Wynn's config" fixtures to xaq names; keep one fixture with the old names (`agentinbox` entry, `${AGENTINBOX_API_KEY}`, `mcp-agentinbox`) via `rename-xaq: keep`.
- `import.ts` `SELF_NAME` skips any third-party server named `xaq-*` or `agentinbox-*` as if it were ours.
- The listener's user-agent is now `xaq-cli/<v>`; an unmigrated daemon shows its version as unknown.

### New-user broker walk (Oct 2026)
- Gmail wording remains for non-Gmail users: the "Gmail for your agents" tagline, "Gmail accounts" in the sidebar, the password page, "the AI tool that will read your mail", an Overview full of mail counts; the agent's tool list includes Gmail tools with no Gmail account connected.
- The Notion dialog example says `notion__search`; the real name is `notion__notion-search`.
- After naming a connection, the console can still show its host as the name.
- The approve page says "This action can't be undone" for `notion-delete-pages` (moves pages to Trash).
- "The next step checks that it works" after creating the agent, but Finish setup goes straight to Overview; an abandoned pairing request stays as a banner until it expires.

### Walk fixes (#71) and re-walk
- Approve page says "This action cannot be undone" for tools that move to Trash (notion-delete-pages); make the copy depend on the tool, or say "may not be reversible".
- The console create-agent form doesn't list the "All agents" connections the new agent will inherit; no console control to see or turn off "All agents" on a connection (API only).
- The refresh route calls `attach()` (aborting an in-progress listing) then `refresh()`; `refresh()` alone suffices when attached.
- The `/approve/<id>` pending text has a stray space before the period.
- A direct `/mcp` call to a killed connection's tool says "No tool named…" (dynamic dispatch only holds listed tools), not the "turned off" message; `service.ts:233` comments say otherwise. Same in search mode.
- `/mcp` instructions still list a disabled connection (from grants).
- Upstream `notifications/tools/list_changed` → `requestRefresh` isn't wired (the remote source has no notification hook); tool changes surface on the 10-minute timer or the Refresh tools button.
- `/me` lists grants on turned-off connections with no status (`listen status` shows them as usable).

### Directory ownership (#74 review)
- `server/listen/paths.ts` header comment says `$XDG_*/xaq-cli`; the code uses `xaq`.
- `server/config.ts` `DATA_MARKERS`: `master.key` is a generic name; a foreign `~/.xaq/master.key` would count as ours and be read as the master key. The db and lock markers suffice.
- `server/config.ts` `OWN_ENTRY`: a macOS `.DS_Store` counts as foreign, so the daemon skips tightening the dir and `clearOwnInstall` refuses a partial `app.new`/`app.old` (safe rollback, clear error). Ignore `.DS_Store`.
- `server/auth/setup-token.ts`: a foreign `~/.xaq/setup-token` of 8–128 alphanumerics would be adopted and printed in our setup link.
- `server/service.ts` `isOurServiceEnv`: a foreign `service.env` holding only keys we know is parsed and then overwritten.
- `server/listen/lock.ts`: a non-empty unreadable lock now throws instead of being taken over; a lock truncated by a crash must be deleted by hand.

### WHOOP without webhooks (blocker round)
- The Funnel command was checked against Tailscale's docs and source, not on a real tailnet.

### Blocker round (#75 review)
- `reachability.ts` matches the Funnel target exactly against `http://127.0.0.1:<port>`; a `localhost` target isn't detected, so the offer keeps showing.
- A launchd PATH may not include Homebrew's `tailscale`: no Funnel offer then (polling still works).
- `GET /api/agents/:id/tool-mode` builds a full MCP server just to read the mode.
- `broker.search:<agentId>` rows aren't deleted with the agent.
- The tool-mode PUT can't set an agent back to `auto`; document it.
- `handleWebhook` marks a record pushed before the route has emitted it; a failed emit relies on WHOOP's retry.
- A re-score WHOOP stamps within 5 minutes of a push isn't announced again (`PUSH_SLACK_MS`).

### T3 Code preset (#76 reviews)
- `t3_project_create` (normal write) takes the same `scripts`/`runOnWorktreeCreate` that makes `t3_project_update` risky; make them consistent, or note that T3's Full access gates it.
- `t3_project_clone` writes a directory anywhere on T3's machine (`destinationPath`); note it or make it risky.
- `html_preview`/`html_render` inline local files by absolute path and load any URL; `preview_navigate` + `preview_snapshot` can read internal web UIs; `preview_snapshot` (a read) can read tabs the user opened. Document as accepted.
- `request_secret` can show the user a misleading secret card (the value never reaches the agent).
- `requireSameOrigin` skips `revocation_endpoint`; add it before revocation lands.
- Unique names have no unique index (concurrent creates can race); the create check uses `owner_id IS NULL` while PATCH uses `before.ownerId`.
- Switching an expired OAuth connection to a static header doesn't clear `expires_at`, so the policy keeps saying "expired".
- `connectionStatusView` shows "Error", not "Expired", for an `error` connection past its date.
- The non-expired reconnect message renders "…work again: <url> . Nothing was sent…".
- `presetServerUrl` throws `SourceError` in the create handler: a URL with userinfo probably returns 500, not 400.
- `registry.ts:24`/`catalog.ts:43` type the preset as `Pick<…,"classify">`; add `nameCheckExempt` to the Pick.
- The list card shows neither the scopes, the expiry date, nor that it's T3 Code; the detail page says "in N days", never the date.
- A fresh connection reads "Needs a reconnect in 30 days" while `expiresInDays` is 29.
- The generic "Ask before risky actions" copy says sending waits for approval; T3 thread sends don't. Add a T3 line.
- Setup step 4 says "not a failure in the middle of a task", but the call does fail (cleanly). Reword.
- T3 default connection name is `host:port`; "T3 Code (host:port)" would read clearer (one line server + console).

## Extensions round (Oct 2026: #79–#82, xaq-extensions #1–#4)

### Store and supply chain (#81)
- The scrubbed git env drops `SSH_AUTH_SOCK`, `HTTPS_PROXY`, `SSL_CERT_FILE`/`GIT_SSL_CAINFO`: private ssh repos and proxied networks can't install. Consider passing those through.
- `git fetch` has no disk cap; the timeout kills only `git`, not `git-remote-https`/`ssh` children.
- A 40-hex ref skips the GitHub API, so a fork-only sha is shown under the typed owner/repo: say "may belong to a fork".
- Registry index and GitHub API bodies are read in full before the size check.
- `fetchLocal`: a file swapped for a symlink/FIFO between `lstat` and read; directories aren't counted toward a cap.
- Refused install attempts (`changed`, `third_party_unconfirmed`, `integrity_mismatch`) aren't audited; an identical reinstall is audited as an install.
- `COMMIT_RE` is 40-hex only (SHA-256 git repos fail unclearly); GitHub ref splitting picks the shortest prefix (tag `x` over branch `x/y`).
- Read-only install dirs make a plain `rm -rf ~/.xaq` fail; document it.
- xaq-extensions CI runs the PR's own `build-index.mjs`: put `scripts/` and `.github/` under CODEOWNERS or run the check from the base. A push-to-main base check only catches a bad pin after merge.
- `text`/`eol=crlf`/`ident` attributes also change tarball bytes (fails closed); `validate.mjs` could refuse them.
- The local-dir update diff shows a meaningless commit row; a third-party GitHub add fetches twice (2 of 60 API calls/hour).
- The console "Add from URL" placeholder could mention registry names.

### Manifests and migration (#80)
- Unique names have no unique index (concurrent creates race).
- `{{` in an https link (`https://{{publicUrl}}`) is accepted and renders oddly.
- A manifest `input.pattern` compiles in the admin's browser: a catastrophic regex can freeze the tab.
- `built` preset cache in `integrations/index.ts` isn't pruned on remove/update; `relist` runs twice after a pinned install.

### Code-extension host (#82)
- Re-check `CODE_EXTENSION_NODE_FLOOR` after Node's Oct 21, 2026 security release (rated High on all lines).
- With `TRUST_PROXY`, a child connecting over loopback can forge `X-Forwarded-For` (same as any local process): document it.
- `user_app` token/authorize requests use global `fetch` (no private-address guard); the exchange accepts a grant with no refresh token (fails only at first expiry); `xaq/credentials/get` isn't rate-limited.
- The in-flight cap of 8 is shared by tool calls and prompts/resources fan-out.
- `EVENT_TYPE_RE` allows a 24-character prefix while names can be 32.
- Template expansion decodes `%2F`/`%25` in variable values; worth a test.
- Code connections marked `error` aren't in `runtime.start()`'s refresh tracking.
- `void reloadExtension(name)`-style calls should `.catch`.
- `/connect` right after creating a code connection kills the child mid-listing (heals on callback); a new code connection is `active` and spawns before sign-in.
- After an integrity failure, install and update say "installed"/"up to date" (DB integrity, not files): the only way out is a forced remove + add. The agent is told "may or may not have run" though the child never started.
- Unreachable WHOOP-era webhook code remains in core (`server/integrations/hooks.ts`, `server/broker/reachability.ts`, `server/app.ts`); the `https_localhost` redirect mode is never wired.
- Registry-unreachable message only shows from Get started → Notion, not from Connections → Add; it uses the id ("notion"), not the display name.

### WHOOP extension (xaq-extensions #3)
- Records cached more than ~8 days back are only re-checked by the weekly rebuild or `sync_now` (deletions, re-scores, late edits).
- An incremental load finishing after a background rebuild can overwrite the newer `builtAt` (extra requests, no data loss).
- `sync_now` on a cold start can exceed the host's 60 s; a cold load over a year of history is ~50 s.
- Fixtures lack DST, workouts across midnight, two main sleeps in one cycle, and records edited between warm loads.
- Tool descriptions and server instructions still mention "the dashboard" (kept verbatim for `tools/list` parity).

## Console self-update (W69, T662)

- **The shrinkwrap is npm's resolution, not pnpm's.** `scripts/shrinkwrap.mjs` resolves `package.json`'s ranges with
  npm at publish time, so a release's `npm-shrinkwrap.json` can pin newer patch versions than `pnpm-lock.yaml`, which
  CI tested. Either generate it from `pnpm-lock.yaml`, or run the tests against an `npm ci` of the shrinkwrap before
  publishing.
- **The publish step is unverified until the next nightly.** The steps were run locally: shrinkwrap, `npm pack`,
  install the tarball with `--ignore-scripts`, the shrinkwrap check and `npm audit signatures` all passed. The real
  publish (OIDC, provenance) hasn't run with it yet. Releases from before it have no shrinkwrap, so updating to them
  is refused.
- **The job doesn't rewrite the unit file.** A release that changes the unit (new environment variables, flags,
  `OOMPolicy`…) still needs `service install`. The job could re-render the unit with the new version's CLI after
  the swap.
- **"Go back" keeps the current database.** Restoring the pre-update snapshot is manual: every job snapshots into
  `<data>/update/snapshots/<started>-<kind>-<from>-to-<to>/` and the newest 3 are kept, so the one from before an
  update survives a go-back. If a migration ever stops being additive, "go back" has to restore the snapshot, or
  refuse. (W75: the single `db-snapshot/` that every job overwrote is gone; one left by a job from before W75
  stays where it is until removed by hand.)
- **Listeners aren't covered.** The console could show listeners that run an older version than the daemon.
- **A job that dies mid-run** leaves `status.json` at `running` (and its `update/lock`). Another update can start
  at once when the job's process is gone, or after 30 minutes. A stuck stop or start isn't timed out by the job
  itself (systemd's own timeouts apply), and a job hung for over 30 minutes no longer blocks a new one: on macOS
  the new launch is then refused while launchd still runs the old job, on Linux `systemd-run` refuses the unit
  name. (W75 closed the race where two requests at once could both start a job.)
