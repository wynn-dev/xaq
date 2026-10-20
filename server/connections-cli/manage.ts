import pc from "picocolors";
import { renameWarning, slugProblem } from "../../shared/connection-rename.ts";
import type { GoogleApiCheckView, SetupStepView, StartConnectInput } from "../../shared/types.ts";
import { safeText } from "../listen/ui.ts";
import { OFFICIAL_NAMES } from "../extensions/registry.ts";
import { NPX } from "../listen/version.ts";
import { accessLabel, agentsLabel, chooseAccess, chooseAgents, parseAccess } from "./access.ts";
import type { ConnectionProbe, ConnectionsApi, ConnectionView, PresetView } from "./api.ts";
import { presetServerSlug, presetServerUrl } from "../integrations/user-server.ts";
import { exactOrigin } from "./private.ts";
import type { Prompter } from "./prompt.ts";
import { reconnectHint, slugify, validSlug } from "./util.ts";

/** `connections add | list | reconnect | disable | remove`. */

export interface AddFlags {
  slug?: string;
  access?: string;
  agent?: string[];
  /** Header name for a server that wants a static key (default Authorization). */
  header?: string;
  /** Always paste the address the browser lands on, instead of waiting for the redirect. */
  paste?: boolean;
  /** The exact `scheme://host:port` to allow without asking (--yes never allows one). */
  allowPrivate?: string;
  yes?: boolean;
  /** The server's address, for an integration whose server you name (t3code). */
  url?: string;
  /** The connection's name (unique per owner); without it the server picks one (host or preset name, " (2)" when taken). */
  name?: string;
  /** A Google extension: the connected Google account (email) it works as. */
  account?: string;
}

export interface ManageDeps {
  prompter: Prompter;
  api: ConnectionsApi;
  openBrowser?: (url: string) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  /** Tests: poll faster. */
  pollMs?: number;
  timeoutMs?: number;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/** Renders a preset's setup step in the terminal (the console renders the same steps). */
export function renderStep(step: SetupStepView, n: number): string[] {
  const out = [pc.bold(`${n}. ${safeText(step.title, 120)}`)];
  for (const para of step.body.split(/\n{2,}/)) out.push(`   ${para.replace(/\s*\n\s*/g, " ").replace(/`([^`]+)`/g, (_m, c: string) => pc.cyan(c))}`);
  for (const a of step.apis ?? []) out.push(`   ${safeText(a.label, 80)}: ${pc.cyan(a.url)}`);
  if (step.link) out.push(`   ${step.link.label}: ${pc.cyan(step.link.url)}`);
  if (step.copy) out.push(`   ${step.copy.label}: ${pc.cyan(step.copy.value)}`);
  return out;
}

async function askInput(p: Prompter, input: NonNullable<SetupStepView["input"]>): Promise<string> {
  for (;;) {
    const v = input.secret ? await p.secret(input.label) : await p.ask(input.label);
    if (!v) {
      p.print(pc.yellow("  This is needed to continue."));
      continue;
    }
    if (input.pattern && !new RegExp(input.pattern).test(v)) {
      p.print(pc.yellow(`  That doesn't look right${input.placeholder ? ` (it looks like ${input.placeholder})` : ""}.`));
      continue;
    }
    return v;
  }
}

async function askSlug(p: Prompter, flag: string | undefined, def: string, taken: Set<string>): Promise<string> {
  if (flag) {
    if (!validSlug(flag)) throw new Error(`--slug "${flag}": use 1-24 lowercase letters, digits and dashes.`);
    if (taken.has(flag)) throw new Error(`There's already a connection "${flag}".`);
    return flag;
  }
  let suggestion = def;
  for (let n = 2; taken.has(suggestion); n++) suggestion = `${def.slice(0, 21)}-${n}`;
  for (;;) {
    const s = (await p.ask("Name it (agents see its tools as <name>__<tool>)", suggestion)).toLowerCase();
    if (!validSlug(s)) p.print(pc.yellow("  Use 1-24 lowercase letters, digits and dashes."));
    else if (taken.has(s)) p.print(pc.yellow(`  There's already a connection "${s}".`));
    else return s;
  }
}

