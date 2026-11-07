import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, buildConnector, type Dispatcher, Pool, ProxyAgent, fetch as undiciFetch } from "undici";
import { type LookupFn, normalizeIp, resolveTarget, type ResolvedTarget, SsrfError, type TargetMessages, urlHost } from "../../util/ssrf.ts";
import { SourceError } from "../types.ts";

/**
 * The broker's one outbound fetch for upstream MCP servers and their OAuth endpoints:
 * - every hop is checked with the SSRF guard `resolveTarget` and the connection is pinned to the checked
 *   address (an undici Agent whose `connect.lookup` only ever answers that address: no DNS rebinding);
 * - redirects are manual, re-checked at every hop, at most MAX_REDIRECTS; credentials are dropped when a
 *   redirect leaves the origin;
 * - response bodies are capped (`maxBytes`), streamed bodies included;
 * - a checked address is reused for TARGET_TTL_MS (no DNS lookup per request, one keep-alive pool per origin);
 * - a request whose connection never opened is retried with backoff (nothing was sent, so any method is safe);
 * - https goes through HTTPS_PROXY (NO_PROXY honoured, as curl reads them) with CONNECT to the checked address.
 *
 * Private targets are refused unless the connection has a private-target allow (`PrivateTargetAllow`): it
 * is pinned to one exact origin and unlocks loopback, RFC 1918, CGNAT and ULA there, plus plain http on
 * that origin only. Link-local and cloud metadata stay blocked (resolveTarget refuses metadata unless the
 * exact IP is listed, and these CIDRs never list it).
 */

/** Admin-set allow for one connection: the exact `scheme://host:port` the admin entered (normalised origin). */
export interface PrivateTargetAllow {
  origin: string;
}

/** Ranges the private-target allow unlocks. Never link-local (169.254/16, fe80::/10) or metadata. */
export const PRIVATE_ALLOW_CIDRS: readonly string[] = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
];

export const MAX_REDIRECTS = 3;
/** Default response cap: MCP results are text; 16 MiB is far beyond any sane tool result. */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** `scheme://host:port` with the default port made explicit, so `http://h` and `http://h:80` compare equal. */
export function originKey(url: URL | string): string {
  const u = typeof url === "string" ? new URL(url) : url;
  const port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
  return `${u.protocol}//${u.hostname.toLowerCase()}:${port}`;
}

/** IPv6 forms that embed an IPv4 address (mapped, compatible, NAT64, 6to4): never accepted under an allow. */
const embedsV4 = (ip: string): boolean => isIP(ip) === 6 && isIP(normalizeIp(ip)) === 4;

export class PrivateTargetError extends Error {}

/**
 * The canonical `scheme://host:port` for a private-target allow (`connections.private_target`). The input must
 * already be exactly that form: explicit port, lowercase host, no path, query, fragment, userinfo, `\`, `%`,
 * blanks or control characters. Numeric IPv4 spellings (hex, octal, decimal) and IPv4-embedding IPv6 are
 * refused (the URL parser rewrites them, so they never equal their canonical form, or are caught explicitly).
 */
