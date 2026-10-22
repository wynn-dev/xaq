// Choosing the Node.js the daemon service runs (server/service-node.ts), against fake Node binaries (shell scripts
// that print a version) laid out like fnm, nvm, Volta and Homebrew under a temp HOME and a temp system root.
// Nothing here touches a real unit directory: ops.unitDir() is a temp directory and systemctl/launchctl are fakes.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeVersionOf as listenerNodeVersionOf, nodeProbeEnv, trustedNodeFile, userPrivateGroup } from "../server/listen/mcpheader.ts";
import { startupNodeWarning } from "../server/server.ts";
import { renderLaunchdPlist, renderSystemdUnit, installService, type ServiceOps, serviceNodeCheck, serviceStatus } from "../server/service.ts";
import {
  chooseServiceNode,
  defaultNodeSearch,
  installedCodeExtensions,
  knownNodes,
  type NodeSearchDeps,
  nodeVersionOf,
  recommendedNodeWarning,
  unitNodePath,
} from "../server/service-node.ts";
import { testConfig } from "./helpers.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A fake node: prints `version` for `-p process.versions.node`. */
function fakeNode(path: string, version: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
  chmodSync(path, 0o755);
  return path;
}

interface Layout {
  home: string;
  root: string;
  deps(installer: { path: string; version: string }, env?: NodeJS.ProcessEnv): NodeSearchDeps;
}

function layout(): Layout {
  const home = temp("xaq-home-");
  const root = temp("xaq-root-");
  return {
    home,
    root,
    deps: (installer, env = {}) => ({ home, root, env, installer, versionOf: nodeVersionOf, trusted: () => true }),
  };
}

const fnm = (l: Layout, v: string) => fakeNode(join(l.home, `.local/share/fnm/node-versions/v${v}/installation/bin/node`), v);
const nvm = (l: Layout, v: string) => fakeNode(join(l.home, `.nvm/versions/node/v${v}/bin/node`), v);
const volta = (l: Layout, v: string) => fakeNode(join(l.home, `.volta/tools/image/node/${v}/bin/node`), v);
const brew = (l: Layout, v: string, sub = "usr/local/bin/node") => fakeNode(join(l.root, sub), v);

const NONE = { previous: [], codeExtensions: [], rerun: "npx xaq-cli service install" };
const CODE = { ...NONE, codeExtensions: ["whoop"] };

