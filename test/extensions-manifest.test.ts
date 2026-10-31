// The extension manifest (server/extensions/manifest.ts): the strict validator, the JSON Schema the xaq-extensions
// repo validates with (they must agree), template substitution, the risk map, presetFromManifest for both kinds,
// the presets() registry over the extension store and usedBy.

import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTool } from "../server/broker/catalog/classify.ts";
import type { SetupContext, ToolDef } from "../server/broker/types.ts";
import { usedBy } from "../server/broker/service.ts";
import { MANIFEST_JSON_SCHEMA, ManifestError, presetFromManifest, renderSetup, validateManifest } from "../server/extensions/manifest.ts";
import { brokenExtensions, presetById, presets, reloadPresets, useExtensionStore } from "../server/integrations/index.ts";
import { FIXTURE_EXTENSIONS, fixtureExtension, fixtureManifest } from "./extension-fixtures.ts";
import { testContext } from "./helpers.ts";

afterEach(() => useExtensionStore(null));

const ajv = new Ajv2020({ allErrors: true });
const schemaValid = ajv.compile(MANIFEST_JSON_SCHEMA);

const CTX: SetupContext = { publicUrl: "https://xaq.example", redirectUri: "https://xaq.example/oauth/connections/callback" };
const tool = (name: string, properties: Record<string, unknown> = {}, annotations?: ToolDef["annotations"]): ToolDef => ({
  name,
  description: "",
  inputSchema: { type: "object", properties },
  ...(annotations ? { annotations } : {}),
});

/** A small valid remote manifest to mutate. */
const remote = (): Record<string, unknown> => ({
  schema: 1,
  name: "demo",
  displayName: "Demo",
  version: "1.2.3",
  description: "A demo server.",
  kind: "remote",
  slug: "demo",
  remote: { url: "https://mcp.demo.example/mcp", auth: { type: "mcp_oauth" } },
  setup: [{ id: "connect", title: "Connect", body: "Press Connect." }],
  risk: { tools: { list_things: { class: "read" }, drop_thing: { class: "risky", target: "/id" } } },
});

const code = (): Record<string, unknown> => ({
  schema: 1,
  name: "whoopish",
  displayName: "Whoopish",
  version: "1.0.0",
  description: "A code extension.",
  kind: "code",
  slug: "whoopish",
  code: {
    entry: "dist/server.mjs",
    node: ">=22.13",
    auth: { type: "user_app", authorizeUrl: "https://api.example/oauth/auth", tokenUrl: "https://api.example/oauth/token", scopes: ["read:all", "offline"], clientIdInput: "client_id", clientSecretInput: "client_secret" },
    network: ["api.example"],
    events: ["whoopish.recovery_updated"],
  },
  setup: [
    { id: "app", title: "Create an app", body: "Use this redirect.", copy: { label: "Redirect URI", value: "{{redirectUri}}" } },
    { id: "id", title: "Client ID", body: "Paste it.", input: { key: "client_id", label: "Client ID", pattern: "^\\S{8,200}$" } },
    { id: "secret", title: "Client secret", body: "Paste it.", input: { key: "client_secret", label: "Client secret", secret: true } },
  ],
  risk: { tools: { get_recovery: { class: "read" } } },
});

/** Sets `value` at a dotted path in a copy of the manifest (numbers index arrays). */
function patch(m: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const copy = structuredClone(m);
  const keys = path.split(".");
  let cur = copy as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  if (value === undefined) delete cur[keys.at(-1)!];
  else cur[keys.at(-1)!] = value;
  return copy;
}

