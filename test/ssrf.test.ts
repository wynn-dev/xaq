import { describe, expect, it } from "vitest";
import { isBlockedAddress, type LookupFn, normalizeIp, resolveTarget, SsrfError } from "../server/util/ssrf.ts";

const DEFAULT_ALLOWLIST = ["localhost", "127.0.0.0/8", "::1"];

const fakeDns =
  (records: Record<string, string[]>): LookupFn =>
  async (host) => {
    const addrs = records[host];
    if (!addrs) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };

const check = (url: string, allowlist: string[] = [], dns: Record<string, string[]> = {}) => resolveTarget(new URL(url), allowlist, fakeDns(dns));

async function refused(p: Promise<unknown>): Promise<SsrfError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SsrfError);
  return err as SsrfError;
}

describe("normalizeIp", () => {
  it("unwraps IPv4 embedded in IPv6", () => {
    expect(normalizeIp("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIp("::ffff:a00:1")).toBe("10.0.0.1");
    expect(normalizeIp("0:0:0:0:0:ffff:7f00:1")).toBe("127.0.0.1");
    expect(normalizeIp("[::ffff:127.0.0.1]")).toBe("127.0.0.1");
    expect(normalizeIp("64:ff9b::a9fe:a9fe")).toBe("169.254.169.254");
    expect(normalizeIp("::1")).toBe("::1");
    expect(normalizeIp("FD00:EC2:0:0:0:0:0:254")).toBe("fd00:ec2::254");
    expect(normalizeIp("::ffff:0:a00:1")).toBe("10.0.0.1"); // SIIT
    expect(normalizeIp("2002:7f00:1::")).toBe("127.0.0.1"); // 6to4
    expect(normalizeIp("2002:a9fe:a9fe::1")).toBe("169.254.169.254");
  });
});

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "::ffff:192.168.0.1",
    "::ffff:7f00:1",
    "::ffff:0:7f00:1",
    "2002:7f00:1::",
    "2002:a00:1::1",
    "64:ff9b:1::a00:1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2002:808:808::1"])("allows %s", (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe("resolveTarget", () => {
  it("allows public hosts and returns the resolved address", async () => {
    await expect(check("https://hooks.example.com/x", [], { "hooks.example.com": ["93.184.216.34"] })).resolves.toEqual({ address: "93.184.216.34", family: 4 });
    await expect(check("https://[2606:4700:4700::1111]/x")).resolves.toEqual({ address: "2606:4700:4700::1111", family: 6 });
  });

  it("refuses private literals with an allowlist hint", async () => {
    const err = await refused(check("http://10.0.0.5:8080/hook"));
    expect(err.kind).toBe("blocked");
    expect(err.message).toMatch(/10\.0\.0\.5 is a private/);
    expect(err.hint).toMatch(/Private addresses/);
    await refused(check("http://192.168.1.10/"));
    await refused(check("http://[fd12::1]/"));
  });

  it("refuses IPv4-mapped IPv6 literals", async () => {
    await refused(check("http://[::ffff:127.0.0.1]/"));
    await refused(check("http://[::ffff:a9fe:a9fe]/"));
  });

  it("refuses a DNS name resolving to loopback, and any mixed answer", async () => {
    const err = await refused(check("https://evil.example.com/", [], { "evil.example.com": ["127.0.0.1"] }));
    expect(err.message).toMatch(/evil\.example\.com resolves to 127\.0\.0\.1/);
    await refused(check("https://mixed.example.com/", [], { "mixed.example.com": ["93.184.216.34", "10.0.0.1"] }));
    await refused(check("https://v6.example.com/", [], { "v6.example.com": ["::ffff:10.0.0.1"] }));
  });

  it("uses the real resolver for localhost", async () => {
    await refused(resolveTarget(new URL("http://localhost:9/"), []));
    await expect(resolveTarget(new URL("http://localhost:9/"), DEFAULT_ALLOWLIST)).resolves.toBeTruthy();
  });

  it("honours allowlisted CIDRs, IPs and hostnames", async () => {
    await expect(check("http://10.1.2.3/", ["10.0.0.0/8"])).resolves.toEqual({ address: "10.1.2.3", family: 4 });
    await expect(check("http://[::ffff:10.1.2.3]/", ["10.0.0.0/8"])).resolves.toBeTruthy();
    await expect(check("http://[fd12::5]/", ["fd12::/16"])).resolves.toBeTruthy();
    await expect(check("http://192.168.0.7/", ["192.168.0.7"])).resolves.toBeTruthy();
    await refused(check("http://192.168.0.8/", ["192.168.0.7", "10.0.0.0/8"]));
    await expect(check("http://n8n.internal/", ["n8n.internal"], { "n8n.internal": ["10.9.9.9"] })).resolves.toBeTruthy();
    await expect(check("http://a.corp.lan/", ["*.corp.lan"], { "a.corp.lan": ["10.9.9.9"] })).resolves.toBeTruthy();
    await expect(check("http://other.lan/", ["10.0.0.0/8"], { "other.lan": ["10.9.9.9"] })).resolves.toBeTruthy();
    await refused(check("http://other.lan/", ["172.16.0.0/12"], { "other.lan": ["10.9.9.9"] }));
  });

  it("refuses cloud metadata unless its exact IP is allowlisted", async () => {
    const err = await refused(check("http://169.254.169.254/latest/meta-data", ["169.254.0.0/16"]));
    expect(err.message).toMatch(/metadata/);
    await refused(check("http://[fd00:ec2::254]/", ["fc00::/7"]));
    await refused(check("http://meta.example.com/", ["meta.example.com"], { "meta.example.com": ["169.254.169.254"] }));
    await expect(check("http://169.254.169.254/", ["169.254.169.254"])).resolves.toBeTruthy();
  });

  it("refuses IPv6 ranges that embed private IPv4 addresses", async () => {
    await refused(check("https://[2002:7f00:1::]/"));
    expect((await refused(check("https://[2002:a9fe:a9fe::]/", ["169.254.0.0/16"]))).message).toMatch(/metadata/);
    await refused(check("https://[64:ff9b:1::a00:1]/"));
    await refused(check("https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/"));
    await refused(check("https://[::ffff:0:a00:1]/"));
    await expect(check("https://[2002:a00:1::]/", ["10.0.0.0/8"])).resolves.toBeTruthy();
  });

  it("requires https unless the target is loopback or allowlisted", async () => {
    const err = await refused(check("http://hooks.example.com/", [], { "hooks.example.com": ["93.184.216.34"] }));
    expect(err.message).toMatch(/https/);
    expect(err.hint).toMatch(/loopback/);
    await refused(check("http://93.184.216.34/"));
    await expect(check("http://127.0.0.1:9/", ["127.0.0.0/8"])).resolves.toBeTruthy();
    await expect(check("http://[::1]:9/", ["::1"])).resolves.toBeTruthy();
    await expect(check("http://hooks.example.com/", ["hooks.example.com"], { "hooks.example.com": ["93.184.216.34"] })).resolves.toBeTruthy();
    await expect(check("http://10.1.1.1/", ["10.0.0.0/8"])).resolves.toBeTruthy();
    // Loopback without an allowlist entry is still refused by the private-address rule.
    await refused(check("http://127.0.0.1/"));
  });

  it("never matches hostname wildcards against IP literals", async () => {
    await refused(check("http://127.0.0.1/", ["*.0.0.1"]));
    await refused(check("https://[::ffff:10.0.0.1]/", ["*.0.1"]));
  });

  it("reports unresolvable hosts and bad schemes", async () => {
    expect((await refused(check("https://nope.invalid/"))).kind).toBe("unresolved");
    expect((await refused(check("ftp://example.com/"))).kind).toBe("blocked");
  });
});
