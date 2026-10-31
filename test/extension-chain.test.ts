// The whole code-extension chain, end to end and offline: the echo fixture installed through the extension store
// (B1, a local directory), turned into a preset by presetFromManifest (B2, through presets()), a connection created
// from that preset over the API, its child spawned by the code host (B3) under the real flags, and a tool call over
// /mcp from an agent. Then a forced removal of the extension disables the connection and stops its child (store
// onRemove/onChange → preset reload → restart), and deleting the connection deletes its state.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { codeExtensionNodeProblem, extensionStateDir } from "../server/extensions/host/index.ts";
import { extensionStore } from "../server/extensions/store.ts";
import { presets } from "../server/integrations/index.ts";
import { CSRF, harness, json } from "./helpers.ts";

const FIXTURE = resolve(import.meta.dirname, "fixtures/extensions/echo");
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});
const textOf = (r: unknown) => (r as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join("\n");

describe.skipIf(codeExtensionNodeProblem() !== null)("a code extension, store → preset → host → /mcp", () => {
  it("installs from a directory, binds through presetFromManifest, spawns under the sandbox and answers a tool call", async () => {
    const h = harness();
    cleanup.push(() => h.dispose());
    const { ctx } = h;
    // No network anywhere: the store's fetch refuses (a local-directory install needs none).
    extensionStore(ctx, {
      fetch: (async () => {
        throw new Error("no network in tests");
      }) as typeof fetch,
    });
    ctx.broker.start?.(); // registers the store with presets() and subscribes to its changes
    const cookie = await h.claim();
    const api = (path: string, init: RequestInit & { json?: unknown } = {}) => h.request(`/api${path}`, { cookie, ...init, headers: { ...CSRF, ...(init.headers as object) } });

    // B1: install (third party, confirmed). B2: presets() now offers it, built from its manifest.
    const installed = await extensionStore(ctx).install(FIXTURE, { confirmThirdParty: true });
    expect(installed).toMatchObject({ name: "echo", kind: "code", official: false, commit: null });
    expect(extensionStore(ctx).verify("echo")).toBe(true);
    const preset = presets().find((p) => p.id === "echo");
    expect(preset).toMatchObject({ id: "echo", kind: "native", auth: { type: "none" } });
    expect(preset!.createSource).toBeTypeOf("function");

    // The connection, from the preset, through the API; an agent with full access.
    const { agent, apiKey } = ctx.policy.createAgent({ name: "Hermes" });
    const con = await json(await api("/connections", { method: "POST", json: { preset: "echo", slug: "echo", agentIds: [agent.id], levelDefault: "full" } }));
    expect(con).toMatchObject({ preset: "echo", kind: "stdio", slug: "echo" });
    ctx.broker.attach(con.id);
    expect(await ctx.broker.catalog.refresh(con.id)).toMatchObject({ ok: true });

    // B3: the child runs from the store's install directory, with the sandbox flags.
    const client = new Client({ name: "agent", version: "1" });
    const app = h.app;
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://xaq.test/mcp"), {
        requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
        fetch: async (url, init) => app.request(String(url), init as RequestInit, { incoming: { socket: { remoteAddress: "127.0.0.1" } } }),
      }),
    );
    cleanup.push(() => client.close());
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["echo__echo", "echo__argv"]));
    expect(textOf(await client.callTool({ name: "echo__echo", arguments: { text: "through the whole chain" } }))).toContain("through the whole chain");
    const argv = textOf(await client.callTool({ name: "echo__argv", arguments: {} }));
    expect(argv).toContain("--permission");
    expect(argv).toContain("--no-experimental-sqlite");
    expect(argv).toContain(installed.installDir);
    expect(argv).toContain(extensionStateDir(ctx.config.dataDir, "echo", con.id));

    // An official extension removed by force and installed again: its connections (official names stay bound) come
    // back on their own, with no sign-in, because nothing cleared their credentials. (The fixture is a directory
    // install; the store's row is marked official to take that path.)
    ctx.db.run("UPDATE extensions SET official = 1 WHERE name = 'echo'");
    await extensionStore(ctx).remove("echo", { force: true });
    expect(await json(await api(`/connections/${con.id}`))).toMatchObject({ status: "disabled", preset: "echo", statusReason: "its extension echo was removed" });
    await extensionStore(ctx).install(FIXTURE, { confirmThirdParty: true });
    expect(await json(await api(`/connections/${con.id}`))).toMatchObject({ status: "active", statusReason: null });
    await ctx.broker.catalog.refresh(con.id);
    expect(textOf(await client.callTool({ name: "echo__echo", arguments: { text: "back after reinstall" } }))).toContain("back after reinstall");

    // Removing a third-party extension (forced: the connection uses it) disables and unbinds the connection, and
    // stops its child; installing it again doesn't bring the connection back.
    const pid = (ctx.broker.source(con.id) as unknown as { pid: number | null }).pid!;
    expect(pid).toBeTypeOf("number");
    await extensionStore(ctx).remove("echo", { force: true });
    const until = Date.now() + 5000;
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (alive() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(alive()).toBe(false);
    expect(await json(await api(`/connections/${con.id}`))).toMatchObject({ status: "disabled", preset: null });
    await extensionStore(ctx).install(FIXTURE, { confirmThirdParty: true });
    expect(await json(await api(`/connections/${con.id}`))).toMatchObject({ status: "disabled" });

    // Deleting the connection deletes its state directory.
    expect((await api(`/connections/${con.id}`, { method: "DELETE" })).status).toBe(204);
    expect(existsSync(extensionStateDir(ctx.config.dataDir, "echo", con.id))).toBe(false);
  });
});
