// One-click update from the console (server/update.ts, docs/adr/0002-console-self-update.md): staging a
// given version with the supply-chain checks, the update job's swap and automatic rollback, the
// password-gated API with its audit entries, and the console's polling verdict. Nothing here reaches npm:
// npm and the service manager are fakes.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelfUpdateHost } from "../server/api/system.ts";
import { AuditLog } from "../server/audit.ts";
import { createBus } from "../server/bus.ts";
import { Db } from "../server/db/index.ts";
import { installedVersion, type NpmRunner, type ServiceOps, shrinkwrapProblems, stagePackage } from "../server/service.ts";
import {
  adoptUpdateLock,
  claimUpdateLock,
  KEEP_SNAPSHOTS,
  launchdJobRunning,
  launchUpdateJob,
  previousVersion,
  readUpdateLock,
  readUpdateStatus,
  releaseUpdateLock,
  renderUpdatePlist,
  runUpdateJob,
  selfUpdateSupport,
  type UpdateJobDeps,
  type UpdateJobRequest,
  updateJobCommand,
  updateLockPath,
  waitForVersion,
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

interface JobWorld {
  dataDir: string;
  calls: string[];
  deps: UpdateJobDeps;
  /** Versions /api/health was asked to answer with. */
  asked: string[];
  db: string;
}

/**
 * A data directory with the service on `current` (and `old` in app.old), a fake systemd and a fake health
 * check. `answers` lists the versions that come up healthy; each start of the service writes a row into the
 * database, standing in for what a new version's migrations would change.
 */
function jobWorld(opts: { current?: string; old?: string; answers?: string[]; stageError?: Error } = {}): JobWorld {
  const root = tempDir();
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  writeInstall(join(dataDir, "app"), opts.current ?? "1.0.0");
  if (opts.old) writeInstall(join(dataDir, "app.old"), opts.old);
  mkdirSync(join(root, "units"));
  writeFileSync(join(root, "units/xaq.service"), UNIT);
  const dbPath = join(dataDir, "xaq.db");
  new Db(dbPath).close();
  const calls: string[] = [];
  const asked: string[] = [];
  let running = true;
  const ops = {
    platform: "linux",
    root: false,
    uid: 1000,
    user: "me",
    unitDir: () => join(root, "units"),
    exec(cmd: string, args: string[]) {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (args.includes("stop")) running = false;
      if (args.includes("start")) {
        running = true;
        const db = new Db(dbPath);
        db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')", `test.started.${installedVersion(join(dataDir, "app"))}`);
        db.close();
      }
    },
    capture: (_cmd: string, args: string[]) => {
      if (args.includes("is-active")) return running ? "active\n" : "inactive\n";
      return "";
    },
  } as unknown as ServiceOps;
  const deps: UpdateJobDeps = {
    ops,
    stage: (dir, version) => {
      if (opts.stageError) throw opts.stageError;
      const staging = join(dir, "app.new");
      writeInstall(staging, version);
      return staging;
    },
    waitForVersion: async (_base, version) => {
      asked.push(version);
      return (opts.answers ?? []).includes(version);
    },
    log: () => {},
  };
  return { dataDir, calls, deps, asked, db: dbPath };
}

/** The versions whose start left their row in the database. */
const startedBy = (w: JobWorld, file = w.db) => {
  const db = new Db(file);
  try {
    return db.all<{ key: string }>("SELECT key FROM settings WHERE key LIKE 'test.started.%' ORDER BY key").map((r) => r.key.slice("test.started.".length));
  } finally {
    db.close();
  }
};
const auditEntries = (w: JobWorld, action: string) => {
  const db = new Db(w.db);
  try {
    return new AuditLog(db, createBus()).list({ action }).items;
  } finally {
    db.close();
  }
};
const snapshots = (w: JobWorld) => readdirSync(join(w.dataDir, "update/snapshots")).sort();
const req = (w: JobWorld, patch: Partial<UpdateJobRequest> = {}): UpdateJobRequest => ({ dataDir: w.dataDir, id: "abc123", kind: "update", version: "2.0.0", ...patch });

describe("update job", () => {
  it("stages, stops, snapshots, swaps, restarts and checks health; keeps app.old", async () => {
    const w = jobWorld({ answers: ["2.0.0"] });
    const status = await runUpdateJob(req(w), w.deps);
    expect(status).toMatchObject({ state: "succeeded", step: "done", from: "1.0.0", to: "2.0.0", message: null });
    expect(readUpdateStatus(w.dataDir)).toEqual(status);
    expect(installedVersion(join(w.dataDir, "app"))).toBe("2.0.0");
    expect(installedVersion(join(w.dataDir, "app.old"))).toBe("1.0.0");
    expect(w.calls).toEqual(["systemctl --user stop xaq", "systemctl --user start xaq"]);
    expect(w.asked).toEqual(["2.0.0"]);
    expect(startedBy(w)).toEqual(["2.0.0"]);
    expect(snapshots(w)).toEqual([expect.stringMatching(/^\d{4}-\d\d-\d\dT\d{6}\.\d{3}Z-update-1\.0\.0-to-2\.0\.0$/)]);
    expect(existsSync(join(w.dataDir, "update/snapshots", snapshots(w)[0]!, "xaq.db"))).toBe(true);
    expect(readUpdateLock(w.dataDir)).toBeNull();
    const [entry] = auditEntries(w, "system.update.result");
    expect(entry).toMatchObject({ actorType: "system", outcome: "ok", target: "2.0.0", detail: { id: "abc123", kind: "update", from: "1.0.0", to: "2.0.0" } });
    expect(previousVersion(w.dataDir, "2.0.0")).toBe("1.0.0");
  });

  it("rolls back on a failed health check: the previous install and the database snapshot come back", async () => {
    const w = jobWorld({ answers: ["1.0.0"] });
    const status = await runUpdateJob(req(w), w.deps);
    expect(status.state).toBe("rolled_back");
    expect(status.step).toBe("restoring");
    expect(status.message).toMatch(/xaq 2\.0\.0 didn't answer on \/api\/health\. xaq 1\.0\.0 and the database from before the update were put back/);
    expect(installedVersion(join(w.dataDir, "app"))).toBe("1.0.0");
    expect(existsSync(join(w.dataDir, "app.old"))).toBe(false);
    expect(w.calls).toEqual(["systemctl --user stop xaq", "systemctl --user start xaq", "systemctl --user stop xaq", "systemctl --user start xaq"]);
    expect(w.asked).toEqual(["2.0.0", "1.0.0"]);
    // 2.0.0's start wrote into the database; the snapshot from before it was restored, then 1.0.0 started.
    expect(startedBy(w)).toEqual(["1.0.0"]);
    expect(auditEntries(w, "system.update.result")[0]).toMatchObject({ outcome: "error", reason: "rolled_back" });
  });

  it("says so when the previous version doesn't come back either", async () => {
    const w = jobWorld({ answers: [] });
    const status = await runUpdateJob(req(w), w.deps);
    expect(status.state).toBe("rollback_failed");
    expect(status.message).toMatch(/Putting xaq 1\.0\.0 back failed too/);
    expect(installedVersion(join(w.dataDir, "app"))).toBe("1.0.0");
    expect(auditEntries(w, "system.update.result")[0]).toMatchObject({ outcome: "error", reason: "rollback_failed" });
  });

  it("changes nothing when staging is refused: the service is never stopped", async () => {
    const w = jobWorld({ stageError: new Error("Installing xaq failed, so the existing service was left as it was. Refused: the release has no npm-shrinkwrap.json") });
    const status = await runUpdateJob(req(w), w.deps);
    expect(status).toMatchObject({ state: "failed", step: "staging" });
    expect(status.message).toMatch(/no npm-shrinkwrap/);
    expect(w.calls).toEqual([]);
    expect(installedVersion(join(w.dataDir, "app"))).toBe("1.0.0");
    expect(auditEntries(w, "system.update.result")[0]).toMatchObject({ outcome: "error", reason: "failed" });
  });

  it("goes back to app.old with the same job, and can be undone by its own rollback", async () => {
    const w = jobWorld({ current: "2.0.0", old: "1.0.0", answers: ["1.0.0"] });
    const status = await runUpdateJob(req(w, { kind: "rollback", version: undefined }), w.deps);
    expect(status).toMatchObject({ state: "succeeded", kind: "rollback", from: "2.0.0", to: "1.0.0" });
    expect(installedVersion(join(w.dataDir, "app"))).toBe("1.0.0");
    expect(installedVersion(join(w.dataDir, "app.old"))).toBe("2.0.0");
    // The newer install kept in app.old isn't offered as "go back".
    expect(previousVersion(w.dataDir, "1.0.0")).toBeNull();
    expect(previousVersion(w.dataDir, "1.0.0-nightly.1")).toBeNull();
    expect(previousVersion(w.dataDir, "2.0.1")).toBe("2.0.0");

    const failing = jobWorld({ current: "2.0.0", old: "1.0.0", answers: ["2.0.0"] });
    expect((await runUpdateJob(req(failing, { kind: "rollback", version: undefined }), failing.deps)).state).toBe("rolled_back");
    expect(installedVersion(join(failing.dataDir, "app"))).toBe("2.0.0");
    expect(installedVersion(join(failing.dataDir, "app.old"))).toBe("1.0.0");
  });

  it("keeps the database from before an update through a go-back, and only the last few snapshots", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const w = jobWorld({ answers: ["2.0.0", "1.0.0"] });
      const at = (time: string, patch: Partial<UpdateJobRequest> = {}) => {
        vi.setSystemTime(new Date(`2026-10-27T${time}Z`));
        return runUpdateJob(req(w, patch), w.deps);
      };
      const back = { kind: "rollback" as const, version: undefined };
      expect((await at("10:00:00")).state).toBe("succeeded");
      expect((await at("11:00:00", { id: "def456", ...back })).state).toBe("succeeded");
      expect(snapshots(w)).toEqual(["2026-10-27T100000.000Z-update-1.0.0-to-2.0.0", "2026-10-27T110000.000Z-rollback-2.0.0-to-1.0.0"]);
      // The update's snapshot is the database before 2.0.0 ever started; the go-back's has 2.0.0's changes.
      const db = (name: string) => join(w.dataDir, "update/snapshots", name, "xaq.db");
      expect(startedBy(w, db(snapshots(w)[0]!))).toEqual([]);
      expect(startedBy(w, db(snapshots(w)[1]!))).toEqual(["2.0.0"]);

      expect((await at("12:00:00", { id: "ghi789" })).state).toBe("succeeded");
      expect((await at("13:00:00", { id: "jkl012", ...back })).state).toBe("succeeded");
      expect(snapshots(w)).toHaveLength(KEEP_SNAPSHOTS);
      expect(snapshots(w)[0]).toMatch(/^2026-10-27T110000/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the lock the app took for it until it ends, and never runs next to another job", async () => {
    const w = jobWorld({ answers: ["2.0.0"] });
    const other: SelfUpdateStatus = { id: "other1", kind: "update", from: "1.0.0", to: "2.0.0", state: "running", step: "staging", message: null, startedAt: new Date().toISOString(), finishedAt: null };
    writeUpdateStatus(w.dataDir, other);
    expect(claimUpdateLock(w.dataDir, "other1").ok).toBe(true);
    const refused = await runUpdateJob(req(w), w.deps);
    expect(refused).toMatchObject({ state: "failed", message: expect.stringMatching(/Another update \(other1\) is already running/) });
    expect(w.calls).toEqual([]);
    expect(readUpdateStatus(w.dataDir)).toEqual(other);
    expect(readUpdateLock(w.dataDir)?.id).toBe("other1");
    expect(auditEntries(w, "system.update.result")[0]).toMatchObject({ outcome: "error", reason: "in_progress", detail: { id: "abc123" } });

    releaseUpdateLock(w.dataDir, "other1");
    expect(claimUpdateLock(w.dataDir, "abc123").ok).toBe(true);
    const held: (string | undefined)[] = [];
    const stage = w.deps.stage;
    w.deps.stage = (dir, version) => (held.push(readUpdateLock(w.dataDir)?.id), stage(dir, version));
    expect((await runUpdateJob(req(w), w.deps)).state).toBe("succeeded");
    expect(held).toEqual(["abc123"]);
    expect(readUpdateLock(w.dataDir)).toBeNull();
  });

  it("refuses to go back without a previous install", async () => {
    const w = jobWorld();
    const status = await runUpdateJob(req(w, { kind: "rollback", version: undefined }), w.deps);
    expect(status).toMatchObject({ state: "failed", message: expect.stringMatching(/no previous install/) });
    expect(w.calls).toEqual([]);
  });
});

describe("the job's code", () => {
  // The job runs from <data>/app and moves it aside mid-run: a lazy import after the swap would load the
  // other version's files. So nothing it loads may import anything dynamically.
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
    await launchUpdateJob(ops, { dataDir: "/data", id: "abc", kind: "update", version: "2.0.0" }, "/opt/node/bin/node", { PATH: "/usr/bin" });
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
    expect(updateJobCommand({ dataDir: "/data", id: "abc", kind: "rollback" }, "/n").slice(-1)).toEqual(["--back"]);
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
    const job = { dataDir: tempDir(), id: "abc", kind: "update" as const, version: "2.0.0" };
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

  it("waits for /api/health to answer with the version asked for", async () => {
    let version = "1.0.0";
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version, setupComplete: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await waitForVersion(base, "2.0.0", { attempts: 2, intervalMs: 1 })).toBe(false);
      setTimeout(() => (version = "2.0.0"), 20);
      expect(await waitForVersion(base, "2.0.0", { attempts: 50, intervalMs: 5 })).toBe(true);
    } finally {
      server.close();
    }
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
    const res = await post(cookie, { password: "wrong password", action: "update", version: "9.9.9" });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("invalid_password");
    expect(launched).toEqual([]);
    expect(readUpdateStatus(h.ctx.config.dataDir)).toBeNull();
    expect(updates()[0]).toMatchObject({ actorType: "admin", outcome: "denied", reason: "bad_password", detail: { action: "update" } });
    // And never without a session.
    expect((await h.request("/api/system/update", { method: "POST", headers: CSRF, json: { password: PASSWORD, action: "update", version: "9.9.9" } })).status).toBe(401);
  });

  it("starts the job with the right password, writes the status and audits it", async () => {
    const { host, launched } = fakeHost();
    h = harness({}, { selfUpdate: host });
    const cookie = await h.claim();
    const res = await post(cookie, { password: PASSWORD, action: "update", version: "9.9.9" });
    expect(res.status).toBe(202);
    const status = (await json(res)) as SelfUpdateStatus;
    expect(status).toMatchObject({ kind: "update", from: "0.0.0-test", to: "9.9.9", state: "running", step: "starting" });
    expect(launched).toEqual([{ dataDir: h.ctx.config.dataDir, id: status.id, kind: "update", version: "9.9.9" }]);
    expect(readUpdateStatus(h.ctx.config.dataDir)).toEqual(status);
    expect(updates()[0]).toMatchObject({ outcome: "ok", detail: { action: "update", id: status.id, from: "0.0.0-test", to: "9.9.9" } });

    // A second one while it runs is refused.
    const again = await post(cookie, { password: PASSWORD, action: "update", version: "9.9.9" });
    expect(again.status).toBe(409);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "in_progress" });
    expect(launched).toHaveLength(1);

    const info = await json(await h.request("/api/system/update", { cookie }));
    expect(info).toMatchObject({ supported: true, previous: null, status: { id: status.id, state: "running" } });
  });

  it("starts exactly one job for two requests at once, and audits the other", async () => {
    const launched: UpdateJobRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { host } = fakeHost({ launch: async (r) => (launched.push(r), gate) });
    h = harness({}, { selfUpdate: host });
    const cookie = await h.claim();
    writeInstall(join(h.ctx.config.dataDir, "app.old"), "0.0.0-older");
    const requests = [post(cookie, { password: PASSWORD, action: "update", version: "9.9.9" }), post(cookie, { password: PASSWORD, action: "rollback" })];
    // One is still starting its job when the other is turned away.
    const refused = await Promise.race(requests);
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.message).toMatch(/(An update to 9\.9\.9|Going back to 0\.0\.0-older) is already running/);
    release();
    expect((await Promise.all(requests)).map((r) => r.status).sort()).toEqual([202, 409]);
    expect(launched).toHaveLength(1);
    const audited = updates();
    expect(audited.map((e) => e.outcome).sort()).toEqual(["denied", "ok"]);
    expect(audited.find((e) => e.outcome === "denied")).toMatchObject({ reason: "in_progress", detail: { running: launched[0]!.id } });
    expect(readUpdateLock(h.ctx.config.dataDir)?.id).toBe(launched[0]!.id);
  });

  it("audits an empty password and a malformed request as denied", async () => {
    const { host, launched } = fakeHost();
    h = harness({}, { selfUpdate: host });
    const cookie = await h.claim();
    expect((await post(cookie, { password: "", action: "update", version: "9.9.9" })).status).toBe(400);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "invalid_request", detail: { error: expect.stringMatching(/Password is required/) } });
    expect((await post(cookie, { password: PASSWORD, action: "reinstall" })).status).toBe(400);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "invalid_request" });
    const garbled = await h.request("/api/system/update", { method: "POST", headers: { ...CSRF, "content-type": "application/json" }, cookie, body: "{not json" });
    expect(garbled.status).toBe(400);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "invalid_request", detail: { error: expect.stringMatching(/valid JSON/) } });
    expect(updates()).toHaveLength(3);
    expect(launched).toEqual([]);
  });

  it("refuses (and audits) a foreground run, a version that isn't the latest, and going back with nothing kept", async () => {
    const unsupported = fakeHost({ support: () => ({ supported: false, reason: "xaq runs in a terminal, not as a service, so it can't update itself." }) });
    h = harness({}, { selfUpdate: unsupported.host });
    let cookie = await h.claim();
    let res = await post(cookie, { password: PASSWORD, action: "update", version: "9.9.9" });
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toMatch(/runs in a terminal/);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "unsupported" });
    expect(unsupported.launched).toEqual([]);
    await h.dispose();

    const { host, launched } = fakeHost();
    h = harness({}, { selfUpdate: host });
    cookie = await h.claim();
    res = await post(cookie, { password: PASSWORD, action: "update", version: "9.9.8" });
    expect(res.status).toBe(409);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "not_latest" });
    res = await post(cookie, { password: PASSWORD, action: "rollback" });
    expect(res.status).toBe(409);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "no_previous" });
    expect(launched).toEqual([]);
    // A refusal leaves no lock behind.
    expect(readUpdateLock(h.ctx.config.dataDir)).toBeNull();
    expect((await post(cookie, { password: PASSWORD, action: "update", version: "9.9.9" })).status).toBe(202);
  });

  it("goes back to the kept install", async () => {
    const { host, launched } = fakeHost();
    h = harness({}, { selfUpdate: host });
    const cookie = await h.claim();
    writeInstall(join(h.ctx.config.dataDir, "app.old"), "0.0.0-older");
    expect((await json(await h.request("/api/system/update", { cookie }))).previous).toBe("0.0.0-older");
    const res = await post(cookie, { password: PASSWORD, action: "rollback" });
    expect(res.status).toBe(202);
    expect(launched[0]).toMatchObject({ kind: "rollback", version: "0.0.0-older" });
  });

  it("never offers going back to a newer install (app.old after a go-back)", async () => {
    const { host, launched } = fakeHost();
    h = harness({}, { selfUpdate: host });
    const cookie = await h.claim();
    writeInstall(join(h.ctx.config.dataDir, "app.old"), "0.0.1");
    expect((await json(await h.request("/api/system/update", { cookie }))).previous).toBeNull();
    const res = await post(cookie, { password: PASSWORD, action: "rollback" });
    expect(res.status).toBe(409);
    expect(updates()[0]).toMatchObject({ outcome: "denied", reason: "no_previous" });
    expect(launched).toEqual([]);
  });

  it("records a job that couldn't start as failed", async () => {
    const { host } = fakeHost({
      launch: async () => {
        throw new Error("systemd-run: Failed to connect to bus");
      },
    });
    h = harness({}, { selfUpdate: host });
    const cookie = await h.claim();
    const res = await post(cookie, { password: PASSWORD, action: "update", version: "9.9.9" });
    expect(res.status).toBe(500);
    expect(readUpdateStatus(h.ctx.config.dataDir)).toMatchObject({ state: "failed", message: expect.stringMatching(/Failed to connect to bus/) });
    expect(updates()[0]).toMatchObject({ outcome: "error", reason: "launch_failed" });
    expect(readUpdateLock(h.ctx.config.dataDir)).toBeNull();
  });
});

