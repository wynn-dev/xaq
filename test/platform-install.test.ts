import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleService } from "../server/google/types.ts";
import { type InstanceInfo, lockPath, serviceInstallCommand } from "../server/instance.ts";
import { nodeVersionError } from "../server/node-check.ts";
import {
  installService,
  isHealthResponse,
  notTheService,
  serviceMainPid,
  renderSystemdUnit,
  serviceHints,
  type ServiceOps,
  serviceStatus,
  uninstallService,
  unitDataDir,
  userManagerConfigHome,
} from "../server/service.ts";
import { defaultPublicUrl } from "../server/settings.ts";
import { testConfig, testContext } from "./helpers.ts";
import { CSRF, type Harness, harness } from "./platform-helpers.ts";

const ROOT = join(import.meta.dirname, "..");
function cli(args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", join(ROOT, "server/cli.ts"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", PORT: "", HOST: "", XAQ_URL: "", ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

let cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
  vi.restoreAllMocks();
});

describe("1: Node version check", () => {
  it("explains a too-old Node", () => {
    expect(nodeVersionError("22.12.0")).toBe(
      "xaq needs Node.js 22.13 or newer (you have v22.12.0). Install a current Node.js from https://nodejs.org and try again.",
    );
    expect(nodeVersionError("v20.18.1")).toMatch(/you have v20\.18\.1/);
    expect(nodeVersionError("18.0.0")).not.toBeNull();
    expect(nodeVersionError("22.13.0")).toBeNull();
    expect(nodeVersionError("22.20.1")).toBeNull();
    expect(nodeVersionError("24.0.0")).toBeNull();
  });

  it("runs before anything else in the CLI", () => {
    const src = readFileSync(join(ROOT, "server/cli.ts"), "utf8");
    expect(src.indexOf('import "./node-check.ts";')).toBeLessThan(src.indexOf("import {"));
  });
});

// ───────────── 3: service install rollback ─────────────

const SERVICE_PID = 4242;

type FakeOps = ServiceOps & {
  calls: string[];
  owner: InstanceInfo | null;
  busyPort: boolean;
  /** systemd's MainPID for the unit; undefined: SERVICE_PID while `owner` is a service, else none. */
  mainPid: number | null | undefined;
};

/**
 * Fake systemd: `enable --now` starts the service, whose process takes the data directory's lock as a
 * service (pid SERVICE_PID, also systemd's MainPID); `disable --now` stops it. `owner` is that lock.
 */
function fakeOps(
  dir: string,
  failOn?: (cmd: string, args: string[]) => boolean,
  ready = true,
): FakeOps {
  const calls: string[] = [];
  let starts = 0;
  const ops: FakeOps = {
    owner: null,
    busyPort: false,
    mainPid: undefined,
    capture: (cmd, args) => {
      if (cmd !== "systemctl" || !args.includes("MainPID")) return "";
      const pid = ops.mainPid !== undefined ? ops.mainPid : ops.owner?.service ? SERVICE_PID : null;
      return `${pid ?? 0}\n`;
    },
    calls,
    platform: "linux",
    root: false,
    uid: 1000,
    user: "me",
    exec(cmd, args) {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (failOn?.(cmd, args)) throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
      if (cmd !== "systemctl") return;
      if (args.includes("enable") && args.includes("--now") && !ops.owner) {
        ops.owner = { pid: SERVICE_PID, host: "127.0.0.1", port: 0, startedAt: `start-${++starts}`, service: true };
      }
      if (args.includes("disable") && ops.owner?.service) ops.owner = null;
    },
    stage(dataDir) {
      const staging = join(dataDir, "app.new");
      mkdirSync(join(staging, "node_modules/xaq-cli/dist"), { recursive: true });
      writeFileSync(join(staging, "node_modules/xaq-cli/dist/cli.js"), "// new\n");
      return staging;
    },
    unitDir: () => join(dir, "units"),
    waitReady: async () => ready,
    instance: () => ops.owner,
    portInUse: async () => ops.busyPort,
  };
  return ops;
}

