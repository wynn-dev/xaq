// One-click update from the console (server/update.ts): staging a given version with the supply-chain checks,
// the update job (`service install` of that version), the password-gated API with its audit entries, and the
// console's polling verdict. Nothing here reaches npm: npm and the service manager are fakes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelfUpdateHost } from "../server/api/system.ts";
import { installedVersion, type NpmRunner, type ServiceOps, shrinkwrapProblems, stagePackage, unitEnv } from "../server/service.ts";
import {
  launchdJobRunning,
  launchUpdateJob,
  readUpdateStatus,
  renderUpdatePlist,
  runUpdateJob,
  selfUpdateSupport,
  type UpdateJobRequest,
  updateJobCommand,
  writeUpdateStatus,
} from "../server/update.ts";
import type { SelfUpdateStatus } from "../shared/types.ts";
import { outcomeText, type PendingUpdate, updateVerdict } from "../src/lib/self-update.ts";
import { CSRF, harness, type Harness, json, PASSWORD } from "./platform-helpers.ts";

const dirs: string[] = [];
const tempDir = (prefix = "xaq-update-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes an install of `version` at `app` the way npm lays one out, with the given runtime dependencies. */
function writeInstall(app: string, version: string, deps: Record<string, string> = {}, opts: { shrinkwrap?: boolean; installed?: Record<string, string> } = {}) {
  const pkg = join(app, "node_modules", "xaq-cli");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "dist/cli.js"), `// ${version}\n`);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "xaq-cli", version }));
  if (opts.shrinkwrap !== false) {
    const packages: Record<string, unknown> = { "": { name: "xaq-cli", version } };
    for (const [name, v] of Object.entries(deps)) packages[`node_modules/${name}`] = { version: v, integrity: `sha512-${name}` };
    packages["node_modules/vite"] = { version: "8.0.0", dev: true };
    writeFileSync(join(pkg, "npm-shrinkwrap.json"), JSON.stringify({ lockfileVersion: 3, packages }));
  }
  for (const [name, v] of Object.entries(opts.installed ?? deps)) {
    mkdirSync(join(pkg, "node_modules", name), { recursive: true });
    writeFileSync(join(pkg, "node_modules", name, "package.json"), JSON.stringify({ name, version: v }));
  }
}

/** A fake npm: `install xaq-cli@<v>` lays out that version; `audit signatures` passes unless told otherwise. */
function fakeNpm(opts: { deps?: Record<string, string>; installed?: Record<string, string>; shrinkwrap?: boolean; signatures?: boolean; actual?: string } = {}) {
  const calls: string[][] = [];
  const run: NpmRunner = (args, cwd) => {
    calls.push(args);
    if (args[0] === "install") {
      const version = args[1]!.split("@")[1]!;
      writeInstall(cwd, opts.actual ?? version, opts.deps ?? { hono: "4.13.13" }, { shrinkwrap: opts.shrinkwrap, installed: opts.installed });
    }
    if (args[0] === "audit" && opts.signatures === false) {
      throw Object.assign(new Error("Command failed: npm audit signatures"), { stderr: "1 package has an invalid registry signature: hono@4.13.13\n" });
    }
    return "";
  };
  return { calls, run };
}

describe("stagePackage with a version", () => {
  it("installs exactly that version, with --ignore-scripts and both checks when hardened", () => {
    const staging = join(tempDir(), "app.new");
    const npm = fakeNpm();
    stagePackage(staging, { where: "test", requireWeb: false, version: "1.2.3", harden: true, npm: npm.run });
    expect(installedVersion(staging)).toBe("1.2.3");
    const install = npm.calls.find((a) => a[0] === "install")!;
    expect(install[1]).toBe("xaq-cli@1.2.3");
    expect(install).toContain("--ignore-scripts");
    expect(npm.calls.some((a) => a[0] === "audit" && a[1] === "signatures")).toBe(true);
    // No local pack: a version always comes from the registry, even from a source checkout.
    expect(npm.calls.some((a) => a[0] === "pack")).toBe(false);
  });

  it("leaves the checks out unless hardened", () => {
    const npm = fakeNpm({ shrinkwrap: false });
    stagePackage(join(tempDir(), "app.new"), { where: "test", requireWeb: false, version: "1.2.3", npm: npm.run });
    expect(npm.calls.find((a) => a[0] === "install")).not.toContain("--ignore-scripts");
    expect(npm.calls.some((a) => a[0] === "audit")).toBe(false);
  });

  it("takes only a plain release version", () => {
    for (const bad of ["latest", "^1.2.3", "file:../evil", "1.2", "1.2.3 --registry=http://x", "git+https://x/y"]) {
      expect(() => stagePackage(join(tempDir(), "app.new"), { where: "test", requireWeb: false, version: bad, npm: fakeNpm().run })).toThrow(/not a release version/);
    }
    expect(() => stagePackage(join(tempDir(), "app.new"), { where: "test", requireWeb: false, version: "0.1.0-nightly.94", npm: fakeNpm().run })).not.toThrow();
  });

  it("refuses when npm installed another version", () => {
    const staging = join(tempDir(), "app.new");
    expect(() => stagePackage(staging, { where: "test", requireWeb: false, version: "1.2.3", npm: fakeNpm({ actual: "1.2.4" }).run })).toThrow(/installed 1\.2\.4 instead of 1\.2\.3/);
    expect(existsSync(staging)).toBe(false);
  });
});

