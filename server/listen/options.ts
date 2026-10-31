import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { EVENT_TYPES, type EventType, isEventType, type WebhookFilter } from "../../shared/types.ts";
import { normalizeFilter, webhookFilterSchema } from "../events/filter.ts";
import { resolve } from "node:path";
import { newSecret, validateForwardUrl } from "./forward.ts";
import { assertTrustedDir } from "./fsutil.ts";
import { DEFAULT_PROFILE, workDir } from "./paths.ts";
import type { Profile } from "./profile.ts";
import { parseRecipeTool, recipe } from "./recipes.ts";
import { NPX } from "./version.ts";

/**
 * `listen` flags. Each group overrides the profile as a unit: targets (--recipe/--exec/--forward), --types,
 * the filter (--from/--to/--label/--subject), the exclusions (--not-from/--not-label) and the category skip.
 */
export interface ListenFlags {
  profile?: string;
  exec?: string;
  /** A built-in recipe (claude-code, codex, cursor, hermes, hermes-oneshot): its command becomes the exec (hermes: the forward), so no `$(…)` is needed. */
  recipe?: string;
  forward?: string;
  types?: string;
  from?: string[];
  to?: string[];
  label?: string[];
  subject?: string;
  /** Exclusions (their own group): senders and labels to skip. */
  notFrom?: string[];
  notLabel?: string[];
  /** Gmail categories: skip none (`--all-categories`), or take one back from the default skip (`--include-category`). */
  allCategories?: boolean;
  includeCategory?: string[];
  /** Back to the default category skip (promotions, social, forums). */
  defaultCategories?: boolean;
  /** Collect events for this long (e.g. "60s") and run --exec once for the batch; "0" turns it off. */
  batch?: string;
  includeBody?: boolean;
  concurrency?: number;
  timeout?: number;
  maxAttempts?: number;
  consumer?: string;
  insecure?: boolean;
  cwd?: string;
  save?: boolean;
  dryRun?: boolean;
  /** A new consumer starts at the oldest stored event instead of now (never saved). */
  fromStart?: boolean;
  /** One-off: run every stored event up to now through the targets (own throwaway cursor and lock), then exit. */
  backfill?: boolean;
  /** --backfill: replay up to this seq instead of where the listener started. */
  until?: number;
}

export interface EffectiveConfig {
  exec: string | null;
  forward: { url: string; secret: string } | null;
  /** Never empty: DEFAULT_LISTEN_TYPES unless --types or the profile says otherwise. */
  types: EventType[];
  /** Neither --types nor the profile named types: `types` is DEFAULT_LISTEN_TYPES. */
  typesDefaulted: boolean;
  filter: WebhookFilter | undefined;
  /** Listener-side exclusions (never sent to the daemon). */
  exclude: Exclusions;
  /** Gmail category label ids whose messages are skipped (default: promotions, social, forums). */
  skipCategories: string[];
  /** --batch window in seconds; 0 = one run per event. */
  batchSeconds: number;
  includeBody: boolean;
  concurrency: number;
  timeoutSeconds: number;
  maxAttempts: number;
  consumer: string;
  insecure: boolean;
  /** Working directory for commands: validated --cwd, else the profile's private work dir. */
  cwd: string;
  cwdIsDefault: boolean;
}

export const DEFAULTS = { concurrency: 2, timeoutSeconds: 300, maxAttempts: 5 } as const;

/** Senders and labels a listener skips. Applied on this machine only, to events that carry a message. */
export interface Exclusions {
  from?: string[];
  labelIds?: string[];
}

/** Gmail's bulk tabs, skipped by default: one paid agent run per newsletter or social ping is rarely wanted. */
export const CATEGORIES = { promotions: "CATEGORY_PROMOTIONS", social: "CATEGORY_SOCIAL", forums: "CATEGORY_FORUMS", updates: "CATEGORY_UPDATES", primary: "CATEGORY_PERSONAL" } as const;
export const DEFAULT_SKIP_CATEGORIES: readonly string[] = [CATEGORIES.promotions, CATEGORIES.social, CATEGORIES.forums];
const categoryName = (id: string) => Object.entries(CATEGORIES).find(([, v]) => v === id)?.[0] ?? id;

