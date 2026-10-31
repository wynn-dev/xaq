// `listen service install|uninstall` driven through the daemon's ServiceOps with fakes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataDir, listenAppDir } from "../server/listen/paths.ts";
import { loadProfile, saveProfile } from "../server/listen/profile.ts";
import { installListenService, uninstallListenService } from "../server/listen/service.ts";
import type { ServiceOps } from "../server/service.ts";
import { FAKE_KEY, isolateXdg } from "./listen-client-fake.ts";

let env: ReturnType<typeof isolateXdg>;
beforeEach(() => {
  env = isolateXdg();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  saveProfile({ url: "https://mail.example.com", apiKey: FAKE_KEY, agentId: "a", agentName: "n", consumer: "c", exec: "cat > /dev/null" });
});
afterEach(() => {
  vi.restoreAllMocks();
  env.restore();
});

const PID = 4242;

/** systemd fake: the unit reports active with MainPID PID (or `state` when given). */
function fakeOps(failOn?: (cmd: string, args: string[]) => boolean, state: { active: string; pid: number } = { active: "active", pid: PID }): ServiceOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    capture: (cmd, args) => {
      if (args.includes("MainPID")) return `${state.pid}\n`;
      if (args.includes("is-active")) {
        if (state.active !== "active") throw Object.assign(new Error(`Command failed: ${cmd}`), { stdout: `${state.active}\n` });
        return "active\n";
      }
      return "";
    },
    calls,
    platform: "linux",
    root: false,
    uid: 1000,
    user: "me",
    exec(cmd, args) {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (failOn?.(cmd, args)) throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
    },
    stage: () => {
      throw new Error("the listener must not use the daemon's stage");
    },
    unitDir: () => join(env.root, "units"),
    waitReady: async () => true,
    instance: () => null,
    portInUse: async () => false,
  };
}

let version = 0;
/** Fake npm install: writes a dist/cli.js tagged with an increasing version. */
const stage = (staging: string) => {
  mkdirSync(join(staging, "node_modules/xaq-cli/dist"), { recursive: true });
  writeFileSync(join(staging, "node_modules/xaq-cli/dist/cli.js"), `// v${++version}\n`);
  return staging;
};
const failingStage = () => {
  throw new Error("Installing xaq failed, so the existing service was left as it was. npm ERR!");
};
const installed = () => readFileSync(join(listenAppDir(), "node_modules/xaq-cli/dist/cli.js"), "utf8");
const unit = () => join(env.root, "units", "xaq-listen-default.service");
const ok = async () => PID;
const never = async () => null;
const node = { path: "/usr/local/bin/node", version: "22.20.0", versioned: false, why: "a stable path that survives fnm/nvm upgrades" };

/**
 * launchd fake. `bootout` returns at once but the job stays loaded for `lingers` more `print`s (launchd
 * tears it down asynchronously); `bootstrap` fails with launchd's "5: Input/output error" while a job
 * with the label is loaded, or always with `bootstrapFails`.
 */
function fakeLaunchd(opts: { lingers?: number; bootstrapFails?: boolean; pid?: number } = {}): ServiceOps & { calls: string[]; loaded: boolean } {
  const calls: string[] = [];
  let lingering = 0;
  const fail = (cmd: string, stderr: string) => Object.assign(new Error(`Command failed: ${cmd}`), { stderr });
  const ops = {
    ...fakeOps(),
    platform: "darwin" as const,
    calls,
    loaded: true, // an older job with this label is loaded
    exec(cmd: string, args: string[]) {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (args[0] === "bootout") {
        if (!ops.loaded) throw fail(cmd, "Boot-out failed: 3: No such process");
        lingering = opts.lingers ?? 0;
        if (!lingering) ops.loaded = false;
      }
    },
    capture(cmd: string, args: string[]) {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (args[0] === "print") {
        if (lingering > 0 && --lingering === 0) {
          ops.loaded = false;
          return "state = running\n\tpid = 1\n"; // the old job, on its way out
        }
        if (!ops.loaded) throw fail(cmd, "Could not find service");
        return `sh.xaq.listen.default = {\n\tstate = running\n\tpid = ${opts.pid ?? PID}\n}\n`;
      }
      if (args[0] === "bootstrap") {
        if (opts.bootstrapFails || ops.loaded) throw fail(cmd, "Bootstrap failed: 5: Input/output error\n");
        ops.loaded = true;
      }
      return "";
    },
  };
  return ops;
}
const plist = () => join(env.root, "units", "sh.xaq.listen.default.plist");