export function canonicalPrivateTarget(input: string): string {
  const fail = (why: string): never => {
    throw new PrivateTargetError(`The private-target allow must be exactly scheme://host:port (e.g. http://127.0.0.1:3773): ${why}`);
  };
  if (typeof input !== "string" || input.length > 300) fail("not a short string");
  // oxlint-disable-next-line no-control-regex -- refusing control characters is the point here
  if (/[\\%\s\u0000-\u001f\u007f@?#[\]]/.test(input)) fail("it contains a character that isn't allowed (IPv6 literals aren't accepted: use a hostname)");
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return fail("it isn't a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") fail("only http and https");
  if (u.username || u.password) fail("no credentials");
  if (u.pathname !== "/" || u.search || u.hash) fail("no path, query or fragment");
  if (embedsV4(urlHost(u))) fail("IPv4-mapped IPv6 addresses aren't accepted; use the IPv4 address");
  const canonical = originKey(u);
  if (canonical !== input) fail(`write it as ${canonical}`);
  return canonical;
}

/**
 * The allow for a stored `private_target`, or null when unset. Defensively null too when it isn't canonical or
 * isn't the connection URL's own origin: the allow only ever covers the connection's own host, whatever the API did.
 */
export function allowFromColumn(privateTarget: string | null, connectionUrl: string | null): PrivateTargetAllow | null {
  if (!privateTarget || !connectionUrl) return null;
  try {
    const origin = canonicalPrivateTarget(privateTarget);
    return origin === originKey(connectionUrl) ? { origin } : null;
  } catch {
    return null;
  }
}

/** Upstream URLs as entered: http(s), no userinfo. Logs and audit name only `originKey(url)`: paths can carry tokens. */
export function validateUpstreamUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new SourceError("protocol", "That isn't a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SourceError("blocked_target", "MCP server URLs must use https (or http on an allowed private host)");
  if (u.username || u.password) throw new SourceError("blocked_target", "MCP server URLs can't carry a username or password; use a header or OAuth instead");
  if (u.hash) u.hash = "";
  return u;
}

const systemLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

const messages = (allowed: boolean): TargetMessages => ({
  subject: "Upstream URL",
  allowHint: () =>
    allowed
      ? "Only loopback, private (RFC 1918), CGNAT and unique-local addresses can be allowed; link-local and cloud metadata never are."
      : "If this is a server on this machine or your private network, the admin can allow this exact host for this connection.",
  httpHint: allowed
    ? "Plain http is only accepted when the allowed host resolves to a private address."
    : "Plain http is only accepted on a connection's own allowed private host.",
  hostHint: "Check the hostname in the connection's URL.",
});

export interface GuardedFetchOptions {
  allow?: PrivateTargetAllow | null;
  /** DNS resolver (tests). */
  lookup?: LookupFn;
  maxBytes?: number;
  /**
   * Tests only: where to actually connect for a checked target (e.g. a fake tailnet host listening on loopback).
   * The guard still checks the real resolved address first. `plain`: speak plain HTTP even to an https URL (a fake
   * public https server, listening without TLS on loopback).
   */
  dial?: (target: ResolvedTarget, url: URL) => { address: string; port: number; plain?: boolean };
  /** Where HTTPS_PROXY/NO_PROXY are read (tests); process.env by default. */
  env?: NodeJS.ProcessEnv;
}

export type GuardedFetch = ((input: string | URL, init?: RequestInit) => Promise<Response>) & {
  /** Closes the pooled pinned connections. */
  close(): Promise<void>;
};

/** Checks one URL against the guard (no request). Throws SourceError("blocked_target"). */
export async function checkTarget(url: URL, opts: GuardedFetchOptions = {}): Promise<ResolvedTarget> {
  if (url.username || url.password) throw new SourceError("blocked_target", "Upstream URLs can't carry credentials");
  const allowed = !!opts.allow && originKey(url) === opts.allow.origin;
  let lookup = opts.lookup ?? systemLookup;
  const host = urlHost(url);
  if (allowed) {
    // Under an allow, an IPv4-embedding IPv6 answer is refused outright (it would otherwise normalise into a range).
    if (embedsV4(host)) throw new SourceError("blocked_target", "IPv4-mapped IPv6 addresses aren't accepted for a private host");
    if (!isIP(host)) {
      const base = lookup;
      let answers: { address: string; family: number }[] | null = null;
      try {
        answers = await base(host);
      } catch {
        // resolveTarget repeats the lookup and reports the failure in its own words.
      }
      if (answers?.some((a) => embedsV4(a.address))) throw new SourceError("blocked_target", `${host} resolves to an IPv4-mapped IPv6 address, which isn't accepted for a private host`);
      if (answers) lookup = async () => answers;
    }
  }
  try {
    return await resolveTarget(url, allowed ? PRIVATE_ALLOW_CIDRS : [], lookup, messages(allowed));
  } catch (err) {
    if (err instanceof SsrfError) {
      if (err.kind === "dns") throw new SourceError("unavailable", err.message);
      throw new SourceError("blocked_target", err.hint ? `${err.message}. ${err.hint}` : err.message);
    }
    throw err;
  }
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);
const REDIRECT = new Set([301, 302, 303, 307, 308]);
/** Headers kept on a cross-origin redirect (plus mcp-*); everything else may be a credential. */
const SAFE_CROSS_ORIGIN = new Set(["accept", "accept-language", "content-type", "content-length", "user-agent", "last-event-id", "cache-control"]);

/** A body stream that errors once more than `max` bytes have passed. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new SourceError("protocol", `Upstream response exceeded ${max} bytes`));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/** How long a checked address is reused for its origin before it is resolved and checked again. */
export const TARGET_TTL_MS = 60_000;
/** Backoff before each retry of a request whose connection never opened. */
export const CONNECT_RETRY_MS = [250, 1_000];
/** Errors raised before a connection exists: the request never left, so it can be sent again whatever its method. */
const NOT_CONNECTED = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "UND_ERR_CONNECT_TIMEOUT"]);

