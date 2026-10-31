// Console decisions for broker connections (docs/MCP-BROKER.md) as pure functions, so they can be tested directly:
// a connection's status in plain words, the Add connection draft and the request sequence it turns into, what a
// probe found and access levels. Built on the /api/connections DTOs in shared/types.ts.
// No React and relative imports only: vitest and the server typecheck load this module too.

import type {
  AccessLevel,
  ConnectionGrant,
  ConnectionProbe,
  ConnectionView,
  CreateConnectionInput,
  GoogleApiCheckView,
  PresetView,
  SetupStepView,
  StartConnectInput,
} from "../../../shared/types.ts";
import { presetServerSlug, withServerPath } from "../../../shared/user-server.ts";
import type { AgentConnection, AgentLevel } from "../../lib/broker-dto.ts";

/** A subset of the console's Tone (src/lib/labels.ts). */
type Tone = "good" | "warn" | "bad" | "idle";

const DAY = 86_400_000;

// ───────────── Access levels ─────────────

export const ACCESS_LEVELS = ["full", "ask", "read"] as const satisfies readonly AccessLevel[];
export const DEFAULT_LEVEL: AccessLevel = "ask";

export const LEVEL_INFO: Record<AgentLevel, { label: string; description: string }> = {
  full: { label: "Full access", description: "Agents use every tool without asking you." },
  ask: {
    label: "Ask before risky actions",
    description: "Reading, creating and editing go straight through. Deleting, sending, sharing outside and payments wait for your approval.",
  },
  read: { label: "Read only", description: "Agents can only look things up. Tools that change anything are hidden." },
  none: { label: "No access", description: "This agent doesn't see this connection's tools." },
};

export const AGENT_LEVELS = ["full", "ask", "read", "none"] as const satisfies readonly AgentLevel[];

// ───────────── Status ─────────────

/** Whole days until `iso` (rounded up), negative once past. */
export function daysLeft(iso: string, now: number): number {
  return Math.ceil((Date.parse(iso) - now) / DAY);
}

export interface ConnectionStatusView {
  label: string;
  tone: Tone;
  /** One sentence; names the fix when there is one. */
  description: string;
  /** The button that fixes it. A disabled connection (the kill switch) comes back with a reconnect too. */
  action: "reconnect" | null;
}

