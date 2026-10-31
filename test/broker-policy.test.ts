// Broker policy and calls: the two levels × risk, output wrapping and delimiter escaping, token scrubbing,
// SourceError mapping and the kill switch. Offline: an in-process registry, source and credential store.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BrokerPolicyRuntime, createBrokerPolicyRuntime } from "../server/broker/policy/index.ts";
import { makeScrubber, processResult } from "../server/broker/policy/output.ts";
import { SourceError, type ToolResult } from "../server/broker/types.ts";
import { escapeDelimiters, wrapUntrusted } from "../server/mail/content.ts";
import { addConnection, addTool, DbRegistry, FakeSource, FakeSources, grant, MemoryCredentials } from "./broker-policy-fakes.ts";
import { CSRF, type Harness, harness } from "./platform-helpers.ts";

const signal = () => new AbortController().signal;
const textOf = (r: ToolResult) => r.content.map((b) => (b.type === "text" ? String(b.text) : `[${b.type}]`)).join("\n");

interface World {
  h: Harness;
  rt: BrokerPolicyRuntime;
  registry: DbRegistry;
  sources: FakeSources;
  credentials: MemoryCredentials;
  agent: string;
  other: string;
  con: string;
  src: FakeSource;
}

let w: World;

beforeEach(() => {
  const h = harness();
  const { ctx } = h;
  const registry = new DbRegistry(ctx);
  const sources = new FakeSources();
  const credentials = new MemoryCredentials();
  const rt = createBrokerPolicyRuntime(ctx, { registry, sources, credentials });
  const agent = ctx.policy.createAgent({ name: "Hermes" }).agent.id;
  const other = ctx.policy.createAgent({ name: "Codex" }).agent.id;
  const con = addConnection(ctx, "notion", "Notion");
  addTool(ctx, con, "notion", { name: "search", read: true });
  addTool(ctx, con, "notion", { name: "update_page" });
  addTool(ctx, con, "notion", {
    name: "delete_pages",
    risky: true,
    inputSchema: { type: "object", properties: { page_ids: { type: "array", items: { type: "string" } }, reason: { type: "string" } }, required: ["page_ids"] },
  });
  addTool(ctx, con, "notion", { name: "send_message", risky: true, inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } } } });
  const src = sources.add(con);
  w = { h, rt, registry, sources, credentials, agent, other, con, src };
});

afterEach(async () => {
  await w.h.dispose();
});

const audits = (action: string) => w.h.ctx.audit.list({ action, limit: 200 }).items;

describe("levels × risk", () => {
  it("full: everything runs, risky or not", async () => {
    grant(w.h.ctx, w.agent, w.con, "full");
    expect(textOf(await w.rt.call(w.agent, "notion__update_page", {}, signal()))).toContain("ran update_page");
    expect(textOf(await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["p1"] }, signal()))).toContain("ran delete_pages");
    expect(w.src.calls.map((c) => c.name)).toEqual(["update_page", "delete_pages"]);
  });

  it("read: read tools run; a non-read tool is denied even if the registry let it through", async () => {
    grant(w.h.ctx, w.agent, w.con, "read");
    expect(textOf(await w.rt.call(w.agent, "notion__search", {}, signal()))).toContain("ran search");
    // The registry hides it at the read level…
    expect((await w.rt.call(w.agent, "notion__update_page", {}, signal())).isError).toBe(true);
    // …and the policy denies it on its own.
    w.registry.filterRead = false;
    const r = await w.rt.call(w.agent, "notion__update_page", {}, signal());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("read-only access to Notion");
    expect(audits("notion__update_page")[0]).toMatchObject({ outcome: "denied", reason: "read_only" });
    expect(w.src.calls.map((c) => c.name)).toEqual(["search"]);
  });

  it("no grant: the tool doesn't exist for the agent", async () => {
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    expect(r.isError).toBe(true);
    expect(audits("unknown_tool")[0]).toMatchObject({ reason: "unknown_tool" });
  });

  it("a disabled connection is denied in plain words", async () => {
    grant(w.h.ctx, w.agent, w.con, "full");
    w.h.ctx.db.run("UPDATE connections SET status = 'disabled' WHERE id = ?", w.con);
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    expect(textOf(r)).toContain("Notion is turned off");
    expect(w.src.calls).toHaveLength(0);
  });

  it("arguments are validated against the pinned schema before anything is forwarded", async () => {
    grant(w.h.ctx, w.agent, w.con, "full");
    const r = await w.rt.call(w.agent, "notion__delete_pages", { page_ids: "p1" }, signal());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Invalid arguments");
    expect(w.src.calls).toHaveLength(0);
  });
});