/** A slug from a URL: the host's first label that says something (mcp.notion.com → notion). */
export function slugFromUrl(url: URL): string {
  const labels = url.hostname.split(".").filter((l) => !["mcp", "api", "www"].includes(l));
  const first = /^\d/.test(url.hostname) || url.hostname.includes(":") ? `${url.hostname}-${url.port || "mcp"}` : (labels[0] ?? url.hostname);
  return slugify(first);
}

const registrationWords: Record<string, string> = {
  preregistered: "with a registered client",
  metadata_document: "registers itself automatically (client metadata document)",
  dcr: "registers itself automatically (dynamic client registration)",
  manual: "needs a client ID you get from the provider",
};

const overSsh = (env: NodeJS.ProcessEnv) => !!(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
const isLoopbackHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";

/** Where the provider sends the browser after consent: the authorize URL's redirect_uri. */
function redirectOf(authorizeUrl: string): URL | null {
  try {
    const r = new URL(authorizeUrl).searchParams.get("redirect_uri");
    return r ? new URL(r) : null;
  } catch {
    return null;
  }
}

/**
 * OAuth: open the browser and wait for the callback, or paste the address the browser lands on: over SSH when the
 * redirect goes to localhost (the browser isn't on this machine), and always for an https://localhost redirect
 * (providers that refuse http, where nothing listens).
 */
export async function authorize(
  conn: ConnectionView,
  start: { authorizeUrl: string; callbackMode?: "direct" | "paste"; redirectUri?: string },
  deps: ManageDeps,
  flags: { paste?: boolean } = {},
): Promise<ConnectionView> {
  const { api, prompter: p } = deps;
  const env = deps.env ?? process.env;
  const authorizeUrl = start.authorizeUrl;
  const redirect = (() => {
    try {
      return start.redirectUri ? new URL(start.redirectUri) : redirectOf(authorizeUrl);
    } catch {
      return redirectOf(authorizeUrl);
    }
  })();
  const loopback = !!redirect && isLoopbackHost(redirect.hostname);
  const paste = !!flags.paste || start.callbackMode === "paste" || (loopback && (overSsh(env) || redirect!.protocol === "https:"));
  const name = safeText(conn.name, 60);
  if (paste) {
    p.print(`Open this link in a browser where you can sign in to ${name}:`);
    p.print(`  ${pc.cyan(authorizeUrl)}`);
    const start = redirect ? `${redirect.origin}${redirect.pathname}` : "the callback address";
    p.print(pc.dim(`After you approve, the browser goes to an address starting with ${start} (it may say the page can't be reached). Copy that whole address.`));
    for (;;) {
      const pasted = await p.ask("Paste the address here");
      if (!/[?&](code|error)=/.test(pasted)) {
        p.print(pc.yellow(`  That isn't the address after signing in: it starts with ${start} and has ?code=… in it.`));
        continue;
      }
      const r = await api.finish(pasted.trim());
      if (r.status === "connected") return r.connection;
      throw new Error(r.status === "error" ? r.message : "The sign-in didn't finish.");
    }
  }
  // A sign-in that completes saves a new credential: its fingerprint changes even on an already-active
  // connection (a Reconnect), where status and updated_at can't tell.
  const stamp = () => api.channel.credentialStamp(conn.id);
  const before = stamp();
  const beforeView = await api.get(conn.id);
  p.print(`Opening your browser to sign in to ${name}. If it doesn't open, use this link:`);
  p.print(`  ${pc.cyan(authorizeUrl)}`);
  try {
    await (deps.openBrowser ?? (async (u: string) => (await import("open")).default(u)))(authorizeUrl);
  } catch {
    // The link is printed.
  }
  const pollMs = deps.pollMs ?? 2000;
  const deadline = Date.now() + (deps.timeoutMs ?? 15 * 60_000);
  p.print(pc.dim("Waiting for you to approve in the browser… (Ctrl+C to stop)"));
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const now = await api.get(conn.id);
    const after = stamp();
    const changed = after !== null ? after !== before : now.expiresAt !== beforeView.expiresAt || now.updatedAt !== beforeView.updatedAt;
    // The sign-in page itself shows any error.
    if (now.status === "active" && changed) return now;
  }
  throw new Error(`Timed out waiting for the sign-in. Try again with \`${NPX} connections reconnect ${conn.slug}\`${overSsh(env) ? "" : " (add --paste to paste the address instead)"}.`);
}

