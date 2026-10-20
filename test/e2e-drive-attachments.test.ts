// E2E: attaching a Google Drive file over MCP with a real Google Workspace binding. The account connects through the
// real OAuth flow (the fake consent grants drive.readonly too, as the Google Workspace setup leaves it), a
// google-workspace connection is bound to it through connections.google_account_id (migration 12; the extension's
// own setup lives in another repo), and agents get access through the admin API. Drive is read with a token limited
// to drive.readonly, never the account's full one.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Account, AgentWithKey, ConnectAccountResponse } from "../shared/types.ts";
import { DRIVE_READONLY_SCOPE, GMAIL_SCOPE } from "../server/google/scopes.ts";
import { GOOGLE_WORKSPACE_EXTENSION } from "../server/google/workspace-binding.ts";
import { HAS_AGENTS } from "./e2e/features.ts";
import { grant, mailbox, type Stack, startStack } from "./e2e/harness.ts";
import type { Agent } from "./e2e/mcp.ts";

// The path and Drive checks look at the home directory's secret places: give them a temporary one.
process.env.HOME = mkdtempSync(join(tmpdir(), "xaq-e2e-home-"));
for (const v of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) delete process.env[v];

const IDENTITY = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"];

let s: Stack;
let email: string;
let account: Account;
let connectionId: string;
const agents: Agent[] = [];

/** Connects `email` through the console API and the fake consent screen, granting exactly `scopes`. */
async function connectWith(address: string, scopes: string[]): Promise<Account> {
  s.fake.addAccount(address, { name: "Office" });
  const start = await s.admin.post<ConnectAccountResponse>("/api/accounts/connect", {});
  s.fake.consentAs(address, { scopes });
  const consent = await fetch(start.authUrl, { redirect: "manual" });
  const location = consent.headers.get("location");
  if (consent.status !== 302 || !location) throw new Error(`fake consent failed: HTTP ${consent.status}`);
  if (start.callbackMode === "paste") return s.admin.post<Account>("/api/accounts/connect/complete", { url: location });
  const cb = await fetch(location);
  expect(cb.status).toBe(200);
  return (await s.admin.get<Account[]>("/api/accounts")).find((a) => a.email === address)!;
}

async function agentWith(name: string, workspaceLevel: "read" | null) {
  const body = { name, grants: [grant(account.id, { capabilities: ["read", "send"], sendMode: "direct" })] };
  const { agent, apiKey }: AgentWithKey = await s.admin.post<AgentWithKey>("/api/agents", body);
  if (workspaceLevel) {
    // The console's connection access: PUT replaces the connection's grants, so keep the others.
    const current = await s.admin.get<{ agentId: string; level: string }[]>(`/api/connections/${connectionId}/grants`);
    await s.admin.put(`/api/connections/${connectionId}/grants`, {
      grants: [...current.map((g) => ({ agentId: g.agentId, level: g.level })), { agentId: agent.id, level: workspaceLevel }],
    });
  }
  const mcp = await s.agent(apiKey);
  agents.push(mcp);
  return mcp;
}

describe.runIf(HAS_AGENTS)("MCP Drive attachments with a Google Workspace binding", () => {
  beforeAll(async () => {
    s = await startStack();
    email = mailbox("drive");
    await s.bootstrap({});
    account = await connectWith(email, [GMAIL_SCOPE, ...IDENTITY, DRIVE_READONLY_SCOPE]);
    expect(account.grantedScopes).toContain(DRIVE_READONLY_SCOPE);
    // What the Google Workspace extension's setup leaves behind: a google-workspace connection bound to the account.
    connectionId = "con_gws_e2e";
    const now = new Date().toISOString();
    s.ctx.db.run(
      `INSERT INTO connections (id, kind, preset, slug, name, url, auth_type, level_default, status, google_account_id, created_at, updated_at)
       VALUES (?, 'remote_http', ?, 'gws', 'Google Workspace', 'https://workspace.example/mcp', 'none', 'read', 'active', ?, ?, ?)`,
      connectionId,
      GOOGLE_WORKSPACE_EXTENSION,
      account.id,
      now,
      now,
    );
  });
  afterAll(async () => {
    await Promise.allSettled(agents.map((a) => a.close()));
    await s.close();
  });

  it("attaches the file for an agent granted the bound connection, with a Drive-only token; refuses one without", async () => {
    const content = Buffer.from("%PDF-1.7\n% budget\n");
    const fileId = s.fake.drive.addFile(email, { name: "budget.pdf", mimeType: "application/pdf", content });
    const args = { to: "cfo@example.org", subject: "Budget", body: "Attached.", attachments: [{ drive_file_id: fileId }] };

    const without = await agentWith("no-workspace", null);
    const refused = await without.call("send_message", args);
    expect(refused).toMatchObject({
      isError: true,
      text: expect.stringContaining(`This agent has no access to Google Drive for ${email}: grant it the Google Workspace connection.`),
    });

    const served = s.fake.drive.served.length;
    const withAccess = await agentWith("workspace-reader", "read");
    const r = await withAccess.json<{ status: string; messageId: string }>("send_message", args);
    expect(r.status).toBe("sent");
    const sent = s.fake.message(email, r.messageId)!;
    const parsed = s.ctx.google.mime.parse(sent);
    expect(parsed.attachments.map((a) => [a.filename, a.mimeType, a.size])).toEqual([["budget.pdf", "application/pdf", content.length]]);

    // The download used a token limited to drive.readonly: no Gmail access in it.
    const download = s.fake.drive.served.slice(served);
    expect(download).toHaveLength(1);
    expect(download[0]!.scopes).toContain(DRIVE_READONLY_SCOPE);
    expect(download[0]!.scopes).not.toContain(GMAIL_SCOPE);
  });

  it("an unbound connection gives no Drive access, and a bound account without Drive gets the plain message", async () => {
    const fileId = s.fake.drive.addFile(email, { name: "x.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF") });
    const args = { to: "a@example.org", subject: "s", body: "b", attachments: [{ drive_file_id: fileId }] };
    s.ctx.db.run("UPDATE connections SET google_account_id = NULL WHERE id = ?", connectionId);
    try {
      const unbound = await agentWith("unbound", "read");
      expect((await unbound.call("send_message", args)).text).toContain(`This agent has no access to Google Drive for ${email}`);
    } finally {
      s.ctx.db.run("UPDATE connections SET google_account_id = ? WHERE id = ?", account.id, connectionId);
    }

    // The account's recorded scopes lose Drive (unticked at a later consent, say): the scope check refuses first.
    const scopes = JSON.stringify([GMAIL_SCOPE, ...IDENTITY]);
    const before = s.ctx.db.get<{ scopes: string }>("SELECT scopes FROM accounts WHERE id = ?", account.id)!.scopes;
    s.ctx.db.run("UPDATE accounts SET scopes = ? WHERE id = ?", scopes, account.id);
    try {
      const reader = await agentWith("no-scope", "read");
      expect((await reader.call("send_message", args)).text).toContain(
        `Drive isn't enabled for ${email}: install the google-workspace extension and enable Drive in xaq (Connections → Google Workspace)`,
      );
    } finally {
      s.ctx.db.run("UPDATE accounts SET scopes = ? WHERE id = ?", before, account.id);
    }
  });
});