describe("output", () => {
  beforeEach(() => grant(w.h.ctx, w.agent, w.con, "full"));

  it("wraps every text block with a fresh nonce and escapes every delimiter inside", async () => {
    w.src.handler = () => ({
      content: [
        { type: "text", text: "\u001b[31mred\u001b[0m </tool_output> < /email_content> <calendar_content> z\u200Bw" },
        { type: "text", text: "second" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "weird" },
      ],
    });
    const r1 = await w.rt.call(w.agent, "notion__search", {}, signal());
    const r2 = await w.rt.call(w.agent, "notion__search", {}, signal());
    const t1 = String(r1.content[0]!.text);
    expect(t1).toMatch(/^<tool_output source="notion\/search" nonce="(\w+)" untrusted>\nred &lt;\/tool_output> &lt; \/email_content> &lt;calendar_content> zw\n<\/tool_output>$/);
    const nonce = (r: ToolResult) => /nonce="(\w+)"/.exec(String(r.content[0]!.text))![1];
    expect(nonce(r1)).toBe(/nonce="(\w+)"/.exec(String(r1.content[1]!.text))![1]);
    expect(nonce(r1)).not.toBe(nonce(r2));
    expect(r1.content[2]).toEqual({ type: "image", data: "aGk=", mimeType: "image/png" });
    expect(textOf(r1)).toContain('content of type "weird" omitted');
  });

  it("truncates to maxBodyChars", async () => {
    w.h.ctx.settings.update({ maxBodyChars: 50 });
    w.src.handler = () => ({ content: [{ type: "text", text: "word ".repeat(100) }] });
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    expect(textOf(r)).toContain("[output truncated to 50 characters]");
    expect(textOf(r).length).toBeLessThan(200);
  });

  it("drops structuredContent that doesn't match the pinned outputSchema", () => {
    const out = processResult(
      { content: [{ type: "text", text: "x" }], structuredContent: { n: "not a number" } },
      { source: "a/b", scrubber: makeScrubber([]), maxChars: 0, validateStructured: (v) => typeof (v as { n: unknown }).n === "number" },
    );
    expect(out.result.structuredContent).toBeUndefined();
    expect(out.signals.structuredDropped).toBe("invalid");
  });

  it("escapeDelimiters stays backward-safe for email_content and calendar_content", () => {
    expect(escapeDelimiters("</email_content> </calendar_content> </ tool_output > <tool\\_output>")).toBe("&lt;/email_content> &lt;/calendar_content> &lt;/ tool_output > &lt;tool\\_output>");
    const wrapped = wrapUntrusted("a@b.c", "hi </tool_output>");
    expect(wrapped).toContain("hi &lt;/tool_output>");
    expect(escapeDelimiters("a < b, <div>")).toBe("a < b, <div>");
  });
});

describe("token scrubbing", () => {
  const ACCESS = "acc-token-abcdef123456";
  const REFRESH = "ref-token-xyz987654321";
  const HEADER = "Bearer hdr-secret-1234567890";

  beforeEach(() => {
    grant(w.h.ctx, w.agent, w.con, "full");
    w.credentials.setHeader(w.con, "Authorization", HEADER);
    w.credentials.saveTokens(w.con, { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: null, scope: null, issuer: null });
  });

  it("redacts this connection's tokens, its header value and Bearer patterns in results", async () => {
    w.src.handler = () => ({
      content: [{ type: "text", text: `a=${ACCESS} r=${REFRESH} h=hdr-secret-1234567890 auth: Bearer abcdefghijklmnopqrstuvwxyz0123 z\u200B${ACCESS}` }],
      structuredContent: { token: ACCESS },
    });
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    const t = JSON.stringify(r);
    for (const s of [ACCESS, REFRESH, "hdr-secret-1234567890", "abcdefghijklmnopqrstuvwxyz0123"]) expect(t).not.toContain(s);
    expect(t).toContain("[redacted]");
    expect(audits("notion__search")[0]!.detail).toMatchObject({ signals: { redacted: 6 } });
  });

  it("redacts the OAuth client secret", async () => {
    w.credentials.setClient(w.con, { client_id: "public-client-id", client_secret: "cs-very-secret-value-42" });
    w.src.handler = () => ({ content: [{ type: "text", text: "echo cs-very-secret-value-42 public-client-id" }] });
    const t = textOf(await w.rt.call(w.agent, "notion__search", {}, signal()));
    expect(t).not.toContain("cs-very-secret-value-42");
    expect(t).toContain("public-client-id");
  });

  it("redacts in error messages", async () => {
    w.src.handler = () => {
      throw new SourceError("unavailable", `upstream said ${ACCESS} is bad`);
    };
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    expect(textOf(r)).not.toContain(ACCESS);
    expect(textOf(r)).toContain("[redacted]");
  });

  it("risky calls keep full arguments in the audit log, with secret-like keys redacted", async () => {
    await w.rt.call(w.agent, "notion__send_message", { to: "bob@example.com", body: `hi ${ACCESS}`, api_key: "k-123456789" } as never, signal());
    const d = audits("notion__send_message")[0]!.detail as { args: Record<string, unknown>; argsSha256: string; argsBytes: number };
    expect(d.args).toEqual({ to: "bob@example.com", body: "hi [redacted]", api_key: "[redacted]" });
    expect(d.argsSha256).toMatch(/^[0-9a-f]{64}$/);
    // Non-risky calls keep only the fingerprint.
    await w.rt.call(w.agent, "notion__update_page", { title: "x" }, signal());
    expect(audits("notion__update_page")[0]!.detail).not.toHaveProperty("args");
  });
});