/** Working = active with at least one tool listed: a "connected" answer alone isn't proof (a header isn't tested). */
export const isWorking = (c: ConnectionView) => c.status === "active" && c.tools.total > 0;

/**
 * Waits briefly for a just-connected connection's first tool sync: until it works, turns needs_reauth / error /
 * disabled, or `ms` pass. Returns the last view.
 */
export async function waitWorking(api: ConnectionsApi, c: ConnectionView, opts: { pollMs?: number; ms?: number } = {}): Promise<ConnectionView> {
  let now = c;
  const deadline = Date.now() + (opts.ms ?? 10_000);
  while (!isWorking(now) && now.status === "active" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 500));
    now = await api.get(c.id);
  }
  return now;
}

/** Connects (header, setup inputs, or OAuth) and returns the connection as it ends up. */
export async function connectNow(conn: ConnectionView, input: StartConnectInput, deps: ManageDeps, flags: { paste?: boolean } = {}): Promise<ConnectionView> {
  const r = await deps.api.connect(conn.id, input);
  if (r.status === "connected") return waitWorking(deps.api, r.connection, { pollMs: deps.pollMs, ms: deps.timeoutMs === undefined ? undefined : Math.min(deps.timeoutMs, 10_000) });
  // A finished sign-in is the start, not proof: wait for the first tool sync, as for a header.
  if (r.status === "authorize") return waitWorking(deps.api, await authorize(conn, r, deps, flags), { pollMs: deps.pollMs, ms: deps.timeoutMs === undefined ? undefined : Math.min(deps.timeoutMs, 10_000) });
  throw new Error(r.message);
}

function printResult(p: Prompter, c: ConnectionView): void {
  if (isWorking(c)) {
    p.print(`${pc.green("✔")} Connected "${c.slug}": ${c.tools.total} tool${c.tools.total === 1 ? "" : "s"}, seen by agents as ${c.slug}__<tool> (${accessLabel(c.levelDefault)}).`);
  } else {
    p.print(`${pc.yellow("○")} "${c.slug}" isn't working yet: ${c.status}${c.statusReason ? ` (${safeText(c.statusReason, 200)})` : ""}, ${c.tools.total} tools.`);
    p.print(`  ${reconnectHint(c)}`);
  }
}

interface Pending {
  slug: string;
  /** Only when the user gave one (--name): otherwise the server's default, which never collides. */
  name?: string;
  preset?: string;
  url?: string;
}

/** The access question, the agents, then create; `after` runs on the new connection (allow, connect). */
async function createThen(base: Pending, flags: AddFlags, deps: ManageDeps, after: (c: ConnectionView) => Promise<ConnectionView>): Promise<number> {
  const { api, prompter: p } = deps;
  const level = await chooseAccess(p, flags.access ? parseAccess(flags.access) : undefined);
  const agents = await chooseAgents(p, api, flags.agent);
  if (!(await p.confirm(`Add "${base.slug}" (${accessLabel(level)}, ${agentsLabel(agents)})?`, true))) {
    p.print("Nothing was added.");
    return 0;
  }
  const created = await api.create({ ...base, levelDefault: level, ...(agents === "all" ? {} : { agentIds: agents }) });
  let conn: ConnectionView;
  try {
    conn = await after(created);
  } catch (err) {
    p.print(pc.yellow(`"${created.slug}" was added but isn't connected: ${safeText(err instanceof Error ? err.message : String(err), 300)}`));
    p.print(`  ${reconnectHint(created)}   (or remove it: ${NPX} connections remove ${created.slug})`);
    return 1;
  }
  printResult(p, conn);
  return isWorking(conn) ? 0 : 1;
}

/** A Google extension (google-workspace): core's Google steps lead its setup (server/extensions/google-setup.ts). */
export const isGoogleExtension = (preset: PresetView) => preset.setupSteps.some((s) => s.id === "google-account" && s.input?.key === "google_account");

