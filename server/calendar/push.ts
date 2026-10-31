// Optional Calendar push channels (workstream D). Only when publicUrl is public
// https; polling stays on as the safety net. Channels live in calendar_sync.channel_*.

import { timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AppContext } from "../context.ts";
import { sha256 } from "../crypto.ts";
import { now } from "../db/index.ts";
import { accountScopes, getRow } from "../google/accounts.ts";
import { CALENDAR_SCOPES, hasScopes } from "../../shared/google-scopes.ts";
import { GoogleApiError } from "../google/types.ts";
import { errorMessage } from "../util/errors.ts";
import { randomToken } from "../util/ids.ts";
import { isBlockedAddress, type LookupFn } from "../webhooks/ssrf.ts";
import type { CalendarService } from "./types.ts";

/** Path Google posts channel notifications to (mounted unauthenticated in server/app.ts). */
export const CALENDAR_PUSH_PATH = "/google/calendar/push";

export type CalendarPush = Pick<CalendarService, "handlePush" | "start" | "stop"> & {
  /** Creates/renews/stops channels to match the synced calendars and the current publicUrl. Never throws. */
  reconcile(accountId?: string): Promise<void>;
};

export interface PushOptions {
  lookup?: LookupFn;
  /** How long a new channel may wait for Google's "sync" notification before polling takes over. */
  verifyTimeoutMs?: number;
}

const CHANNEL_TTL_S = 7 * 86_400;
const RENEW_BEFORE_MS = 24 * 3_600_000;
const VERIFY_TIMEOUT_MS = 2 * 60_000;
/** Renewals, verification timeouts and accounts that stopped being usable are picked up this often. */
const RECONCILE_EVERY_MS = 10 * 60_000;

/** Hostnames that only resolve inside a private network (tailnet, mDNS, cloud-internal). */
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|internal|ts\.net)$/i;

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Where Google should post notifications, or null when it can't reach us: publicUrl must be https and its
 * host must resolve only to public addresses (the webhook SSRF ranges, which include 100.64/10 for Tailscale).
 */
export async function pushAddress(publicUrl: string, lookup: LookupFn = defaultLookup): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || PRIVATE_SUFFIX.test(host)) return null;
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host)).map((a) => a.address);
  } catch {
    return null;
  }
  if (!addresses.length || addresses.some(isBlockedAddress)) return null;
  return `${publicUrl.replace(/\/+$/, "")}${CALENDAR_PUSH_PATH}`;
}

/** Channel ids carry a tag of the address they post to, so a publicUrl change (even while stopped) is noticed. */
const addressTag = (address: string) => sha256(address).slice(0, 8);
const channelId = (address: string) => `chn_${addressTag(address)}_${randomToken(20)}`;

interface ChannelRow {
  account_id: string;
  calendar_id: string;
  channel_id: string | null;
  channel_resource_id: string | null;
  channel_token_hash: string | null;
  channel_expires_at: string | null;
  channel_verified_at: string | null;
}

/**
 * events.watch refused the address itself (not https, no valid certificate, a host Google won't call).
 * Anything else (5xx, 429, network, one account's scopes) is retried on the next reconcile.
 */
export function addressRejected(err: unknown): boolean {
  if (!(err instanceof GoogleApiError) || ![400, 401, 403].includes(err.status)) return false;
  const reasons = [err.reason, ...(err.details.reasons ?? [])].filter(Boolean) as string[];
  if (reasons.some((r) => r.startsWith("push.webhookUrl"))) return true;
  // Older answers say it only in words, as a 400.
  return err.status === 400 && /webhook|callback|certificate/i.test(err.message);
}

/** Compared against when the channel is unknown, so both answers take the same time. */
const DUMMY_HASH = sha256("no such channel");

const sameHash = (a: string, b: string) => {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
};

function channelRows(ctx: AppContext, accountId?: string): ChannelRow[] {
  const cols = "account_id, calendar_id, channel_id, channel_resource_id, channel_token_hash, channel_expires_at, channel_verified_at";
  return accountId
    ? ctx.db.all<ChannelRow>(`SELECT ${cols} FROM calendar_sync WHERE account_id = ?`, accountId)
    : ctx.db.all<ChannelRow>(`SELECT ${cols} FROM calendar_sync`);
}

