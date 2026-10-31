// Content cleaning runs in worker threads with a hard deadline. Any sender controls the HTML being parsed
// and converted, and synchronous CPU work can't be interrupted by a timeout on the main thread, so a
// pathological message must never be able to block the event loop (MCP calls, listeners, the console).
//
// - The deadline covers queueing and running: a job not done in time resolves with its fallback (cleaned
//   text/plain part or a notice); a worker still running it is terminated and replaced.
// - The queue is bounded; overflow resolves with the fallback at once.
// - Inputs that already timed out are remembered (small LRU) and go straight to the fallback.
// - Two lanes: interactive (MCP reads) always has a worker; background (listener bodies) may use all but one.

import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { AppContext } from "../context.ts";
import type { ParsedMessage } from "../google/types.ts";
import { errorMessage } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { type BuiltContent, buildContent, fallbackContent, htmlToMarkdown, stripInvisible } from "./content.ts";
import type { ContentReply, ContentTask } from "./content-worker.ts";

/** Source mode (tsx/vitest) loads the .ts worker; the build emits dist/content-worker.js next to dist/cli.js. */
const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./content-worker.ts" : "./content-worker.js", import.meta.url);

export const CONTENT_DEADLINE_MS = 2_000;
const POOL_SIZE = 2;
const MAX_QUEUE = 32;
const SLOW_MEMORY = 256;
/** Workers that die before becoming ready this many times in a row: clean in-process instead. */
const MAX_START_FAILURES = 2;

export type Lane = "interactive" | "background";
type ContentOpts = { accountEmail: string; maxChars: number };
type TaskInput =
  | { kind: "content"; parsed: ParsedMessage; opts: ContentOpts }
  | { kind: "html"; html: string }
  | { kind: "text"; text: string };

interface Job {
  task: ContentTask;
  lane: Lane;
  /** Identifies the input, to remember ones that timed out. */
  key: string;
  state: "queued" | "running" | "done";
  slot?: Slot;
  timer?: NodeJS.Timeout;
  resolve(value: unknown): void;
  fallback(): unknown;
  inline(): unknown;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  job: Job | null;
}

export interface PoolOptions {
  size?: number;
  deadlineMs?: number;
  maxQueue?: number;
  workerUrl?: URL;
}

const digest = (s: string) => createHash("sha1").update(s).digest("base64url");

