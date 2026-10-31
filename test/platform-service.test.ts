import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lockPath } from "../server/instance.ts";
import {
  mergeServiceEnv,
  parseEnvFile,
  renderLaunchdPlist,
  renderSystemdUnit,
  type ServiceSpec,
  validateMasterKey,
} from "../server/service.ts";
import { testContext } from "./helpers.ts";

const KEY = Buffer.alloc(32, 1).toString("base64");
const spec = (patch: Partial<ServiceSpec> = {}): ServiceSpec => ({
  execPath: "/usr/bin/node",
  entry: "/home/me/.xaq/app/node_modules/xaq-cli/dist/cli.js",
  dataDir: "/home/me/.xaq",
  port: 8425,
  host: "0.0.0.0",
  extraEnv: {},
  ...patch,
});

describe("systemd unit", () => {
  it("loads service.env by an unquoted absolute path and keeps secrets out of the unit", () => {
    const unit = renderSystemdUnit(spec({ extraEnv: { XAQ_MASTER_KEY: KEY, TRUST_PROXY: "1" } }));
    expect(unit).toContain("\nEnvironmentFile=/home/me/.xaq/service.env\n");
    expect(unit).not.toContain(KEY);
    expect(unit).not.toContain("TRUST_PROXY");
    expect(unit).toContain('ExecStart="/usr/bin/node" "/home/me/.xaq/app/node_modules/xaq-cli/dist/cli.js" start --no-open');
    expect(unit).toContain('Environment="XAQ_DATA=/home/me/.xaq"');
    expect(unit).toContain('Environment="XAQ_SERVICE=1"');
    expect(unit).toContain("WantedBy=default.target");
  });

  it("omits EnvironmentFile without extra env, and targets multi-user as root", () => {
    const unit = renderSystemdUnit(spec({ system: true, execPath: "/opt/node 24/bin/node" }));
    expect(unit).not.toContain("EnvironmentFile");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain('ExecStart="/opt/node 24/bin/node"');
  });
});

describe("launchd plist", () => {
  it("carries the extra env, escaped", () => {
    const plist = renderLaunchdPlist(spec({ dataDir: "/Users/me/a&b", extraEnv: { XAQ_MASTER_KEY: KEY, XAQ_LOG_LEVEL: "debug" } }));
    expect(plist).toContain(`<key>XAQ_MASTER_KEY</key><string>${KEY}</string>`);
    expect(plist).toContain("<key>XAQ_LOG_LEVEL</key><string>debug</string>");
    expect(plist).toContain("<key>XAQ_DATA</key><string>/Users/me/a&amp;b</string>");
    expect(plist).toContain("<string>/Users/me/a&amp;b/xaq.log</string>");
    expect(plist).toContain("<key>Label</key><string>sh.xaq.daemon</string>");
  });
});

describe("service env", () => {
  it("keeps previous values on reinstall unless the shell overrides or clears them", () => {
    const previous = parseEnvFile(`XAQ_MASTER_KEY=${KEY}\nTRUST_PROXY=1\nXAQ_LOG_LEVEL=debug\n# comment\n`);
    expect(mergeServiceEnv(previous, {})).toEqual({ XAQ_MASTER_KEY: KEY, TRUST_PROXY: "1", XAQ_LOG_LEVEL: "debug" });
    expect(mergeServiceEnv(previous, { XAQ_LOG_LEVEL: "warn", TRUST_PROXY: "" })).toEqual({
      XAQ_MASTER_KEY: KEY,
      XAQ_LOG_LEVEL: "warn",
    });
    expect(mergeServiceEnv({}, { TRUST_PROXY: "1", PATH: "/bin" })).toEqual({ TRUST_PROXY: "1" });
    expect(mergeServiceEnv({ TRUST_PROXY_FROM: "10.0.0.0/8" }, {})).toEqual({});
  });

  it("validates the master key", () => {
    expect(() => validateMasterKey(undefined)).not.toThrow();
    expect(() => validateMasterKey(KEY)).not.toThrow();
    expect(() => validateMasterKey("too-short")).toThrow(/32 random bytes/);
    expect(() => validateMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 random bytes/);
  });
});

const ROOT = join(import.meta.dirname, "..");
function cli(args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", join(ROOT, "server/cli.ts"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", PORT: "", HOST: "", XAQ_DATA: "", ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("reset-password", () => {
  it("refuses a data directory without an instance, creating nothing", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "xaq-none-")), "data");
    const r = cli(["reset-password", "--data", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/No xaq data in .*sudo/);
    expect(existsSync(dir)).toBe(false);
  });

  it("says so on an unclaimed instance, and uses the running instance's port", async () => {
    const t = testContext();
    const { dataDir } = t.ctx.config;
    try {
      writeFileSync(lockPath(dataDir), JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: 9123, startedAt: "" }));
      let r = cli(["reset-password", "--data", dataDir]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("hasn't been claimed yet");
      expect(r.stdout).toMatch(/http:\/\/127\.0\.0\.1:9123\/setup\?token=[0-9a-z]{24}/);

      t.ctx.settings.setState("admin.passwordHash", "scrypt$x");
      // --data is global: before the command works too.
      r = cli(["--data", dataDir, "reset-password"]);
      expect(r.stdout).toContain("password was removed");
      expect(r.stdout).toContain(":9123/setup?token=");
      expect(t.ctx.settings.getState("admin.passwordHash")).toBeNull();
    } finally {
      rmSync(lockPath(dataDir), { force: true });
      await t.dispose();
    }
  });

  it("rejects an invalid PORT environment variable", () => {
    const r = cli(["reset-password", "--data", "/nonexistent-xaq"], { PORT: "80a" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/No xaq data|PORT="80a"/);
    const s = cli(["start", "--data", mkdtempSync(join(tmpdir(), "xaq-port-"))], { PORT: "80a" });
    expect(s.code).toBe(1);
    expect(s.stderr).toContain('PORT="80a" is not a valid port');
  });
});
