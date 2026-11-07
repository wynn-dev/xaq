export type StreamState = "connecting" | "open" | "reconnecting" | "offline";

/** The server pings every 20 s (server/api/events.ts): a stream silent for this long has died without a word. */
export const SILENT_MS = 45_000;
const CHECK_MS = 15_000;
const MAX_RETRY_MS = 30_000;

export interface LiveStreamHandlers {
  state(state: StreamState): void;
  /** A connection opened; `resumed` when it replaces an earlier one, so messages may have been missed. */
  open(resumed: boolean): void;
  message(data: string): void;
}

/** The browser's (tests pass fakes). */
export interface LiveStreamEnv {
  EventSource: typeof EventSource;
  window: EventTarget;
  document: EventTarget & { readonly visibilityState: string };
}

/**
 * Keeps one EventSource on `url` open; returns a function that closes it for good.
 *
 * EventSource retries a dropped connection itself, but not one the server refused (CLOSED): that is retried
 * here with backoff, and at once when the page is shown again. A connection can also die silently (the laptop
 * slept, the network changed, a NAT forgot it) and look open for many minutes: once the server's pings are seen,
 * one silent past SILENT_MS is replaced, and coming back online always reconnects. An older server that only
 * sends comments is never pinged out.
 */
export function openLiveStream(url: string, on: LiveStreamHandlers, env: LiveStreamEnv): () => void {
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let everOpened = false;
  // Wall clock (it keeps counting through sleep) of the last message or ping; null until the first ping.
  let lastSeen: number | null = null;

  const connect = () => {
    clearTimeout(retryTimer);
    es?.close();
    lastSeen = null;
    const source = new env.EventSource(url, { withCredentials: true });
    es = source;
    source.onopen = () => {
      on.open(everOpened);
      everOpened = true;
      attempt = 0;
      on.state("open");
    };
    source.addEventListener("ping", () => (lastSeen = Date.now()));
    source.onmessage = (e) => {
      if (lastSeen !== null) lastSeen = Date.now();
      on.message(e.data as string);
    };
    source.onerror = () => {
      if (source.readyState !== env.EventSource.CLOSED) return on.state("reconnecting");
      source.close();
      on.state(everOpened ? "reconnecting" : "offline");
      retryTimer = setTimeout(connect, Math.min(MAX_RETRY_MS, 1000 * 2 ** attempt++));
    };
  };
  const silent = () => lastSeen !== null && Date.now() - lastSeen > SILENT_MS;
  const reconnectNow = () => {
    attempt = 0;
    connect();
  };

  const onVisible = () => {
    if (env.document.visibilityState === "visible" && (!es || es.readyState === env.EventSource.CLOSED || silent())) reconnectNow();
  };
  const check = setInterval(() => silent() && reconnectNow(), CHECK_MS);
  env.document.addEventListener("visibilitychange", onVisible);
  env.window.addEventListener("online", reconnectNow);
  connect();

  return () => {
    clearInterval(check);
    clearTimeout(retryTimer);
    env.document.removeEventListener("visibilitychange", onVisible);
    env.window.removeEventListener("online", reconnectNow);
    es?.close();
  };
}
