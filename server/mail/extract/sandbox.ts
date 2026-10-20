// Document parsing out of process. Every attachment is attacker-controlled, and PDF/Office parsers are large; so each
// parse runs in a short-lived child `node` that can't touch the file system, can't start processes or workers, can't
// signal xaq, can't generate code from strings, can't reach the network, and is killed at a hard deadline or when its
// memory grows past a cap. A worker thread wouldn't do: it shares the daemon's file permissions and memory.
//
// The child (exact argv: parserArgs()):
//   process.execPath --permission --no-experimental-sqlite --disallow-code-generation-from-strings
//     --max-old-space-size=<PARSER_HEAP_MB> --import <CHILD_PRELOAD> --import <PARSER_PRELOAD>
//     --input-type=module -e <BOOTSTRAP>
// - `--permission` with NO --allow-* flags: every fs read and write, child_process, worker, addons, WASI, the inspector
//   and process.binding are refused. Not even the parser's own file is readable: the daemon reads
//   dist/attachment-parser.js and sends it on stdin, and the bootstrap imports it from a data: URL. (On Node 22 the
//   entry script itself needs a read allow; this needs none.)
// - `--no-experimental-sqlite`: node:sqlite ignores the permission model (server/extensions/host/spawn.ts).
// - CHILD_PRELOAD (shared with code extensions): process.kill/_debugProcess and os.setPriority throw, SIGUSR1 ignored.
// - PARSER_PRELOAD, deny by default before any parser code exists:
//   - every export of net, tls, dns, dns/promises, dgram, http, https and http2 becomes a throwing stub (classes too),
//     and the prototypes that reach the network are locked to throwers (Socket#connect, Server#listen, every
//     dgram.Socket and dns Resolver method, Agent#createConnection), since instances such as process.stdout (a
//     net.Socket) hand out the original classes; fetch, WebSocket and EventSource go too. Node 25+ refuses the network
//     under --permission anyway (no --allow-net is passed); on 22 and 24 this is what stands. (Node has no `undici`
//     builtin: fetch is its only public entry, and it ends in Socket#connect.)
//   - v8.setFlagsFromString throws (it can turn on --allow-natives-syntax).
//   Locked properties are non-writable and non-configurable, and ESM named exports are re-synced.
// - The environment is empty (no PATH, HOME, NODE_OPTIONS, XAQ_*), cwd is the file-system root, stdio is three pipes.
// - stdin: [u32 code length][parser code][u32 task length][task JSON][attachment bytes]. stdout: one JSON reply,
//   at most PARSER_OUTPUT_BYTES (more kills the child). stderr: kept (first 4 KB) for the debug log only.
//
// Limits enforced from the daemon:
// - Wall clock: PARSER_DEADLINE_MS from the moment the job is queued, then SIGKILL.
// - Memory: --max-old-space-size doesn't cover ArrayBuffers (a PDF stream inflating to gigabytes lives there), so the
//   daemon samples the child's resident memory every PARSER_RSS_INTERVAL_MS (Linux: /proc/<pid>/status VmRSS; macOS
//   and others: `ps -o rss= -p <pid>`) and SIGKILLs it above PARSER_RSS_LIMIT_BYTES. On Linux the child's
//   oom_score_adj is also set to 1000, so if the kernel must kill something it picks the child, and xaq's systemd
//   units say OOMPolicy=continue (an OOM-killed child doesn't stop the service).
// - A file whose parse timed out, crashed or was killed for memory while running is remembered (by format and
//   SHA-256) and fails at once next time; identical requests in flight share one child.
//
// On a Node below the code-extension floor (codeExtensionNodeProblem) the permission model has known bypasses: the
// child is still used (weaker isolation, still a separate process with its own deadline and memory cap), never
// in-process. Concurrency mirrors server/mail/pool.ts: at most PARSER_CONCURRENCY children and a bounded queue.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse } from "node:path";
import { z } from "zod";
import type { AppContext } from "../../context.ts";
import { CHILD_PRELOAD, codeExtensionNodeProblem } from "../../extensions/host/spawn.ts";
import { errorMessage } from "../../util/errors.ts";
import type { Logger } from "../../util/log.ts";
import { type Extracted, PARSE_LIMITS, type ParseReply, type ParseTask } from "./types.ts";

