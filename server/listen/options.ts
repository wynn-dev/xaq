import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { EVENT_TYPES, type EventType, isEventType } from "../../shared/types.ts";
import { workDir } from "./paths.ts";
import type { ListenSettings, Profile } from "./profile.ts";
import { parseRecipeTool, recipe } from "./recipes.ts";

/**
 * `listen` flags. The settings flags (--recipe, --exec, --types, --not-from, --all-categories, --include-body)
 * replace the saved settings as a whole when any is given; `listen service install` saves them.
 */
export interface ListenFlags {
  exec?: string;
  /** The built-in recipe (claude-code): its command becomes the exec, so no `$(…)` is needed. */
  recipe?: string;
  types?: string;
  notFrom?: string[];
  allCategories?: boolean;
  includeBody?: boolean;
  dryRun?: boolean;
  /** One-off: run every stored event from before the listener started through the command (own cursor and lock), then exit. */
  backfill?: boolean;
}

export interface EffectiveConfig {
  exec: string | null;
  /** Never empty: DEFAULT_LISTEN_TYPES unless --types or the saved settings say otherwise. */
  types: EventType[];
  /** No types given or saved: `types` is DEFAULT_LISTEN_TYPES. */
  typesDefaulted: boolean;
  /** Senders to skip (listener-side, never sent to the daemon). */
  notFrom: string[];
  /** Gmail category label ids whose messages are skipped (default: promotions, social, forums). */
  skipCategories: string[];
  includeBody: boolean;
  consumer: string;
  insecure: boolean;
  /** Working directory for commands: the private work dir. */
  cwd: string;
}

/** Events handled at once, the per-event time limit and attempts before an event is given up on. */
export const LIMITS = { concurrency: 2, timeoutSeconds: 300, maxAttempts: 5 } as const;

/** Gmail's bulk tabs, skipped by default: one paid agent run per newsletter or social ping is rarely wanted. */
export const DEFAULT_SKIP_CATEGORIES: readonly string[] = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"];

/**
 * Event types a listener gets when no types are given: new mail only. Each event can start a paid agent
 * run, so mail the account sends (message.sent, also the console's test email) and label changes don't
 * wake it unless asked for with --types.
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

/** Suffixes of the throwaway cursors `--backfill` and `--dry-run` derive from the consumer (the daemon reserves them too). */
export const THROWAWAY_SUFFIXES = { backfill: "-replay", dryRun: "-dry-run" } as const;

/**
 * The throwaway cursor for `consumer`: `<consumer><suffix>`, or, when that would pass the 100-character
 * limit, a truncated name plus a hash of the full one, so two long consumers never share a cursor.
 */
export function throwawayConsumer(consumer: string, suffix: (typeof THROWAWAY_SUFFIXES)[keyof typeof THROWAWAY_SUFFIXES]): string {
  if (consumer.length + suffix.length <= 100) return `${consumer}${suffix}`;
  const hash = createHash("sha256").update(consumer).digest("hex").slice(0, 8);
  return `${consumer.slice(0, 100 - suffix.length - hash.length - 1)}-${hash}${suffix}`;
}

/** Default consumer: one server-side cursor per machine. */
export function defaultConsumer(): string {
  const host = hostname()
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return host || "host";
}

/** The listener settings the flags name, or null when no settings flag was given. */
function settingsFromFlags(f: ListenFlags): ListenSettings | null {
  if (f.recipe === undefined && f.exec === undefined && f.types === undefined && f.notFrom === undefined && f.allCategories === undefined && f.includeBody === undefined) return null;
  if (f.recipe !== undefined && f.exec !== undefined) throw new Error("--recipe and --exec can't be combined: --recipe claude-code already sets the command.");
  // --recipe exists so nobody has to write `--exec "$(npx … )"`: inside `$(…)` npx's "Ok to proceed?" prompt becomes part of the command.
  const exec = f.recipe !== undefined ? recipe(parseRecipeTool(f.recipe)).exec : f.exec;
  if (exec !== undefined && !exec.trim()) throw new Error("--exec needs a command.");
  const notFrom = f.notFrom?.map((g) => g.trim().toLowerCase()).filter(Boolean);
  return {
    exec,
    types: f.types !== undefined ? parseTypes(f.types) : undefined,
    notFrom: notFrom?.length ? [...new Set(notFrom)] : undefined,
    allCategories: f.allCategories || undefined,
    includeBody: f.includeBody || undefined,
  };
}

/**
 * The effective config: the flags' settings when any settings flag was given, else the saved ones.
 * `settings` is what `listen service install` saves.
 */
export function resolveListen(profile: Profile, flags: ListenFlags): { config: EffectiveConfig; settings: ListenSettings } {
  const settings = settingsFromFlags(flags) ?? { exec: profile.exec, types: profile.types, notFrom: profile.notFrom, allCategories: profile.allCategories, includeBody: profile.includeBody };
  const typesDefaulted = !settings.types?.length;
  return {
    config: {
      exec: settings.exec ?? null,
      types: typesDefaulted ? [...DEFAULT_LISTEN_TYPES] : settings.types!,
      typesDefaulted,
      notFrom: settings.notFrom ?? [],
      skipCategories: settings.allCategories ? [] : [...DEFAULT_SKIP_CATEGORIES],
      includeBody: settings.includeBody ?? false,
      consumer: profile.consumer,
      insecure: profile.insecure ?? false,
      cwd: workDir(),
    },
    settings,
  };
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

const categoryName = (id: string) => id.replace(/^CATEGORY_/, "").toLowerCase();

/** One-line description of what the listener takes, for the banner and `listen status`. */
export function describeFilter(c: Pick<EffectiveConfig, "types" | "notFrom" | "skipCategories">): string {
  const parts = [c.types.length === EVENT_TYPES.length ? "all event types" : `types ${c.types.join(", ")}`];
  if (c.notFrom.length) parts.push(`not from ${c.notFrom.join(" | ")}`);
  parts.push(c.skipCategories.length ? `skipping Gmail ${c.skipCategories.map(categoryName).join(", ")}` : "all Gmail categories");
  return parts.join(" · ");
}