/** Clears a row's channel, only if it is still `id` (a renewal may have replaced it). */
function clearChannel(ctx: AppContext, row: ChannelRow, id: string): void {
  ctx.db.run(
    `UPDATE calendar_sync SET channel_id = NULL, channel_resource_id = NULL, channel_token_hash = NULL, channel_expires_at = NULL,
       channel_verified_at = NULL, updated_at = ? WHERE account_id = ? AND calendar_id = ? AND channel_id = ?`,
    now(),
    row.account_id,
    row.calendar_id,
    id,
  );
}

/** channels.stop, best effort (404 = already gone; a needs_reauth account can't ask anymore, and the channel expires). */
async function stopChannel(ctx: AppContext, accountId: string, id: string, resourceId: string | null): Promise<void> {
  if (!resourceId || getRow(ctx, accountId)?.status === "needs_reauth") return;
  try {
    await ctx.google.calendar(accountId).stopChannel({ id, resourceId });
  } catch (err) {
    ctx.log.child("calendar").warn("Could not stop a Calendar push channel", { channelId: id, error: errorMessage(err) });
  }
}

async function stopChannelsNow(ctx: AppContext, accountId: string): Promise<void> {
  for (const row of channelRows(ctx, accountId)) {
    if (!row.channel_id) continue;
    await stopChannel(ctx, accountId, row.channel_id, row.channel_resource_id);
    clearChannel(ctx, row, row.channel_id);
  }
}

/** The running push service per context, so account removal can go through its queue. */
const services = new WeakMap<AppContext, { stopAccount(accountId: string): Promise<void> }>();

/**
 * Stops every channel of an account before it is removed (channels.stop needs its token). Runs in the
 * push queue after any channel creation in flight, and keeps new ones from being created for it.
 */
export async function stopAccountChannels(ctx: AppContext, accountId: string): Promise<void> {
  const push = services.get(ctx);
  return push ? push.stopAccount(accountId) : stopChannelsNow(ctx, accountId);
}