describe("3: service install", () => {
  const setup = () => {
    const config = testConfig();
    cleanup.push(() => rmSync(config.dataDir, { recursive: true, force: true }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return config;
  };
  const enableFails = (cmd: string, args: string[]) => cmd === "systemctl" && args.includes("enable");

  it("installs a user unit without network-online and cleans up the staging dirs", async () => {
    const config = setup();
    const ops = fakeOps(config.dataDir);
    await installService(config, ops);
    const unit = readFileSync(join(config.dataDir, "units/xaq.service"), "utf8");
    expect(unit).not.toContain("network-online");
    expect(unit).toContain("WantedBy=default.target");
    expect(existsSync(join(config.dataDir, "app/node_modules/xaq-cli/dist/cli.js"))).toBe(true);
    expect(existsSync(join(config.dataDir, "app.new"))).toBe(false);
    expect(existsSync(join(config.dataDir, "app.old"))).toBe(false);
    expect(ops.calls).toContain("systemctl --user enable --now xaq");
    expect(ops.calls).toContain("loginctl enable-linger me");
  });

  it("rolls a fresh install back completely when the service can't start", async () => {
    const config = setup();
    const ops = fakeOps(config.dataDir, enableFails);
    const err = await installService(config, ops).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/Starting the service failed .*Rolled back to no service/s);
    expect(err?.message).toContain("journalctl --user -u xaq -e");
    expect(existsSync(join(config.dataDir, "units/xaq.service"))).toBe(false);
    expect(existsSync(join(config.dataDir, "app"))).toBe(false);
    expect(ops.calls.filter((c) => c === "systemctl --user daemon-reload").length).toBeGreaterThanOrEqual(2);
  });

  it("restores the previous install when an update can't start", async () => {
    const config = setup();
    mkdirSync(join(config.dataDir, "units"), { recursive: true });
    writeFileSync(join(config.dataDir, "units/xaq.service"), "previous unit\n");
    mkdirSync(join(config.dataDir, "app"), { recursive: true });
    writeFileSync(join(config.dataDir, "app/marker"), "old app");
    writeFileSync(join(config.dataDir, "service.env"), "TRUST_PROXY=1\n");
    let attempts = 0;
    // The new unit fails to start; re-enabling the restored one works.
    const ops = fakeOps(config.dataDir, (cmd, args) => enableFails(cmd, args) && ++attempts === 1);
    await expect(installService(config, ops)).rejects.toThrow(/Rolled back to the previous install/);
    expect(readFileSync(join(config.dataDir, "units/xaq.service"), "utf8")).toBe("previous unit\n");
    expect(existsSync(join(config.dataDir, "app.new"))).toBe(false);
    expect(readFileSync(join(config.dataDir, "app/marker"), "utf8")).toBe("old app");
    expect(readFileSync(join(config.dataDir, "service.env"), "utf8")).toBe("TRUST_PROXY=1\n");
    expect(attempts).toBe(2);
  });

  it("changes nothing when systemd can't be reached (no user bus)", async () => {
    const config = setup();
    mkdirSync(join(config.dataDir, "units"), { recursive: true });
    writeFileSync(join(config.dataDir, "units/xaq.service"), "working unit\n");
    mkdirSync(join(config.dataDir, "app/node_modules/xaq-cli"), { recursive: true });
    const ops = fakeOps(config.dataDir, (cmd) => cmd === "systemctl");
    let staged = false;
    ops.stage = () => {
      staged = true;
      return "";
    };
    await expect(installService(config, ops)).rejects.toThrow(/Can't talk to systemd \(user session\): Command failed.*Nothing was changed/s);
    expect(staged).toBe(false);
    expect(readFileSync(join(config.dataDir, "units/xaq.service"), "utf8")).toBe("working unit\n");
    expect(existsSync(join(config.dataDir, "app/node_modules/xaq-cli"))).toBe(true);
    expect(ops.calls).toEqual(["systemctl --user daemon-reload"]);
  });

  it("rolls back when the service starts but never answers health checks", async () => {
    const config = setup();
    const ops = fakeOps(config.dataDir, undefined, false);
    await expect(installService(config, ops)).rejects.toThrow(/did not answer on port .*Rolled back to no service/s);
    expect(existsSync(join(config.dataDir, "units/xaq.service"))).toBe(false);
    expect(existsSync(join(config.dataDir, "app"))).toBe(false);
    expect(ops.calls).toContain("systemctl --user disable --now xaq");
  });

  it("refuses while xaq runs in a terminal on the same data directory, and changes nothing", async () => {
    const config = setup();
    const ops = fakeOps(config.dataDir);
    ops.owner = { pid: 777, host: "0.0.0.0", port: 8425, startedAt: "x", service: false };
    let staged = false;
    ops.stage = () => {
      staged = true;
      return "";
    };
    await expect(installService(config, ops)).rejects.toThrow(
      "xaq is already running in a terminal (pid 777, port 8425): stop it with Ctrl-C, then run this again.",
    );
    expect(staged).toBe(false);
    expect(existsSync(join(config.dataDir, "units/xaq.service"))).toBe(false);
    expect(ops.calls).toEqual(["systemctl --user daemon-reload"]);
  });

  it("refuses when the port is taken and no service is installed yet", async () => {
    const config = setup();
    const ops = fakeOps(config.dataDir);
    ops.busyPort = true;
    await expect(installService(config, ops)).rejects.toThrow(/Port \d+ is already in use.*Nothing was changed/);
    expect(existsSync(join(config.dataDir, "app"))).toBe(false);
  });

  it("reinstalls over a running service (its own lock is not a conflict)", async () => {
    const config = setup();
    const ops = fakeOps(config.dataDir);
    await installService(config, ops);
    ops.busyPort = true; // the service itself holds the port
    await installService(config, ops);
    expect(ops.owner).toMatchObject({ service: true, startedAt: "start-2" });
  });

  it("rolls back when a foreground xaq answers instead of the service", async () => {
    const config = setup();
    const ops = fakeOps(config.dataDir);
    const log = vi.spyOn(console, "log");
    // A terminal instance grabs the data directory and port just before the service starts; the service never gets them.
    ops.exec = (cmd, args) => {
      ops.calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "systemctl" && args.includes("enable")) ops.owner = { pid: 999, host: "127.0.0.1", port: 0, startedAt: "fg", service: false };
    };
    await expect(installService(config, ops)).rejects.toThrow(/data directory \(pid 999\) is not the service.*Rolled back to no service/s);
    expect(existsSync(join(config.dataDir, "units/xaq.service"))).toBe(false);
    expect(log.mock.calls.flat().join("\n")).not.toMatch(/Installed|Running at/);
  });

  it("treats an unflagged lock holder as the service when it is systemd's main process (early nightlies)", async () => {
    const config = setup();
    mkdirSync(join(config.dataDir, "units"), { recursive: true });
    writeFileSync(join(config.dataDir, "units/xaq.service"), "old unit\n");
    const ops = fakeOps(config.dataDir);
    ops.owner = { pid: SERVICE_PID, host: "127.0.0.1", port: 0, startedAt: "old" };
    ops.mainPid = SERVICE_PID;
    ops.exec = (cmd, args) => {
      ops.calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd !== "systemctl") return;
      if (args.includes("disable")) ops.owner = null;
      if (args.includes("enable") && args.includes("--now")) ops.owner = { pid: SERVICE_PID + 1, host: "127.0.0.1", port: 0, startedAt: "new", service: true };
    };
    ops.capture = (cmd, args) => (cmd === "systemctl" && args.includes("MainPID") ? `${ops.owner?.pid ?? 0}\n` : "");
    await installService(config, ops);
    expect(ops.owner).toMatchObject({ pid: SERVICE_PID + 1 });
    // Without a unit, the same unflagged holder is a terminal instance.
    const fresh = setup();
    const other = fakeOps(fresh.dataDir);
    other.owner = { pid: SERVICE_PID, host: "127.0.0.1", port: 0, startedAt: "old" };
    other.mainPid = SERVICE_PID;
    await expect(installService(fresh, other)).rejects.toThrow(/already running in a terminal \(pid 4242/);
  });

  it("probes the port unless the service is actually running", async () => {
    // A unit is installed but its service isn't running: whatever holds the port isn't it.
    const config = setup();
    mkdirSync(join(config.dataDir, "units"), { recursive: true });
    writeFileSync(join(config.dataDir, "units/xaq.service"), "stopped unit\n");
    const ops = fakeOps(config.dataDir);
    ops.busyPort = true;
    ops.mainPid = null;
    await expect(installService(config, ops)).rejects.toThrow(/Port \d+ is already in use/);
    expect(readFileSync(join(config.dataDir, "units/xaq.service"), "utf8")).toBe("stopped unit\n");
    // Running (on another data directory, say): it holds the port, and reinstalling stops it first.
    const running = fakeOps(config.dataDir);
    running.busyPort = true;
    running.capture = (cmd, args) =>
      cmd === "systemctl" && args.includes("MainPID") ? `${running.owner ? SERVICE_PID : running.calls.some((c) => c.includes("disable")) ? 0 : 31337}\n` : "";
    await installService(config, running);
    expect(running.owner).toMatchObject({ pid: SERVICE_PID, service: true });
  });

  it("rolls a reinstall back to the previous unit, re-enabled, when someone else holds the data directory", async () => {
    const config = setup();
    mkdirSync(join(config.dataDir, "units"), { recursive: true });
    writeFileSync(join(config.dataDir, "units/xaq.service"), "previous unit\n");
    mkdirSync(join(config.dataDir, "app"), { recursive: true });
    writeFileSync(join(config.dataDir, "app/marker"), "old app");
    const ops = fakeOps(config.dataDir);
    ops.owner = { pid: SERVICE_PID, host: "127.0.0.1", port: 0, startedAt: "old", service: true };
    let enables = 0;
    ops.exec = (cmd, args) => {
      ops.calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd !== "systemctl") return;
      if (args.includes("disable")) ops.owner = null;
      if (args.includes("enable") && args.includes("--now")) {
        // First the new service starts, but a terminal instance got the data directory; then the previous one comes back.
        ops.owner = ++enables === 1 ? { pid: 999, host: "127.0.0.1", port: 0, startedAt: "fg", service: false } : { pid: SERVICE_PID, host: "127.0.0.1", port: 0, startedAt: "again", service: true };
      }
    };
    const log = vi.spyOn(console, "log");
    await expect(installService(config, ops)).rejects.toThrow(/\(pid 999\) is not the service.*Rolled back to the previous install/s);
    expect(readFileSync(join(config.dataDir, "units/xaq.service"), "utf8")).toBe("previous unit\n");
    expect(readFileSync(join(config.dataDir, "app/marker"), "utf8")).toBe("old app");
    expect(enables).toBe(2);
    expect(ops.calls.filter((c) => c === "systemctl --user enable --now xaq")).toHaveLength(2);
    expect(log.mock.calls.flat().join("\n")).not.toMatch(/Installed|Running at/);
  });

  it("reads the service's main pid from systemd and launchd", () => {
    const ops = fakeOps("/tmp/x");
    ops.capture = (cmd, args) => (cmd === "systemctl" && args.join(" ") === "--user show -p MainPID --value xaq" ? "1234\n" : "");
    expect(serviceMainPid(ops)).toBe(1234);
    ops.capture = () => "0\n";
    expect(serviceMainPid(ops)).toBeNull();
    const mac = { ...fakeOps("/tmp/x"), platform: "darwin" as const, uid: 501 };
    const seen: string[][] = [];
    mac.capture = (cmd, args) => {
      seen.push([cmd, ...args]);
      return `gui/501/sh.xaq.daemon = {\n\tactive count = 1\n\tpath = /Users/me/Library/LaunchAgents/sh.xaq.daemon.plist\n\tstate = running\n\tprogram = /usr/local/bin/node\n\tpid = 8123\n\timmediate reason = speculative\n}\n`;
    };
    expect(serviceMainPid(mac)).toBe(8123);
    expect(seen).toEqual([["launchctl", "print", "gui/501/sh.xaq.daemon"]]);
    mac.capture = () => "gui/501/sh.xaq.daemon = {\n\tstate = not running\n}\n";
    expect(serviceMainPid(mac)).toBeNull();
    mac.capture = () => {
      throw new Error("Could not find service");
    };
    expect(serviceMainPid(mac)).toBeNull();
  });

  it("only counts the service's own process as ready", () => {
    const svc = (pid: number, startedAt = "a"): InstanceInfo => ({ pid, host: "h", port: 1, startedAt, service: true });
    expect(notTheService(svc(10), null, 10)).toBeNull();
    expect(notTheService(svc(10), null, null)).toBeNull();
    expect(notTheService(null, null, 10)).toMatch(/no xaq holds the data directory/);
    expect(notTheService({ ...svc(11), service: false }, null, null)).toMatch(/pid 11\) is not the service/);
    expect(notTheService(svc(11), null, 10)).toBe("the xaq holding the data directory (pid 11) is not the service (pid 10)");
    // The service manager's own process counts, even from a build that didn't flag its lock.
    expect(notTheService({ ...svc(10), service: false }, null, 10)).toBeNull();
    // The previous service's process still holding the lock: the new one didn't take over.
    expect(notTheService(svc(10, "old"), svc(10, "old"), null)).not.toBeNull();
    expect(notTheService(svc(12, "new"), svc(10, "old"), 12)).toBeNull();
  });

  it("tells you to re-run install with the same flags", async () => {
    const config = setup();
    config.port = 9123;
    const log = vi.spyOn(console, "log");
    await installService(config, fakeOps(config.dataDir));
    const out = log.mock.calls.flat().join("\n");
    expect(serviceInstallCommand(config)).toMatch(/service install --data .* --host 127\.0\.0\.1 --port 9123$/);
    expect(out).toContain(`run \`${serviceInstallCommand(config)}\` again`);
  });

  it("finds the user unit dir via the user manager's environment and explains a missing user session", () => {
    expect(userManagerConfigHome({ capture: () => "HOME=/home/me\nXDG_CONFIG_HOME=/srv/cfg\nLANG=C\n" })).toBe("/srv/cfg");
    expect(userManagerConfigHome({ capture: () => "HOME=/home/me\n" })).toBeNull();
    expect(
      userManagerConfigHome({
        capture: () => {
          throw new Error("Failed to connect to bus");
        },
      }),
    ).toBeNull();
    const ops = fakeOps("/tmp/x");
    expect(serviceHints(ops, {}).join("\n")).toMatch(/XDG_RUNTIME_DIR is not set.*enable-linger me.*\/run\/user\/1000/s);
    expect(serviceHints(ops, { XDG_RUNTIME_DIR: "/run/user/1000" })).toHaveLength(2);
    expect(serviceHints({ ...ops, root: true }, {})).toEqual(["systemctl status xaq", "journalctl -u xaq -e"]);
  });

  it("uninstall removes the service's app; status says when nothing is installed", async () => {
    const config = setup();
    const ops = fakeOps(config.dataDir);
    await installService(config, ops);
    writeFileSync(config.dbPath, "data");
    mkdirSync(join(config.dataDir, "app.old"));
    writeFileSync(join(config.dataDir, "app.old/mine"), "not the service's");
    // A wrong --data is ignored in favor of the installed unit's XAQ_DATA, and never created.
    const wrong = join(config.dataDir, "..", "xaq-wrong-data");
    uninstallService({ dataDir: wrong }, ops);
    expect(existsSync(wrong)).toBe(false);
    expect(existsSync(join(config.dataDir, "units/xaq.service"))).toBe(false);
    expect(existsSync(join(config.dataDir, "app"))).toBe(false);
    expect(readFileSync(config.dbPath, "utf8")).toBe("data");
    expect(readFileSync(join(config.dataDir, "app.old/mine"), "utf8")).toBe("not the service's");
    const log = vi.spyOn(console, "log");
    serviceStatus(ops);
    expect(log.mock.calls.flat().join(" ")).toMatch(/not installed/);
    process.exitCode = 0;
  });
});

