import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { helperNode, helperNodeChoice, serviceNode } from "../server/listen/mcpheader.ts";
import { codexBlock, removeTomlServer, setupMcp, upsertYamlServer } from "../server/listen/mcpsetup.ts";
import { saveProfile } from "../server/listen/profile.ts";
import { FAKE_KEY, isolateXdg } from "./listen-client-fake.ts";

let env: ReturnType<typeof isolateXdg>;
let home: string;
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, HERMES_HOME: process.env.HERMES_HOME };
const target = { name: "xaq", url: "https://mail.example.com/mcp", key: FAKE_KEY };

beforeEach(() => {
  env = isolateXdg();
  home = join(env.root, "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.HERMES_HOME;
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

    saveProfile("default", { url: "https://mail.example.com", apiKey: FAKE_KEY, agentId: "a", agentName: "n", consumer: "c" });
    const r = setupMcp("claude-code", { ...target, profile: "default" }, "/p.json");
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
    const node = helperNodeChoice().path;
    expect(entry.headersHelper.startsWith(`'${node}' `)).toBe(true);
    expect(r.notes).toEqual([expect.stringContaining(`Node.js: Claude Code runs the header helper with ${node}`)]);
    expect(r.notes![0]).toContain("run `npx xaq-cli setup-mcp --tool claude-code` again");

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

  it("records the node running the command, and says when its path belongs to one Node version", () => {
    const fnm = "/home/u/.local/share/fnm/node-versions/v24.21.0/installation/bin/node";
    expect(helperNode(fnm)).toEqual({ path: fnm, versioned: true });
    expect(helperNode("/opt/homebrew/Cellar/node/24.1.0/bin/node").versioned).toBe(true);
    expect(helperNode("/usr/bin/node")).toEqual({ path: "/usr/bin/node", versioned: false });
    expect(serviceNode("/usr/local/bin/node", "22.20.0")).toMatchObject({ path: "/usr/local/bin/node", version: "22.20.0", why: "this shell's node" });
    expect(serviceNode(fnm, "24.21.0").why).toContain("re-run install after upgrading or removing it");
  });

  it("Claude Code: explains the manual command when the CLI is missing", () => {
    process.env.PATH = "/nonexistent";
    const r = setupMcp("claude-code", target, "/p.json");
    expect(r.ok).toBe(false);
    expect(r.manual?.join("\n")).toContain("claude mcp add-json --scope user xaq");
    expect(r.manual?.join("\n")).toContain("headersHelper");
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
  });

  it("Codex: replaces our table in config.toml, keeps the rest, backs up, 0600", () => {
    const dir = join(home, ".codex");
    mkdirSync(dir);
    const file = join(dir, "config.toml");
    writeFileSync(
      file,
      `model = "o5"\n\n[mcp_servers.xaq]\nurl = "https://old/mcp"\n\n[mcp_servers.xaq.env]\nX = "1"\n\n[mcp_servers.other]\ncommand = "x"\n`,
    );
    const r = setupMcp("codex", target, "/p.json");
    expect(r.ok).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain('model = "o5"');
    expect(text).toContain("[mcp_servers.other]");
    expect(text).not.toContain("https://old/mcp");
    expect(text).not.toContain("[mcp_servers.xaq.env]");
    expect(text.match(/\[mcp_servers\.xaq\]/g)).toHaveLength(1);
    expect(text).toContain(`http_headers = { Authorization = "Bearer ${FAKE_KEY}" }`);
    expect(text).toContain('default_tools_approval_mode = "approve"');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(backups(dir)).toHaveLength(1);
    expect(r.message).not.toContain(FAKE_KEY);
  });

  it("Codex: refuses inline mcp_servers definitions", () => {
    expect(removeTomlServer(`mcp_servers = { xaq = { url = "x" } }\n`, "xaq")).toBeNull();
    expect(removeTomlServer(`[x]\nmcp_servers.xaq.url = "x"\n`, "xaq")).toBeNull();
    expect(removeTomlServer(`[mcp_servers."xaq"]\nurl = "x"\n[y]\nz = 1\n`, "xaq")).toBe(`[y]\nz = 1\n`);
    expect(codexBlock(target)).toContain("[mcp_servers.xaq]");
  });

  it("Cursor: merges mcp.json", () => {
    const dir = join(home, ".cursor");
    mkdirSync(dir);
    const file = join(dir, "mcp.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, extra: true }));
    expect(setupMcp("cursor", target, "/p.json").ok).toBe(true);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    expect(doc).toEqual({
      mcpServers: { other: { command: "x" }, xaq: { url: target.url, headers: { Authorization: `Bearer ${FAKE_KEY}` } } },
      extra: true,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "{ // comment\n}");
    const r = setupMcp("cursor", target, "/p.json");
    expect(r.ok).toBe(false);
    expect(r.manual?.length).toBeGreaterThan(0);
  });

  it("Hermes: adds mcp_servers to config.yaml and the key to .env", () => {
    const dir = join(home, ".hermes");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.yaml"), `model: hermes-4\nmcp_servers:\n    github:\n        command: gh-mcp\n    xaq:\n        url: "https://old"\ntoolsets: [web]\n`);
    writeFileSync(join(dir, ".env"), "OPENROUTER_API_KEY=x\nXAQ_API_KEY=old\n");
    const r = setupMcp("hermes", target, "/p.json");
    expect(r.ok).toBe(true);
    const yaml = readFileSync(join(dir, "config.yaml"), "utf8");
    expect(yaml).toBe(
      `model: hermes-4\nmcp_servers:\n    xaq:\n        url: "https://mail.example.com/mcp"\n        headers:\n          Authorization: "Bearer \${XAQ_API_KEY}"\n    github:\n        command: gh-mcp\ntoolsets: [web]\n`,
    );
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`OPENROUTER_API_KEY=x\nXAQ_API_KEY=${FAKE_KEY}\n`);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(yaml).not.toContain(FAKE_KEY);
  });

  it("Hermes: YAML edge cases", () => {
    const entry = ['url: "u"'];
    expect(upsertYamlServer("", "xaq", entry)).toBe('mcp_servers:\n  xaq:\n    url: "u"\n');
    expect(upsertYamlServer("a: 1\nmcp_servers: {}\n", "xaq", entry)).toBe('a: 1\nmcp_servers:\n  xaq:\n    url: "u"\n');
    expect(upsertYamlServer("mcp_servers: { x: 1 }\n", "xaq", entry)).toBeNull();
    expect(existsSync(join(home, ".hermes"))).toBe(false);
  });
});