/** Most events one batched run gets; a bigger burst becomes several runs. */
export const MAX_BATCH = 20;
const MAX_BATCH_SECONDS = 3600;

/** "60s", "2m", "1h", "500ms" or plain seconds ("90"). "0" means no batching. */
export function parseDuration(value: string, name = "--batch"): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
  if (!m) throw new Error(`${name} takes a duration such as 30s, 2m or 0 (off), not "${value}".`);
  const unit = (m[2] ?? "s").toLowerCase();
  const seconds = Number(m[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600 } as Record<string, number>)[unit]!;
  if (seconds !== 0 && (seconds < 1 || seconds > MAX_BATCH_SECONDS)) throw new Error(`${name} must be 0 (off) or between 1s and 1h.`);
  return Math.round(seconds);
}

function categoryId(value: string): string {
  const v = value.trim();
  const byName = (CATEGORIES as Record<string, string>)[v.toLowerCase()];
  if (byName) return byName;
  if (Object.values(CATEGORIES).includes(v.toUpperCase() as never)) return v.toUpperCase();
  throw new Error(`Unknown Gmail category "${value}". Choose from: ${Object.keys(CATEGORIES).join(", ")}.`);
}

/**
 * Event types a listener gets when neither --types nor the profile names any: new mail only. Each
 * event can start a paid agent run, so mail the account sends (message.sent, also the console's
 * test email) and label changes don't wake it unless asked for with --types.
 */
export const DEFAULT_LISTEN_TYPES: readonly EventType[] = ["message.received"];

/** Comma-separated event types; "all" means every type. */
export function parseTypes(value: string): EventType[] {
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) throw new Error(`--types needs at least one event type (or "all"). Choose from: ${EVENT_TYPES.join(", ")}.`);
  if (list.includes("all")) {
    if (list.length > 1) throw new Error(`--types all can't be combined with other types.`);
    return [...EVENT_TYPES];
  }
  const bad = list.filter((t) => !isEventType(t));
  if (bad.length) throw new Error(`Unknown event type${bad.length > 1 ? "s" : ""} ${bad.join(", ")}. Choose from: ${EVENT_TYPES.join(", ")}.`);
  return [...new Set(list)] as EventType[];
}

const CONSUMER_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** Suffixes of the throwaway cursors `--backfill` and `--dry-run` derive from a consumer (the daemon reserves them too). */
export const THROWAWAY_SUFFIXES = { backfill: "-replay", dryRun: "-dry-run" } as const;

export function validConsumer(name: string): string {
  if (!CONSUMER_RE.test(name)) throw new Error(`Invalid consumer name "${name}": use up to 100 letters, digits, ".", "_" or "-".`);
  const reserved = Object.values(THROWAWAY_SUFFIXES).find((s) => name.endsWith(s));
  if (reserved) throw new Error(`Invalid consumer name "${name}": names ending in "${reserved}" are reserved for --backfill and --dry-run cursors.`);
  return name;
}

/**
 * The throwaway cursor for `consumer`: `<consumer><suffix>`, or, when that would pass the 100-character
 * limit, a truncated name plus a hash of the full one, so two long consumers never share a cursor.
 */
export function throwawayConsumer(consumer: string, suffix: (typeof THROWAWAY_SUFFIXES)[keyof typeof THROWAWAY_SUFFIXES]): string {
  if (consumer.length + suffix.length <= 100) return `${consumer}${suffix}`;
  const hash = createHash("sha256").update(consumer).digest("hex").slice(0, 8);
  return `${consumer.slice(0, 100 - suffix.length - hash.length - 1)}-${hash}${suffix}`;
}

/** Default consumer: one server-side cursor per machine and profile. */
export function defaultConsumer(profile: string): string {
  const host = hostname()
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // Fits the 100-character consumer limit with "-<profile>" (profiles are at most 40).
    .slice(0, 99 - profile.length);
  return `${host || "host"}-${profile}`;
}

