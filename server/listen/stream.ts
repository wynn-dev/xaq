import { networkInterfaces } from "node:os";
import type { EventType } from "../../shared/types.ts";
import { abortable } from "./abortable.ts";
import { apiError, clientHeader, describeFetchError, userAgent } from "./api.ts";
import { SseParser, type SseMessage } from "./sse.ts";
import { safeText } from "./ui.ts";

export type StreamEnd = { kind: "revoked"; code: string; reason: string } | { kind: "fatal"; reason: string } | { kind: "stopped" };

/**
 * Why the daemon refused or ended the stream. Permanent ones end the listener (exit 78); reversible
 * ones (an admin disabled the agent, or took away its last read grant) keep it waiting.
 */
export const REFUSALS: Record<string, { permanent: boolean; text: string }> = {
  agent_deleted: { permanent: true, text: "This agent was deleted in the xaq console." },
  key_rotated: { permanent: true, text: "This agent's API key was replaced (rotated) in the console." },
  unauthorized: { permanent: true, text: "The daemon doesn't recognize this API key (it was rotated, or the agent was deleted)." },
  agent_disabled: { permanent: false, text: "An admin disabled this agent. Waiting; it resumes on its own when the agent is re-enabled." },
  no_read_grant: { permanent: false, text: "This agent has no read access to any mailbox or calendar right now. Waiting; it resumes when an admin grants read or calendar.read." },
  forbidden: { permanent: false, text: "The daemon refused access for now. Waiting and retrying." },
};

/** Classifies an HTTP refusal or a `revoked` reason code. 401 is permanent; 403 is reversible unless its code says otherwise. */
export function classifyRefusal(code: string | null, status?: number): { code: string; permanent: boolean; text: string } {
  const known = code && REFUSALS[code] ? code : status === 401 ? "unauthorized" : status === 403 ? "forbidden" : code ? null : "unauthorized";
  if (known) return { code: known, ...REFUSALS[known]! };
  // An unknown `revoked` reason: assume permanent (that's what the event means), but show it.
  return { code: code!, permanent: true, text: `Access revoked (${code}).` };
}

const BLOCKED_RETRY_MS = 60_000;

export interface StreamOptions {
  url: string;
  apiKey: string;
  consumer: string;
  types?: EventType[];
  includeBody?: boolean;
  /** `after=<seq>` on every connect (dry runs start at the current head). */
  after?: number;
  /** Ask the daemon to start a new consumer at the oldest event (`start=beginning`) instead of the head. */
  fromStart?: boolean;
  /** Highest seq received so far, sent as Last-Event-ID on reconnect (0 = let the server cursor decide). */
  lastEventId: () => number;
  onOpen: () => void;
  onMessage: (m: SseMessage) => void;
  /** Connection lost / failed; reconnecting after `retryInMs`. */
  onDisconnect: (reason: string, retryInMs: number, opts: { serious: boolean }) => void;
  /** Reversible refusal (agent disabled, no read grant): the stream keeps retrying slowly. */
  onBlocked?: (code: string, text: string) => void;
  /** Wait between attempts while blocked (default 60 s). */
  blockedRetryMs?: number;
  /** Runs before every connection attempt; a returned reason refuses this attempt (re-checked transport). */
  beforeConnect?: () => Promise<string | null>;
  /** True while the local backlog is too large: the stream disconnects and resumes once it drains. */
  shouldPause?: () => boolean;
  /** Silence (no events, no pings) after which the connection is presumed dead. The server pings every 15 s. */
  stallMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Tests: the fetch implementation (default: global fetch). */
  fetch?: typeof fetch;
  /** Tests: this machine's network addresses (default: localAddresses). */
  addresses?: () => string;
}

/**
 * This machine's routable addresses. When they change (another wifi, a VPN, a cable, the network coming
 * back), the open connection is stranded or a backoff wait is pointless: reconnect instead of waiting for the stall.
 */
export const localAddresses = (): string =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal && !a.address.startsWith("fe80:"))
    .map((a) => a!.address)
    .sort()
    .join(",");


class Stalled extends Error {}
class Paused extends Error {}
class Reconnect extends Error {}

const sleepJump = 20_000;