describe("hardening refusal", () => {
  const stageHardened = (npm: ReturnType<typeof fakeNpm>) => {
    const staging = join(tempDir(), "app.new");
    let error: Error | null = null;
    try {
      stagePackage(staging, { where: "test", requireWeb: false, version: "1.2.3", harden: true, npm: npm.run });
    } catch (err) {
      error = err as Error;
    }
    return { staging, error };
  };

  it("refuses a release without a shrinkwrap", () => {
    const { staging, error } = stageHardened(fakeNpm({ shrinkwrap: false }));
    expect(error?.message).toMatch(/left as it was.*Refused: the release has no npm-shrinkwrap\.json/);
    expect(existsSync(staging)).toBe(false);
  });

  it("refuses a dependency the shrinkwrap doesn't pin as installed", () => {
    const { staging, error } = stageHardened(fakeNpm({ deps: { hono: "4.13.13", zod: "4.6.7" }, installed: { hono: "4.13.14" } }));
    expect(error?.message).toMatch(/hono is 4\.13\.14, the shrinkwrap pins 4\.13\.13; zod 4\.6\.7 wasn't installed/);
    expect(existsSync(staging)).toBe(false);
  });

  it("refuses when npm audit signatures fails, and never gets that far without a shrinkwrap", () => {
    const npm = fakeNpm({ signatures: false });
    const { staging, error } = stageHardened(npm);
    expect(error?.message).toMatch(/Refused: `npm audit signatures` failed: 1 package has an invalid registry signature/);
    expect(existsSync(staging)).toBe(false);
    const unwrapped = fakeNpm({ shrinkwrap: false, signatures: false });
    stageHardened(unwrapped);
    expect(unwrapped.calls.some((a) => a[0] === "audit")).toBe(false);
  });

  it("finds a hoisted dependency, and skips dev and optional entries", () => {
    const staging = tempDir();
    writeInstall(staging, "1.2.3", { hono: "4.13.13" }, { installed: {} });
    mkdirSync(join(staging, "node_modules/hono"), { recursive: true });
    writeFileSync(join(staging, "node_modules/hono/package.json"), JSON.stringify({ version: "4.13.13" }));
    expect(shrinkwrapProblems(staging)).toEqual([]);
  });
});

// ───────────── The job ─────────────

const UNIT = `[Unit]
Description=xaq

[Service]
ExecStart="/usr/bin/node" "/data/app/node_modules/xaq-cli/dist/cli.js" start --no-open
Environment="PORT=9123"
Environment="HOST=127.0.0.1"
`;

/** A data directory with the service on 1.0.0, a fake systemd and a fake health check (`healthy`). */
function jobWorld(opts: { healthy?: boolean; stageError?: Error } = {}) {
  const root = tempDir();
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  writeInstall(join(dataDir, "app"), "1.0.0");
  mkdirSync(join(root, "units"));
  const unit = join(root, "units/xaq.service");
  writeFileSync(unit, UNIT);
  const staged: (string | undefined)[] = [];
  let running = true;
  let starts = 0;
  const ops: ServiceOps = {
    platform: "linux",
    root: false,
    uid: 1000,
    user: "me",
    unitDir: () => join(root, "units"),
    exec(_cmd, args) {
      if (args.includes("disable")) running = false;
      if (args.includes("enable") && args.includes("--now")) {
        running = true;
        starts++;
      }
    },
    capture: (_cmd, args) => (args.includes("MainPID") ? `${running ? 4242 + starts : 0}\n` : ""),
    stage(dir, version) {
      staged.push(version);
      if (opts.stageError) throw opts.stageError;
      writeInstall(join(dir, "app.new"), version!);
      return join(dir, "app.new");
    },
    waitReady: async () => opts.healthy ?? true,
    instance: () => (running ? { pid: 4242 + starts, host: "127.0.0.1", port: 9123, startedAt: `s${starts}`, service: true } : null),
    portInUse: async () => false,
  };
  return { dataDir, unit, ops, staged };
}

const req = (dataDir: string): UpdateJobRequest => ({ dataDir, id: "abc123", version: "2.0.0" });

describe("update job", () => {
  afterEach(() => vi.restoreAllMocks());
  const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

  it("is `service install` of the new version, on the service's data directory, port and host", async () => {
    quiet();
    const w = jobWorld();
    const status = await runUpdateJob(req(w.dataDir), { ops: w.ops });
    expect(status).toMatchObject({ id: "abc123", from: "1.0.0", to: "2.0.0", state: "succeeded", message: null });
    expect(status.finishedAt).not.toBeNull();
    expect(readUpdateStatus(w.dataDir)).toEqual(status);
    expect(w.staged).toEqual(["2.0.0"]);
    expect(installedVersion(join(w.dataDir, "app"))).toBe("2.0.0");
    expect(existsSync(join(w.dataDir, "app.old"))).toBe(false);
    const unit = readFileSync(w.unit, "utf8");
    expect([unitEnv(unit, "PORT"), unitEnv(unit, "HOST"), unitEnv(unit, "XAQ_DATA")]).toEqual(["9123", "127.0.0.1", w.dataDir]);
    expect(unit).toContain(`ExecStart="${process.execPath}" `);
  });

  it("changes nothing when staging is refused", async () => {
    quiet();
    const w = jobWorld({ stageError: new Error("Refused: hono is pinned without an integrity hash.") });
    const status = await runUpdateJob(req(w.dataDir), { ops: w.ops });
    expect(status).toMatchObject({ state: "failed", message: expect.stringMatching(/Refused/) });
    expect(installedVersion(join(w.dataDir, "app"))).toBe("1.0.0");
    expect(readFileSync(w.unit, "utf8")).toBe(UNIT);
  });

  it("reports a new version that doesn't come up, with where to look", async () => {
    quiet();
    const w = jobWorld({ healthy: false });
    const status = await runUpdateJob(req(w.dataDir), { ops: w.ops });
    expect(status).toMatchObject({ state: "failed", message: expect.stringMatching(/Starting the service failed \(it did not answer on port 9123\)[\s\S]*systemctl --user status xaq/) });
  });

  it("fails without an installed service", async () => {
    const w = jobWorld();
    rmSync(w.unit);
    expect(await runUpdateJob(req(w.dataDir), { ops: w.ops })).toMatchObject({ state: "failed", message: expect.stringMatching(/isn't installed/) });
    expect(w.staged).toEqual([]);
  });
});

describe("the job's code", () => {
  // The job runs from <data>/app and replaces it mid-run: a lazy import after the swap would find its files gone. So nothing it loads may import anything dynamically.
  it("loads everything up front", () => {
    const seen = new Set<string>();
    const lazy: string[] = [];
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/\bimport\s*\(/.test(code)) lazy.push(file);
      for (const m of text.matchAll(/^import (?!type )[^;]*?from "(\.[^"]+\.ts)"/gms)) walk(resolve(dirname(file), m[1]!));
    };
    walk(join(import.meta.dirname, "../server/update.ts"));
    expect(seen.size).toBeGreaterThan(10);
    expect(lazy).toEqual([]);
  });
});

describe("starting the job", () => {
  it("runs this install's CLI as a transient systemd unit outside the service", async () => {
    const calls: string[][] = [];
    const ops = { platform: "linux", root: false, capture: (cmd: string, args: string[]) => (calls.push([cmd, ...args]), "") } as unknown as ServiceOps;
    await launchUpdateJob(ops, { dataDir: "/data", id: "abc", version: "2.0.0" }, "/opt/node/bin/node", { PATH: "/usr/bin" });
    expect(calls).toEqual([
      [
        "systemd-run",
        "--user",
        "--unit=xaq-update",
        "--collect",
        "--quiet",
        "--setenv=PATH=/opt/node/bin:/usr/bin",
        "--",
        "/opt/node/bin/node",
        "/data/app/node_modules/xaq-cli/dist/cli.js",
        "service",
        "update-run",
        "--data",
        "/data",
        "--id",
        "abc",
        "--to",
        "2.0.0",
      ],
    ]);
    expect(updateJobCommand({ dataDir: "/data", id: "abc", version: "2.0.0" }, "/n")[0]).toBe("/n");
  });

  it("on macOS, a one-shot launchd job whose plist stays out of LaunchAgents", () => {
    const plist = renderUpdatePlist(["/n", "/d&x/cli.js"], "/Users/me/.xaq", "/n:/usr/bin");
    expect(plist).toContain("<key>Label</key><string>sh.xaq.update</string>");
    expect(plist).toContain("<string>/d&amp;x/cli.js</string>");
    expect(plist).toContain("<string>/Users/me/.xaq/update/update.log</string>");
    expect(plist).not.toContain("KeepAlive");
  });

  it("on macOS, never replaces an update job launchd still runs", async () => {
    const calls: string[] = [];
    let state = "running";
    const ops = {
      platform: "darwin",
      root: false,
      uid: 501,
      exec: (cmd: string, args: string[]) => void calls.push(`${cmd} ${args[0]}`),
      capture: (cmd: string, args: string[]) => (calls.push(`${cmd} ${args[0]}`), args[0] === "print" ? `gui/501/sh.xaq.update = {\n\tstate = ${state}\n}\n` : ""),
    } as unknown as ServiceOps;
    const job = { dataDir: tempDir(), id: "abc", version: "2.0.0" };
    await expect(launchUpdateJob(ops, job, "/n", {})).rejects.toThrow(/still running the previous update job/);
    expect(calls).toEqual(["launchctl print"]);
    // One that ended stays loaded as "not running": replacing it is fine.
    state = "not running";
    expect(launchdJobRunning(ops)).toBe(false);
  });

  it("is only offered to a service running from its own install", () => {
    const config = { service: true, dataDir: "/data" };
    expect(selfUpdateSupport(config, "/data/app/node_modules/xaq-cli", "linux")).toEqual({ supported: true, reason: null });
    expect(selfUpdateSupport(config, "/data/app/node_modules/xaq-cli", "darwin").supported).toBe(true);
    expect(selfUpdateSupport({ ...config, service: false }, "/data/app/node_modules/xaq-cli", "linux").reason).toMatch(/runs in a terminal/);
    expect(selfUpdateSupport(config, "/home/me/src/xaq", "linux").reason).toMatch(/source checkout/);
    expect(selfUpdateSupport(config, "/data/app/node_modules/xaq-cli", "win32").supported).toBe(false);
  });
});

// ───────────── The API ─────────────

describe("POST /api/system/update", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  function fakeHost(patch: Partial<SelfUpdateHost> = {}) {
    const launched: UpdateJobRequest[] = [];
    const host: SelfUpdateHost = {
      support: () => ({ supported: true, reason: null }),
      latest: async () => "9.9.9",
      launch: async (r) => void launched.push(r),
      ...patch,
    };
    return { host, launched };
  }
  const updates = () => h!.ctx.audit.list({ action: "system.update" }).items;
  const post = (cookie: string, body: unknown) => h!.request("/api/system/update", { method: "POST", headers: CSRF, cookie, json: body });

  it("does nothing without the right password, and audits the attempt", async () => {
    const { host, launched } = fakeHost();
    h = harness({}, { selfUpdate: host });
    const cookie = await h.claim();
    const res = await post(cookie, { password: "wrong password", version: "9.9.9" });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("invalid_password");
    expect(launched).toEqual([]);
    expect(readUpdateStatus(h.ctx.config.dataDir)).toBeNull();
    expect(updates()[0]).toMatchObject({ actorType: "admin", outcome: "denied", reason: "bad_password" });
    // And never without a session.
    expect((await h.request("/api/system/update", { method: "POST", headers: CSRF, json: { password: PASSWORD, version: "9.9.9" } })).status).toBe(401);
  });

  it("starts the job with the right password, writes the status and audits it", async () => {
    const { host, launched } = fakeHost();
    h = harness({}, { selfUpdate: host });
    const cookie = await h.claim();
    const res = await post(cookie, { password: PASSWORD, version: "9.9.9" });
    expect(res.status).toBe(202);
    const status = (await json(res)) as SelfUpdateStatus;
    expect(status).toMatchObject({ from: "0.0.0-test", to: "9.9.9", state: "running" });
    expect(launched).toEqual([{ dataDir: h.ctx.config.dataDir, id: status.id, version: "9.9.9" }]);
    expect(readUpdateStatus(h.ctx.config.dataDir)).toEqual(status);
    expect(updates()[0]).toMatchObject({ outcome: "ok", detail: { id: status.id, from: "0.0.0-test", to: "9.9.9" } });

    // A second one while it runs is refused.
    const again = await post(cookie, { password: PASSWORD, version: "9.9.9" });
    expect(again.status).toBe(409);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "in_progress" });
    expect(launched).toHaveLength(1);

    const info = await json(await h.request("/api/system/update", { cookie }));
    expect(info).toMatchObject({ supported: true, status: { id: status.id, state: "running" } });

    // One that died (its status still says running after 30 minutes) doesn't block the next.
    writeUpdateStatus(h.ctx.config.dataDir, { ...status, startedAt: new Date(Date.now() - 31 * 60_000).toISOString() });
    expect((await post(cookie, { password: PASSWORD, version: "9.9.9" })).status).toBe(202);
    expect(launched).toHaveLength(2);
  });

  it("audits an empty password and a malformed request as denied", async () => {
    const { host, launched } = fakeHost();
    h = harness({}, { selfUpdate: host });
    const cookie = await h.claim();
    expect((await post(cookie, { password: "", version: "9.9.9" })).status).toBe(400);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "invalid_request", detail: { error: expect.stringMatching(/Password is required/) } });
    expect((await post(cookie, { password: PASSWORD })).status).toBe(400);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "invalid_request" });
    const garbled = await h.request("/api/system/update", { method: "POST", headers: { ...CSRF, "content-type": "application/json" }, cookie, body: "{not json" });
    expect(garbled.status).toBe(400);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "invalid_request", detail: { error: expect.stringMatching(/valid JSON/) } });
    expect(updates()).toHaveLength(3);
    expect(launched).toEqual([]);
  });

  it("refuses (and audits) a foreground run and a version that isn't the latest", async () => {
    const unsupported = fakeHost({ support: () => ({ supported: false, reason: "xaq runs in a terminal, not as a service, so it can't update itself." }) });
    h = harness({}, { selfUpdate: unsupported.host });
    let cookie = await h.claim();
    let res = await post(cookie, { password: PASSWORD, version: "9.9.9" });
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toMatch(/runs in a terminal/);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "unsupported" });
    expect(unsupported.launched).toEqual([]);
    await h.dispose();

    const { host, launched } = fakeHost();
    h = harness({}, { selfUpdate: host });
    cookie = await h.claim();
    res = await post(cookie, { password: PASSWORD, version: "9.9.8" });
    expect(res.status).toBe(409);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "not_latest" });
    expect(launched).toEqual([]);
    expect((await post(cookie, { password: PASSWORD, version: "9.9.9" })).status).toBe(202);
  });

  it("records a job that couldn't start as failed", async () => {
    const { host } = fakeHost({
      launch: async () => {
        throw new Error("systemd-run: Failed to connect to bus");
      },
    });
    h = harness({}, { selfUpdate: host });
    const cookie = await h.claim();
    const res = await post(cookie, { password: PASSWORD, version: "9.9.9" });
    expect(res.status).toBe(500);
    expect(readUpdateStatus(h.ctx.config.dataDir)).toMatchObject({ state: "failed", message: expect.stringMatching(/Failed to connect to bus/) });
    expect(updates()[0]).toMatchObject({ outcome: "error", reason: "launch_failed" });
  });
});

