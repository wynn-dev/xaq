// The code-extension host (docs/EXTENSIONS.md "The code-extension host"). See source.ts for the protocol and the
// lifecycle, spawn.ts for the argv, environment and state directory, transport.ts for the stdio pipe.

import { type NativeSourceDeps, SourceError, type ToolSource } from "../../broker/types.ts";
import { createCodeSource } from "./source.ts";
import { extensionStateDir } from "./spawn.ts";
import type { ExtensionVerifier, InstalledExtension } from "./types.ts";

export { CodeToolSource, CREDENTIALS_ERROR, createCodeSource } from "./source.ts";
export {
  belowRecommendedNode,
  CHILD_PRELOAD,
  CODE_EXTENSION_NODE_FLOOR,
  childArgs,
  childEnv,
  codeExtensionNodeProblem,
  ensureStateDir,
  entryPath,
  extensionStateDir,
  NODE_HAS_ALLOW_NET,
  RECOMMENDED_NODE,
  removeConnectionState,
  XAQ_EXT_PROTOCOL,
} from "./spawn.ts";
export type { CodeManifest, CodeSourceDeps, ExtensionVerifier, HostLimits, InstalledExtension } from "./types.ts";
export { codeManifestOf, DEFAULT_LIMITS } from "./types.ts";

/**
 * A code extension's ToolSource from the broker's native-source deps (what IntegrationPreset.createSource gets):
 * the state directory under deps.dataDir, the outbox through deps.emit, and the store's integrity re-check. For
 * presetFromManifest: `createSource: (deps) => codeExtensionSource(ext, deps, store)`.
 */
export function codeExtensionSource(ext: InstalledExtension, deps: NativeSourceDeps, store: ExtensionVerifier): ToolSource {
  const { dataDir, emit } = deps;
  if (!dataDir || !emit) {
    const message = "This build of xaq can't run code extensions (the broker didn't pass a data directory and an event outbox)";
    return {
      connectionId: deps.connectionId,
      listTools: () => Promise.reject(new SourceError("unavailable", message)),
      callTool: () => Promise.reject(new SourceError("unavailable", message)),
      close: async () => {},
    };
  }
  return createCodeSource(ext, {
    ...deps,
    stateDir: extensionStateDir(dataDir, ext.name, deps.connectionId),
    emit,
    verify: () => store.verify(ext.name),
  });
}