export const PARSER_DEADLINE_MS = 20_000;
export const PARSER_HEAP_MB = 256;
export const PARSER_RSS_LIMIT_BYTES = 512 * 1024 * 1024;
export const PARSER_RSS_INTERVAL_MS = 100;
export const PARSER_OUTPUT_BYTES = 16 * 1024 * 1024;
export const PARSER_CONCURRENCY = 2;
export const PARSER_MAX_QUEUE = 8;
const FAILED_MEMORY = 128;
const STDERR_KEEP = 4096;

/** Network deny-by-default and v8 flags, loaded before the bootstrap (see the header). Plain JS, no imports. */
const PARSER_HARDENING = `
// The stdio pipes are created lazily from net.Socket: create them while that's still the real class.
void process.stdin; void process.stdout; void process.stderr;
const NET ="Network access is disabled in the attachment parser";
const get = (m) => process.getBuiltinModule(m);
const thrower = (msg) => { const f = function () { throw new Error(msg); }; return f; };
const lock = (o, k, msg) => { try { Object.defineProperty(o, k, { value: thrower(msg), writable: false, configurable: false, enumerable: true }); } catch {} };
const lockAll = (proto, stopAt) => {
  for (let p = proto; p && p !== Object.prototype && p !== stopAt; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) {
      const d = Object.getOwnPropertyDescriptor(p, k);
      if (k !== "constructor" && d && typeof d.value === "function") lock(p, k, NET);
    }
  }
};
const EE = get("node:events").EventEmitter.prototype;
const net = get("node:net"), tls = get("node:tls"), dgram = get("node:dgram"), dns = get("node:dns"), dnsp = get("node:dns/promises");
const http = get("node:http"), https = get("node:https"), http2 = get("node:http2");
lock(net.Socket.prototype, "connect", NET);
lock(net.Server.prototype, "listen", NET);
lockAll(dgram.Socket.prototype, EE);
lockAll(dns.Resolver.prototype, EE);
lockAll(dnsp.Resolver.prototype, EE);
lock(http.Agent.prototype, "createConnection", NET);
lock(https.Agent.prototype, "createConnection", NET);
for (const mod of [net, tls, dgram, dns, dnsp, dns.promises, http, https, http2]) {
  if (!mod) continue;
  for (const k of Object.getOwnPropertyNames(mod)) {
    const d = Object.getOwnPropertyDescriptor(mod, k);
    if (d && (typeof d.value === "function" || typeof d.get === "function" || (d.value && typeof d.value === "object"))) lock(mod, k, NET);
  }
}
for (const k of ["fetch", "WebSocket", "EventSource"]) lock(globalThis, k, NET);
lock(get("node:v8"), "setFlagsFromString", "v8 flags can't be changed in the attachment parser");
get("node:module").syncBuiltinESMExports();
`;
export const PARSER_PRELOAD = `data:text/javascript,${encodeURIComponent(PARSER_HARDENING)}`;

/** Frames stdin, imports the parser from a data: URL, writes one JSON reply. */
export const BOOTSTRAP = [
  "const chunks=[];for await(const c of process.stdin)chunks.push(c);const buf=Buffer.concat(chunks);",
  "const n=buf.readUInt32BE(0),code=buf.subarray(4,4+n),m=buf.readUInt32BE(4+n),task=JSON.parse(buf.subarray(8+n,8+n+m).toString());",
  "const input=Buffer.from(buf.subarray(8+n+m));chunks.length=0;",
  'let reply;try{const mod=await import("data:text/javascript;base64,"+code.toString("base64"));reply=await mod.run(input,task)}catch(e){reply={ok:false,error:"The file couldn\'t be parsed."}}',
  "process.stdout.write(JSON.stringify(reply),()=>process.exit(0));",
].join("");

/** The child's argv after the Node binary (see the header). */
export function parserArgs(heapMb = PARSER_HEAP_MB): string[] {
  return [
    "--permission",
    "--no-experimental-sqlite",
    "--disallow-code-generation-from-strings",
    `--max-old-space-size=${heapMb}`,
    "--import",
    CHILD_PRELOAD,
    "--import",
    PARSER_PRELOAD,
    "--input-type=module",
    "-e",
    BOOTSTRAP,
  ];
}

// ───────────── Resident memory of a child ─────────────

/** Bytes resident for `pid`, or null when it can't be read (gone, or not supported). */
export type RssReader = (pid: number) => Promise<number | null>;