/** The forward-mode signing secret: generated once per profile, kept with the saved forward URL when there is one. */
export function forwardSecret(profile: Profile): { secret: string; created: boolean } {
  const existing = profile.forward?.secret ?? profile.forwardSecret;
  if (existing) return { secret: existing, created: false };
  return { secret: newSecret(), created: true };
}

function filterFromFlags(f: ListenFlags): WebhookFilter | undefined {
  const given = f.from?.length || f.to?.length || f.label?.length || f.subject !== undefined;
  if (!given) return undefined;
  const filter = normalizeFilter({ from: f.from, to: f.to, labelIds: f.label, subject: f.subject });
  const parsed = webhookFilterSchema.safeParse(filter);
  if (!parsed.success) throw new Error(`Invalid filter: ${parsed.error.issues[0]?.message}`);
  return filter;
}

const exclusionsSchema = webhookFilterSchema.pick({ from: true, labelIds: true });

function exclusionsFromFlags(f: ListenFlags): Exclusions | undefined {
  if (f.notFrom === undefined && f.notLabel === undefined) return undefined;
  const { from, labelIds } = normalizeFilter({ from: f.notFrom, labelIds: f.notLabel });
  const parsed = exclusionsSchema.safeParse({ from, labelIds });
  if (!parsed.success) throw new Error(`Invalid exclusion: ${parsed.error.issues[0]?.message}`);
  return { ...(from ? { from } : {}), ...(labelIds ? { labelIds } : {}) };
}

/** The categories skipped after --all-categories / --include-category, or undefined when neither was given. */
function skipFromFlags(f: ListenFlags): string[] | undefined {
  const given = [f.allCategories && "--all-categories", f.includeCategory?.length && "--include-category", f.defaultCategories && "--default-categories"].filter(Boolean);
  if (given.length > 1) throw new Error(`${given.join(" and ")} can't be combined: each sets which Gmail categories are skipped.`);
  if (f.defaultCategories) return [...DEFAULT_SKIP_CATEGORIES];
  if (f.allCategories) return [];
  if (!f.includeCategory?.length) return undefined;
  const back = new Set(f.includeCategory.map(categoryId));
  const notSkipped = [...back].filter((c) => !DEFAULT_SKIP_CATEGORIES.includes(c));
  if (notSkipped.length) {
    throw new Error(`--include-category ${notSkipped.map(categoryName).join(", ")}: that category isn't skipped (only ${DEFAULT_SKIP_CATEGORIES.map(categoryName).join(", ")} are). To skip it, use --not-label ${notSkipped[0]}.`);
  }
  return DEFAULT_SKIP_CATEGORIES.filter((c) => !back.has(c));
}

const positiveInt = (v: number | undefined, name: string, max: number) => {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 1 || v > max) throw new Error(`${name} must be a whole number from 1 to ${max}.`);
  return v;
};

/**
 * `--recipe <name>` is shorthand for `--exec "<that recipe's command>"` (for this profile's paths), or for
 * `--forward <Hermes gateway route>` with `hermes`, and is saved the same way. It exists so nobody has to
 * write `--exec "$(npx … --print-recipe …)"`: inside `$(…)` npx's "Ok to proceed?" install prompt is
 * captured and silently becomes part of the command.
 */
export function withRecipe(profileName: string, flags: ListenFlags): ListenFlags {
  if (flags.recipe === undefined) return flags;
  if (flags.exec !== undefined) throw new Error("--recipe and --exec can't be combined: --recipe <name> already sets the command (see it with --print-recipe <name>).");
  const r = recipe(parseRecipeTool(flags.recipe), profileName);
  if (r.forward) {
    if (flags.forward !== undefined) throw new Error(`--recipe ${r.name} already forwards to ${r.forward}; for another port, pass only --forward <url>.`);
    return { ...flags, recipe: undefined, forward: r.forward };
  }
  return { ...flags, recipe: undefined, exec: r.exec };
}

