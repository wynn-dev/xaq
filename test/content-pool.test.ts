// Content cleaning in worker threads: deadlines, fallbacks and a responsive event loop under hostile mail.

import { afterEach, describe, expect, it } from "vitest";
import type { ParsedMessage } from "../server/google/types.ts";
import { buildContent, cleanLine, escapeDelimiters, fallbackContent, formatAddress, stripInvisible } from "../server/mail/content.ts";
import { ContentPool } from "../server/mail/pool.ts";
import { createLogger } from "../server/util/log.ts";
import { bestOf, expectLinear } from "./content-perf.ts";

const log = createLogger("test").child("content");

/**
 * In source mode the real worker is server/mail/content-worker.ts, which Node can only load with built-in
 * type stripping (22.18+ / 23.6+). On older Node the pool cleans in-process (by design), so tests that
 * need a real worker thread are skipped there; the build ships plain JS and is unaffected.
 */
const supportsTsWorkers = !!(process.features as { typescript?: unknown }).typescript;
const workerOnly = it.skipIf(!supportsTsWorkers);
const OPTS = { accountEmail: "me@acme.com", maxChars: 0 };
const pools: ContentPool[] = [];
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
});
const pool = (opts?: ConstructorParameters<typeof ContentPool>[1]) => {
  const p = new ContentPool(log, opts);
  pools.push(p);
  return p;
};

const message = (html: string | null, text: string | null = null): ParsedMessage => ({
  summary: { id: "m1", threadId: "t1", from: { name: null, email: "x@evil.example" }, to: [], cc: [], subject: "s", snippet: "", date: "", labelIds: [], hasAttachments: false },
  headers: {},
  messageId: null,
  inReplyTo: null,
  references: [],
  replyTo: [],
  text,
  html,
  attachments: [],
  authenticationResults: null,
});

/** Runs `fn` while sampling event-loop lag every 10 ms; returns the result, wall time and worst lag. */
async function measure<T>(fn: () => Promise<T>) {
  let worst = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  const t0 = performance.now();
  try {
    const result = await fn();
    return { result, ms: performance.now() - t0, lag: worst };
  } finally {
    clearInterval(probe);
  }
}

describe("content pool", () => {
  it("returns the same content as in-process cleaning", async () => {
    const p = pool();
    const m = message('<p>Hello <b>there</b></p><div style="display:none">hidden</div>');
    expect(await p.content(m, OPTS)).toEqual(buildContent(m, OPTS));
    expect((await p.html("<h1>T</h1>")).markdown).toBe("# T");
  });

  workerOnly("falls back to the text part when the deadline passes, then keeps working", async () => {
    const p = pool({ deadlineMs: 1 });
    const slow = message(`<table>${"<tr><td>cell</td><td>x</td></tr>".repeat(4000)}</table>`, "Plain version.");
    const c = await p.content(slow, OPTS);
    expect(c.truncated).toBe(true);
    expect(c.body).toBe("[This message is too complex to display safely; showing its plain-text version.]\n\nPlain version.");
    const none = await p.content(message(slow.html), OPTS);
    expect(none.body).toMatch(/too complex to display safely\. Ask a human/);
    const relaxed = pool({ deadlineMs: 5_000 });
    expect((await relaxed.content(message("<p>ok</p>"), OPTS)).body).toBe("ok");
  });

  workerOnly("keeps the event loop responsive and every hostile message under 3 s", async () => {
    const p = pool();
    const hostile = {
      selectorBacktracking: `<style>section div div div div div div div div{display:none}</style>${"<div>".repeat(60)}x`,
      deepNesting: "<div>".repeat(19_000) + "x",
      tooManyElements: "<div>".repeat(50_000) + "x",
      flatInline: "<b>x</b>".repeat(50_000),
      rulesTimesElements: `<style>${Array.from({ length: 8000 }, (_, i) => `.c${i}{display:none}`).join("")}</style>${'<div class="c5000 a b">t</div>'.repeat(10_000)}`,
      longWhitespace: `<pre>a${" ".repeat(400_000)}b</pre>`,
    };
    for (const [name, html] of Object.entries(hostile)) {
      const m = await measure(() => p.content(message(html, "fallback text"), OPTS));
      // Generous bounds for slow CI; the point is "never blocks for seconds" (these took 3 s to minutes).
      expect(m.ms, name).toBeLessThan(3_000);
      expect(m.lag, name).toBeLessThan(500);
      expect(m.result.body.length, name).toBeGreaterThan(0);
    }
  });

  it("cleans in-process when workers can't start, and says so once", async () => {
    const warnings: string[] = [];
    const quiet = { ...log, warn: (msg: string) => void warnings.push(msg), child: () => quiet };
    const p = new ContentPool(quiet, { workerUrl: new URL("./does-not-exist.js", import.meta.url) });
    pools.push(p);
    for (let i = 0; i < 5; i++) expect((await p.content(message(`<p>inline ${i}</p>`), OPTS)).body).toBe(`inline ${i}`);
    expect(warnings.filter((w) => /could not start/.test(w))).toHaveLength(1);
  });

  it("resolves pending work with the fallback on close", async () => {
    const p = new ContentPool(log, { deadlineMs: 60_000 });
    const pending = p.content(message(`<p>${"x ".repeat(10)}</p>`, "text"), OPTS);
    await p.close();
    expect((await pending).body.length).toBeGreaterThan(0);
  });
});

