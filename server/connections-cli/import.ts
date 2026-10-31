import pc from "picocolors";
import type { Agent } from "../../shared/types.ts";
import type { AccessLevel } from "../broker/types.ts";
import { mcpTarget, type McpSetupResult, type RemoveServer, setupMcp } from "../listen/mcpsetup.ts";
import { DEFAULT_PROFILE, profilePath } from "../listen/paths.ts";
import { loadProfile, type Profile, profileExists } from "../listen/profile.ts";
import { safeText } from "../listen/ui.ts";
import { NPX } from "../listen/version.ts";
import type { LookupFn } from "../util/ssrf.ts";
import { accessLabel, agentsLabel, chooseAccess, chooseAgents, parseAccess } from "./access.ts";
import { isWorking, waitWorking } from "./manage.ts";
import { confinedRoutes } from "./routes.ts";
import { mcpServerName } from "../listen/recipes.ts";
import type { ConnectionsApi, ConnectionView } from "./api.ts";
import { CLIENT_LABELS, type ClientConfig, type ClientEntry, type ImportClient, parseImportClient, readClientConfig } from "./clients.ts";
import { checkTarget } from "./private.ts";
import type { Prompter } from "./prompt.ts";
import { reconnectHint, slugify } from "./util.ts";

/**
 * `import --from <client>`: one connection per remote MCP server in that client's config, with its static header
 * moved into the broker. OAuth servers are created needing Connect (their tokens stay in the client); stdio ones
 * aren't supported yet (M4) and stay where they are. Nothing is written without a confirmation (or --yes), and
 * the client's config is only touched by the optional setup-mcp step at the end, which removes just the entries
 * whose connection works.
 */

export interface ImportFlags {
  from: string;
  dryRun?: boolean;
  yes?: boolean;
  access?: string;
  agent?: string[];
  profile?: string;
  /** Exact `scheme://host:port` origins allowed without asking (--yes never allows one). */
  allowPrivate?: string[];
}

export interface ImportDeps {
  prompter: Prompter;
  /** Opens the admin channel (not called for --dry-run). */
  openApi: () => ConnectionsApi;
  lookup?: LookupFn;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** This xaq's own MCP origins (loopback with its port), so its entry is never imported. */
  selfOrigins?: string[];
  /** How long to wait for a connected server's first tool sync (default 10 s), and how often to look. */
  verifyMs?: number;
  pollMs?: number;
}

export type PlanItem =
  | { action: "self"; entry: ClientEntry }
  | { action: "stdio"; entry: ClientEntry }
  | { action: "skip"; entry: ClientEntry; reason: string }
  | { action: "exists"; entry: ClientEntry; connection: ConnectionView }
  | {
      action: "create";
      entry: ClientEntry;
      slug: string;
      /** The connection's name: the entry's, with " (2)", " (3)"… when an existing connection or an earlier item has it. */
      name: string;
      url: string;
      /** header: moved into the broker; oauth: the client says so; none: no credential (the connect finds out). */
      auth: { type: "header"; name: string; value: string } | { type: "oauth" } | { type: "none" };
      /** The exact origin a private-target allow would cover, when the URL is on this machine or a private network. */
      privateTarget: string | null;
    };

// Our own entry under its name, or under the one a profile from before the rename registered: never imported.
const SELF_NAME = /^(?:xaq|agentinbox)(?:-[a-z0-9][a-z0-9_-]*)?$/; // rename-xaq: keep

function isSelf(e: ClientEntry, selfOrigins: string[]): boolean {
  if (SELF_NAME.test(e.name)) return true;
  if (Object.values(e.headers).some((v) => /^Bearer\s+aib_/i.test(v.trim()))) return true;
  if (!e.url) return false;
  try {
    const u = new URL(e.url);
    return u.pathname.replace(/\/+$/, "").endsWith("/mcp") && selfOrigins.includes(u.origin);
  } catch {
    return false;
  }
}

