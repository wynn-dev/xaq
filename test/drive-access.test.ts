// agentCanReadDrive with the real connection → Google account binding (connections.google_account_id, migration 12;
// server/google/workspace-binding.ts). test/mail-attach-sources.test.ts and test/e2e-drive-attachments.test.ts cover
// the attachments end to end.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentCanReadDrive } from "../server/google/drive-access.ts";
import { GOOGLE_WORKSPACE_EXTENSION, workspaceConnectionAccount } from "../server/google/workspace-binding.ts";
import { grantInput } from "./mail-fakes.ts";
import { testContext } from "./helpers.ts";

let t: ReturnType<typeof testContext>;
beforeAll(() => {
  t = testContext();
});
afterAll(() => t.dispose());

describe("agentCanReadDrive", () => {
  it("follows connections.google_account_id, only on google-workspace connections", () => {
    const { ctx } = t;
    const now = new Date().toISOString();
    for (const [id, email] of [["acc_x", "x@example.com"], ["acc_y", "y@example.com"]] as const) {
      ctx.db.run("INSERT INTO accounts (id, email, display_name, status, refresh_token_enc, created_at) VALUES (?, ?, 'X', 'active', 'x', ?)", id, email, now);
    }
    const { agent } = ctx.policy.createAgent({ name: "drive-agent", grants: [grantInput("acc_x", { capabilities: ["read", "send"] })] });
    const connection = (id: string, preset: string, accountId: string | null, slug: string) => {
      ctx.db.run(
        `INSERT INTO connections (id, kind, preset, slug, name, url, auth_type, level_default, status, google_account_id, created_at, updated_at)
         VALUES (?, 'remote_http', ?, ?, 'Google Workspace', 'https://workspace.example/mcp', 'none', 'read', 'active', ?, ?, ?)`,
        id,
        preset,
        slug,
        accountId,
        now,
        now,
      );
      ctx.db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, 'read', ?, ?)", agent.id, id, now, now);
    };

    // Unbound (no account picked yet): no Drive.
    connection("con_unbound", GOOGLE_WORKSPACE_EXTENSION, null, "gws-a");
    expect(workspaceConnectionAccount(ctx.db, "con_unbound")).toBeNull();
    expect(agentCanReadDrive(ctx, agent.id, "acc_x")).toBe(false);

    // Another extension's connection with an account id: not a Workspace binding.
    connection("con_other", "notion", "acc_x", "notion-a");
    expect(workspaceConnectionAccount(ctx.db, "con_other")).toBeNull();
    expect(agentCanReadDrive(ctx, agent.id, "acc_x")).toBe(false);

    // Bound to the account: Drive for that account only.
    connection("con_bound", GOOGLE_WORKSPACE_EXTENSION, "acc_x", "gws-b");
    expect(workspaceConnectionAccount(ctx.db, "con_bound")).toBe("acc_x");
    expect(agentCanReadDrive(ctx, agent.id, "acc_x")).toBe(true);
    expect(agentCanReadDrive(ctx, agent.id, "acc_y")).toBe(false);

    // The account removed from xaq: ON DELETE SET NULL unbinds it.
    ctx.db.run("UPDATE connections SET google_account_id = NULL WHERE id = 'con_bound'");
    expect(agentCanReadDrive(ctx, agent.id, "acc_x")).toBe(false);
  });
});