const API_STATE: Record<GoogleApiCheckView["state"], string> = { enabled: "on", disabled: "off", unchecked: "not checked yet", error: "couldn't check" };

/**
 * `connections add google-workspace`: the account (from xaq's connected ones), the API links, the gcloud command and
 * a check of each API, then the connection and Google's consent for exactly the extension's access.
 */
async function addGooglePreset(preset: PresetView, flags: AddFlags, deps: ManageDeps, taken: Set<string>): Promise<number> {
  const { api, prompter: p } = deps;
  p.print(pc.bold(`Connect ${safeText(preset.displayName, 60)}`));
  preset.setupSteps.forEach((step, i) => {
    for (const l of renderStep(step, i + 1)) p.print(l);
  });
  const step = preset.setupSteps.find((s) => s.id === "google-account")!;
  const choices = step.input?.choices ?? [];
  const usable = choices.filter((c) => !c.disabled);
  if (!usable.length) {
    throw new Error(
      choices.length
        ? "Every Google account connected to xaq needs reconnecting first (Accounts in the console)."
        : `No Google account is connected to xaq yet. Connect one in the console (Accounts → Connect account), then run this again.`,
    );
  }
  let account: string;
  if (flags.account) {
    const hit = choices.find((c) => c.value.toLowerCase() === flags.account!.trim().toLowerCase());
    if (!hit) throw new Error(`--account ${flags.account}: that Google account isn't connected to xaq. Connected: ${choices.map((c) => c.value).join(", ")}.`);
    if (hit.disabled) throw new Error(`${hit.value} ${hit.note ?? "can't be used now"}.`);
    account = hit.value;
  } else if (usable.length === 1) {
    account = usable[0]!.value;
    p.print(`Google account: ${pc.cyan(account)}${usable[0]!.note ? pc.dim(` (${usable[0]!.note})`) : ""}`);
  } else {
    account = await p.choose(
      "Which Google account should it work as?",
      usable.map((c) => ({ value: c.value, label: c.note ? `${c.value} (${c.note})` : c.value })),
      usable[0]!.value,
    );
  }
  // The APIs, checked as that account (a downscoped token: never one that can read its mail).
  for (;;) {
    const checks = await api.googleApis(preset.id, account);
    for (const c of checks) {
      const mark = c.state === "enabled" ? pc.green("✔") : c.state === "disabled" ? pc.red("✘") : pc.yellow("○");
      p.print(`  ${mark} ${safeText(c.label, 80)}: ${API_STATE[c.state]}${c.message ? pc.dim(` (${safeText(c.message, 200)})`) : ""}`);
      if (c.state === "disabled") p.print(`    Turn it on: ${pc.cyan(c.enableUrl)}`);
    }
    if (!checks.some((c) => c.state === "disabled")) break;
    if (!p.interactive || p.assumeYes) {
      p.print(pc.yellow("Some APIs are off: turn them on (links above), or the extension's tools that use them won't work."));
      break;
    }
    if (!(await p.confirm("Check again once you've turned them on? (no: continue anyway)", true))) break;
  }
  const slug = await askSlug(p, flags.slug, preset.slug, taken);
  p.print(pc.dim("Next, Google asks to allow only the extension's access: tick every box (and, for your own unverified app, Advanced → Go to <your app>)."));
  return createThen({ slug, ...(flags.name ? { name: flags.name } : {}), preset: preset.id }, flags, deps, (c) => connectNow(c, { inputs: { google_account: account } }, deps, flags));
}

async function addPreset(preset: PresetView, flags: AddFlags, deps: ManageDeps, taken: Set<string>): Promise<number> {
  if (isGoogleExtension(preset)) return addGooglePreset(preset, flags, deps, taken);
  const p = deps.prompter;
  p.print(pc.bold(`Connect ${safeText(preset.displayName, 60)}`));
  preset.setupSteps.forEach((step, i) => {
    for (const l of renderStep(step, i + 1)) p.print(l);
  });
  const inputs: Record<string, string> = {};
  for (const step of preset.setupSteps) if (step.input) inputs[step.input.key] = await askInput(p, step.input);
  let header: StartConnectInput["header"];
  if (preset.authType === "header") {
    header = await askHeader(p, flags.header ?? "Authorization");
  }
  const slug = await askSlug(p, flags.slug, preset.slug, taken);
  const input: StartConnectInput = { ...(header ? { header } : {}), ...(Object.keys(inputs).length ? { inputs } : {}) };
  return createThen({ slug, ...(flags.name ? { name: flags.name } : {}), preset: preset.id }, flags, deps, (c) => connectNow(c, input, deps, flags));
}

