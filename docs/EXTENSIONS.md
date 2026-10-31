# Extensions (DECIDED by Wynn, 2026-10-16)

xaq's core stays lean. It holds the broker, agents and keys, approvals, the console, the audit log, and Gmail and
Calendar. Every pre-built connection (Notion, T3 Code, Brightspace, WHOOP, …) is an **extension**. Extensions are
installed from the public repo [wynn-dev/xaq-extensions](https://github.com/wynn-dev/xaq-extensions) (MIT) or, behind
a clear warning, from a third-party source.

This file is the contract that the parallel writers build against. A change to it needs the lead's sign-off.

## Two kinds

| Kind | What it is | Runs |
| --- | --- | --- |
| `remote` | A manifest only: an MCP URL (or "the user names the server"), auth hints, setup copy and a risk map. Notion, T3 Code and Brightspace. | Nothing: xaq proxies the remote MCP server, exactly as for presets today. |
| `code` | A manifest plus one bundled Node ESM file that is an MCP server over stdio. WHOOP. | A child process per connection, out of xaq's process, under Node's permission model (below). |

## The manifest: `xaq-extension.json`

It lives at the root of the extension's directory. Unknown keys are rejected (schema 1).

```jsonc
{
  "schema": 1,
  "name": "t3code",                 // [a-z0-9-]{1,32}; unique in the registry; the install's identity
  "displayName": "T3 Code",
  "version": "1.0.0",               // semver; shown, not trusted (the pin is the commit + integrity)
  "description": "…",
  "kind": "remote",                 // "remote" | "code"
  "slug": "t3",                     // default connection slug, [a-z0-9-]{1,24}

  // kind "remote":
  "remote": {
    "url": "https://mcp.notion.com/mcp",               // or omit and use userServer
    "userServer": { "defaultPath": "/mcp", "sameOriginIssuer": true },
    "auth": { "type": "mcp_oauth" }                    // or { "type": "header", "headerName": "Authorization", "prefix": "Bearer " } or { "type": "none" }
  },

  // kind "code":
  "code": {
    "entry": "dist/server.mjs",     // one self-contained ESM file: no node_modules, no install scripts, ever
    "node": ">=22.23.2",            // shown; the host enforces its own floor for code extensions (Sandbox limits)
    "auth": {                       // OAuth is done by xaq core; the extension only ever gets access tokens
      "type": "user_app",           // or "none", or "google" (official extensions only, below)
      "authorizeUrl": "…", "tokenUrl": "…", "scopes": ["…"],
      "clientIdInput": "client_id", "clientSecretInput": "client_secret",
      "refreshScope": "offline"     // optional: sent as `scope` on refresh (WHOOP needs "offline"); omit to send none
    },
    // or, official extensions only: a connected Google account, tokens downscoped to `scopes` (see "Google accounts
    // for code extensions")
    // "auth": { "type": "google",
    //           "scopes": ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/drive.file"],
    //           "apis": [{ "service": "docs.googleapis.com", "label": "Google Docs API" }] },
    "network": ["api.example.com"],      // declared hosts: shown at install and in the warning (not enforced, see Sandbox)
    "events": ["example.item_updated"]   // the event types it may emit (`<name>.<event>`); anything else is dropped and logged
  },

  "reconnectPolicy": { "maxLifetimeDays": 180, "idleDays": 30, "tokenLifetimeCapDays": 30 },

  // Setup copy: SetupStep[] (server/broker/types.ts). Strings may use {{publicUrl}}, {{redirectUri}}, {{webhookUrl}}
  // and nothing else ({{projectId}} too with a "google" auth). A step with "when": "webhookUrl" appears only when the
  // internet reaches this install.
  "setup": [ { "id": "app", "title": "…", "body": "…", "copy": { "label": "Redirect URI", "value": "{{redirectUri}}" } } ],

  // The risk map: exact tool names. Anything not listed falls back to the generic rules (annotations + verbs).
  "risk": {
    "tools": { "t3_project_delete": { "class": "risky", "target": "/projectId" }, "t3_project_list": { "class": "read" } },
    "nameCheckExempt": ["t3_thread_send"]
  }
}
```

The manifest becomes an `IntegrationPreset` through `presetFromManifest` (in `server/extensions/manifest.ts`), so the
broker, policy, catalog and console don't change shape. `kind: "code"` maps to `kind: "native"` with a `createSource`
that talks to the child.

Field rules, all enforced by `validateManifest`. The JSON Schema `MANIFEST_JSON_SCHEMA` (same file, copied into the
repo's `scripts/validate.mjs`) checks the shape; a few rules below are only the validator's.
- **Required:** `schema`, `name`, `displayName`, `version`, `description`, `kind`, `slug`, and `remote` or `code` to
  match `kind`. `reconnectPolicy` (and each of its fields), `setup` and `risk` are optional.
- **`remote`:** exactly one of `url` (https) and `userServer`. `userServer.sameOriginIssuer` defaults to false.
- **`remote.auth.broadScopes`** (with `mcp_oauth` only, optional): granted scopes that mean broad access. The console
  warns when a sign-in grants any of them. T3 Code: `["settings:write", "source-control:write"]`.
- **`remote.auth.scopeNotes`** (with `mcp_oauth` only, optional): `[{ "scope": "…", "note": "…" }]`, in priority
  order. It's an array rather than an object so the order is reliable: JavaScript reorders integer-like object keys.
  Scopes are unique. The connection page shows the note of the first scope the sign-in granted, otherwise the generic broad-access
  warning. Notes are shown as they are (no `{{ }}`). T3 Code explains its Full access, Supervised and Read only
  levels this way.
- **`reconnectPolicy`:** each field is a whole number of days, from 1 to 3650.
  - `maxLifetimeDays`: a cap on a refreshable sign-in, counted from the sign-in (Notion: 180).
  - `idleDays`: shown only (Notion: 30).
  - `tokenLifetimeCapDays`: for a credential without a refresh token, `expires_at` is the smaller of the token's
    expiry and the sign-in time plus N days. When the server sends no `expires_in`, it is N days (T3 Code: 30).
    Warnings come at 7 days and 1 day, as for any expiry.
- **`setup`:** steps have `id`, `title` and `body`, plus optionally one each of `link`, `copy` and `input` (the
  `SetupStep` shape), and `when`.
  - **Variables:** only `{{publicUrl}}`, `{{redirectUri}}` and `{{webhookUrl}}` (validator only). Any other
    `{{…}}` is an error.
  - **`when`:** the only value is `"webhookUrl"`. A step that uses `{{webhookUrl}}` must have it (validator only).
  - **Links:** a link is https, or one of the variables followed by `/`, `?`, `#` or nothing, so
    `{{publicUrl}}@evil.example` is refused.
  - **Shown as they are:** input `label` and `placeholder` and `scopeNotes` can't contain `{{` or `}}`.
  - **Uniqueness:** step ids and input keys are unique (validator only).
- **`risk.tools[name].class`:**

  | `class` | `ToolClass` | Effect |
  | --- | --- | --- |
  | `"read"` | `{ read: true, risky: false }` | Listed at Read only. |
  | `"write"` | `{ read: false, risky: false }` | Goes through without asking. |
  | `"risky"` | `{ read: false, risky: true }` | Asks at the "ask" level. |

  Tools not listed return null, which means the generic rules (annotations, then the verb list).

  **Third-party risk maps can make tools stricter, never looser.** For an extension that isn't from the official
  registry, xaq applies the generic rules on top of its map: `risky = map risky OR generic risky`,
  `read = map read AND generic read` (a tool the generic rules call a write stays a write, so Read only never gains
  one), and its `nameCheckExempt` is ignored. The install warning says so, and the
  Add connection picker marks its preset "third-party" (`PresetView.official`).
- **`risk.tools[name].target`:** a JSON Pointer, or an array of candidate pointers. The first candidate whose
  top-level argument the tool's live `inputSchema` declares becomes the "always allow … for this target" path. If
  none is declared, there is no target. Notion uses `["/page_ids", "/pages", "/page_id", "/ids", "/id"]`.
- **`risk.nameCheckExempt`:** each name must be listed in `risk.tools` and not be `risky` (validator only). The
  table's answer is final for those exact names. Official extensions only (ignored for third-party ones).
- **`code`:** `entry` is a relative `.mjs` or `.js` path inside the extension. `events` are `<name>.<event>`, which
  limits a name with events to 24 characters. A `user_app` auth's `clientIdInput` and `clientSecretInput` must be
  setup inputs (validator only). Its optional `refreshScope` (OAuth scopes separated by single spaces) passes through
  to the preset's `auth.refreshScope` and is sent as `scope` on a refresh; without it, a refresh sends no scope.
  WHOOP sets `"offline"`.
- **`code.auth` of type `google`:** official extensions only (validator only: the schema lives in the official repo).
  `validateManifest(raw, { official })` refuses it for a third-party manifest, before reading its scopes, so the
  store refuses such an install (and `resolve`) with `invalid`, and `presetFromManifest` refuses it again for a store
  row that isn't official. Keys `type`, `scopes` and `apis`, all required, nothing else. The name `google-workspace` is
  reserved (`OFFICIAL_NAMES`): no third-party extension can take it, even offline.
  - `scopes`: 1 to 20 unique `https://www.googleapis.com/auth/<name>` URLs. Never Gmail, Calendar, Pub/Sub or Cloud:
    any name starting `gmail`, `calendar`, `pubsub` or `cloud-platform` is refused, and so is `https://mail.google.com/`
    (`EXTENSION_SCOPE_RE` and `CORE_ONLY_SCOPES` in `server/google/scopes.ts`; the schema has the same pattern).
  - `apis`: up to 20 `{ "service": "<name>.googleapis.com", "label": "…" }`, unique services; labels are shown as they
    are (no `{{ }}`).
  - `{{projectId}}` may be used in such a manifest's setup strings (the install's Google Cloud project ID, or
    `YOUR_PROJECT_ID` while unknown); in a link only after the host (path, query or fragment), URL-encoded there.
  - Step ids starting `google-` are xaq's own (any manifest).
- **Names:** an extension can't use one of xaq's own event prefixes as its name (`message`, `calendar`,
  `connection`, `approval`, …).

## Sources, pinning and the registry

- **Registry:** `index.json` at the root of xaq-extensions:
  `{ "schema": 1, "extensions": [{ "name", "displayName", "description", "kind", "version", "path": "extensions/<name>", "commit": "<40-hex sha>", "integrity": "sha256-<base64>" }] }`.
  It's fetched from `https://raw.githubusercontent.com/wynn-dev/xaq-extensions/main/index.json`. The index is only a
  catalog: what gets installed is pinned by `commit` and `integrity`.
- **Sources** (the console's Extensions page):
  - a registry name;
  - a GitHub URL `https://github.com/<owner>/<repo>[/tree/<ref>/<path>]`, fetched as the codeload tarball of the
    resolved commit;
  - any other git URL, through the `git` CLI;
  - a local directory, for development and tests.
  Anything that isn't the official registry (wynn-dev/xaq-extensions at the indexed commit) is **third-party**. It
  gets a clear warning before install: the declared network hosts, kind `code` or not, "this code runs on your
  machine with network access", and that its risk map can make tools stricter but never looser. It needs a
  confirmation.
- **Integrity:** sha256 over a canonical listing of the extension directory. For each regular file, sorted by POSIX
  path relative to the extension root, the line is `<path>\0<mode 644|755>\0<hex sha256 of content>\n`. Symlinks,
  devices and paths outside the root are refused. It's encoded as `sha256-<base64>`. Core
  (`server/extensions/integrity.ts`) and the repo's `scripts/integrity.mjs` share test vectors and must agree.
- **Pinned installs:** an install records the source, the resolved commit (or, for a local path, none), the integrity,
  the version and the manifest. Files land in `<dataDir>/extensions/<name>/<integrity-hex-prefix>/`, made read-only.
  The integrity is checked again before every child start. A mismatch refuses to start and says why.
- **Updates:** an update shows the old and new version, commit and integrity, and installs only on
  confirmation. Nothing ever updates on its own: an update never swaps code silently. An update can't change the
  extension's `name` or its `kind` (remote or code): that's a remove and a new install.
- **Removal:** refused while connections use the extension, unless forced, which
  disables those connections. A third-party name also unbinds them (`connections.preset` is cleared), so a later
  extension of that name can't take them over. An official name keeps them bound: no third party can install under
  it, and re-adding the extension brings its rules back. Credentials are deleted only by removing the connections.
- **Broken installs:** an installed extension whose manifest this xaq can't read is reported (logged, and listed by
  `brokenExtensions()`) and offers no preset. An official one is replaced by its pinned build when the pin is
  another build (`store.replacePinned`): the pinned build is fetched and verified first, then swapped in. Offline or
  on a bad pin, the installed one stays as it was. Nothing is removed, and its connections stay bound and enabled.
- **Console:** an Extensions page lists installed extensions with their version, commit, source, official or
  third-party, and the connections using each. It can add from the registry, update with the diff shown, and remove.
  Adding from a URL works with the same warning.

## The code-extension host

- **One child per connection:** `process.execPath --permission --no-experimental-sqlite --import <signal preload> --allow-fs-read=<installDir> --allow-fs-read=<stateDir> --allow-fs-write=<stateDir> [--allow-net] <installDir>/<entry>`.
  - *Clarified (B3):* one flag per path. Node 22.13.0 and 24.22 both read the comma form
    (`--allow-fs-read=a,b`) as one literal path: on 22.13 the child can't even load its entry. A test pins the argv.
  - No `--allow-child-process`, `--allow-worker`, `--allow-addons` or `--allow-wasi`. Without them, Node refuses
    `child_process`, `worker_threads`, WASI, `process.dlopen`, `process.binding` and the inspector, and symlinks,
    hard links and `..` out of the allowed paths.
  - *Clarified (B3, from the security review):*
    - `--no-experimental-sqlite`: `node:sqlite` ignores the permission model. It opens, ATTACHes and `VACUUM INTO`s
      any path, xaq's own DB included. With the flag the module doesn't exist (`import` fails and
      `getBuiltinModule` returns undefined).
    - The signal preload is a `data:` URL, so it needs no file-system allow. It pins `process.kill`, `_kill`,
      `_debugProcess`, `_debugEnd` and `os.setPriority` to throwers (non-writable, non-configurable, on the objects
      `getBuiltinModule` and `require` return, with the ESM named exports synced). So the child can't SIGUSR1 xaq
      into opening its inspector, kill xaq or other processes of the same user, or lower xaq's priority. It also ignores SIGUSR1 itself. xaq ignores SIGUSR1 too (`ignoreInspectorSignal`
      at startup).
    - `--allow-net` is added only on a Node that has it. From 25, `--permission` gates the network too: on 26.12.0,
      fetch fails with ERR_ACCESS_DENIED without it. On 22.x and 24.x the flag doesn't exist and is fatal. The
      contract leaves the network open, so the child's network is the same on every version.
    - Verified on Node 22.13.0, 22.23.3, 24.22.0 and 26.12.0.
  - `cwd` is `<stateDir>`, stdio is pipes only, `detached: false`, and no other fds are passed (a test checks that
    no regular file xaq holds open, such as the DB, reaches the child).
