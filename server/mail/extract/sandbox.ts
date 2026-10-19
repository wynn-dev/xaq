// Document parsing out of process. Every attachment is attacker-controlled, and PDF/Office parsers are large; so each
// parse runs in a short-lived child `node` that can't touch the file system, can't start processes or workers, can't
// signal xaq, can't generate code from strings, and is killed at a hard deadline. A worker thread wouldn't do: it
// shares the daemon's file permissions.
//
// The child (exact argv: parserArgs()):
//   process.execPath --permission --no-experimental-sqlite --disallow-code-generation-from-strings
//     --max-old-space-size=<PARSER_HEAP_MB> --import <CHILD_PRELOAD> --input-type=module -e <BOOTSTRAP>
// - `--permission` with NO --allow-* flags: every fs read and write, child_process, worker, addons and WASI are refused.
//   Not even the parser's own file is readable: the daemon reads dist/attachment-parser.js and sends it on stdin, and
//   the bootstrap imports it from a data: URL. (On Node 22 the entry script itself needs a read allow; this needs none.)
// - `--no-experimental-sqlite`: node:sqlite ignores the permission model (server/extensions/host/spawn.ts).
// - CHILD_PRELOAD (shared with code extensions): process.kill/_debugProcess and os.setPriority throw, SIGUSR1 ignored.
// - BOOTSTRAP also disables the network (fetch, WebSocket, net/tls/dgram/http(s)/http2/dns) before loading the parser.
//   Node 25+ refuses the network under --permission anyway (no --allow-net is passed); on 22 and 24 this JS-level block
//   is what stands, and it is defense in depth only: the parser has nothing to send but the attachment's own bytes.
// - The environment is empty (no PATH, HOME, NODE_OPTIONS, XAQ_*), cwd is the file-system root, stdio is three pipes.
// - stdin: [u32 code length][parser code][u32 task length][task JSON][attachment bytes]. stdout: one JSON reply,
//   at most PARSER_OUTPUT_BYTES (more kills the child). stderr: kept (first 4 KB) for the debug log only.
// - Wall clock: PARSER_DEADLINE_MS from the moment the job is queued, then SIGKILL.
//
// On a Node below the code-extension floor (codeExtensionNodeProblem) the permission model has known bypasses: the
// child is still used (weaker isolation, still a separate process with its own heap and deadline), never in-process.
//
// Concurrency mirrors server/mail/pool.ts: at most PARSER_CONCURRENCY children, a bounded queue (overflow fails at
// once), a deadline covering queueing and running, and inputs that timed out remembered so a resend fails fast.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
export const PARSER_OUTPUT_BYTES = 16 * 1024 * 1024;
export const PARSER_CONCURRENCY = 2;
export const PARSER_MAX_QUEUE = 8;
const SLOW_MEMORY = 64;
const STDERR_KEEP = 4096;

/** Runs before the parser code: the network goes, then stdin is framed and the parser imported from a data: URL. */
export const BOOTSTRAP = [
  'const deny=(o,k)=>{try{Object.defineProperty(o,k,{value(){throw new Error("Network access is disabled in the attachment parser")},writable:false,configurable:false})}catch{}};',
  'for(const k of ["fetch","WebSocket","EventSource"])deny(globalThis,k);',
  'const mods={"node:net":["connect","createConnection","createServer"],"node:tls":["connect","createServer"],"node:dgram":["createSocket"],"node:http":["request","get","createServer"],"node:https":["request","get","createServer"],"node:http2":["connect","createServer","createSecureServer"],"node:dns":["lookup","lookupService","resolve","resolve4","resolve6","resolveAny","resolveTxt"]};',
  "for(const[m,ks]of Object.entries(mods)){const o=process.getBuiltinModule(m);for(const k of ks)deny(o,k);if(m===\"node:dns\")for(const k of ks)deny(o.promises,k);}",
  'deny(process.getBuiltinModule("node:net").Socket.prototype,"connect");',
  'process.getBuiltinModule("node:module").syncBuiltinESMExports();',
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
    "--input-type=module",
    "-e",
    BOOTSTRAP,
  ];
}

