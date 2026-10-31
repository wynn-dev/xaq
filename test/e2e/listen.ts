// Harness hooks for device-flow pairing and the /agent/v1 listener stream (feat/listen-server) and
// for the `xaq connect` / `listen` CLI (feat/listen-client). Contract: shared/agent-api.ts on
// feat/listen-server. Types are local so this file compiles on main before those PRs land.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GrantInput, WebhookPayload } from "../../shared/types.ts";
import { REPO_ROOT } from "./features.ts";
import { resilientFetch } from "./fetch.ts";
import type { AdminClient, Stack } from "./harness.ts";
import { waitFor } from "./wait.ts";

// ───────────── Device-flow pairing ─────────────

export interface PairingStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  interval: number;
}

export type PairingPoll =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "approved"; apiKey: string; agent: { id: string; name: string }; mcpUrl: string; skillUrl: string }
  | { status: "denied"; note: string | null }
  | { status: "expired" }
  | { status: "consumed" };

export interface PairingRequest {
  id: string;
  userCode: string;
  name: string;
  status: "pending" | "approved" | "denied" | "expired";
  agentId: string | null;
  ip: string | null;
  client: Record<string, string>;
  decisionNote: string | null;
}

export interface AgentSelf {
  id: string;
  name: string;
  grants: { accountId: string; accountEmail: string; level: string; allowTo: string[] }[];
  mcpUrl: string;
  skillUrl: string;
  headSeq: number;
}

export interface Reply<T> {
  status: number;
  body: T;
}

async function call<T>(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await resilientFetch(url, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

/** POST /agent/v1/pairings (public), as `xaq connect` does. */
export const startPairing = (base: string, input: { name: string; description?: string; requested?: Record<string, unknown>; client?: Record<string, unknown> }, headers?: Record<string, string>) =>
  call<PairingStart>(`${base}/agent/v1/pairings`, { body: input, headers });

/** POST /agent/v1/pairings/poll (public). */
export const pollPairing = (base: string, deviceCode: string) => call<PairingPoll>(`${base}/agent/v1/pairings/poll`, { body: { deviceCode } });

export const agentMe = (base: string, key: string) => call<AgentSelf>(`${base}/agent/v1/me`, { headers: bearer(key) });

export const ackEvents = (base: string, key: string, consumer: string, seq: number) =>
  call<{ ackedSeq: number }>(`${base}/agent/v1/events/ack`, { body: { consumer, seq }, headers: bearer(key) });

/** Console side: the pending request showing this user code. */
export async function findPairing(admin: AdminClient, userCode: string, status = "pending"): Promise<PairingRequest> {
  const list = await admin.get<PairingRequest[]>(`/api/pairings?status=${status}`);
  const found = list.find((p) => p.userCode === userCode);
  if (!found) throw new Error(`no ${status} pairing with code ${userCode}`);
  return found;
}

export const approvePairing = (admin: AdminClient, id: string, userCode: string, grants: GrantInput[], name?: string) =>
  admin.post<{ id: string; name: string; grants: unknown[] }>(`/api/pairings/${id}/approve`, { userCode, grants, ...(name ? { name } : {}) });

export const denyPairing = (admin: AdminClient, id: string, note?: string) => admin.post<PairingRequest>(`/api/pairings/${id}/deny`, { note });

/**
 * Replaces the agent API's in-process options (the server exposes them for tests: poll interval,
 * code TTL, clock). Must run before pairings start; a restart resets them.
 */
export async function setAgentApiOptions(stack: Stack, options: { intervalSeconds?: number; ttlMs?: number; collectGraceMs?: number; heartbeatMs?: number }): Promise<void> {
  const mod = (await import(/* @vite-ignore */ join(REPO_ROOT, "server", "agentapi", "index.ts"))) as {
    agentApi: (ctx: unknown, options?: Record<string, unknown>) => unknown;
  };
  mod.agentApi(stack.ctx, options);
}

/** Full pairing over HTTP: start → admin approves the matching code → poll until the key arrives. */
export async function pairAgent(stack: Stack, name: string, grants: GrantInput[]): Promise<{ apiKey: string; agentId: string; start: PairingStart }> {
  const start = await startPairing(stack.url, { name, client: { tool: "other", hostname: "e2e", platform: "linux" } });
  if (start.status !== 200) throw new Error(`pairing start failed: ${start.status} ${JSON.stringify(start.body)}`);
  const req = await findPairing(stack.admin, start.body.userCode);
  await approvePairing(stack.admin, req.id, start.body.userCode, grants);
  const poll = await waitFor(
    async () => {
      const r = await pollPairing(stack.url, start.body.deviceCode);
      return r.body.status === "approved" ? r.body : r.body.status === "pending" || r.body.status === "slow_down" ? null : Promise.reject(new Error(r.body.status));
    },
    { interval: start.body.interval * 1000 + 50, timeout: 10_000, what: "approved poll" },
  );
  return { apiKey: poll.apiKey, agentId: poll.agent.id, start: start.body };
}

// ───────────── Agent event stream (/agent/v1/events/stream) ─────────────

export interface SseEvent {
  id: string | null;
  event: string;
  data: string;
}

export interface AgentStream {
  status: number;
  /** Error body when the stream was refused. */
  error: { error?: { code?: string } } | null;
  events: SseEvent[];
  /** `event: mail` frames parsed. */
  mail(): (WebhookPayload & { seq: number })[];
  comments: string[];
  /** Resolves when the server closes the stream (or close() is called). */
  closed: Promise<void>;
  isClosed(): boolean;
  next(pred: (e: SseEvent) => boolean, timeout?: number): Promise<SseEvent>;
  close(): void;
}

export interface StreamQuery {
  consumer: string;
  after?: number;
  start?: "now" | "beginning";
  types?: string[];
  includeBody?: boolean;
  lastEventId?: number;
}

/** Opens the listener stream with a bearer key, as `xaq listen` does, parsing id/event/data frames. */
export async function openAgentStream(base: string, apiKey: string, q: StreamQuery): Promise<AgentStream> {
  const qs = new URLSearchParams({ consumer: q.consumer });
  if (q.after !== undefined) qs.set("after", String(q.after));
  if (q.start) qs.set("start", q.start);
  if (q.types?.length) qs.set("types", q.types.join(","));
  if (q.includeBody) qs.set("include_body", "1");
  const ctrl = new AbortController();
  const headers: Record<string, string> = { accept: "text/event-stream", ...bearer(apiKey) };
  if (q.lastEventId !== undefined) headers["last-event-id"] = String(q.lastEventId);
  const res = await resilientFetch(`${base}/agent/v1/events/stream?${qs}`, { headers, signal: ctrl.signal });
  let closedFlag = false;
  let resolveClosed!: () => void;
  const stream: AgentStream = {
    status: res.status,
    error: null,
    events: [],
    comments: [],
    mail: () => stream.events.filter((e) => e.event === "mail").map((e) => ({ ...(JSON.parse(e.data) as WebhookPayload), seq: Number(e.id) })),
    closed: new Promise<void>((r) => (resolveClosed = () => ((closedFlag = true), r()))),
    isClosed: () => closedFlag,
    next: (pred, timeout = 8000) => waitFor(() => stream.events.find(pred), { timeout, what: "agent stream frame" }),
    close: () => ctrl.abort(),
  };
  if (!res.ok || !res.body) {
    stream.error = (await res.json().catch(() => null)) as AgentStream["error"];
    resolveClosed();
    return stream;
  }
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev: SseEvent = { id: null, event: "message", data: "" };
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) stream.comments.push(line.slice(1).trim());
            else if (line.startsWith("id:")) ev.id = line.slice(3).trim();
            else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (data.length) stream.events.push({ ...ev, data: data.join("\n") });
        }
      }
    } catch {
      // aborted
    } finally {
      resolveClosed();
    }
  })();
  await waitFor(() => stream.comments.includes("connected") || closedFlag, { timeout: 3000, what: "stream connected" });
  return stream;
}