describe("listen service install (launchd)", () => {
  it("waits for the old job to unload before bootstrapping, then confirms launchd runs the new listener", async () => {
    const ops = fakeLaunchd({ lingers: 3 });
    await installListenService({}, { ops, stage, waitStarted: ok, node, pollMs: 1 });
    const bootstrap = ops.calls.findIndex((c) => c.startsWith("launchctl bootstrap"));
    const lastPrintBefore = ops.calls.slice(0, bootstrap).filter((c) => c.startsWith("launchctl print")).length;
    expect(lastPrintBefore).toBeGreaterThanOrEqual(3); // polled until the old job was gone
    expect(ops.calls.filter((c) => c.startsWith("launchctl bootstrap"))).toHaveLength(1);
    expect(readFileSync(plist(), "utf8")).toContain("<string>/usr/local/bin/node</string>");
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("running as pid 4242");
  });

  it("a bootstrap that keeps failing is reported (with launchd's reason) and rolled back, never 'Installed'", async () => {
    const ops = fakeLaunchd({ bootstrapFails: true });
    await expect(installListenService({}, { ops, stage, waitStarted: ok, node, pollMs: 1 })).rejects.toThrow(
      /launchctl bootstrap failed: Bootstrap failed: 5: Input\/output error\)\. Removed the new service again \(no listener service is installed\)\./,
    );
    expect(ops.calls.filter((c) => c.startsWith("launchctl bootstrap")).length).toBe(5);
    expect(existsSync(plist())).toBe(false);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain("Installed");
  });

  it("a listener that isn't launchd's job (an old one still running) doesn't count as installed", async () => {
    const ops = fakeLaunchd({ pid: 999 });
    await expect(installListenService({}, { ops, stage, waitStarted: ok, node, pollMs: 1 })).rejects.toThrow(/isn't the service's process \(launchd state running, pid 999\)/);
  });
});

