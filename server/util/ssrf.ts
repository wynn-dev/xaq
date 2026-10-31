import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * SSRF guard for outbound URLs (MCP upstreams). A target is refused when its host resolves to a non-public
 * address (private, loopback, link-local, unique-local, CGNAT, multicast, unspecified, reserved),
 * unless the host or the resolved address matches the caller's allowlist (hostnames,
 * "*.suffix" wildcards, IPs or CIDRs). Cloud metadata endpoints are refused unless their exact IP
 * is listed. Callers connect to the returned address (not the hostname) so a second DNS answer
 * cannot swap in a different target (DNS rebinding).
 */

export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

export class SsrfError extends Error {
  constructor(
    /** "dns" is a transient lookup failure; the others are definitive. */
    readonly kind: "blocked" | "unresolved" | "dns",
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network, unspecified
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128],
  ["100::", 64], // discard
  ["64:ff9b:1::", 48], // local-use NAT64: the embedded IPv4 position depends on the operator's prefix
  ["2001::", 32], // Teredo tunnels to arbitrary IPv4 hosts
  ["fc00::", 7], // unique-local, incl. fd00:ec2::254
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** Cloud metadata endpoints: only an exact-IP allowlist entry unlocks these, never a CIDR or hostname. */
const METADATA = new Set(["169.254.169.254", "fd00:ec2::254", "169.254.170.2", "100.100.100.200"]);

/**
 * Canonical form for comparisons. IPv6 addresses that embed an IPv4 address become that IPv4
 * address: IPv4-mapped ("::ffff:10.0.0.1", "::ffff:a00:1"), SIIT ::ffff:0:0:0/96, IPv4-compatible,
 * NAT64 64:ff9b::/96 and 6to4 2002::/16. (Teredo and local-use NAT64 are blocked as whole ranges.)
 */
export function normalizeIp(ip: string): string {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  if (isIP(bare) !== 6) return bare;
  const g = expandV6(bare);
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const mapped = zero(0, 5) && g[5] === 0xffff;
  const compatible = zero(0, 6) && (g[6]! > 0 || g[7]! > 1); // not "::" or "::1"
  const siit = zero(0, 4) && g[4] === 0xffff && g[5] === 0;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6);
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (mapped || siit || compatible || nat64) return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return new URL(`http://[${bare}]/`).hostname.slice(1, -1);
}

/** Eight 16-bit groups of a valid IPv6 address (dotted IPv4 tails included). */
function expandV6(ip: string): number[] {
  const parse = (part: string): number[] =>
    part
      ? part.split(":").flatMap((p) => {
          if (!p.includes(".")) return [parseInt(p, 16)];
          const [a, b, c, d] = p.split(".").map(Number) as [number, number, number, number];
          return [(a << 8) | b, (c << 8) | d];
        })
      : [];
  const [head, tail] = ip.includes("::") ? (ip.split("::") as [string, string]) : [ip, null];
  const h = parse(head);
  if (tail === null) return h;
  const t = parse(tail);
  return [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
}

const family = (ip: string): "ipv4" | "ipv6" => (isIP(ip) === 6 ? "ipv6" : "ipv4");

export function isBlockedAddress(ip: string): boolean {
  const n = normalizeIp(ip);
  return BLOCKED.check(n, family(n)) || METADATA.has(n);
}

interface Allowlist {
  hosts: string[];
  ips: Set<string>;
  nets: BlockList;
}

function compileAllowlist(entries: readonly string[]): Allowlist {
  const out: Allowlist = { hosts: [], ips: new Set(), nets: new BlockList() };
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const slash = entry.indexOf("/");
    if (slash > 0) {
      const net = normalizeIp(entry.slice(0, slash));
      const prefix = Number(entry.slice(slash + 1));
      const fam = isIP(net);
      // A mapped-IPv6 CIDR like ::ffff:10.0.0.0/104 becomes an IPv4 one.
      const adjusted = fam === 4 && isIP(entry.slice(0, slash).replace(/^\[|\]$/g, "")) === 6 ? prefix - 96 : prefix;
      if (fam && Number.isInteger(adjusted) && adjusted >= 0 && adjusted <= (fam === 4 ? 32 : 128)) {
        out.nets.addSubnet(net, adjusted, fam === 4 ? "ipv4" : "ipv6");
      }
      continue;
    }
    const ip = normalizeIp(entry);
    if (isIP(ip)) out.ips.add(ip);
    else out.hosts.push(entry.replace(/\.$/, ""));
  }
  return out;
}