export function createCalendarPush(ctx: AppContext, opts: PushOptions = {}): CalendarPush {
  const log = ctx.log.child("calendar");
  const lookup = opts.lookup ?? defaultLookup;
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS;
  /** When each unverified channel was created (or first seen after a restart). */
  const createdAt = new Map<string, number>();
  /**
   * Channels being created: Google sends "sync" as soon as events.watch succeeds, possibly before the row
   * is written. A verified entry is carried over when the row is.
   */
  const pending = new Map<string, { accountId: string; calendarId: string; tokenHash: string; verified: boolean }>();
  /** The address Google couldn't reach: no new channels for it until publicUrl changes or a restart. */
  let unreachable: string | null = null;
  /** Accounts being removed: no new channels for them. */
  const removing = new Set<string>();
  let running: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const timeouts = new Set<NodeJS.Timeout>();

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timeouts.delete(t);
      fn();
    }, ms);
    t.unref?.();
    timeouts.add(t);
  };

  async function create(row: ChannelRow, address: string): Promise<boolean> {
    const id = channelId(address);
    const token = randomToken(48);
    const tokenHash = sha256(token);
    pending.set(id, { accountId: row.account_id, calendarId: row.calendar_id, tokenHash, verified: false });
    try {
      const ch = await ctx.google.calendar(row.account_id).watchEvents(row.calendar_id, { id, address, token, ttlSeconds: CHANNEL_TTL_S });
      const expires = Number(ch.expiration);
      const verified = pending.get(id)?.verified ? now() : null;
      const { changes } = ctx.db.run(
        `UPDATE calendar_sync SET channel_id = ?, channel_resource_id = ?, channel_token_hash = ?, channel_expires_at = ?,
           channel_verified_at = ?, updated_at = ? WHERE account_id = ? AND calendar_id = ?`,
        id,
        ch.resourceId,
        tokenHash,
        new Date(Number.isFinite(expires) && expires > 0 ? expires : Date.now() + CHANNEL_TTL_S * 1000).toISOString(),
        verified,
        now(),
        row.account_id,
        row.calendar_id,
      );
      // The calendar left the synced set meanwhile.
      if (!changes) {
        await stopChannel(ctx, row.account_id, id, ch.resourceId);
        return false;
      }
      if (!verified) {
        createdAt.set(id, Date.now());
        later(verifyTimeoutMs + 1000, () => void reconcile(row.account_id));
      }
      return true;
    } catch (err) {
      // Google refuses addresses it can't use (no valid certificate, not https): stay on polling. Other
      // failures are retried on the next reconcile; polling covers the meantime.
      log.warn("Couldn't create a Calendar push channel; changes arrive by polling", { calendarId: row.calendar_id, error: errorMessage(err) });
      if (addressRejected(err)) unreachable = address;
      return false;
    } finally {
      pending.delete(id);
    }
  }

  async function reconcileOnce(accountId?: string): Promise<void> {
    const address = await pushAddress(ctx.settings.publicUrl(), lookup);
    const tag = address ? addressTag(address) : null;
    for (const row of channelRows(ctx, accountId)) {
      if (stopped) return;
      const acct = getRow(ctx, row.account_id);
      const usable = !!acct && acct.status === "active" && !removing.has(acct.id) && hasScopes(accountScopes(acct), CALENDAR_SCOPES);
      const want = usable && !!address && unreachable !== address;
      const id = row.channel_id;
      if (id) {
        const left = Date.parse(row.channel_expires_at ?? "") - Date.now();
        const created = createdAt.get(id);
        // Unverified and not created by this process (a restart came in between): replace it, it gets a new window.
        const orphan = !row.channel_verified_at && created === undefined;
        const unverified = !row.channel_verified_at && created !== undefined && Date.now() - created >= verifyTimeoutMs;
        if (unverified) {
          log.warn(`Google can't reach ${ctx.settings.publicUrl()}: Calendar changes arrive by polling`, { calendarId: row.calendar_id });
          unreachable = address;
        }
        const keep = want && !unverified && !orphan && id.startsWith(`chn_${tag}_`) && left > RENEW_BEFORE_MS;
        if (keep) continue;
        // Renewal (or a new address): the new channel first, then stop the old one, so no change goes unnoticed.
        const replaced = want && !unverified && !!address && (await create(row, address));
        if (!replaced) clearChannel(ctx, row, id);
        await stopChannel(ctx, row.account_id, id, row.channel_resource_id);
        createdAt.delete(id);
      } else if (want && address) {
        await create(row, address);
      }
    }
  }

  /** Serialized: overlapping reconciles would create two channels for one calendar. */
  function enqueue(fn: () => Promise<void>): Promise<void> {
    running = running.then(fn).catch((err) => log.error("Calendar push reconcile failed", { error: errorMessage(err) }));
    return running;
  }
  const reconcile = (accountId?: string) => enqueue(() => (stopped ? Promise.resolve() : reconcileOnce(accountId)));

  const service = {
    stopAccount(accountId: string): Promise<void> {
      removing.add(accountId);
      return enqueue(() => stopChannelsNow(ctx, accountId));
    },
  };

  let lastUrl = ctx.settings.publicUrl();
  const onSettings = () => {
    const url = ctx.settings.publicUrl();
    if (url === lastUrl) return;
    lastUrl = url;
    unreachable = null;
    void reconcile();
  };

  return {
    reconcile,

    handlePush(headers) {
      const id = headers.get("x-goog-channel-id") ?? "";
      const token = headers.get("x-goog-channel-token") ?? "";
      const state = headers.get("x-goog-resource-state");
      const row = id ? ctx.db.get<ChannelRow>("SELECT * FROM calendar_sync WHERE channel_id = ?", id) : undefined;
      const early = row ? undefined : pending.get(id);
      const stored = row?.channel_token_hash ?? early?.tokenHash;
      // Unknown channel and wrong token answer alike: 404 tells Google to stop, and reveals nothing to others.
      const match = sameHash(sha256(token), stored ?? DUMMY_HASH);
      if (!stored || !token || !match) return 404;
      if (row?.channel_resource_id && headers.get("x-goog-resource-id") !== row.channel_resource_id) return 404;
      if (early) {
        early.verified = true;
        return 204;
      }
      if (!row!.channel_verified_at) {
        ctx.db.run("UPDATE calendar_sync SET channel_verified_at = ?, updated_at = ? WHERE channel_id = ?", now(), now(), id);
        createdAt.delete(id);
      }
      if (state !== "sync") ctx.calendar.kick(row!.account_id, row!.calendar_id);
      return 204;
    },

    start() {
      services.set(ctx, service);
      ctx.bus.on("settings", onSettings);
      timer = setInterval(() => void reconcile(), RECONCILE_EVERY_MS);
      timer.unref?.();
      void reconcile();
    },

    async stop() {
      stopped = true;
      if (services.get(ctx) === service) services.delete(ctx);
      ctx.bus.off("settings", onSettings);
      clearInterval(timer);
      for (const t of timeouts) clearTimeout(t);
      timeouts.clear();
      await running;
    },
  };
}
