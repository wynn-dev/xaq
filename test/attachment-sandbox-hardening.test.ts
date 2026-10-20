// The parser child after the security review: no network by any route (TCP, UDP, DNS resolvers, HTTP, TLS, HTTP/2,
// fetch, classes reached through live instances), no v8 flag changes, a resident-memory cap enforced from the daemon
// (Linux /proc and the `ps` reader used on macOS), oom_score_adj, failures of running jobs remembered, and identical
// requests in flight merged.

import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttachmentParser, procRss, psRss, rssReaderFor } from "../server/mail/extract/sandbox.ts";
import { createLogger } from "../server/util/log.ts";

const log = createLogger("test").child("hardening");
const parsers: AttachmentParser[] = [];
afterAll(async () => {
  for (const p of parsers) await p.close();
});
const hostile = (src: string, opts: ConstructorParameters<typeof AttachmentParser>[1] = {}) => {
  const p = new AttachmentParser(log, { ...opts, loadCode: async () => Buffer.from(src) });
  parsers.push(p);
  return p;
};
/** Runs `body` (an async function body) in the child; returns what it reported. */
async function probe(body: string): Promise<Record<string, string>> {
  const p = hostile(`export async function run() { const out = {}; ${body}; return { ok: true, result: { format: "docx", markdown: JSON.stringify(out), notes: [] } }; }`);
  const r = await p.parse(Buffer.from(String(Math.random())), { format: "docx" });
  if (!r.ok || r.result.format !== "docx") throw new Error(`expected the probe's report: ${JSON.stringify(r)}`);
  return JSON.parse(r.result.markdown) as Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("no network from the child", () => {
  let tcp: Server;
  let tcpPort = 0;
  let tcpHits = 0;
  const udp = createSocket("udp4");
  let udpPort = 0;
  let udpHits = 0;
  beforeAll(async () => {
    tcp = createServer((s) => {
      tcpHits++;
      s.destroy();
    });
    await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", () => r()));
    tcpPort = (tcp.address() as { port: number }).port;
    udp.on("message", () => udpHits++);
    await new Promise<void>((r) => udp.bind(0, "127.0.0.1", () => r()));
    udpPort = udp.address().port;
  });
  afterAll(async () => {
    await new Promise((r) => tcp.close(r));
    udp.close();
  });

  it("every route throws and nothing reaches a local TCP or UDP listener", async () => {
    const report = await probe(`
      const g = (m) => process.getBuiltinModule(m);
      const tries = {
        netConnect: () => g("node:net").connect(${tcpPort}, "127.0.0.1"),
        netSocketExport: () => new (g("node:net").Socket)().connect(${tcpPort}, "127.0.0.1"),
        stdoutCtor: () => new process.stdout.constructor().connect(${tcpPort}, "127.0.0.1"),
        netServer: () => g("node:net").createServer().listen(0),
        tls: () => g("node:tls").connect(${tcpPort}, "127.0.0.1"),
        http: () => g("node:http").request("http://127.0.0.1:${tcpPort}/").end(),
        httpGet: () => g("node:http").get("http://127.0.0.1:${tcpPort}/"),
        httpAgent: () => new (g("node:http").Agent)().createConnection({ port: ${tcpPort}, host: "127.0.0.1" }),
        https: () => g("node:https").request("https://127.0.0.1:${tcpPort}/").end(),
        http2: () => g("node:http2").connect("http://127.0.0.1:${tcpPort}"),
        dgramExport: () => g("node:dgram").createSocket("udp4").send("x", ${udpPort}, "127.0.0.1"),
        dgramClass: () => new (g("node:dgram").Socket)("udp4").send("x", ${udpPort}, "127.0.0.1"),
        dnsLookup: () => g("node:dns").lookup("example.test", () => {}),
        dnsResolver: () => { const r = new (g("node:dns").Resolver)(); r.setServers(["127.0.0.1:${udpPort}"]); r.resolve4("exfil.example.test", () => {}); },
        dnsPromisesResolver: () => { const r = new (g("node:dns/promises").Resolver)(); r.setServers(["127.0.0.1:${udpPort}"]); return r.resolve4("exfil.example.test"); },
        dnsDotPromises: () => { const p = g("node:dns").promises; return typeof p === "function" ? p() : p.resolve4("exfil.example.test"); },
        v8Flags: () => g("node:v8").setFlagsFromString("--allow-natives-syntax"),
        binding: () => process.binding("udp_wrap"),
      };
      for (const [k, f] of Object.entries(tries)) {
        try { const v = f(); if (v && typeof v.then === "function") await v; out[k] = "ALLOWED"; }
        catch (e) { out[k] = /disabled|can't be changed/.test(e.message) ? "blocked" : (e.code || e.message); }
      }
      for (const k of ["fetch", "WebSocket", "EventSource"]) {
        try { await globalThis[k]("http://127.0.0.1:${tcpPort}/"); out[k] = "ALLOWED"; } catch (e) { out[k] = /disabled/.test(e.message) ? "blocked" : e.message; }
      }
      // ESM named imports see the stubs too.
      const esm = await import("node:dgram");
      try { esm.createSocket("udp4"); out.esmNamed = "ALLOWED"; } catch (e) { out.esmNamed = /disabled/.test(e.message) ? "blocked" : e.message; }
      // Locked: can't be put back.
      { let P = process.stdout; while (P && !Object.hasOwn(P, "connect")) P = Object.getPrototypeOf(P); try { P.connect = () => 1; out.relock = "ALLOWED"; } catch { out.relock = P.connect.toString().includes("throw") ? "blocked" : "ALLOWED"; } }
      await new Promise((r) => setTimeout(r, 300));
    `);
    for (const [k, v] of Object.entries(report)) expect([k, v]).toEqual([k, k === "binding" ? "ERR_ACCESS_DENIED" : "blocked"]);
    expect(Object.keys(report)).toHaveLength(23);
    await sleep(300);
    expect(tcpHits).toBe(0);
    expect(udpHits).toBe(0);
  });
});

describe("no Unix sockets through the stdio handles", () => {
  it.runIf(process.platform !== "win32")("connect/bind/listen on process.std*._handle, its prototype and new handles of its class all throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xaq-sock-"));
    const path = join(dir, "s.sock");
    let hits = 0;
    const server = createServer((s) => {
      hits++;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(path, () => r()));
    try {
      const report = await probe(`
        const p = ${JSON.stringify(path)};
        const req = () => ({ oncomplete() {} });
        for (const [name, s] of [["stdin", process.stdin], ["stdout", process.stdout], ["stderr", process.stderr]]) {
          const h = s._handle;
          out[name + "Handle"] = h ? "present" : "none";
          if (!h) continue;
          const proto = Object.getPrototypeOf(h);
          for (const k of ["connect", "connect6", "bind", "bind6", "listen"]) {
            if (!(k in h)) continue;
            for (const [route, f] of [
              ["own", () => h[k](req(), p)],
              ["proto", () => proto[k].call(h, req(), p)],
              ["fresh", () => { const x = new h.constructor(0); return x[k](req(), p); }],
            ]) {
              try { f(); out[name + "." + k + "." + route] = "ALLOWED"; } catch (e) { out[name + "." + k + "." + route] = /disabled/.test(e.message) ? "blocked" : e.message; }
            }
            try { proto[k] = () => 0; out[name + "." + k + ".relock"] = "ALLOWED"; } catch { out[name + "." + k + ".relock"] = "blocked"; }
          }
        }
        await new Promise((r) => setTimeout(r, 300));
      `);
      const checked = Object.entries(report).filter(([k]) => !k.endsWith("Handle"));
      expect(report.stdoutHandle).toBe("present");
      expect(checked.length).toBeGreaterThanOrEqual(12);
      for (const [k, v] of checked) expect([k, v]).toEqual([k, "blocked"]);
      await sleep(200);
      expect(hits).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory", () => {
  it("SIGKILLs a child whose resident memory passes the cap (ArrayBuffers, outside the V8 heap), and remembers the file", async () => {
    const p = hostile("export function run() { const keep = []; for (;;) { const b = new Uint8Array(32 * 1024 * 1024); b.fill(1); keep.push(b); } }", {
      rssLimitBytes: 192 * 1024 * 1024,
      deadlineMs: 15_000,
    });
    const started = Date.now();
    const r = await p.parse(Buffer.from("bomb"), { format: "pdf" });
    expect(r).toMatchObject({ ok: false, reason: "memory" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const again = Date.now();
    expect(await p.parse(Buffer.from("bomb"), { format: "pdf" })).toMatchObject({ ok: false, reason: "memory", message: expect.stringMatching(/before/) });
    expect(Date.now() - again).toBeLessThan(200);
  });

  it("reads resident memory on Linux from /proc and through ps (the macOS path), and picks by platform", async () => {
    expect(rssReaderFor("linux")).toBe(procRss);
    expect(rssReaderFor("darwin")).not.toBe(procRss);
    // ps output parsing, with a fake exec: kB → bytes; garbage and failures → null.
    expect(await psRss(async (file, args) => (file === "/bin/ps" && args.join(" ") === "-o rss= -p 42" ? "  2048\n" : ""))(42)).toBe(2048 * 1024);
    expect(await psRss(async () => "")(42)).toBeNull();
    expect(await psRss(async () => Promise.reject(new Error("no such process")))(42)).toBeNull();
    if (process.platform === "linux") {
      const proc = await procRss(process.pid);
      expect(proc).toBeGreaterThan(10 * 1024 * 1024);
      // The real ps (also on Linux) agrees roughly with /proc.
      const ps = await psRss()(process.pid);
      expect(ps).not.toBeNull();
      expect(Math.abs(ps! - proc!) / proc!).toBeLessThan(0.5);
      expect(await procRss(2 ** 22 + 12345)).toBeNull();
    }
  });

  it("the watchdog works with the ps reader too (as on macOS)", async () => {
    const p = hostile("export function run() { const keep = []; for (;;) { const b = new Uint8Array(32 * 1024 * 1024); b.fill(1); keep.push(b); } }", {
      rssLimitBytes: 192 * 1024 * 1024,
      rssReader: psRss(),
    });
    expect(await p.parse(Buffer.from("bomb-ps"), { format: "pdf" })).toMatchObject({ ok: false, reason: "memory" });
  });

  it.runIf(process.platform === "linux")("sets the child's oom_score_adj to 1000", async () => {
    let score = "";
    const p = hostile("export async function run() { await new Promise((r) => setTimeout(r, 500)); return { ok: false, error: 'done' }; }", {
      onSpawn: (pid) => {
        setTimeout(() => {
          try {
            score = readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim();
          } catch {
            score = "unreadable";
          }
        }, 100);
      },
    });
    await p.parse(Buffer.from("oom"), { format: "csv" });
    expect(score).toBe("1000");
  });
});

describe("failure memory and merging", () => {
  it("remembers a crash while running; doesn't remember a job that only waited in the queue", async () => {
    const crash = hostile("export function run() { process.abort(); }");
    expect(await crash.parse(Buffer.from("c"), { format: "pdf" })).toMatchObject({ ok: false, reason: "crashed" });
    expect(await crash.parse(Buffer.from("c"), { format: "pdf" })).toMatchObject({ ok: false, reason: "crashed", message: expect.stringMatching(/before/) });

    // A job that times out while still queued says nothing about its file: not remembered. (With FIFO and one deadline
    // for all, the queue normally moves first; this drives the queued expiry directly.)
    const slot = hostile("export async function run(input) { if (input.toString() === 'A') await new Promise(() => setInterval(() => {}, 1000)); return { ok: true, result: { format: 'docx', markdown: input.toString(), notes: [] } }; }", {
      concurrency: 1,
      deadlineMs: 5000,
    });
    const a = slot.parse(Buffer.from("A"), { format: "docx" });
    const c = slot.parse(Buffer.from("C"), { format: "docx" });
    const internals = slot as unknown as { queue: { state: string }[]; active: Set<unknown>; expire(job: unknown): void };
    expect(internals.queue.map((j) => j.state)).toEqual(["queued"]);
    internals.expire(internals.queue[0]);
    expect(await c).toMatchObject({ ok: false, reason: "timeout" });
    internals.expire([...internals.active][0]);
    expect(await a).toMatchObject({ ok: false, reason: "timeout" });
    expect(await slot.parse(Buffer.from("A"), { format: "docx" })).toMatchObject({ ok: false, message: expect.stringMatching(/before/) });
    expect(await slot.parse(Buffer.from("C"), { format: "docx" })).toMatchObject({ ok: true, result: { markdown: "C" } });
  });

  it("identical requests in flight share one child", async () => {
    let spawned = 0;
    const p = hostile("export async function run(input) { await new Promise((r) => setTimeout(r, 300)); return { ok: true, result: { format: 'docx', markdown: input.toString(), notes: [] } }; }", {
      onSpawn: () => spawned++,
    });
    const results = await Promise.all([1, 2, 3, 4].map(() => p.parse(Buffer.from("same"), { format: "docx" })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(spawned).toBe(1);
  });
});
