// What a public URL means for the two things that depend on it: Google sign-in (the OAuth redirect)
// and agents (the transport rule in src/lib/cli.ts, the same one the CLI enforces).

import { type Transport, transportOf } from "./cli.ts";

export type HostKind = "loopback" | "tailscale" | "ip" | "private-name" | "public-name";

function ipv4(host: string) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m ? m.slice(1).map(Number) : null;
}

// Names Google won't accept in a redirect URI: they don't end in a public top-level domain.
const PRIVATE_SUFFIXES = [".lan", ".local", ".home", ".internal", ".home.arpa", ".localdomain", ".corp", ".intranet", ".private", ".test", ".example", ".invalid", ".localhost"];

// Exactly the server's callback rule (server/google/client.ts LOOPBACK): only these get a direct
// http redirect; other loopback names (foo.localhost, 127.0.0.2) use paste mode there.
const GOOGLE_LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

/** This machine, decided from the hostname alone (https://localhost is loopback too). */
const isLoopbackName = (host: string) => host === "localhost" || host.endsWith(".localhost") || host === "::1" || ipv4(host)?.[0] === 127;

export function hostKind(url: URL): HostKind {
  const host = bareHost(url);
  if (isLoopbackName(host)) return "loopback";
  const v4 = ipv4(host);
  if ((v4 && v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127) || /^fd7a:115c:a1e0:/.test(host)) return "tailscale";
  if (ipv4(host) || host.includes(":")) return "ip";
  if (!host.includes(".") || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return "private-name";
  return "public-name";
}

export interface UrlAnalysis {
  url: URL;
  transport: Transport;
  host: HostKind;
  /**
   * Google sign-in: "direct" redirects back here; "paste" means Google can't redirect to plain http,
   * so the user pastes the address they land on; "rejected" is https Google won't accept (raw IP or a
   * private name).
   */
  google: "direct" | "paste" | "rejected";
}

export function analyzeUrl(raw: string): UrlAnalysis | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const transport = transportOf(url.href);
  const host = hostKind(url);
  const exactLoopback = GOOGLE_LOOPBACK.has(bareHost(url));
  // http: the server redirects directly only to the exact loopback names; https: always direct, but
  // Google refuses raw IPs and private names (other than those loopback names) as redirect URIs.
  const google =
    url.protocol === "http:"
      ? exactLoopback
        ? "direct"
        : "paste"
      : exactLoopback || host === "public-name"
        ? "direct"
        : "rejected";
  return { url, transport, host, google };
}

export type Tone = "good" | "warn" | "bad" | "info";

/** What this address means for Google sign-in and for agents, in the same terms the CLI uses. */
export function urlVerdict(a: UrlAnalysis, browserRemote: boolean): { google: [Tone, string]; agents: [Tone, string] } {
  const google: [Tone, string] =
    a.host === "loopback" && browserRemote
      ? ["bad", "Won't work from this browser: Google would send you back to localhost on the computer you're browsing from, not to the server."]
      : a.google === "direct"
        ? ["good", "Works directly: Google sends you straight back here."]
        : a.google === "paste"
          ? ["warn", "One extra step: Google only returns to https or localhost addresses, so after signing in you copy the address you land on and paste it here."]
          : ["bad", "Won't work: Google refuses https addresses on a raw IP or a private name (like .lan or .local). Use a real domain, a *.ts.net name or localhost through an SSH tunnel."];
  const agents: [Tone, string] =
    a.transport === "loopback"
      ? ["info", "Only agents on the same machine as xaq can reach it."]
      : a.transport === "tailscale"
        ? ["good", "Agents on your tailnet can connect (Tailscale encrypts the traffic)."]
        : a.transport === "https"
          ? ["good", "Agents anywhere that can reach this address can connect."]
          : ["warn", "Agents on other machines refuse plain http unless you add --insecure, because their key would cross the network unencrypted. Prefer an SSH tunnel, Tailscale or https."];
  return { google, agents };
}

/** Short label for an address chip ("This machine", "Your network", …). */
export function addressLabel(raw: string, browserOrigin: string): string {
  const a = analyzeUrl(raw);
  if (!a) return "Address";
  if (raw === browserOrigin && a.host !== "loopback") return "Address in your browser";
  switch (a.host) {
    case "loopback":
      return raw === browserOrigin ? "This computer (your browser's address)" : "This computer only";
    case "tailscale":
      return "Tailscale";
    case "ip": {
      const v4 = ipv4(a.url.hostname);
      const priv = v4 && (v4[0] === 10 || (v4[0] === 172 && v4[1]! >= 16 && v4[1]! <= 31) || (v4[0] === 192 && v4[1] === 168) || (v4[0] === 169 && v4[1] === 254));
      return priv ? "Your local network" : "Public IP";
    }
    default:
      return "Network name";
  }
}

export const isLoopbackOrigin = (origin: string) => analyzeUrl(origin)?.host === "loopback";

/**
 * The "this computer" address step 1 recommends: the browser's own origin when it is already a loopback
 * address the server calls back to directly (localhost, 127.0.0.1, [::1]) on the server's own port, so
 * the session cookie and the links the CLI prints (built from this address) stay on the same host.
 * Otherwise localhost on the server's port (another port is an SSH tunnel's or a proxy's, not the server's).
 */
export function localConsoleUrl(browserOrigin: string, port: string): { url: string; fromBrowser: boolean } {
  const a = analyzeUrl(browserOrigin);
  return a && a.host === "loopback" && a.google === "direct" && a.url.port === port ? { url: a.url.origin, fromBrowser: true } : { url: `http://localhost:${port}`, fromBrowser: false };
}

/** The port this console is served on (for tunnel and Tailscale commands). */
export function consolePort(addresses: string[], publicUrl: string): string {
  // The server's own addresses first: the browser may reach it through a tunnel or proxy on another port.
  // (globalThis: this module is also unit-tested under Node, which has no window.)
  const origin = (globalThis as { location?: { origin: string } }).location?.origin ?? "";
  for (const u of [...addresses, origin, publicUrl]) {
    try {
      const p = new URL(u).port;
      if (p) return p;
    } catch {
      /* skip */
    }
  }
  return "8425";
}



/**
 * The saved public URL's origin when the browser reached this same server under another loopback name
 * (http://localhost:8425 vs http://127.0.0.1:8425): both work, but Google sign-in returns to the saved one.
 * null when they match, or when they aren't the same computer and port.
 */
export function loopbackTwin(browserOrigin: string, publicUrl: string): string | null {
  const b = analyzeUrl(browserOrigin);
  const p = analyzeUrl(publicUrl);
  // Only where Google returns straight to the saved address (localhost, 127.0.0.1, [::1] on http/https).
  if (!b || !p || b.host !== "loopback" || p.host !== "loopback" || p.google !== "direct") return null;
  if (b.url.origin === p.url.origin || b.url.protocol !== p.url.protocol || b.url.port !== p.url.port) return null;
  return p.url.origin;
}
