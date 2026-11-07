// The console's live stream (src/lib/live-stream.ts) against a fake EventSource: it reconnects one that died
// silently (sleep, a network change), retries a refused one with backoff, and comes back at once on wake or online.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type LiveStreamEnv, openLiveStream, SILENT_MS, type StreamState } from "../src/lib/live-stream.ts";

class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    super();
    FakeEventSource.all.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  ping() {
    this.dispatchEvent(new MessageEvent("ping", { data: "ping" }));
  }
  send(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  /** The server answered with an error status: EventSource gives up (CLOSED). */
  refuse() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

const latest = () => FakeEventSource.all.at(-1)!;

function setup() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as "visible" | "hidden" });
  const env = { EventSource: FakeEventSource, window: win, document: doc } as unknown as LiveStreamEnv;
  const states: StreamState[] = [];
  const opens: boolean[] = [];
  const messages: string[] = [];
  const close = openLiveStream("/api/events/stream", { state: (s) => states.push(s), open: (r) => opens.push(r), message: (m) => messages.push(m) }, env);
  const show = () => {
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  return { win, doc, states, opens, messages, close, show };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.all = [];
});
afterEach(() => vi.useRealTimers());

describe("console live stream", () => {
  it("replaces a stream whose pings stopped, and refetches what it missed", () => {
    const s = setup();
    latest().open();
    latest().ping();
    latest().send("a");
    expect(s.messages).toEqual(["a"]);
    // Pings keep it alive.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(20_000);
      latest().ping();
    }
    expect(FakeEventSource.all).toHaveLength(1);
    // The connection dies without an error: no pings, still "open".
    vi.advanceTimersByTime(SILENT_MS + 15_000);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(FakeEventSource.all[0]!.readyState).toBe(FakeEventSource.CLOSED);
    latest().open();
    expect(s.opens).toEqual([false, true]);
    s.close();
  });

  it("reconnects at once when a slept laptop's page is shown again", () => {
    const s = setup();
    latest().open();
    latest().ping();
    // Sleep: the wall clock moves on, timers don't run.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    s.show();
    expect(FakeEventSource.all).toHaveLength(2);
    // A healthy stream is left alone.
    latest().open();
    latest().ping();
    s.show();
    expect(FakeEventSource.all).toHaveLength(2);
    s.close();
  });

  it("reconnects when the browser comes back online", () => {
    const s = setup();
    latest().open();
    latest().ping();
    s.win.dispatchEvent(new Event("online"));
    expect(FakeEventSource.all).toHaveLength(2);
    expect(FakeEventSource.all[0]!.readyState).toBe(FakeEventSource.CLOSED);
    s.close();
  });

  it("never pings out an older server that sends no ping events", () => {
    const s = setup();
    latest().open();
    vi.advanceTimersByTime(10 * 60_000);
    expect(FakeEventSource.all).toHaveLength(1);
    s.close();
  });

  it("retries a refused stream with backoff, and at once when the page is shown", () => {
    const s = setup();
    latest().refuse();
    expect(s.states).toEqual(["offline"]);
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(2);
    latest().refuse();
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(3);
    latest().refuse();
    s.show();
    expect(FakeEventSource.all).toHaveLength(4);
    // The pending backoff retry was replaced, not added to.
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.all).toHaveLength(4);
    latest().open();
    expect(s.states.at(-1)).toBe("open");
    s.close();
  });

  it("stops for good when closed", () => {
    const s = setup();
    latest().open();
    latest().ping();
    s.close();
    expect(latest().readyState).toBe(FakeEventSource.CLOSED);
    vi.advanceTimersByTime(10 * 60_000);
    s.win.dispatchEvent(new Event("online"));
    s.show();
    expect(FakeEventSource.all).toHaveLength(1);
  });
});
