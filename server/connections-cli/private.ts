import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { type LookupFn, normalizeIp, urlHost } from "../util/ssrf.ts";

/**
 * Which upstream URLs need the private-target allow (docs/MCP-BROKER.md#private-targets), decided on the CLI side
 * so the admin can confirm the exact origins before anything is created. The daemon's guard still decides; this
 * only knows what to ask.
 */

/** The ranges a private-target allow may cover: loopback, RFC 1918, CGNAT (Tailscale), ULA. */
const ALLOWABLE = new BlockList();
for (const [net, prefix] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
] as const) {
  ALLOWABLE.addSubnet(net, prefix, "ipv4");
}
ALLOWABLE.addAddress("::1", "ipv6");
ALLOWABLE.addSubnet("fc00::", 7, "ipv6");

/** Never allowed, even by an admin: link-local and cloud metadata. */
const NEVER = new BlockList();
NEVER.addSubnet("169.254.0.0", 16, "ipv4");
NEVER.addSubnet("fe80::", 10, "ipv6");
NEVER.addAddress("fd00:ec2::254", "ipv6");
NEVER.addAddress("100.100.100.200", "ipv4");

export type AddressClass = "public" | "private" | "never";

export function classifyAddress(ip: string): AddressClass {
  const a = normalizeIp(ip);
  const family = isIP(a) === 6 ? "ipv6" : "ipv4";
  if (NEVER.check(a, family)) return "never";
  if (ALLOWABLE.check(a, family)) return "private";
  return "public";
}

/** `scheme://host:port` with the port always spelled out: exactly what a private-target allow pins. */
export function exactOrigin(url: URL): string {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}//${url.hostname}:${port}`;
}

export type TargetCheck =
  | { kind: "public" }
  | { kind: "private"; origin: string; addresses: string[] }
  /** link_local: link-local or cloud metadata; ipv6_literal: the allow takes hostnames and IPv4 only. */
  | { kind: "never"; address: string; why: "link_local" | "ipv6_literal" };

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Whether `url` is on this machine or a private network (resolving names the way the daemon on this host will). */
export async function checkTarget(url: URL, lookup: LookupFn = defaultLookup): Promise<TargetCheck> {
  const host = urlHost(url);
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else if (host === "localhost" || host.endsWith(".localhost")) addresses = ["127.0.0.1"];
  else {
    try {
      addresses = (await lookup(host)).map((a) => a.address);
    } catch {
      // Unresolvable here: the daemon's probe reports it.
      return { kind: "public" };
    }
  }
  const never = addresses.find((a) => classifyAddress(a) === "never");
  if (never) return { kind: "never", address: never, why: "link_local" };
  const priv = addresses.filter((a) => classifyAddress(a) === "private");
  if (priv.length && isIP(host) === 6) return { kind: "never", address: host, why: "ipv6_literal" };
  return priv.length ? { kind: "private", origin: exactOrigin(url), addresses: priv } : { kind: "public" };
}