describe("validateManifest and the JSON Schema", () => {
  it.each(FIXTURE_EXTENSIONS)("the repo's %s manifest is valid, by both", (name) => {
    const m = fixtureManifest(name);
    expect(() => validateManifest(m)).not.toThrow();
    expect(schemaValid(m), JSON.stringify(schemaValid.errors)).toBe(true);
  });

  it("valid samples pass both, and validation returns a copy", () => {
    for (const m of [remote(), code()]) {
      expect(validateManifest(m)).toEqual(m);
      expect(validateManifest(m)).not.toBe(m);
      expect(schemaValid(m), JSON.stringify(schemaValid.errors)).toBe(true);
    }
    const user = patch(patch(remote(), "remote.url", undefined), "remote.userServer", { defaultPath: "/mcp", sameOriginIssuer: true });
    expect(() => validateManifest(user)).not.toThrow();
    expect(schemaValid(user)).toBe(true);
    // reconnectPolicy, setup and risk are optional, and so is every reconnectPolicy field.
    const bare = patch(patch(remote(), "setup", undefined), "risk", undefined);
    expect(() => validateManifest(bare)).not.toThrow();
    expect(schemaValid(bare)).toBe(true);
    for (const policy of [{}, { idleDays: 30 }, { maxLifetimeDays: 180, idleDays: 30, tokenLifetimeCapDays: 30 }]) {
      const m = patch(remote(), "reconnectPolicy", policy);
      expect(() => validateManifest(m)).not.toThrow();
      expect(schemaValid(m)).toBe(true);
    }
  });

  // Each: refused by validateManifest with a message matching `why`, and by the schema too.
  it.each([
    ["an unknown top-level key", "homepage", "https://x", /unknown key "homepage"/],
    ["an unknown remote key", "remote.headers", {}, /remote has an unknown key "headers"/],
    ["an unknown auth key", "remote.auth.scope", "x", /remote.auth has an unknown key "scope"/],
    ["a key another auth type takes", "remote.auth.headerName", "X-Key", /doesn't take/],
    ["an unknown step key", "setup.0.icon", "x", /setup\[0\] has an unknown key "icon"/],
    ["an unknown risk entry key", "risk.tools.list_things.why", "x", /unknown key "why"/],
    ["an unknown reconnectPolicy key", "reconnectPolicy", { days: 3 }, /unknown key "days"/],
    ["schema 2", "schema", 2, /schema must be 1/],
    ["an uppercase name", "name", "Demo", /name must be/],
    ["a reserved name", "name", "connection", /xaq uses it/],
    ["a long slug", "slug", "a".repeat(25), /slug must be at most 24/],
    ["a non-semver version", "version", "v1", /semantic version/],
    ["an unknown kind", "kind", "stdio", /kind must be/],
    ["http for a fixed url", "remote.url", "http://mcp.demo.example/mcp", /https/],
    ["both url and userServer", "remote.userServer", { defaultPath: "/mcp" }, /exactly one/],
    ["an unknown auth type", "remote.auth", { type: "basic" }, /remote.auth.type must be/],
    ["a bad header name", "remote.auth", { type: "header", headerName: "X Key" }, /HTTP header name/],
    ["a zero-day policy", "reconnectPolicy", { maxLifetimeDays: 0 }, /whole number of days/],
    ["a fractional policy", "reconnectPolicy", { tokenLifetimeCapDays: 1.5 }, /whole number of days/],
    ["an unknown risk class", "risk.tools.list_things", { class: "safe" }, /must be "read", "write" or "risky"/],
    ["a target that isn't a pointer", "risk.tools.drop_thing.target", "id", /JSON Pointer/],
    ["an empty target list", "risk.tools.drop_thing.target", [], /must not be empty/],
    ["a step without a body", "setup.0.body", undefined, /missing "body"/],
    ["a step with when", "setup.0.when", "webhookUrl", /when/],
    ["a non-https link", "setup.0.link", { label: "Open", url: "http://example.com" }, /https/],
    ["a secret that isn't a boolean", "setup.0.input", { key: "k", label: "K", secret: "yes" }, /true or false/],
  ])("refuses %s", (_what, path, value, why) => {
    const m = patch(remote(), path, value);
    expect(() => validateManifest(m)).toThrow(why);
    expect(() => validateManifest(m)).toThrow(ManifestError);
    expect(schemaValid(m)).toBe(false);
  });

  // Rules only the validator checks (the schema can't express them).
  it.each([
    ["an unknown template variable", "setup.0.body", "Open {{consoleUrl}}.", /only \{\{publicUrl\}\} and \{\{redirectUri\}\}/],
    ["a stray brace", "setup.0.body", "Open {{publicUrl}.", /unbalanced/],
    ["an exempt name the table doesn't list", "risk.nameCheckExempt", ["send_it"], /doesn't list/],
    ["an exempt name that's already risky", "risk.nameCheckExempt", ["drop_thing"], /already risky/],
    ["a bad input pattern", "setup.0.input", { key: "k", label: "K", pattern: "(" }, /regular expression/],
    ["duplicate step ids", "setup.1", { id: "connect", title: "Again", body: "x" }, /same id/],
    ["a bidi control character", "displayName", "Demo\u202e", /control characters/],
  ])("refuses %s", (_what, path, value, why) => {
    expect(() => validateManifest(patch(remote(), path, value))).toThrow(why);
  });

  it("code manifests: entry inside the extension, events under its name, user_app inputs asked for", () => {
    for (const [path, value, why] of [
      ["code.entry", "../evil.mjs", /relative path/],
      ["code.entry", "/abs/server.mjs", /relative path/],
      ["code.entry", "dist/server.ts", /relative path/],
      ["code.events", ["other.recovery_updated"], /must be "whoopish.<event>"/],
      ["code.network", ["API.example"], /host name/],
      ["code.auth.clientSecretInput", "client_id", /different inputs/],
      ["code.auth.clientIdInput", "app_id", /no setup step asks for/],
      ["code.auth.authorizeUrl", "http://api.example/oauth/auth", /https/],
      ["remote", { url: "https://x.example/mcp", auth: { type: "none" } }, /only for "kind": "remote"/],
    ] as const) {
      expect(() => validateManifest(patch(code(), path, value)), path).toThrow(why);
    }
    expect(() => validateManifest(patch(code(), "code", undefined))).toThrow(/required for "kind": "code"/);
  });

  it("the schema's top-level keys are exactly the validator's", () => {
    const keys = Object.keys(MANIFEST_JSON_SCHEMA.properties).sort();
    expect(keys).toEqual(["code", "description", "displayName", "kind", "name", "reconnectPolicy", "remote", "risk", "schema", "setup", "slug", "version"]);
    for (const k of keys) {
      // A key the validator didn't know would be refused as unknown.
      const m = remote();
      if (!(k in m)) continue;
      expect(() => validateManifest(m)).not.toThrow();
    }
  });
});

describe("setup copy", () => {
  it("fills {{publicUrl}} and {{redirectUri}}", () => {
    const m = validateManifest(code());
    const steps = renderSetup(m.setup!, CTX);
    expect(steps.map((s) => s.id)).toEqual(["app", "id", "secret"]);
    expect(steps[0]!.copy).toEqual({ label: "Redirect URI", value: CTX.redirectUri });
    expect(steps[2]!.input).toEqual({ key: "client_secret", label: "Client secret", secret: true });
    const link = validateManifest(patch(remote(), "setup.0.link", { label: "Open {{publicUrl}}", url: "{{publicUrl}}/settings" }));
    expect(renderSetup(link.setup!, CTX)[0]!.link).toEqual({ label: "Open https://xaq.example", url: "https://xaq.example/settings" });
  });
});

describe("presetFromManifest", () => {
  it("remote: url, auth, reconnectPolicy, classify and nameCheckExempt", () => {
    const m = patch(patch(remote(), "reconnectPolicy", { maxLifetimeDays: 180, tokenLifetimeCapDays: 30 }), "risk.nameCheckExempt", ["list_things"]);
    const p = presetFromManifest({ ...fixtureExtension("notion"), name: "demo", manifest: m });
    expect(p).toMatchObject({ id: "demo", displayName: "Demo", slug: "demo", kind: "remote_http", url: "https://mcp.demo.example/mcp", auth: { type: "mcp_oauth" } });
    expect(p.reconnectPolicy).toEqual({ maxLifetimeDays: 180, tokenLifetimeCapDays: 30 });
    expect(p.nameCheckExempt).toEqual(["list_things"]);
    expect(p.userServer).toBeUndefined();
    expect(p.createSource).toBeUndefined();
    expect(p.classify(tool("list_things"))).toEqual({ risky: false, read: true, source: "preset" });
    expect(p.classify(tool("drop_thing", { id: {} }))).toEqual({ risky: true, read: false, source: "preset", targetPath: "/id" });
    expect(p.classify(tool("drop_thing", { other: {} }))).toEqual({ risky: true, read: false, source: "preset" });
    // Unlisted tools: null, so the generic rules (annotations, then the verb list) decide.
    for (const name of ["unknown_tool", "toString", "__proto__", "hasOwnProperty"]) expect(p.classify(tool(name))).toBeNull();
    expect(classifyTool(tool("delete_everything", {}, { readOnlyHint: true }), p)).toMatchObject({ risky: true, source: "heuristic" });
  });

  it("write, read and risky map to ToolClass exactly", () => {
    const m = patch(remote(), "risk.tools", { w: { class: "write" }, r: { class: "read" }, x: { class: "risky" } });
    const p = presetFromManifest({ ...fixtureExtension("notion"), name: "demo", manifest: m });
    expect(p.classify(tool("w"))).toEqual({ risky: false, read: false, source: "preset" });
    expect(p.classify(tool("r"))).toEqual({ risky: false, read: true, source: "preset" });
    expect(p.classify(tool("x"))).toEqual({ risky: true, read: false, source: "preset" });
  });

  it("target candidates: the first pointer whose top-level argument the live schema declares", () => {
    const m = patch(remote(), "risk.tools.drop_thing.target", ["/ids", "/thing~1id", "/id"]);
    const p = presetFromManifest({ ...fixtureExtension("notion"), name: "demo", manifest: m });
    expect(p.classify(tool("drop_thing", { id: {}, ids: {} }))?.targetPath).toBe("/ids");
    expect(p.classify(tool("drop_thing", { id: {}, "thing/id": {} }))?.targetPath).toBe("/thing~1id");
    expect(p.classify(tool("drop_thing", { id: {} }))?.targetPath).toBe("/id");
    expect(p.classify(tool("drop_thing", {}))?.targetPath).toBeUndefined();
    expect(p.classify({ name: "drop_thing", description: "", inputSchema: {} })?.targetPath).toBeUndefined();
  });

  it("header auth and a user-named server", () => {
    const p = presetFromManifest(fixtureExtension("brightspace"));
    expect(p).toMatchObject({ kind: "remote_http", auth: { type: "header", headerName: "Authorization", prefix: "Bearer " }, userServer: { defaultPath: "/mcp", sameOriginIssuer: false } });
    expect(p.url).toBeUndefined();
    expect(p.setupSteps(CTX).some((s) => s.id === "server")).toBe(true);
  });

  it("code: a native preset whose source is the code host's, with its OAuth and events", async () => {
    const ext = { ...fixtureExtension("notion"), name: "whoopish", kind: "code" as const, manifest: code() };
    const p = presetFromManifest(ext);
    expect(p).toMatchObject({ id: "whoopish", kind: "native", auth: { type: "user_app", clientIdInput: "client_id", scopes: ["read:all", "offline"] }, events: { types: ["whoopish.recovery_updated"] } });
    const source = p.createSource!({ connectionId: "con_1", accessToken: async () => "t", fetch: globalThis.fetch, log: { info() {}, warn() {} } });
    expect(source.connectionId).toBe("con_1");
    // Without the broker's deps (a data dir and the outbox) the host refuses, without spawning; the full chain is
    // test/extension-chain.test.ts.
    await expect(source.listTools(AbortSignal.timeout(1000))).rejects.toThrow(/can't run code extensions/);
  });

  it("code.auth.refreshScope: optional, checked by both, passed through to the preset's auth", () => {
    const ext = (m: Record<string, unknown>) => ({ ...fixtureExtension("notion"), name: "whoopish", kind: "code" as const, manifest: m });
    const withScope = patch(code(), "code.auth.refreshScope", "offline");
    expect(schemaValid(withScope), JSON.stringify(schemaValid.errors)).toBe(true);
    expect(validateManifest(withScope).code!.auth).toMatchObject({ type: "user_app", refreshScope: "offline" });
    expect(presetFromManifest(ext(withScope)).auth).toMatchObject({ type: "user_app", refreshScope: "offline" });
    expect(presetFromManifest(ext(patch(code(), "code.auth.refreshScope", "offline read:recovery"))).auth).toMatchObject({ refreshScope: "offline read:recovery" });
    // Absent: no key at all (the refresh sends no scope).
    expect(presetFromManifest(ext(code())).auth).not.toHaveProperty("refreshScope");
    for (const bad of ["", "offline  read", " offline", 'off"line', ["offline"]]) {
      const m = patch(code(), "code.auth.refreshScope", bad);
      expect(() => validateManifest(m), JSON.stringify(bad)).toThrow(/code.auth.refreshScope/);
      expect(schemaValid(m), JSON.stringify(bad)).toBe(false);
    }
    // Only user_app takes it.
    expect(() => validateManifest(patch(code(), "code.auth", { type: "none", refreshScope: "offline" }))).toThrow(/takes no other keys/);
  });

  it("refuses a manifest that isn't the installed extension's", () => {
    expect(() => presetFromManifest({ ...fixtureExtension("notion"), name: "other" })).toThrow(/installed as "other"/);
    expect(() => presetFromManifest({ ...fixtureExtension("notion"), kind: "code" })).toThrow(/installed as "code"/);
    expect(() => presetFromManifest({ ...fixtureExtension("notion"), manifest: { schema: 1 } })).toThrow(ManifestError);
  });
});

describe("presets(): installed extensions plus what's left in core", () => {
  it("nothing without a store (no preset is left in core); installed extensions in display order; reload picks up changes", () => {
    expect(presets().map((p) => p.id)).toEqual([]);
    const installed = [fixtureExtension("brightspace"), fixtureExtension("t3code")];
    useExtensionStore({ list: () => installed });
    expect(presets().map((p) => p.id)).toEqual(["t3code", "brightspace"]);
    const t3 = presetById("t3code");
    installed.push(fixtureExtension("notion"));
    expect(presetById("notion")).toBeNull(); // cached until a reload
    reloadPresets();
    expect(presets().map((p) => p.id)).toEqual(["notion", "t3code", "brightspace"]);
    // The same install keeps the same preset object across reloads.
    expect(presetById("t3code")).toBe(t3);
  });

  it("an installed extension replaces a core preset of the same name; a broken manifest offers nothing", () => {
    const whoop = { ...fixtureExtension("notion"), name: "whoop", kind: "code" as const, manifest: { ...code(), name: "whoop", slug: "whoop", code: { ...(code().code as object), events: ["whoop.recovery_updated"] } } };
    const broken = { ...fixtureExtension("notion"), name: "broken", manifest: { schema: 1, name: "broken" } };
    useExtensionStore({ list: () => [whoop, broken] });
    const ids = presets().map((p) => p.id);
    expect(ids).toEqual(["whoop"]);
    expect(presetById("whoop")!.kind).toBe("native");
    expect(presetById("whoop")!.auth).toMatchObject({ authorizeUrl: "https://api.example/oauth/auth" });
    expect(brokenExtensions().get("broken")).toMatch(/missing/);
  });
});

describe("usedBy", () => {
  it("usedBy: the connections bound to an extension (connections.preset), oldest first", async () => {
    const t = testContext();
    try {
      const add = (id: string, preset: string | null, at: string) =>
        t.ctx.db.run("INSERT INTO connections (id, kind, preset, slug, name, url, created_at, updated_at) VALUES (?, 'remote_http', ?, ?, ?, 'https://x.example/mcp', ?, ?)", id, preset, id.replace("_", "-"), id, at, at);
      add("con_b", "notion", "2026-10-02T00:00:00Z");
      add("con_a", "notion", "2026-10-01T00:00:00Z");
      add("con_c", null, "2026-10-01T00:00:00Z");
      add("con_d", "t3code", "2026-10-01T00:00:00Z");
      expect(usedBy(t.ctx.db, "notion")).toEqual(["con_a", "con_b"]);
      expect(usedBy(t.ctx.db, "t3code")).toEqual(["con_d"]);
      expect(usedBy(t.ctx.db, "brightspace")).toEqual([]);
    } finally {
      await t.dispose();
    }
  });
});

describe("review rules (tier L)", () => {
  const third = (manifest: Record<string, unknown>) => presetFromManifest({ ...fixtureExtension("notion"), name: "demo", official: false, source: "/tmp/demo", manifest });

  it("a third-party risk map can make tools stricter, never looser; its nameCheckExempt is ignored", () => {
    const m = patch(
      patch(remote(), "risk.tools", {
        send_note: { class: "write" },
        list_notes: { class: "read" },
        wipe_cache: { class: "read" },
        tidy: { class: "risky", target: "/id" },
        archive_note: { class: "write" },
        notes_report: { class: "read" },
      }),
      "risk.nameCheckExempt",
      ["send_note"],
    );
    const p = third(m);
    expect(p.official).toBe(false);
    expect(p.nameCheckExempt).toBeUndefined();
    // Looser than the generic rules: overruled. send (a risky verb) stays risky even though the map says write and exempts it.
    expect(classifyTool(tool("send_note"), p)).toMatchObject({ risky: true, read: false });
    // A read the annotations call destructive is risky, not a read.
    expect(classifyTool(tool("notes_report", {}, { destructiveHint: true }), p)).toMatchObject({ risky: true, read: false });
    expect(classifyTool(tool("wipe_cache"), p)).toMatchObject({ risky: true, read: false });
    // Stricter: kept. A tool the generic rules call a write can be made risky; a plain read stays a read.
    expect(classifyTool(tool("tidy", { id: {} }), p)).toEqual({ risky: true, read: false, source: "preset", targetPath: "/id" });
    expect(classifyTool(tool("list_notes", {}, { readOnlyHint: true }), p)).toEqual({ risky: false, read: true, source: "preset" });
    expect(classifyTool(tool("archive_note", {}, { destructiveHint: true }), p)).toMatchObject({ risky: true });
    // A generic write the map calls a read stays a write: not listed at Read only (update_page, run_query, create_issue).
    const reads = third(patch(remote(), "risk.tools", { update_page: { class: "read" }, run_query: { class: "read" }, create_issue: { class: "read" } }));
    for (const name of ["update_page", "run_query", "create_issue"]) {
      expect(classifyTool(tool(name, {}, { readOnlyHint: false }), reads), name).toMatchObject({ read: false });
      expect(classifyTool(tool(name), reads), name).toMatchObject({ read: false });
    }
    // The same map from the official registry is trusted as written.
    const o = presetFromManifest({ ...fixtureExtension("notion"), name: "demo", manifest: m });
    expect(o.official).toBe(true);
    expect(classifyTool(tool("send_note"), o)).toMatchObject({ risky: false, read: false });
    expect(classifyTool(tool("notes_report", {}, { destructiveHint: true }), o)).toEqual({ risky: false, read: true, source: "preset" });
  });

  it("a template link must go on with /, ?, # or nothing, so the install's address can't become a user name", () => {
    for (const url of ["{{publicUrl}}", "{{publicUrl}}/settings", "{{redirectUri}}?x=1", "{{redirectUri}}#top"]) {
      const m = patch(remote(), "setup.0.link", { label: "Open", url });
      expect(() => validateManifest(m), url).not.toThrow();
      expect(schemaValid(m), url).toBe(true);
    }
    for (const url of ["{{publicUrl}}@evil.example", "{{publicUrl}}.evil.example/x", "{{publicUrl}}:8443", "{{ publicUrl }}evil"]) {
      const m = patch(remote(), "setup.0.link", { label: "Open", url });
      expect(() => validateManifest(m), url).toThrow(/followed by \/, \?, # or nothing/);
      expect(schemaValid(m), url).toBe(false);
    }
  });

  it("input labels and placeholders are shown as they are: no {{ }}", () => {
    for (const input of [
      { key: "k", label: "Paste {{publicUrl}}" },
      { key: "k", label: "Key", placeholder: "{{redirectUri}}" },
      { key: "k", label: "Key }}" },
    ]) {
      const m = patch(remote(), "setup.0.input", input);
      expect(() => validateManifest(m), JSON.stringify(input)).toThrow(/can't use \{\{ \}\}/);
      expect(schemaValid(m), JSON.stringify(input)).toBe(false);
    }
  });

  it("scopeNotes: an array of { scope, note }, in order (integer-like scopes too), passed to the preset", () => {
    const ordered = patch(remote(), "remote.auth", { type: "mcp_oauth", scopeNotes: [{ scope: "b", note: "B." }, { scope: "10", note: "Ten." }, { scope: "2", note: "Two." }] });
    expect((presetFromManifest({ ...fixtureExtension("notion"), name: "demo", manifest: ordered }).auth as unknown as { scopeNotes: { scope: string }[] }).scopeNotes.map((n) => n.scope)).toEqual(["b", "10", "2"]);
    const m = patch(remote(), "remote.auth", { type: "mcp_oauth", broadScopes: ["admin"], scopeNotes: [{ scope: "admin", note: "Everything." }, { scope: "read:all", note: "Reads." }] });
    expect(schemaValid(m)).toBe(true);
    expect(presetFromManifest({ ...fixtureExtension("notion"), name: "demo", manifest: m }).auth).toEqual({
      type: "mcp_oauth",
      broadScopes: ["admin"],
      scopeNotes: [
        { scope: "admin", note: "Everything." },
        { scope: "read:all", note: "Reads." },
      ],
    });
    for (const notes of [{ admin: "x" }, [{ scope: "admin", note: 3 }], [{ scope: "bad scope", note: "x" }], [{ scope: "admin", note: "See {{publicUrl}}" }], [{ scope: "a", note: "x", extra: 1 }], [{ scope: "a" }]]) {
      const bad = patch(remote(), "remote.auth", { type: "mcp_oauth", scopeNotes: notes });
      expect(() => validateManifest(bad), JSON.stringify(notes)).toThrow(/scopeNotes/);
      expect(schemaValid(bad), JSON.stringify(notes)).toBe(false);
    }
    expect(() => validateManifest(patch(remote(), "remote.auth", { type: "header", headerName: "X-Key", scopeNotes: {} }))).toThrow(/doesn't take/);
  });
});
