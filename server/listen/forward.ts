import { createHmac, randomBytes } from "node:crypto";
import type { WebhookPayload } from "../../shared/types.ts";
import { describeFetchError, userAgent } from "./api.ts";
import { commandInput } from "./event.ts";
import { isLoopbackHost } from "./transport.ts";

/** Standard Webhooks secret: "whsec_" + base64 of 24 random bytes. */
export const newSecret = (): string => `whsec_${randomBytes(24).toString("base64")}`;

/**
 * Standard Webhooks signature (https://www.standardwebhooks.com): base64 HMAC-SHA256 over
 * "{id}.{timestamp}.{body}", keyed with the base64-decoded part of the secret after "whsec_".
 */
export function sign(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export interface ForwardResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  response: string | null;
  durationMs: number;
  /** 429 Too Many Requests: when to try again (Retry-After, else a minute). */
  retryAfterMs?: number;
}

/** Retry-After in seconds or as an HTTP date; a minute when absent (Hermes limits a route per minute). Clamped to 1 s – 10 min. */
export function retryAfter(header: string | null, now = Date.now()): number {
  let ms = 60_000;
  if (header && /^\d+$/.test(header.trim())) ms = Number(header.trim()) * 1000;
  else if (header && !Number.isNaN(Date.parse(header))) ms = Date.parse(header) - now;
  return Math.min(Math.max(ms, 1000), 600_000);
}

/** Forward targets must be on this machine: the point is waking a local process, not relaying mail elsewhere. */
export function validateForwardUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid --forward URL "${raw}". Use e.g. http://localhost:8787/xaq.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--forward must be an http(s) URL.");
  // Literal loopback only: a *.localhost name would need resolving first.
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(`--forward must point at this machine (localhost, 127.0.0.1 or [::1]), not ${url.host}.`);
  }
  if (url.username || url.password) throw new Error("--forward must not contain credentials; receivers verify the signature instead.");
  return url.toString();
}

/**
 * The body for an agent that reads it as text (the Hermes route puts it into the prompt): the untrusted
 * notice first and the event cleaned as for --exec, plus `type` so Hermes can name the event.
 */
export const wrappedBody = (payload: WebhookPayload) => JSON.stringify({ type: payload.type, ...commandInput(payload) });

/**
 * POSTs the WebhookPayload exactly like a daemon webhook (Standard Webhooks headers, signed with the
 * listener's own secret), so the same receiver code works for both; with `wrap`, the cleaned
 * { type, notice, event } form instead. webhook-id is the event id and stays the same across retries:
 * dedupe on it. Redirects are not followed.
 */
export async function forwardEvent(url: string, secret: string, payload: WebhookPayload, opts: { timeoutMs: number; signal?: AbortSignal; wrap?: boolean }): Promise<ForwardResult> {
  const started = performance.now();
  const body = opts.wrap ? wrappedBody(payload) : JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const id = payload.data.id;
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const elapsed = () => Math.round(performance.now() - started);
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      headers: {
        "content-type": "application/json",
        "user-agent": userAgent(),
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": sign(secret, id, timestamp, body),
        // Subjects, senders, snippets, bodies and calendar event text in this payload are untrusted content.
        // Kept from before the rename: receivers may check for it.
        "x-agentinbox-untrusted": "1",
      },
      body,
    });
    const text = (await res.text().catch(() => "")).slice(0, 500) || null;
    const ok = res.status >= 200 && res.status < 300;
    const limited = res.status === 429 ? { retryAfterMs: retryAfter(res.headers.get("retry-after")) } : {};
    return { ok, statusCode: res.status, response: text, error: ok ? null : `Receiver responded ${res.status}${res.status === 429 ? " (too many requests)" : ""}`, durationMs: elapsed(), ...limited };
  } catch (err) {
    const reason = timeout.aborted ? `Timed out after ${Math.round(opts.timeoutMs / 1000)} s` : describeFetchError(err);
    return { ok: false, statusCode: null, response: null, error: reason, durationMs: elapsed() };
  }
}
