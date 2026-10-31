// Console decisions for the Extensions page as pure functions, tested directly.
// No React and relative imports only: vitest loads this module too.

import type { ExtensionRegistryEntryView, ExtensionView } from "../../../shared/extensions.ts";

export const shortCommit = (c: string | null) => (c ? c.slice(0, 12) : "local directory");

/** "Official" or "Third-party", with the tone the badge uses. */
export function originView(e: Pick<ExtensionView, "official">): { label: string; tone: "good" | "warn" } {
  return e.official ? { label: "Official", tone: "good" } : { label: "Third-party", tone: "warn" };
}

/** What a registry entry offers: install it, it's installed, an update, or a same-named third-party one is in the way. */
export type RegistryAction = "install" | "installed" | "update" | "conflict";

export function registryAction(e: ExtensionRegistryEntryView): RegistryAction {
  if (!e.installed) return "install";
  if (!e.installed.official) return "conflict";
  return e.installed.integrity === e.integrity ? "installed" : "update";
}

export interface DiffRow {
  label: string;
  from: string;
  to: string;
  changed: boolean;
}

/** The update dialog's rows: version, commit and integrity always; kind, source and network hosts when they change. */
export function updateRows(from: ExtensionView, to: ExtensionView): DiffRow[] {
  const row = (label: string, a: string, b: string): DiffRow => ({ label, from: a, to: b, changed: a !== b });
  const hosts = (e: ExtensionView) => (e.network.length ? e.network.join(", ") : "none");
  const rows = [row("Version", from.version, to.version), row("Commit", shortCommit(from.commit), shortCommit(to.commit)), row("Integrity", from.integrity, to.integrity)];
  if (from.kind !== to.kind) rows.push(row("Kind", from.kind, to.kind));
  if (from.source !== to.source) rows.push(row("Source", from.source, to.source));
  if ((from.kind === "code" || to.kind === "code") && hosts(from) !== hosts(to)) rows.push(row("Network hosts", hosts(from), hosts(to)));
  return rows;
}

/**
 * Official registry extensions the "Add connection" picker offers to install: not installed under that name, and not
 * already a preset (an installed one is).
 */
export function installableExtensions(registry: readonly ExtensionRegistryEntryView[] | undefined, presetIds: readonly string[]): ExtensionRegistryEntryView[] {
  return (registry ?? []).filter((e) => !e.installed && !presetIds.includes(e.name));
}

/** "Used by" in words. */
export const usedByLabel = (usedBy: string[]) => (usedBy.length ? usedBy.join(", ") : "No connections");
