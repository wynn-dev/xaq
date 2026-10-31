// Search-mode eval: does search_tools put the right tool in front of the agent?
// Deterministic: BM25 over a fixed synthetic catalog, no model involved.
import { describe, expect, it } from "vitest";
import { ToolIndex, tokenize } from "../server/broker/search/bm25.ts";
import { CATALOG, TASKS } from "./broker-search-catalog.ts";

describe("search_tools eval", () => {
  it("has a realistic catalog: about 100 tools over 8 services, about 40 tasks", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(95);
    expect(new Set(CATALOG.map((t) => t.name.split("__")[0])).size).toBe(8);
    expect(new Set(CATALOG.map((t) => t.name)).size).toBe(CATALOG.length);
    expect(TASKS.length).toBeGreaterThanOrEqual(40);
    const names = new Set(CATALOG.map((t) => t.name));
    for (const t of TASKS) for (const e of t.expected) expect(names, e).toContain(e);
  });

  it("puts the right tool in the top 5 for at least 90 % of tasks", () => {
    const index = new ToolIndex(CATALOG);
    let top1 = 0;
    let top5 = 0;
    const misses: string[] = [];
    for (const { task, expected } of TASKS) {
      const hits = index.search(task, 5).map((h) => h.tool.name);
      if (expected.includes(hits[0] ?? "")) top1++;
      if (hits.some((h) => expected.includes(h))) top5++;
      else misses.push(`${task} → ${hits.slice(0, 3).join(", ") || "(none)"}`);
    }
    const pct = (n: number) => `${((100 * n) / TASKS.length).toFixed(1)} %`;
    console.log(`search_tools eval: ${CATALOG.length} tools, ${TASKS.length} tasks; top-1 ${top1}/${TASKS.length} (${pct(top1)}), top-5 ${top5}/${TASKS.length} (${pct(top5)})`);
    if (misses.length) console.log(`top-5 misses:\n  ${misses.join("\n  ")}`);
    expect(top5 / TASKS.length).toBeGreaterThanOrEqual(0.9);
  });

  it("tokenizes names and text the same way", () => {
    expect(tokenize("notion__create_pages")).toEqual(["notion", "creat", "pag"]);
    expect(tokenize("getPullRequestDiff")).toEqual(["get", "pull", "request", "diff"]);
    expect(tokenize("Scheduling the scheduled meetings")).toEqual(["schedul", "schedul", "meet"]);
  });

  it("is deterministic and leaves out tools that share no word with the query", () => {
    const index = new ToolIndex(CATALOG);
    expect(index.search("refund a payment", 5)).toEqual(index.search("refund a payment", 5));
    expect(index.search("zzzz qqqq", 5)).toEqual([]);
    expect(index.search("the and of", 5)).toEqual([]);
  });
});