const sameUrl = (a: string | null | undefined, b: string) => {
  try {
    return !!a && new URL(a).href.replace(/\/+$/, "") === new URL(b).href.replace(/\/+$/, "");
  } catch {
    return false;
  }
};

export async function planImport(config: ClientConfig, ctx: { existing?: ConnectionView[]; lookup?: LookupFn; selfOrigins?: string[] } = {}): Promise<PlanItem[]> {
  const label = CLIENT_LABELS[config.client];
  const taken = new Set((ctx.existing ?? []).map((c) => c.slug));
  // Connection names are unique per owner (case-insensitive), like slugs: de-dupe before anything is created.
  const takenNames = new Set((ctx.existing ?? []).map((c) => c.name.toLowerCase()));
  const items: PlanItem[] = [];
  for (const entry of config.entries) {
    if (isSelf(entry, ctx.selfOrigins ?? [])) {
      items.push({ action: "self", entry });
      continue;
    }
    if (entry.transport === "stdio") {
      items.push({ action: "stdio", entry });
      continue;
    }
    if (entry.problem) {
      items.push({ action: "skip", entry, reason: entry.problem });
      continue;
    }
    if (!entry.enabled) {
      items.push({ action: "skip", entry, reason: `it's turned off in ${label}` });
      continue;
    }
    let url: URL;
    try {
      url = new URL(entry.url!);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
    } catch {
      items.push({ action: "skip", entry, reason: "its url isn't an http(s) URL" });
      continue;
    }
    const headerNames = Object.keys(entry.headers);
    if (headerNames.length > 1) {
      items.push({ action: "skip", entry, reason: `it sends ${headerNames.length} headers (${headerNames.join(", ")}); a connection keeps one (not supported yet)` });
      continue;
    }
    const existing = (ctx.existing ?? []).find((c) => sameUrl(c.url, url.href));
    if (existing) {
      items.push({ action: "exists", entry, connection: existing });
      continue;
    }
    const target = await checkTarget(url, ctx.lookup);
    if (target.kind === "never") {
      items.push({
        action: "skip",
        entry,
        reason:
          target.why === "ipv6_literal"
            ? `the private-network allow takes a hostname or an IPv4 address, not ${target.address}`
            : `it's on ${target.address}, a link-local or cloud metadata address, which is never allowed`,
      });
      continue;
    }
    if (target.kind === "public" && url.protocol === "http:") {
      items.push({ action: "skip", entry, reason: "plain http to a public host isn't allowed; use its https URL" });
      continue;
    }
    let slug = slugify(entry.name);
    for (let n = 2; taken.has(slug); n++) slug = `${slugify(entry.name).slice(0, 21)}-${n}`;
    taken.add(slug);
    let name = entry.name;
    for (let n = 2; takenNames.has(name.toLowerCase()); n++) name = `${entry.name} (${n})`;
    takenNames.add(name.toLowerCase());
    const auth = headerNames.length
      ? { type: "header" as const, name: headerNames[0]!, value: entry.headers[headerNames[0]!]! }
      : entry.oauth
        ? { type: "oauth" as const }
        : { type: "none" as const };
    items.push({ action: "create", entry, slug, name, url: entry.url!.trim(), auth, privateTarget: target.kind === "private" ? target.origin : null });
  }
  return items;
}

const where = (e: ClientEntry) => (e.scope ? ` (${e.scope} scope)` : "");
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** "its Authorization header (from $GITHUB_TOKEN) is sent to mcp.example.com": where each secret ends up. */
function headerLine(i: Extract<PlanItem, { action: "create" }>): string | null {
  if (i.auth.type !== "header") return null;
  const vars = i.entry.headerSources[i.auth.name] ?? [];
  const from = vars.length ? ` (from ${vars.map((v) => `$${v}`).join(", ")})` : "";
  return `its ${i.auth.name} header${from} moves into xaq (encrypted; never shown) and is sent to ${safeText(hostOf(i.url), 120)}`;
}