function notConnected(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    if (NOT_CONNECTED.has((e as { code?: string }).code ?? "")) return true;
  }
  return false;
}

/** A body that can be sent again (a redirect or a retry); a stream can't. */
const replayable = (body: unknown): boolean => body === null || typeof body === "string" || body instanceof URLSearchParams || body instanceof Uint8Array;

/**
 * The proxy for an https URL: https_proxy/HTTPS_PROXY (else http_proxy/HTTP_PROXY) unless no_proxy/NO_PROXY names the
 * host (exact, or a parent domain; `*` for all; `host:port` for one port), as undici's EnvHttpProxyAgent reads them.
 */
export function proxyFor(url: URL, env: NodeJS.ProcessEnv): string | null {
  if (url.protocol !== "https:") return null;
  const proxy = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
  if (!proxy) return null;
  const host = url.hostname.toLowerCase();
  const port = Number(url.port || 443);
  for (const entry of (env.no_proxy ?? env.NO_PROXY ?? "").split(/[,\s]/)) {
    if (!entry) continue;
    if (entry === "*") return null;
    const m = /^(.+):(\d+)$/.exec(entry);
    if (m && Number(m[2]) !== port) continue;
    const name = (m ? m[1]! : entry).replace(/^\*?\./, "").toLowerCase();
    if (host === name || host.endsWith(`.${name}`)) return null;
  }
  return proxy;
}

