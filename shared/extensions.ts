// /api/extensions DTOs (server/api/extensions.ts), shared by the console and the CLI.

export type ExtensionKind = "remote" | "code";

/** An installed extension (or a candidate, before install). */
export interface ExtensionView {
  name: string;
  displayName: string;
  description: string;
  kind: ExtensionKind;
  version: string;
  /** A registry name, a GitHub or other repository URL, or a directory on xaq's machine. */
  source: string;
  /** The resolved commit; null for a directory. */
  commit: string | null;
  integrity: string;
  official: boolean;
  /** kind "code": the hosts it declares it talks to (declared, not enforced). */
  network: string[];
  /** Connections using it. */
  usedBy: string[];
  installedAt: string;
}

/** POST /api/extensions/resolve: what `source` would install, and the third-party warning (empty when official). */
export interface ExtensionResolveResult {
  candidate: ExtensionView;
  warnings: string[];
  /** The same name, already installed. */
  installed: ExtensionView | null;
}

/** POST /api/extensions/:name/update. `update` null: already up to date. `installed`: whether it was applied. */
export interface ExtensionUpdateResult {
  update: { from: ExtensionView; to: ExtensionView; warnings: string[] } | null;
  installed: boolean;
}

/** GET /api/extensions/registry: the official index, with what's installed. */
export interface ExtensionRegistryEntryView {
  name: string;
  displayName: string;
  description: string;
  kind: ExtensionKind;
  version: string;
  commit: string;
  integrity: string;
  /** The installed extension of that name, if any (official or not). */
  installed: { version: string; integrity: string; official: boolean } | null;
}

/** The error body for 409s that carry more than a message (in_use, third_party_unconfirmed, changed). */
export interface ExtensionErrorBody {
  error: { code: string; message: string; hint?: string };
  usedBy?: string[];
  warnings?: string[];
  candidate?: ExtensionView;
}