const isAuthorization = (name: string) => /^authorization$/i.test(name.trim());

/**
 * The header value to store for what was typed or pasted, the same in `add` and `reconnect`: no CR/LF and no
 * surrounding whitespace; for Authorization, a bare token gets "Bearer " and a pasted "Bearer <token>" (any case,
 * any spacing) is stored as "Bearer <token>". Another scheme ("Basic …") is kept as typed.
 */
export function headerValue(name: string, typed: string): string {
  const v = typed.replace(/[\r\n]+/g, "").trim();
  if (!isAuthorization(name)) return v;
  const bearer = /^bearer\s+(\S.*)$/i.exec(v);
  if (bearer) return `Bearer ${bearer[1]!.trim()}`;
  return /\s/.test(v) ? v : `Bearer ${v}`;
}

async function askHeader(p: Prompter, name: string): Promise<NonNullable<StartConnectInput["header"]>> {
  const label = isAuthorization(name) ? `API key or token (not shown; "Bearer " is added if you leave it out)` : `${name} value (not shown)`;
  for (;;) {
    const value = headerValue(name, await askInput(p, { key: "header", label, secret: true }));
    // "Bearer" alone, or only whitespace once CR/LF are gone.
    if (value && !/^bearer(\s+bearer)?$/i.test(value)) return { name: name.trim(), value };
    p.print(pc.yellow("  This is needed to continue."));
  }
}

async function headerFor(p: Prompter, flags: { header?: string }): Promise<NonNullable<StartConnectInput["header"]>> {
  return askHeader(p, flags.header ?? (await p.ask("Header name", "Authorization")));
}

function describeProbe(p: Prompter, probe: ConnectionProbe): void {
  if (probe.auth === "oauth") {
    p.print(`It signs in with OAuth${probe.issuer ? ` via ${safeText(probe.issuer, 120)}` : ""}${probe.registration ? `, and ${registrationWords[probe.registration] ?? probe.registration}` : ""}.`);
  } else if (probe.auth === "header") p.print("It needs an API key or token.");
  else if (probe.auth === "none") p.print("It doesn't need a sign-in.");
  else p.print(safeText(probe.message, 200));
}

const MANUAL_CLIENT = "It needs a client ID from the provider; finish it in the console's Connections page.";