/** A connection's badge: active / needs reconnect / expiring in N days / disabled. Warns from 7 days before expiresAt. */
export function connectionStatusView(
  c: Pick<ConnectionView, "status" | "statusReason" | "expiresAt" | "name"> & Partial<Pick<ConnectionView, "authType" | "toolsCachedAt" | "tools" | "expired">>,
  now: number,
): ConnectionStatusView {
  // Never got as far as listing tools: an OAuth sign-in that was abandoned (or a credential that never worked).
  const neverListed = c.toolsCachedAt === null && (c.tools?.total ?? 0) === 0;
  if (neverListed && (c.status === "needs_reauth" || (c.status === "active" && c.authType === "oauth"))) {
    return { label: "Not signed in", tone: "warn", description: `The sign-in to ${c.name} wasn't finished. Agents can't use it until you sign in.`, action: "reconnect" };
  }
  switch (c.status) {
    case "disabled":
      return {
        label: "Disabled",
        tone: "idle",
        description: `${c.statusReason ? `${cap(c.statusReason)}. ` : ""}Agents don't see its tools. Reconnect to use it again.`,
        action: "reconnect",
      };
    case "needs_reauth":
      // Past the credential's lifetime (T3 Code: 30 days, no refresh): only a fresh sign-in helps.
      if (c.expired || (c.expiresAt && daysLeft(c.expiresAt, now) <= 0)) {
        return {
          label: "Expired",
          tone: "bad",
          description: `Its sign-in expired${c.expiresAt ? ` on ${c.expiresAt.slice(0, 10)}` : ""}. Agents are told to ask you to reconnect ${c.name}. Reconnect keeps its name, agents and access.`,
          action: "reconnect",
        };
      }
      return {
        label: "Needs reconnect",
        tone: "bad",
        description: `${c.statusReason ?? "Its sign-in stopped working."} Agents' calls to ${c.name} fail until you reconnect.`,
        action: "reconnect",
      };
    case "error":
      return { label: "Error", tone: "bad", description: `${c.statusReason ?? "The server isn't answering."} Reconnecting often fixes it.`, action: "reconnect" };
    case "active": {
      if (!c.expiresAt) return { label: "Active", tone: "good", description: "Working.", action: null };
      const days = daysLeft(c.expiresAt, now);
      if (days <= 0) return { label: "Expired", tone: "bad", description: `Its sign-in has expired. Reconnect ${c.name} to keep it working.`, action: "reconnect" };
      if (days <= 7) {
        return {
          label: `Expires in ${days} day${days === 1 ? "" : "s"}`,
          tone: days <= 1 ? "bad" : "warn",
          description: `Its sign-in stops working ${days === 1 ? "tomorrow" : `in ${days} days`}. Reconnect now so agents aren't interrupted.`,
          action: "reconnect",
        };
      }
      // Whole days left (as the server's expiresInDays): a fresh 30-day sign-in reads 29, never 31 on a stale clock.
      const whole = Math.max(0, Math.floor((Date.parse(c.expiresAt) - now) / DAY));
      return { label: "Active", tone: "good", description: `Working. Needs a reconnect in ${whole} days.`, action: null };
    }
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What the server granted with the current sign-in, and a warning when that includes scopes the connection's extension
 * calls broad (its manifest's `remote.auth.broadScopes`: T3 Code's Full access). null when nothing is recorded (not
 * OAuth, or not signed in).
 */
export function grantedScopesView(c: Pick<ConnectionView, "grantedScopes" | "broadScopes" | "scopeNotes" | "name">): { scopes: string[]; note: string | null } | null {
  if (!c.grantedScopes) return null;
  const scopes = c.grantedScopes;
  // The extension's own words first (T3: what its Full access, Supervised and Read only levels mean).
  const noted = c.scopeNotes?.find((n) => scopes.includes(n.scope));
  if (noted) return { scopes, note: noted.note };
  const broad = scopes.filter((s) => c.broadScopes?.includes(s));
  if (!broad.length) return { scopes, note: null };
  return {
    scopes,
    note: `Broad access: this sign-in granted ${broad.join(", ")} on ${c.name}. If agents don't need that, reconnect and pick a lower level.`,
  };
}

// ───────────── Google extensions (google-workspace) ─────────────

/**
 * A Google extension's connection in plain words: the account it works as, and what it can't do because Google
 * wasn't asked or a box was unticked. null for any other connection.
 */
export function googleAccessView(c: Pick<ConnectionView, "google" | "name">): { account: string; note: string | null } | null {
  const g = c.google;
  if (!g) return null;
  if (!g.email) return { account: "No Google account picked", note: `Reconnect ${c.name} to pick one.` };
  if (!g.granted.length) return { account: g.email, note: `${c.name} has no access to ${g.email} yet. Reconnect and allow it on Google's screen.` };
  if (!g.missing.length) return { account: g.email, note: null };
  const without = g.missing.map((m) => m.without ?? `no ${m.grants}`).join("; ");
  return { account: g.email, note: `Not granted on Google's screen: ${g.missing.map((m) => m.grants).join("; ")}. So ${without}. Reconnect and tick every box to fix it.` };
}

/** "Check again" in one line: which APIs are still off, or that all are on (or what xaq couldn't tell yet). */
export function apiCheckSummary(checks: readonly GoogleApiCheckView[]): { tone: Tone; text: string } {
  const off = checks.filter((c) => c.state === "disabled");
  if (off.length) return { tone: "bad", text: `Still off: ${off.map((c) => c.label).join(", ")}. Turn ${off.length === 1 ? "it" : "them"} on, wait a minute, then check again.` };
  const errors = checks.filter((c) => c.state === "error");
  if (errors.length) return { tone: "warn", text: `Couldn't check ${errors.map((c) => c.label).join(", ")}: ${errors[0]!.message ?? "Google didn't answer"}` };
  const unchecked = checks.filter((c) => c.state === "unchecked");
  if (unchecked.length) return { tone: "idle", text: unchecked[0]!.message ?? "xaq can check these once you've allowed access." };
  return { tone: "good", text: "Every API is on." };
}

// ───────────── Agent access (adapter over per-connection grants) ─────────────

/** One agent's level on every connection, from the connections and each connection's grants. */
export function agentConnections(agentId: string, connections: readonly ConnectionView[], grants: Record<string, readonly ConnectionGrant[]>): AgentConnection[] {
  return connections.map((c) => ({
    connectionId: c.id,
    slug: c.slug,
    name: c.name,
    status: c.status,
    level: grants[c.id]?.find((g) => g.agentId === agentId)?.level ?? "none",
  }));
}

/** The PUT /api/connections/:id/grants body that sets one agent's level and keeps everyone else's. */
export function grantsWith(grants: readonly ConnectionGrant[], agentId: string, level: AgentLevel): { grants: { agentId: string; level: AccessLevel }[] } {
  const others = grants.filter((g) => g.agentId !== agentId).map((g) => ({ agentId: g.agentId, level: g.level }));
  return { grants: level === "none" ? others : [...others, { agentId, level }] };
}

// ───────────── Upstream sign-in ─────────────

/**
 * The connection callback page's message (server/api/oauth.ts CONNECTION_CALLBACK_SCRIPT), for the connection being
 * signed in only. It says which connection; whether it worked is read back from the connection (refetch).
 */
export function oauthMessageFor(data: unknown, connectionId: string | null): { ok: boolean; error: string | null } | null {
  if (!data || typeof data !== "object") return null;
  const m = data as { type?: unknown; ok?: unknown; connectionId?: unknown; error?: unknown };
  if (m.type !== "agentinbox:connection-oauth") return null;
  if (!connectionId || m.connectionId !== connectionId) return null;
  return { ok: m.ok !== false, error: typeof m.error === "string" ? m.error : null };
}

/** Checks a pasted landing address (paste mode) before POST /api/connections/finish; a problem in plain words, or null. */
export function pastedProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "That isn't a full address. Copy everything in the address bar, starting with http.";
  }
  const err = url.searchParams.get("error");
  if (err) return err === "access_denied" ? "This address says the sign-in was cancelled. Start again and approve it." : `The sign-in returned an error: ${err}`;
  if (!url.searchParams.get("code")) return "This address has no authorization code. Copy it after approving the sign-in.";
  return null;
}