describe("the update lock", () => {
  const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

  it("goes to exactly one of two claims, until its holder releases it", () => {
    const dataDir = tempDir();
    expect(claimUpdateLock(dataDir, "a")).toEqual({ ok: true });
    expect(claimUpdateLock(dataDir, "b")).toMatchObject({ ok: false, holder: { id: "a", pid: process.pid } });
    releaseUpdateLock(dataDir, "b");
    expect(readUpdateLock(dataDir)?.id).toBe("a");
    releaseUpdateLock(dataDir, "a");
    expect(claimUpdateLock(dataDir, "b")).toEqual({ ok: true });
    expect(readdirSync(join(dataDir, "update"))).toEqual(["lock"]);
  });

  it("is taken over when its job died, hung for 30 minutes, or it isn't a lock", () => {
    const dataDir = tempDir();
    expect(claimUpdateLock(dataDir, "crashed", deadPid()).ok).toBe(true);
    expect(claimUpdateLock(dataDir, "next")).toEqual({ ok: true });
    expect(claimUpdateLock(dataDir, "later", process.pid, Date.now() + 10 * 60_000).ok).toBe(false);
    expect(claimUpdateLock(dataDir, "later", process.pid, Date.now() + 31 * 60_000)).toEqual({ ok: true });
    writeFileSync(updateLockPath(dataDir), "{");
    expect(claimUpdateLock(dataDir, "fresh")).toEqual({ ok: true });
    expect(readdirSync(join(dataDir, "update"))).toEqual(["lock"]);
  });

  it("follows the job: it takes over the app's lock for its id, and claims one when run by hand", () => {
    const dataDir = tempDir();
    expect(claimUpdateLock(dataDir, "job1").ok).toBe(true);
    const gone = deadPid();
    expect(adoptUpdateLock(dataDir, "job1", gone)).toEqual({ ok: true });
    expect(readUpdateLock(dataDir)).toMatchObject({ id: "job1", pid: gone });
    // Once that process is gone, the lock is stale.
    expect(adoptUpdateLock(dataDir, "job2").ok).toBe(true);
    expect(adoptUpdateLock(dataDir, "job3")).toMatchObject({ ok: false, holder: { id: "job2" } });
    releaseUpdateLock(dataDir, "job2");
    expect(adoptUpdateLock(dataDir, "job3")).toEqual({ ok: true });
  });
});