// ───────────── CLI (dist/cli.js) ─────────────

let builtCli: string | null = null;
const tempDirs = new Set<string>();

/** A temp dir removed by cleanupListenTemp(). */
function tempDir(prefix: string, parent = tmpdir()): string {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, prefix));
  tempDirs.add(dir);
  return dir;
}

/**
 * Builds dist/cli.js from this checkout into a private temp dir (tsdown, ~1 s), once per test
 * process, so concurrent runs in one checkout never race on dist/. The dir sits under
 * node_modules/.cache so the bundle's external imports resolve from the checkout's node_modules,
 * with package.json next to it (the CLI reads its version from ../package.json).
 */
export function buildCli(): string {
  if (builtCli) return builtCli;
  const root = tempDir("e2e-cli-", join(REPO_ROOT, "node_modules", ".cache", "xaq-e2e"));
  const outDir = join(root, "dist");
  copyFileSync(join(REPO_ROOT, "package.json"), join(root, "package.json"));
  const config = join(root, "tsdown.e2e.config.mjs");
  writeFileSync(
    config,
    `import configs from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, "tsdown.config.mjs")).href)};
const repo = ${JSON.stringify(REPO_ROOT)};
// The repo's configs (server, attachment parser) with paths made absolute (tsdown resolves relative ones from
// this config's dir). Only the first cleans; only the one that copies SKILL.md copies it.
export default (Array.isArray(configs) ? configs : [configs]).map((base, i) => ({
  ...base,
  cwd: repo,
  entry: Object.fromEntries(Object.entries(base.entry).map(([k, v]) => [k, repo + "/" + v])),
  outDir: ${JSON.stringify(outDir)},
  clean: i === 0,
  ...(base.copy ? { copy: [{ from: repo + "/server/skill/SKILL.md", to: ${JSON.stringify(join(outDir, "skill"))} }] } : {}),
}));
`,
  );
  execFileSync("pnpm", ["exec", "tsdown", "--config", config, "--config-loader", "native"], { cwd: REPO_ROOT, stdio: "pipe", env: { ...process.env, CI: "1" } });
  builtCli = join(outDir, "cli.js");
  return builtCli;
}

