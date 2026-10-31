import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BannerEnv, bannerLines, sameLoopbackServer, startServer, tunnelCommand } from "../server/server.ts";
import { fakeGoogle, fakeIngest, harness, json } from "./platform-helpers.ts";
import { testConfig } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const cli = (...args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", join(ROOT, "server/cli.ts"), ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });

describe("startServer", () => {
  it("listens on a free port, serves requests and closes cleanly", async () => {
    const config = testConfig();
    const running = await startServer({ config, overrides: { google: fakeGoogle(), ingest: fakeIngest() } });
    try {
      expect(config.port).toBeGreaterThan(0);
      expect(running.url).toBe(`http://127.0.0.1:${config.port}`);
      const res = await fetch(`${running.url}/api/health`);
      expect(res.status).toBe(200);
      expect((await json(res)).version).toBe("0.0.0-test");
      expect(running.ctx.settings.publicUrl()).toBe(`http://localhost:${config.port}`);
    } finally {
      await running.close();
      await running.close();
      rmSync(config.dataDir, { recursive: true, force: true });
    }
  });

  it("reports a busy port in plain words", async () => {
    const first = testConfig();
    const running = await startServer({ config: first, overrides: { google: fakeGoogle(), ingest: fakeIngest() } });
    const second = testConfig({ port: first.port });
    try {
      await expect(startServer({ config: second })).rejects.toThrow(/already in use/);
    } finally {
      await running.close();
      rmSync(first.dataDir, { recursive: true, force: true });
      rmSync(second.dataDir, { recursive: true, force: true });
    }
  });
});

describe("startup banner", () => {
  const desktop: BannerEnv = { env: { DISPLAY: ":0" }, platform: "linux", addresses: [], hostname: "box", username: "ada" };
  // oxlint-disable-next-line no-control-regex
  const text = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

  async function withHarness(fn: (h: ReturnType<typeof harness>) => Promise<void> | void) {
    const h = harness();
    h.ctx.config.port = 8425;
    try {
      await fn(h);
    } finally {
      await h.dispose();
    }
  }

  it("first run on a desktop: one setup link, how to keep it running, no tunnel", () =>
    withHarness((h) => {
      const out = text(bannerLines(h.ctx, { mcp: true }, desktop));
      expect(out).toContain("xaq is running.");
      expect(out).toContain("Open this link to finish setup (the console walks you through what to connect and your first agent):");
      expect(out).toContain(`http://127.0.0.1:8425/setup?token=${h.setupToken()}`);
      expect(out).toContain("Keep this terminal open; Ctrl-C stops it.");
      expect(out).toMatch(new RegExp(`service install --data \\S*${h.ctx.config.dataDir.split("/").pop()} --host 127\\.0\\.0\\.1$`, "m"));
      expect(out).not.toContain("ssh -L");
      expect(out).not.toContain("Heads up");
    }));

  it("first run over SSH on a public server: tunnel command and a one-line exposure warning", () =>
    withHarness((h) => {
      h.ctx.config.host = "0.0.0.0";
      const env: BannerEnv = {
        env: { SSH_CONNECTION: "203.0.113.9 50022 198.51.100.7 22" },
        platform: "linux",
        addresses: ["192.168.1.5", "198.51.100.7"],
        hostname: "box",
        username: "ada",
      };
      const out = text(bannerLines(h.ctx, { mcp: true }, env));
      const token = h.setupToken()!;
      expect(out).toContain(`http://localhost:8425/setup?token=${token}`);
      expect(out).toContain(`http://192.168.1.5:8425/setup?token=${token}`);
      expect(out).toContain("ssh -L 8425:localhost:8425 ada@198.51.100.7 (your usual ssh host or alias works)");
      expect(out).toContain("then open the link above in its browser");
      const warning = out.split("\n").filter((l) => l.includes("Heads up"));
      expect(warning).toHaveLength(1);
      expect(warning[0]).toContain("198.51.100.7:8425");
      expect(warning[0]).not.toContain("192.168.1.5");
      expect(warning[0]).toContain("--host 127.0.0.1");
    }));

  it("tunnel: -p for a non-standard SSH port, a placeholder for private server IPs, Tailscale allowed", () =>
    withHarness((h) => {
      const tunnel = (conn: string, extra: Partial<BannerEnv> = {}) =>
        tunnelCommand(h.ctx.config, { ...desktop, env: { SSH_CONNECTION: conn }, ...extra });
      expect(tunnel("203.0.113.9 50022 198.51.100.7 2222")).toBe("ssh -p 2222 -L 8425:localhost:8425 ada@198.51.100.7");
      for (const ip of ["10.1.2.3", "172.20.0.5", "192.168.1.5", "169.254.1.1", "127.0.0.1", "fd12::1", "fe80::1", "::1"]) {
        expect(tunnel(`203.0.113.9 50022 ${ip} 22`)).toBe("ssh -L 8425:localhost:8425 <the host you ssh to>");
      }
      expect(tunnel("100.101.102.1 50022 100.91.67.127 22")).toBe("ssh -L 8425:localhost:8425 ada@100.91.67.127");
      expect(tunnel("203.0.113.9 50022 2001:db8::7 22", { username: "" })).toBe("ssh -L 8425:localhost:8425 2001:db8::7");
      // SSH_TTY alone (no SSH_CONNECTION): still a tunnel hint, with the placeholder.
      expect(tunnelCommand(h.ctx.config, { ...desktop, env: { SSH_TTY: "/dev/pts/1" } })).toBe("ssh -L 8425:localhost:8425 <the host you ssh to>");
    }));

  it("tunnel over sudo names the invoking user, not root", () =>
    withHarness((h) => {
      // The default banner env is read from the process.
      const keys = ["SUDO_USER", "USER", "SSH_CONNECTION"] as const;
      const saved = keys.map((k) => process.env[k]);
      Object.assign(process.env, { SUDO_USER: "ada", USER: "root", SSH_CONNECTION: "203.0.113.9 50022 198.51.100.7 22" });
      try {
        expect(text(bannerLines(h.ctx, { mcp: true }))).toContain("ssh -L 8425:localhost:8425 ada@198.51.100.7");
      } finally {
        keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
      }
    }));

  it("headless without SSH (a container, a console): no tunnel, open the link elsewhere", () =>
    withHarness((h) => {
      const out = text(bannerLines(h.ctx, { mcp: true }, { ...desktop, env: {} }));
      expect(out).not.toContain("ssh -L");
      expect(out).toContain("Open the link from a machine with a browser");
    }));

  it("over SSH with a non-loopback bind address, the laptop-side link is spelled out", () =>
    withHarness((h) => {
      h.ctx.config.host = "10.0.0.4";
      const out = text(bannerLines(h.ctx, { mcp: true }, { ...desktop, env: { SSH_CONNECTION: "203.0.113.9 1 198.51.100.7 22" } }));
      expect(out).toContain("ssh -L 8425:10.0.0.4:8425 ada@198.51.100.7");
      expect(out).toContain(`then open http://localhost:8425/setup?token=${h.setupToken()}`);
    }));

  it("once claimed: console URL and the MCP endpoint, no setup link or tunnel", () =>
    withHarness(async (h) => {
      await h.claim();
      const out = text(bannerLines(h.ctx, { mcp: true }, { ...desktop, env: { SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" } }));
      // Bound to 127.0.0.1, address still the default localhost: one loopback host, the saved address.
      expect(out).toMatch(/Console\s+http:\/\/localhost:8425\n/);
      expect(out).not.toContain("127.0.0.1:8425");
      expect(out).toContain("Agents connect to http://localhost:8425/mcp");
      expect(out).not.toContain("setup?token");
      expect(out).not.toContain("ssh -L");
      expect(out).toContain("Ctrl-C stops it");
    }));

  it("once claimed: the console URL is the saved loopback address, never two spellings of it", () =>
    withHarness(async (h) => {
      await h.claim();
      h.ctx.settings.update({ publicUrl: "http://127.0.0.1:8425" });
      let out = text(bannerLines(h.ctx, { mcp: true }, desktop));
      expect(out).toMatch(/Console\s+http:\/\/127\.0\.0\.1:8425\n/);
      expect(out).toContain("Agents connect to http://127.0.0.1:8425/mcp");
      expect(out).not.toContain("localhost:8425");
      // A different port (a tunnel or proxy) or a real address: both lines stay.
      h.ctx.settings.update({ publicUrl: "https://mail.example.com" });
      out = text(bannerLines(h.ctx, { mcp: true }, desktop));
      expect(out).toMatch(/Console\s+http:\/\/127\.0\.0\.1:8425\n\s+https:\/\/mail\.example\.com\n/);
      h.ctx.settings.update({ publicUrl: "http://localhost:9000" });
      out = text(bannerLines(h.ctx, { mcp: true }, desktop));
      expect(out).toMatch(/Console\s+http:\/\/127\.0\.0\.1:8425\n\s+http:\/\/localhost:9000\n/);
      // Bound to 127.0.0.1, saved as [::1]: another IP family, not the same server. Both lines stay.
      h.ctx.settings.update({ publicUrl: "http://[::1]:8425" });
      out = text(bannerLines(h.ctx, { mcp: true }, desktop));
      expect(out).toMatch(/Console\s+http:\/\/127\.0\.0\.1:8425\n\s+http:\/\/\[::1\]:8425\n/);
    }));

  it("sameLoopbackServer: the same host, or localhost and an IP; never 127.0.0.1 and [::1]", () => {
    expect(sameLoopbackServer("http://127.0.0.1:8425", "http://localhost:8425")).toBe(true);
    expect(sameLoopbackServer("http://localhost:8425", "http://127.0.0.1:8425")).toBe(true);
    expect(sameLoopbackServer("http://[::1]:8425", "http://localhost:8425")).toBe(true);
    expect(sameLoopbackServer("http://127.0.0.1:8425", "http://127.0.0.1:8425")).toBe(true);
    expect(sameLoopbackServer("http://127.0.0.1:8425", "http://[::1]:8425")).toBe(false);
    expect(sameLoopbackServer("http://[::1]:8425", "http://127.0.0.1:8425")).toBe(false);
    expect(sameLoopbackServer("http://127.0.0.1:8425", "http://localhost:9000")).toBe(false);
    expect(sameLoopbackServer("http://127.0.0.1:8425", "https://localhost:8425")).toBe(false);
    expect(sameLoopbackServer("http://127.0.0.1:8425", "http://localhost:8425/inbox")).toBe(false);
    expect(sameLoopbackServer("http://192.168.1.5:8425", "http://localhost:8425")).toBe(false);
  });

  it("as a service: never prints the setup token, points at reset-password", () =>
    withHarness((h) => {
      h.ctx.config.service = true;
      const out = text(bannerLines(h.ctx, { mcp: true }, desktop));
      expect(out).not.toContain(h.setupToken()!);
      expect(out).toContain("reset-password --data");
      expect(out).not.toContain("Ctrl-C");
    }));
});

describe("cli", () => {
  it("prints the version, and installs the skill into a directory", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
    expect(cli("--version").trim()).toBe(pkg.version);

    const dir = mkdtempSync(join(tmpdir(), "xaq-skills-"));
    try {
      cli("skill", "install", "--target", dir, "--url", "http://10.0.0.5:8425");
      expect(readFileSync(join(dir, "xaq", "SKILL.md"), "utf8")).toContain("http://10.0.0.5:8425/mcp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("groups commands for a newcomer and shows examples", () => {
    const help = cli("--help");
    expect(help).toContain("open the link it prints");
    expect(help).toMatch(/Run xaq:\n\s+start/);
    expect(help).toMatch(/On an agent's machine:[\s\S]*connect[\s\S]*listen/);
    expect(help).toContain("npx xaq-cli connect https://mail.example.com");
    expect(help).toContain("docs/reference.md");
  });

  it("fails without a stack trace on bad input", () => {
    try {
      cli("skill", "install", "--target", tmpdir(), "--url", "nope");
      expect.unreachable();
    } catch (err) {
      const stderr = String((err as { stderr?: string }).stderr);
      expect(stderr).toContain('Invalid --url "nope"');
      expect(stderr).not.toMatch(/\n\s+at /);
    }
  });
});