/** `preset`: an integration whose server you name (t3code): its steps first, then the same check as a custom URL. */
async function addUrl(raw: string, flags: AddFlags, deps: ManageDeps, taken: Set<string>, preset: PresetView | null = null): Promise<number> {
  const { api, prompter: p } = deps;
  let url: URL;
  try {
    url = new URL(preset?.userServer ? presetServerUrl(raw, preset.userServer.defaultPath) : raw.trim());
  } catch {
    throw new Error(`"${raw}" isn't a URL. Use the server's full MCP address, e.g. https://mcp.example.com/mcp.`);
  }
  if (preset) {
    p.print(pc.bold(`Connect ${safeText(preset.displayName, 60)}`));
    preset.setupSteps.forEach((step, i) => {
      for (const l of renderStep(step, i + 1)) p.print(l);
    });
  }
  p.print(`Checking ${pc.cyan(url.href)}…`);
  const probe = await api.probe(url.href);
  let allowPrivate = false;
  let header: StartConnectInput["header"];
  if (probe.blocked === "private_target") {
    const origin = exactOrigin(url);
    p.print(pc.yellow(`${url.host} is on this machine or your private network.`));
    p.print(
      "xaq blocks those by default: a connection to a server there can reach other services on the same machine or network. " +
        `An allow covers exactly ${origin}, for this connection only (and plain http on that host).`,
    );
    const allowed = flags.allowPrivate === origin || (await p.confirmExplicit(`Allow this connection to reach ${origin}?`, `nothing was added (pass --allow-private ${origin} to allow it)`));
    if (!allowed) {
      p.print("Nothing was added.");
      return 0;
    }
    // Probed again once the connection (and its allow) exists.
    allowPrivate = true;
  } else if (probe.blocked || !probe.reachable) throw new Error(probe.message);
  else {
    describeProbe(p, probe);
    if (probe.auth === "oauth" && probe.registration === "manual") throw new Error(MANUAL_CLIENT);
    if (probe.auth === "header") header = await headerFor(p, flags);
  }
  if (preset && !allowPrivate && probe.auth !== "oauth") throw new Error(`${url.host} doesn't look like a ${preset.displayName} server: it doesn't ask for a sign-in.`);
  const slug = await askSlug(p, flags.slug, preset ? presetServerSlug(preset.slug, url.href) : slugFromUrl(url), taken);
  const base: Pending = { slug, ...(flags.name ? { name: flags.name } : {}), ...(preset ? { preset: preset.id } : {}), url: url.href };
  return createThen(base, flags, deps, async (c) => {
    if (allowPrivate) {
      await api.allowPrivateTarget(c.id, true);
      const again = await api.probe(url.href, c.id);
      if (again.blocked || !again.reachable) throw new Error(again.message);
      if (preset && again.auth !== "oauth") throw new Error(`${url.host} doesn't look like a ${preset.displayName} server: it doesn't ask for a sign-in.`);
      describeProbe(p, again);
      if (again.auth === "oauth" && again.registration === "manual") throw new Error(MANUAL_CLIENT);
      if (again.auth === "header") header = await headerFor(p, flags);
    }
    return connectNow(c, header ? { header } : {}, deps, flags);
  });
}

/**
 * Pre-made connections are extensions: an official one that isn't installed says how to install it; anything else
 * names what is installed.
 */
export function unknownIntegration(target: string, installed: readonly string[]): string {
  const name = target.trim().toLowerCase();
  if (OFFICIAL_NAMES.includes(name)) {
    return `The ${name} extension isn't installed. Install it first: \`${NPX} ext add ${name}\`, then run \`${NPX} connections add ${name}\` again.`;
  }
  const have = installed.length ? `Installed integrations: ${installed.join(", ")}. ` : "No integrations are installed yet. ";
  return `Unknown integration "${safeText(target, 64)}". ${have}Install one with \`${NPX} ext add <name>\` (official: ${OFFICIAL_NAMES.join(", ")}), or pass an MCP server URL.`;
}

export async function addConnection(target: string, flags: AddFlags, deps: ManageDeps): Promise<number> {
  const existing = await deps.api.list();
  const taken = new Set(existing.map((c) => c.slug));
  // A name you chose that's taken fails now, before any question (names are unique per owner, case-insensitive).
  if (flags.name !== undefined) {
    const name = flags.name.trim();
    if (!name) throw new Error("--name can't be empty.");
    const clash = existing.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new Error(`You already have a connection named "${safeText(clash.name, 100)}" ("${clash.slug}"). Pick another --name, or leave it out.`);
    flags = { ...flags, name };
  }
  if (isUrl(target)) return addUrl(target, flags, deps, taken);
  const presets = await deps.api.presets();
  const preset = presets.find((x) => x.id === target.trim().toLowerCase());
  if (!preset) throw new Error(unknownIntegration(target, presets.map((x) => x.id)));
  if (preset.userServer) {
    const raw = flags.url ?? (await deps.prompter.ask(`Address of your ${preset.displayName} server (e.g. http://100.101.102.103:3773)`));
    return addUrl(raw, flags, deps, taken, preset);
  }
  return addPreset(preset, flags, deps, taken);
}