- **Environment, minimal:** only `XAQ_EXT_NAME`, `XAQ_EXT_CONNECTION_ID`, `XAQ_EXT_STATE_DIR`, `XAQ_EXT_PROTOCOL=1`,
  `TZ`, `LANG`, and `NODE_OPTIONS` unset. Nothing else is inherited, so no `XAQ_*`/`AGENTINBOX_*` secrets, no HOME,
  and no T3 or other variables.
- **State:** `<dataDir>/extension-state/<name>/<connectionId>/`, mode 0700, owned by xaq and deleted with the connection.
  The child never gets xaq's DB, `master.key`, other connections' tokens, the client secret or any path outside
  install and state.
- **Sandbox limits** (documented in the README and the warning): Node's permission model restricts the file system,
  child processes, workers and addons. It does **not** restrict the network. It's a guard against accidents and
  sloppy code, not a hostile-code jail, which is why third-party code extensions get the warning.
  - *Clarified (B3):*
    - **Signals and scheduling priority** aren't part of the permission model. They're blocked only by the preload
      above, from JavaScript.
      Only OS-level isolation (a separate user, a container) closes this fully.
    - **`node:sqlite`** is disabled in the child, because it would bypass the file-system rules.
    - **Node floor for code extensions:** earlier releases have known permission-model bypasses, so code
      extensions run only on Node ≥ 22.23.2, ≥ 24.18.1 or ≥ 26.5.1, the July 29, 2026 security releases. Those fix
      CVE-2026-58043, where path matching over-granted file-system access. Earlier fixes include CVE-2025-55130
      (symlinks), CVE-2025-55132 (`futimes`), CVE-2026-21715 and -21716, and CVE-2026-48617 and -48935. 22.13.0 also
      has CVE-2025-23083 (`module.register` plus a diagnostics_channel worker). Lines 23 and 25 are end of life and
      refused. Below the floor, the connection says "Code extensions need Node ≥ X (xaq is running on Y). Update Node
      and restart xaq." and nothing is spawned.
    - xaq itself still runs on ≥ 22.13: remote extensions and everything else work there.
