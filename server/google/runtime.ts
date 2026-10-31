import type { GmailLabel } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import {
  backoffMs,
  buildUrl,
  errorFromResponse,
  isAbortError,
  isRetryable,
  MAX_ATTEMPTS,
  readBodyCapped,
  ResponseTooLargeError,
  networkError,
  OUTCOME_UNKNOWN,
  type Query,
  rejectedBeforeProcessing,
  REQUEST_TIMEOUT_MS,
  sleep,
  TokenBucket,
} from "./http.ts";
import { TokenManager } from "./tokens.ts";
import { GoogleApiError } from "./types.ts";

export interface RequestOptions {
  method?: string;
  query?: Query;
  /** JSON body. */
  body?: unknown;
  /** Non-JSON body (media uploads), sent as is; mutually exclusive with `body`. */
  rawBody?: { contentType: string; data: Uint8Array };
  /** Gmail quota units charged to the account's token bucket (0 = not throttled). */
  cost?: number;
  signal?: AbortSignal;
  /**
   * false for requests that must not run twice (messages.send, drafts.send, drafts.create): they are
   * only retried when Google provably rejected them before processing (429, 403 rate limit, 401,
   * connection refused), never after a 5xx, a timeout or a dropped connection.
   */
  idempotent?: boolean;
  /** Per-attempt timeout; 0 disables it. */
  timeoutMs?: number;
  /** Extra request headers (e.g. Calendar's If-Match). */
  headers?: Record<string, string>;
  /** For non-idempotent requests: what may have happened when the outcome is unknown (default: a Gmail send). */
  ambiguousHint?: string;
  /** Return the body as a Buffer (media downloads such as Drive's alt=media) instead of parsed JSON. */
  binary?: boolean;
  /**
   * Refuse a successful response longer than this many bytes with ResponseTooLargeError (not retried),
   * without reading past the limit.
   */
  maxResponseBytes?: number;
  /**
   * The bearer token to use instead of the account's full access token, e.g. a downscoped one
   * (server/google/scoped.ts googleAccessToken). Called with `force` true once after a 401, for a fresh one.
   */
  token?: (force: boolean) => Promise<string>;
}

/**
 * Per-context shared state for server/google and server/ingest: token manager, quota buckets, label
 * cache and test-email rate limits. Keyed by the AppContext so every service sees the same instance.
 */
export class GoogleRuntime {
  readonly tokens: TokenManager;
  readonly labelCache = new Map<string, { at: number; labels: GmailLabel[] }>();
  /** accountId → send times (ms) of recent test emails, for the rate limit. */
  readonly testEmails = new Map<string, number[]>();
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(ctx: AppContext) {
    this.tokens = new TokenManager(ctx);
  }

  /**
   * Authenticated JSON request as `accountId`. Throttles by quota cost, retries 429/5xx/403 rate
   * limits, timeouts and network errors with backoff (see `idempotent`), refreshes the token once on 401.
   */
  async request<T>(accountId: string, base: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = buildUrl(base, path, opts.query);
    const method = opts.method ?? "GET";
    const idempotent = opts.idempotent ?? true;
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    let forced = false;
    /** An earlier attempt that may have reached Google (5xx, timeout, reset) before this one was sent. */
    let uncertain: GoogleApiError | null = null;
    for (let attempt = 0; ; attempt++) {
      if (opts.cost) await this.bucket(accountId).take(opts.cost);
      const token = opts.token ? await opts.token(forced) : await this.tokens.accessToken(accountId, { force: forced });
      let err: GoogleApiError;
      try {
        const res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...opts.headers,
            ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(opts.rawBody ? { "content-type": opts.rawBody.contentType } : {}),
          },
          body: opts.rawBody ? opts.rawBody.data : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: attemptSignal(opts.signal, timeoutMs),
        });
        if (res.ok) {
          if (opts.binary || opts.maxResponseBytes !== undefined) {
            const bytes = await readBodyCapped(res, opts.maxResponseBytes);
            if (opts.binary) return bytes as T;
            const text = bytes.toString("utf8");
            return (text ? JSON.parse(text) : undefined) as T;
          }
          const text = await res.text();
          return (text ? JSON.parse(text) : undefined) as T;
        }
        err = await errorFromResponse(res);
      } catch (e) {
        if (opts.signal?.aborted || e instanceof ResponseTooLargeError) throw e;
        if (e instanceof SyntaxError) throw new GoogleApiError(502, "Google returned an invalid JSON response", "invalid_response");
        err = isAbortError(e)
          ? new GoogleApiError(0, `Google (${new URL(url).host}) didn't respond within ${timeoutMs / 1000}s`, "timeout")
          : networkError(e, new URL(url).host);
      }
      if (err.status === 401 && !forced) {
        forced = true;
        // A caller's own token is refreshed by calling it with force; the account's full token is dropped here.
        if (!opts.token) this.tokens.invalidate(accountId);
        continue;
      }
      const retry = idempotent ? isRetryable(err) : rejectedBeforeProcessing(err);
      if (!retry || attempt >= MAX_ATTEMPTS - 1) {
        // A write retried after an attempt that may have been applied, ending in a failed precondition (the first
        // attempt may be what changed it) or in more server errors: its outcome is unknown.
        if (uncertain && method !== "GET" && (err.status === 412 || isRetryable(err))) {
          throw ambiguous(uncertain, opts.ambiguousHint ?? "The change may have been applied: check before retrying.");
        }
        throw idempotent ? err : ambiguous(err, opts.ambiguousHint);
      }
      if (!rejectedBeforeProcessing(err)) uncertain ??= err;
      await sleep(backoffMs(attempt, err.details.retryAfterMs), opts.signal);
      if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
  }

  private bucket(accountId: string): TokenBucket {
    let b = this.buckets.get(accountId);
    if (!b) this.buckets.set(accountId, (b = new TokenBucket()));
    return b;
  }
}

/** For non-idempotent calls, a timeout, dropped connection or 5xx may have happened after Google acted. */
function ambiguous(err: GoogleApiError, hint = "The message may have been sent: check Sent in Gmail before retrying."): GoogleApiError {
  if (rejectedBeforeProcessing(err) || (err.status !== 0 && err.status < 500)) return err;
  return new GoogleApiError(err.status, `${err.message}. ${hint}`, err.reason, { ...err.details, reasons: [...(err.details.reasons ?? []), OUTCOME_UNKNOWN] });
}

function attemptSignal(outer: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (!timeoutMs) return outer;
  const timeout = AbortSignal.timeout(timeoutMs);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

const runtimes = new WeakMap<object, GoogleRuntime>();

export function googleRuntime(ctx: AppContext): GoogleRuntime {
  let r = runtimes.get(ctx);
  if (!r) runtimes.set(ctx, (r = new GoogleRuntime(ctx)));
  return r;
}