/**
 * Merges flags over the profile. Returns the effective config and the profile as it would be saved
 * with --save (the forward secret is always persisted, so receivers keep verifying across restarts).
 */
export function resolveListen(profileName: string, profile: Profile, given: ListenFlags): { config: EffectiveConfig; next: Profile; changed: boolean } {
  const flags = withRecipe(profileName, given);
  const next: Profile = { ...profile };
  let changed = false;

  const targetsGiven = flags.exec !== undefined || flags.forward !== undefined;
  let exec = profile.exec ?? null;
  let forward = profile.forward ?? null;
  if (targetsGiven) {
    exec = flags.exec?.trim() ? flags.exec : null;
    if (flags.exec !== undefined && !flags.exec.trim()) throw new Error("--exec needs a command.");
    forward = null;
    if (flags.forward) {
      const url = validateForwardUrl(flags.forward);
      const { secret, created } = forwardSecret(profile);
      forward = { url, secret };
      if (created || !profile.forward) {
        // Keep the secret even without --save so `listen secret` and the receiver agree from now on.
        next.forwardSecret = secret;
        changed = true;
      }
    }
  }
  if (forward) validateForwardUrl(forward.url);

  // Saved as given (no types saved = the default), so the profile follows the default if it changes.
  const typesDefaulted = flags.types === undefined && !profile.types?.length;
  const types = flags.types !== undefined ? parseTypes(flags.types) : typesDefaulted ? [...DEFAULT_LISTEN_TYPES] : profile.types!;
  const filter = filterFromFlags(flags) ?? profile.filter;
  const exclude = exclusionsFromFlags(flags) ?? profile.exclude ?? {};
  const skipCategories = skipFromFlags(flags) ?? profile.skipCategories ?? [...DEFAULT_SKIP_CATEGORIES];
  const batchSeconds = flags.batch !== undefined ? parseDuration(flags.batch) : (profile.batchSeconds ?? 0);
  const includeBody = flags.includeBody ?? profile.includeBody ?? false;
  const concurrency = positiveInt(flags.concurrency, "--concurrency", 32) ?? profile.concurrency ?? DEFAULTS.concurrency;
  const timeoutSeconds = positiveInt(flags.timeout, "--timeout", 86_400) ?? profile.timeoutSeconds ?? DEFAULTS.timeoutSeconds;
  const maxAttempts = positiveInt(flags.maxAttempts, "--max-attempts", 100) ?? profile.maxAttempts ?? DEFAULTS.maxAttempts;
  const consumer = validConsumer(flags.consumer ?? profile.consumer ?? defaultConsumer(profileName));
  const insecure = flags.insecure ?? profile.insecure ?? false;
  const chosenCwd = flags.cwd !== undefined ? resolve(flags.cwd) : profile.cwd;
  if (chosenCwd) assertTrustedDir(chosenCwd);
  const cwd = chosenCwd ?? workDir(profileName);

  if (flags.save) {
    changed = true;
    if (targetsGiven) {
      next.exec = exec ?? undefined;
      next.forward = forward ?? undefined;
      if (forward) delete next.forwardSecret;
    }
    if (flags.types !== undefined) next.types = types;
    if (filterFromFlags(flags)) next.filter = filter;
    if (exclusionsFromFlags(flags)) next.exclude = Object.keys(exclude).length ? exclude : undefined;
    const skip = skipFromFlags(flags);
    // Saved only when it differs from the default, so the profile follows the default if it changes.
    if (skip) next.skipCategories = skip.length === DEFAULT_SKIP_CATEGORIES.length ? undefined : skip;
    if (flags.batch !== undefined) next.batchSeconds = batchSeconds || undefined;
    if (flags.includeBody !== undefined) next.includeBody = includeBody;
    if (flags.concurrency !== undefined) next.concurrency = concurrency;
    if (flags.timeout !== undefined) next.timeoutSeconds = timeoutSeconds;
    if (flags.maxAttempts !== undefined) next.maxAttempts = maxAttempts;
    if (flags.consumer !== undefined) next.consumer = consumer;
    if (flags.insecure !== undefined) next.insecure = insecure;
    if (flags.cwd !== undefined) next.cwd = chosenCwd;
  }

  return { config: { exec, forward, types, typesDefaulted, filter, exclude, skipCategories, batchSeconds, includeBody, concurrency, timeoutSeconds, maxAttempts, consumer, insecure, cwd, cwdIsDefault: !chosenCwd }, next, changed };
}

