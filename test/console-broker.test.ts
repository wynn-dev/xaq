// The console's broker decisions (src/components/connections/connection-flow.ts, approvals/mcp-call.ts,
// setup/first-run.ts) against the real /api/connections and approval DTOs: connection status in words, the Add
// connection request sequence, agent access over per-connection grants, the mcp.call card (targets, warnings, done
// states), and first run with Google optional (without disturbing the Google wizard).
import { describe, expect, it } from "vitest";
import type * as Shared from "../shared/types.ts";
import type { SetupState } from "../shared/types.ts";
import {
  alwaysAllowFor,
  argsHaveInvisible,
  asMcpApproval,
  atPointer,
  cardWarnings,
  doneState,
  escapeInvisible,
  isCallView,
  targetChoices,
  targetLabel,
  targetName,
} from "../src/components/approvals/mcp-call.ts";
import {
  agentConnections,
  authControl,
  connectInput,
  connectionStatusView,
  createInput,
  defaultName,
  draftControl,
  draftProblems,
  draftUrl,
  duplicateOf,
  emptyDraft,
  grantedScopesView,
  suggestDraftSlug,
  exactOrigin,
  finishEarlyCreate,
  grantsWith,
  hostPort,
  inputProblems,
  LEVEL_INFO,
  nameChange,
  oauthMessageFor,
  pastedProblem,
  privateExplanation,
  probeSummary,
  slugFromName,
  slugProblem,
  suggestSlug,
} from "../src/components/connections/connection-flow.ts";
import { brokerStatuses, firstRunView, shownWizard } from "../src/components/setup/first-run.ts";
import { stepStatuses } from "../src/components/setup/steps.ts";
import { fixtureManifest } from "./extension-fixtures.ts";
import { presetServerSlug } from "../shared/user-server.ts";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();
const ch = (cp: number) => String.fromCodePoint(cp);

const conn = (over: Partial<Shared.ConnectionView> = {}): Shared.ConnectionView => ({
  id: "con_1",
  ownerId: null,
  allAgents: false,
  kind: "remote_http",
  preset: "notion",
  slug: "notion",
  name: "Notion",
  url: "https://mcp.notion.com/mcp",
  authType: "oauth",
  levelDefault: "ask",
  privateTarget: null,
  status: "active",
  statusReason: null,
  expiresAt: null,
  protocol: null,
  toolsCachedAt: null,
  instructionsHash: null,
  createdAt: inDays(-3),
  updatedAt: inDays(-3),
  tools: { total: 12 },
  expiresInDays: null,
  expired: false,
  grantedScopes: null,
  broadScopes: null,
  scopeNotes: null,
  agents: 2,
  ...over,
});

const grant = (agentId: string, connectionId: string, level: Shared.AccessLevel): Shared.ConnectionGrant => ({ agentId, connectionId, level, createdAt: inDays(-1), updatedAt: inDays(-1) });

const probe = (over: Partial<Shared.ConnectionProbe> = {}): Shared.ConnectionProbe => ({ reachable: true, auth: "none", message: "", ...over });

const call = (over: Partial<Shared.McpCallApproval> = {}, detail: Partial<Shared.McpCallApprovalDetail> = {}): Shared.McpCallApproval => ({
  id: "apr_1",
  agentId: "agt_1",
  agentName: "Hermes",
  status: "pending",
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  body: "",
  threadId: null,
  attachments: [],
  reason: null,
  decidedAt: null,
  decisionNote: null,
  sentMessageId: null,
  error: null,
  createdAt: inDays(0),
  expiresAt: inDays(1),
  kind: "mcp.call",
  accountId: null,
  accountEmail: null,
  draftId: null,
  connectionId: "con_1",
  call: { tool: "notion-delete-pages", exposedName: "notion__notion-delete-pages", args: '{"page_id":"abc"}', argsSha256: "00", pinHash: "11", ...detail },
  ...over,
});

