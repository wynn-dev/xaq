// `xaq connections rename` and the console's "Change short name": both PATCH /api/connections/:id {slug}, check the
// new slug the same way (shared/connection-rename.ts) and warn that calls by the old tool names break.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renameWarning, slugProblem } from "../shared/connection-rename.ts";
import { addConnection, renameConnection } from "../server/connections-cli/manage.ts";
import { ScriptedPrompter } from "../server/connections-cli/prompt.ts";
import { type Daemon, startDaemon } from "./connections-cli-fake.ts";

describe("slugProblem and renameWarning (console and CLI)", () => {
  const all = [
    { id: "c1", slug: "notion", name: "Notion" },
    { id: "c2", slug: "whoop", name: "WHOOP" },
  ];
  it("refuses an invalid, unchanged or taken slug", () => {
    expect(slugProblem("notion-work", all[0]!, all)).toBeNull();
    expect(slugProblem("notion", all[0]!, all)).toMatch(/already/);
    expect(slugProblem("Bad Slug", all[0]!, all)).toMatch(/lowercase/);
    expect(slugProblem("x".repeat(25), all[0]!, all)).toMatch(/1-24/);
    expect(slugProblem("whoop", all[0]!, all)).toBe(`There's already a connection "whoop" (WHOOP).`);
  });
  it("warns that the old tool names stop working", () => {
    expect(renameWarning("whoop", "whoop-old")).toMatch(/whoop-old__<tool> from now on: anything that calls whoop__<tool> .* stops working/);
  });
});

describe("connections rename (CLI)", () => {
  let d: Daemon;
  beforeEach(async () => {
    d = await startDaemon();
  });
  afterEach(() => d.dispose());
  const deps = (p: ScriptedPrompter) => ({ api: d.api, prompter: p, env: {}, pollMs: 1, timeoutMs: 2000 });
  const yes = () => new ScriptedPrompter([], true);
  const tools = (slug: string) =>
    d.h.ctx.db.all<{ exposed_name: string }>("SELECT exposed_name FROM upstream_tools t JOIN connections c ON c.id = t.connection_id WHERE c.slug = ? ORDER BY exposed_name", slug).map((r) => r.exposed_name);

  it("renames the slug and the exposed tool names after the warning and a yes", async () => {
    expect(await addConnection("notion", { yes: true }, deps(yes()))).toBe(0);
    const before = tools("notion");
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((t) => t.startsWith("notion__"))).toBe(true);
    const id = d.h.ctx.db.get<{ id: string }>("SELECT id FROM connections WHERE slug = 'notion'")!.id;

    const declined = new ScriptedPrompter(["n"]);
    expect(await renameConnection("notion", { slug: "notion-work" }, deps(declined))).toBe(0);
    expect(declined.text).toMatch(/anything that calls notion__<tool> .* stops working/);
    expect(declined.text).toMatch(/Nothing was changed/);
    expect(tools("notion")).toEqual(before);

    const p = new ScriptedPrompter(["y"]);
    expect(await renameConnection(id, { slug: "notion-work", name: "Work wiki" }, deps(p))).toBe(0);
    expect(p.text).toMatch(/Renamed "notion": its tools are now notion-work__<tool>; its name is now "Work wiki"/);
    expect(tools("notion")).toEqual([]);
    expect(tools("notion-work")).toEqual(before.map((t) => t.replace(/^notion__/, "notion-work__")));
    expect(d.h.ctx.db.get<{ name: string }>("SELECT name FROM connections WHERE id = ?", id)!.name).toBe("Work wiki");
  });

  it("a slug that's in use (or invalid) fails cleanly, before any question, and changes nothing", async () => {
    await addConnection("notion", { yes: true }, deps(yes()));
    await addConnection("notion", { yes: true, slug: "notion-work" }, deps(yes()));
    const p = new ScriptedPrompter([]); // any question would throw
    await expect(renameConnection("notion", { slug: "notion-work" }, deps(p))).rejects.toThrow(/--slug "notion-work": There's already a connection "notion-work"/);
    await expect(renameConnection("notion", { slug: "Not OK" }, deps(p))).rejects.toThrow(/lowercase letters/);
    await expect(renameConnection("nope", { slug: "x" }, deps(p))).rejects.toThrow(/No connection "nope"/);
    await expect(renameConnection("notion", {}, deps(p))).rejects.toThrow(/Pass --slug/);
    expect(d.h.ctx.db.all<{ slug: string }>("SELECT slug FROM connections ORDER BY slug").map((r) => r.slug)).toEqual(["notion", "notion-work"]);
  });

  it("the server still refuses a taken slug (a race past the CLI's check) with a clean error", async () => {
    await addConnection("notion", { yes: true }, deps(yes()));
    await addConnection("notion", { yes: true, slug: "notion-work" }, deps(yes()));
    const id = d.h.ctx.db.get<{ id: string }>("SELECT id FROM connections WHERE slug = 'notion'")!.id;
    await expect(d.api.update(id, { slug: "notion-work" })).rejects.toThrow(/The slug notion-work is taken/);
  });
});