const running = new Set<CliProcess>();

/** Kills every CLI process still running (afterEach/afterAll), so a failing test never leaks one. */
export async function killAllCli(): Promise<void> {
  await Promise.all([...running].map((p) => p.kill("SIGKILL")));
}

/** Removes the CLI build, homes and exec dirs (afterAll). */
export function cleanupListenTemp(): void {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  builtCli = null;
}

export interface CliHome {
  root: string;
  env: Record<string, string>;
  configDir: string;
  stateDir: string;
}

/** An isolated HOME with XDG config/state/data dirs, so profiles and logs never touch the real ones. */
export function cliHome(): CliHome {
  const root = tempDir("xaq-cli-");
  const configDir = join(root, ".config");
  const stateDir = join(root, ".local", "state");
  const env = { HOME: root, XDG_CONFIG_HOME: configDir, XDG_STATE_HOME: stateDir, XDG_DATA_HOME: join(root, ".local", "share") };
  return { root, env, configDir, stateDir };
}

export interface CliProcess {
  proc: ChildProcess;
  stdout: string[];
  stderr: string[];
  output(): string;
  waitForOutput(re: RegExp, timeout?: number): Promise<RegExpMatchArray>;
  exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): Promise<number | null>;
}

/** Runs `node dist/cli.js <args>` with an argv array (no shell) in an isolated home. */
export function spawnCli(args: string[], home: CliHome, extraEnv: Record<string, string> = {}): CliProcess {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("XAQ_") && !k.startsWith("XDG_")) env[k] = v;
  const proc = spawn(process.execPath, [buildCli(), ...args], {
    cwd: home.root,
    env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0", ...home.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  proc.stdout!.on("data", (c: Buffer) => stdout.push(c.toString("utf8")));
  proc.stderr!.on("data", (c: Buffer) => stderr.push(c.toString("utf8")));
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  const output = () => stdout.join("") + stderr.join("");
  const cli: CliProcess = {
    proc,
    stdout,
    stderr,
    output,
    waitForOutput: (re, timeout = 10_000) => waitFor(() => output().match(re), { timeout, what: `CLI output ${re}` }),
    exited,
    async kill(signal = "SIGTERM") {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
      return exited;
    },
  };
  running.add(cli);
  void exited.then(() => running.delete(cli));
  return cli;
}

/** A fresh dir for a command recorder (removed by cleanupListenTemp). */
export const execDir = () => tempDir("xaq-exec-");

// ───────────── Command recorder (the --exec target) ─────────────

export interface RecordedCall {
  stdin: string;
  argv: string[];
  /** XAQ_* variables the command saw. */
  env: Record<string, string>;
  /** $XAQ_EVENT_FILE as the command saw it (content and permission bits). */
  eventFile: { content: string; mode: number } | { error: string } | null;
}

export interface CommandRecorder {
  /** Pass to `listen --exec`. A fixed string: paths only, no event data. */
  command: string;
  calls(): RecordedCall[];
  /** Created only if injected shell syntax runs. */
  canary: string;
}

/** A node script that records stdin, argv and XAQ_* env of each invocation as one JSON file. */
export function commandRecorder(dir: string): CommandRecorder {
  const calls = join(dir, "calls");
  mkdirSync(calls, { recursive: true });
  const script = join(dir, "record.mjs");
  writeFileSync(
    script,
    `import { readFileSync, statSync, writeFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("XAQ_")));
let eventFile = null;
try {
  const f = process.env.XAQ_EVENT_FILE;
  if (f) eventFile = { content: readFileSync(f, "utf8"), mode: statSync(f).mode & 0o777 };
} catch (e) { eventFile = { error: String(e) }; }
writeFileSync(${JSON.stringify(calls)} + "/" + process.hrtime.bigint() + "-" + process.pid + ".json", JSON.stringify({ stdin, argv: process.argv.slice(2), env, eventFile }));
`,
  );
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return {
    command: `${q(process.execPath)} ${q(script)}`,
    canary: join(dir, "PWNED"),
    calls: () =>
      readdirSync(calls)
        .sort()
        .map((f) => JSON.parse(readFileSync(join(calls, f), "utf8")) as RecordedCall),
  };
}
