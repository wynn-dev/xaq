# ADR 0002: one-click update from the console, done by a separate job

Status: **accepted**, 2026-10-27 (W69). Research: task T547.

## Context

The console already shows **Update available** and the command to run (`npx xaq-cli service install …`). The admin
still has to open a shell on the server. We want an **Update now** button that does the same safely: it never
leaves a broken install, it can go back, and it's no weaker against a compromised release than a person reading
the command first.

T547 weighed three designs:
- **(A)** the app replaces its own files and re-execs;
- **(B)** the app shells out to `service install`;
- **(C)** the app hands the work to a separate supervisor job and exits the picture.

(A) and (B) both run inside the process being replaced. The service manager stops that process (and everything in
its cgroup) halfway through the swap, and nothing would be left to roll back. (C) is the only one where the code
doing the swap outlives the restart.

## Decision

1. **The update is a separate job.** `POST /api/system/update` starts it:
   - on Linux, `systemd-run [--user] --unit=xaq-update --collect`: a transient unit outside `xaq.service`'s cgroup;
   - on macOS, a launchd job `sh.xaq.update`, with RunAtLoad and no KeepAlive. Its plist lives in
     `<data>/update/`, never in LaunchAgents, so nothing runs it again at login.

   The job is `xaq service update-run` (hidden), run by the current Node and the current install's CLI.
2. **Service mode only.** The button exists only when the process is a service (`XAQ_SERVICE=1`) on
   systemd/launchd that runs from its own install, `<data>/app/node_modules/xaq-cli`. Foreground runs, source
   checkouts and a pre-rename service keep the notify-only dialog with the command.
3. **The gate is an admin session plus the password again.** The re-entered password counts toward the same lockout
   as sign-in. Every attempt is audited as `system.update` (`ok`, or `denied` with `bad_password`, `lockout`,
   `busy`, `unsupported`, `in_progress`, `not_latest`, `no_latest` or `no_previous`, or `error`
   `launch_failed`). The job audits its own outcome as `system.update.result`, actor `system`: `ok`, or `error`
   with `failed`, `rolled_back` or `rollback_failed`.
4. **Only forward to npm `latest`.** The request names the version the console showed. The server accepts it only
   if it is the current `latest` dist-tag and newer than the running version. There is no new channel and no tag.
   Nothing ever starts on its own.
5. **Supply-chain checks are required.** `stagePackage` takes a `version` (a plain `x.y.z[-pre]`, never a range,
   tag, URL or path) and `harden: true`. With both, it installs `xaq-cli@<version>` into `<data>/app.new` with
   `--ignore-scripts`, then refuses (deleting app.new and changing nothing) unless:
   - the package ships an `npm-shrinkwrap.json` (lockfile v2+), and every runtime entry in it is installed at
     exactly the pinned version, with an integrity hash;
   - `npm audit signatures` passes: registry signatures, plus provenance attestations where the package has them.

   Releases get the shrinkwrap from `scripts/shrinkwrap.mjs` in `nightly.yml`, and `npm-shrinkwrap.json` is in
   `files`.
6. **The job's steps**, each written to `<data>/update/status.json`:
   1. stage the new version (the service keeps running; a refusal ends here with nothing changed);
   2. stop the service (systemd `stop`, not `disable`; launchd `bootout` and wait);
   3. copy the SQLite database with its WAL and SHM to `<data>/update/db-snapshot/`;
   4. swap: `app` becomes `app.old`, and `app.new` becomes `app` (`swapIn`);
   5. start the service;
   6. poll `/api/health` until it answers **with the new version** (about 60 s).

   If any step from the start on fails, the job stops the service, restores the snapshot, moves `app.old` back
   and starts the service again. It then checks that the old version answers and reports `rolled_back` (or
   `rollback_failed`). On success, it keeps `app.old` and the snapshot.
7. **"Go back" is the same job**, with `--back`. It exchanges `app` and `app.old` and runs steps 2 to 6 the same
   way, including the automatic rollback. It reuses the kept install rather than staging the old version from npm
   again. That install already ran here, it needs no network, and releases from before the shrinkwrap would fail
   the checks. The console offers it only when `app.old` holds an older version.
8. **The console follows it.** The tab keeps the job's id in sessionStorage and polls the status and the public
   `/api/health` every 2 s. Once health answers with the target version, it reloads once to load that version's
   console, then shows the outcome: success, or the failure and whether the previous version is back.

## What is lost across the restart

- **Pending Google consents and the handed-token scrub list are in memory only.** A consent started just before
  the update has to be started again. Tokens handed out before the restart aren't scrubbed from later output.
- **In-flight MCP requests** are cut off by the graceful shutdown (up to 10 s; `server/server.ts`). MCP is stateless
  per request (`server/mcp/index.ts`), so agents retry.
- **Listener streams** reconnect and resume from their cursor (`agentapi/stream.ts`). Nothing is lost.
- **Console sessions** live in the database and survive, unless a rollback restores the snapshot. Sessions created
  during the failed attempt are then gone.
- **On rollback**, whatever the failed version wrote to the database before it failed is gone with the snapshot.
  That includes mail ingested in those seconds, which ingest fetches again.

## Consequences

- **The job runs from `<data>/app` and moves it aside mid-run.** In the bundle, a lazy `import()` after the swap would
  load the other version's chunks. `server/update.ts` therefore imports everything statically, and a test fails if
  anything it loads imports dynamically.
- **The unit file isn't rewritten.** Its entry path (`<data>/app/…/dist/cli.js`) stays valid across the swap. A
  release that needs a different unit (new environment, new flags) still needs `service install`.
- **"Go back" keeps the current database.** Migrations are additive and an older version ignores ones it doesn't
  know. The snapshot from before the last update stays in `<data>/update/db-snapshot/` for a manual restore.
- **Extensions and listeners aren't touched.** Listeners are separate units, maybe on other machines. They keep
  their own `listen service install` path.
- **The shrinkwrap is npm's resolution** of `package.json`'s ranges at publish time, not `pnpm-lock.yaml`'s. So
  the published tree can differ in patch versions from what CI tested (docs/FOLLOWUPS.md).
- **Logs:** `journalctl [--user] -u xaq-update` on Linux, `<data>/update/update.log` on macOS.

## Alternatives considered

- **(A) self-replacement in the process:** rejected. The swap would be done by the process being stopped.
- **(B) running `service install` from the app:** rejected for the same reason. It also rewrites the unit and
  runs `disable --now` on the service it runs under.
- **Staging the previous version from npm for "go back":** rejected for the reasons in decision 7.
- **Auditing the outcome from the app at startup:** rejected. The new version starts before the job knows whether
  it is healthy. A refusal at staging never restarts anything. So the job writes the entry itself, through the same
  `AuditLog`.
