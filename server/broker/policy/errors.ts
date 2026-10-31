// SourceError → plain words for the agent.

import { presetById } from "../../integrations/index.ts";
import { SourceError, type SourceErrorCode } from "../types.ts";
import { connectionConsoleUrl } from "../upstream/connection.ts";
import type { Scrubber } from "./output.ts";
import { type ConnectionInfo, isExpired } from "./store.ts";

export interface DescribedFailure {
  /** Audit reason: the SourceError code, or "internal". */
  reason: SourceErrorCode | "internal" | "connection_disabled";
  message: string;
  /** The call may have reached the upstream (and done something): counted toward risky caps, never retried. */
  maybeRan: boolean;
}

/** Codes where the upstream never got the call. Anything else may have run. */
const NOT_SENT = new Set<SourceErrorCode>(["needs_reauth", "blocked_target", "rate_limited"]);

/** What an agent is told about a connection that can't be used: its name, kind, whether it expired, where to fix it. */
export interface ConnectionLabel {
  name: string;
  /** The preset's display name ("T3 Code"), or null for a custom server. */
  kind: string | null;
  /** Past its credential's lifetime (T3: 30 days, no refresh). */
  expired: boolean;
  /** The connection's page in the console (`<publicUrl>/connections/<id>`), with the Reconnect button. */
  consoleUrl: string;
}

export function connectionLabel(c: ConnectionInfo, publicUrl: string, at = Date.now()): ConnectionLabel {
  return {
    name: c.name,
    kind: c.preset ? (presetById(c.preset)?.displayName ?? null) : null,
    expired: isExpired(c, at),
    consoleUrl: connectionConsoleUrl(publicUrl, c.id),
  };
}

export function reconnectMessage(c: string | ConnectionLabel): string {
  if (typeof c !== "string" && c.expired) {
    // Agent-readable and relayable: the agent can't fix it, its user can, at that page.
    return `The ${c.kind ? `${c.kind} ` : ""}connection '${c.name}' expired; ask your user to reconnect it in xaq at ${c.consoleUrl} . Nothing was sent to ${c.name}.`;
  }
  const name = typeof c === "string" ? c : c.name;
  const where = typeof c === "string" ? "" : `: ${c.consoleUrl} `;
  return `The owner must reconnect ${name} in xaq (Connections → Reconnect) before its tools work again${where}. Nothing was sent to ${name}.`;
}

export function describeFailure(err: unknown, connection: string | ConnectionLabel, scrubber: Scrubber): DescribedFailure {
  const connectionName = typeof connection === "string" ? connection : connection.name;
  const detail = (msg: string) => {
    // Scrub before clipping, so a clipped secret can't survive as an unmatched prefix.
    const s = scrubber.scrub(msg.replace(/\s+/g, " ").trim()).text.slice(0, 300);
    return s ? ` (${s})` : "";
  };
  if (!(err instanceof SourceError)) {
    // Not a SourceError: an unexpected failure. The agent gets plain words only; the caller logs the detail.
    return {
      reason: "internal",
      message: `The call to ${connectionName} failed unexpectedly. It may or may not have run there: check before trying again.`,
      maybeRan: true,
    };
  }
  const maybeRan = !NOT_SENT.has(err.code);
  switch (err.code) {
    case "needs_reauth":
      return { reason: err.code, message: reconnectMessage(connection), maybeRan };
    case "timeout":
      return {
        reason: err.code,
        message: `${connectionName} didn't answer in time. The call may or may not have run there: check before trying again.`,
        maybeRan,
      };
    case "rate_limited": {
      const secs = err.retryAfterMs ? Math.max(1, Math.ceil(err.retryAfterMs / 1000)) : null;
      return {
        reason: err.code,
        message: `${connectionName} is limiting requests right now. ${secs ? `Try again in ${secs} second${secs === 1 ? "" : "s"}.` : "Try again in a minute."} Nothing was sent.`,
        maybeRan,
      };
    }
    case "blocked_target":
      return {
        reason: err.code,
        message: `xaq blocked the connection to ${connectionName}: its address is on a private or blocked network. Nothing was sent. The owner can allow this host for the connection in xaq (Connections → ${connectionName}).`,
        maybeRan,
      };
    case "unavailable":
      return {
        reason: err.code,
        message: `${connectionName} is unavailable right now${detail(err.message)}. The call may or may not have run there: check before trying again.`,
        maybeRan,
      };
    case "protocol":
      return {
        reason: err.code,
        message: `${connectionName} sent an answer xaq couldn't understand${detail(err.message)}. The call may or may not have run there: check before trying again.`,
        maybeRan,
      };
  }
}