export async function listConnections(deps: ManageDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const all = await api.list();
  if (!all.length) {
    p.print(`No connections yet. Install an extension (${NPX} ext add notion), then ${NPX} connections add notion; or ${NPX} connections add <an MCP server URL>.`);
    return 0;
  }
  const w = Math.max(4, ...all.map((c) => c.slug.length));
  p.print(pc.dim(`${"NAME".padEnd(w)}  ${"STATUS".padEnd(12)}  ${"ACCESS".padEnd(24)}  ${"TOOLS".padEnd(5)}  URL`));
  for (const c of all) {
    const status = c.status === "active" ? pc.green(c.status.padEnd(12)) : pc.yellow(c.status.padEnd(12));
    const notes: string[] = [];
    if (c.privateTarget) notes.push("private network");
    const d = c.expiresInDays;
    if (d !== null && d <= 7) notes.push(d <= 0 ? "expires today: Reconnect" : `expires in ${d} day${d === 1 ? "" : "s"}`);
    if (c.status === "needs_reauth") notes.push("Reconnect");
    p.print(
      `${c.slug.padEnd(w)}  ${status}  ${accessLabel(c.levelDefault).padEnd(24)}  ${String(c.tools.total).padEnd(5)}  ${safeText(c.url ?? c.kind, 80)}${notes.length ? pc.yellow(`  (${notes.join(", ")})`) : ""}`,
    );
  }
  return 0;
}

export async function reconnectConnection(slug: string, flags: { paste?: boolean; header?: string }, deps: ManageDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const c = await api.bySlug(slug);
  const after = await connectNow(c, c.authType === "header" ? { header: await headerFor(p, flags) } : {}, deps, flags);
  printResult(p, after);
  return isWorking(after) ? 0 : 1;
}

export async function disableConnection(slug: string, deps: ManageDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const c = await api.bySlug(slug);
  if (!(await p.confirm(`Disable "${slug}"? Agents lose its tools at once, its pending approvals are cancelled and its stored credentials are deleted.`, false))) return 0;
  await api.kill(c.id);
  p.print(`${pc.green("✔")} Disabled "${slug}". To use it again, turn it on in the console's Connections page and reconnect.`);
  return 0;
}

/** `connections rename <slug|id> --slug <new> [--name <name>]`: the PATCH the console's "Change short name" uses. */
export async function renameConnection(target: string, flags: { slug?: string; name?: string }, deps: ManageDeps): Promise<number> {
  const { api, prompter: p } = deps;
  if (flags.slug === undefined && flags.name === undefined) throw new Error("Pass --slug <new-name> (and/or --name <display name>).");
  const all = await api.list();
  const c = all.find((x) => x.slug === target || x.id === target);
  if (!c) throw new Error(`No connection "${target}". ${all.length ? `There are: ${all.map((x) => x.slug).join(", ")}.` : "There are none yet."}`);
  const patch: { slug?: string; name?: string } = {};
  if (flags.slug !== undefined && flags.slug !== c.slug) {
    const slug = flags.slug.trim();
    const problem = slugProblem(slug, c, all.map((x) => ({ ...x, name: safeText(x.name, 60) })));
    if (problem) throw new Error(`--slug "${slug}": ${problem}`);
    patch.slug = slug;
  }
  if (flags.name !== undefined && flags.name.trim() !== c.name) {
    const name = flags.name.trim();
    if (!name) throw new Error("--name can't be empty.");
    patch.name = name;
  }
  if (!Object.keys(patch).length) {
    p.print(`"${c.slug}" already has that ${flags.slug !== undefined ? "short name" : "name"}; nothing to change.`);
    return 0;
  }
  if (patch.slug) {
    p.print(pc.yellow(renameWarning(c.slug, patch.slug)));
    if (!(await p.confirm(`Rename "${c.slug}" to "${patch.slug}"?`, false))) {
      p.print("Nothing was changed.");
      return 0;
    }
  }
  const after = await api.update(c.id, patch);
  const parts = [patch.slug ? `its tools are now ${after.slug}__<tool>` : "", patch.name ? `its name is now "${safeText(after.name, 100)}"` : ""].filter(Boolean);
  p.print(`${pc.green("✔")} Renamed "${c.slug}": ${parts.join("; ")}.`);
  return 0;
}

export async function removeConnection(slug: string, deps: ManageDeps): Promise<number> {
  const { api, prompter: p } = deps;
  const c = await api.bySlug(slug);
  if (!(await p.confirm(`Remove "${slug}" and delete its stored credentials? This can't be undone.`, false))) return 0;
  await api.remove(c.id);
  p.print(`${pc.green("✔")} Removed "${slug}".`);
  return 0;
}
