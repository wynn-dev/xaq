import type { ApiError } from "../../shared/types.ts";

/** Throw from anywhere in request handling; the API layer turns it into an ApiError response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }

  toJSON(): ApiError {
    return { error: { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) } };
  }
}

export const badRequest = (message: string, hint?: string) => new HttpError(400, "bad_request", message, hint);
export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const conflict = (message: string, hint?: string) => new HttpError(409, "conflict", message, hint);

/** Thrown by policy checks. `reason` is the guardrail name recorded in the audit log. */
export class PolicyDenied extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Network error codes raised before a connection existed (DNS failure, refused, unreachable, undici's connect
 * timeout): the request never left this machine, so sending it again is safe whatever its method.
 */
export const NOT_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