// ───────────── Add connection ─────────────

const SLUG_RE = /^[a-z0-9-]{1,24}$/;
const GENERIC_LABELS = new Set(["www", "mcp", "api", "app", "server", "com", "net", "org", "io", "dev", "sh", "ai", "co"]);

/** A slug from a URL's host: mcp.notion.com → notion, 127.0.0.1:3773 → local-3773. */
export function suggestSlug(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":") || host === "localhost") return `local${u.port ? `-${u.port}` : ""}`;
  // Without the TLD, the first label that names something: mcp.notion.com → notion, whoop.weish.me → whoop.
  const all = host.split(".").filter(Boolean);
  const labels = (all.length > 1 ? all.slice(0, -1) : all).filter((l) => !GENERIC_LABELS.has(l));
  const base = (labels[0] ?? all[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.slice(0, 24);
}

/** The MCP URL for a preset whose server the user names (T3 Code): as typed, with the preset's path (shared/user-server.ts). */
export function presetServerUrl(raw: string, defaultPath: string): string {
  const text = raw.trim();
  try {
    return withServerPath(new URL(text), defaultPath);
  } catch {
    return text;
  }
}

/** The name a connection gets when none is typed: the preset's, or the server's `host[:port]` (as the server does). */
export function defaultName(d: Pick<ConnectionDraft, "preset" | "url">): string {
  if (d.preset && !d.preset.userServer) return d.preset.displayName;
  try {
    return new URL(draftUrl(d)).host;
  } catch {
    return d.preset?.displayName ?? "";
  }
}

/** The slug suggested once the address is checked: `<preset>-<host>` for a user-named server, else from the host. */
export function suggestDraftSlug(d: Pick<ConnectionDraft, "preset" | "url">, taken: readonly string[] = []): string {
  const url = draftUrl(d);
  const base = d.preset?.userServer ? presetServerSlug(d.preset.slug, url) : suggestSlug(url);
  if (!base || !taken.includes(base)) return base;
  // Free like the server's freeSlug: a second server on the same IP or first DNS label gets -2, -3…
  const root = base.slice(0, 20).replace(/-+$/, "");
  for (let n = 2; ; n++) if (!taken.includes(`${root}-${n}`)) return `${root}-${n}`;
}

/**
 * The connection this draft would duplicate, offered as "Reconnect it instead": for a user-named server (T3 Code) the
 * one of that preset at the same `scheme://host:port`, for other presets the one with that preset and slug. Never the
 * connection this dialog created itself (for the private-network allow).
 */
export function duplicateOf<C extends Pick<ConnectionView, "id" | "preset" | "slug" | "url">>(
  d: Pick<ConnectionDraft, "preset" | "url" | "slug" | "createdId">,
  connections: readonly C[],
): C | null {
  const p = d.preset;
  if (!p) return null;
  const others = connections.filter((c) => c.preset === p.id && c.id !== d.createdId);
  if (p.userServer) {
    const origin = d.url.trim() ? exactOrigin(draftUrl(d)) : null;
    return origin ? (others.find((c) => c.url && exactOrigin(c.url) === origin) ?? null) : null;
  }
  return others.find((c) => c.slug === d.slug) ?? null;
}

/** The draft's MCP URL: a preset's fixed one, a user-named server's (path added), or the custom URL as typed. */
export function draftUrl(d: Pick<ConnectionDraft, "preset" | "url">): string {
  if (d.preset?.userServer) return presetServerUrl(d.url, d.preset.userServer.defaultPath);
  return d.preset?.url ?? d.url.trim();
}

/** A slug from the name the user typed: "Notes server" → "notes-server". */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 24)
    .replace(/-+$/, "");
}