- **Protocol:** standard MCP over stdio, with xaq as the client. Extension-to-host custom JSON-RPC:
  - request `xaq/credentials/get`, params `{}`, returns `{ accessToken, expiresAt }` for **this connection only**. xaq
    refreshes it with its single-flight refresher. An error means needs-reauth.
  - notification `xaq/events/emit`: `{ type, dedupeKey, data }`. The type must be in the manifest's `events`. Events
    go through the outbox like native events today.
  - notification `xaq/log`: `{ level, msg, meta }`, rate-limited and redacted.
  - *Clarified (B3), as built in `server/extensions/host`:*
    - Framing is newline-delimited JSON-RPC 2.0 on stdin/stdout (the MCP stdio transport). stdout carries only
      JSON-RPC; anything else is dropped and logged. Use stderr or `xaq/log` for logs.
    - xaq opens with the 2025-era `initialize` handshake (no `server/discover` probe), offering the SDK's latest
      2025 version, with no client capabilities: no sampling, elicitation or roots. The server should declare
      `tools`, and `prompts` and `resources` if it has them; xaq asks only for what's declared.
    - `xaq/credentials/get`: params must be `{}` (or carry only `_meta`). Anything else, such as a connection id, is
      refused with -32602. `expiresAt` is epoch milliseconds, or null when unknown. A refusal is error -32010 with
      `data.reason: "needs_reauth"`. The client secret and the refresh token are never sent.
    - `xaq/events/emit`: `type` matches `<name>.<event>` and is listed in `code.events`; `dedupeKey` is 1 to 200
      printable ASCII characters (unique per occurrence); `data` is a JSON object of at most 8 KB. It's rate-limited
      to a burst of 30, then 1 per second. Anything else is dropped with a log line.
    - `xaq/log`: `level` is `debug`, `info`, `warn` or `error`. `msg` is capped at 500 characters and `meta` at
      1 KB of JSON. Both are redacted, including the access token xaq handed out. It's rate-limited to a burst of 20,
      then 1 per second.
    - Limits per connection: 8 requests in flight (more are refused at once as `rate_limited`), one stdout message
      up to 8 MB (a larger one kills the child, counted as a crash), 15 s to start and finish `initialize`, 30 s per
      list and 60 s per call.
    - The extension must exit when stdin closes (xaq may be gone), and should exit on SIGTERM.