const view = (over: Partial<Shared.McpCallApprovalView> = {}): Shared.McpCallApprovalView => ({
  approval: call(),
  connection: { id: "con_1", slug: "notion", name: "Notion", status: "active" },
  tool: { exposedName: "notion__notion-delete-pages", name: "notion-delete-pages", title: null, risky: true, read: false, targetPath: "/page_id", level: "ask", pinMatches: true },
  argsDisplay: '{"page_id":"abc"}',
  pretty: '{\n  "page_id": "abc"\n}',
  recipients: [],
  urls: [],
  target: { path: "/page_id", value: "abc" },
  argumentPaths: ["/page_id"],
  argsIntact: true,
  ...over,
});

const notion: Shared.PresetView = { id: "notion", displayName: "Notion", slug: "notion", kind: "remote_http", url: "https://mcp.notion.com/mcp", authType: "oauth", setupSteps: [], reconnectPolicy: { maxLifetimeDays: 180 }, userServer: null, official: true };
const whoop: Shared.PresetView = {
  id: "whoop",
  displayName: "WHOOP",
  slug: "whoop",
  kind: "native",
  url: null,
  authType: "oauth",
  reconnectPolicy: null,
  userServer: null,
  official: true,
  setupSteps: [
    { id: "dash", title: "Open the developer dashboard", body: "Sign in with your WHOOP account.", link: { label: "Open dashboard", url: "https://developer.whoop.com" } },
    { id: "redirect", title: "Add the redirect URI", body: "Paste it as `Redirect URL`.", copy: { label: "Redirect URI", value: "http://localhost:8425/oauth/connections/callback" } },
    { id: "id", title: "Client ID", body: "", input: { key: "clientId", label: "Client ID", pattern: "[0-9a-f-]{36}" } },
    { id: "secret", title: "Client secret", body: "", input: { key: "clientSecret", label: "Client secret", secret: true } },
  ],
};

describe("Connections: status in plain words", () => {
  it("active, disabled (the kill switch) and needs reconnect, each with its fix", () => {
    expect(connectionStatusView(conn(), NOW)).toMatchObject({ label: "Active", tone: "good", action: null });
    const killed = connectionStatusView(conn({ status: "disabled", statusReason: "killed by the owner" }), NOW);
    expect(killed).toMatchObject({ label: "Disabled", action: "reconnect" });
    expect(killed.description).toMatch(/^Killed by the owner\. .*Reconnect/);
    const broken = connectionStatusView(conn({ status: "needs_reauth", statusReason: "Notion rejected the sign-in." }), NOW);
    expect(broken).toMatchObject({ label: "Needs reconnect", tone: "bad", action: "reconnect" });
    expect(broken.description).toContain("until you reconnect");
  });

  it("warns 'expiring in N days' from 7 days before expiresAt, red on the last day and after", () => {
    expect(connectionStatusView(conn({ expiresAt: inDays(30) }), NOW)).toMatchObject({ label: "Active", action: null });
    expect(connectionStatusView(conn({ expiresAt: inDays(7) }), NOW)).toMatchObject({ label: "Expires in 7 days", tone: "warn", action: "reconnect" });
    expect(connectionStatusView(conn({ expiresAt: inDays(0.5) }), NOW)).toMatchObject({ label: "Expires in 1 day", tone: "bad" });
    expect(connectionStatusView(conn({ expiresAt: inDays(-1) }), NOW)).toMatchObject({ label: "Expired", tone: "bad", action: "reconnect" });
  });
});