/**
 * Holds the outbound event stream open forever: reconnects with jittered exponential backoff,
 * resumes with Last-Event-ID (the server also resumes from the consumer's acked cursor), treats
 * ~45 s of silence as a dead connection, and reconnects at once after the machine wakes from sleep or
 * its network addresses change.
 * Only permanent revocation (401, or `event: revoked` for a deleted agent or replaced key) and
 * unrecoverable request errors end it; a disabled agent or a missing read grant just waits.
 */
export class EventStream {
  private stopped = false;
  private current: AbortController | null = null;
  private wake: (() => void) | null = null;
  private failures = 0;

  constructor(private readonly o: StreamOptions) {}

  stop(): void {
    this.stopped = true;
    this.current?.abort();
    this.wake?.();
  }

  /** Forces a reconnect now (network change, wake from sleep). */
  reconnect(): void {
    this.failures = 0;
    this.current?.abort(new Reconnect("reconnect requested"));
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    // stop() may have come while we weren't sleeping (its wake-up went to an earlier sleep).
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = done;
    });
  }

  private backoff(): number {
    const min = this.o.minBackoffMs ?? 1000;
    const max = this.o.maxBackoffMs ?? 60_000;
    const cap = Math.min(max, min * 2 ** Math.min(this.failures, 16));
    // Full jitter, but never below `min`, so a fleet of laptops waking together doesn't stampede.
    return Math.round(min + Math.random() * (cap - min));
  }

  private streamUrl(): string {
    const u = new URL(`${this.o.url}/agent/v1/events/stream`);
    u.searchParams.set("consumer", this.o.consumer);
    if (this.o.types?.length) u.searchParams.set("types", this.o.types.join(","));
    if (this.o.includeBody) u.searchParams.set("include_body", "1");
    if (this.o.fromStart) u.searchParams.set("start", "beginning");
    if (this.o.after) u.searchParams.set("after", String(this.o.after));
    return u.toString();
  }

  async run(): Promise<StreamEnd> {
    // Laptop sleep: timers stall while suspended, so a big jump in wall-clock time means we just woke up.
    let lastTick = Date.now();
    const addresses = this.o.addresses ?? localAddresses;
    let lastAddresses = addresses();
    const sleepWatch = setInterval(() => {
      const now = Date.now();
      const current = addresses();
      if (now - lastTick > sleepJump || current !== lastAddresses) this.reconnect();
      lastTick = now;
      lastAddresses = current;
    }, 5000);
    sleepWatch.unref();
    try {
      while (!this.stopped) {
        while (this.o.shouldPause?.() && !this.stopped) await this.sleep(250);
        if (this.stopped) break;
        const result = await this.connectOnce();
        if (result) return result;
      }
      return { kind: "stopped" };
    } finally {
      clearInterval(sleepWatch);
    }
  }

  /** One connection. Returns a terminal result, or null to reconnect (after waiting, unless paused). */
  private async connectOnce(): Promise<StreamEnd | null> {
    const ac = new AbortController();
    this.current = ac;
    const stallMs = this.o.stallMs ?? 45_000;
    let stallTimer: NodeJS.Timeout | undefined;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => ac.abort(new Stalled(`no data or ping for ${Math.round(stallMs / 1000)} s`)), stallMs);
    };
    const opened = Date.now();
    let delivered = false;
    let revoked: string | null = null;

    try {
      const refused = await this.o.beforeConnect?.();
      if (refused) {
        this.failures++;
        const wait = Math.max(this.backoff(), 30_000);
        this.disconnected(refused, wait, true);
        await this.sleep(wait);
        return null;
      }
      const headers: Record<string, string> = {
        accept: "text/event-stream",
        authorization: `Bearer ${this.o.apiKey}`,
        "cache-control": "no-cache",
        "user-agent": userAgent(),
        "x-agentinbox-client": clientHeader(),
      };
      const last = this.o.lastEventId();
      if (last > 0) headers["last-event-id"] = String(last);
      armStall();
      const pending = (this.o.fetch ?? fetch)(this.streamUrl(), { headers, signal: ac.signal, redirect: "error" });
      // If abort wins, release whatever the fetch still produces.
      pending.then((r) => (ac.signal.aborted ? r.body?.cancel().catch(() => {}) : undefined)).catch(() => {});
      const res = await abortable(pending, ac.signal);
      if (!res.ok) {
        const err = await abortable(apiError(res, "Opening the event stream"), ac.signal);
        if (res.status === 401 || res.status === 403) {
          const r = classifyRefusal(err.code, res.status);
          if (r.permanent) return { kind: "revoked", code: r.code, reason: r.text };
          clearTimeout(stallTimer);
          this.o.onBlocked?.(r.code, r.text);
          await this.sleep(this.o.blockedRetryMs ?? BLOCKED_RETRY_MS);
          return null;
        }
        if (res.status === 400 || res.status === 422) return { kind: "fatal", reason: err.message };
        clearTimeout(stallTimer);
        const longWait = res.status === 404 ? 300_000 : null;
        if (res.status === 404) {
          this.disconnected("This xaq server has no /agent/v1 event stream (upgrade the daemon). Retrying in 5 minutes", longWait!, true);
          await this.sleep(longWait!);
        } else {
          this.failures++;
          const wait = err.retryAfter ? err.retryAfter * 1000 : this.backoff();
          this.disconnected(err.message, wait, res.status >= 500 || res.status === 429 ? false : true);
          await this.sleep(wait);
        }
        return null;
      }
      if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
        throw new Error(`expected text/event-stream, got ${res.headers.get("content-type") ?? "no content type"}`);
      }
      this.o.onOpen();
      armStall();

      const parser = new SseParser(
        (m) => {
          if (m.event === "revoked") {
            let reason = "unauthorized";
            try {
              const r = (JSON.parse(m.data) as { reason?: unknown }).reason;
              if (typeof r === "string" && r) reason = safeText(r, 60);
            } catch {
              // Keep the default.
            }
            revoked = reason;
            ac.abort();
            return;
          }
          delivered = true;
          this.o.onMessage(m);
          if (this.o.shouldPause?.()) ac.abort(new Paused("backlog full"));
        },
        () => {},
      );
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      // Cancel the body on abort (stop, stall, pause, reconnect, revoked), and never wait on a read
      // that undici fails to settle.
      const cancel = () => void reader.cancel().catch(() => {});
      ac.signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          const { done, value } = await abortable(reader.read(), ac.signal);
          if (done) break;
          armStall();
          parser.push(decoder.decode(value, { stream: true }));
          if (revoked !== null) break;
        }
      } finally {
        ac.signal.removeEventListener("abort", cancel);
        cancel();
      }
      if (revoked !== null) return this.afterRevoked(revoked);
      throw new Error("the server closed the stream");
    } catch (err) {
      if (revoked !== null) return this.afterRevoked(revoked);
      if (this.stopped) return { kind: "stopped" };
      const reason = ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : err;
      if (reason instanceof Paused) return null;
      // A connection that was healthy for a while (or delivered events) starts the backoff over.
      if (delivered || Date.now() - opened > 60_000) this.failures = 0;
      if (reason instanceof Reconnect) {
        this.disconnected("reconnecting (network change or wake from sleep)", 0, false);
        return null;
      }
      this.failures++;
      const wait = this.backoff();
      const text = reason instanceof Stalled ? `stream stalled (${reason.message})` : describeFetchError(reason);
      this.disconnected(text, wait, this.failures > 3);
      await this.sleep(wait);
      return null;
    } finally {
      clearTimeout(stallTimer);
      ac.abort();
      this.current = null;
    }
  }

  /** `event: revoked`: permanent reasons end the listener; reversible ones wait and retry. */
  private async afterRevoked(code: string): Promise<StreamEnd | null> {
    const r = classifyRefusal(code);
    if (r.permanent) return { kind: "revoked", code: r.code, reason: r.text };
    this.o.onBlocked?.(r.code, r.text);
    await this.sleep(this.o.blockedRetryMs ?? BLOCKED_RETRY_MS);
    return null;
  }

  private disconnected(reason: string, wait: number, serious: boolean): void {
    if (!this.stopped) this.o.onDisconnect(reason, wait, { serious });
  }
}