- **Lifecycle:**
  - The child starts when its connection is active and stops (SIGTERM, then SIGKILL after 5 s) on disable, remove,
    update or shutdown.
  - A crash restarts it with backoff; repeated crashes mark the connection `error` with the last stderr lines,
    redacted.
  - *Clarified (B3):* the backoff is 1 s, doubling, up to 60 s. Five crashes in a row (a child that ran for 60 s
    resets the count) mark the connection `error`, and it isn't restarted until the connection is reloaded or xaq
    restarts. A failed integrity check also marks it `error`, with the reason, and never spawns. A good start clears
    an `error` the host set.
  - Scheduled work, such as a polling sync, is the extension's own timer while it runs.

## Google accounts for code extensions

An official code extension (google-workspace: Docs, Sheets, Slides and the Drive files to find them) can work as one
of xaq's connected Google accounts, through xaq's own OAuth client, with access added incrementally when the user opts
in. Core side: `server/extensions/google-auth.ts` (binding, connect, tokens, status), `server/extensions/google-setup.ts`
(the setup steps), `server/google/scoped.ts` (downscoped tokens), `server/google/apis.ts` (API links and probe).

- **Binding:** a connection is bound to ONE connected account, picked in setup (the `google_account` input: an email or
  account id). It's kept in `connections.google_account_id` (migration 12, `ON DELETE SET NULL`). Nothing else per
  connection is stored: the refresh token stays the account's.