export type ParseFailure = "timeout" | "crashed" | "busy" | "unreadable" | "unavailable";
export type ParseOutcome = { ok: true; result: Extracted } | { ok: false; reason: ParseFailure; message: string };

export interface ParserOptions {
  deadlineMs?: number;
  concurrency?: number;
  maxQueue?: number;
  heapMb?: number;
  /** The parser code sent to the child (tests swap in hostile code). Default: the built bundle. */
  loadCode?: () => Promise<Buffer>;
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

export class AttachmentParser {
  private queue: Job[] = [];
  private active = new Set<Job>();
  private running = 0;
  private slow = new Set<string>();
  private code: Promise<Buffer> | null = null;
  private closed = false;
  private warnedFloor = false;
  private readonly deadlineMs: number;
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly heapMb: number;
  private readonly loadCode: () => Promise<Buffer>;

  constructor(
    private readonly log: Logger,
    opts: ParserOptions = {},
  ) {
    this.deadlineMs = opts.deadlineMs ?? PARSER_DEADLINE_MS;
    this.concurrency = Math.max(1, opts.concurrency ?? PARSER_CONCURRENCY);
    this.maxQueue = opts.maxQueue ?? PARSER_MAX_QUEUE;
    this.heapMb = opts.heapMb ?? PARSER_HEAP_MB;
    this.loadCode = opts.loadCode ?? defaultCode;
  }

  parse(bytes: Buffer, task: ParseTask): Promise<ParseOutcome> {
    const key = `${task.format}:${createHash("sha256").update(bytes).digest("base64url")}`;
    if (this.closed) return Promise.resolve(fail("unavailable", "The parser is shutting down."));
    if (this.slow.has(key)) return Promise.resolve(fail("timeout", "Reading this file took too long before, so it wasn't tried again."));
    if (this.queue.length >= this.maxQueue) {
      this.log.warn("Attachment parser queue is full", { queued: this.queue.length });
      return Promise.resolve(fail("busy", "Too many attachments are being read right now."));
    }
    return new Promise((resolve) => {
      const job: Job = { bytes, task, key, state: "queued", resolve };
      job.timer = setTimeout(() => this.expire(job), this.deadlineMs);
      job.timer.unref();
      this.queue.push(job);
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queue.splice(0), ...this.active]) {
      job.kill?.();
      this.settle(job, fail("unavailable", "The parser is shutting down."));
    }
  }

  private expire(job: Job): void {
    if (job.state === "done") return;
    this.log.warn("Attachment parsing exceeded its deadline", { deadlineMs: this.deadlineMs, format: job.task.format, state: job.state });
    this.slow.add(job.key);
    if (this.slow.size > SLOW_MEMORY) this.slow.delete(this.slow.values().next().value!);
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
      this.log.warn("Attachment parser could not start", { error: errorMessage(err) });
      this.settle(job, fail("unavailable", "The document parser couldn't start."));
    });
    child.on("close", (exitCode, signal) => {
      if (job.state === "done") return;
      if (overflow) return this.settle(job, fail("unreadable", "The document produced more output than is read."));
      let json: unknown = null;
      try {
        json = JSON.parse(Buffer.concat(out).toString("utf8"));
      } catch {
        json = null;
      }
      if (exitCode !== 0 || json === null) {
        this.log.warn("Attachment parser stopped unexpectedly", { format: job.task.format, exitCode, signal, stderr: errText.replace(/\s+/g, " ").slice(0, 300) });
        return this.settle(job, fail("crashed", "The document parser stopped while reading this file."));
      }
      // The child is not trusted either: its answer must have the expected shape and format.
      const reply = REPLY.safeParse(json);
      if (!reply.success || (reply.data.ok && reply.data.result.format !== job.task.format)) {
        this.log.warn("Attachment parser answered something unexpected", { format: job.task.format });
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
