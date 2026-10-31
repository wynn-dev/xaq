import type { ApiError as ApiErrorBody } from "@shared/types";
import { toast } from "sonner";

/** A non-2xx console API response (or a network failure, with status 0). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;
  /** Set on oauth_already_connected: the account that sign-in connected. */
  readonly email?: string;
  constructor(status: number, code: string, message: string, hint?: string, email?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.email = email;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

/** Fired on a 401 from an authenticated endpoint; the app layout sends the user to /login. */
export const UNAUTHORIZED_EVENT = "agentinbox:unauthorized";

// Auth endpoints answer 401/403 for wrong passwords and tokens; those are form errors, not session expiry.
const AUTH_PATHS = ["/api/auth/login", "/api/setup/claim", "/api/setup/verify-token", "/api/auth/password", "/api/setup/status"];

function isApiErrorBody(v: unknown): v is ApiErrorBody {
  return !!v && typeof v === "object" && "error" in v && !!(v as ApiErrorBody).error && typeof (v as ApiErrorBody).error.message === "string";
}

export async function api<T = void>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") headers["x-xaq-csrf"] = "1";
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, credentials: "same-origin", signal: opts.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network", "Can't reach the xaq server", "Check that the daemon is running, then try again.");
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && !AUTH_PATHS.includes(url.pathname)) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    if (isApiErrorBody(parsed)) {
      throw new ApiError(res.status, parsed.error.code, parsed.error.message, parsed.error.hint, parsed.error.email);
    }
    const msg = typeof parsed === "string" && parsed.trim() && parsed.length < 300 ? parsed.trim() : `Request failed (HTTP ${res.status})`;
    throw new ApiError(res.status, "http_" + res.status, msg);
  }
  return parsed as T;
}

export const apiGet = <T>(path: string, query?: Query) => api<T>(path, { query });

/** Error message + server hint for inline display. */
export function describeError(err: unknown): { message: string; hint?: string } {
  if (err instanceof ApiError) return { message: err.message, hint: err.hint };
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}

/** Toasts an API error: the server's message, with its remediation hint underneath. */
export function toastError(err: unknown, title?: string) {
  const { message, hint } = describeError(err);
  if (title) toast.error(title, { description: hint ? `${message} ${hint}` : message });
  else toast.error(message, { description: hint });
}