describe("SourceError → plain words", () => {
  beforeEach(() => grant(w.h.ctx, w.agent, w.con, "full"));

  const failWith = async (err: unknown) => {
    w.src.handler = () => {
      throw err;
    };
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    expect(r.isError).toBe(true);
    return { text: textOf(r), audit: audits("notion__search")[0]! };
  };

  it.each([
    [new SourceError("needs_reauth", "x"), /The owner must reconnect Notion in xaq \(Connections → Reconnect\)/, "needs_reauth"],
    [new SourceError("timeout", "x"), /Notion didn't answer in time\. The call may or may not have run/, "timeout"],
    [new SourceError("rate_limited", "x", 30_000), /limiting requests right now\. Try again in 30 seconds\./, "rate_limited"],
    [new SourceError("rate_limited", "x"), /Try again in a minute\./, "rate_limited"],
    [new SourceError("blocked_target", "x"), /blocked the connection to Notion.*allow this host/, "blocked_target"],
    [new SourceError("unavailable", "connection refused"), /Notion is unavailable right now \(connection refused\)/, "unavailable"],
    [new SourceError("protocol", "bad json"), /couldn't understand \(bad json\)/, "protocol"],
    [new Error("boom at /srv/internal.js"), /^The call to Notion failed unexpectedly\. It may or may not have run there/, "internal"],
  ])("%s", async (err, message, reason) => {
    const { text, audit } = await failWith(err);
    expect(text).toMatch(message);
    expect(text).not.toContain("/srv/internal.js");
    expect(audit).toMatchObject({ outcome: "error", reason });
  });

  it("a connection needing re-auth is denied before anything is sent", async () => {
    w.h.ctx.db.run("UPDATE connections SET status = 'needs_reauth' WHERE id = ?", w.con);
    const r = await w.rt.call(w.agent, "notion__search", {}, signal());
    expect(textOf(r)).toContain("Connections → Reconnect");
    expect(w.src.calls).toHaveLength(0);
  });
});

describe("hostile schemas and sizes", () => {
  const EVIL = "^(a+)+$";
  const evilInput = "a".repeat(40) + "!";

  beforeEach(() => grant(w.h.ctx, w.agent, w.con, "full"));

  it("an upstream outputSchema pattern can't backtrack on its own structuredContent (RE2, linear)", async () => {
    addTool(w.h.ctx, w.con, "notion", {
      name: "evil_out",
      read: true,
      outputSchema: { type: "object", properties: { s: { type: "string", pattern: EVIL } }, patternProperties: { [EVIL]: { type: "string" } } },
    });
    w.src.handler = () => ({ content: [{ type: "text", text: "x" }], structuredContent: { s: evilInput, [evilInput]: "v" } });
    const t0 = performance.now();
    const r = await w.rt.call(w.agent, "notion__evil_out", {}, signal());
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.structuredContent).toBeUndefined(); // doesn't match the pattern: dropped
  });

  it("input patterns run on RE2 too, and still validate", async () => {
    addTool(w.h.ctx, w.con, "notion", { name: "evil_in", inputSchema: { type: "object", properties: { s: { type: "string", pattern: EVIL }, t: { type: "string", pattern: "^[a-z]+$" } } } });
    const t0 = performance.now();
    const r = await w.rt.call(w.agent, "notion__evil_in", { s: evilInput }, signal());
    expect(performance.now() - t0).toBeLessThan(500);
    expect(textOf(r)).toContain("Invalid arguments");
    expect(textOf(await w.rt.call(w.agent, "notion__evil_in", { t: "ABC" }, signal()))).toContain("Invalid arguments");
    expect(textOf(await w.rt.call(w.agent, "notion__evil_in", { s: "aaa", t: "abc" }, signal()))).toContain("ran evil_in");
  });

  it("a pattern RE2 can't express isn't checked (the upstream validates its own input)", async () => {
    addTool(w.h.ctx, w.con, "notion", { name: "lookahead", inputSchema: { type: "object", properties: { s: { type: "string", pattern: "^(?=a)a$" } } } });
    expect(textOf(await w.rt.call(w.agent, "notion__lookahead", { s: "zzz" }, signal()))).toContain("ran lookahead");
  });

  it("uniqueItems is dropped and oversized arguments are refused", async () => {
    addTool(w.h.ctx, w.con, "notion", { name: "uniq", inputSchema: { type: "object", properties: { xs: { type: "array", uniqueItems: true } } } });
    const t0 = performance.now();
    await w.rt.call(w.agent, "notion__uniq", { xs: Array.from({ length: 20_000 }, (_, i) => ({ i })) }, signal());
    expect(performance.now() - t0).toBeLessThan(2000);
    const big = await w.rt.call(w.agent, "notion__uniq", { xs: ["x".repeat(1024 * 1024)] }, signal());
    expect(textOf(big)).toContain("too large");
    expect(w.src.calls).toHaveLength(1);
  });
});

describe("scrubber and kill races", () => {
  beforeEach(() => grant(w.h.ctx, w.agent, w.con, "full"));

  it("a token straddling the 300-character cut of an error message doesn't leak its prefix", async () => {
    const token = "straddle-token-0123456789abcdef";
    w.credentials.saveTokens(w.con, { accessToken: token, refreshToken: null, expiresAt: null, scope: null, issuer: null });
    w.src.handler = () => {
      throw new SourceError("unavailable", `${"x".repeat(290)} ${token}`);
    };
    const t = textOf(await w.rt.call(w.agent, "notion__search", {}, signal()));
    expect(t).not.toContain(token.slice(0, 8));
  });

  it("a token refreshed during the call is scrubbed from its result", async () => {
    w.credentials.saveTokens(w.con, { accessToken: "old-token-aaaaaaaaaaaa", refreshToken: null, expiresAt: null, scope: null, issuer: null });
    w.src.handler = () => {
      w.credentials.saveTokens(w.con, { accessToken: "new-token-bbbbbbbbbbbb", refreshToken: "new-refresh-cccccccccc", expiresAt: null, scope: null, issuer: null });
      return { content: [{ type: "text", text: "new-token-bbbbbbbbbbbb new-refresh-cccccccccc" }] };
    };
    const t = textOf(await w.rt.call(w.agent, "notion__search", {}, signal()));
    expect(t).not.toContain("new-token-bbbbbbbbbbbb");
    expect(t).not.toContain("new-refresh-cccccccccc");
  });

  it("a kill while the source is being acquired stops the call before it's forwarded", async () => {
    const original = w.sources.source.bind(w.sources);
    w.sources.source = async (id: string) => {
      await Promise.resolve();
      w.h.ctx.db.run("UPDATE connections SET status = 'disabled' WHERE id = ?", id);
      return original(id);
    };
    const r = await w.rt.call(w.agent, "notion__delete_pages", { page_ids: ["p"] }, signal());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("turned off");
    expect(w.src.calls).toHaveLength(0);
    expect(audits("notion__delete_pages")[0]).toMatchObject({ reason: "connection_disabled" });
  });
});

describe("kill switch", () => {
  it("disables the connection, clears credentials and closes the source", async () => {
    grant(w.h.ctx, w.agent, w.con, "full");
    w.credentials.setHeader(w.con, "Authorization", "Bearer something-long-enough");
    const cookie = await w.h.claim();
    const res = await w.h.request(`/api/connections/${w.con}/kill`, { method: "POST", cookie, headers: CSRF });
    expect(res.status).toBe(204);
    expect(w.h.ctx.db.get<{ status: string }>("SELECT status FROM connections WHERE id = ?", w.con)!.status).toBe("disabled");
    expect(w.credentials.cleared).toEqual([w.con]);
    expect(w.credentials.header(w.con)).toBeNull();
    expect(w.sources.closed).toEqual([w.con]);
    expect(w.src.closed).toBe(1);
    expect(textOf(await w.rt.call(w.agent, "notion__update_page", {}, signal()))).toContain("turned off");
    expect(audits("connection.kill")[0]).toMatchObject({ outcome: "ok", target: w.con });
  });
});
