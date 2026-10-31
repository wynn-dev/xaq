import { SourceError } from "../types.ts";
import { scrubText } from "../credentials/scrub.ts";
import { originKey, type PrivateTargetAllow } from "./fetch.ts";

/**
 * Strict OAuth discovery for remote MCP servers:
 * protected resource metadata (RFC 9728) then authorization server metadata (RFC 8414, OIDC fallback).
 * A document only counts when it is served as JSON, parses to an object and names exactly the expected
 * issuer/resource. A 200 with HTML (T3's SPA answers /.well-known/openid-configuration) is not metadata.
 */

export interface ResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  [key: string]: unknown;
}

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
  authorization_response_iss_parameter_supported?: boolean;
  [key: string]: unknown;
}

type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;
const MAX_DOC_BYTES = 256 * 1024;

/** Reads a JSON document strictly. Returns null on 404/405 or a non-JSON answer (the caller tries the next URL). */
export async function fetchJsonDoc(fetch: Fetch, url: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, { headers: { accept: "application/json", "mcp-protocol-version": "2025-11-25" }, signal: s });
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!res.ok || !(type === "application/json" || type.endsWith("+json"))) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const text = await res.text();
  if (text.length > MAX_DOC_BYTES) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `resource_metadata` from a 401's `WWW-Authenticate: Bearer …`, plus `scope` and `error`. */
export function parseWwwAuthenticate(header: string | null): { resourceMetadata?: string; scope?: string; error?: string } {
  if (!header || !/^\s*bearer\b/i.test(header)) return {};
  const out: Record<string, string> = {};
  for (const m of header.matchAll(/([a-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi)) {
    out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return { resourceMetadata: out.resource_metadata, scope: out.scope, error: out.error };
}

/** The canonical resource identifier of an MCP URL (RFC 8707): no fragment, no query. */
export function canonicalResource(url: string | URL): string {
  const u = new URL(String(url));
  u.hash = "";
  u.search = "";
  const s = u.toString();
  return u.pathname === "/" ? s.replace(/\/$/, "") : s;
}

/** RFC 9728 well-known URLs for a resource, path-inserted first. */
function resourceMetadataUrls(serverUrl: URL): string[] {
  const path = serverUrl.pathname.replace(/\/$/, "");
  const urls = [];
  if (path) urls.push(new URL(`/.well-known/oauth-protected-resource${path}`, serverUrl).toString());
  urls.push(new URL("/.well-known/oauth-protected-resource", serverUrl).toString());
  return urls;
}

export async function discoverResource(fetch: Fetch, serverUrl: URL, hinted: string | undefined, signal?: AbortSignal): Promise<ResourceMetadata | null> {
  const expected = canonicalResource(serverUrl);
  for (const url of hinted ? [hinted, ...resourceMetadataUrls(serverUrl)] : resourceMetadataUrls(serverUrl)) {
    const doc = await fetchJsonDoc(fetch, url, signal);
    if (!doc || typeof doc.resource !== "string") continue;
    // RFC 9728 §3.3: the resource must be the one we asked about (a prefix match allows a server-wide document).
    const got = canonicalResource(doc.resource);
    if (got !== expected && !expected.startsWith(`${got.replace(/\/$/, "")}/`)) {
      throw new SourceError("protocol", `The server's resource metadata names a different resource (${scrubText(doc.resource, [], 200)})`);
    }
    return doc as ResourceMetadata;
  }
  return null;
}

/** RFC 8414 then OIDC discovery URLs for an issuer, path-inserted forms first. */
function authServerMetadataUrls(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/$/, "");
  if (!path) {
    return [new URL("/.well-known/oauth-authorization-server", issuer).toString(), new URL("/.well-known/openid-configuration", issuer).toString()];
  }
  return [
    new URL(`/.well-known/oauth-authorization-server${path}`, issuer).toString(),
    new URL(`/.well-known/openid-configuration${path}`, issuer).toString(),
    new URL(`${path}/.well-known/openid-configuration`, issuer).toString(),
  ];
}

/**
 * Where the browser may be sent and where we POST: https, or http only on the connection's own allowed
 * private origin. No other scheme (CVE-2025-6514 was a crafted authorization_endpoint).
 */
export function checkEndpoint(raw: unknown, what: string, allow: PrivateTargetAllow | null | undefined): string {
  if (typeof raw !== "string") throw new SourceError("protocol", `The authorization server didn't give a ${what}`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceError("protocol", `The authorization server's ${what} isn't a valid URL`);
  }
  if (u.username || u.password) throw new SourceError("blocked_target", `The authorization server's ${what} carries credentials`);
  if (u.protocol === "https:") return u.toString();
  if (u.protocol === "http:" && allow && originKey(u) === allow.origin) return u.toString();
  throw new SourceError("blocked_target", `The authorization server's ${what} must use https (got ${u.protocol}//${u.host})`);
}

/** Authorization server metadata with an exact issuer check, PKCE S256 required, endpoints validated. */
export async function discoverAuthServer(fetch: Fetch, issuer: string, allow: PrivateTargetAllow | null | undefined, signal?: AbortSignal): Promise<AuthServerMetadata> {
  const iss = new URL(checkEndpoint(issuer, "issuer", allow));
  for (const url of authServerMetadataUrls(iss)) {
    const doc = await fetchJsonDoc(fetch, url, signal);
    if (!doc) continue;
    if (doc.issuer !== issuer) {
      throw new SourceError("protocol", `Authorization server metadata at ${url} names issuer ${scrubText(String(doc.issuer), [], 200)}, expected ${issuer}`);
    }
    const md = doc as AuthServerMetadata;
    if (!md.code_challenge_methods_supported?.includes("S256")) {
      throw new SourceError("protocol", `The authorization server ${issuer} doesn't advertise PKCE S256, which is required`);
    }
    md.authorization_endpoint = checkEndpoint(md.authorization_endpoint, "authorization endpoint", allow);
    md.token_endpoint = checkEndpoint(md.token_endpoint, "token endpoint", allow);
    if (md.registration_endpoint !== undefined) md.registration_endpoint = checkEndpoint(md.registration_endpoint, "registration endpoint", allow);
    if (md.revocation_endpoint !== undefined) md.revocation_endpoint = checkEndpoint(md.revocation_endpoint, "revocation endpoint", allow);
    return md;
  }
  throw new SourceError("protocol", `No valid OAuth metadata for ${issuer} (expected JSON at /.well-known/oauth-authorization-server)`);
}

export interface Discovered {
  resource: string;
  resourceMetadata: ResourceMetadata | null;
  issuer: string;
  metadata: AuthServerMetadata;
}

/**
 * Full discovery for an MCP URL. `hint` is the 401's resource_metadata. Without protected resource
 * metadata, the 2025-03-26 fallback treats the MCP origin as the authorization server.
 */
export async function discover(fetch: Fetch, serverUrl: URL, hint: string | undefined, allow: PrivateTargetAllow | null | undefined, signal?: AbortSignal): Promise<Discovered> {
  if (hint) checkEndpoint(hint, "resource metadata URL", allow);
  const rm = await discoverResource(fetch, serverUrl, hint, signal);
  const issuer = rm?.authorization_servers?.[0] ?? `${serverUrl.protocol}//${serverUrl.host}`;
  const metadata = await discoverAuthServer(fetch, issuer, allow, signal);
  return { resource: rm ? rm.resource : canonicalResource(serverUrl), resourceMetadata: rm, issuer, metadata };
}