describe("3/5: unit parsing and health detection", () => {
  it("reads XAQ_DATA back from a unit and a plist", () => {
    const unit = renderSystemdUnit({ execPath: "/n", entry: "/e", dataDir: '/srv/a%b"c', port: 1, host: "h", extraEnv: {} });
    expect(unitDataDir(unit)).toBe('/srv/a%b"c');
    expect(unitDataDir("<key>XAQ_DATA</key><string>/Users/me/a&amp;b</string>")).toBe("/Users/me/a&b");
    expect(unitDataDir("[Service]\n")).toBeNull();
  });

  it("only accepts a real HealthResponse as ready", () => {
    expect(isHealthResponse({ status: "starting" })).toBe(false);
    expect(isHealthResponse({ status: "ok", version: "0.1.0", setupComplete: false })).toBe(true);
    expect(isHealthResponse({ status: "degraded", version: "0.1.0", setupComplete: true })).toBe(true);
    expect(isHealthResponse({ status: "ok" })).toBe(false);
    expect(isHealthResponse(null)).toBe(false);
  });
});

describe("4: default public URL", () => {
  it("uses localhost for all-interfaces and loopback binds, else the chosen host", () => {
    expect(defaultPublicUrl("0.0.0.0", 8425)).toBe("http://localhost:8425");
    expect(defaultPublicUrl("::", 8425)).toBe("http://localhost:8425");
    expect(defaultPublicUrl("127.0.0.1", 8425)).toBe("http://localhost:8425");
    expect(defaultPublicUrl("127.0.0.2", 8425)).toBe("http://127.0.0.2:8425");
    expect(defaultPublicUrl("::1", 8425)).toBe("http://localhost:8425");
    expect(defaultPublicUrl("192.168.1.5", 9000)).toBe("http://192.168.1.5:9000");
    expect(defaultPublicUrl("100.64.1.2", 8425)).toBe("http://100.64.1.2:8425");
    expect(defaultPublicUrl("fd00::5", 8425)).toBe("http://[fd00::5]:8425");
    expect(defaultPublicUrl("Mail.LAN", 8425)).toBe("http://mail.lan:8425");
  });

  it("is the settings default", async () => {
    const t = testContext({}, { host: "10.0.0.2", port: 9100 });
    cleanup.push(t.dispose);
    expect(t.ctx.settings.publicUrl()).toBe("http://10.0.0.2:9100");
  });
});

