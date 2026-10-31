import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveProfile } from "../server/listen/profile.ts";
import { FAKE_KEY, FakeAgentApi, isolateXdg, makeEvent, waitFor } from "./listen-client-fake.ts";

const ROOT = join(import.meta.dirname, "..");

function cli(args: string[], env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, ["--import", "tsx", "server/cli.ts", ...args], { cwd: ROOT, env: { ...process.env, ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, exit, output: () => output };
}

let api: FakeAgentApi;
let env: ReturnType<typeof isolateXdg>;
let xdg: Record<string, string | undefined>;
beforeEach(async () => {
  env = isolateXdg();
  xdg = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  api = await new FakeAgentApi().start();
});
afterEach(async () => {
  await api.stop();
  env.restore();
});

describe("xaq CLI (subprocess)", () => {
  it("connect pairs, prints the code and next steps, never the key", async () => {
    api.pollScript = [{ status: "approved", apiKey: FAKE_KEY, agent: { id: "agt_9", name: "Hermes on box" }, mcpUrl: `${api.url}/mcp`, skillUrl: `${api.url}/skill.md` }];
    const run = cli(["connect", api.url, "--tool", "hermes"], xdg);
    expect(await run.exit).toBe(0);
    const out = run.output();
    expect(out).toContain("K7QM-2XPD");
    // Not Claude Code: the agent runs from the user's own script, and its MCP client is pointed by hand.
    expect(out).toContain("npx xaq-cli listen --exec /path/to/handle-email.sh");
    expect(out).toContain(`MCP endpoint (streamable HTTP): ${api.url}/mcp`);
    expect(out).not.toContain("$(");
    expect(out).toContain("npx xaq-cli listen service install --exec /path/to/handle-email.sh");
    expect(out).not.toContain(FAKE_KEY);
  }, 30_000);

  it("connect --log works from the real command line (the SKILL.md self-setup)", async () => {
    api.pollScript = [{ status: "approved", apiKey: FAKE_KEY, agent: { id: "agt_9", name: "x" }, mcpUrl: `${api.url}/mcp`, skillUrl: `${api.url}/skill.md` }];
    const log = join(env.root, "connect.log");
    const run = cli(["connect", api.url, "--name", "Smoke on box", "--tool", "claude-code", "--log", log], xdg);
    expect(await run.exit).toBe(0);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("K7QM-2XPD");
    expect(text).toContain("Approved");
    expect(text).not.toContain(FAKE_KEY);
    expect(statSync(log).mode & 0o777).toBe(0o600);

  }, 30_000);

  it("listen --recipe rejects unknown tools and --exec alongside it, before connecting", async () => {
    saveProfile({ url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c" });
    const bad = cli(["listen", "--recipe", "vim"], xdg);
    expect(await bad.exit).toBe(1);
    expect(bad.output()).toContain('Unknown --recipe "vim". The built-in recipe is claude-code');
    const both = cli(["listen", "service", "install", "--recipe", "claude-code", "--exec", "cat"], xdg);
    expect(await both.exit).toBe(1);
    expect(both.output()).toContain("--recipe and --exec can't be combined");
    // Without a target, the service install points at --recipe first.
    const none = cli(["listen", "service", "install"], xdg);
    expect(await none.exit).toBe(1);
    expect(none.output()).toContain("Nothing for the service to run. Pass --recipe claude-code or --exec");
    expect(api.live.size).toBe(0);
  }, 30_000);

  it("listen exits 78 when access is revoked, so services don't restart-loop", async () => {
    saveProfile({ url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c", exec: "cat > /dev/null" });
    const run = cli(["listen"], xdg);
    await waitFor(() => api.live.size === 1, 15_000, "stream");
    api.publish(makeEvent(1));
    await waitFor(() => api.acked === 1, 10_000, "ack");
    api.revoke("agent_deleted");
    expect(await run.exit).toBe(78);
    expect(run.output()).toContain("Access revoked: This agent was deleted");
    expect(run.output()).not.toContain(FAKE_KEY);

    const status = cli(["listen", "status"], xdg);
    expect(await status.exit).toBe(0);
    expect(status.output()).toMatch(/Key\s+rejected/);
    expect(status.output()).toMatch(/not running \(stopped .*revoked: This agent was deleted/);
    expect(status.output()).toMatch(/acked #1/);
  }, 30_000);

  it("listen stops cleanly on SIGTERM", async () => {
    saveProfile({ url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c", exec: "cat > /dev/null" });
    const run = cli(["listen", "--exec", "cat > /dev/null", "--types", "message.received"], xdg);
    await waitFor(() => api.live.size === 1, 15_000, "stream");
    run.child.kill("SIGTERM");
    expect(await run.exit).toBe(0);
    expect(run.output()).toContain("Stopped.");
  }, 30_000);

  it("listen without a target explains what to pass", async () => {
    saveProfile({ url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", agentName: "t", consumer: "c" });
    const run = cli(["listen"], xdg);
    expect(await run.exit).toBe(1);
    expect(run.output()).toContain("--exec");
  }, 30_000);
});
