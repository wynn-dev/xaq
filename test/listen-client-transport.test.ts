import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConnect } from "../server/listen/connect.ts";
import { runListener } from "../server/listen/listen.ts";
import { saveProfile } from "../server/listen/profile.ts";
import { checkTransport, normalizeDaemonUrl, TransportError } from "../server/listen/transport.ts";
import { FAKE_KEY, FakeAgentApi, isolateXdg } from "./listen-client-fake.ts";

describe("transport rule", () => {
  it("accepts https and loopback http", async () => {
    expect((await checkTransport("https://mail.example.com")).kind).toBe("https");
    for (const u of ["http://localhost:8425", "http://127.0.0.1:8425", "http://127.9.9.9", "http://[::1]:8425", "http://xaq.localhost"]) {
      expect((await checkTransport(u)).kind, u).toBe("loopback");
    }
  });

  it("refuses plain http to other hosts", async () => {
    for (const u of ["http://mail.example.com", "http://192.168.1.10:8425", "http://10.0.0.5", "http://100.128.0.1", "http://[fd00::1]"]) {
      await expect(checkTransport(u), u).rejects.toBeInstanceOf(TransportError);
    }
  });

  it("allows Tailscale addresses (100.64.0.0/10, fd7a:115c:a1e0::/48)", async () => {
    for (const u of ["http://100.64.0.1:8425", "http://100.101.102.103", "http://100.127.255.254", "http://[fd7a:115c:a1e0::1]:8425"]) {
      expect((await checkTransport(u)).kind, u).toBe("tailscale");
    }
  });

  it("allows *.ts.net only when it resolves to tailnet addresses", async () => {
    const tailnet = async () => ["100.100.1.2"];
    const publicIp = async () => ["100.100.1.2", "203.0.113.7"];
    const none = async () => [] as string[];
    expect((await checkTransport("http://box.tail1234.ts.net:8425", { resolve: tailnet })).kind).toBe("tailscale");
    await expect(checkTransport("http://box.tail1234.ts.net", { resolve: publicIp })).rejects.toThrow(/Refusing plain http/);
    await expect(checkTransport("http://box.tail1234.ts.net", { resolve: none })).rejects.toThrow(/Refusing plain http/);
    // Look-alike domains don't count.
    await expect(checkTransport("http://evil-ts.net", { resolve: tailnet })).rejects.toThrow(/Refusing plain http/);
  });

  it("--insecure allows it with a loud warning", async () => {
    const v = await checkTransport("http://mail.example.com", { insecure: true });
    expect(v.kind).toBe("insecure");
    expect(v.warning).toMatch(/INSECURE/);
  });

  it("normalizes daemon URLs", () => {
    expect(normalizeDaemonUrl("https://mail.example.com/")).toBe("https://mail.example.com");
    expect(normalizeDaemonUrl("mail.example.com")).toBe("https://mail.example.com");
    expect(() => normalizeDaemonUrl("ftp://x")).toThrow(/http/);
    expect(() => normalizeDaemonUrl("https://u:p@x")).toThrow(/credentials/);
  });
});

describe("transport rule in the commands", () => {
  let env: ReturnType<typeof isolateXdg>;
  let output = "";
  beforeEach(() => {
    env = isolateXdg();
    output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => ((output += String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((output += String(c)), true));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    env.restore();
  });

  it("connect refuses a non-loopback http URL before sending anything", async () => {
    await expect(runConnect("http://192.0.2.10:8425", {})).rejects.toThrow(/Refusing plain http to 192\.0\.2\.10:8425/);
  });

  it("listen refuses it too, and prints the warning on every start when connect was --insecure", async () => {
    const profile = { url: "http://192.0.2.10:9", apiKey: FAKE_KEY, agentId: "agt_1", agentName: "x", consumer: "c", exec: "true" };
    saveProfile(profile);
    await expect(runListener({ flags: {} })).rejects.toThrow(/Refusing plain http/);

    // Paired with --insecure, it starts (and keeps retrying the unreachable host until stopped).
    saveProfile({ ...profile, insecure: true });
    const api = await new FakeAgentApi().start();
    try {
      const ac = new AbortController();
      const run = runListener({ flags: {}, signal: ac.signal, minBackoffMs: 50, maxBackoffMs: 100 });
      await new Promise((r) => setTimeout(r, 300));
      ac.abort();
      expect(await run).toBe(0);
      expect(output).toMatch(/INSECURE: talking to 192\.0\.2\.10:9 over plain http/);
    } finally {
      await api.stop();
    }
  });
});

describe("client info header", () => {
  it("is valid JSON and always a legal (ASCII) header value", async () => {
    const { clientHeader } = await import("../server/listen/api.ts");
    const h = clientHeader();
    expect(h).toMatch(/^[\x20-\x7e]+$/);
    expect(Object.keys(JSON.parse(h))).toEqual(["hostname", "platform", "version"]);
    expect(JSON.parse(JSON.stringify({ h: "café" }).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)).h).toBe("café");
  });
});
