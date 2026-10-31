import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_EXIT, runConnect } from "../server/listen/connect.ts";
import { profilePath } from "../server/listen/paths.ts";
import { loadProfile } from "../server/listen/profile.ts";
import { FAKE_KEY, FakeAgentApi, isolateXdg } from "./listen-client-fake.ts";

let api: FakeAgentApi;
let env: ReturnType<typeof isolateXdg>;
let output = "";

beforeEach(async () => {
  env = isolateXdg();
  api = await new FakeAgentApi().start();
  output = "";
  const capture = (chunk: unknown) => {
    output += String(chunk);
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(capture);
  vi.spyOn(process.stderr, "write").mockImplementation(capture);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await api.stop();
  env.restore();
});

const approved = () => ({
  status: "approved" as const,
  apiKey: FAKE_KEY,
  agent: { id: "agt_1", name: "Claude Code on testhost" },
  mcpUrl: `${api.url}/mcp`,
  skillUrl: `${api.url}/skill.md`,
});

describe("connect (device flow)", () => {
  it("writes the key to a 0600 profile in a 0700 dir and never prints it", async () => {
    api.pollScript = [{ status: "pending" }, approved()];
    const code = await runConnect(api.url, { tool: "claude-code", name: "Claude Code on testhost", account: ["me@example.com"] }, { pollIntervalMs: 10 });
    expect(code).toBe(CONNECT_EXIT.approved);

    const path = profilePath();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(saved).toMatchObject({ url: api.url, apiKey: FAKE_KEY, agentId: "agt_1", tool: "claude-code", mcpUrl: `${api.url}/mcp` });
    expect(loadProfile().consumer).toMatch(/^[a-z0-9._-]+$/);

    expect(output).toContain("K7QM-2XPD");
    expect(output).toContain("Approved");
    expect(output).toContain("claude -p");
    expect(output).not.toContain(FAKE_KEY);
    expect(output).not.toContain("dev_secret");

    expect(api.pairingStarts[0]).toMatchObject({
      name: "Claude Code on testhost",
      requested: { accounts: ["me@example.com"] },
      client: { tool: "claude-code", platform: process.platform },
    });
  });

  it("reports a denial with exit code 2 and writes nothing", async () => {
    api.pollScript = [{ status: "denied", note: "not this one" }];
    expect(await runConnect(api.url, {}, { pollIntervalMs: 10 })).toBe(CONNECT_EXIT.denied);
    expect(output).toContain("denied");
    expect(output).toContain("not this one");
    expect(() => loadProfile()).toThrow(/isn't paired yet/);
  });

  it("reports expiry (3) and consumed (4)", async () => {
    api.pollScript = [{ status: "expired" }];
    expect(await runConnect(api.url, {}, { pollIntervalMs: 10 })).toBe(CONNECT_EXIT.expired);
    expect(output).toContain("expired");
    api.pollScript = [{ status: "consumed" }];
    expect(await runConnect(api.url, {}, { pollIntervalMs: 10 })).toBe(CONNECT_EXIT.consumed);
    expect(output).toMatch(/never delivered twice/);
  });

  it("honors the interval and backs off on slow_down", async () => {
    api.interval = 1;
    api.pollScript = [{ status: "slow_down", interval: 2 }, { status: "pending" }, approved()];
    const started = Date.now();
    expect(await runConnect(api.url, {})).toBe(CONNECT_EXIT.approved);
    const [first, second, third] = api.pollTimes;
    expect(first! - started).toBeGreaterThanOrEqual(950);
    // After slow_down the gap is at least the new interval (2 s).
    expect(second! - first!).toBeGreaterThanOrEqual(1950);
    expect(third! - second!).toBeGreaterThanOrEqual(1950);
  }, 15_000);

  it("refuses to overwrite the pairing without --force", async () => {
    api.pollScript = [approved()];
    await runConnect(api.url, {}, { pollIntervalMs: 10 });
    await expect(runConnect(api.url, {}, { pollIntervalMs: 10 })).rejects.toThrow(/already paired[\s\S]*--force/);
    api.pollScript = [approved()];
    expect(await runConnect(api.url, { force: true }, { pollIntervalMs: 10 })).toBe(0);
  });

  it("can be cancelled", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    expect(await runConnect(api.url, {}, { pollIntervalMs: 20, signal: ac.signal })).toBe(CONNECT_EXIT.cancelled);
  });

  it("validates --tool before contacting the daemon", async () => {
    await expect(runConnect(api.url, { tool: "vim" })).rejects.toThrow(/Unknown --tool/);
    expect(api.pairingStarts).toHaveLength(0);
  });
});