describe("5: CLI commands", () => {
  it("reports unknown commands with a suggestion", () => {
    let r = cli(["skil"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown command 'skil'");
    expect(r.stderr).toContain("Did you mean skill?");
    r = cli(["frobnicate"]);
    expect(r.stderr).toContain("unknown command 'frobnicate'");
    expect(r.stderr).not.toContain("Did you mean");
  });
});

describe("7/8: skill commands", () => {
  it("defaults the URL to the running instance, else localhost:8425", () => {
    const data = mkdtempSync(join(tmpdir(), "xaq-skill-"));
    cleanup.push(() => rmSync(data, { recursive: true, force: true }));
    const skill = () => {
      cli(["skill", "install", "--target", data], { XAQ_DATA: data });
      return readFileSync(join(data, "xaq", "SKILL.md"), "utf8");
    };
    expect(skill()).toContain("http://localhost:8425/mcp");
    writeFileSync(lockPath(data), JSON.stringify({ pid: process.pid, host: "0.0.0.0", port: 9234, startedAt: "" }));
    expect(skill()).toContain("http://localhost:9234/mcp");
    writeFileSync(lockPath(data), JSON.stringify({ pid: process.pid, host: "192.168.7.7", port: 9235, startedAt: "" }));
    expect(skill()).toContain("http://192.168.7.7:9235/mcp");
  });

  it("accepts known targets and paths, and refuses typos", () => {
    const dir = mkdtempSync(join(tmpdir(), "xaq-skills-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let r = cli(["skill", "install", "-t", "claud", "--url", "http://x.test"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown skill target "claud". Did you mean claude?');
    r = cli(["skill", "install", "-t", "notes", "--url", "http://x.test"]);
    expect(r.stderr).toContain("directory path such as ./skills");
    r = cli(["skill", "install", "-t", join(dir, "skills"), "--url", "http://x.test"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "skills/xaq/SKILL.md"), "utf8")).toContain("http://x.test/mcp");
  });
});

describe("16: account connect options", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  it("passes scopes and reauthAccountId through to startConnect", async () => {
    const seen: unknown[] = [];
    const google = () =>
      ({
        clientView: () => ({ clientId: null, hasSecret: false, projectId: null, appType: null, redirectUri: "", callbackMode: "direct" }),
        pubsubState: () => ({ mode: "poll", topic: null, subscription: null, lastError: null, lastMessageAt: null }),
        startConnect: (opts: unknown) => {
          seen.push(opts);
          return { authUrl: "https://accounts.google.com/x", state: "s", callbackMode: "direct" };
        },
      }) as unknown as GoogleService;
    h = harness({ google });
    const cookie = await h.claim();
    const connect = (json: unknown) => h!.request("/api/accounts/connect", { method: "POST", headers: CSRF, cookie, json });
    expect((await connect({ scopes: ["pubsub"], reauthAccountId: "acc_1" })).status).toBe(200);
    expect((await connect({})).status).toBe(200);
    expect(seen).toEqual([{ scopes: ["pubsub"], reauthAccountId: "acc_1" }, { scopes: undefined, reauthAccountId: undefined }]);
    expect((await connect({ scopes: ["gmail"] })).status).toBe(400);
  });
});

// ───────────── 3b: service install on launchd ─────────────

const PLIST = "units/sh.xaq.daemon.plist";

/**
 * Fake launchd. `bootout` returns at once but the old job stays loaded for `lingers` more `launchctl print`
 * calls (launchd tears it down asynchronously), and `bootstrap` fails with launchd's "5: Input/output error"
 * while a job with the label is loaded, or for the first `bootstrapFailures` calls. A bootstrapped job is
 * the running service: it holds the data directory's lock as pid SERVICE_PID.
 */
function fakeLaunchdOps(dir: string, opts: { lingers?: number; bootstrapFailures?: number; loaded?: boolean } = {}): FakeOps & { loaded: boolean } {
  let linger = 0;
  let failures = opts.bootstrapFailures ?? 0;
  let starts = 0;
  const eio = () => Object.assign(new Error("Command failed: launchctl bootstrap"), { stderr: "Bootstrap failed: 5: Input/output error\n" });
  const bootstrap = () => {
    if (ops.loaded || failures-- > 0) throw eio();
    ops.loaded = true;
    ops.owner = { pid: SERVICE_PID, host: "127.0.0.1", port: 0, startedAt: `start-${++starts}`, service: true };
  };
  const ops: FakeOps & { loaded: boolean } = {
    ...fakeOps(dir),
    platform: "darwin",
    uid: 501,
    loaded: opts.loaded ?? false,
    instance: () => ops.owner,
    portInUse: async () => ops.busyPort,
    exec(cmd, args) {
      ops.calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "launchctl" && args[0] === "bootout") {
        if (!ops.loaded) throw new Error("Boot-out failed: 3: No such process");
        linger = opts.lingers ?? 0;
        if (ops.owner?.service) ops.owner = null;
        if (linger === 0) ops.loaded = false;
      }
      if (cmd === "launchctl" && args[0] === "bootstrap") bootstrap();
    },
    capture(cmd, args) {
      ops.calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd !== "launchctl") return "";
      if (args[0] === "print") {
        if (ops.loaded && linger > 0) {
          if (--linger === 0) ops.loaded = false;
          return "state = stopping\n";
        }
        if (!ops.loaded) throw new Error('Could not find service "sh.xaq.daemon" in domain for port');
        return ops.owner?.service ? `state = running\n\tpid = ${SERVICE_PID}\n` : "state = waiting\n";
      }
      if (args[0] === "bootstrap") bootstrap();
      return "";
    },
  };
  return ops;
}