- **Connecting** (`POST /api/connections/:id/connect` with `inputs.google_account`, or Reconnect with the bound one):
  - the picked account is bound only when it already granted every manifest scope (connected at once) or once its
    consent comes back with some of them (kept with the pending attempt): an abandoned or cancelled re-pick leaves the
    connection on its old account. A successful consent re-lists the connection's tools at once;
  - otherwise Google's consent for exactly the manifest's scopes on top of what the account has
    (`include_granted_scopes=true`, `login_hint`, the existing client and `/oauth/callback`, as "Add Calendar" does).
    It never asks for Calendar on its own, and a later account reconnect asks again for scopes the account had;
  - the account's granted scopes are recorded as Google returns them; existing scopes are never revoked;
  - unticked boxes: the account keeps what was ticked, and the callback says, in plain words, what each missing scope
    would have allowed and what won't work without it (`oauth_extension_not_granted`); a cancel, an admin block or the
    wrong Google account are said for the extension too. Paste mode goes through `POST /api/connections/finish`.
- **Status:** `needs_reauth` while there's no usable access (no account picked, the account removed or needing a
  reconnect, nothing granted), with the reason; `active` once any of the manifest's scopes is granted. Recomputed on
  every account change (bus `account`) and shown live in the connection view (`ConnectionView.google`: the account,
  the granted and the missing scopes in plain words; `grantedScopes` holds the granted ones).