describe("service Node: selection", () => {
  it("chooses the installer's Node when it has the October 2026 security release", () => {
    const l = layout();
    fnm(l, "24.25.0");
    const installer = fakeNode(join(l.home, "inst/bin/node"), "24.22.1");
    const pick = chooseServiceNode(CODE, l.deps({ path: installer, version: "24.22.1" }));
    expect(pick).toMatchObject({ path: installer, version: "24.22.1", source: "installer", codeReady: true, recommended: true });
  });

  it("prefers a found Node with the October 2026 security release over an installer's that only meets the floor", () => {
    const l = layout();
    const installer = fakeNode(join(l.home, "inst/bin/node"), "24.19.0");
    const older = fnm(l, "24.20.0");
    // Nothing recommended: the installer's floor-meeting Node is still accepted.
    expect(chooseServiceNode(CODE, l.deps({ path: installer, version: "24.19.0" }))).toMatchObject({ path: installer, source: "installer", codeReady: true, recommended: false });
    const rec = nvm(l, "24.22.1");
    const pick = chooseServiceNode(CODE, l.deps({ path: installer, version: "24.19.0" }));
    expect(pick).toMatchObject({ path: rec, version: "24.22.1", source: "found", codeReady: true, recommended: true });
    expect(pick.why).toBe(`found at ${rec} (nvm), the newest one that has Node's October 2026 security release (22.23.4, 24.22.1 or 26.12.1); the Node running this install is 24.19.0`);
    expect(pick.path).not.toBe(older);
    // Without code extensions too.
    expect(chooseServiceNode(NONE, l.deps({ path: installer, version: "24.19.0" }))).toMatchObject({ path: rec, recommended: true });
  });

  it("chooses the old service's Node when the installer's is too old for code extensions", () => {
    const l = layout();
    const old = brew(l, "22.20.0");
    const prev = fnm(l, "24.22.1");
    fnm(l, "24.25.0"); // newer, but the previous service's Node comes first
    const pick = chooseServiceNode({ ...CODE, previous: [prev] }, l.deps({ path: old, version: "22.20.0" }));
    expect(pick).toMatchObject({ path: prev, version: "24.22.1", source: "previous", why: "the Node the previous service used" });
  });

  it("reads the previous Node from a systemd unit and a launchd plist", () => {
    const spec = { entry: "/e", dataDir: "/d", port: 1, host: "h", extraEnv: {} };
    expect(unitNodePath(renderSystemdUnit({ ...spec, execPath: '/opt/my "node"/bin/node' }))).toBe('/opt/my "node"/bin/node');
    expect(unitNodePath(renderLaunchdPlist({ ...spec, execPath: "/Users/me/a&b/node" }))).toBe("/Users/me/a&b/node");
    expect(unitNodePath("[Service]\n")).toBeNull();
  });

  it("searches fnm, nvm, Volta, Homebrew and /usr/bin, and the newest qualifying Node wins", () => {
    const l = layout();
    const a = fnm(l, "22.23.2");
    const b = nvm(l, "24.30.0");
    const c = volta(l, "24.18.1");
    const d = brew(l, "26.12.1", "opt/homebrew/opt/node@26/bin/node");
    const e = brew(l, "20.0.0", "usr/bin/node");
    expect(knownNodes(l.deps({ path: "/x", version: "1.0.0" })).map((n) => n.path)).toEqual([a, b, c, d, e]);
    const old = fakeNode(join(l.home, "old/node"), "22.20.0");
    const pick = chooseServiceNode(CODE, l.deps({ path: old, version: "22.20.0" }));
    expect(pick).toMatchObject({ path: d, version: "26.12.1", source: "found" });
    expect(pick.why).toContain(`found at ${d} (Homebrew)`);
  });

  it("breaks a version tie by search order, and skips Nodes below the floor however new their line", () => {
    const l = layout();
    const first = fnm(l, "24.19.0");
    nvm(l, "24.19.0");
    volta(l, "26.1.0"); // 26 but below 26.5.1
    const old = fakeNode(join(l.home, "old/node"), "22.20.0");
    expect(chooseServiceNode(CODE, l.deps({ path: old, version: "22.20.0" })).path).toBe(first);
  });

  it("finds fnm under $FNM_DIR and macOS's Application Support", () => {
    const l = layout();
    const custom = fakeNode(join(l.home, "custom-fnm/node-versions/v24.20.0/installation/bin/node"), "24.20.0");
    const mac = fakeNode(join(l.home, "Library/Application Support/fnm/node-versions/v24.21.0/installation/bin/node"), "24.21.0");
    const paths = knownNodes({ home: l.home, root: l.root, env: { FNM_DIR: join(l.home, "custom-fnm") } }).map((n) => n.path);
    expect(paths).toEqual([custom, mac]);
  });

  it("never records an fnm multishell link: the installer's is resolved to the install it points to", () => {
    const l = layout();
    const real = fnm(l, "24.19.0");
    const alias = join(l.home, ".local/share/fnm/aliases/default");
    mkdirSync(dirname(alias), { recursive: true });
    symlinkSync(dirname(dirname(real)), alias);
    const shell = join(l.home, ".local/state/fnm_multishells/123_456");
    mkdirSync(dirname(shell), { recursive: true });
    symlinkSync(alias, shell);
    const pick = chooseServiceNode(CODE, l.deps({ path: join(shell, "bin/node"), version: "24.19.0" }));
    expect(pick.path).toBe(real);
    expect(pick.path).not.toContain("fnm_multishells");
  });

  it("skips a dangling multishell link left in the previous service", () => {
    const l = layout();
    const old = brew(l, "22.20.0");
    const good = nvm(l, "24.19.0");
    const gone = join(l.home, ".local/state/fnm_multishells/999_1/bin/node");
    const pick = chooseServiceNode({ ...CODE, previous: [gone] }, l.deps({ path: old, version: "22.20.0" }));
    expect(pick).toMatchObject({ path: good, source: "found" });
  });

  it("without code extensions, xaq's own minimum applies (still preferring a floor-meeting Node)", () => {
    const l = layout();
    const old = brew(l, "22.20.0");
    expect(chooseServiceNode(NONE, l.deps({ path: old, version: "22.20.0" }))).toMatchObject({ path: old, source: "installer", codeReady: false });
    const good = fnm(l, "24.19.0");
    expect(chooseServiceNode(NONE, l.deps({ path: old, version: "22.20.0" }))).toMatchObject({ path: good, source: "found", codeReady: true });
  });

  it("fails with what it found, what's needed and the fix when nothing qualifies", () => {
    const l = layout();
    const old = brew(l, "22.20.0");
    const nv = nvm(l, "22.22.0");
    const err = (() => {
      try {
        chooseServiceNode(CODE, l.deps({ path: old, version: "22.20.0" }));
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err?.message).toContain("No Node.js on this machine can run your code extensions, so the service was not installed. Nothing was changed.");
    expect(err?.message).toContain("Code extensions (whoop) need Node.js 22.23.2+, 24.18.1+ or 26.5.1+ (or a newer line).");
    expect(err?.message).toContain(`${old} → 22.20.0 (the Node running this install)`);
    expect(err?.message).toContain(`${nv} → 22.22.0 (nvm)`);
    expect(err?.message).toContain("fnm install 24 && fnm default 24");
    expect(err?.message).toContain("brew install node@24");
    expect(err?.message).toContain("npx xaq-cli service install --node /path/to/node");
  });

  it("--node is used when new enough, and refused when too old for code extensions", () => {
    const l = layout();
    const old = brew(l, "22.20.0");
    const good = fnm(l, "24.19.0");
    expect(chooseServiceNode({ ...CODE, flag: good }, l.deps({ path: old, version: "22.20.0" }))).toMatchObject({ path: good, source: "flag" });
    expect(() => chooseServiceNode({ ...CODE, flag: old }, l.deps({ path: good, version: "24.19.0" }))).toThrow(
      /--node .*can't run the service \(it is Node\.js 22\.20\.0\)\. Code extensions \(whoop\) need Node\.js 22\.23\.2\+/,
    );
    // Without code extensions, the same Node is fine.
    expect(chooseServiceNode({ ...NONE, flag: old }, l.deps({ path: good, version: "24.19.0" }))).toMatchObject({ path: old, source: "flag" });
  });

  it("asks the binary, not the path, for its version", () => {
    const l = layout();
    const liar = fakeNode(join(l.home, ".nvm/versions/node/v24.30.0/bin/node"), "22.20.0");
    expect(nodeVersionOf(liar)).toBe("22.20.0");
    expect(nodeVersionOf(join(l.home, "missing"))).toBeNull();
  });
});

describe("service Node: probing a binary", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("runs it with a minimal environment: no XAQ_MASTER_KEY, no NODE_OPTIONS, nothing else exported", () => {
    const l = layout();
    const out = join(l.home, "env.txt");
    const spy = join(l.home, "spy/node");
    mkdirSync(dirname(spy), { recursive: true });
    writeFileSync(spy, `#!/bin/sh\nenv > '${out}'\necho 24.22.1\n`);
    chmodSync(spy, 0o755);
    vi.stubEnv("XAQ_MASTER_KEY", "a".repeat(64));
    vi.stubEnv("NODE_OPTIONS", "--require /nonexistent/xaq-probe.cjs");
    vi.stubEnv("XAQ_TEST_SECRET", "s3cret");
    vi.stubEnv("LANG", "C.UTF-8");
    expect(nodeVersionOf(spy)).toBe("24.22.1");
    const seen = readFileSync(out, "utf8");
    expect(seen).not.toContain("XAQ_MASTER_KEY");
    expect(seen).not.toContain("NODE_OPTIONS");
    expect(seen).not.toContain("s3cret");
    expect(seen).toContain(`HOME=${process.env.HOME}`);
    expect(seen).toContain("LANG=C.UTF-8");
    expect(nodeProbeEnv({ PATH: "/bin", HOME: "/h", LANG: "C", NODE_OPTIONS: "--x", XAQ_MASTER_KEY: "k" })).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C" });
  });

  it("a NODE_OPTIONS that would break a real Node can't break detection", () => {
    vi.stubEnv("NODE_OPTIONS", "--require /nonexistent/xaq-probe.cjs");
    // The same NODE_OPTIONS does break a Node that inherits it.
    const broken = spawnSync(process.execPath, ["-p", "process.versions.node"], { encoding: "utf8" });
    expect(broken.status).not.toBe(0);
    expect(nodeVersionOf(process.execPath)).toBe(process.versions.node);
    expect(listenerNodeVersionOf(process.execPath)).toBe(process.versions.node);
  });

  it("kills a binary that ignores SIGTERM when the probe times out", () => {
    const l = layout();
    const stuck = join(l.home, "stuck/node");
    mkdirSync(dirname(stuck), { recursive: true });
    writeFileSync(stuck, "#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n");
    chmodSync(stuck, 0o755);
    const t0 = Date.now();
    expect(nodeVersionOf(stuck, 300)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("service Node: the real permission check (umask 002)", () => {
  /** Makes every directory from `top` down to the binary group-writable (775), as fnm does under umask 002. */
  const loosen = (top: string, node: string) => {
    for (let d = dirname(node); d.startsWith(top); d = dirname(d)) chmodSync(d, 0o775);
  };
  const real = (l: Layout, installer: { path: string; version: string }): NodeSearchDeps => ({ ...l.deps(installer), trusted: defaultNodeSearch().trusted });

  it.skipIf(userPrivateGroup() === null || userPrivateGroup() !== process.getgid?.())("finds the user's own fnm Node in group-writable directories of their private group", () => {
    const l = layout();
    const old = brew(l, "22.20.0");
    const node = fnm(l, "24.22.1");
    loosen(join(l.home, ".local"), node);
    const pick = chooseServiceNode(CODE, real(l, { path: old, version: "22.20.0" }));
    expect(pick).toMatchObject({ path: node, source: "found" });
  });

  it("trusts the previous service's group-writable Node, refuses it world-writable, and says which", () => {
    const l = layout();
    const old = brew(l, "22.20.0");
    const prev = fnm(l, "24.19.0");
    const other = nvm(l, "24.22.1");
    loosen(join(l.home, ".local"), prev);
    loosen(join(l.home, ".nvm"), other);
    // No private group here: only the previous service's Node may be group-writable.
    const deps: NodeSearchDeps = { ...l.deps({ path: old, version: "22.20.0" }), trusted: (p, previous) => trustedNodeFile(p, { privateGid: null, groupWritable: previous }) };
    expect(chooseServiceNode({ ...CODE, previous: [prev] }, deps)).toMatchObject({ path: prev, source: "previous" });
    chmodSync(dirname(prev), 0o777);
    const err = (() => {
      try {
        chooseServiceNode({ ...CODE, previous: [prev] }, deps);
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err?.message).toContain(`${prev} → doesn't run (the previous service's: world-writable or owned by another user, skipped)`);
    expect(err?.message).toContain(`${other} → doesn't run (nvm: group- or world-writable, or owned by another user, skipped)`);
    chmodSync(dirname(prev), 0o755);
  });
});

describe("the October 2026 security release warning", () => {
  it("warns below RECOMMENDED_NODE, at or above the floor, with the fix", () => {
    const w = recommendedNodeWarning("24.19.0", "npx xaq-cli service install");
    expect(w).toBe(
      [
        "Node.js 24.19.0 runs xaq; the October 2026 security release (22.23.4, 24.22.1 or 26.12.1) fixes a sandbox bypass and high-severity issues in Node itself. Update Node, then run `npx xaq-cli service install` again. For example:",
        "    fnm install 24 && fnm default 24",
        "    nvm install 24 && nvm alias default 24",
        "    brew upgrade node@24",
      ].join("\n  "),
    );
    for (const v of ["24.22.1", "22.23.4", "26.12.1", "27.0.0"]) expect(recommendedNodeWarning(v, "x"), v).toBeNull();
    expect(recommendedNodeWarning("22.23.2")).toContain("Update Node, then restart xaq.");
  });

  it("the daemon logs it at start: the service command under the service, a restart otherwise", () => {
    const config = { dataDir: temp("xaq-data-"), host: "0.0.0.0", port: 8425 };
    expect(startupNodeWarning({ ...config, service: true }, "24.19.0")).toMatch(/^Node\.js 24\.19\.0 runs xaq; .*then run `[^`]*service install[^`]*` again/);
    expect(startupNodeWarning({ ...config, service: false }, "24.19.0")).toContain("Update Node, then restart xaq.");
    expect(startupNodeWarning({ ...config, service: true }, "24.22.1")).toBeNull();
  });
});

// ───────────── installService with fake systemd ─────────────

/** Records a data directory's installed code extensions, as the extension store would. */
function addCodeExtension(dbPath: string, name: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS extensions (name TEXT PRIMARY KEY, kind TEXT NOT NULL)");
  db.prepare("INSERT INTO extensions (name, kind) VALUES (?, 'code')").run(name);
  db.close();
}

function fakeOps(dir: string, nodeSearch: Partial<NodeSearchDeps>): ServiceOps & { calls: string[] } {
  const calls: string[] = [];
  let running = false;
  return {
    calls,
    platform: "linux",
    root: false,
    uid: 1000,
    user: "me",
    capture: (cmd, args) => (args.includes("MainPID") ? `${running ? 4242 : 0}\n` : ""),
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
    nodeSearch,
  };
}

describe("service install: the Node it records", () => {
  const setup = () => {
    const config = testConfig();
    cleanup.push(() => rmSync(config.dataDir, { recursive: true, force: true }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return { config, log, l: layout() };
  };

  it("writes the previous unit's Node when the installer's is too old, and says why", async () => {
    const { config, log, l } = setup();
    addCodeExtension(config.dbPath, "whoop");
    const old = brew(l, "22.20.0");
    const prev = fnm(l, "24.19.0");
    mkdirSync(join(config.dataDir, "units"), { recursive: true });
    writeFileSync(join(config.dataDir, "units/xaq.service"), renderSystemdUnit({ execPath: prev, entry: "/e", dataDir: config.dataDir, port: 0, host: "127.0.0.1", extraEnv: {} }));
    await installService(config, fakeOps(config.dataDir, l.deps({ path: old, version: "22.20.0" })));
    expect(unitNodePath(readFileSync(join(config.dataDir, "units/xaq.service"), "utf8"))).toBe(prev);
    const out = log.mock.calls.flat().join("\n");
    expect(out).toContain(`It runs Node.js 24.19.0 at ${prev}: the Node the previous service used.`);
    expect(out).toContain("Warning: Node.js 24.19.0 runs xaq; the October 2026 security release (22.23.4, 24.22.1 or 26.12.1)");
  });

  it("fails before touching anything when no Node can run the installed code extensions", async () => {
    const { config, log, l } = setup();
    addCodeExtension(config.dbPath, "whoop");
    const old = brew(l, "22.20.0");
    const ops = fakeOps(config.dataDir, l.deps({ path: old, version: "22.20.0" }));
    await expect(installService(config, ops)).rejects.toThrow(/No Node\.js on this machine can run your code extensions.*Nothing was changed/s);
    expect(existsSync(join(config.dataDir, "units/xaq.service"))).toBe(false);
    expect(existsSync(join(config.dataDir, "app"))).toBe(false);
    expect(ops.calls.filter((c) => !c.endsWith("daemon-reload"))).toEqual([]);
    expect(log.mock.calls.flat().join("\n")).not.toContain("Installed");
  });

  it("refuses a too-old --node while code extensions are installed", async () => {
    const { config, l } = setup();
    addCodeExtension(config.dbPath, "whoop");
    const good = fnm(l, "24.19.0");
    const old = brew(l, "22.20.0");
    await expect(installService(config, fakeOps(config.dataDir, l.deps({ path: good, version: "24.19.0" })), { node: old })).rejects.toThrow(/--node .* can't run the service/);
    expect(existsSync(join(config.dataDir, "units/xaq.service"))).toBe(false);
  });
});

describe("service status: the service's Node", () => {
  const unitFor = (dataDir: string, node: string) => renderSystemdUnit({ execPath: node, entry: "/e", dataDir, port: 8425, host: "0.0.0.0", extraEnv: {} });

  it("flags a Node below the code-extension floor while code extensions are installed, with the fix", () => {
    const dataDir = temp("xaq-data-");
    const l = layout();
    const old = brew(l, "22.20.0");
    expect(serviceNodeCheck(unitFor(dataDir, old)).problem).toBeNull();
    addCodeExtension(join(dataDir, "xaq.db"), "whoop");
    expect(installedCodeExtensions(join(dataDir, "xaq.db"))).toEqual(["whoop"]);
    const { problem, warning } = serviceNodeCheck(unitFor(dataDir, old));
    expect(problem).toContain(`The service runs ${old}, which is Node.js 22.20.0. Code extensions (whoop) need Node.js 22.23.2+, 24.18.1+ or 26.5.1+ (or a newer line).`);
    expect(problem).toContain("--node /path/to/node");
    expect(warning).toBeNull(); // the problem says it all
    expect(serviceNodeCheck(unitFor(dataDir, fnm(l, "24.19.0"))).problem).toBeNull();
    expect(serviceNodeCheck(unitFor(dataDir, fnm(l, "24.22.1")))).toEqual({ problem: null, warning: null });
  });

  it("warns, without changing the exit code, on a Node at or above the floor but below the October 2026 release", () => {
    const dataDir = temp("xaq-data-");
    const l = layout();
    addCodeExtension(join(dataDir, "xaq.db"), "whoop");
    const ops = fakeOps(dataDir, {});
    mkdirSync(join(dataDir, "units"), { recursive: true });
    writeFileSync(join(dataDir, "units/xaq.service"), unitFor(dataDir, fnm(l, "24.19.0")));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    serviceStatus(ops);
    const out = log.mock.calls.flat().join("\n");
    expect(out).toContain(
      "Warning: Node.js 24.19.0 runs xaq; the October 2026 security release (22.23.4, 24.22.1 or 26.12.1) fixes a sandbox bypass and high-severity issues in Node itself. Update Node, then run `",
    );
    expect(out).toMatch(/service install --data .* again\. For example:\n {6}fnm install 24 && fnm default 24\n {6}nvm install 24/);
    expect(out).not.toContain("Problem:");
    expect(process.exitCode).toBe(0);
  });

  it("reports it from `service status` and exits non-zero", () => {
    const dataDir = temp("xaq-data-");
    const l = layout();
    addCodeExtension(join(dataDir, "xaq.db"), "whoop");
    const ops = fakeOps(dataDir, {});
    mkdirSync(join(dataDir, "units"), { recursive: true });
    writeFileSync(join(dataDir, "units/xaq.service"), unitFor(dataDir, brew(l, "22.20.0")));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    serviceStatus(ops);
    expect(log.mock.calls.flat().join("\n")).toMatch(/Problem: The service runs .*Node\.js 22\.20\.0/);
    expect(process.exitCode).toBe(1);
  });
});
