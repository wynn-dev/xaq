import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { helperNode, helperNodeChoice, serviceNode } from "../server/listen/mcpheader.ts";
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
});