- **`xaq/credentials/get`** returns `{ accessToken, expiresAt }` (unchanged shape) for the account bound to THIS
  connection, read on every call, downscoped to the manifest's scopes that account granted:
  - Google's refresh grant with an explicit `scope`, a subset of the granted scopes (RFC 6749 §6: the token gets exactly
    that scope, which "MUST NOT include any scope not originally granted"). Google's client libraries send it the same
    way (google-auth's `refresh_grant`: "If present, all scopes must be authorized for the refresh token").
  - **Fail closed:** the token is handed over only when Google's response names its `scope` and every scope is within
    what was asked for, and within the manifest's (checked twice). Identity scopes Google may add (`openid`,
    `userinfo.email`, `userinfo.profile`, `email`, `profile`) are accepted: they can't read mail or files. Otherwise it's dropped (`DownscopeError`, the
    extension gets needs_reauth). An extension never receives a token that can read or send Gmail.
  - Cached per account and scope set until a minute before it expires, dropped when the account's refresh token
    changes; one refresh in flight per account and scope set. Never written over the account's own token or scopes.
  - Every failure is needs_reauth (`-32010`) with plain words. The tokens handed out are scrubbed from tool output like
    stored credentials.
- **Core's own use** (`server/google/scoped.ts`): `accountHasScopes(ctx, accountId, scopes)` and
  `googleAccessToken(ctx, accountId, scopes)` (a downscoped token for any granted subset; `ScopesNotGrantedError` when
  not granted). Scope constants, including `DRIVE_READONLY_SCOPE` and `WORKSPACE_SCOPES`, are in `server/google/scopes.ts`.