describe("3b: service install on launchd", () => {
  const setup = () => {
    const config = testConfig();
    cleanup.push(() => rmSync(config.dataDir, { recursive: true, force: true }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(join(config.dataDir, "units"), { recursive: true });
    writeFileSync(join(config.dataDir, PLIST), "previous plist\n");
    mkdirSync(join(config.dataDir, "app"), { recursive: true });
    writeFileSync(join(config.dataDir, "app/marker"), "old app");
    return config;
  };
  const bootstraps = (ops: FakeOps) => ops.calls.filter((c) => c.startsWith("launchctl bootstrap"));
  const running = (ops: FakeOps) => {
    ops.owner = { pid: SERVICE_PID, host: "127.0.0.1", port: 0, startedAt: "old", service: true };
  };

  it("an update waits for the old job to finish unloading (bootout returns early) before bootstrapping the new one", async () => {
    const config = setup();
    const ops = fakeLaunchdOps(config.dataDir, { loaded: true, lingers: 3 });
    running(ops);
    await installService(config, ops, { launchdPollMs: 1 });
    const first = ops.calls.findIndex((c) => c.startsWith("launchctl bootstrap"));
    expect(ops.calls.slice(0, first).filter((c) => c.startsWith("launchctl print")).length).toBeGreaterThanOrEqual(3);
    expect(bootstraps(ops)).toEqual([`launchctl bootstrap gui/501 ${join(config.dataDir, PLIST)}`]);
    expect(readFileSync(join(config.dataDir, PLIST), "utf8")).not.toBe("previous plist\n");
    expect(existsSync(join(config.dataDir, "app/node_modules/xaq-cli/dist/cli.js"))).toBe(true);
  });

  it("retries a bootstrap that fails with launchd's error 5, then succeeds", async () => {
    const config = setup();
    const ops = fakeLaunchdOps(config.dataDir, { loaded: true, bootstrapFailures: 2 });
    running(ops);
    await installService(config, ops, { launchdPollMs: 1 });
    expect(bootstraps(ops)).toHaveLength(3);
    expect(ops.loaded).toBe(true);
  });

  it("a bootstrap that keeps failing is reported with launchd's reason and rolled back to the previous install", async () => {
    const config = setup();
    // All five attempts for the new plist fail; the restored plist's bootstrap works.
    const ops = fakeLaunchdOps(config.dataDir, { loaded: true, bootstrapFailures: 5 });
    running(ops);
    await expect(installService(config, ops, { launchdPollMs: 1 })).rejects.toThrow(
      /Starting the service failed \(launchctl bootstrap failed: Bootstrap failed: 5: Input\/output error\)\. Rolled back to the previous install/,
    );
    expect(bootstraps(ops)).toHaveLength(6);
    expect(ops.loaded).toBe(true);
    expect(readFileSync(join(config.dataDir, PLIST), "utf8")).toBe("previous plist\n");
    expect(readFileSync(join(config.dataDir, "app/marker"), "utf8")).toBe("old app");
  });

  it("the restore after a failed update also waits for the failed job to unload", async () => {
    const config = setup();
    const ops = fakeLaunchdOps(config.dataDir, { loaded: true, lingers: 2 });
    running(ops);
    ops.waitReady = async () => false;
    await expect(installService(config, ops, { launchdPollMs: 1 })).rejects.toThrow(/did not answer on port .*Rolled back to the previous install/s);
    expect(bootstraps(ops)).toHaveLength(2);
    expect(ops.loaded).toBe(true);
    expect(readFileSync(join(config.dataDir, PLIST), "utf8")).toBe("previous plist\n");
  });
});