export class ContentPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  private startFailures = 0;
  /** Inputs that hit the deadline before (insertion-ordered for LRU eviction). */
  private slow = new Set<string>();
  /** Workers can't start in this environment: clean in-process (bounded only by the content caps). */
  private inline = false;
  private closed = false;
  private readonly size: number;
  private readonly deadlineMs: number;
  private readonly maxQueue: number;
  private readonly workerUrl: URL;

  constructor(
    private readonly log: Logger,
    opts: PoolOptions = {},
  ) {
    this.size = Math.max(1, opts.size ?? POOL_SIZE);
    this.deadlineMs = opts.deadlineMs ?? CONTENT_DEADLINE_MS;
    this.maxQueue = opts.maxQueue ?? MAX_QUEUE;
    this.workerUrl = opts.workerUrl ?? WORKER_URL;
  }

  /** Cleaned content for a parsed message; the fallback when it can't be done within the deadline. */
  content(parsed: ParsedMessage, opts: ContentOpts, lane: Lane = "interactive"): Promise<BuiltContent> {
    const key = `c:${parsed.summary.id}:${digest(parsed.html ?? "")}`;
    return this.run(
      { kind: "content", parsed, opts },
      key,
      lane,
      () => fallbackContent(parsed, opts),
      () => buildContent(parsed, opts),
    ) as Promise<BuiltContent>;
  }

  /** HTML → cleaned markdown (HTML attachments). */
  html(html: string, lane: Lane = "interactive"): Promise<{ markdown: string; removed: number }> {
    return this.run(
      { kind: "html", html },
      `h:${digest(html)}`,
      lane,
      () => ({ markdown: "[This HTML is too complex to display safely.]", removed: 0 }),
      () => htmlToMarkdown(html),
    ) as Promise<{ markdown: string; removed: number }>;
  }

  /** Invisible-character cleaning of a text attachment. */
  text(text: string, lane: Lane = "interactive"): Promise<string> {
    return this.run(
      { kind: "text", text },
      `t:${digest(text)}`,
      lane,
      () => "[This text is too complex to display safely.]",
      () => stripInvisible(text).text,
    ) as Promise<string>;
  }

  async close(): Promise<void> {
    this.closed = true;
    const slots = this.slots;
    this.slots = [];
    for (const job of this.queue.splice(0)) this.settle(job, null);
    for (const slot of slots) if (slot.job) this.settle(slot.job, null);
    await Promise.all(slots.map((s) => s.worker.terminate().catch(() => 0)));
  }

  private run(input: TaskInput, key: string, lane: Lane, fallback: () => unknown, inline: () => unknown): Promise<unknown> {
    if (this.inline) return Promise.resolve().then(inline);
    if (this.closed || this.slow.has(key)) return Promise.resolve().then(fallback);
    if (this.queue.length >= this.maxQueue) {
      this.log.warn("Content cleaning queue is full; using the fallback", { queued: this.queue.length });
      return Promise.resolve().then(fallback);
    }
    return new Promise((resolve) => {
      const job: Job = { task: { ...input, id: this.nextId++ } as ContentTask, lane, key, state: "queued", resolve, fallback, inline };
      job.timer = setTimeout(() => this.expire(job), this.deadlineMs);
      job.timer.unref();
      this.queue.push(job);
      this.pump();
    });
  }

  /** The deadline passed (queued or running): fall back, remember the input, recycle a busy worker. */
  private expire(job: Job): void {
    if (job.state === "done") return;
    this.log.warn("Content cleaning exceeded its deadline", { deadlineMs: this.deadlineMs, kind: job.task.kind, state: job.state });
    this.slow.add(job.key);
    if (this.slow.size > SLOW_MEMORY) this.slow.delete(this.slow.values().next().value!);
    if (job.state === "queued") {
      this.queue.splice(this.queue.indexOf(job), 1);
    } else if (job.slot) {
      const slot = job.slot;
      this.remove(slot);
      slot.job = null;
      void slot.worker.terminate().catch(() => 0);
    }
    this.settle(job, null);
    this.pump();
  }

  private settle(job: Job, value: unknown): void {
    if (job.state === "done") return;
    job.state = "done";
    if (job.timer) clearTimeout(job.timer);
    let result = value;
    if (result === null || result === undefined) {
      try {
        result = job.fallback();
      } catch {
        result = null;
      }
    }
    job.resolve(result);
  }

  /** Next job for a free worker: interactive first; background never takes the last free worker. */
  private nextJob(): Job | undefined {
    const interactive = this.queue.findIndex((j) => j.lane === "interactive");
    if (interactive >= 0) return this.queue.splice(interactive, 1)[0];
    const busyBackground = this.slots.filter((s) => s.job?.lane === "background").length;
    if (this.size > 1 && busyBackground >= this.size - 1) return undefined;
    const background = this.queue.findIndex((j) => j.lane === "background");
    return background >= 0 ? this.queue.splice(background, 1)[0] : undefined;
  }

  private pump(): void {
    if (this.inline) {
      for (const job of this.queue.splice(0)) {
        try {
          this.settle(job, job.inline());
        } catch {
          this.settle(job, null);
        }
      }
      return;
    }
    while (this.queue.length) {
      const slot = this.slots.find((s) => s.ready && !s.job);
      if (!slot) {
        if (this.slots.length < this.size && !this.closed && !this.slots.some((s) => !s.ready)) this.spawn();
        return;
      }
      const job = this.nextJob();
      if (!job) return;
      job.state = "running";
      job.slot = slot;
      slot.job = job;
      slot.worker.postMessage(job.task);
    }
  }

  private spawn(): void {
    let worker: Worker;
    try {
      worker = new Worker(this.workerUrl, { resourceLimits: { maxOldGenerationSizeMb: 256 } });
    } catch (err) {
      this.startFailed(err);
      return;
    }
    worker.unref();
    const slot: Slot = { worker, ready: false, job: null };
    this.slots.push(slot);
    worker.on("message", (m: ContentReply) => {
      if ("ready" in m) {
        slot.ready = true;
        this.startFailures = 0;
        this.pump();
        return;
      }
      const job = slot.job;
      if (!job || job.task.id !== m.id) return;
      slot.job = null;
      if (!m.ok) this.log.debug("Content cleaning failed in worker", { error: m.error });
      this.settle(job, m.ok ? m.result : null);
      this.pump();
    });
    worker.on("error", (err) => this.lost(slot, err));
    worker.on("exit", (code) => this.lost(slot, new Error(`content worker exited with code ${code}`)));
  }

  private remove(slot: Slot): boolean {
    const i = this.slots.indexOf(slot);
    if (i < 0) return false;
    this.slots.splice(i, 1);
    return true;
  }

  private lost(slot: Slot, err: unknown): void {
    if (!this.remove(slot)) return;
    if (slot.job) this.settle(slot.job, null);
    slot.job = null;
    if (this.closed) return;
    if (!slot.ready) this.startFailed(err);
    else this.log.warn("Content worker stopped unexpectedly; it will be replaced", { error: errorMessage(err) });
    this.pump();
  }

  private startFailed(err: unknown): void {
    if (++this.startFailures < MAX_START_FAILURES) return;
    this.inline = true;
    this.log.warn("Content worker could not start; cleaning content in-process", { error: errorMessage(err) });
  }
}

const pools = new WeakMap<AppContext, ContentPool>();

/** The context's pool, created lazily (no threads until content is first cleaned). */
export function contentPool(ctx: AppContext): ContentPool {
  let pool = pools.get(ctx);
  if (!pool) pools.set(ctx, (pool = new ContentPool(ctx.log.child("content"))));
  return pool;
}

export async function closeContentPool(ctx: AppContext): Promise<void> {
  const pool = pools.get(ctx);
  pools.delete(ctx);
  await pool?.close();
}