/** The plan in plain words. Never prints a header value. */
export function renderPlan(config: ClientConfig, items: PlanItem[]): string[] {
  const label = CLIENT_LABELS[config.client];
  const out: string[] = [];
  const width = Math.min(24, Math.max(4, ...items.map((i) => i.entry.name.length)));
  const pad = (s: string) => s.padEnd(width);
  const cont = " ".repeat(width + 4);
  out.push(`${label}: ${config.files.join(", ") || "no config file"} lists ${items.length} MCP server${items.length === 1 ? "" : "s"}.`);
  for (const i of items) {
    const name = `  ${pad(safeText(i.entry.name, 40))}  `;
    switch (i.action) {
      case "self":
        out.push(`${name}${pc.dim("skip: this is xaq itself")}`);
        break;
      case "stdio":
        out.push(`${name}${pc.yellow("not supported yet (M4)")}: a local command (${safeText(i.entry.command ?? "", 60)}); it stays in ${label}`);
        break;
      case "skip":
        out.push(`${name}${pc.yellow("skip")}: ${i.reason}; it stays in ${label}`);
        break;
      case "exists":
        if (isWorking(i.connection)) out.push(`${name}already connected: "${i.connection.slug}" (${i.connection.tools.total} tools)`);
        else {
          const why =
            i.entry.oauth || i.connection.authType === "oauth" || i.connection.status === "needs_reauth" ? "needs Connect" : `${i.connection.status}, ${i.connection.tools.total} tools`;
          out.push(`${name}already a connection: "${i.connection.slug}", ${why}; it stays in ${label} until it works`);
          out.push(`${cont}${reconnectHint(i.connection)}`);
        }
        out.push(...droppedLines(i.entry, cont));
        break;
      case "create": {
        out.push(`${name}${pc.green("create")} connection "${i.slug}" → ${safeText(i.url, 120)}${where(i.entry)}`);
        if (i.entry.fromProject) out.push(`${cont}${pc.yellow("from the project's .mcp.json")}: asked separately (--yes doesn't answer it)`);
        const h = headerLine(i);
        if (h) out.push(`${cont}${h}`);
        else if (i.auth.type === "oauth") out.push(`${cont}OAuth: created needing Connect (${label} keeps its own tokens); sign in once with the link it prints`);
        else out.push(`${cont}no credential in ${label}: connected as it is (if it turns out to use OAuth, it needs Connect)`);
        if (i.privateTarget) out.push(`${cont}${pc.yellow("private network")}: needs the allow for exactly ${i.privateTarget}`);
        out.push(...droppedLines(i.entry, cont));
        break;
      }
    }
  }
  return out;
}

/** What the client did for this server that the broker doesn't: said in the plan, never silently dropped. */
function droppedLines(e: ClientEntry, cont: string): string[] {
  const d = e.dropped;
  if (!d) return [];
  const out: string[] = [];
  const list = (xs: string[]) => xs.map((x) => safeText(x, 64)).join(", ");
  if (d.exclude) out.push(`${cont}${pc.yellow("not carried over")}: its tool filter hides ${list(d.exclude)}; through xaq every tool is listed (subject to the access level)`);
  if (d.include) out.push(`${cont}${pc.yellow("not carried over")}: its tool filter shows only ${list(d.include)}; through xaq every tool is listed (subject to the access level)`);
  if (d.settings.length) out.push(`${cont}${pc.yellow("not carried over")}: ${d.settings.join(", ")} (xaq uses its own 60 s per call)`);
  return out;
}

type CreateItem = Extract<PlanItem, { action: "create" }>;

interface Outcome {
  item: CreateItem;
  /** connected: works now; unverified: created, but not working (yet); authorize: needs a sign-in; failed: nothing kept. */
  status: "connected" | "unverified" | "authorize" | "failed";
  connection?: ConnectionView;
  authorizeUrl?: string;
  error?: string;
}