describe("linear-time helpers", () => {
  it.each([
    ["delimiter escaping (spaces)", (n: number) => () => escapeDelimiters("<" + " ".repeat(n))],
    ["delimiter escaping (angle brackets)", (n: number) => () => escapeDelimiters("<".repeat(n))],
    ["zero-length check", (n: number) => () => buildContent(message(`<p style="font-size:${"0".repeat(n)}x">a</p>`), OPTS)],
    ["background shorthand", (n: number) => () => buildContent(message(`<p style="background:${"a-".repeat(n / 2)}">a</p>`), OPTS)],
    ["comment with brackets", (n: number) => () => buildContent(message(`<!--${"<".repeat(n)}-->`), OPTS)],
    ["auth results parentheses", (n: number) => () => buildContent({ ...message(null, "x"), authenticationResults: "mx.google.com; " + "(".repeat(n) }, OPTS)],
    ["role-spoof pattern on blank lines", (n: number) => () => buildContent(message(null, "\n".repeat(n) + "x"), OPTS)],
  ])("%s", (name, make) => {
    expect(bestOf(make(40_000), 1)).toBeLessThan(1_000);
    expectLinear(name, make, 10_000);
  });
});

describe("review inputs finish well inside the deadline", () => {
  const big = {
    "20k unclosed divs": "<div>".repeat(20_000) + "x",
    "60k unclosed divs": "<div>".repeat(60_000) + "x",
    "90k closed divs": "<div>".repeat(90_000) + "x" + "</div>".repeat(90_000),
    "10k small tables": Array.from({ length: 10_000 }, (_, i) => `<table><tr><th>a${i}</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>`).join(""),
    "30k-row table": `<table><tr><th>a</th><th>b</th></tr>${"<tr><td>1</td><td>2</td></tr>".repeat(30_000)}</table>`,
    "6.6k-row table with links": `<table><tr><th>a</th><th>b</th></tr>${'<tr><td><a href="https://x.io">1</a></td><td>2</td></tr>'.repeat(6_600)}</table>`,
    // Just under the element cap, so it's really converted (2,000 cells through turndown, the rest as text).
    "4.9k-row table with links": `<table><tr><th>a</th><th>b</th></tr>${'<tr><td><a href="https://x.io">1</a></td><td>2</td></tr>'.repeat(4_900)}</table>`,
    "19.9k unclosed divs": "<div>".repeat(19_900) + "x",
  };
  it.each(Object.entries(big))("%s in-process", (_name, html) => {
    // In-process cleaning only runs when workers can't start; it must never block for many seconds.
    // Locally 0-200 ms; shared CI runners on Node 22 have measured ~1.6 s.
    expect(bestOf(() => buildContent(message(html, "text"), OPTS), 2)).toBeLessThan(4_000);
  });
  workerOnly("all of them through the pool, without fallbacks", async () => {
    const p = pool();
    // The first job's deadline also pays the pool's cold start: starting the worker, then unoptimized code (a
    // first deep tree or table runs 2-3x slower). On a slow CI runner the two together have passed it, so warm
    // the worker on the same paths with small inputs first (they can't time out, which would replace the worker).
    await p.content(message("<div>".repeat(2_000) + "x"), OPTS);
    await p.content(message(`<table>${'<tr><td><a href="https://x.io">1</a></td><td>2</td></tr>'.repeat(500)}</table>`), OPTS);
    for (const [name, html] of Object.entries(big)) {
      const m = await measure(() => p.content(message(html, "text"), OPTS));
      // No deadline fallback is the real assertion; lag only has to show the loop never blocked.
      expect(m.result.body, name).not.toMatch(/too complex to display safely; showing its plain-text/);
      expect(m.lag, name).toBeLessThan(500);
    }
  });
});

