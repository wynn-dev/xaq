# Console screenshots

Taken from demos against a fake Google (`scripts/demo/seed.ts`) by `scripts/demo/docs-shots.mjs`.
1280 px wide at 1.5× unless noted; wizard steps are full-page.

| File | What it shows |
|---|---|
| `wizard-1-address.png` | Setup wizard, step 1: the address of xaq, with the "All on this computer" advice open |
| `wizard-2-project.png` | Step 2: a new Google Cloud project, created with one Cloud Shell command |
| `wizard-3-signin-screen.png` | Step 3: the Google sign-in screen, External chosen, with the "publish the app" step |
| `wizard-4-oauth-client.png` | Step 4: OAuth client form values, the imported client JSON, and Google's client check (all green) |
| `wizard-5-gmail.png` | Step 5: a connected Google account (Gmail and Calendar in one sign-in) |
| `wizard-6-agent.png` | Step 6: a `connect` request from the agent's terminal, approved inline with its code |
| `wizard-7-verify.png` | Step 7: "Check that it works", every check green and "Setup complete" |
| `overview.png` | Overview: account needing reconnect, agent asking for access, pending approval, 24 h stats and activity |
| `overview-dark.png` | The same in dark mode |
| `overview-mobile.png` | Overview on a phone (390 px, 2×) |
| `accounts.png` | Gmail accounts with their Calendar status, one needing reconnect, with the agents using each |
| `agents.png` | Agents list with the "Connect an agent" entry point and a pending access request |
| `connect-agent.png` | Connect an agent: the `connect` command per tool and a waiting request to approve |
| `agent-grant-editor.png` | Agent detail: grant editor (capabilities, thread-level label scope, send mode, recipients, caps) |
| `agent-listeners.png` | Agent detail: MCP setup commands and connected listeners |
| `pairing-request.png` | Approvals, Agent access: a request opened from the terminal's link |
| `pairing-approve.png` | Approving a request: type the terminal's code, choose access (starts at read-only) |
| `approvals.png` | Approvals: a reply waiting for review, with the agent's reason |
| `events.png` | Live events feed |
| `audit.png` | Audit log with a guardrail denial expanded |
| `audit-dark.png` | Audit log in dark mode |
| `settings.png` | Settings: agent pairing toggle, attachment directories, Google OAuth client |

Regenerate after `pnpm build` with `node scripts/demo/docs-shots.mjs` (add `--only name,name` for a few). It
starts and stops its own demos on ports 8425 and 8531; see the header of that file for the Playwright setup.