// ───────────── The console ─────────────

describe("console polling", () => {
  const pending: PendingUpdate = { id: "a", kind: "update", from: "1.0.0", to: "2.0.0" };
  const status = (patch: Partial<SelfUpdateStatus>): SelfUpdateStatus => ({ id: "a", kind: "update", from: "1.0.0", to: "2.0.0", state: "running", step: "health", message: null, startedAt: "", finishedAt: null, ...patch });
  const health = (version: string) => ({ status: "ok" as const, version, setupComplete: true });

  it("waits while the service restarts, reloads once the new version answers, then reports success", () => {
    expect(updateVerdict(pending, null, null)).toBe("wait");
    expect(updateVerdict(pending, status({ step: "restarting" }), health("1.0.0"))).toBe("wait");
    expect(updateVerdict(pending, status({}), health("2.0.0"))).toBe("reload");
    expect(updateVerdict({ ...pending, reloaded: true }, status({ state: "succeeded" }), health("2.0.0"))).toBe("succeeded");
    // Another update's status says nothing about this one.
    expect(updateVerdict(pending, status({ id: "b", state: "rolled_back" }), null)).toBe("wait");
  });

  it("reports a failure and whether it rolled back", () => {
    expect(updateVerdict(pending, status({ state: "rolled_back" }), health("1.0.0"))).toBe("failed");
    expect(outcomeText(status({ state: "rolled_back", message: "xaq 2.0.0 didn't answer." }))).toMatchObject({ ok: false, title: "The update to 2.0.0 failed; xaq 1.0.0 is back" });
    expect(outcomeText(status({ state: "failed" })).title).toBe("The update to 2.0.0 didn't happen");
    expect(outcomeText(status({ state: "succeeded", kind: "rollback", to: "1.0.0" }))).toMatchObject({ ok: true, title: "Went back to xaq 1.0.0" });
  });
});
