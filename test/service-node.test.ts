// The Node.js the daemon service runs: the one running `service install`, or --node (at least MIN_NODE).
// Nothing here touches a real unit directory: ops.unitDir() is a temp directory and systemctl is a fake.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startupNodeWarning } from "../server/server.ts";
import { installService, nodeVersionOf, type ServiceOps } from "../server/service.ts";
import { testConfig } from "./helpers.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
  vi.restoreAllMocks();
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A fake node: prints `version` for `-p process.versions.node`, and the variables it was given to `env`. */
function fakeNode(path: string, version: string, env?: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${env ? `env > ${env}\n` : ""}echo ${version}\n`);
  chmodSync(path, 0o755);
  return path;
}

function fakeOps(dir: string): ServiceOps & { calls: string[] } {
  const calls: string[] = [];
  let running = false;
  return {
    calls,
    platform: "linux",
    root: false,
    uid: 1000,
    user: "me",
    capture: (_cmd, args) => (args.includes("MainPID") ? `${running ? 4242 : 0}\n` : ""),
    exec(cmd, args) {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "systemctl" && args.includes("enable") && args.includes("--now")) running = true;
      if (cmd === "systemctl" && args.includes("disable")) running = false;
    },
    stage(dataDir) {
      const staging = join(dataDir, "app.new");
      mkdirSync(join(staging, "node_modules/xaq-cli/dist"), { recursive: true });
      writeFileSync(join(staging, "node_modules/xaq-cli/dist/cli.js"), "// new\n");
      return staging;
    },
    unitDir: () => join(dir, "units"),
    waitReady: async () => true,
    instance: () => (running ? { pid: 4242, host: "127.0.0.1", port: 0, startedAt: "s", service: true } : null),
    portInUse: async () => false,
  };
}

describe("service install: the Node it records", () => {
  const setup = () => {
    const config = testConfig();
    cleanup.push(() => rmSync(config.dataDir, { recursive: true, force: true }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    return { config, log, unit: () => readFileSync(join(config.dataDir, "units/xaq.service"), "utf8") };
  };

  it("records the Node running the install", async () => {
    const { config, log, unit } = setup();
    await installService(config, fakeOps(config.dataDir));
    expect(unit()).toContain(`ExecStart="${process.execPath}" `);
    expect(log.mock.calls.flat().join("\n")).toContain(`It runs Node.js ${process.versions.node} at ${process.execPath}.`);
  });

  it("records --node when it is new enough, and refuses one that is too old or doesn't run, changing nothing", async () => {
    const { config, unit } = setup();
    const bin = temp("xaq-node-");
    const good = fakeNode(join(bin, "good/node"), "24.22.1");
    await installService(config, fakeOps(config.dataDir), { node: good });
    expect(unit()).toContain(`ExecStart="${good}" `);
    const before = unit();
    await expect(installService(config, fakeOps(config.dataDir), { node: fakeNode(join(bin, "old/node"), "22.12.0") })).rejects.toThrow(/needs Node\.js 22\.13 or newer.*Nothing was changed/s);
    await expect(installService(config, fakeOps(config.dataDir), { node: join(bin, "missing") })).rejects.toThrow(/doesn't run as Node\.js.*Nothing was changed/s);
    expect(unit()).toBe(before);
  });

  it("asks --node for its version without this shell's secrets", () => {
    const bin = temp("xaq-node-");
    const seen = join(bin, "env.txt");
    const node = fakeNode(join(bin, "node"), "24.22.1", seen);
    process.env.XAQ_MASTER_KEY = "secret";
    process.env.NODE_OPTIONS = "--require /missing.js";
    try {
      expect(nodeVersionOf(node)).toBe("24.22.1");
    } finally {
      delete process.env.XAQ_MASTER_KEY;
      delete process.env.NODE_OPTIONS;
    }
    expect(readFileSync(seen, "utf8")).not.toMatch(/XAQ_MASTER_KEY|NODE_OPTIONS/);
    expect(nodeVersionOf(process.execPath)).toBe(process.versions.node);
  });
});

describe("the October 2026 security release warning", () => {
  it("the daemon logs it at start: the service command under the service, a restart otherwise", () => {
    const config = { dataDir: temp("xaq-data-"), host: "0.0.0.0", port: 8425 };
    expect(startupNodeWarning({ ...config, service: true }, "24.19.0")).toMatch(
      /^Node\.js 24\.19\.0 runs xaq; the October 2026 security release \(22\.23\.4, 24\.22\.1 or 26\.12\.1\) .*then run `[^`]*service install[^`]*` again\.$/,
    );
    expect(startupNodeWarning({ ...config, service: false }, "24.19.0")).toContain("Update Node, then restart xaq.");
    for (const v of ["24.22.1", "22.23.4", "26.12.1", "27.0.0"]) expect(startupNodeWarning({ ...config, service: true }, v), v).toBeNull();
  });
});
