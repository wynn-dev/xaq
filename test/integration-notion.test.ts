// The Notion extension (xaq-extensions extensions/notion, a fixture copy): its manifest, through presetFromManifest,
// keeps the core preset's shape, setup copy and risk table exactly.

import { afterAll, describe, expect, it } from "vitest";
import type { ToolDef } from "../server/broker/types.ts";
import { presetById, presets } from "../server/integrations/index.ts";
import { fixtureManifest, useFixtureExtensions } from "./extension-fixtures.ts";

afterAll(useFixtureExtensions());
const notionPreset = presetById("notion")!;
const classifyNotionTool = (t: ToolDef) => notionPreset.classify(t);
const ALIASES = ["fetch", "search", "ai-search"];
const NOTION_TOOLS = Object.fromEntries(Object.entries(fixtureManifest("notion").risk!.tools).filter(([name]) => !ALIASES.includes(name)));

const tool = (name: string, properties: Record<string, unknown> = {}): ToolDef => ({
  name,
  description: "",
  inputSchema: { type: "object", properties },
});

// Written out independently of NOTION_TOOLS so a change to the data shows up here.
const READ = [
  "notion-search",
  "notion-ai-search",
  "notion-memory-search",
  "notion-get-tool-access",
  "notion-get-self",
  "notion-download-skill",
  "notion-get-enabled-skills",
  "notion-fetch",
  "notion-get-file-download-urls",
  "notion-list-private-pages",
  "notion-list-shared-pages",
  "notion-list-favorite-pages",
  "notion-list-recent-pages",
  "notion-list-page-backlinks",
  "notion-download-attachment",
  "notion-query-data-sources",
  "notion-query-multiple-data-sources",
  "notion-query-meeting-notes",
  "notion-search-agents",
  "notion-query-sessions",
  "notion-search-sessions",
  "notion-get-session-status",
  "notion-wait-session",
  "notion-list-session-events",
  "notion-read-session-event",
  "notion-get-comments",
  "notion-get-teams",
  "notion-get-groups",
  "notion-get-users",
  "notion-get-async-task",
];
const WRITE = [
  "notion-upload-skill",
  "notion-update-enabled-skills",
  "notion-convert-page-to-skill",
  "notion-create-file-upload",
  "notion-create-attachment",
  "notion-create-pages",
  "notion-update-page",
  "notion-move-pages",
  "notion-restore-pages",
  "notion-duplicate-page",
  "notion-create-database",
  "notion-create-folder",
  "notion-update-folder",
  "notion-update-data-source",
  "notion-create-view",
  "notion-update-view",
  "notion-stop-session",
  "notion-create-comment",
  "notion-update-comment",
  "notion-set-discussion-resolved",
  "notion-set-comment-reaction",
];
const RISKY = [
  "notion-delete-pages",
  "notion-delete-databases",
  "notion-delete-comment",
  // Custom Agents act on their own (Mail Send, Slack): delegating to one must ask like the action itself.
  "notion-spawn-session",
  "notion-send-message-to-session",
];

describe("Notion extension", () => {
  it("has the core preset's shape", () => {
    expect(notionPreset).toMatchObject({
      id: "notion",
      displayName: "Notion",
      slug: "notion",
      kind: "remote_http",
      url: "https://mcp.notion.com/mcp",
      auth: { type: "mcp_oauth" },
      reconnectPolicy: { maxLifetimeDays: 180, idleDays: 30 },
    });
    expect(notionPreset.slug).toMatch(/^[a-z0-9-]{1,24}$/);
    expect(presets()).toContain(notionPreset);
  });

  it("covers exactly Notion's 56 documented tools", () => {
    const expected = [...READ, ...WRITE, ...RISKY].sort();
    expect(new Set(expected).size).toBe(56);
    expect(Object.keys(NOTION_TOOLS).sort()).toEqual(expected);
  });

  it.each(READ)("%s is a read", (name) => {
    expect(classifyNotionTool(tool(name))).toEqual({ risky: false, read: true, source: "preset" });
  });

  it.each(WRITE)("%s is a write that goes through", (name) => {
    expect(classifyNotionTool(tool(name))).toEqual({ risky: false, read: false, source: "preset" });
  });

  it.each(RISKY)("%s is risky", (name) => {
    expect(classifyNotionTool(tool(name))).toMatchObject({ risky: true, read: false, source: "preset" });
  });

  it("maps the documented short aliases", () => {
    expect(classifyNotionTool(tool("fetch"))).toEqual({ risky: false, read: true, source: "preset" });
    expect(classifyNotionTool(tool("ai-search"))?.read).toBe(true);
    expect(classifyNotionTool(tool("search"))).toEqual({ risky: false, read: true, source: "preset" });
  });

  it("returns null for tools it doesn't know", () => {
    expect(classifyNotionTool(tool("notion-share-page"))).toBeNull();
    expect(classifyNotionTool(tool("notion-publish-site"))).toBeNull();
    expect(classifyNotionTool(tool("toString"))).toBeNull();
    expect(classifyNotionTool(tool("__proto__"))).toBeNull();
  });

  it("renders plain setup steps", () => {
    const steps = notionPreset.setupSteps({
      publicUrl: "https://inbox.example.com",
      redirectUri: "https://inbox.example.com/oauth/connections/callback",
      webhookUrl: null,
    });
    expect(steps.map((s) => s.id)).toEqual(["connect", "approve", "reconnect"]);
    expect(steps[0]!.title).toBe("Connect");
    expect(steps[1]!.title).toBe("In Notion, choose the workspace and approve");
    expect(steps[1]!.body).toMatch(/Business and Enterprise/);
    expect(steps[2]!.body).toMatch(/180 days/);
    expect(steps[2]!.body).toMatch(/30 days/);
    for (const s of steps) {
      expect(s.link).toBeUndefined();
      expect(s.input).toBeUndefined();
      expect(s.body).not.toMatch(/https?:\/\/|[*#[\]]/);
    }
  });

  // TODO(W10): enable once feat/broker-sdk-spike lands test/fake-mcp-upstream.ts and the upstream manager exists:
  // start the fake with Notion-like tool names, connect it through the preset's ToolSource, list and call a tool.
  it.skip("proxies a Notion-like fake upstream", () => {});
});
