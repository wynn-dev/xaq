# Google Calendar: design and work split

Status: **shipped.** Calendar sync, the MCP calendar tools, calendar access through the account's grant, calendar
events for webhooks and the listener, and the console's "Add Google Calendar" setup are all on `main` (#37–#46).
Approvals, calendar scopes, write modes, reply-only and send caps were removed later (one permission model:
full or read, plus the recipient allowlist); the sections below say what remains. The rest of this document is the design they implement; the
"Review amendments" section at the end overrides earlier sections where they differ. "Contract map" and "Work split"
record how it was built (as of the contract PR), not what is stubbed now.

## Google facts

Checked against Google's docs on 2026-10-16.

**Scopes.** Calendar scopes are listed at https://developers.google.com/workspace/calendar/api/auth.

| Scope | Covers (per method reference pages) | Class |
| --- | --- | --- |
| `calendar.events` | events list, get, insert, patch, delete, watch, on **every** calendar the user can access ([list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch), [watch](https://developers.google.com/workspace/calendar/api/v3/reference/events/watch)) | sensitive |
| `calendar.calendarlist.readonly` | calendarList.list ([ref](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list)). `calendar.events` does **not** cover it. | sensitive |
| `calendar.events.freebusy` | freebusy.query on calendars the user can access, colleagues' included ([ref](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)). `calendar.events` does **not** cover freebusy. | sensitive |

- **Sensitivity.** Google's sensitive-scope page names "reading events stored in Google Calendar" as an
  example of a sensitive scope
  ([source](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)).
  No Calendar scope is restricted
  ([source](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)).
  The exact class of each scope shows on the project's Data Access page.
- **Verification.** agentinbox already requests `gmail.modify`, which is restricted. Adding sensitive scopes
  therefore changes nothing about verification for a self-hosted app (Internal, or External and unverified).
- **Why not narrower scopes.** We rejected `calendar.events.owned`: it can't reach shared calendars, and no
  doc says it allows answering other people's invitations. We rejected `calendar` as far broader (ACLs,
  deleting calendars). `calendar.freebusy` covers only the user's own calendars, which is useless for
  scheduling with others.

**API id.** The Calendar API's service name is `calendar-json.googleapis.com`. Enable it with
`gcloud services enable calendar-json.googleapis.com`, or at
`https://console.cloud.google.com/flows/enableapi?apiid=calendar-json.googleapis.com&project=<id>`
([quickstart](https://developers.google.com/workspace/calendar/api/quickstart/nodejs)).

**Errors.** `classifyCalendarError` in `server/google/calendar.ts` implements these and is tested.
- **API disabled:** `403 PERMISSION_DENIED` with ErrorInfo `reason: "SERVICE_DISABLED"` and metadata
  `{consumer, service, activationUrl?}`.
  - `activationUrl` is optional
    ([error_reason.proto](https://raw.githubusercontent.com/googleapis/googleapis/master/google/api/error_reason.proto),
    [example](https://developers.google.com/data-manager/api/devguides/concepts/understand-errors)).
  - Older bodies carry `errors[].reason: "accessNotConfigured"`.
- **Scope missing:** `403` with ErrorInfo `reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT"`. Older bodies carry
  `errors[].reason: "insufficientPermissions"` and the message "Insufficient Permission".

**syncToken.** Source: [events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list),
[sync guide](https://developers.google.com/workspace/calendar/api/guides/sync),
[errors](https://developers.google.com/workspace/calendar/api/guides/errors).
- `nextSyncToken` is only on the last page.
- An expired token gets `410 Gone` (`fullSyncRequired`): throw the token away and do a full sync.
- These parameters can't be combined with `syncToken` (Google answers 400): `iCalUID`, `orderBy`, `q`,
  `timeMin`, `timeMax`, `updatedMin`, `privateExtendedProperty` and `sharedExtendedProperty`.
- Other parameters (notably `singleEvents`) must match the initial sync.
- Incremental results always include deletions, as `status: "cancelled"` with possibly only `id`.

**Invitations.** Source: [events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events).
- The invitee's copy has `attendees[i].self: true`, `responseStatus: "needsAction"` and `organizer.self: false`.
- `responseStatus` is one of needsAction, declined, tentative or accepted.
- `eventType` is one of default, outOfOffice, focusTime, workingLocation, birthday or fromGmail.

**Push.** Source: [push guide](https://developers.google.com/workspace/calendar/api/guides/push),
[events.watch](https://developers.google.com/workspace/calendar/api/v3/reference/events/watch).
- The `address` must be HTTPS with a valid, CA-signed certificate. The current guide no longer mentions
  domain verification.
- `token` (up to 256 chars) comes back as `X-Goog-Channel-Token`.
- Notifications have no body. Their headers are `X-Goog-Channel-ID`, `X-Goog-Resource-ID` and
  `X-Goog-Resource-State` (`sync` once at creation, then `exists` or `not_exists`).
- Channels expire (default TTL 7 days) and never renew themselves.
- `channels.stop {id, resourceId}` has to come from the same user and OAuth client.

**Incremental consent.** Source: [web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server),
[limits](https://developers.google.com/identity/protocols/oauth2).
- With `include_granted_scopes=true`, the new grant covers the union of old and new scopes.
- With `access_type=offline&prompt=consent`, Google returns a new refresh token that yields access tokens
  for all of them.
- Google allows 100 refresh tokens per account per client; past that, the oldest stop working silently.
  The previous token is not revoked by the new consent.
- Revoking any token revokes the whole grant, so never revoke the old token.

**Granular consent.** Source: [granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions).
- Every Web client created in 2019 or later gets per-scope checkboxes, so a user can untick Calendar.
- What was actually granted is the `scope` field of the token response.

**Scope backfill.** The refresh-token grant response includes `scope`
([example](https://developers.google.com/identity/protocols/oauth2/web-server#offline)). Every token refresh
therefore tells us what the account currently grants, with no re-consent.

**RSVP.** To answer an invitation, patch the attendee's own `responseStatus`. `attendeesOmitted: true`
allows sending only the self attendee. `sendUpdates` takes `all`, `externalOnly` or `none`; the API
reference doesn't document a default. `sendNotifications` is deprecated.

## Decisions

### Access

- **The account's grant covers its calendars.** Read only: list_calendars, list_calendar_events,
  get_calendar_event, get_free_busy and calendar.* events in the feed, webhooks and listeners. Full access: also
  create, update and delete events, and respond_to_invitation. Writes apply at once. Calendar tools are listed only
  for agents with a grant on an account that has Google Calendar.
- **Calendar ids.** The primary calendar is the account email; tools accept `"primary"` as an alias
  (`resolveCalendarId`), and omitting `calendar_id` means the primary calendar. Any other id must be in the account's
  calendar list (`ctx.calendar.calendars`), not just reachable through `calendar.events` (someone else's calendar the
  user can open); otherwise it's denied with reason `calendar_not_found`, and the message never reveals whether it
  exists. free/busy may query any id or address (Google decides what is visible); without `calendars` it queries the
  primary calendar.
- **Attendees and `allowTo`.** Inviting someone emails them and shares the event, so attendees count as
  recipients (`attendeeImpact` in server/policy/calendar.ts). What must pass allowTo (`checked`) doesn't
  depend on notify: an event stays readable by its attendees (and editable with guestsCanModify), so a quiet
  write can still carry text to them.
  - `checked`: every attendee after the change, plus the organizer when it isn't the account, plus everyone
    `emailed`. On delete, only `emailed`: a quiet delete writes nothing to anyone else.
  - `emailed` (only with `notify_attendees` true, the default, `sendUpdates: "all"`): every attendee after the
    change plus removed ones and another organizer; on delete, all attendees of an event the account
    organizes, else the organizer.
  - Rooms (`@resource.calendar.google.com`) and the account itself are exempt. An update's attendee list
    keeps the account and existing rooms unless the list names rooms itself (then it is the full room list).
  - RSVP: a bare answer isn't checked (the organizer invited the account, much like replying). With a
    `comment`, the organizer and every attendee must pass allowTo: Google shows the note to all invitees.
  - Hidden guest lists: when the grant has an allowlist, the account doesn't organize the event and Google
    hides its guests from the account (`guestsCanSeeOtherGuests: false` or `attendeesOmitted`), updates and
    commented RSVPs are denied (`allow_to`): there's no way to check who would see them.
- **`sendUpdates` defaults.** Create, update and delete use `all` when `notify_attendees` isn't false (agents
  creating events usually mean to invite people; the allowTo check is the brake). RSVP uses `all`, so the organizer
  hears back, unless notify is false. `externalOnly` is not exposed.
- **Writes.** A create chooses its event id up front (base32hex, 26 characters), and `create_calendar_event` accepts
  it back as `event_id`: an agent retrying after `write_uncertain` can't create a second event (Google's 409 with
  the same content counts as applied; a different event under that id is `event_id_taken`). Update and delete send
  `If-Match` with the etag just read. After a 412, an ambiguous failure (timeout, network, 5xx, `outcome_unknown`) or
  a 409 on create, the event is re-read (`afterFailure` in server/calendar/apply.ts): a change already in place counts
  as applied (with `maybeSent`); a change known not to have landed fails cleanly; one that can't be told apart fails
  as `write_uncertain` ("may already have been applied").
- **Audit.** Every tool call is audited by the MCP layer (action = tool name). Writes put
  `{calendarId, eventId, emailed, notified: n}` in `detail`. Denials use plain words: `calendar_not_found`,
  `calendar_not_granted`, `calendar_api_disabled`, `allow_to` and `read_only`. A 412 from Google is
  `calendar_conflict`.
- **Event visibility.** `policy.canSeeEvent`: an enabled agent with a grant on the account sees its mail, calendar
  and account events alike.

### Events

- **New types.** `calendar.event_created`, `calendar.event_updated`, `calendar.event_cancelled` and
  `calendar.invitation_received`, grouped as `CALENDAR_EVENT_TYPES`.
- **Envelope.** These use the existing `MailEvent` envelope with `message: null` and
  `calendarEvent: CalendarEventSummary`.
  - The field is absent on mail events, so mail webhook payloads are byte-identical.
  - The events table gained `calendar_id` and `calendar_event`. `events.emit` and the repo carry them
    (implemented).
- **Detail.**
  - `event_updated`: `{ changes: CalendarEventChange[] | null }`, where null means the previous version
    wasn't seen.
  - `event_cancelled`: `{ wasOrganizer }`.
- **No body.** `CalendarEventSummary` carries no description, the same rule as "no bodies stored". Free text
  (summary, location, names) is cleaned to single lines in `summarizeEvent`. The description is fetched on
  demand and cleaned like a mail body.
- **Dedupe keys.** `${acc}:${cal}:${eventId}:${type}:${updated}`. Invitations use
  `${acc}:${cal}:${eventId}:invitation`, so each is announced once.
- **Webhooks.**
  - `WebhookFilter.calendarIds` restricts by calendar.
  - On calendar events, `from` matches the organizer, `to` any attendee, and `subject` the summary;
    `labelIds` and `hasAttachments` are ignored.
  - With `includeBody`, `content` is the cleaned description.
  - Webhooks list explicit event types, so existing ones never receive calendar events.

### Sync (polling by default)

- **Which calendars.** An account syncs only while it has every `CALENDAR_SCOPES` scope, isn't paused or
  `needs_reauth`, and at least one enabled agent has a grant on it. Mail-only installs make zero Calendar API
  calls.
  - Synced calendars are calendarList entries with accessRole owner or writer, refreshed every 15 minutes
    and on kick.
  - Read-only subscriptions (holidays, colleagues) are readable through tools but not synced into events.
- **Baseline.** A full `events.list` (`singleEvents=false`, every page) stores `calendar_event_state` for
  upcoming events (end ≥ now − 1 day) and recurring series, plus `sync_token` and `baseline_at`. It emits
  nothing, like Gmail's baseline historyId.
- **Incremental polling.** `events.list?syncToken=` runs every `Settings.calendarPollSeconds`, default 60
  and minimum 15. Each changed item is handled as follows:
  - **cancelled:** if known in state, emit `event_cancelled` with the stored summary and drop the state;
    unknown events are ignored.
  - **unknown, created ≥ baseline_at − 5 min:** emit `invitation_received` if `isInvitation(raw)`, else
    `event_created`.
  - **unknown, older, upcoming:** emit `event_updated` with `changes: null`.
  - **unknown, older, past:** ignored.
  - **known:** compare fingerprints. A change emits `event_updated` with `changes`. If the account was newly
    added as `needsAction`, emit `invitation_received` instead.
- **410 Gone.** Full resync, diffed against `calendar_event_state` so that changes are still reported
  (missing → cancelled, changed → updated, new → created or invitation). Then a new baseline. No gap event:
  `sync.gap` stays mail-only.
- **Status.** Account status lives in `accounts.calendar_status`, `calendar_error` and `calendar_synced_at`,
  which `Account.calendar` reads.
  - `api_disabled` comes from `classifyCalendarError`.
  - `scope_missing` triggers a token refresh, which re-reads the granted scopes; the status then derives
    from them.
  - Success clears errors.
- **Pruning.** Maintenance prunes state rows that ended more than a day ago.
- **Agent writes.** Writes made through agentinbox show up in sync like any change. Optionally, A marks them
  with `detail.source: "agentinbox"` and `agentId` when the event id and `updated` match a recent write.

### Push (optional)

- **When.** Only when `publicUrl` is `https:` and its host resolves only to public addresses. The private
  ranges are those of server/webhooks/ssrf.ts, plus 100.64/10 (Tailscale) and `.ts.net`, `.local` and
  `.internal`. Tailnet-only installs therefore stay on polling, which is the default.
- **Channels.** One `events.watch` per synced calendar:
  - id `chn_…`
  - `address = publicUrl + /google/calendar/push`
  - a random `token`, stored as a sha256 hash
  - TTL 7 days, renewed when less than 24 h remains: create the new channel, then stop the old one.
- **Verification.** A channel counts only after Google's `sync` notification arrives
  (`channel_verified_at`). If it hasn't arrived within 2 minutes, stop the channel and stay on polling,
  logging "Google can't reach <publicUrl>".
- **Polling.** With a verified channel, polling drops to every 15 minutes as a safety net.
- **Notifications.** Look up `X-Goog-Channel-ID`, compare the token hash in constant time, then answer 204
  and `kick(account, calendar)`. An unknown channel gets 404.
- **Lifecycle.** Reconcile on start, on a publicUrl change (bus "settings") and when the synced set changes.
  Stop the channels before an account is removed.

### OAuth, setup and the upgrade flow

- **Scope constants** live in `server/google/scopes.ts`: `MAIL_SCOPES`, `CALENDAR_SCOPES`, `PUBSUB_SCOPE`
  and `EXTRA_SCOPE_SETS`.
- **When Calendar is requested.** "Calendar is part of this install" is InternalState `calendar.setup.enabled`.
  - With no row the install counts as enabled (fresh installs). Migration 7 writes `{enabled:false}` if any
    account existed.
  - While enabled, every connect and reconnect requests `CALENDAR_SCOPES` too.
  - `scopes: ["calendar"]` on `POST /api/accounts/connect` requests them for one account regardless.
  - A reconnect re-requests calendar scopes the account had, as it already does for Pub/Sub.
- **Scope backfill.** Every token refresh writes the response's `scope` to `accounts.scopes`, so revocations
  and grants made elsewhere show up without re-consent.
- **New installs.** In the wizard:
  - Step 2's command becomes `gcloud services enable gmail.googleapis.com calendar-json.googleapis.com --project=<id>`.
    The console fallback is the `flows/enableapi?apiid=…` link for Calendar.
  - The consent-screen step lists the three Calendar scopes for Data Access.
  - Accounts connect with mail and calendar scopes in one consent.
- **Existing installs** (Wynn: nightly, 2 accounts, Pub/Sub, a paired agent), step by step:
  1. **Update and restart.** Migration 7 is additive: ADD COLUMN with defaults, two new tables, and one
     settings row. It runs in milliseconds at startup.
     - Mail is untouched: the Pub/Sub watch, history cursors and tokens are unchanged, and grants stay
       mail-only.
     - The restart is the only interruption, as with any update. Missed mail is caught up from the history
       cursor.
  2. **Notice.** Overview and Accounts show `calendar_not_added` (info) with an **Add Google Calendar**
     button. It can be dismissed (`PATCH /api/google/calendar {dismissed:true}`).
  3. **Turn on the Calendar API.** The dialog shows `enableApiCommand` and the `enableApiUrl` deep link. This
     can't be verified until an account has the scopes, so "Done" continues.
  4. **Add the scopes on the consent screen.** Google Auth Platform → Data Access → Add or remove scopes,
     paste the three URLs, Update, Save (`dataAccessUrl`).
     - For Internal apps this is optional.
     - For External apps it is recommended, because it lists the scopes on the consent screen.
     - Google doesn't expose whether it was done, so this step is informational.
  5. **Turn it on.** `PATCH /api/google/calendar {enabled:true}`. From now on, any reconnect also adds
     Calendar.
  6. **Per account, "Add Calendar to <email>".** This calls `POST /api/accounts/connect {reauthAccountId, scopes:["calendar"]}`.
     - Google asks only for the new Calendar permissions (include_granted_scopes keeps Gmail and Pub/Sub).
     - The callback stores the new refresh token, which covers everything, in one UPDATE.
     - In-flight mail calls keep using the cached access token. The old refresh token is never revoked.
     - `ingest.onAccountConnected` continues from the existing history cursor and re-arms the watch. It never
       re-baselines, so no mail is skipped.
  7. **Failure modes don't touch mail.**
     - If the user unticks Calendar or cancels, the account stays as it was and shows `not_granted` with
       `missingScopes`.
     - If the API is still off, the probe D runs right after the consent (calendarList, maxResults 1) sets
       `api_disabled`. The flow returns to step 3 with Google's `activationUrl`.
  8. **Done.** Agents with a grant on the account use its calendars (read only, or full access to change them).
     Sync starts at the next poll.
- **Accounts that haven't upgraded** keep working for mail. Calendar tools resolve them to a ToolError
  `calendar_not_granted` ("ask the operator to add Google Calendar for <email>").

## Contract map (what exists now)

| Piece | Where | State |
| --- | --- | --- |
| Shared types: capabilities, write modes, event types, CalendarEventSummary/Info/Input, Account.grantedScopes/calendar, SetupWarning codes, approval kinds + CalendarApprovalDetail, CalendarSetupState/Input, ConnectAccountInput, WebhookFilter.calendarIds, Settings.calendarPollSeconds, route map | `shared/types.ts` | done |
| Migration 7 | `server/db/schema.ts` | done, tested on a pre-calendar DB |
| Scopes | `server/google/scopes.ts` | done |
| REST client interface, raw shapes, `classifyCalendarError`, enable-API helpers | `server/google/calendar.ts` | interface + classifier done; `createCalendarClient` stub (A) |
| `ctx.google.calendar(accountId)` | `server/google/index.ts`, `types.ts` | wired to the stub |
| CalendarService and composer | `server/calendar/types.ts`, `index.ts` | done; parts stubbed |
| `summarizeEvent`, `isInvitation` | `server/calendar/summary.ts` | done, tested |
| AgentCalendar (agent actions) | `server/calendar/agent.ts` | done (B) |
| Policy helpers: scope, `attendeeImpact`, allowTo | `server/policy/calendar.ts` | done, tested |
| Grant fields, upsert semantics, visibility | `server/policy/grants.ts`, `index.ts` | done, tested |
| Approval dispatch, kind-aware cancel, applying calendar changes | `server/mail/approvals.ts`, `server/calendar/approvals.ts` | done, tested (B) |
| Event storage | `server/events/*` | done, tested |
| MCP registration hook, tool names | `server/mcp/calendar.ts`, `server/mcp/server.ts` (`Register`, `CALENDAR_TOOL_NAMES`) | hook stub (C) |
| Console vocabulary: labels, icons, KIND_LABEL, DENIAL_REASONS, CALENDAR_WRITE_MODE_INFO | `src/lib/labels.ts`, `src/components/events/event-row.tsx` | done (copy may change) |
| `config.google.calendarBase` (`AGENTINBOX_GOOGLE_CALENDAR_BASE`) | `server/config.ts` | done; fake and demo point it at themselves |

## Work split

Rules:
- Each workstream owns its files exclusively.
- To change a file you don't own, ask its owner, or add only a re-export.
- FROZEN members (in `server/calendar/types.ts`, `server/google/types.ts` and `server/events/types.ts`) don't
  change shape. Additions are fine.
- `shared/types.ts` is append-only for everyone: add, don't rename. Tell the lead when you add something.
- Delete `notImplemented` uses as you go. The file `server/calendar/todo.ts` goes once nothing imports it.

**Merge order.**
1. A, B and D first (server core).
2. C needs B's AgentCalendar; stub against it meanwhile.
3. E and F (console) can merge at any point against the types.
4. G last, with the E2E tests.

### A: Calendar client, fake Calendar API, sync engine, event emission

- **Owns:**
  - `server/google/calendar.ts` (the `createCalendarClient` body)
  - `server/calendar/sync.ts`, `server/calendar/summary.ts`, new `server/calendar/state.ts` (calendar_sync
    and calendar_event_state repos, fingerprint, diff)
  - the calendar section of `test/fake-google.ts` (nobody else edits that file)
  - `scripts/demo/*` (calendar seed data)
  - calendar pruning in `server/maintenance.ts`
  - tests `test/calendar-client.test.ts`, `test/calendar-sync.test.ts`
- **Interfaces:**
  - provides `CalendarClient`, `ctx.calendar.kick` / `syncAccount`, the event emission rules above, and
    `accounts.calendar_*` updates;
  - uses `ctx.events.emit` (NewEvent.calendarEvent) and `summarizeEvent`.
- **Fake Calendar surface** (`g.calendar.*` on FakeGoogle, routes under `/calendar/v3`):
  - Every fake account starts with a primary calendar (id = email).
  - `addCalendar(email, { name, accessRole?, id? }) → id`
  - `putEvent(email, calendarId, Partial<CalendarEventRaw>) → CalendarEventRaw` (create or replace; bumps
    `updated` and the change log that sync tokens read)
  - `invite(organizer, attendees[], event)`: the organizer's event plus each fake attendee's copy (`self`,
    `needsAction`), like Google
  - `respond(email, eventId, status)`: a human RSVP, propagated to the organizer's copy
  - `cancelEvent(email, calendarId, eventId)`
  - `events(email, calendarId)` and `event(email, calendarId, id)`
  - `expireSyncTokens(email, calendarId?)`: the next incremental call gets 410 `fullSyncRequired`
  - `disableApi("calendar", on)`: 403 `SERVICE_DISABLED` with `activationUrl`
  - Calendar routes check the token's scopes (consentAs `{scopes}` simulates granular consent): 403
    `ACCESS_TOKEN_SCOPE_INSUFFICIENT`.
  - `mailsSent(email)`: notifications Google would have emailed (`sendUpdates`), as `{to, kind: invite|update|cancel|reply, eventId}`
  - `channels()` and `notify(channelId, state)`: POST a push to the channel's address
  - **Routes:**
    - `GET users/me/calendarList`
    - `GET`/`POST calendars/:cal/events`: list supports syncToken (400 with forbidden params), timeMin/timeMax,
      q, singleEvents (expands RRULE DAILY/WEEKLY with COUNT/UNTIL), orderBy=startTime, pageToken/maxResults
      and showDeleted
    - `GET`/`PATCH`/`DELETE calendars/:cal/events/:id` (If-Match → 412)
    - `POST freeBusy`
    - `POST calendars/:cal/events/watch`
    - `POST channels/stop`
- **Acceptance:**
  - client unit tests against the fake: paging, 410, the error classes, and non-idempotent insert not retried
    after a 5xx;
  - baseline emits nothing;
  - created, updated (with `changes`), cancelled and invitation are each emitted once (dedupe across repeated
    polls);
  - 410 resync reports changes;
  - no Calendar calls without a `calendar.read` grant;
  - paused and needs_reauth accounts are skipped;
  - `Account.calendar` reflects api_disabled, error and success;
  - mail tests untouched.

### B: Policy, grants, approvals, audit for calendar

- **Owns:**
  - `server/calendar/agent.ts` (AgentCalendar)
  - `server/calendar/approvals.ts`
  - `server/policy/calendar.ts`, `server/policy/enforce.ts` (send caps count calendar writes)
  - `server/policy/index.ts` and `server/policy/grants.ts` (e.g. `ctx.calendar.kick(accountId)` when a grant
    gains `calendar.read`)
  - `server/mail/approvals.ts`
  - `server/agentapi/pairing.ts` (requested calendar capabilities and `calendarWriteMode`; pairing approval
    defaults to `"approval"`)
  - tests `test/calendar-policy.test.ts`, `test/calendar-approvals.test.ts`
- **Interfaces:**
  - provides every AgentCalendar method (the signatures are the contract with C), `approvalBlockedReason`
    and `applyApproval`;
  - uses `ctx.google.calendar` (A) and `eventDescriptionContent` (C).
- **Acceptance:**
  - capability and account resolution messages match AgentMail's style;
  - calendar scope enforced on every method, including free/busy and event ids from another calendar;
  - direct mode writes at once, approval mode queues without touching Google;
  - approve applies, reject and expire discard, and a 412 on etag fails the approval;
  - allowTo is checked per `attendeeImpact` (notify on and off);
  - writes that email count toward caps;
  - every write is audited with `detail.emailed` and denial reasons;
  - removing `calendar.write` cancels pending calendar approvals only.

### C: MCP tools, content cleaning, skill docs

- **Owns:**
  - `server/mcp/calendar.ts`
  - `server/mcp/format.ts` (calendar formatters; calendar events in `formatFeed`; calendar lines in
    `formatAccounts`; calendar kinds in `formatApprovalStatus`)
  - `server/mcp/server.ts` (INSTRUCTIONS; register `get_send_status` for `calendar.write` too)
  - `server/calendar/content.ts`, `server/mail/content.ts` (generalize `wrapUntrusted` with a
    `<calendar_content … untrusted>` tag; `escapeDelimiters` covers it)
  - `server/skill/SKILL.md`
  - tests `test/calendar-mcp.test.ts`, `test/calendar-content.test.ts`, and the catalog test in
    `test/mcp-http.test.ts`
- **Tool shapes** (snake_case args; all take `account?`):
  - `list_calendars {}`
  - `list_calendar_events {calendar_id?, time_min, time_max, query?, max_results?, page_token?}`
  - `get_calendar_event {calendar_id?, event_id}`
  - `get_free_busy {time_min, time_max, calendars?}`
  - `create_calendar_event {calendar_id?, summary, start, end, all_day?, time_zone?, description?, location?, attendees?, add_meet_link?, recurrence?, notify_attendees?, reason?}`
  - `update_calendar_event {calendar_id?, event_id, …same fields optional…}`
  - `delete_calendar_event {calendar_id?, event_id, notify_attendees?, reason?}`
  - `respond_to_invitation {calendar_id?, event_id, response: accepted|declined|tentative, comment?, notify_organizer?, reason?}`
  - Write results say which happened: applied, deleted, or `pending_approval` with an approvalId.
- **Acceptance:**
  - tools registered strictly by capability;
  - descriptions, locations and names cleaned (hidden text removed, suspicious phrases flagged), with
    descriptions wrapped as untrusted;
  - an injection-corpus case through an invite description (see `test/content-corpus.test.ts`);
  - the catalog test grants calendar capabilities and expects all of `TOOL_NAMES`;
  - SKILL.md documents the tools and the approval behavior.

### D: OAuth scopes, consent, setup state, warnings, push

- **Owns:**
  - `server/google/oauth.ts`, `server/google/scopes.ts`, `server/google/tokens.ts` (scope backfill on
    refresh), `server/google/types.ts` (`startConnect` accepts `ExtraScopeName[]`)
  - `server/google/warnings.ts` (the four `calendar_*` codes), `server/google/accounts.ts` (stop push
    channels on remove; `accountCalendar`)
  - `server/calendar/setup.ts`, `server/calendar/push.ts`
  - `server/api/accounts.ts` (connect zod `scopes: z.enum(EXTRA_SCOPE_NAMES)`; `GET /accounts/:id/calendars`)
  - `server/api/google.ts` (`GET`/`PATCH /google/calendar`, `POST /google/calendar/check`)
  - `server/app.ts` (unauthenticated `POST /google/calendar/push`, CSP/limits like `/oauth/callback`)
  - tests `test/calendar-setup.test.ts`, `test/google-oauth-calendar.test.ts`, `test/calendar-push.test.ts`
- **Interfaces:**
  - provides `CalendarSetupState`, `calendarEnabled()` and `calendars(accountId)` (used by B and C for
    list_calendars, with `synced` filled from calendar_sync);
  - after connect, probes the account (`calendarList` maxResults 1) and records api state in
    `calendar.setup.api` and `accounts.calendar_status`.
- **Acceptance:**
  - fresh install connects with mail and calendar scopes in one consent;
  - an existing install's per-account consent keeps the history cursor, the Pub/Sub watch and mail working
    across the token swap (fake: mail delivered before, during and after);
  - unticked Calendar leaves `not_granted` and mail intact;
  - API off gives `api_disabled` plus a warning with `activationUrl`;
  - refresh responses update `accounts.scopes`;
  - push is created only for public https, ignored for unknown channels or bad tokens, renewed before
    expiry, and falls back to polling when unverified;
  - every setup warning has a message, hint and url, as the SetupWarning docs require.

### E: Console, setup and accounts

- **Owns:**
  - `src/components/setup/*`, `src/routes/setup.tsx`, `src/lib/gcp-project.ts` (step-2 command and
    Calendar API links)
  - `src/components/accounts/*`, `src/routes/_app/accounts.tsx`, `src/components/google/*`
  - `src/components/settings/settings-form.tsx` (calendarPollSeconds)
  - `src/routes/_app/index.tsx` (overview notice)
  - `src/lib/queries.ts`. Add `queries.calendarSetup()` and `queries.accountCalendars(accountId)` in your
    first commit; F uses them.
  - console logic tests (`test/console-*.test.ts` additions)
- **Delivers:**
  - Add Google Calendar dialog: enable API, Data Access, enable, then per-account consent through
    connect-host with `scopes: ["calendar"]`, resuming after each account;
  - wizard changes for new installs;
  - Accounts calendar status badge with fix actions (consent, enable-API link);
  - warning rendering for the four new codes.
- **Acceptance:**
  - the flow works end to end against the fake (D's endpoints);
  - one dialog, never a dead end;
  - dismissible;
  - wizard copy updated;
  - docs screenshots regenerated where the wizard changed (`scripts/demo/docs-shots.mjs`; coordinate with A
    on seed data).

### F: Console, agents, approvals, events, webhooks UI

- **Owns:**
  - `src/components/agents/*` (grant editor calendar section: capabilities, calendar scope picker from
    `queries.accountCalendars`, write mode control from `CALENDAR_WRITE_MODE_INFO`, "None" = no
    calendar.write; `grant-words.ts`)
  - `src/components/approvals/*`, `src/routes/_app/approvals.tsx` (calendar approval card with before/after,
    attendees notified, "Apply"/"Discard" wording)
  - `src/components/events/*`, `src/routes/_app/events.tsx` (calendar event rows: title, time, organizer,
    changes, invitation badge)
  - `src/components/webhooks/*` (calendar types and calendarIds in the filter builder)
  - `src/lib/labels.ts`, `src/lib/format.ts`
  - pairing approval form calendar fields (`src/components/approvals/pairing.tsx`)
- **Acceptance:**
  - existing mail UI unchanged;
  - typecheck clean;
  - console logic tests for grant serialization (calendar fields always sent explicitly), calendar
    approval rendering and event rows.

### G: Delivery surfaces, CLI, docs, E2E

- **Owns:**
  - `server/webhooks/filter.ts` (calendarIds and calendar semantics for from/to/subject; schema accepts
    `calendarIds`), `server/webhooks/send.ts` (includeBody → `ctx.calendar.eventContent`)
  - `server/listen/*` (`--types` help, event summaries and env vars for calendar events, `connect
    --capabilities calendar.read`)
  - `server/agentapi/stream.ts` if needed
  - `docs/reference.md`, `docs/listen.md`, `README.md`, the user-facing parts of this file
  - `test/e2e-calendar.test.ts`, `test/e2e/*` helpers
- **Acceptance:**
  - E2E against the fake (needs A–D):
    - read: list, search, get with a cleaned description, free/busy;
    - write in direct and approval mode (approve applies, reject discards);
    - an invitation arrives as an event, then respond_to_invitation;
    - webhooks and listeners receive calendar events only with `calendar.read` and in scope;
    - the upgrade from a pre-calendar DB with Pub/Sub: migrate, enable, per-account consent, mail never
      stops (messages delivered throughout are all evented);
  - docs list the new tools, events, payloads and the upgrade steps.

## Open questions (with the decision taken)

1. **Default `notify_attendees: true`.** Decided yes: agents creating meetings mean to invite. The
   alternative is a quieter default of false, where the agent must opt in to emailing. Wynn can flip it per
   tool call; changing the default later is one line in B.
2. **60 s polling latency for invitations on tailnet installs.** Decided 60 s (≈1,440 cheap calls per
   calendar per day, well inside quota). The setting goes down to 15 s.

## Review amendments (PR #37)

The tier-L reviews of this contract changed the following. Where these amendments differ from the sections above,
they take precedence. Each workstream implements its own items.

- **B: attendee checks don't depend on notify.** Whenever a write is visible to others, `checked` is every non-self,
  non-room attendee after the change, plus the organizer when that isn't the account. `notify` only drives `emailed`
  and the send caps.
  - An RSVP with a comment requires the organizer to pass allowTo.
  - `checked` is stored in CalendarApprovalDetail and re-checked at approval time.
- **B: a null calendarScope means the calendars in the account's list,** not any id Google would open. Free/busy for any
  address stays allowed.
- **B: creates are idempotent.** The Google event id is chosen when the write is queued (and in direct mode) and
  stored in `eventId`. A 409 duplicate on retry counts as applied.
- **B: `replyOnly` constrains invites.** With replyOnly on, adding new attendees is denied or sent to approval; B
  documents which.
- **B: approvals and grant ids.**
  - Malformed calendar approval payloads fail permanently.
  - The shared "agent deleted or disabled" check stays common to all approvals.
  - `calendarScope` rejects "primary" and lowercases email-shaped ids.
  - `calendar.read` alone shows `account.auth_failed` but not `sync.gap`.
- **A: invitations.** For an unknown upcoming event, `isInvitation(raw)` is checked before the created-time test, so
  being added to an existing meeting fires `invitation_received`.
- **A: link safety.** Summaries keep conference and html links only when they are https, with Google's host for
  htmlLink. Free text is cleaned before events are emitted.
- **A: ownership.** A owns `server/calendar/index.ts` and `types.ts`, and exposes a hook for D's push reconcile when
  the synced calendar set changes.
- **D: token refresh race.** A refresh only writes back tokens and scopes if the refresh token it used is still
  current. A missing `scope` in the response means "unchanged".
- **D and E: admin-blocked Calendar.** `admin_policy_enforced` on a first connect maps to "connect without Calendar",
  and the wizard offers that choice.
- **C/F/G: `calendar.read` gets calendar events,** not only mail `read`.
  - C: feed tools (list_events, wait_for_events, ack_events) are registered for read OR calendar.read.
  - F: `grantSees` in event-row.tsx.
  - G: `server/agentapi/listeners.ts` (stream gating, newestGrantedSeq/newestVisibleSeq).
- **G owns `server/webhooks/payload.ts`.** `scopeBodyCheck` re-checks the calendar scope for calendar events.
- **G: listener stdin.** It cleans `calendarEvent` and wraps calendar text with the organizer (not `from=undefined`).
  The `calendar_content` delimiter is defused. Recipe prompts and UNTRUSTED_NOTICE mention calendar invites.
- **F: presets and rendering.**
  - Grant presets (`src/lib/grants.ts`) keep the calendar fields.
  - Links render only when they are https.
  - The calendar approval card shows the full description, the location and who gets emailed.
