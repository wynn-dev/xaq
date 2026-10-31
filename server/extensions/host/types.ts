// What the code-extension host needs from the rest of the extensions system (docs/EXTENSIONS.md): the store's
// InstalledExtension and its integrity re-check (server/extensions/store.ts).

import type { IntegrationEvent, NativeSourceDeps } from "../../broker/types.ts";
import type { ExtensionStore } from "../store.ts";

export type { InstalledExtension } from "../store.ts";

/** The store's integrity re-check: recomputes the install's integrity and compares it with the recorded one. */
export type ExtensionVerifier = Pick<ExtensionStore, "verify">;

/** What createCodeSource needs, beyond the native-source deps. */
export interface CodeSourceDeps extends NativeSourceDeps {
  connectionId: string;
  /** `<dataDir>/extension-state/<name>/<connectionId>/` (extensionStateDir); created here, mode 0700. */
  stateDir: string;
  /** Into the events outbox (the caller keeps the `<preset>.*` and per-connection checks). */
  emit(e: IntegrationEvent): void;
  /** The integrity re-check before every start: false refuses to start. */
  verify(): boolean;
  /** Tests: limits and timings. */
  limits?: Partial<HostLimits>;
  /** Tests: the Node binary (default process.execPath). */
  execPath?: string;
  /** Tests: the Node version the floor is checked against (default process.versions.node, which runs the child). */
  nodeVersion?: string;
}

export interface HostLimits {
  /** Tool calls (and prompt/resource requests) in flight per connection; more are refused at once. */
  maxConcurrent: number;
  /** Largest JSON-RPC message (one stdout line) from the child, in bytes; a longer one kills the child. */
  maxMessageBytes: number;
  /** Longest stderr line kept, in characters (the rest is cut). */
  maxStderrLine: number;
  /** stderr lines kept for the crash report. */
  stderrLines: number;
  /** Spawn plus the MCP initialize handshake. */
  startTimeoutMs: number;
  /** tools/list, prompts/list, resources/list. */
  listTimeoutMs: number;
  /** tools/call, prompts/get, resources/read. */
  callTimeoutMs: number;
  /** SIGTERM, then SIGKILL after this. */
  killAfterMs: number;
  /** First crash restart delay; doubles per consecutive crash. */
  restartBaseMs: number;
  restartMaxMs: number;
  /** Consecutive crashes before the connection is marked `error` and restarts stop. */
  maxCrashes: number;
  /** A child that ran this long without crashing resets the crash count. */
  stableAfterMs: number;
  /** xaq/log: burst and refill per second. */
  logBurst: number;
  logPerSecond: number;
  /** xaq/events/emit: burst and refill per second. */
  eventBurst: number;
  eventPerSecond: number;
  /** xaq/events/emit: largest `data`, as JSON. */
  maxEventBytes: number;
}

export const DEFAULT_LIMITS: HostLimits = {
  maxConcurrent: 8,
  maxMessageBytes: 8 * 1024 * 1024,
  maxStderrLine: 300,
  stderrLines: 20,
  startTimeoutMs: 15_000,
  listTimeoutMs: 30_000,
  callTimeoutMs: 60_000,
  killAfterMs: 5_000,
  restartBaseMs: 1_000,
  restartMaxMs: 60_000,
  maxCrashes: 5,
  stableAfterMs: 60_000,
  logBurst: 20,
  logPerSecond: 1,
  eventBurst: 30,
  eventPerSecond: 1,
  maxEventBytes: 8 * 1024,
};

/** The part of the manifest the host reads (kind "code"). The manifest module validated it; this re-checks the shape. */
export interface CodeManifest {
  entry: string;
  events: string[];
}

/** Reads `manifest.code` defensively: null when it isn't a code manifest the host can run. */
export function codeManifestOf(manifest: unknown): CodeManifest | null {
  const code = (manifest as { code?: unknown } | null)?.code;
  if (!code || typeof code !== "object") return null;
  const { entry, events } = code as { entry?: unknown; events?: unknown };
  if (typeof entry !== "string" || !entry) return null;
  const list = Array.isArray(events) ? events.filter((e): e is string => typeof e === "string") : [];
  return { entry, events: list };
}
