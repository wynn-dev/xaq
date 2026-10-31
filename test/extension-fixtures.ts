// Extension fixtures for tests: copies of the xaq-extensions repo's manifests (test/fixtures/extensions/<name>/
// xaq-extension.json; refresh them when the repo's change).

import { readFileSync } from "node:fs";
import type { InstalledExtension } from "../server/extensions/store.ts";
import type { Manifest } from "../server/extensions/manifest.ts";
import { useExtensionStore } from "../server/integrations/index.ts";

export const FIXTURE_EXTENSIONS = ["notion", "t3code", "brightspace"] as const;
export type FixtureExtension = (typeof FIXTURE_EXTENSIONS)[number];

/** The parsed manifest JSON, as the repo has it. */
export function fixtureManifest(name: FixtureExtension): Manifest {
  return JSON.parse(readFileSync(new URL(`./fixtures/extensions/${name}/xaq-extension.json`, import.meta.url), "utf8")) as Manifest;
}

export function fixtureExtension(name: FixtureExtension, over: Partial<InstalledExtension> = {}): InstalledExtension {
  const manifest = fixtureManifest(name);
  return {
    name,
    kind: manifest.kind,
    version: manifest.version,
    source: "registry:wynn-dev/xaq-extensions",
    commit: "1111111111111111111111111111111111111111",
    integrity: `sha256-${Buffer.alloc(32, name.length).toString("base64")}`,
    official: true,
    installDir: `/nonexistent/extensions/${name}`,
    manifest,
    installedAt: "2026-10-16T00:00:00.000Z",
    ...over,
  };
}

/** Installs the fixture extensions into presets() for this test file; returns the undo. */
export function useFixtureExtensions(names: readonly FixtureExtension[] = FIXTURE_EXTENSIONS): () => void {
  useExtensionStore({ list: () => names.map((n) => fixtureExtension(n)) });
  return () => useExtensionStore(null);
}