/** The draft change for a typed name: a custom connection's slug follows it until the slug is edited by hand. */
export function nameChange(d: Pick<ConnectionDraft, "preset" | "slugEdited" | "slug">, name: string): Partial<ConnectionDraft> {
  if (d.preset || d.slugEdited) return { name };
  return { name, slug: slugFromName(name) || d.slug };
}

/** Why a slug can't be used, or null. Native-name collisions are checked by the server. */
export function slugProblem(slug: string, taken: readonly string[]): string | null {
  if (!slug) return "Give it a short name.";
  if (!SLUG_RE.test(slug)) return "Use up to 24 lowercase letters, digits and dashes.";
  if (taken.includes(slug)) return `You already have a connection named ${slug}.`;
  return null;
}

/** Setup inputs still missing or not matching their pattern, by key. */
export function inputProblems(steps: readonly SetupStepView[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of steps) {
    if (!s.input) continue;
    const v = (values[s.input.key] ?? "").trim();
    if (s.input.choices) {
      // A choice (a Google extension's account): one of the offered values that can be picked.
      if (!v) out[s.input.key] = s.input.choices.length ? `Pick the ${s.input.label.toLowerCase()}.` : `Add a ${s.input.label.toLowerCase()} to xaq first.`;
      else if (!s.input.choices.some((c) => c.value === v && !c.disabled)) out[s.input.key] = `Pick one of the offered ${s.input.label.toLowerCase()}s.`;
    } else if (!v) out[s.input.key] = `Paste the ${s.input.label.toLowerCase()}.`;
    else if (s.input.pattern) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(`^(?:${s.input.pattern})$`);
      } catch {
        re = null;
      }
      if (re && !re.test(v)) out[s.input.key] = `That doesn't look like a ${s.input.label.toLowerCase()}.`;
    }
  }
  return out;
}

/** How the connection signs in, as the dialog's control once the source is known. */
export type AuthControl = { kind: "oauth"; issuer: string | null; manual: boolean } | { kind: "header" } | { kind: "none" } | { kind: "private" } | { kind: "unknown" };

