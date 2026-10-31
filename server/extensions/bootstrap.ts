// Migration from core presets to extensions, with no re-auth (docs/EXTENSIONS.md "Migration from core presets").
//
// A connection is bound to an extension by `connections.preset`, which holds the extension's name: the Notion,
// T3 Code and WHOOP presets' ids are those extensions' names, so their connections are bound as they are. Nothing in
// the row changes, nor anything else of the connection: tokens, client records, grants, levels,
// slug and exposed tool names stay as they were, so nobody signs in again.
//
// At startup every bound extension that isn't installed is installed in the background from its bootstrap pin
// (bootstrap.json: name, commit, integrity of the official extensions at release time). Until then a connection of
// an official remote extension that core carries a data snapshot of (bootstrap/notion.json, bootstrap/t3code.json)
// works under that snapshot: its risk map, setup copy, sign-in rules and policies, so nothing gets looser and a
// reconnect still works. Any other bound connection has no preset: a remote one runs on the generic rules and can't
// be reconnected; a code one's tools are unavailable.

import type { Db } from "../db/index.ts";
import { reloadPresets } from "../integrations/index.ts";
import { errorMessage } from "../util/errors.ts";
import pinsJson from "./bootstrap.json" with { type: "json" };
import { presetFromManifest } from "./manifest.ts";
import type { ExtensionPin, ExtensionStore, InstalledExtension } from "./store.ts";

/** The official extensions' pins at release time. */
export const BOOTSTRAP_PINS: readonly ExtensionPin[] = pinsJson;

const PLACEHOLDER_COMMIT = /^0{40}$/;

/** A pin the release hasn't filled in yet (all-zero commit): nothing to install. */
export const isPlaceholderPin = (pin: ExtensionPin): boolean => PLACEHOLDER_COMMIT.test(pin.commit);

/** The ids of the connections bound to an extension (ExtensionStore.usedBy), oldest first. */
export function usedBy(db: Pick<Db, "all">, name: string): string[] {
  return db.all<{ id: string }>("SELECT id FROM connections WHERE preset = ? ORDER BY created_at, rowid", name).map((r) => r.id);
}

/** What the upgrade needs from the extension store. */
export type UpgradeStore = Pick<ExtensionStore, "list" | "get" | "installPinned" | "replacePinned">;

export interface UpgradeDeps {
  db: Pick<Db, "all">;
  store: UpgradeStore;
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  /** Default: BOOTSTRAP_PINS. */
  pins?: readonly ExtensionPin[];
  /** After a background install (presets() is already reloaded): drop cached tool views, re-list the connections. */
  onInstalled?(ext: InstalledExtension, connectionIds: string[]): void;
}

export interface UpgradeResult {
  /** Connections bound to a bootstrap extension, with its name. */
  bound: { connectionId: string; extension: string }[];
  /** Bound extensions that weren't installed, being installed now (or skipped: no pin yet). */
  missing: string[];
  /** Installed extensions whose manifest doesn't validate (name → why); official ones with a newer pin reinstall. */
  broken: Record<string, string>;
  /** Settles when the background installs are done (never rejects). */
  done: Promise<void>;
}

/** Installs in flight, per store: a second upgrade (or a restart of the service) doesn't install twice. */
const inFlight = new WeakMap<UpgradeStore, Map<string, Promise<void>>>();

/** The startup upgrade: binds legacy preset connections and installs missing extensions in the background. */
export function upgradeToExtensions(deps: UpgradeDeps): UpgradeResult {
  const pins = deps.pins ?? BOOTSTRAP_PINS;
  const byName = new Map(pins.map((p) => [p.name, p]));
  const rows = deps.db.all<{ id: string; preset: string }>("SELECT id, preset FROM connections WHERE preset IS NOT NULL ORDER BY created_at, rowid");
  const bound = rows.filter((r) => byName.has(r.preset)).map((r) => ({ connectionId: r.id, extension: r.preset }));
  const missing = [...new Set(bound.map((b) => b.extension))].filter((name) => !deps.store.get(name));
  if (bound.length) deps.log.info("Connections bound to extensions", { connections: bound.length, missing });

  // Installed extensions this xaq can't read (a manifest an older check let through, or files edited by hand): they
  // offer no preset, so their connections fall back to the bootstrap snapshot or the generic rules. Reported; an
  // official one is reinstalled from its pin when the pin is another build (the same build wouldn't read either).
  const broken: Record<string, string> = {};
  const repair: ExtensionPin[] = [];
  for (const ext of deps.store.list()) {
    try {
      presetFromManifest(ext);
    } catch (err) {
      broken[ext.name] = errorMessage(err);
      const pin = byName.get(ext.name);
      const fixable = ext.official && pin && !isPlaceholderPin(pin) && pin.integrity !== ext.integrity;
      deps.log.error("An installed extension's manifest doesn't load", { extension: ext.name, error: broken[ext.name], reinstall: !!fixable });
      if (fixable) repair.push(pin);
    }
  }

  const running = inFlight.get(deps.store) ?? new Map<string, Promise<void>>();
  inFlight.set(deps.store, running);
  const install = async (name: string) => {
    const pin = byName.get(name)!;
    if (isPlaceholderPin(pin)) {
      deps.log.warn("No release pin for this extension yet: its connections use the bootstrap snapshot or the generic rules until it's installed", { extension: name });
      return;
    }
    try {
      const ext = await deps.store.installPinned(pin);
      reloadPresets();
      deps.log.info("Installed an extension for existing connections", { extension: name, version: ext.version, commit: ext.commit });
      deps.onInstalled?.(ext, usedBy(deps.db, name));
    } catch (err) {
      deps.log.warn("Couldn't install an extension for existing connections: they use the bootstrap snapshot or the generic rules", { extension: name, error: errorMessage(err) });
    }
  };
  // The pinned build is fetched and verified first, then swapped in (store.replacePinned): offline, or on a bad pin,
  // the installed one stays as it was. Its connections stay bound throughout.
  const reinstall = async (pin: ExtensionPin) => {
    try {
      const ext = await deps.store.replacePinned(pin);
      reloadPresets();
      deps.log.info("Replaced a broken extension with its pinned build", { extension: pin.name, version: ext.version, commit: ext.commit });
      deps.onInstalled?.(ext, usedBy(deps.db, pin.name));
    } catch (err) {
      deps.log.warn("Couldn't replace a broken extension with its pinned build: it stays as it is", { extension: pin.name, error: errorMessage(err) });
    }
  };
  const job = (name: string, run: () => Promise<void>) => {
    let j = running.get(name);
    if (!j) {
      j = run().finally(() => running.delete(name));
      running.set(name, j);
    }
    return j;
  };
  const jobs = [...missing.map((name) => job(name, () => install(name))), ...repair.map((pin) => job(pin.name, () => reinstall(pin)))];
  return { bound, missing, broken, done: Promise.all(jobs).then(() => {}) };
}