/** Hostname entries match names only: an IP literal is never matched as text (e.g. by "*.0.0.1"). */
function hostAllowed(host: string, list: Allowlist): boolean {
  if (isIP(host)) return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  return list.hosts.some((entry) => (entry.startsWith("*.") ? h.endsWith(entry.slice(1)) : h === entry));
}

function ipAllowed(ip: string, list: Allowlist): boolean {
  return list.ips.has(ip) || list.nets.check(ip, family(ip));
}

/** Wording of resolveTarget's errors, so callers (the MCP broker's upstream fetch) name their own setting. */
export interface TargetMessages {
  /** What the URL is, e.g. "Upstream URL". */
  subject: string;
  /** How to allow a private host. */
  allowHint: (host: string) => string;
  /** Where plain http is allowed. */
  httpHint: string;
  /** Where the hostname is configured. */
  hostHint: string;
}

const URL_MESSAGES: TargetMessages = {
  subject: "URL",
  allowHint: () => "Private addresses aren't allowed here.",
  httpHint: "Plain http is only allowed for loopback addresses.",
  hostHint: "Check the hostname in the URL.",
};

/** Hostname from a URL without IPv6 brackets. */
export const urlHost = (url: URL): string => url.hostname.replace(/^\[|\]$/g, "");

/**
 * Resolves the URL's host and returns the address to connect to. Throws SsrfError when the target
 * is not allowed. Every resolved address must pass, so a mixed answer cannot slip a private one in.
 */
export async function resolveTarget(
  url: URL,
  allowlist: readonly string[],
  lookup: LookupFn = defaultLookup,
  messages: TargetMessages = URL_MESSAGES,
): Promise<ResolvedTarget> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SsrfError("blocked", `${messages.subject} must use http or https`);
  const host = urlHost(url);
  const list = compileAllowlist(allowlist);
  const hostListed = hostAllowed(host, list);
  const literal = isIP(host) ? [{ address: host, family: isIP(host) }] : null;
  let answers: { address: string; family: number }[];
  try {
    answers = literal ?? (await lookup(host));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") throw new SsrfError("unresolved", `Could not resolve ${host}`, messages.hostHint);
    throw new SsrfError("dns", `DNS lookup for ${host} failed: ${(err as Error).message}`);
  }
  if (answers.length === 0) throw new SsrfError("unresolved", `Could not resolve ${host}`, messages.hostHint);
  for (const a of answers) {
    const ip = normalizeIp(a.address);
    if (METADATA.has(ip)) {
      if (list.ips.has(ip)) continue;
      throw new SsrfError("blocked", `${host} resolves to a cloud metadata address (${ip}), which is never allowed`);
    }
    if (!isBlockedAddress(ip) || hostListed || ipAllowed(ip, list)) continue;
    throw new SsrfError(
      "blocked",
      `${host === ip ? ip : `${host} resolves to ${ip}, which`} is a private, loopback or reserved address`,
      messages.allowHint(host),
    );
  }
  // Plain http only where cleartext stays local or was explicitly allowed: mail content travels in it.
  if (url.protocol === "http:" && !hostListed) {
    const local = answers.every((a) => {
      const ip = normalizeIp(a.address);
      return LOOPBACK.check(ip, family(ip)) || ipAllowed(ip, list);
    });
    if (!local) {
      throw new SsrfError("blocked", `${messages.subject}s must use https`, messages.httpHint);
    }
  }
  const first = answers[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}