export function authControl(source: { preset: PresetView } | { probe: ConnectionProbe }): AuthControl {
  if ("preset" in source) {
    const t = source.preset.authType;
    // A preset's own setup steps (WHOOP's app id and secret) are inputs; the OAuth sign-in follows them.
    return t === "oauth" ? { kind: "oauth", issuer: null, manual: false } : t === "header" ? { kind: "header" } : { kind: "none" };
  }
  const p = source.probe;
  if (p.blocked === "private_target") return { kind: "private" };
  if (p.auth === "oauth") return { kind: "oauth", issuer: p.issuer ?? null, manual: p.registration === "manual" };
  if (p.auth === "header") return { kind: "header" };
  if (p.auth === "none") return { kind: "none" };
  return { kind: "unknown" };
}

/** `scheme://host:port` the private-target allow covers (default ports spelled out, as the server pins it). */
export function exactOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }
}

/** `host:port` of a URL. */
export function hostPort(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return url;
  }
}

/** The private-network explanation shown with "Allow host:port". */
export function privateExplanation(url: string): string {
  return (
    `Allowing ${hostPort(url)} lets xaq connect to a server on this computer or your private network (like Tailscale). ` +
    "Only this connection gets it, only at this exact address, and only you can turn it on. " +
    "A server there can reach other services on that machine or network, so allow only servers you run or trust."
  );
}

/** One or two sentences about what the probe found (the server's words, with ours for the common cases). */
export function probeSummary(p: ConnectionProbe): string {
  if (p.blocked === "private_target") return "This server is on this computer or your private network. xaq blocks those addresses unless you allow one.";
  if (p.blocked === "ssrf") return p.message || "xaq can't connect to this address.";
  if (!p.reachable) return p.message || "xaq couldn't reach this server.";
  if (p.auth === "oauth") {
    const host = p.issuer ? hostPort(p.issuer).replace(/:443$/, "") : "its own sign-in";
    return p.registration === "manual"
      ? `Signs in with ${host}, which doesn't register apps automatically. ${p.message}`.trim()
      : `Signs in with ${host}. xaq registers itself automatically, so there's nothing to set up there.`;
  }
  if (p.auth === "header") return "Needs an API key or token. xaq keeps it encrypted and sends it with every request; agents never see it.";
  if (p.auth === "none") return "An MCP server that needs no sign-in.";
  return p.message;
}

export interface ConnectionDraft {
  preset: PresetView | null;
  url: string;
  probe: ConnectionProbe | null;
  /** Created early when the private-target allow is needed (the allow belongs to a connection). */
  createdId: string | null;
  privateAllowed: boolean;
  /** The user typed a slug: the name no longer drives it. */
  slugEdited: boolean;
  slug: string;
  name: string;
  level: AccessLevel;
  /** "all" by default. */
  agents: "all" | string[];
  headerName: string;
  headerValue: string;
  inputs: Record<string, string>;
}

export const emptyDraft = (preset: PresetView | null = null): ConnectionDraft => ({
  preset,
  url: preset?.url ?? "",
  probe: null,
  createdId: null,
  privateAllowed: false,
  slugEdited: false,
  // A user-named server (T3 Code): slug and name come from its address once it's checked.
  slug: preset?.userServer ? "" : (preset?.slug ?? ""),
  name: preset?.userServer ? "" : (preset?.displayName ?? ""),
  level: DEFAULT_LEVEL,
  agents: "all",
  headerName: "Authorization",
  headerValue: "",
  inputs: {},
});

/** A preset's own control, except a user-named server's (T3 Code), which is probed like a custom URL first. */
export const draftControl = (d: ConnectionDraft): AuthControl | null =>
  d.preset && !d.preset.userServer ? authControl({ preset: d.preset }) : d.probe ? authControl({ probe: d.probe }) : null;

/** The address must be checked (and maybe allowed) before Connect: a custom URL, or a user-named server (T3 Code). */
export const needsProbe = (d: Pick<ConnectionDraft, "preset">): boolean => !d.preset || !!d.preset.userServer;

