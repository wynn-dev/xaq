// `xaq connections add google-workspace` (server/connections-cli/manage.ts): the same flow as the console's setup
// view, in the terminal: pick one of xaq's connected Google accounts, a link per Google API in the project and the
// gcloud command, a check of each API, then the connection and its consent for that account.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addConnection } from "../server/connections-cli/manage.ts";
import { ScriptedPrompter } from "../server/connections-cli/prompt.ts";
import { presetFromValidManifest, validateManifest } from "../server/extensions/manifest.ts";
import { GMAIL_SCOPE, WORKSPACE_SCOPES } from "../shared/google-scopes.ts";
import { type Daemon, startDaemon } from "./connections-cli-fake.ts";
import { googleManifest } from "./google-extension-fixtures.ts";

const GOOGLE = presetFromValidManifest(validateManifest(googleManifest(), { official: true }), null, { official: true });

describe("connections add google-workspace", () => {
  let d: Daemon;
  beforeEach(async () => {
    d = await startDaemon({ presets: [GOOGLE] });
  });
  afterEach(() => d.dispose());
  const deps = (p: ScriptedPrompter) => ({ api: d.api, prompter: p, env: {}, pollMs: 1, timeoutMs: 2000 });
  /** What the real connector leaves behind once the account allowed access: bound, the scopes granted, active, tools. */
  const connected = (conn: { id: string; slug: string }, input: { inputs?: Record<string, string> }, tools: number) => {
    const db = d.h.ctx.db;
    const account = db.get<{ id: string }>("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE", input.inputs!.google_account!)!;
    db.run("UPDATE accounts SET scopes = ? WHERE id = ?", JSON.stringify([GMAIL_SCOPE, ...WORKSPACE_SCOPES]), account.id);
    db.run("UPDATE connections SET google_account_id = ?, status = 'active', status_reason = NULL WHERE id = ?", account.id, conn.id);
    d.giveTools(conn.slug, tools);
    return { status: "connected" as const };
  };
  const addAccount = (id: string, email: string, status = "active") =>
    d.h.ctx.db.run(
      "INSERT INTO accounts (id, email, display_name, status, refresh_token_enc, scopes, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
      id,
      email,
      status,
      d.h.ctx.crypto.encrypt("1//rt"),
      JSON.stringify([GMAIL_SCOPE]),
      new Date().toISOString(),
    );

  it("asks for the account, prints a link per API and the gcloud command, checks them, and connects with that account", async () => {
    addAccount("acc_me", "me@example.com");
    addAccount("acc_ops", "ops@example.com");
    addAccount("acc_old", "old@example.com", "needs_reauth");
    d.h.ctx.settings.setState("google.client", { clientId: "x.apps.googleusercontent.com", clientSecretEnc: null, projectId: "fake-project", appType: "external" });
    d.upstreams.connect = (conn, input) => connected(conn, input, 4);
    // Account 2 (ops), then the slug, access and agents defaults, and yes.
    const p = new ScriptedPrompter(["2", "", "", "", "y"]);
    expect(await addConnection("google-workspace", {}, deps(p))).toBe(0);
    expect(p.text).toContain("1. Pick the Google account");
    expect(p.text).toContain("   Google Docs API: https://console.cloud.google.com/apis/library/docs.googleapis.com?project=fake-project");
    expect(p.text).toContain("   Google Drive API: https://console.cloud.google.com/apis/library/drive.googleapis.com?project=fake-project");
    expect(p.text).toContain("gcloud services enable docs.googleapis.com sheets.googleapis.com slides.googleapis.com drive.googleapis.com --project=fake-project");
    expect(p.text).toContain("Google hasn't verified this app");
    expect(p.text).toContain("Which Google account should it work as?");
    expect(p.text).not.toMatch(/\d\. old@example\.com/); // needs reconnecting: not offered
    expect(p.text).toContain("Google Docs API: not checked yet");
    expect(d.upstreams.connects).toEqual([{ slug: "gws", input: { inputs: { google_account: "ops@example.com" } }, privateTarget: null }]);
    expect(p.text).toContain('Connected "gws": 4 tools');
  });

  it("--account picks it without asking; an account xaq doesn't have, or none at all, is said plainly", async () => {
    addAccount("acc_me", "me@example.com");
    d.upstreams.connect = (conn, input) => connected(conn, input, 1);
    await expect(addConnection("google-workspace", { account: "nobody@example.com" }, deps(new ScriptedPrompter([])))).rejects.toThrow(/isn't connected to xaq\. Connected: me@example\.com/);
    expect(await addConnection("google-workspace", { account: "ME@example.com" }, deps(new ScriptedPrompter(["", "", "", "y"])))).toBe(0);
    expect(d.upstreams.connects.at(-1)!.input).toEqual({ inputs: { google_account: "me@example.com" } });
    d.h.ctx.db.run("DELETE FROM connections");
    d.h.ctx.db.run("DELETE FROM accounts");
    await expect(addConnection("google-workspace", {}, deps(new ScriptedPrompter([])))).rejects.toThrow(/No Google account is connected to xaq yet/);
  });
});
