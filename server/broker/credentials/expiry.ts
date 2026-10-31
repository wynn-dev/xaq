import type { AuditLog } from "../../audit.ts";
import type { Db } from "../../db/index.ts";
import type { Logger } from "../../util/log.ts";
import { errorMessage } from "../../util/errors.ts";
import type { EmitConnectionEvent, CredentialStore } from "./store.ts";

/**
 * Dated expiry warnings for credentials that stop working without a human: no refresh grant (T3: the
 * access token is the whole credential) or a hard cap (a preset's reconnectPolicy, e.g. Notion's 180
 * days). `connections.expires_at` holds that date. Warned at 7 days and 1 day; past it the connection
 * is marked needs_reauth before any call can hit a 401.
 */

const DAY_MS = 86_400_000;
export const WARN_DAYS = [7, 1] as const;

export interface ExpiryNotice {
  expiresAt: string;
  /** Whole days left, rounded up; 0 once expired. */
  daysLeft: number;
  /** The tightest threshold reached (7 or 1), null when further out, "expired" past it. */
  level: (typeof WARN_DAYS)[number] | "expired" | null;
  message: string;
}

/** What the console and CLI show for a connection's expiry; null when it isn't known to expire. */
export function expiryNotice(c: { name: string; expiresAt: string | null }, now = Date.now()): ExpiryNotice | null {
  if (!c.expiresAt) return null;
  const at = Date.parse(c.expiresAt);
  if (!Number.isFinite(at)) return null;
  const date = c.expiresAt.slice(0, 10);
  if (at <= now) return { expiresAt: c.expiresAt, daysLeft: 0, level: "expired", message: `${c.name}'s sign-in expired on ${date}. Reconnect it.` };
  const daysLeft = Math.ceil((at - now) / DAY_MS);
  const level = [...WARN_DAYS].reverse().find((d) => daysLeft <= d) ?? null;
  return {
    expiresAt: c.expiresAt,
    daysLeft,
    level,
    message: `${c.name} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (on ${date}). Reconnect it before then.`,
  };
}

export interface ExpiryDeps {
  db: Db;
  audit: AuditLog;
  log: Logger;
  emit: EmitConnectionEvent;
  store: CredentialStore;
  now?: () => number;
  /** The console page of a connection: the one-click Reconnect link in `connection.expiring`. */
  consoleUrl?: (connectionId: string) => string;
}

/** One pass: emits `connection.expiring` once per threshold and credential, marks expired ones needs_reauth. */
export function checkExpiries(deps: ExpiryDeps): void {
  const now = (deps.now ?? Date.now)();
  const rows = deps.db.all<{ id: string; slug: string; name: string; expires_at: string }>(
    "SELECT id, slug, name, expires_at FROM connections WHERE expires_at IS NOT NULL AND status = 'active'",
  );
  for (const r of rows) {
    const n = expiryNotice({ name: r.name, expiresAt: r.expires_at }, now);
    if (!n?.level) continue;
    if (n.level === "expired") {
      deps.store.markNeedsReauth(r.id, n.message, { expired: true });
      continue;
    }
    // The outbox dedupes on the key: one event per threshold per credential (a reconnect moves expires_at).
    const dedupeKey = `${r.id}:expiring:${n.level}:${r.expires_at}`;
    const seen = deps.db.get("SELECT 1 FROM audit_log WHERE action = 'connection.expiring' AND target = ? AND reason = ?", r.id, dedupeKey);
    if (seen) continue;
    try {
      deps.emit({
        type: "connection.expiring",
        connectionId: r.id,
        detail: {
          slug: r.slug,
          name: r.name,
          expiresAt: r.expires_at,
          daysLeft: n.daysLeft,
          message: n.message,
          // The one-click Reconnect: the connection's page in the console (webhooks and the listener carry it).
          ...(deps.consoleUrl ? { reconnectUrl: deps.consoleUrl(r.id) } : {}),
        },
        dedupeKey,
      });
    } catch (err) {
      deps.log.child("broker").error("Could not record connection.expiring", { error: errorMessage(err) });
    }
    deps.audit.record({
      actorType: "system",
      action: "connection.expiring",
      target: r.id,
      outcome: "ok",
      reason: dedupeKey,
      detail: { slug: r.slug, expiresAt: r.expires_at, daysLeft: n.daysLeft },
    });
  }
}
