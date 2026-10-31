import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { helperNode, helperNodeChoice, serviceNode, trustedNodeFile, userPrivateGroup } from "../server/listen/mcpheader.ts";
import { setupMcp } from "../server/listen/mcpsetup.ts";
import { saveProfile } from "../server/listen/profile.ts";
import { FAKE_KEY, isolateXdg } from "./listen-client-fake.ts";

let env: ReturnType<typeof isolateXdg>;
let home: string;
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
const target = { url: "https://mail.example.com", apiKey: FAKE_KEY, agentId: "a", agentName: "n", consumer: "c" };

beforeEach(() => {
  env = isolateXdg();
  home = join(env.root, "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  env.restore();
});

const backups = (dir: string) => readdirSync(dir).filter((f) => f.includes(".xaq-backup-"));

describe("setup-mcp", () => {
  it("Claude Code: registers a header helper with add-json, so the key is never in argv", () => {
    const bin = join(env.root, "bin");
    mkdirSync(bin);
    const log = join(env.root, "claude-args.txt");
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> ${log}; done; printf -- '--\\n' >> ${log}\n` +
        `if [ "$1 $2" = "mcp add-json" ] && [ -n "$FAIL" ]; then echo "error: bad server $5 $6"; exit 1; fi\nexit 0\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${saved.PATH}`;
    writeFileSync(join(home, ".claude.json"), "{}");

    saveProfile(target);
    const r = setupMcp("claude-code", target, "/p.json");
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain(FAKE_KEY);
    const argvLog = readFileSync(log, "utf8");
    expect(argvLog).not.toContain(FAKE_KEY);
    const calls = argvLog.split("--\n").filter(Boolean).map((c) => c.trim().split("\n"));
    expect(calls[1]).toEqual(["mcp", "remove", "xaq", "--scope", "user"]);
    expect(calls[2]!.slice(0, 5)).toEqual(["mcp", "add-json", "--scope", "user", "xaq"]);
    const entry = JSON.parse(calls[2]![5]!) as { type: string; url: string; headersHelper: string };
    expect(entry).toMatchObject({ type: "http", url: "https://mail.example.com/mcp" });
    expect(backups(home)).toHaveLength(1);
    // It names the Node.js the helper runs with, and how to recover after replacing it.
    // (The node chosen for this machine: process.execPath, or a stable path under Homebrew, fnm, nvm….)
    const node = helperNodeChoice().path;
    expect(entry.headersHelper.startsWith(`'${node}' `)).toBe(true);
    expect(r.notes).toEqual([expect.stringContaining(`Node.js: Claude Code runs the header helper with ${node}`)]);
    expect(r.notes![0]).toContain("run `npx xaq-cli setup-mcp` again");

    // The helper prints the header from the 0600 profile (to a pipe, never a terminal).
    const helper = spawnSync("/bin/sh", ["-c", entry.headersHelper], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(helper.status).toBe(0);
    expect(JSON.parse(helper.stdout)).toEqual({ Authorization: `Bearer ${FAKE_KEY}` });

    process.env.FAIL = "1";
    try {
      const failed = setupMcp("claude-code", target, "/p.json");
      expect(failed.ok).toBe(false);
      expect(failed.message).toContain("add-json failed");
      expect(JSON.stringify(failed)).not.toContain(FAKE_KEY);
    } finally {
      delete process.env.FAIL;
    }
  });

  it("listener service: the stable node, but only one new enough for xaq (22.13+); says which and why", () => {
    const fnm = "/Users/w/Library/Application Support/fnm/node-versions/v24.1.0/installation/bin/node";
    const fnmDefault = "/Users/w/Library/Application Support/fnm/aliases/default/bin/node";
    // Wynn's Mac: fnm v24 interactively, /usr/local/bin/node v22.20 installed too. fnm's default alias is too old here.
    const versions: Record<string, string> = { [fnmDefault]: "22.12.0", "/usr/local/bin/node": "22.20.0", "/usr/bin/node": "18.19.1" };
    const trusted = () => true;
    const chosen = serviceNode(fnm, (p) => versions[p] ?? null, "24.1.0", trusted);
    expect(chosen).toMatchObject({ path: "/usr/local/bin/node", version: "22.20.0", versioned: false });
    expect(chosen.why).toBe(`a stable path that survives fnm/nvm upgrades (this shell's is ${fnm}, v24.1.0)`);
    // Only nodes too old for xaq around: this shell's node, flagged as version-specific.
    const old = serviceNode(fnm, (p) => (p === "/usr/bin/node" ? "20.11.0" : null), "24.1.0", trusted);
    // A candidate someone else could replace (not root's or ours, or group/world-writable) is skipped.
    expect(serviceNode(fnm, (p) => versions[p] ?? null, "24.1.0", (p) => p !== "/usr/local/bin/node").path).toBe(fnm);
    expect(old).toMatchObject({ path: fnm, version: "24.1.0", versioned: true });
    expect(old.why).toContain("re-run install after upgrading or removing it");
    // A node that isn't a version manager's is used as is, without probing anything.
    expect(serviceNode("/usr/local/bin/node", () => { throw new Error("no probing"); }, "22.20.0")).toMatchObject({ path: "/usr/local/bin/node", why: "this shell's node" });
  });

  it("Claude Code: prefers a stable node over a version manager's, only when it exists and works", () => {
    const fnm = "/home/u/.local/share/fnm/node-versions/v24.21.0/installation/bin/node";
    const fnmDefault = "/home/u/.local/share/fnm/aliases/default/bin/node";
    expect(helperNode(fnm, (p) => p === fnmDefault)).toEqual({ path: fnmDefault, versioned: false });
    expect(helperNode(fnm, (p) => p === "/usr/bin/node")).toEqual({ path: "/usr/bin/node", versioned: false });
    expect(helperNode(fnm, () => false)).toEqual({ path: fnm, versioned: true });
    // The older ~/.fnm layout too.
    expect(helperNode("/home/u/.fnm/node-versions/v22.1.0/installation/bin/node", () => true).path).toBe("/home/u/.fnm/aliases/default/bin/node");
    // Homebrew: the keg's opt/ link first (same formula across upgrades), then the prefix's bin/node.
    const cellar = "/opt/homebrew/Cellar/node/24.1.0/bin/node";
    expect(helperNode(cellar, () => true)).toEqual({ path: "/opt/homebrew/opt/node/bin/node", versioned: false });
    expect(helperNode(cellar, (p) => p === "/opt/homebrew/bin/node")).toEqual({ path: "/opt/homebrew/bin/node", versioned: false });
    const keg22 = "/usr/local/Cellar/node@22/22.1.0/bin/node";
    expect(helperNode(keg22, () => true).path).toBe("/usr/local/opt/node@22/bin/node");
    expect(helperNode(keg22, (p) => p === "/usr/local/bin/node").path).toBe("/usr/local/bin/node");
    const nvm = "/home/u/.nvm/versions/node/v22.13.0/bin/node";
    expect(helperNode(nvm, () => false)).toEqual({ path: nvm, versioned: true });
    // asdf, mise and Volta pick a version per directory: only system nodes are tried, never their shims.
    const tried: string[] = [];
    helperNode("/home/u/.asdf/installs/nodejs/22.1.0/bin/node", (p) => (tried.push(p), false));
    expect(tried).toEqual(["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]);
    // A non-versioned node is kept as is, without trying anything.
    expect(helperNode("/usr/bin/node", () => true)).toEqual({ path: "/usr/bin/node", versioned: false });
  });

  it("Claude Code: explains the manual command when the CLI is missing", () => {
    process.env.PATH = "/nonexistent";
    const r = setupMcp("claude-code", target, "/p.json");
    expect(r.ok).toBe(false);
    expect(r.manual?.join("\n")).toContain("claude mcp add-json --scope user xaq");
    expect(r.manual?.join("\n")).toContain("headersHelper");
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });
});

describe("trustedNodeFile", () => {
  it("accepts only files owned by root or this user that aren't group- or world-writable (after symlinks)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aib-node-"));
    const node = join(dir, "node");
    writeFileSync(node, "");
    chmodSync(node, 0o755);
    symlinkSync(node, join(dir, "link"));
    expect(trustedNodeFile(node)).toBe(true);
    expect(trustedNodeFile(join(dir, "link"))).toBe(true);
    expect(trustedNodeFile(node, { uid: 12345 })).toBe(false); // someone else's file
    chmodSync(node, 0o775);
    expect(trustedNodeFile(join(dir, "link"), { privateGid: null })).toBe(false); // group-writable target
    expect(trustedNodeFile(join(dir, "missing"))).toBe(false);
    chmodSync(node, 0o755);
    // A parent directory others can write to (and that isn't sticky): of the real file, or of the link.
    const shared = mkdtempSync(join(tmpdir(), "aib-shared-"));
    const inShared = join(shared, "node");
    writeFileSync(inShared, "");
    chmodSync(inShared, 0o755);
    expect(trustedNodeFile(inShared)).toBe(true);
    chmodSync(shared, 0o777);
    expect(trustedNodeFile(inShared)).toBe(false);
    symlinkSync(inShared, join(dir, "link2"));
    expect(trustedNodeFile(join(dir, "link2"))).toBe(false); // via the target's parent
    chmodSync(shared, 0o1777);
    expect(trustedNodeFile(inShared)).toBe(true); // sticky, like /tmp
    chmodSync(shared, 0o755);
    const looseLinks = mkdtempSync(join(tmpdir(), "aib-links-"));
    symlinkSync(node, join(looseLinks, "node"));
    chmodSync(looseLinks, 0o777);
    expect(trustedNodeFile(join(looseLinks, "node"))).toBe(false); // via the link's own parent
    chmodSync(looseLinks, 0o755);
  });

  /** An fnm tree as umask 002 leaves it: directories 775, the binary 755. */
  const umask002Tree = () => {
    const root = mkdtempSync(join(tmpdir(), "aib-umask-"));
    const bin = join(root, "fnm/node-versions/v24.19.0/installation/bin");
    mkdirSync(bin, { recursive: true });
    for (let d = bin; d !== root; d = dirname(d)) chmodSync(d, 0o775);
    chmodSync(root, 0o775);
    const node = join(bin, "node");
    writeFileSync(node, "");
    chmodSync(node, 0o755);
    return { root, bin, node, gid: statSync(root).gid };
  };

  it("trusts directories writable by the user's private group (umask 002), never world-writable ones", () => {
    const t = umask002Tree();
    expect(trustedNodeFile(t.node, { privateGid: null })).toBe(false);
    expect(trustedNodeFile(t.node, { privateGid: t.gid })).toBe(true);
    expect(trustedNodeFile(t.node, { privateGid: t.gid + 1 })).toBe(false); // another group can write
    chmodSync(t.node, 0o775);
    expect(trustedNodeFile(t.node, { privateGid: t.gid })).toBe(true); // the binary too
    chmodSync(t.bin, 0o777);
    expect(trustedNodeFile(t.node, { privateGid: t.gid })).toBe(false);
    expect(trustedNodeFile(t.node, { privateGid: t.gid, groupWritable: true })).toBe(false);
    chmodSync(t.bin, 0o775);
    chmodSync(t.node, 0o777);
    expect(trustedNodeFile(t.node, { privateGid: t.gid, groupWritable: true })).toBe(false);
    chmodSync(t.node, 0o755);
    // The previous service's Node: any group-writable directory, still not world-writable.
    expect(trustedNodeFile(t.node, { privateGid: null, groupWritable: true })).toBe(true);
  });

  // The real check, as `service install` runs it (no injected group): on a machine with a user-private group.
  it.skipIf(userPrivateGroup() === null || userPrivateGroup() !== process.getgid?.())("trusts the user's own umask-002 fnm tree with the real group lookup", () => {
    const t = umask002Tree();
    expect(t.gid).toBe(userPrivateGroup());
    expect(trustedNodeFile(t.node)).toBe(true);
    chmodSync(t.bin, 0o777);
    expect(trustedNodeFile(t.node)).toBe(false);
  });

  it("knows a user-private group only from /etc/passwd and /etc/group on Linux", () => {
    const passwd = "root:x:0:0::/root:/bin/sh\nada:x:1000:1000::/home/ada:/bin/sh\nbob:x:1001:1001::/home/bob:/bin/sh\n";
    const group = "root:x:0:\nada:x:1000:\nbob:x:1001:\nusers:x:100:ada,bob\n";
    const upg = (o: { passwd?: string; group?: string; uid?: number; platform?: NodeJS.Platform } = {}) =>
      userPrivateGroup({ platform: "linux", uid: 1000, passwd, group, ...o });
    expect(upg()).toBe(1000);
    expect(upg({ group: group.replace("ada:x:1000:", "ada:x:1000:ada") })).toBe(1000); // the user itself listed
    expect(upg({ group: group.replace("ada:x:1000:", "ada:x:1000:bob") })).toBeNull(); // another member
    expect(upg({ passwd: `${passwd}carol:x:1002:1000::/home/carol:/bin/sh\n` })).toBeNull(); // someone else's primary group
    expect(upg({ passwd: passwd.replace("ada:x:1000:1000", "ada:x:1000:100") })).toBeNull(); // the shared `users`
    expect(upg({ group: "root:x:0:\n" })).toBeNull(); // not in /etc/group (LDAP)
    expect(upg({ uid: 4242 })).toBeNull(); // not in /etc/passwd
    expect(upg({ group: `${group}+:::\n` })).toBeNull(); // NIS compat entries
    expect(upg({ uid: 0 })).toBeNull();
    expect(upg({ platform: "darwin" })).toBeNull();
  });
});