describe("T3 Code in the console: a user-named server, expiry and granted scopes", () => {
  const t3: Shared.PresetView = {
    id: "t3code",
    displayName: "T3 Code",
    slug: "t3",
    kind: "remote_http",
    url: null,
    authType: "oauth",
    setupSteps: [{ id: "server", title: "Enter your T3 Code server's address", body: "" }],
    reconnectPolicy: null,
    userServer: { defaultPath: "/mcp" },
    official: true,
  };

  it("asks for the address and checks it like a custom server; names and slugs come from the host", () => {
    const d = emptyDraft(t3);
    expect(d).toMatchObject({ url: "", name: "", slug: "" });
    expect(draftControl(d)).toBeNull();
    expect(draftProblems(d, [])[0]).toBe("Check the address first.");
    const typed = { ...d, url: "http://100.104.249.49:3773" };
    expect(draftUrl(typed)).toBe("http://100.104.249.49:3773/mcp");
    expect(defaultName(typed)).toBe("100.104.249.49:3773");
    expect(suggestDraftSlug(typed)).toBe("t3-100-104-249-49");
    expect(presetServerSlug("t3", "http://forge.tail1.ts.net:3773/mcp")).toBe("t3-forge");
    // On the tailnet: the private-network allow first, like any custom server.
    const blocked = { ...typed, slug: "t3-100-104-249-49", probe: probe({ reachable: false, auth: "unknown", blocked: "private_target", privateTarget: "http://100.104.249.49:3773" }) };
    expect(draftControl(blocked)).toEqual({ kind: "private" });
    expect(draftProblems(blocked, [])).toContain("Allow the private-network address, or use another one.");
    const ready = { ...blocked, probe: probe({ auth: "oauth", issuer: "http://100.104.249.49:3773", registration: "dcr", refresh: false }) };
    expect(draftProblems(ready, [])).toEqual([]);
    // A server that doesn't sign in isn't T3.
    expect(draftProblems({ ...ready, probe: probe({ auth: "none" }) }, [])[0]).toMatch(/doesn't look like a T3 Code server/);
    // The create body carries the preset, the address (path added) and a typed name.
    expect(createInput(ready)).toEqual({ preset: "t3code", url: "http://100.104.249.49:3773/mcp", slug: "t3-100-104-249-49", levelDefault: "ask" });
    expect(createInput({ ...ready, name: "forge" }).name).toBe("forge");
  });

  it("a second T3 server on the same IP (another port) or first DNS label: its own slug, no false 'you already have'", () => {
    const first = conn({ id: "con_a", preset: "t3code", slug: "t3-127-0-0-1", name: "127.0.0.1:41063", url: "http://127.0.0.1:41063/mcp" });
    const list = [first, conn({ id: "con_n", preset: "notion", slug: "notion" })];
    const taken = list.map((c) => c.slug);
    const second = { ...emptyDraft(t3), url: "http://127.0.0.1:41987" };
    // Not a duplicate: another port is another server, so no "Reconnect 127.0.0.1:41063" offer.
    expect(duplicateOf(second, list)).toBeNull();
    // The suggested slug skips the taken one, like the server's freeSlug; a third gets -3.
    const slug = suggestDraftSlug(second, taken);
    expect(slug).toBe("t3-127-0-0-1-2");
    expect(suggestDraftSlug(second, [...taken, slug])).toBe("t3-127-0-0-1-3");
    expect(suggestDraftSlug({ ...emptyDraft(t3), url: "http://forge.local:3773" }, ["t3-forge"])).toBe("t3-forge-2");
    // With it, the create body (the early create for the allow) doesn't collide, and nothing blocks Connect.
    const ready = { ...second, slug, probe: probe({ auth: "oauth", issuer: "http://127.0.0.1:41987", registration: "dcr", refresh: false }) };
    expect(createInput(ready)).toMatchObject({ preset: "t3code", url: "http://127.0.0.1:41987/mcp", slug: "t3-127-0-0-1-2" });
    expect(draftProblems(ready, taken)).toEqual([]);
    expect(defaultName(ready)).toBe("127.0.0.1:41987");
    // The same server again (same origin, with or without /mcp) is a duplicate, and offers that one.
    expect(duplicateOf({ ...emptyDraft(t3), url: "http://127.0.0.1:41063/" }, list)?.id).toBe("con_a");
    // …but never the connection this dialog created itself for the allow.
    expect(duplicateOf({ ...emptyDraft(t3), url: "http://127.0.0.1:41063", createdId: "con_a" }, list)).toBeNull();
    // Other presets still match on preset and slug.
    expect(duplicateOf({ ...emptyDraft(notion), slug: "notion" }, list)?.id).toBe("con_n");
  });

  it("an expired connection says so and offers Reconnect", () => {
    const expired = connectionStatusView(conn({ preset: "t3code", status: "needs_reauth", statusReason: "forge's sign-in expired on 2026-10-15. Reconnect it.", expiresAt: inDays(-1), expired: true }), NOW);
    expect(expired).toMatchObject({ label: "Expired", tone: "bad", action: "reconnect" });
    expect(expired.description).toMatch(/expired on 2026-10-15.*Reconnect keeps its name, agents and access/);
    expect(connectionStatusView(conn({ expiresAt: inDays(6.5) }), NOW)).toMatchObject({ label: "Expires in 7 days", action: "reconnect" });
    expect(connectionStatusView(conn({ expiresAt: inDays(0.5) }), NOW)).toMatchObject({ label: "Expires in 1 day", tone: "bad" });
  });

  it("shows the granted scopes, with the extension's own note for them, or a generic broad-access warning", () => {
    expect(grantedScopesView(conn({ grantedScopes: null }))).toBeNull();
    expect(grantedScopesView(conn({ preset: "notion", grantedScopes: ["read"] }))).toEqual({ scopes: ["read"], note: null });
    // T3 Code's manifest: Full access scopes are broad, and every level has its note (remote.auth.scopeNotes).
    const auth = fixtureManifest("t3code").remote!.auth as { broadScopes: string[]; scopeNotes: { scope: string; note: string }[] };
    const t3 = { preset: "t3code", name: "forge", broadScopes: auth.broadScopes, scopeNotes: auth.scopeNotes };
    const full = grantedScopesView(conn({ ...t3, grantedScopes: ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write"] }));
    expect(full?.scopes).toHaveLength(4);
    expect(full?.note).toMatch(/^Full access in T3: .*reconnect and pick a lower level\.$/);
    expect(grantedScopesView(conn({ ...t3, grantedScopes: ["orchestration:read", "orchestration:operate"] }))?.note).toMatch(/start, message and stop/);
    expect(grantedScopesView(conn({ ...t3, grantedScopes: ["orchestration:read"] }))?.note).toMatch(/^Read only in T3/);
    // Broad scopes without a note of their own: the generic warning.
    const bare = { ...t3, scopeNotes: null };
    expect(grantedScopesView(conn({ ...bare, grantedScopes: ["orchestration:read", "settings:write"] }))?.note).toBe(
      "Broad access: this sign-in granted settings:write on forge. If agents don't need that, reconnect and pick a lower level.",
    );
    expect(grantedScopesView(conn({ ...bare, grantedScopes: ["orchestration:read"] }))?.note).toBeNull();
    // Without broad scopes or notes named, nothing is said, whatever the preset.
    expect(grantedScopesView(conn({ preset: "t3code", grantedScopes: ["settings:write"] }))?.note).toBeNull();
  });
});

describe("Agent access over per-connection grants", () => {
  const list = [conn(), conn({ id: "con_2", slug: "t3", name: "T3 forge" })];
  const grants = { con_1: [grant("agt_1", "con_1", "ask"), grant("agt_2", "con_1", "full")], con_2: [grant("agt_2", "con_2", "read")] };

  it("shows one agent's level on every connection, 'none' without a grant", () => {
    expect(agentConnections("agt_1", list, grants).map((r) => [r.name, r.level])).toEqual([
      ["Notion", "ask"],
      ["T3 forge", "none"],
    ]);
  });

  it("changes one agent's level and keeps everyone else's; 'none' drops the grant", () => {
    expect(grantsWith(grants.con_1, "agt_1", "read")).toEqual({ grants: [{ agentId: "agt_2", level: "full" }, { agentId: "agt_1", level: "read" }] });
    expect(grantsWith(grants.con_1, "agt_1", "none")).toEqual({ grants: [{ agentId: "agt_2", level: "full" }] });
    expect(grantsWith([], "agt_3", "ask")).toEqual({ grants: [{ agentId: "agt_3", level: "ask" }] });
  });
});

describe("Add connection", () => {
  it("suggests a slug from the address and checks it", () => {
    expect(suggestSlug("https://mcp.notion.com/mcp")).toBe("notion");
    expect(suggestSlug("https://whoop.weish.me/api/mcp")).toBe("whoop");
    expect(suggestSlug("https://api.linear.app/mcp")).toBe("linear");
    expect(suggestSlug("http://127.0.0.1:3773")).toBe("local-3773");
    expect(suggestSlug("not a url")).toBe("");
    expect(slugProblem("", [])).toMatch(/name/);
    expect(slugProblem("t3_forge", [])).toMatch(/lowercase/);
    expect(slugProblem("notion", ["notion"])).toMatch(/already/);
    expect(slugProblem("t3-forge", ["notion"])).toBeNull();
  });

  it("picks the control from the preset or what the probe found", () => {
    expect(authControl({ preset: notion })).toEqual({ kind: "oauth", issuer: null, manual: false });
    expect(authControl({ preset: { ...notion, authType: "header" } })).toEqual({ kind: "header" });
    expect(authControl({ probe: probe({ auth: "oauth", issuer: "https://auth.example.com", registration: "dcr" }) })).toEqual({
      kind: "oauth",
      issuer: "https://auth.example.com",
      manual: false,
    });
    expect(authControl({ probe: probe({ auth: "header" }) })).toEqual({ kind: "header" });
    expect(authControl({ probe: probe({ auth: "unknown", blocked: "private_target" }) })).toEqual({ kind: "private" });
    expect(authControl({ probe: probe({ auth: "unknown" }) })).toEqual({ kind: "unknown" });
  });

  it("explains what was found in plain words, including the private-network block", () => {
    expect(probeSummary(probe({ auth: "oauth", issuer: "https://auth.example.com", registration: "dcr" }))).toBe(
      "Signs in with auth.example.com. xaq registers itself automatically, so there's nothing to set up there.",
    );
    expect(probeSummary(probe({ auth: "header" }))).toMatch(/^Needs an API key or token/);
    expect(probeSummary(probe({ reachable: false, auth: "unknown", message: "Connection refused." }))).toBe("Connection refused.");
    expect(probeSummary(probe({ blocked: "private_target", auth: "unknown" }))).toMatch(/private network/);
    expect(hostPort("http://127.0.0.1:3773/mcp")).toBe("127.0.0.1:3773");
    expect(exactOrigin("https://100.104.249.49/mcp")).toBe("https://100.104.249.49:443");
    const why = privateExplanation("http://100.104.249.49:3773/mcp");
    expect(why).toContain("Allowing 100.104.249.49:3773");
    expect(why).toContain("only at this exact address");
  });

  it("defaults to 'Ask before risky actions' and all agents (agentIds omitted), with no tool review", () => {
    const d = emptyDraft(notion);
    expect(d.level).toBe("ask");
    expect(d.agents).toBe("all");
    expect(LEVEL_INFO.ask.label).toBe("Ask before risky actions");
    expect(createInput(d)).toEqual({ preset: "notion", slug: "notion", levelDefault: "ask" });
    expect(connectInput(d)).toEqual({});
  });

  it("blocks Connect until the address is checked, a private target is allowed, and the key is pasted", () => {
    const d = { ...emptyDraft(), url: "http://127.0.0.1:8787/mcp", slug: "local-8787" };
    expect(draftProblems(d, [])).toContain("Check the address first.");
    const blocked = { ...d, probe: probe({ auth: "unknown", blocked: "private_target" }) };
    expect(draftProblems(blocked, [])[0]).toMatch(/Allow the private-network address/);
    // After the allow, the connection exists already: its own slug isn't a clash.
    const allowed = { ...blocked, createdId: "con_9", privateAllowed: true, probe: probe({ auth: "header" }) };
    expect(draftProblems(allowed, ["local-8787"])).toEqual(["Paste the API key or token."]);
    const ready = { ...allowed, headerValue: " sk-123 ", agents: ["agt_1"] };
    expect(draftProblems(ready, ["local-8787"])).toEqual([]);
    expect(createInput(ready)).toEqual({ url: d.url, slug: "local-8787", levelDefault: "ask", agentIds: ["agt_1"] });
    expect(connectInput(ready)).toEqual({ header: { name: "Authorization", value: "Bearer sk-123" } });
    expect(connectInput({ ...ready, headerValue: "Bearer sk-123" }).header?.value).toBe("Bearer sk-123");
    expect(connectInput({ ...ready, headerName: "X-API-Key" }).header).toEqual({ name: "X-API-Key", value: "sk-123" });
    expect(draftProblems({ ...ready, agents: [] }, [])).toEqual(["Pick at least one agent, or all of them."]);
    expect(draftProblems({ ...d, probe: probe({ reachable: false, auth: "unknown" }) }, [])).toContain("xaq couldn't reach this server.");
  });

  it("gives a connection created early for the allow the rest of the draft before connecting", () => {
    const created = conn({ name: "127.0.0.1", slug: "local-8787", levelDefault: "ask" });
    const d = { ...emptyDraft(), name: "Brightspace", slug: "brightspace", level: "full" as const, agents: "all" as const };
    expect(finishEarlyCreate(d, created, ["agt_1", "agt_2"])).toEqual({
      patch: { name: "Brightspace", slug: "brightspace", levelDefault: "full", allAgents: true },
      grants: { grants: [{ agentId: "agt_1", level: "full" }, { agentId: "agt_2", level: "full" }] },
    });
    const same = { ...emptyDraft(), name: "127.0.0.1", slug: "local-8787", agents: ["agt_2"] };
    expect(finishEarlyCreate(same, created, ["agt_1", "agt_2"])).toEqual({ patch: null, grants: { grants: [{ agentId: "agt_2", level: "ask" }] } });
  });

  it("checks a preset's setup inputs and sends them trimmed", () => {
    expect(inputProblems(whoop.setupSteps, {})).toEqual({ clientId: "Paste the client id.", clientSecret: "Paste the client secret." });
    expect(inputProblems(whoop.setupSteps, { clientId: "nope", clientSecret: "s" })).toEqual({ clientId: "That doesn't look like a client id." });
    const id = "0f6b2c1e-1234-4abc-9def-0123456789ab";
    expect(inputProblems(whoop.setupSteps, { clientId: id, clientSecret: "s" })).toEqual({});
    expect(connectInput({ ...emptyDraft(whoop), inputs: { clientId: ` ${id}`, clientSecret: "s " } })).toEqual({ inputs: { clientId: id, clientSecret: "s" } });
  });
});

describe("Upstream sign-in", () => {
  it("only takes the callback message of the connection being signed in", () => {
    const msg = { type: "agentinbox:connection-oauth", ok: true, connectionId: "con_1", name: "Notion" };
    expect(oauthMessageFor(msg, "con_1")).toEqual({ ok: true, error: null });
    expect(oauthMessageFor(msg, "con_2")).toBeNull();
    expect(oauthMessageFor({ ...msg, type: "agentinbox:oauth" }, "con_1")).toBeNull();
    expect(oauthMessageFor({ ...msg, ok: false, error: "Cancelled" }, "con_1")).toEqual({ ok: false, error: "Cancelled" });
    // No ok field (just which connection): the connection's status decides, so it counts as finished.
    expect(oauthMessageFor({ type: "agentinbox:connection-oauth", connectionId: "con_1", name: "Notion" }, "con_1")).toEqual({ ok: true, error: null });
  });
});

describe("mcp.call approval card", () => {
  it("shows invisible characters as JSON escapes, and notices escaped ones", () => {
    const raw = JSON.stringify({ title: `Hi${ch(0x200b)}there${ch(0x202e)}`, tag: `x${ch(0xe0041)}` });
    expect(escapeInvisible(raw)).toContain("Hi\\u200Bthere\\u202E");
    expect(escapeInvisible(raw)).toContain("x\\uDB40\\uDC41");
    expect(JSON.parse(escapeInvisible(raw))).toEqual(JSON.parse(raw));
    expect(escapeInvisible("plain é ✓")).toBe("plain é ✓");
    expect(argsHaveInvisible(raw)).toBe(true);
    expect(argsHaveInvisible('{"a":"\\u200b"}')).toBe(true);
    expect(argsHaveInvisible('{"a":"ok"}')).toBe(false);
  });

  it("labels 'only for this target', one rule per item for an array target", () => {
    expect(targetLabel({ path: "/parent/page_id", value: "abc" })).toBe("Only for page_id abc");
    expect(targetLabel({ path: "/to", value: `a${ch(0x200b)}b` })).toBe("Only for to a\\u200Bb");
    expect(targetLabel({ path: "/page_ids", value: ["p1", "p2", "p3"] })).toBe("Only for these 3 items");
    expect(targetLabel({ path: "/page_ids", value: ["p1"] })).toBe("Only for this item (p1)");
    expect(targetName("/a~1b/c~0d")).toBe("c~d");
  });

  it("offers the tool's own target, else any argument the server lists (argumentPaths)", () => {
    const own = targetChoices(view());
    expect(own).toEqual([{ path: "/page_id", label: "Only for page_id abc", own: true }]);
    expect(alwaysAllowFor(own[0]!)).toEqual({ target: true });
    const generic = view({
      target: null,
      argumentPaths: ["/channel", "/thread/id", "/missing"],
      approval: call({}, { args: '{"channel":"#ops","thread":{"id":7},"text":"hi"}' }),
    });
    expect(targetChoices(generic)).toEqual([
      { path: "/channel", label: "Only for channel #ops", own: false },
      { path: "/thread/id", label: "Only for id 7", own: false },
    ]);
    expect(alwaysAllowFor(targetChoices(generic)[1]!)).toEqual({ target: true, targetPath: "/thread/id" });
    expect(alwaysAllowFor(null)).toEqual({ target: false });
    expect(atPointer({ a: [{ b: 1 }] }, "/a/0/b")).toBe(1);
    expect(atPointer({ a: 1 }, "/nope")).toBeUndefined();
  });

  it("warns before deciding when the call can't run as asked", () => {
    expect(cardWarnings(view())).toEqual([]);
    expect(cardWarnings(view({ argsIntact: false }))[0]).toMatch(/fingerprint/);
    expect(cardWarnings(view({ tool: null }))[0]).toMatch(/can't reach this tool/);
    expect(cardWarnings(view({ connection: null }))[0]).toMatch(/connection was removed/);
    expect(cardWarnings(view({ connection: { id: "con_1", slug: "notion", name: "Notion", status: "needs_reauth" } }))[0]).toMatch(/Notion isn't working.*needs reauth/);
  });

  it("says plainly what happened after a decision, including an unknown outcome", () => {
    expect(doneState(call({ status: "sent" }), "always").title).toBe("Approved, and always allowed");
    expect(doneState(call({ status: "sent" }), "approve").description).toMatch(/^The call ran/);
    expect(doneState(call({ status: "rejected" }), "reject").description).toMatch(/Nothing ran/);
    expect(doneState(call({ status: "expired" }), null).title).toBe("This request expired");
    const unknown = doneState(call({ status: "failed", error: "timeout" }, { outcomeUnknown: true }), "approve");
    expect(unknown.title).toBe("Approved: outcome unknown");
    expect(unknown.description).toMatch(/may or may not have run/);
    expect(doneState(call({ status: "failed", error: "Upstream said no." }), "approve").description).toMatch(/^Upstream said no\./);
    expect(doneState(call({ status: "pending", error: "Reconnect Notion. Approve again once that's fixed." }), "approve")).toMatchObject({ title: "Not run yet", tone: "bad" });
  });

  it("tells mcp.call approvals and their card view from mail ones", () => {
    const mail = { ...call(), kind: "send", call: undefined, accountId: "acc_1", accountEmail: "me@example.com", draftId: "d1", connectionId: null } as unknown as Shared.Approval;
    expect(asMcpApproval(mail)).toBeNull();
    const c = call();
    expect(asMcpApproval(c)).toBe(c);
    expect(isCallView(view())).toBe(true);
    expect(isCallView(c)).toBe(false);
  });
});
describe("First run with Google optional", () => {
  const fresh: Pick<SetupState, "googleClientConfigured" | "accountsConnected" | "gcpProjectId"> = { googleClientConfigured: false, accountsConnected: 0, gcpProjectId: null };

  it("asks what to connect on a fresh install, only with the broker on", () => {
    expect(firstRunView(fresh, {})).toBe("choose");
    expect(firstRunView(undefined, {})).toBe("choose");
  });

  it("Gmail & Calendar enters the Google steps; the others take the short path", () => {
    expect(firstRunView(fresh, { firstConnect: "google" })).toBe("google");
    for (const c of ["notion", "custom"] as const) expect(firstRunView(fresh, { firstConnect: c })).toBe("broker");
  });

  it("doesn't ask an install already into the Google steps", () => {
    expect(firstRunView({ ...fresh, googleClientConfigured: true }, {})).toBe("google");
    expect(firstRunView({ ...fresh, accountsConnected: 1 }, {})).toBe("google");
    expect(firstRunView(fresh, { projectConfirmed: true })).toBe("google");
    expect(firstRunView(fresh, { appType: "external" })).toBe("google");
  });

  it("the short path is done with a connection and an agent", () => {
    expect(brokerStatuses(0, 0)).toEqual({ connect: "todo", agent: "todo" });
    expect(brokerStatuses(1, 1)).toEqual({ connect: "done", agent: "done" });
  });

  it("leaves the Google wizard's steps as they were", () => {
    const state = {
      ...fresh,
      claimed: true,
      googleAppType: null,
      agentsCreated: 0,
      verified: false,
      complete: false,
      warnings: [],
    } as unknown as SetupState;
    expect(stepStatuses(state, { firstConnect: "google" })).toEqual(stepStatuses(state, {}));
  });
});

describe("Review fixes (#65)", () => {
  it("checks a pasted landing address for paste mode", () => {
    expect(pastedProblem("nope")).toMatch(/full address/);
    expect(pastedProblem("http://box:8425/oauth/connections/callback?error=access_denied")).toMatch(/cancelled/);
    expect(pastedProblem("http://box:8425/oauth/connections/callback?state=s1")).toMatch(/no authorization code/);
    expect(pastedProblem("http://box:8425/oauth/connections/callback?code=c&state=s1")).toBeNull();
  });

  it("derives a custom connection's slug from its name until the slug is edited", () => {
    expect(slugFromName("Notes server")).toBe("notes-server");
    expect(slugFromName("  Héllo, World!! ")).toBe("hello-world");
    expect(slugFromName("a".repeat(30))).toHaveLength(24);
    const d = { ...emptyDraft(), slug: "local-38399" };
    expect(nameChange(d, "Notes server")).toEqual({ name: "Notes server", slug: "notes-server" });
    expect(nameChange({ ...d, slugEdited: true }, "Notes server")).toEqual({ name: "Notes server" });
    expect(nameChange(emptyDraft(notion), "My Notion")).toEqual({ name: "My Notion" });
    expect(nameChange(d, "!!!")).toEqual({ name: "!!!", slug: "local-38399" });
  });

  it("says 'Not signed in' for an OAuth connection whose sign-in was abandoned", () => {
    const fresh = conn({ tools: { total: 0 }, toolsCachedAt: null });
    expect(connectionStatusView(fresh, NOW)).toMatchObject({ label: "Not signed in", action: "reconnect" });
    expect(connectionStatusView({ ...fresh, status: "needs_reauth", authType: "header" }, NOW).label).toBe("Not signed in");
    expect(connectionStatusView({ ...fresh, authType: "none" }, NOW).label).toBe("Active");
    expect(connectionStatusView(conn({ toolsCachedAt: inDays(-1) }), NOW).label).toBe("Active");
  });

  it("escapes controls in one-line places and in target names; an empty array target offers no 'only for'", () => {
    expect(escapeInvisible("a\nb\tc\u0007")).toBe("a\nb\tc\\u0007");
    expect(escapeInvisible("a\nb\tc", true)).toBe("a\\u000Ab\\u0009c");
    expect(targetName(`/to${ch(0x202e)}x`)).toBe("to\\u202Ex");
    expect(targetLabel({ path: "/to", value: "a@b.c\nBcc: evil@x.y" })).toBe("Only for to a@b.c\\u000ABcc: evil@x.y");
    expect(targetChoices(view({ target: { path: "/page_ids", value: [] } }))).toEqual([]);
  });

  it("a ?step= link always opens the Google wizard, whatever first run chose", () => {
    expect(shownWizard("broker", "client")).toBe("google");
    expect(shownWizard("choose", "accounts")).toBe("google");
    expect(shownWizard("broker", undefined)).toBe("broker");
    expect(shownWizard("google", undefined)).toBe("google");
  });
});