/** What still blocks "Connect", in the order the dialog shows the fields; empty when ready. */
export function draftProblems(d: ConnectionDraft, taken: readonly string[]): string[] {
  const out: string[] = [];
  if (needsProbe(d) && !d.probe) out.push("Check the address first.");
  const control = draftControl(d);
  if (control?.kind === "private") out.push("Allow the private-network address, or use another one.");
  if (needsProbe(d) && d.probe && !d.probe.reachable && !d.probe.blocked) out.push("xaq couldn't reach this server.");
  // A user-named server must ask for what its extension says it does (T3 Code: a sign-in; Brightspace: a key).
  if (d.preset?.userServer && d.probe?.reachable && d.probe.auth !== d.preset.authType && d.preset.authType !== "none") {
    out.push(`This doesn't look like a ${d.preset.displayName} server: it doesn't ask for ${d.preset.authType === "oauth" ? "a sign-in" : "an API key or token"}.`);
  }
  if (d.probe?.blocked === "ssrf") out.push("xaq can't connect to this address.");
  // Created early for the allow: its own slug isn't a clash.
  const slug = slugProblem(d.slug, d.createdId ? taken.filter((s) => s !== d.slug) : taken);
  if (slug) out.push(slug);
  if (control?.kind === "header" && (!d.headerValue.trim() || !/^[A-Za-z0-9-]{1,100}$/.test(d.headerName.trim()))) out.push("Paste the API key or token.");
  if (d.preset) out.push(...Object.values(inputProblems(d.preset.setupSteps, d.inputs)));
  if (Array.isArray(d.agents) && d.agents.length === 0) out.push("Pick at least one agent, or all of them.");
  return out;
}

/** POST /api/connections for the draft. "All agents" omits agentIds: the server grants every agent, and agents added later. */
export function createInput(d: ConnectionDraft): CreateConnectionInput {
  const body: CreateConnectionInput = { slug: d.slug, levelDefault: d.level };
  if (d.preset) body.preset = d.preset.id;
  if (needsProbe(d)) body.url = draftUrl(d);
  if (d.name.trim() && (d.preset?.userServer || d.name.trim() !== d.preset?.displayName)) body.name = d.name.trim();
  if (Array.isArray(d.agents)) body.agentIds = d.agents;
  return body;
}

/** POST /api/connections/:id/connect for the draft: the header (bearer prefixed when it's Authorization) and setup inputs. */
export function connectInput(d: ConnectionDraft): StartConnectInput {
  const body: StartConnectInput = {};
  if (draftControl(d)?.kind === "header") {
    const name = d.headerName.trim() || "Authorization";
    const v = d.headerValue.trim();
    body.header = { name, value: name.toLowerCase() === "authorization" && !/^\w+\s/.test(v) ? `Bearer ${v}` : v };
  }
  if (d.preset && Object.keys(d.inputs).length) body.inputs = Object.fromEntries(Object.entries(d.inputs).map(([k, v]) => [k, v.trim()]));
  return body;
}

/**
 * The connection created early (for the private-target allow) gets the rest of the draft before connecting:
 * the PATCH (name, slug, level) and the grants PUT, or null when nothing changed.
 */
export function finishEarlyCreate(
  d: ConnectionDraft,
  created: Pick<ConnectionView, "name" | "slug" | "levelDefault">,
  allAgents: readonly string[],
): { patch: { name?: string; slug?: string; levelDefault?: AccessLevel; allAgents?: boolean } | null; grants: { grants: { agentId: string; level: AccessLevel }[] } } {
  const patch: { name?: string; slug?: string; levelDefault?: AccessLevel; allAgents?: boolean } = {};
  if (d.name.trim() && d.name.trim() !== created.name) patch.name = d.name.trim();
  if (d.slug !== created.slug) patch.slug = d.slug;
  if (d.level !== created.levelDefault) patch.levelDefault = d.level;
  // Created early without grants: "All agents" also covers agents added later.
  if (d.agents === "all") patch.allAgents = true;
  const ids = d.agents === "all" ? allAgents : d.agents;
  return { patch: Object.keys(patch).length ? patch : null, grants: { grants: ids.map((agentId) => ({ agentId, level: d.level })) } };
}