describe("listen service install", () => {
  it("first install that never starts rolls back to no service, no install, original settings", async () => {
    const ops = fakeOps();
    await expect(installListenService({ exec: "new-cmd" }, { ops, stage, waitStarted: never })).rejects.toThrow(/Removed the new service again/);
    expect(existsSync(unit())).toBe(false);
    expect(existsSync(listenAppDir())).toBe(false);
    expect(loadProfile().exec).toBe("cat > /dev/null");
    expect(ops.calls).toContain("systemctl --user disable --now xaq-listen-default");
  });

  it("a failed re-install (readiness timeout) restores the previous unit, install and settings, and restarts it", async () => {
    const ops = fakeOps();
    await installListenService({}, { ops, stage, waitStarted: ok, node });
    const before = { unit: readFileSync(unit(), "utf8"), app: installed() };
    ops.calls.length = 0;
    await expect(installListenService({ exec: "new-cmd", types: "all" }, { ops, stage, waitStarted: never })).rejects.toThrow(/Put the previous install back; it is running again \(systemd active, MainPID 4242\)\./);
    expect(readFileSync(unit(), "utf8")).toBe(before.unit);
    expect(installed()).toBe(before.app);
    expect(loadProfile()).toMatchObject({ exec: "cat > /dev/null" });
    expect(loadProfile().types).toBeUndefined();
    expect(ops.calls.filter((c) => c === "systemctl --user restart xaq-listen-default")).toHaveLength(2); // new attempt, then the restored one
  });

  it("a failed npm install changes nothing (settings included)", async () => {
    const ops = fakeOps();
    await installListenService({}, { ops, stage, waitStarted: ok, node });
    const before = readFileSync(unit(), "utf8");
    await expect(installListenService({ exec: "new-cmd" }, { ops, stage: failingStage, waitStarted: ok })).rejects.toThrow(/left as it was/);
    expect(loadProfile().exec).toBe("cat > /dev/null");
    expect(readFileSync(unit(), "utf8")).toBe(before);
  });

  it("saves the flags given (none: keeps the saved ones); uninstall removes the unit and the install", async () => {
    const ops = fakeOps();
    await installListenService({ recipe: "claude-code", notFrom: ["*@github.com"] }, { ops, stage, waitStarted: ok, node });
    expect(loadProfile()).toMatchObject({ exec: expect.stringContaining("claude -p"), notFrom: ["*@github.com"] });
    await installListenService({}, { ops, stage, waitStarted: ok, node });
    expect(loadProfile()).toMatchObject({ exec: expect.stringContaining("claude -p"), notFrom: ["*@github.com"] });
    expect(installed()).toBe(`// v${version}\n`);

    uninstallListenService(true, { ops });
    expect(existsSync(unit())).toBe(false);
    expect(existsSync(listenAppDir())).toBe(false);
    expect(loadProfile().apiKey).toBe(FAKE_KEY);
  });

  it("checks that systemd itself runs the new listener: is-active and MainPID must match the listener that started", async () => {
    const log = vi.mocked(console.log);
    await expect(installListenService({}, { ops: fakeOps(undefined, { active: "failed", pid: 0 }), stage, waitStarted: ok, node })).rejects.toThrow(
      /doesn't report it running \(systemd failed\)[\s\S]*Removed the new service again/,
    );
    // Another listener (not the unit's main process) answering doesn't count either.
    await expect(installListenService({}, { ops: fakeOps(undefined, { active: "active", pid: 777 }), stage, waitStarted: ok, node })).rejects.toThrow(/pid 4242\) isn't the service's process/);
    expect(log.mock.calls.flat().join("\n")).not.toContain("Installed");
    await installListenService({}, { ops: fakeOps(), stage, waitStarted: ok, node });
    expect(log.mock.calls.flat().join("\n")).toContain("it is running as pid 4242");
  });

  it("says when restarting the previous install failed instead of claiming a rollback", async () => {
    const ops = fakeOps();
    await installListenService({}, { ops, stage, waitStarted: ok, node });
    let restarts = 0;
    const flaky = fakeOps((cmd, args) => cmd === "systemctl" && args.includes("restart") && ++restarts === 2);
    await expect(installListenService({ exec: "new-cmd" }, { ops: flaky, stage, waitStarted: never, node })).rejects.toThrow(
      /Put the previous install back, but restarting it failed \(Command failed: systemctl --user restart xaq-listen-default\), so no listener service is running now/,
    );
  });

  it("runs the chosen stable node and says which and why", async () => {
    await installListenService({}, { ops: fakeOps(), stage, waitStarted: ok, node });
    expect(readFileSync(unit(), "utf8")).toContain('ExecStart="/usr/local/bin/node" ');
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("Node.js:   /usr/local/bin/node (v22.20.0): a stable path that survives fnm/nvm upgrades");
  });

  it("refuses a concurrent install and a directory that holds a daemon's database", async () => {
    const ops = fakeOps();
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(join(dataDir(), "install.lock"), JSON.stringify({ pid: process.ppid, startedAt: "earlier" }));
    await expect(installListenService({}, { ops, stage, waitStarted: ok, node })).rejects.toThrow(/Another listener service install is running/);
    writeFileSync(join(dataDir(), "install.lock"), JSON.stringify({ pid: 2 ** 22 + 4242, startedAt: "crashed" }));
    await installListenService({}, { ops, stage, waitStarted: ok, node }); // stale lock taken over
    expect(existsSync(join(dataDir(), "install.lock"))).toBe(false);

    writeFileSync(join(dataDir(), "xaq.db"), "");
    await expect(installListenService({}, { ops, stage, waitStarted: ok, node })).rejects.toThrow(/holds a xaq daemon's data/);
  });
});
