// agentCanReadDrive with the real connection → Google account binding (server/google/workspace-binding.ts). Until
// writer C's binding merges it binds nothing, so Drive attachments are refused for every agent: fail closed.
// test/mail-attach-sources.test.ts covers the grant rules with bound connections.

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
  it("is false without C's binding, even with a grant on a google-workspace connection", () => {
    const { ctx } = t;
    const now = new Date().toISOString();
    ctx.db.run(
      "INSERT INTO accounts (id, email, display_name, status, refresh_token_enc, created_at) VALUES ('acc_x', 'x@example.com', 'X', 'active', 'x', ?)",
      now,
    );
    const { agent } = ctx.policy.createAgent({ name: "drive-agent", grants: [grantInput("acc_x", { capabilities: ["read", "send"] })] });
    ctx.db.run(
      `INSERT INTO connections (id, kind, preset, slug, name, url, auth_type, level_default, status, created_at, updated_at)
       VALUES ('con_gws', 'remote_http', ?, 'gws', 'Google Workspace', 'https://workspace.example/mcp', 'none', 'read', 'active', ?, ?)`,
      GOOGLE_WORKSPACE_EXTENSION,
      now,
      now,
    );
    ctx.db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, 'con_gws', 'full', ?, ?)", agent.id, now, now);
    expect(workspaceConnectionAccount(ctx.db, "con_gws")).toBeNull();
    expect(agentCanReadDrive(ctx, agent.id, "acc_x")).toBe(false);
  });
});