const works = isWorking;

function setupLines(r: McpSetupResult): string[] {
  const out = [r.ok ? `${r.dryRun ? pc.cyan("○") : pc.green("✔")} ${r.message}` : `${pc.yellow("!")} ${r.message}`];
  for (const l of r.changes ?? []) out.push(l.startsWith(" ") ? pc.gray(`  ${l}`) : `  - ${l}`);
  if (r.backup) out.push(pc.gray(`  Backup: ${r.backup}`));
  if (!r.ok) for (const l of r.manual ?? []) out.push(`    ${l}`);
  for (const n of r.notes ?? []) out.push(pc.dim(`  ${n}`));
  if (r.ok && r.verify?.length) out.push(`  ${r.dryRun ? "Afterwards, check it with" : "Check it with"}: ${r.verify.map((v) => pc.cyan(v)).join("; ")}`);
  return out;
}

const toRemove = (e: ClientEntry): RemoveServer => ({ name: e.name, scope: e.scope, projectDir: e.scope === "user" ? undefined : e.projectDir });

/** The agent this machine's client uses (its xaq profile), if that agent is on this daemon. */
interface ClientAgent {
  profileName: string;
  profile: Profile | null;
  agent: Agent | null;
}

export async function runImport(flags: ImportFlags, deps: ImportDeps): Promise<number> {
  const p = deps.prompter;
  const client: ImportClient = parseImportClient(flags.from);
  const label = CLIENT_LABELS[client];
  const access: AccessLevel | undefined = flags.access ? parseAccess(flags.access) : undefined;
  const config = readClientConfig(client, { env: deps.env, cwd: deps.cwd });
  if (!config.entries.length) {
    p.print(`${label} has no MCP servers configured (${config.files.join(", ") || "no config file"}). Nothing to import.`);
    return 0;
  }
  const profileName = flags.profile ?? DEFAULT_PROFILE;

  if (flags.dryRun) {
    // Existing connections from the daemon when it's reachable, so a re-run's plan is the real one.
    let existing: ConnectionView[] | undefined;
    try {
      existing = await deps.openApi().list();
    } catch {
      existing = undefined;
    }
    const items = await planImport(config, { existing, lookup: deps.lookup, selfOrigins: deps.selfOrigins });
    p.print(pc.bold("Dry run: nothing is created or changed."));
    for (const l of renderPlan(config, items)) p.print(l);
    const creates = items.filter((i): i is CreateItem => i.action === "create");
    const priv = creates.filter((i) => i.privateTarget);
    p.print("");
    p.print(`Would create ${creates.length} connection${creates.length === 1 ? "" : "s"} with ${access ? accessLabel(access) : "the access you choose (default: Ask before risky actions)"}.`);
    if (priv.length) p.print(`Would ask before allowing ${priv.map((i) => i.privateTarget).join(", ")} (--yes never does; --allow-private <origin> does for that origin).`);
    if (!existing) p.print(pc.dim("xaq wasn't reachable, so existing connections weren't checked (the real run does: nothing is created twice)."));
    const removable = [
      ...items.filter((i): i is Extract<PlanItem, { action: "exists" }> => i.action === "exists" && works(i.connection)).map((i) => toRemove(i.entry)),
      ...creates.filter((i) => i.auth.type !== "oauth").map((i) => toRemove(i.entry)),
    ];
    p.print("");
    if (!removable.length) p.print(`${label}'s config isn't changed.`);
    else if (!profileExists(profileName)) {
      p.print(`Afterwards it offers to replace the imported entries in ${label} with the single xaq entry, once this machine's ${label} is paired (${NPX} connect <xaq-url> --tool ${client}).`);
    } else {
      p.print(`Afterwards it offers setup-mcp --tool ${client}, which would (for the entries whose connection works and that ${label}'s agent can use; OAuth ones after you Reconnect them):`);
      const r = setupMcp(client, mcpTarget(profileName, loadProfile(profileName)), profilePath(profileName), { dryRun: true, removeServers: removable });
      for (const l of setupLines(r)) p.print(l);
    }
    return 0;
  }

  const api = deps.openApi();
  const existing = await api.list();
  const items = await planImport(config, { existing, lookup: deps.lookup, selfOrigins: deps.selfOrigins });
  for (const l of renderPlan(config, items)) p.print(l);
  let creates = items.filter((i): i is CreateItem => i.action === "create");
  const already = items.filter((i): i is Extract<PlanItem, { action: "exists" }> => i.action === "exists");
  p.print("");

  // A project's .mcp.json was written by whoever can commit to the repository: its own confirmation, never --yes.
  const fromProject = creates.filter((i) => i.entry.fromProject);
  if (fromProject.length) {
    p.print(pc.yellow(`These come from ${fromProject[0]!.entry.file}, which ships with the project (anyone who can commit to it wrote them):`));
    for (const i of fromProject) p.print(`  ${safeText(i.entry.name, 40)} → ${safeText(i.url, 120)}${headerLine(i) ? `; ${headerLine(i)}` : ""}`);
    if (!(await p.confirmExplicit(`Import ${fromProject.length === 1 ? "it" : `these ${fromProject.length}`} into xaq?`, "they stay in Claude Code"))) {
      creates = creates.filter((i) => !i.entry.fromProject);
    }
  }

  // The private-target allow: only a person at the terminal (or --allow-private naming the exact origin) gives it.
  const preAllowed = new Set(flags.allowPrivate ?? []);
  const priv = creates.filter((i) => i.privateTarget && !preAllowed.has(i.privateTarget));
  for (const i of creates.filter((x) => x.privateTarget && preAllowed.has(x.privateTarget))) p.print(`Allowing ${i.privateTarget} (${safeText(i.entry.name, 40)}): --allow-private.`);
  if (priv.length) {
    p.print(pc.yellow("These servers are on this machine or your private network:"));
    for (const i of priv) p.print(`  ${i.privateTarget}  (${safeText(i.entry.name, 40)})`);
    p.print(
      pc.dim("A connection to such a server can reach other services there too. Each allow covers exactly that scheme://host:port, for that connection only."),
    );
    const names = priv.map((i) => i.entry.name).join(", ");
    if (!(await p.confirmExplicit(`Allow xaq to connect to ${priv.length === 1 ? "it" : `these ${priv.length}`}?`, `skipping ${names} (pass --allow-private <origin> to allow one)`))) {
      creates = creates.filter((i) => !priv.includes(i));
    }
  }

  const who = await clientAgent(api, profileName);
  if (!creates.length) {
    p.print("Nothing to create.");
    return offerSetup(
      deps,
      api,
      client,
      who,
      already.filter((a) => works(a.connection)).map((a) => ({ entry: a.entry, connection: a.connection })),
      already.filter((a) => !works(a.connection)).map((a) => a.entry.name),
      0,
    );
  }

  const level = await chooseAccess(p, access);
  let agents = await chooseAgents(p, api, flags.agent);
  if (agents !== "all" && who.agent && !agents.includes(who.agent.id)) {
    p.print(pc.yellow(`${safeText(who.agent.name, 60)} (the agent ${label} on this machine uses) isn't among them, so ${label} couldn't use these through xaq.`));
    if (await p.confirm(`Include ${safeText(who.agent.name, 60)}?`, true)) agents = [...agents, who.agent.id];
  }
  if (!(await p.confirm(`Create ${creates.length} connection${creates.length === 1 ? "" : "s"} (${accessLabel(level)}, ${agentsLabel(agents)})?`, true))) {
    p.print("Nothing was created.");
    return 0;
  }

  const outcomes: Outcome[] = [];
  for (const item of creates) {
    let created: ConnectionView | null = null;
    try {
      created = await api.create({ slug: item.slug, name: item.name, url: item.url, levelDefault: level, ...(agents === "all" ? {} : { agentIds: agents }) });
      if (item.privateTarget) await api.allowPrivateTarget(created.id, true);
      const r = await api.connect(created.id, item.auth.type === "header" ? { header: { name: item.auth.name, value: item.auth.value } } : {});
      if (r.status === "connected") {
        // "connected" means stored, not tested (a header connect doesn't call the server): wait for the first tool sync.
        const after = await waitWorking(api, r.connection, { pollMs: deps.pollMs, ms: deps.verifyMs });
        outcomes.push({ item, status: works(after) ? "connected" : "unverified", connection: after });
      } else if (r.status === "authorize") outcomes.push({ item, status: "authorize", connection: created, authorizeUrl: r.authorizeUrl });
      else throw new Error(r.message);
    } catch (err) {
      // Nothing half-made stays behind: running the import again retries it cleanly.
      if (created) await api.remove(created.id).catch(() => {});
      outcomes.push({ item, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  p.print("");
  for (const o of outcomes) {
    const name = safeText(o.item.entry.name, 40);
    if (o.status === "failed") p.print(`${pc.red("✘")} ${name}: ${safeText(o.error!, 300)} (it stays in ${label})`);
    else if (o.status === "connected") p.print(`${pc.green("✔")} ${name} → "${o.connection!.slug}", ${o.connection!.tools.total} tools`);
    else if (o.status === "unverified") {
      const c = o.connection!;
      p.print(`${pc.yellow("○")} ${name} → "${c.slug}": not working (${c.status}${c.statusReason ? `: ${safeText(c.statusReason, 200)}` : ""}, ${c.tools.total} tools), so it stays in ${label}.`);
      p.print(`    ${reconnectHint(c)}   then run this import again.`);
    }
    else {
      p.print(`${pc.yellow("○")} ${name} → "${o.connection!.slug}": needs Connect. Sign in (link valid 15 minutes):`);
      p.print(`    ${pc.cyan(o.authorizeUrl!)}`);
      p.print(`    ${reconnectHint(o.connection!)}`);
    }
  }
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const working = [
    ...already.filter((a) => works(a.connection)).map((a) => ({ entry: a.entry, connection: a.connection })),
    ...outcomes.filter((o) => o.status === "connected").map((o) => ({ entry: o.item.entry, connection: o.connection! })),
  ];
  const pending = [
    ...already.filter((a) => !works(a.connection)).map((a) => a.entry.name),
    ...outcomes.filter((o) => o.status === "authorize" || o.status === "unverified").map((o) => o.item.entry.name),
  ];
  return offerSetup(deps, api, client, who, working, pending, failed ? 1 : 0);
}

async function clientAgent(api: ConnectionsApi, profileName: string): Promise<ClientAgent> {
  if (!profileExists(profileName)) return { profileName, profile: null, agent: null };
  const profile = loadProfile(profileName);
  const agent = (await api.agents()).find((a) => a.id === profile.agentId && !a.disabled) ?? null;
  return { profileName, profile, agent };
}

/**
 * Step 2: replace the entries now served by the broker with the single xaq entry (setup-mcp). Only entries
 * the client's own agent can use through xaq go: the profile's agent must be on this daemon and have a grant
 * on the connection (offered when it has none).
 */
async function offerSetup(
  deps: ImportDeps,
  api: ConnectionsApi,
  client: ImportClient,
  who: ClientAgent,
  working: { entry: ClientEntry; connection: ConnectionView }[],
  pending: string[],
  code: number,
): Promise<number> {
  const p = deps.prompter;
  const label = CLIENT_LABELS[client];
  if (pending.length) p.print(pc.dim(`${pending.join(", ")} stay${pending.length === 1 ? "s" : ""} in ${label} until ${pending.length === 1 ? "it works" : "they work"} through xaq (Reconnect); then run this import again to replace ${pending.length === 1 ? "it" : "them"}.`));
  if (!working.length) return code;
  if (!who.profile) {
    p.print(
      `To replace ${working.map((w) => w.entry.name).join(", ")} in ${label} with the single xaq entry, pair it first ` +
        `(${NPX} connect <xaq-url> --tool ${client}) and run this import again.`,
    );
    return code;
  }
  if (!who.agent) {
    p.print(
      pc.yellow(
        `The agent in your "${who.profileName}" profile (${safeText(who.profile.agentId, 40)}) isn't an agent of this xaq (or is disabled), so ${label} ` +
          `couldn't use these through it. Not replacing anything in ${label}. Pair it with this xaq (${NPX} connect <xaq-url> --tool ${client} --force), then run this import again.`,
      ),
    );
    return code;
  }
  const agentName = safeText(who.agent.name, 60);
  const usable: ClientEntry[] = [];
  for (const w of working) {
    if (w.entry.fromProject) {
      // ./.mcp.json is the project's file (often committed): left for its owners to change.
      p.print(pc.dim(`  "${w.entry.name}" stays in ${w.entry.file}: it ships with the project. Remove it there if the project no longer needs it.`));
      continue;
    }
    const grants = await api.grants(w.connection.id);
    if (grants.some((g) => g.agentId === who.agent!.id)) {
      usable.push(w.entry);
      continue;
    }
    if (await p.confirm(`${agentName} (the agent ${label} uses) has no access to "${w.connection.slug}". Give it ${accessLabel(w.connection.levelDefault)}?`, true)) {
      await api.setGrants(w.connection.id, [...grants.map((g) => ({ agentId: g.agentId, level: g.level })), { agentId: who.agent.id, level: w.connection.levelDefault }]);
      usable.push(w.entry);
    } else p.print(pc.dim(`  "${w.entry.name}" stays in ${label}: its agent couldn't use "${w.connection.slug}".`));
  }
  if (!usable.length) return code;
  p.print("");
  const question = `Replace ${usable.map((e) => `"${e.name}"`).join(", ")} in ${label} with the single xaq entry (setup-mcp --tool ${client}, with a backup)?`;
  const routes = confinedRoutes(client, mcpServerName(who.profileName), deps.env);
  let ok: boolean;
  if (routes.length) {
    const slugs = working.filter((w) => usable.includes(w.entry)).map((w) => w.connection.slug);
    p.print(pc.yellow(`These ${label} settings are limited to the xaq server only:`));
    for (const r of routes) p.print(`  ${safeText(r, 120)}`);
    p.print(
      pc.yellow(
        `Through xaq they now also see the tools of ${slugs.map((s) => `"${s}"`).join(", ")} (as <name>__<tool>), which ${routes.length === 1 ? "it" : "they"} couldn't reach before. ` +
          `If one is triggered by email or webhooks, those tools become reachable from that content. Give ${agentName} less access on those connections, or keep them out, if that's not what you want.`,
      ),
    );
    ok = await p.confirmExplicit(question, `${label}'s config wasn't changed; decide in a terminal`);
  } else ok = await p.confirm(question, true);
  if (!ok) {
    p.print(`${label}'s config wasn't changed. Run this import again any time to do it.`);
    return code;
  }
  const r = setupMcp(client, mcpTarget(who.profileName, who.profile), profilePath(who.profileName), { removeServers: usable.map(toRemove) });
  for (const l of setupLines(r)) p.print(l);
  const vars = [...new Set(usable.flatMap((e) => ((r.removed ?? []).includes(e.name) ? e.headerVars : [])))];
  if (r.ok && vars.length) {
    p.print(pc.dim(`  ${vars.join(", ")} ${vars.length === 1 ? "is" : "are"} no longer needed by the removed entries; delete ${vars.length === 1 ? "it" : "them"} from your environment${client === "hermes" ? " (~/.hermes/.env)" : ""} once everything works through xaq.`));
  }
  return r.ok ? code : 1;
}
