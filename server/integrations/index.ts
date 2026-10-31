// The preset registry (docs/MCP-BROKER.md "Pre-made integrations", docs/EXTENSIONS.md). Pre-made connections are
// extensions: each installed extension's manifest becomes an IntegrationPreset (server/extensions/manifest.ts). No
// preset is left in core (WHOOP is a code extension, run by server/extensions/host). The broker service, the
// connections API (presets list, create from a preset) and the classifier read them from here.
//
// Rules for entries:
// - `id` is the extension's name. It's stored in connections.preset (which binds the connection to the extension)
//   and names its events `<id>.<name>`; it can't be one of xaq's own event prefixes (message, calendar, connection, …).
// - Remote presets give `url` and `auth`, or `userServer` when the user names the server (T3 Code, Brightspace);
//   native ones give `createSource` (and `events`).
//
// presets() is synchronous for its callers and cached. The broker's start() registers the store
// (useExtensionStore) and its onChange hook calls reloadPresets() after an install, update or remove.

import type { IntegrationPreset } from "../broker/types.ts";
import { presetFromManifest } from "../extensions/manifest.ts";
import type { ExtensionStore, InstalledExtension } from "../extensions/store.ts";

/** Display order for the official extensions; anything else follows by name. */
const ORDER = ["notion", "whoop", "t3code", "brightspace"];

/** What presets() needs from the extension store. */
export type PresetSource = Pick<ExtensionStore, "list">;

let store: PresetSource | null = null;
let core: IntegrationPreset[] | null = null;
let cached: IntegrationPreset[] | null = null;
/** Presets of installed extensions, by name and integrity: the same install keeps the same object across reloads. */
const built = new Map<string, IntegrationPreset>();
/** Installed extensions whose manifest didn't load (name → why), for diagnostics. */
const broken = new Map<string, string>();

/**
 * Presets still in core: none. WHOOP left core for its code extension (server/extensions/host); its connections show
 * "Needs the whoop extension" until it's installed.
 */
const corePresets = (): IntegrationPreset[] => (core ??= []);

function extensionPreset(ext: InstalledExtension): IntegrationPreset | null {
  const key = `${ext.name}\0${ext.integrity}`;
  const hit = built.get(key);
  if (hit) return hit;
  try {
    const p = presetFromManifest(ext);
    built.set(key, p);
    broken.delete(ext.name);
    return p;
  } catch (err) {
    broken.set(ext.name, (err as Error).message);
    return null;
  }
}

const rank = (id: string) => {
  const i = ORDER.indexOf(id);
  return i === -1 ? ORDER.length : i;
};

function build(): IntegrationPreset[] {
  const installed = (store?.list() ?? []).flatMap((ext) => extensionPreset(ext) ?? []);
  const names = new Set(installed.map((p) => p.id));
  const all = [...installed, ...corePresets().filter((p) => !names.has(p.id))];
  return all.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** Every pre-made integration, in display order: installed extensions, then presets still in core. */
export const presets = (): IntegrationPreset[] => (cached ??= build());

export const presetById = (id: string): IntegrationPreset | null => presets().find((p) => p.id === id) ?? null;

/** Rebuilds presets() on next use: after an extension was installed, updated or removed. */
export function reloadPresets(): void {
  cached = null;
}

/** The extension store presets() reads (set once at startup; tests set a stub and reset it with null). */
export function useExtensionStore(s: PresetSource | null): void {
  store = s;
  built.clear();
  broken.clear();
  reloadPresets();
}

/** The store presets() reads (null: core presets only). */
export const presetSource = (): PresetSource | null => store;

/** Installed extensions whose manifest didn't load, with the reason (they offer no preset). */
export const brokenExtensions = (): ReadonlyMap<string, string> => {
  presets();
  return broken;
};