// ───────────── The console ─────────────

describe("console polling", () => {
  const pending: PendingUpdate = { id: "a", from: "1.0.0", to: "2.0.0" };
  const status = (patch: Partial<SelfUpdateStatus>): SelfUpdateStatus => ({ id: "a", from: "1.0.0", to: "2.0.0", state: "running", message: null, startedAt: "", finishedAt: null, ...patch });
  const health = (version: string) => ({ status: "ok" as const, version, setupComplete: true });

  it("waits while the service restarts, reloads once the new version answers, then reports success", () => {
    expect(updateVerdict(pending, null, null)).toBe("wait");
    expect(updateVerdict(pending, status({}), health("1.0.0"))).toBe("wait");
    expect(updateVerdict(pending, status({}), health("2.0.0"))).toBe("reload");
    expect(updateVerdict({ ...pending, reloaded: true }, status({ state: "succeeded" }), health("2.0.0"))).toBe("succeeded");
    // Another update's status says nothing about this one.
    expect(updateVerdict(pending, status({ id: "b", state: "failed" }), null)).toBe("wait");
  });

  it("reports a failure", () => {
    expect(updateVerdict(pending, status({ state: "failed" }), health("1.0.0"))).toBe("failed");
    expect(outcomeText(status({ state: "failed", message: "Starting the service failed." }))).toMatchObject({ ok: false, title: "The update to 2.0.0 failed" });
    expect(outcomeText(status({ state: "succeeded" }))).toMatchObject({ ok: true, title: "Updated to xaq 2.0.0" });
  });
});