/** Linux: VmRSS from /proc/<pid>/status (in kB, so the page size doesn't matter). */
export const procRss: RssReader = async (pid) => {
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(await readFile(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
};

type Exec = (file: string, args: string[]) => Promise<string>;
const execText: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2000, env: {}, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

/** macOS (no /proc) and others: `ps -o rss= -p <pid>` (kB), run by the daemon. `exec` is replaceable for tests. */
export const psRss =
  (exec: Exec = execText, ps = "/bin/ps"): RssReader =>
  async (pid) => {
    try {
      const kb = Number.parseInt((await exec(ps, ["-o", "rss=", "-p", String(pid)])).trim(), 10);
      return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : null;
    } catch {
      return null;
    }
  };

export const rssReaderFor = (platform: NodeJS.Platform = process.platform): RssReader => (platform === "linux" ? procRss : psRss());

/** Linux: make the child the kernel OOM killer's first choice. Raising a child's score needs no privilege. */
function preferOomKill(pid: number): void {
  if (process.platform !== "linux") return;
  try {
    writeFileSync(`/proc/${pid}/oom_score_adj`, "1000");
  } catch {
    // Not fatal: the RSS watchdog is the real limit.
  }
}

// ───────────── The parser ─────────────

export type ParseFailure = "timeout" | "crashed" | "memory" | "busy" | "unreadable" | "unavailable";
export type ParseOutcome = { ok: true; result: Extracted } | { ok: false; reason: ParseFailure; message: string };

export interface ParserOptions {
  deadlineMs?: number;
  concurrency?: number;
  maxQueue?: number;
  heapMb?: number;
  rssLimitBytes?: number;
  rssIntervalMs?: number;
  rssReader?: RssReader;
  /** The parser code sent to the child (tests swap in hostile code). Default: the built bundle. */
  loadCode?: () => Promise<Buffer>;
  /** Tests: told each child's pid once it's spawned. */
  onSpawn?: (pid: number) => void;
}

/** Built: dist/attachment-parser.js next to this file's chunk. Source mode: built on first use (bundle.ts). */
async function defaultCode(): Promise<Buffer> {
  if (!import.meta.url.endsWith(".ts")) return readFile(new URL("./attachment-parser.js", import.meta.url));
  const fromEnv = process.env.XAQ_ATTACHMENT_PARSER;
  if (fromEnv) return readFile(fromEnv);
  // A computed specifier: bundle.ts (and the tsdown it loads) must stay out of the build.
  const devOnly = new URL("bundle.ts", import.meta.url).href;
  const { sourceModeBundle } = (await import(devOnly)) as typeof import("./bundle.ts");
  return readFile(await sourceModeBundle());
}

interface Job {
  bytes: Buffer;
  task: ParseTask;
  key: string;
  state: "queued" | "running" | "done";
  timer?: NodeJS.Timeout;
  kill?: () => void;
  resolve(o: ParseOutcome): void;
}

const REMEMBERED: Partial<Record<ParseFailure, string>> = {
  timeout: "Reading this file took too long before, so it wasn't tried again.",
  crashed: "The parser stopped while reading this file before, so it wasn't tried again.",
  memory: "Reading this file needed too much memory before, so it wasn't tried again.",
};

export class AttachmentParser {
  private queue: Job[] = [];
  private active = new Set<Job>();
  private running = 0;
  /** Inputs whose parse failed while running (timeout, crash, memory): key → reason. Insertion-ordered (LRU-ish). */
  private failed = new Map<string, ParseFailure>();
  private inflight = new Map<string, Promise<ParseOutcome>>();
  private code: Promise<Buffer> | null = null;
  private closed = false;
  private warnedFloor = false;
  private readonly deadlineMs: number;
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly heapMb: number;
  private readonly rssLimit: number;
  private readonly rssInterval: number;
  private readonly rss: RssReader;
  private readonly loadCode: () => Promise<Buffer>;
  private readonly onSpawn?: (pid: number) => void;

  constructor(
    private readonly log: Logger,
    opts: ParserOptions = {},
  ) {
    this.deadlineMs = opts.deadlineMs ?? PARSER_DEADLINE_MS;
    this.concurrency = Math.max(1, opts.concurrency ?? PARSER_CONCURRENCY);
    this.maxQueue = opts.maxQueue ?? PARSER_MAX_QUEUE;
    this.heapMb = opts.heapMb ?? PARSER_HEAP_MB;
    this.rssLimit = opts.rssLimitBytes ?? PARSER_RSS_LIMIT_BYTES;
    this.rssInterval = opts.rssIntervalMs ?? PARSER_RSS_INTERVAL_MS;
    this.rss = opts.rssReader ?? rssReaderFor();
    this.loadCode = opts.loadCode ?? defaultCode;
    this.onSpawn = opts.onSpawn;
  }

  parse(bytes: Buffer, task: ParseTask): Promise<ParseOutcome> {
    const key = `${task.format}:${createHash("sha256").update(bytes).digest("base64url")}`;
    if (this.closed) return Promise.resolve(fail("unavailable", "The parser is shutting down."));
    const before = this.failed.get(key);
    if (before) return Promise.resolve(fail(before, REMEMBERED[before] ?? "Reading this file failed before."));
    // The same file asked for again while it's being read: one child, one answer.
    const pending = this.inflight.get(key);
    if (pending) return pending;
    if (this.queue.length >= this.maxQueue) {
      this.log.warn("Attachment parser queue is full", { queued: this.queue.length });
      return Promise.resolve(fail("busy", "Too many attachments are being read right now."));
    }
    const promise = new Promise<ParseOutcome>((resolve) => {
      const job: Job = { bytes, task, key, state: "queued", resolve };
      job.timer = setTimeout(() => this.expire(job), this.deadlineMs);
      job.timer.unref();
      this.queue.push(job);
      this.pump();
    });
    this.inflight.set(key, promise);
    void promise.then(() => this.inflight.delete(key));
    return promise;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queue.splice(0), ...this.active]) {
      job.kill?.();
      this.settle(job, fail("unavailable", "The parser is shutting down."));
    }
  }

  /** Only failures of a running child count: a job that waited too long in the queue says nothing about the file. */
  private remember(job: Job, reason: ParseFailure): void {
    if (job.state !== "running") return;
    this.failed.delete(job.key);
    this.failed.set(job.key, reason);
    if (this.failed.size > FAILED_MEMORY) this.failed.delete(this.failed.keys().next().value!);
  }

  private expire(job: Job): void {
    if (job.state === "done") return;
    this.log.warn("Attachment parsing exceeded its deadline", { deadlineMs: this.deadlineMs, format: job.task.format, state: job.state });
    this.remember(job, "timeout");
    if (job.state === "queued") this.queue.splice(this.queue.indexOf(job), 1);
    job.kill?.();
    this.settle(job, fail("timeout", "Reading this file took too long."));
  }

  private settle(job: Job, outcome: ParseOutcome): void {
    if (job.state === "done") return;
    this.active.delete(job);
    if (job.state === "running") {
      this.running--;
      queueMicrotask(() => this.pump());
    }
    job.state = "done";
    if (job.timer) clearTimeout(job.timer);
    job.resolve(outcome);
  }

  private pump(): void {
    while (!this.closed && this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      job.state = "running";
      this.running++;
      this.active.add(job);
      void this.start(job);
    }
  }

  private async start(job: Job): Promise<void> {
    let code: Buffer;
    try {
      this.code ??= this.loadCode();
      code = await this.code;
    } catch (err) {
      this.code = null;
      this.log.warn("Attachment parser code could not be loaded", { error: errorMessage(err) });
      return this.settle(job, fail("unavailable", "The document parser isn't available."));
    }
    if (job.state === "done") return;
    const floor = codeExtensionNodeProblem();
    if (floor && !this.warnedFloor) {
      this.warnedFloor = true;
      this.log.warn("This Node release has known permission-model bypasses; attachment parsing runs with weaker isolation", { node: process.versions.node });
    }
    let child;
    try {
      child = spawn(process.execPath, parserArgs(this.heapMb), {
        cwd: parse(process.execPath).root,
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      this.log.warn("Attachment parser could not start", { error: errorMessage(err) });
      return this.settle(job, fail("unavailable", "The document parser couldn't start."));
    }
    job.kill = () => child.kill("SIGKILL");
    const pid = child.pid;
    let overMemory = false;
    let watchdog: NodeJS.Timeout | undefined;
    if (pid !== undefined) {
      preferOomKill(pid);
      this.onSpawn?.(pid);
      let sampling = false;
      watchdog = setInterval(() => {
        if (sampling || job.state !== "running") return;
        sampling = true;
        void this.rss(pid)
          .then((bytes) => {
            if (bytes !== null && bytes > this.rssLimit && job.state === "running" && child.exitCode === null) {
              overMemory = true;
              this.log.warn("Attachment parser killed: too much memory", { format: job.task.format, rssMb: Math.round(bytes / 1048576) });
              child.kill("SIGKILL");
            }
          })
          .finally(() => (sampling = false));
      }, this.rssInterval);
      watchdog.unref();
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let errText = "";
    let overflow = false;
    child.stdout.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > PARSER_OUTPUT_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (errText.length < STDERR_KEEP) errText += d.toString("utf8").slice(0, STDERR_KEEP - errText.length);
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (err) => {
      if (watchdog) clearInterval(watchdog);
      this.log.warn("Attachment parser could not start", { error: errorMessage(err) });
      this.settle(job, fail("unavailable", "The document parser couldn't start."));
    });
    child.on("close", (exitCode, signal) => {
      if (watchdog) clearInterval(watchdog);
      if (job.state === "done") return;
      if (overMemory) {
        this.remember(job, "memory");
        return this.settle(job, fail("memory", "Reading this file needed too much memory."));
      }
      if (overflow) return this.settle(job, fail("unreadable", "The document produced more output than is read."));
      let json: unknown = null;
      try {
        json = JSON.parse(Buffer.concat(out).toString("utf8"));
      } catch {
        json = null;
      }
      if (exitCode !== 0 || json === null) {
        this.log.warn("Attachment parser stopped unexpectedly", { format: job.task.format, exitCode, signal, stderr: errText.replace(/\s+/g, " ").slice(0, 300) });
        this.remember(job, "crashed");
        return this.settle(job, fail("crashed", "The document parser stopped while reading this file."));
      }
      // The child is not trusted either: its answer must have the expected shape and format.
      const reply = REPLY.safeParse(json);
      if (!reply.success || (reply.data.ok && reply.data.result.format !== job.task.format)) {
        this.log.warn("Attachment parser answered something unexpected", { format: job.task.format });
        this.remember(job, "crashed");
        return this.settle(job, fail("crashed", "The document parser answered something unexpected."));
      }
      const r = reply.data as ParseReply;
      if (!r.ok) return this.settle(job, fail("unreadable", r.error.slice(0, 300)));
      this.settle(job, { ok: true, result: r.result });
    });
    const head = Buffer.alloc(4);
    head.writeUInt32BE(code.length);
    const task = Buffer.from(JSON.stringify(job.task));
    const taskHead = Buffer.alloc(4);
    taskHead.writeUInt32BE(task.length);
    child.stdin.end(Buffer.concat([head, code, taskHead, task, job.bytes]));
  }
}

const fail = (reason: ParseFailure, message: string): ParseOutcome => ({ ok: false, reason, message });

const text = z.string().max(PARSE_LIMITS.textChars + 100_000);
const n = z.number().int().min(0).max(10_000_000);
const extras = { notes: z.array(z.string().max(500)).max(20), hiddenChars: n.optional() };
const SHEET = z.object({ name: z.string().max(PARSE_LIMITS.cellChars), rows: z.array(z.array(z.string().max(PARSE_LIMITS.cellChars))).max(PARSE_LIMITS.rows), totalRows: n, totalCols: n });
const EXTRACTED = z.discriminatedUnion("format", [
  z.object({ format: z.literal("pdf"), totalPages: n, pages: z.array(z.object({ n, text })).max(PARSE_LIMITS.pdfPages), ...extras }),
  z.object({ format: z.literal("docx"), markdown: text, ...extras }),
  z.object({ format: z.enum(["xlsx", "csv"]), sheets: z.array(SHEET).max(PARSE_LIMITS.sheets), totalSheets: n, ...extras }),
  z.object({ format: z.literal("pptx"), totalSlides: n, slides: z.array(z.object({ n, text, notes: text })).max(PARSE_LIMITS.slides), ...extras }),
]);
const REPLY = z.union([z.object({ ok: z.literal(true), result: EXTRACTED }), z.object({ ok: z.literal(false), error: z.string().max(2000) })]);

const parsers = new WeakMap<AppContext, AttachmentParser>();

/** The context's parser, created lazily (no process until an attachment is first parsed). */
export function attachmentParser(ctx: AppContext): AttachmentParser {
  let p = parsers.get(ctx);
  if (!p) parsers.set(ctx, (p = new AttachmentParser(ctx.log.child("attachments"))));
  return p;
}

/** Tests: a parser with other options (deadline, hostile code). */
export function setAttachmentParser(ctx: AppContext, parser: AttachmentParser): void {
  parsers.set(ctx, parser);
}

export async function closeAttachmentParser(ctx: AppContext): Promise<void> {
  const p = parsers.get(ctx);
  parsers.delete(ctx);
  await p?.close();
}