/** Notes about the event types for the listener's log: the default in use, or types that overlap. */
export function typesNotes(c: Pick<EffectiveConfig, "types" | "typesDefaulted">): { info: string[]; warn: string[] } {
  const info: string[] = [];
  const warn: string[] = [];
  if (c.typesDefaulted) info.push(`Using default types: ${DEFAULT_LISTEN_TYPES.join(", ")} (add --types all for every event).`);
  if (c.types.length === EVENT_TYPES.length) {
    // Recommended for "every event", so a note rather than a warning.
    info.push("With all types, each reply also arrives as thread.reply_received: dedupe on the message id.");
  } else if (c.types.includes("message.received") && c.types.includes("thread.reply_received")) {
    warn.push(
      "thread.reply_received is a subset of message.received: with both, every reply to a thread you sent runs your command twice. Keep one of them (--types thread.reply_received for replies only).",
    );
  }
  return { info, warn };
}

/**
 * The category skip is newer than many profiles: when the profile has no skipCategories (the default) and no
 * category flag was given, one line saying what is now skipped and how to take it back.
 */
export function categoryNote(profileName: string, profile: Profile, flags: ListenFlags, c: Pick<EffectiveConfig, "filter" | "skipCategories">): string | null {
  if (profile.skipCategories !== undefined || flags.allCategories || flags.includeCategory?.length || flags.defaultCategories || !effectiveSkip(c).length) return null;
  const p = profileName === DEFAULT_PROFILE ? "" : ` --profile ${profileName}`;
  return `New: mail in Gmail's Promotions, Social and Forums tabs is now skipped by default. To get it back: \`${NPX} listen${p} --all-categories --save\` (or one tab: \`--include-category forums --save\`; for the service: \`${NPX} listen service install${p} --all-categories\`).`;
}

/** One-line description of the filter for the console. */
export function describeFilter(c: Pick<EffectiveConfig, "types" | "filter"> & Partial<Pick<EffectiveConfig, "exclude" | "skipCategories">>): string {
  const parts: string[] = [];
  if (c.types?.length) parts.push(c.types.length === EVENT_TYPES.length ? "all event types" : `types ${c.types.join(", ")}`);
  const f = c.filter ?? {};
  if (f.from?.length) parts.push(`from ${f.from.join(" | ")}`);
  if (f.to?.length) parts.push(`to ${f.to.join(" | ")}`);
  if (f.labelIds?.length) parts.push(`label ${f.labelIds.join(" | ")}`);
  if (f.subject) parts.push(`subject /${f.subject}/i`);
  if (f.hasAttachments !== undefined) parts.push(f.hasAttachments ? "with attachments" : "without attachments");
  if (c.exclude?.from?.length) parts.push(`not from ${c.exclude.from.join(" | ")}`);
  if (c.exclude?.labelIds?.length) parts.push(`not label ${c.exclude.labelIds.join(" | ")}`);
  const skipped = effectiveSkip(c);
  if (skipped.length) parts.push(`skipping Gmail ${skipped.map(categoryName).join(", ")}`);
  else if (c.skipCategories) parts.push("all Gmail categories");
  return parts.length ? parts.join(" · ") : "all events your grants can see";
}

/** Categories actually skipped: one named with --label is wanted, so it isn't skipped. */
export function effectiveSkip(c: { filter?: WebhookFilter; skipCategories?: readonly string[] }): string[] {
  const wanted = new Set(c.filter?.labelIds ?? []);
  return (c.skipCategories ?? []).filter((id) => !wanted.has(id));
}
