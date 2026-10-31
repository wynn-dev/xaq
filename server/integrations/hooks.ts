// Inbound webhooks for native presets: POST /hooks/connections/:id, or /hooks/connections/<preset id> (one URL for
// the provider's app, known before the connection exists, so the setup can show it). Provider-facing, so it lives outside the admin
// session and CSRF guard (like CALENDAR_PUSH_PATH); the preset verifies the request itself (WHOOP: HMAC with the
// connection's client secret). Inert until the broker wiring supplies a ConnectionHookHost.

import { Hono } from "hono";
import type { IntegrationEvent, IntegrationPreset, NativeSourceDeps } from "../broker/types.ts";
import type { Logger } from "../util/log.ts";

export const CONNECTION_HOOKS_PREFIX = "/hooks/connections";
/** WHOOP's payloads are four small fields. */
export const CONNECTION_HOOK_BODY_LIMIT = 16 * 1024;
/** Longer than any preset's signature tolerance (WHOOP: 2 h), so an accepted replay is still remembered. */
export const HOOK_DEDUPE_TTL_MS = 3 * 3_600_000;
const HOOK_DEDUPE_MAX = 2_000;

/** The inbound webhook URL for a connection (or a preset, by its id), given a base such as the install's public URL. */
export const connectionHookUrl = (publicUrl: string, connectionId: string) =>
  `${publicUrl.replace(/\/+$/, "")}${CONNECTION_HOOKS_PREFIX}/${encodeURIComponent(connectionId)}`;

export interface ConnectionHookTarget {
  preset: IntegrationPreset;
  deps: NativeSourceDeps;
  clientSecret: string;
  client: Record<string, unknown> | null;
}

/** What the broker provides to the route (implemented where connections and the credential store live). */
export interface ConnectionHookHost {
  /**
   * The connection's preset, source deps, client secret and stored client record (CredentialStore.client: WHOOP keeps
   * the connected member's `whoop_user_id` there); null when the connection doesn't exist, is disabled or needs
   * re-auth, or has no client secret.
   */
  webhookTarget(connectionId: string): ConnectionHookTarget | null;
  /**
   * The same for every connection of a preset (/hooks/connections/<preset id>). Each target's own signature check
   * decides which connection a delivery is for: each WHOOP app has its own client secret.
   */
  presetWebhookTargets?(presetId: string): ConnectionHookTarget[];
  /** A delivery for this connection passed its signature check, so its webhooks do reach this install. */
  delivered?(connectionId: string): void;
  /** Into the events outbox (deduped on dedupeKey). Throwing makes the route answer 500, so the provider retries. */
  emit(events: IntegrationEvent[]): void;
}

/** Recently emitted dedupe keys per connection (providers deliver an event more than once). */
class Seen {
  private readonly byConnection = new Map<string, Map<string, number>>();
  constructor(private readonly now: () => number) {}

  has(connectionId: string, key: string): boolean {
    const at = this.byConnection.get(connectionId)?.get(key);
    return at !== undefined && this.now() - at < HOOK_DEDUPE_TTL_MS;
  }

  mark(connectionId: string, key: string): void {
    let seen = this.byConnection.get(connectionId);
    if (!seen) this.byConnection.set(connectionId, (seen = new Map()));
    const t = this.now();
    seen.delete(key);
    seen.set(key, t);
    // Oldest first (insertion order): drop expired entries and anything over the cap.
    for (const [k, v] of seen) {
      if (seen.size <= HOOK_DEDUPE_MAX && t - v < HOOK_DEDUPE_TTL_MS) break;
      seen.delete(k);
    }
  }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function connectionHookRoutes(opts: { host: () => ConnectionHookHost | null; log: Logger; now?: () => number }) {
  const app = new Hono();
  const seen = new Seen(opts.now ?? Date.now);
  app.post(`${CONNECTION_HOOKS_PREFIX}/:id`, async (c) => {
    const id = c.req.param("id");
    const host = opts.host();
    const one = host && ID.test(id) ? host.webhookTarget(id) : null;
    const candidates = one ? [one] : host && ID.test(id) ? (host.presetWebhookTargets?.(id) ?? []) : [];
    const targets = candidates.filter((t) => t.preset.events?.handleWebhook);
    if (!host || !targets.length) return c.body(null, 404);
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v;
    });
    let verified = false;
    const fresh: IntegrationEvent[] = [];
    for (const target of targets) {
      const connectionId = target.deps.connectionId;
      // The contract's deps plus the client record (additive; presets that don't need it ignore it).
      const deps: NativeSourceDeps & { clientSecret: string; client: Record<string, unknown> | null } = {
        ...target.deps,
        clientSecret: target.clientSecret,
        client: target.client,
      };
      let events: IntegrationEvent[] | null;
      try {
        events = await target.preset.events!.handleWebhook!({ headers, rawBody }, deps);
      } catch (err) {
        opts.log.warn("connection webhook failed", { connectionId, error: (err as Error).message });
        return c.body(null, 500);
      }
      if (events === null) continue;
      verified = true;
      const mine = events.filter((e) => e.connectionId === connectionId);
      // Only a delivery for this connection's own member (another member of the same app verifies too, but says
      // nothing about this connection).
      if (mine.length) host.delivered?.(connectionId);
      fresh.push(...mine.filter((e) => !seen.has(connectionId, e.dedupeKey)));
    }
    if (!verified) {
      opts.log.warn("connection webhook: bad signature", { connectionId: id });
      return c.body(null, 401);
    }
    if (fresh.length) {
      try {
        host.emit(fresh);
      } catch (err) {
        // Not marked as seen: the provider's retry gets another chance.
        opts.log.warn("connection webhook: emit failed", { connectionId: id, error: (err as Error).message });
        return c.body(null, 500);
      }
      for (const e of fresh) seen.mark(e.connectionId, e.dedupeKey);
    }
    return c.body(null, 204);
  });
  return app;
}