describe("queueing: total deadline, bounded queue, memory of slow inputs, lanes", () => {
  const SLOW_WORKER = new URL("./content-slow-worker.mjs", import.meta.url);
  const msg = (html: string, id = html) => ({ ...message(html, "plain"), summary: { ...message(html).summary, id } });
  const warm = async (p: ContentPool) => {
    await Promise.all([p.content(msg("warm1"), OPTS, "interactive"), p.content(msg("warm2"), OPTS, "interactive")]);
  };

  it("measures the deadline from enqueue, so a benign read never waits behind many slow ones", async () => {
    const p = pool({ workerUrl: SLOW_WORKER, deadlineMs: 300 });
    await warm(p);
    const bombs = Array.from({ length: 10 }, (_, i) => p.content(msg("SLOW", `bomb${i}`), OPTS));
    const t0 = performance.now();
    const benign = await p.content(msg("benign"), OPTS);
    // Queued behind 10 jobs of 10 s each, it resolves at its own deadline with the fallback.
    expect(benign.truncated).toBe(true);
    expect(performance.now() - t0).toBeLessThan(5_000);
    await Promise.all(bombs);
  });

  it("falls back at once when the queue is full", async () => {
    const p = pool({ workerUrl: SLOW_WORKER, deadlineMs: 5_000, maxQueue: 2, size: 1 });
    await p.content(msg("warm"), OPTS);
    const running = p.content(msg("SLOW", "a"), OPTS);
    let runningDone = false;
    void running.then(() => (runningDone = true));
    const queued = [p.content(msg("SLOW", "b"), OPTS), p.content(msg("SLOW", "c"), OPTS)];
    // Resolves while every queued job is still busy-waiting (10 s each, 5 s deadline).
    const overflow = await p.content(msg("SLOW", "d"), OPTS);
    expect(overflow.body).toMatch(/too complex to display safely/);
    expect(runningDone).toBe(false);
    await p.close();
    await Promise.all([running, ...queued]);
  });

  it("sends inputs that already timed out straight to the fallback", async () => {
    const p = pool({ workerUrl: SLOW_WORKER, deadlineMs: 1_500 });
    await warm(p);
    await p.content(msg("SLOW", "same"), OPTS);
    const t0 = performance.now();
    const again = await p.content(msg("SLOW", "same"), OPTS);
    expect(again.truncated).toBe(true);
    // Without the memory it would wait for the 1.5 s deadline again.
    expect(performance.now() - t0).toBeLessThan(750);
  });

  it("keeps a worker free for interactive reads while background jobs are slow", async () => {
    const p = pool({ workerUrl: SLOW_WORKER, deadlineMs: 2_000 });
    await warm(p);
    const background = Array.from({ length: 5 }, (_, i) => p.content(msg("SLOW", `hook${i}`), OPTS, "background"));
    // Not the fallback: a worker was free for it while the background jobs busy-wait.
    const read = await p.content(msg("benign"), OPTS, "interactive");
    expect(read.body).toBe("fast:benign");
    await p.close();
    await Promise.all(background);
  });
});

describe("bidi bombs stay linear on every main-thread path", () => {
  const pairs = (n: number) => String.fromCodePoint(0x202a).repeat(n) + String.fromCodePoint(0x2069).repeat(n);
  const bomb = pairs(40_000);
  it.each([
    ["stripInvisible", (n: number) => () => stripInvisible(pairs(n))],
    ["fallbackContent (text part)", (n: number) => () => fallbackContent(message(null, pairs(n)), OPTS)],
    ["fallbackContent (subject)", (n: number) => () => fallbackContent({ ...message(null, "x"), summary: { ...message(null).summary, subject: pairs(n) } }, OPTS)],
    ["in-process plain text", (n: number) => () => buildContent(message(null, pairs(n)), OPTS)],
    ["cleanLine", (n: number) => () => cleanLine(pairs(n))],
    ["formatAddress", (n: number) => () => formatAddress({ name: pairs(n), email: "x@evil.example" })],
    ["nested comments in Authentication-Results", (n: number) => () => buildContent({ ...message(null, "x"), authenticationResults: "mx.google.com; " + "(".repeat(n / 10) + ")".repeat(n / 10) + '"'.repeat(n / 10) }, OPTS)],
  ])("%s", (name, make) => {
    // 40k pairs took ~3 s when this was quadratic.
    expect(bestOf(make(40_000), 1)).toBeLessThan(1_000);
    expectLinear(name, make, 10_000);
  });

  workerOnly("text attachments are cleaned in a worker", async () => {
    const p = pool();
    const m = await measure(() => p.text(`hi${bomb}`));
    expect(m.result).toBe("hi");
    expect(m.lag).toBeLessThan(500);
  });
});