- **Setup, in the product** (the console, from `PresetView.setupSteps`): core's four steps come first, then the manifest's own.
  1. **Pick the Google account** from xaq's connected ones (`input.choices`; one needing a reconnect is disabled), with
     a link to add one.
  2. **Turn on the APIs** in the user's own Cloud project: a link per API
     (`https://console.cloud.google.com/apis/library/<service>?project=<project id>`, the project from the Google step
     of the setup wizard), a copyable `gcloud services enable … --project=<id>`, and Check again
     (`POST /api/connections/presets/:id/google-apis {account}`). The probe is a cheap read per known API (Drive, Docs,
     Sheets, Slides), with a downscoped token: the extension's granted scopes, or only the identity scopes before
     consent. Google's `SERVICE_DISABLED` / `accessNotConfigured` reads "off" (with Google's activationUrl when it
     sends one); before consent an API that answers "insufficient scopes" reads "not checked yet".
  3. **Allow access on Google's screen:** the new permissions in plain words, tick every box, and for a non-Internal
     app Google's "unverified app" warning (Advanced → Go to <app>) and the test-user rule.
  4. **Done:** the granted scopes and anything missing, explained on the connection.
  The CLI prints the steps and links, picks the account (`--account`), checks the APIs (offering to check again), then
  opens the consent URL (or asks for the pasted address).
- **Revoke:** removing the extension or the connection keeps the account's granted scopes (core may use them too, and
  other connections may share them). To drop them, remove xaq's access at https://myaccount.google.com/permissions:
  that removes all of xaq's access to the account, mail included, so reconnect the account in xaq afterwards.

## Prompts and resources

`/mcp` passes upstream prompts and resources through for every connection, remote and code:
- **Prompts** are `<slug>__<name>`.
- **Resources** are `xaq://<slug>/<encodeURIComponent(original uri)>`, with names prefixed `<slug>__`.
- **Templates:** resource templates are passed through the same way.
- **Access:** both are "read" class. An agent sees them when it has any grant on the connection.
- *Clarified (B3):*
  - In a resource template, the literal parts are `encodeURIComponent`-encoded and the `{…}` expressions are kept, so
    a client expands it as usual and the URI decodes back to the upstream's own URI. A variable's value reaches the
    upstream percent-decoded.
  - `prompts/get` and `resources/read` are routed by slug and audited like a read tool call (actions `prompts/get` and
    `resources/read`, target the connection). The lists aren't audited, like `tools/list`.
  - Results are cleaned like tool output: ANSI and control characters and invisible characters are removed, the
    connection's secrets scrubbed, and xaq's delimiters escaped. `uri`s inside them, such as an embedded resource,
    are rewritten to the `xaq://` form, and binaries over 5 MB are left out.
  - Resource text, from `resources/read` or a resource embedded in a prompt, is wrapped as tool output is, in
    `<tool_output source="<slug>/…" nonce="…" untrusted>`. Prompt messages aren't wrapped: a prompt is instructions
    the user chose to send, and wrapping would defeat it.
  - The `/mcp` server declares `prompts` and `resources` only for an agent with at least one connection grant. Each
    list asks every granted connection in parallel; one that fails or takes longer than 10 s is left out of that
    answer.

## Migration from core presets (no re-auth)