/** Builds the guarded fetch for one connection. */
export function guardedFetch(opts: GuardedFetchOptions = {}): GuardedFetch {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const env = opts.env ?? process.env;
  const agents = new Map<string, Dispatcher>();
  const targets = new Map<string, { target: ResolvedTarget; until: number }>();

  /** The checked address for the URL's origin, resolved again once it is TARGET_TTL_MS old. */
  const resolve = async (url: URL): Promise<ResolvedTarget> => {
    const key = originKey(url);
    const hit = targets.get(key);
    if (hit && Date.now() < hit.until) return hit.target;
    const target = await checkTarget(url, opts);
    targets.delete(key);
    if (targets.size >= 16) targets.delete(targets.keys().next().value!);
    targets.set(key, { target, until: Date.now() + TARGET_TTL_MS });
    return target;
  };

  const agentFor = (url: URL, target: ResolvedTarget): Dispatcher => {
    // A private allow's host is on this machine or its network: never sent to a proxy.
    const proxy = opts.allow && originKey(url) === opts.allow.origin ? null : proxyFor(url, env);
    const key = `${originKey(url)}|${target.address}|${proxy ?? ""}`;
    let agent = agents.get(key);
    if (!agent) {
      const lookup: LookupFunction = (_hostname, options, cb) => {
        if (options.all) cb(null, [{ address: target.address, family: target.family }]);
        else cb(null, target.address, target.family);
      };
      const dial = opts.dial;
      if (proxy) {
        // The tunnel is opened to the checked address, never the hostname: the proxy can't resolve it elsewhere.
        // TLS still names the hostname. (Tests: `dial(...).plain` skips TLS inside the tunnel.)
        const authority = target.family === 6 ? `[${target.address}]` : target.address;
        agent = new ProxyAgent({
          uri: proxy,
          keepAliveTimeout: 30_000,
          factory: (origin, o: Pool.Options) =>
            new Pool(origin, {
              ...o,
              connect: (c, cb) => {
                const plain = dial?.(target, url).plain;
                const port = c.port || "443";
                const servername = c.servername || (isIP(urlHost(url)) ? undefined : urlHost(url));
                (o.connect as buildConnector.connector)({ ...c, host: `${authority}:${port}`, port, servername, ...(plain ? { protocol: "http:" } : {}) }, cb);
              },
            }),
        });
      } else if (dial) {
        const connector = buildConnector({});
        agent = new Agent({
          connect: (o, cb) => {
            const d = dial(target, url);
            connector({ ...o, ...(d.plain ? { protocol: "http:" } : {}), hostname: d.address, port: String(d.port) }, cb);
          },
          keepAliveTimeout: 30_000,
        });
      } else agent = new Agent({ connect: { lookup }, keepAliveTimeout: 30_000 });
      if (agents.size >= 16) {
        const [oldKey, old] = agents.entries().next().value as [string, Dispatcher];
        agents.delete(oldKey);
        void old.close().catch(() => {});
      }
      agents.set(key, agent);
    }
    return agent;
  };

  /** One hop: checked, pinned, and retried while its connection can't be opened. */
  const send = async (url: URL, init: RequestInit, retry: boolean) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const target = await resolve(url);
        // undici's own fetch and Agent (the global fetch may come from another undici version).
        return await undiciFetch(url, { ...(init as object), redirect: "manual", dispatcher: agentFor(url, target) });
      } catch (err) {
        // A DNS failure (SourceError "unavailable" from the guard) or a connection that never opened.
        const transient = err instanceof SourceError ? err.code === "unavailable" : notConnected(err);
        if (!retry || !transient || attempt >= CONNECT_RETRY_MS.length || init.signal?.aborted) throw err;
        targets.delete(originKey(url)); // the host may have moved
        await sleep(CONNECT_RETRY_MS[attempt]!, undefined, { signal: init.signal ?? undefined });
      }
    }
  };

  const run = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    let url = new URL(String(input));
    const startOrigin = originKey(url);
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body ?? null;
    const headers = new Headers(init.headers);
    for (let hop = 0; ; hop++) {
      if (url.username || url.password) throw new SourceError("blocked_target", "Upstream URLs can't carry credentials");
      const res = await send(url, { method, headers, body, signal: init.signal }, replayable(body));
      // A caller that handles redirects itself (the SDK's same-origin policy) gets the 3xx; its next hop is checked again.
      if (REDIRECT.has(res.status) && res.headers.get("location") && init.redirect !== "manual") {
        await res.body?.cancel().catch(() => {});
        if (init.redirect === "error") throw new SourceError("protocol", "Upstream redirected");
        if (hop >= MAX_REDIRECTS) throw new SourceError("protocol", `Upstream redirected more than ${MAX_REDIRECTS} times`);
        const next = new URL(res.headers.get("location")!, url);
        if (originKey(next) !== startOrigin) {
          // Never carry credentials to another origin: a static header can have any name, so only plain
          // protocol headers survive the hop.
          for (const name of [...headers.keys()]) if (!SAFE_CROSS_ORIGIN.has(name) && !name.startsWith("mcp-")) headers.delete(name);
        }
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = null;
          headers.delete("content-type");
          headers.delete("content-length");
        } else if (!replayable(body)) {
          throw new SourceError("protocol", "Upstream redirected a streamed request");
        }
        url = next;
        continue;
      }
      const length = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(length) && length > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new SourceError("protocol", `Upstream response is ${length} bytes, over the ${maxBytes}-byte limit`);
      }
      const out = new Response(NULL_BODY.has(res.status) || !res.body ? null : capped(res.body as ReadableStream<Uint8Array>, maxBytes), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers as unknown as Headers,
      });
      Object.defineProperty(out, "url", { value: url.toString() });
      return out;
    }
  };

  return Object.assign(run, {
    async close() {
      const all = [...agents.values()];
      agents.clear();
      targets.clear();
      await Promise.all(all.map((a) => a.close().catch(() => {})));
    },
  });
}