- **Core:** the Notion, T3 Code and WHOOP presets leave core. Core keeps the generic machinery: remote MCP OAuth,
  `user_app` OAuth with refresh, private-target allow, expiry, events and outbox.
  - *Clarified (B3):* `user_app` OAuth is `server/broker/upstream/user-app.ts`, driven by the preset's auth (a code
    manifest's `code.auth`): authorization code with the client secret in the body, no PKCE, https endpoints only.
    The refresh request sends `scope=<code.auth.refreshScope>` when the manifest sets it, and no `scope` otherwise
    (the originally granted scope applies, RFC 6749 §6). WHOOP's manifest sets `"refreshScope": "offline"`: WHOOP's
    documented refresh request includes it, as the native code did. There's no user-id lookup: it only routed webhooks.
    The generic `/hooks/connections/:id` route stays mounted but answers 404, because no preset in core handles webhooks.
- **Pins, plus a data snapshot:** core carries `server/extensions/bootstrap.json`, the pins (name, commit, integrity)
  of the official notion, t3code, whoop and brightspace extensions at release time. It also carries a data snapshot of
  the official remote manifests for already-bound connections, `server/extensions/bootstrap/{notion,t3code}.json`.
  They are byte-identical to the pinned repo files, a test checks that, and they hold no code.
- **Upgrade, at startup:**
  - each connection whose `preset` is one of these is bound to that extension;
  - a missing extension is installed in the background from its bootstrap pin;
  - until it's installed, a connection of notion or t3code works under the snapshot: its risk map, setup copy,
    `userServer`/`sameOriginIssuer` and policies. Nothing gets looser than before the upgrade, and a reconnect still
    works, so a T3 connection never dies at its 30-day expiry because an install failed;
  - the snapshot serves only connections already bound to that name. It isn't offered in Add connection, since new
    connections need the installed extension, and an installed extension always wins over it;
  - any other bound remote connection runs on the generic rules, and a code one reads "Needs the <name> extension.
    Install it from Extensions in the console." (shown as status `error`, not
    stored), with its tools unavailable;
  - *Clarified (B3):* a forced removal disables the connections. When an official extension is installed again,
    its connections (still bound) return to `active` if their credentials are still there, or to `needs_reauth`;
    no new sign-in is needed. A third-party one's connections were unbound, so they stay disabled;
  - tokens, client records, grants, levels and always-allow rules are untouched: nobody re-authorizes.
- **Binding:** `connections.preset` holds the extension's name. That is the binding, with no extra column.
  `usedBy(name)` is the ids of the connections `WHERE preset = name` (`server/extensions/bootstrap.ts`).
- **Reconnect before the install:** through the snapshot for notion and t3code. A bound connection with neither an
  install nor a snapshot can't be reconnected: its sign-in waits for the extension's own rules instead of running
  generic ones. Its tools keep working on the stored credential.
- **The registry:** `presets()` (`server/integrations/index.ts`) stays synchronous. It lists the installed extensions'
  presets, then what is still in core; an installed extension replaces a core preset of the same name.
- **Startup wiring** (the broker's `start()`): `useExtensionStore(extensionStore(ctx))`, then `setHooks` with:
  - `usedBy`, as above;
  - `onRemove`: a forced removal disables the bound connections and, for a third-party name, unbinds them. Their
    credentials stay until the connections are removed.
  - `onChange`: `reloadPresets()`, then the bound connections are re-listed, which re-classifies their pinned tools
    under the new manifest, or under the generic rules once it's gone.
  A background install from a bootstrap pin re-lists the same way. The broker's `stop()` unregisters the store.
- **Validation:** the store's `checkManifest` is `validateManifest`; an invalid manifest is an `invalid` error.
- **Placeholder pins:** an all-zero commit in `bootstrap.json` installs nothing. The release fills in the real pins.
- **Test:** a DB fixture shaped like Wynn's install: `notion-personal` and `notion-work` (Notion preset), `whoop` (a
  generic MCP connection to the dashboard URL with a bearer key) and `brightspace` (generic, bearer, `127.0.0.1`). After
  the upgrade, all four list and call tools with the same credentials and exposed names, with Notion's rules intact
  (spawning a Custom Agent asks, its reads stay listed at Read only), before and after the install.
