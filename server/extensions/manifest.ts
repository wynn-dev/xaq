// The extension manifest, `xaq-extension.json` (docs/EXTENSIONS.md): its type, a strict validator, the JSON Schema
// the xaq-extensions repo checks manifests with (scripts/validate.mjs), and `presetFromManifest`, which turns an
// installed extension into the IntegrationPreset the broker, policy, catalog and console already use.
//
// Strict on purpose: an unknown key anywhere is an error (schema 1), and every value is checked here, not by the
// schema alone. Setup strings may use {{publicUrl}}, {{redirectUri}} and {{webhookUrl}} and nothing else; a step
// that uses {{webhookUrl}} must say `"when": "webhookUrl"`, so it only shows when the internet can reach this install.

import { classifyTool } from "../broker/catalog/classify.ts";
import type { IntegrationPreset, PresetAuth, SetupContext, SetupStep, ToolClass, ToolDef } from "../broker/types.ts";
import { CORE_ONLY_SCOPES, EXTENSION_SCOPE_RE, GOOGLE_SERVICE_RE, isExtensionScope } from "../google/scopes.ts";
import { googleSetupSteps } from "./google-setup.ts";
import { codeExtensionSource } from "./host/index.ts";
import { computeIntegrity } from "./integrity.ts";
import type { InstalledExtension } from "./store.ts";

export const MANIFEST_FILE = "xaq-extension.json";
export const MANIFEST_SCHEMA_VERSION = 1;

// ───────────── Types ─────────────

export type RiskClass = "read" | "write" | "risky";

export interface RiskEntry {
  class: RiskClass;
}

export type RemoteAuth =
  | { type: "none" }
  | { type: "header"; headerName: string; prefix?: string }
  /**
   * `broadScopes`: granted scopes that mean broad access; the console warns when a sign-in grants any of them.
   * `scopeNotes`: what a granted scope means, in priority order; the console shows the first granted one's note.
   */
  | { type: "mcp_oauth"; broadScopes?: string[]; scopeNotes?: { scope: string; note: string }[] };

/** One Google API a `google` auth needs on in the user's Cloud project: `docs.googleapis.com`, "Google Docs API". */
export interface GoogleApi {
  service: string;
  label: string;
}

export type CodeAuth =
  | { type: "none" }
  /**
   * Official extensions only: a connection is bound to one of xaq's connected Google accounts and gets access tokens
   * downscoped to exactly `scopes`, added to the account by incremental consent (docs/EXTENSIONS.md "Google accounts
   * for code extensions"). Never Gmail, Calendar or Pub/Sub scopes.
   */
  | { type: "google"; scopes: string[]; apis: GoogleApi[] }
  | {
      type: "user_app";
      authorizeUrl: string;
      tokenUrl: string;
      scopes: string[];
      clientIdInput: string;
      clientSecretInput: string;
      /** Sent as `scope` on a refresh (WHOOP: "offline"); omitted when absent. */
      refreshScope?: string;
    };

export interface ManifestSetupStep extends SetupStep {
  /** Shown only when this context is present: "webhookUrl" when the internet can reach the install's webhooks. */
  when?: "webhookUrl";
}

export interface Manifest {
  schema: 1;
  name: string;
  displayName: string;
  version: string;
  description: string;
  kind: "remote" | "code";
  slug: string;
  remote?: {
    url?: string;
    userServer?: { defaultPath: string; sameOriginIssuer?: boolean };
    auth: RemoteAuth;
  };
  code?: {
    entry: string;
    node?: string;
    auth: CodeAuth;
    network?: string[];
    events?: string[];
  };
  reconnectPolicy?: { maxLifetimeDays?: number; idleDays?: number; tokenLifetimeCapDays?: number };
  setup?: ManifestSetupStep[];
  risk?: { tools: Record<string, RiskEntry>; nameCheckExempt?: string[] };
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

// ───────────── Rules (shared by the validator and the JSON Schema) ─────────────

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const SLUG_RE = /^[a-z0-9-]{1,24}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const STEP_ID_RE = /^[a-z0-9-]{1,32}$/;
const INPUT_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,100}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.\-/]{1,128}$/;
const POINTER_RE = /^(\/([^~/]|~[01])*)+$/;
const HOST_RE = /^(?=.{1,253}$)(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const EVENT_NAME_RE = /^[a-z0-9_]{1,64}$/;
/** A space-separated OAuth scope list (RFC 6749 scope-token: no space, quote or backslash). */
const SCOPE_LIST_RE = /^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/;
const ENTRY_RE = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9_./-]{1,200}\.(mjs|js)$/;
/** xaq's own event prefixes (shared/types.ts): an extension that names its events can't be called like one. */
const RESERVED_NAMES = new Set(["message", "thread", "label", "account", "sync", "calendar", "connection", "approval", "xaq"]);
const TEMPLATE_VARS = ["publicUrl", "redirectUri", "webhookUrl"] as const;
/** Only in a manifest with a `google` code.auth: the install's Google Cloud project ID (never at the start of a link). */
const PROJECT_ID_VAR = "projectId";
type TemplateVar = (typeof TEMPLATE_VARS)[number] | typeof PROJECT_ID_VAR;
/** What the project ID reads as when xaq doesn't know it (the Google step of the setup wizard isn't done). */
export const UNKNOWN_PROJECT_ID = "YOUR_PROJECT_ID";
const TEMPLATE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
/** A link built on one of the install's addresses: the variable, then a path, query, fragment or nothing. */
const TEMPLATE_LINK_RE = /^\{\{\s*(publicUrl|redirectUri|webhookUrl)\s*\}\}([/?#]|$)/;
const SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
// No control characters except newline in prose (manifests are shown to the admin verbatim).
// oxlint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const MAX_DAYS = 3650;

// ───────────── Validator ─────────────

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function fail(path: string, msg: string): never {
  throw new ManifestError(`${MANIFEST_FILE}: ${path} ${msg}`);
}

function obj(v: unknown, path: string, allowed: readonly string[], required: readonly string[] = []): Obj {
  if (!isObj(v)) fail(path, "must be an object");
  for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(path, `has an unknown key "${k.slice(0, 64)}"`);
  for (const k of required) if (!Object.hasOwn(v, k)) fail(path, `is missing "${k}"`);
  return v;
}

function str(v: unknown, path: string, opts: { max: number; min?: number; re?: RegExp; multiline?: boolean; what?: string }): string {
  if (typeof v !== "string") fail(path, "must be a string");
  if (v.length < (opts.min ?? 1)) fail(path, "must not be empty");
  if (v.length > opts.max) fail(path, `must be at most ${opts.max} characters`);
  if (opts.re && !opts.re.test(v)) fail(path, `must be ${opts.what ?? `like ${opts.re.source}`}`);
  const control = opts.multiline ? v.replace(/\n/g, "") : v;
  if (CONTROL_RE.test(control)) fail(path, "must not contain control characters");
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(path, "must be true or false");
  return v;
}

function days(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_DAYS) fail(path, `must be a whole number of days from 1 to ${MAX_DAYS}`);
  return v;
}

function strList(v: unknown, path: string, item: (s: unknown, p: string) => string, max: number): string[] {
  if (!Array.isArray(v)) fail(path, "must be an array");
  if (v.length > max) fail(path, `must have at most ${max} entries`);
  const out = v.map((s, i) => item(s, `${path}[${i}]`));
  if (new Set(out).size !== out.length) fail(path, "has duplicates");
  return out;
}

function httpsUrl(v: unknown, path: string): string {
  const s = str(v, path, { max: 2048 });
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    fail(path, "must be an absolute URL");
  }
  if (u.protocol !== "https:") fail(path, "must be an https URL");
  if (u.username || u.password) fail(path, "must not carry a user name or password");
  return s;
}

/** Template variables used in a string; unknown ones are refused. {{projectId}} only with `projectId` (a google auth). */
function templateVars(s: string, path: string, projectId = false): TemplateVar[] {
  const out: TemplateVar[] = [];
  for (const m of s.matchAll(TEMPLATE_RE)) {
    const name = m[1]!;
    const known = (TEMPLATE_VARS as readonly string[]).includes(name) || (projectId && name === PROJECT_ID_VAR);
    if (!known) {
      fail(
        path,
        name === PROJECT_ID_VAR
          ? 'uses {{projectId}}, which only an extension with "code.auth": { "type": "google" } can use'
          : `uses {{${name.slice(0, 40)}}}: only {{publicUrl}}, {{redirectUri}} and {{webhookUrl}} are available${projectId ? ", and {{projectId}}" : ""}`,
      );
    }
    out.push(name as TemplateVar);
  }
  // A stray brace pair left after removing the valid ones is a typo ({{publicUrl}, {publicUrl}}).
  if (/\{\{|\}\}/.test(s.replace(TEMPLATE_RE, ""))) fail(path, "has an unbalanced {{ }}");
  return out;
}

function templated(v: unknown, path: string, opts: { max: number; multiline?: boolean; projectId?: boolean }, used: Set<TemplateVar>): string {
  const s = str(v, path, opts);
  for (const name of templateVars(s, path, opts.projectId)) used.add(name);
  return s;
}

function validatePattern(v: unknown, path: string): string {
  const s = str(v, path, { max: 500 });
  try {
    new RegExp(s);
  } catch {
    fail(path, "must be a valid regular expression");
  }
  return s;
}

/** Strings that are shown as they are (no {{variables}} filled in) can't look like a template either. */
function noTemplate(s: string, path: string): string {
  if (s.includes("{{") || s.includes("}}")) fail(path, "can't use {{ }}");
  return s;
}

function validateStep(v: unknown, path: string, projectId = false): ManifestSetupStep {
  const o = obj(v, path, ["id", "title", "body", "link", "copy", "input", "when"], ["id", "title", "body"]);
  const used = new Set<TemplateVar>();
  if (o.id !== undefined && typeof o.id === "string" && o.id.startsWith("google-")) fail(`${path}.id`, 'can\'t start with "google-": xaq uses those for its own Google steps');
  const step: ManifestSetupStep = {
    id: str(o.id, `${path}.id`, { max: 32, re: STEP_ID_RE, what: "lowercase letters, digits and dashes" }),
    title: templated(o.title, `${path}.title`, { max: 120, projectId }, used),
    body: templated(o.body, `${path}.body`, { max: 4000, multiline: true, projectId }, used),
  };
  if (o.link !== undefined) {
    const l = obj(o.link, `${path}.link`, ["label", "url"], ["label", "url"]);
    const label = templated(l.label, `${path}.link.label`, { max: 120, projectId }, used);
    // {{projectId}} can't be the start of a link (TEMPLATE_LINK_RE), only after an https host: it never picks the host.
    const url = templated(l.url, `${path}.link.url`, { max: 2048, projectId }, used);
    // A link is either an https URL or one of this install's own addresses, followed by a path, query, fragment or
    // nothing (so `{{publicUrl}}@evil.example` can't turn the install's address into a user name).
    if (/^\{\{/.test(url)) {
      if (!TEMPLATE_LINK_RE.test(url)) fail(`${path}.link.url`, "must be {{publicUrl}}, {{redirectUri}} or {{webhookUrl}} followed by /, ?, # or nothing");
    } else httpsUrl(url, `${path}.link.url`);
    // {{projectId}} only in the path, query or fragment of a link: never in its host.
    const at = url.search(/\{\{\s*projectId\s*\}\}/);
    if (at >= 0 && !/^https:\/\/[^/?#{}]+[/?#]/.test(url.slice(0, at))) fail(`${path}.link.url`, "can use {{projectId}} only after the host (in the path, query or fragment)");
    step.link = { label, url };
  }
  if (o.copy !== undefined) {
    const c = obj(o.copy, `${path}.copy`, ["label", "value"], ["label", "value"]);
    step.copy = { label: templated(c.label, `${path}.copy.label`, { max: 120, projectId }, used), value: templated(c.value, `${path}.copy.value`, { max: 2048, projectId }, used) };
  }
  if (o.input !== undefined) {
    const i = obj(o.input, `${path}.input`, ["key", "label", "secret", "pattern", "placeholder"], ["key", "label"]);
    step.input = {
      key: str(i.key, `${path}.input.key`, { max: 64, re: INPUT_KEY_RE, what: "a lowercase identifier (letters, digits, _)" }),
      label: noTemplate(str(i.label, `${path}.input.label`, { max: 120 }), `${path}.input.label`),
    };
    if (i.secret !== undefined) step.input.secret = bool(i.secret, `${path}.input.secret`);
    if (i.pattern !== undefined) step.input.pattern = validatePattern(i.pattern, `${path}.input.pattern`);
    if (i.placeholder !== undefined) step.input.placeholder = noTemplate(str(i.placeholder, `${path}.input.placeholder`, { max: 200 }), `${path}.input.placeholder`);
  }
  if (o.when !== undefined) {
    if (o.when !== "webhookUrl") fail(`${path}.when`, 'must be "webhookUrl"');
    step.when = "webhookUrl";
  }
  if (used.has("webhookUrl") && step.when !== "webhookUrl") fail(path, 'uses {{webhookUrl}}, so it needs "when": "webhookUrl"');
  return step;
}

function validateRisk(v: unknown, path: string): NonNullable<Manifest["risk"]> {
  const o = obj(v, path, ["tools", "nameCheckExempt"], ["tools"]);
  if (!isObj(o.tools)) fail(`${path}.tools`, "must be an object");
  const names = Object.keys(o.tools);
  if (names.length > 1000) fail(`${path}.tools`, "must list at most 1000 tools");
  const tools: Record<string, RiskEntry> = {};
  for (const name of names) {
    const p = `${path}.tools["${name.slice(0, 64)}"]`;
    str(name, p, { max: 128, re: TOOL_NAME_RE, what: "a tool name" });
    // "target" (a JSON Pointer for approval rules, gone) is still accepted and ignored, so older manifests install.
    const e = obj(o.tools[name], p, ["class", "target"], ["class"]);
    if (e.class !== "read" && e.class !== "write" && e.class !== "risky") fail(`${p}.class`, 'must be "read", "write" or "risky"');
    const entry: RiskEntry = { class: e.class };
    Object.defineProperty(tools, name, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  const risk: NonNullable<Manifest["risk"]> = { tools };
  if (o.nameCheckExempt !== undefined) {
    risk.nameCheckExempt = strList(o.nameCheckExempt, `${path}.nameCheckExempt`, (s, p) => str(s, p, { max: 128, re: TOOL_NAME_RE, what: "a tool name" }), 100);
    for (const name of risk.nameCheckExempt) {
      // The exemption makes the table's answer final for that name: it must have one, and it can't be "risky" (moot).
      if (!Object.hasOwn(tools, name)) fail(`${path}.nameCheckExempt`, `names ${name}, which risk.tools doesn't list`);
      if (tools[name]!.class === "risky") fail(`${path}.nameCheckExempt`, `names ${name}, which is already risky`);
    }
  }
  return risk;
}

function validateRemote(v: unknown): NonNullable<Manifest["remote"]> {
  const o = obj(v, "remote", ["url", "userServer", "auth"], ["auth"]);
  const remote: NonNullable<Manifest["remote"]> = { auth: { type: "none" } };
  if ((o.url === undefined) === (o.userServer === undefined)) fail("remote", 'needs exactly one of "url" or "userServer"');
  if (o.url !== undefined) remote.url = httpsUrl(o.url, "remote.url");
  if (o.userServer !== undefined) {
    const u = obj(o.userServer, "remote.userServer", ["defaultPath", "sameOriginIssuer"], ["defaultPath"]);
    remote.userServer = { defaultPath: str(u.defaultPath, "remote.userServer.defaultPath", { max: 200, re: /^\/[A-Za-z0-9_.~\-/]*$/, what: 'a path such as "/mcp"' }) };
    if (u.sameOriginIssuer !== undefined) remote.userServer.sameOriginIssuer = bool(u.sameOriginIssuer, "remote.userServer.sameOriginIssuer");
  }
  const a = obj(o.auth, "remote.auth", ["type", "headerName", "prefix", "broadScopes", "scopeNotes"], ["type"]);
  const extra = (allowed: string[]) => {
    for (const k of Object.keys(a)) if (k !== "type" && !allowed.includes(k)) fail("remote.auth", `has "${k}", which type ${String(a.type)} doesn't take`);
  };
  switch (a.type) {
    case "none":
      extra([]);
      remote.auth = { type: "none" };
      break;
    case "header": {
      extra(["headerName", "prefix"]);
      const auth: RemoteAuth = { type: "header", headerName: str(a.headerName, "remote.auth.headerName", { max: 100, re: HEADER_RE, what: "an HTTP header name" }) };
      if (a.prefix !== undefined) auth.prefix = str(a.prefix, "remote.auth.prefix", { max: 32, re: /^[\x21-\x7e]+ ?$/, what: 'a short scheme such as "Bearer "' });
      remote.auth = auth;
      break;
    }
    case "mcp_oauth": {
      extra(["broadScopes", "scopeNotes"]);
      const auth: RemoteAuth = { type: "mcp_oauth" };
      if (a.broadScopes !== undefined) auth.broadScopes = strList(a.broadScopes, "remote.auth.broadScopes", (s, p) => str(s, p, { max: 200, re: SCOPE_RE, what: "an OAuth scope" }), 50);
      if (a.scopeNotes !== undefined) {
        // An array, not an object: the order is the priority, and JS reorders integer-like object keys.
        if (!Array.isArray(a.scopeNotes)) fail("remote.auth.scopeNotes", "must be an array of { scope, note }");
        if (a.scopeNotes.length > 50) fail("remote.auth.scopeNotes", "must have at most 50 entries");
        auth.scopeNotes = a.scopeNotes.map((n: unknown, i: number) => {
          const p = `remote.auth.scopeNotes[${i}]`;
          const e = obj(n, p, ["scope", "note"], ["scope", "note"]);
          return { scope: str(e.scope, `${p}.scope`, { max: 200, re: SCOPE_RE, what: "an OAuth scope" }), note: noTemplate(str(e.note, `${p}.note`, { max: 1000 }), `${p}.note`) };
        });
        const scopes = auth.scopeNotes.map((n) => n.scope);
        if (new Set(scopes).size !== scopes.length) fail("remote.auth.scopeNotes", "names a scope twice");
      }
      remote.auth = auth;
      break;
    }
    default:
      fail("remote.auth.type", 'must be "mcp_oauth", "header" or "none"');
  }
  return remote;
}

function validateGoogleAuth(a: Obj, official: boolean): Extract<CodeAuth, { type: "google" }> {
  // Checked before anything else: a third-party manifest never gets as far as naming Google scopes.
  if (!official) {
    fail("code.auth", 'of type "google" is only for official extensions (from wynn-dev/xaq-extensions): it uses your connected Google accounts');
  }
  obj(a, "code.auth", ["type", "scopes", "apis"], ["type", "scopes", "apis"]);
  const scopes = strList(
    a.scopes,
    "code.auth.scopes",
    (s, p) => {
      const scope = str(s, p, { max: 200 });
      if (!/^https:\/\/www\.googleapis\.com\/auth\/[a-z0-9][a-z0-9._-]{0,99}$/.test(scope)) fail(p, "must be a Google API scope URL (https://www.googleapis.com/auth/…)");
      if (!isExtensionScope(scope)) fail(p, "is a Gmail, Calendar, Pub/Sub or Cloud scope: those stay with xaq's core and an extension can never ask for them");
      return scope;
    },
    20,
  );
  if (!scopes.length) fail("code.auth.scopes", "must list at least one scope");
  if (!Array.isArray(a.apis)) fail("code.auth.apis", "must be an array of { service, label }");
  if (a.apis.length > 20) fail("code.auth.apis", "must have at most 20 entries");
  const apis = a.apis.map((x: unknown, i: number) => {
    const p = `code.auth.apis[${i}]`;
    const e = obj(x, p, ["service", "label"], ["service", "label"]);
    return {
      service: str(e.service, `${p}.service`, { max: 100, re: GOOGLE_SERVICE_RE, what: 'a Google API service name such as "docs.googleapis.com"' }),
      label: noTemplate(str(e.label, `${p}.label`, { max: 80 }), `${p}.label`),
    };
  });
  const services = apis.map((x) => x.service);
  if (new Set(services).size !== services.length) fail("code.auth.apis", "names a service twice");
  return { type: "google", scopes, apis };
}

function validateCode(v: unknown, name: string, official: boolean): NonNullable<Manifest["code"]> {
  const o = obj(v, "code", ["entry", "node", "auth", "network", "events"], ["entry", "auth"]);
  const code: NonNullable<Manifest["code"]> = {
    entry: str(o.entry, "code.entry", { max: 200, re: ENTRY_RE, what: "a relative path to one .mjs or .js file inside the extension" }),
    auth: { type: "none" },
  };
  if (o.node !== undefined) code.node = str(o.node, "code.node", { max: 64, re: /^[<>=^~ 0-9.x|*-]+$/, what: 'a semver range such as ">=22.13"' });
  const a = obj(o.auth, "code.auth", ["type", "authorizeUrl", "tokenUrl", "scopes", "clientIdInput", "clientSecretInput", "refreshScope", "apis"], ["type"]);
  if (a.type === "none") {
    if (Object.keys(a).length > 1) fail("code.auth", 'of type "none" takes no other keys');
  } else if (a.type === "google") {
    code.auth = validateGoogleAuth(a, official);
  } else if (a.type === "user_app") {
    obj(a, "code.auth", ["type", "authorizeUrl", "tokenUrl", "scopes", "clientIdInput", "clientSecretInput", "refreshScope"], ["authorizeUrl", "tokenUrl", "scopes", "clientIdInput", "clientSecretInput"]);
    code.auth = {
      type: "user_app",
      authorizeUrl: httpsUrl(a.authorizeUrl, "code.auth.authorizeUrl"),
      tokenUrl: httpsUrl(a.tokenUrl, "code.auth.tokenUrl"),
      scopes: strList(a.scopes, "code.auth.scopes", (s, p) => str(s, p, { max: 200, re: /^[\x21\x23-\x5b\x5d-\x7e]+$/, what: "an OAuth scope" }), 50),
      clientIdInput: str(a.clientIdInput, "code.auth.clientIdInput", { max: 64, re: INPUT_KEY_RE, what: "a setup input key" }),
      clientSecretInput: str(a.clientSecretInput, "code.auth.clientSecretInput", { max: 64, re: INPUT_KEY_RE, what: "a setup input key" }),
    };
    if (a.refreshScope !== undefined) code.auth.refreshScope = str(a.refreshScope, "code.auth.refreshScope", { max: 1000, re: SCOPE_LIST_RE, what: "OAuth scopes separated by single spaces" });
    if (code.auth.clientIdInput === code.auth.clientSecretInput) fail("code.auth", "needs different inputs for the client id and secret");
  } else {
    fail("code.auth.type", 'must be "user_app", "google" or "none"');
  }
  if (o.network !== undefined) code.network = strList(o.network, "code.network", (s, p) => str(s, p, { max: 253, re: HOST_RE, what: "a lowercase host name" }), 50);
  if (o.events !== undefined) {
    if (name.length > 24) fail("code.events", "needs an extension name of at most 24 characters (event types are <name>.<event>)");
    code.events = strList(
      o.events,
      "code.events",
      (s, p) => {
        const t = str(s, p, { max: 90 });
        const dot = t.indexOf(".");
        if (t.slice(0, dot) !== name || !EVENT_NAME_RE.test(t.slice(dot + 1))) fail(p, `must be "${name}.<event>" (lowercase letters, digits, _)`);
        return t;
      },
      50,
    );
  }
  return code;
}

/**
 * Validates a parsed `xaq-extension.json`. Throws ManifestError naming the first problem. Returns a fresh copy.
 * `official`: the extension comes from the official registry. Only then may it use `"code.auth": { "type": "google" }`
 * (a third-party one is refused here, so at install too); the default is third-party.
 */
export function validateManifest(raw: unknown, opts: { official?: boolean } = {}): Manifest {
  const o = obj(
    raw,
    "the manifest",
    ["schema", "name", "displayName", "version", "description", "kind", "slug", "remote", "code", "reconnectPolicy", "setup", "risk"],
    ["schema", "name", "displayName", "version", "description", "kind", "slug"],
  );
  if (o.schema !== MANIFEST_SCHEMA_VERSION) fail("schema", `must be ${MANIFEST_SCHEMA_VERSION} (this xaq reads schema ${MANIFEST_SCHEMA_VERSION} manifests)`);
  const name = str(o.name, "name", { max: 32, re: NAME_RE, what: "lowercase letters, digits and dashes (at most 32)" });
  if (RESERVED_NAMES.has(name)) fail("name", `can't be "${name}": xaq uses it`);
  if (o.kind !== "remote" && o.kind !== "code") fail("kind", 'must be "remote" or "code"');
  const m: Manifest = {
    schema: 1,
    name,
    displayName: str(o.displayName, "displayName", { max: 64 }),
    version: str(o.version, "version", { max: 64, re: SEMVER_RE, what: 'a semantic version such as "1.0.0"' }),
    description: str(o.description, "description", { max: 500 }),
    kind: o.kind,
    slug: str(o.slug, "slug", { max: 24, re: SLUG_RE, what: "lowercase letters, digits and dashes (at most 24)" }),
  };
  if (m.kind === "remote") {
    if (o.code !== undefined) fail("code", 'is only for "kind": "code"');
    if (o.remote === undefined) fail("remote", 'is required for "kind": "remote"');
    m.remote = validateRemote(o.remote);
  } else {
    if (o.remote !== undefined) fail("remote", 'is only for "kind": "remote"');
    if (o.code === undefined) fail("code", 'is required for "kind": "code"');
    m.code = validateCode(o.code, name, opts.official === true);
  }
  const projectId = m.code?.auth.type === "google";
  if (o.reconnectPolicy !== undefined) {
    const r = obj(o.reconnectPolicy, "reconnectPolicy", ["maxLifetimeDays", "idleDays", "tokenLifetimeCapDays"]);
    m.reconnectPolicy = {};
    if (r.maxLifetimeDays !== undefined) m.reconnectPolicy.maxLifetimeDays = days(r.maxLifetimeDays, "reconnectPolicy.maxLifetimeDays");
    if (r.idleDays !== undefined) m.reconnectPolicy.idleDays = days(r.idleDays, "reconnectPolicy.idleDays");
    if (r.tokenLifetimeCapDays !== undefined) m.reconnectPolicy.tokenLifetimeCapDays = days(r.tokenLifetimeCapDays, "reconnectPolicy.tokenLifetimeCapDays");
  }
  if (o.setup !== undefined) {
    if (!Array.isArray(o.setup)) fail("setup", "must be an array");
    if (o.setup.length > 30) fail("setup", "must have at most 30 steps");
    m.setup = o.setup.map((s, i) => validateStep(s, `setup[${i}]`, projectId));
    const ids = m.setup.map((s) => s.id);
    if (new Set(ids).size !== ids.length) fail("setup", "has two steps with the same id");
    const keys = m.setup.flatMap((s) => (s.input ? [s.input.key] : []));
    if (new Set(keys).size !== keys.length) fail("setup", "has two inputs with the same key");
  }
  if (m.code?.auth.type === "user_app") {
    const keys = new Set((m.setup ?? []).map((s) => s.input?.key));
    for (const k of [m.code.auth.clientIdInput, m.code.auth.clientSecretInput]) if (!keys.has(k)) fail("code.auth", `names the input "${k}", which no setup step asks for`);
  }
  if (o.risk !== undefined) m.risk = validateRisk(o.risk, "risk");
  return m;
}

// ───────────── JSON Schema (copied into xaq-extensions' scripts/validate.mjs) ─────────────

const stringOf = (maxLength: number, extra: Obj = {}) => ({ type: "string", minLength: 1, maxLength, ...extra });
const days$ = { type: "integer", minimum: 1, maximum: MAX_DAYS };
const scope$ = stringOf(200, { pattern: "^[\\x21\\x23-\\x5b\\x5d-\\x7e]+$" });
const toolName$ = stringOf(128, { pattern: TOOL_NAME_RE.source });
const pointer$ = stringOf(512, { pattern: POINTER_RE.source });
const noTemplate$ = { not: { pattern: "\\{\\{|\\}\\}" } };
const httpsUrl$ = stringOf(2048, { pattern: "^https://[^\\s@/]+(/\\S*)?$" });

/**
 * The manifest's JSON Schema (draft 2020-12). It checks shape; validateManifest checks the rest too (template
 * variables, `when` for {{webhookUrl}}, unique step ids and input keys, exempt names listed in risk.tools, event
 * prefixes, setup inputs named by user_app auth).
 */
export const MANIFEST_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://raw.githubusercontent.com/wynn-dev/xaq/main/docs/xaq-extension.schema.json",
  title: "xaq extension manifest (xaq-extension.json), schema 1",
  type: "object",
  additionalProperties: false,
  required: ["schema", "name", "displayName", "version", "description", "kind", "slug"],
  properties: {
    schema: { const: 1 },
    name: stringOf(32, { pattern: NAME_RE.source, not: { enum: [...RESERVED_NAMES] } }),
    displayName: stringOf(64),
    version: stringOf(64, { pattern: SEMVER_RE.source }),
    description: stringOf(500),
    kind: { enum: ["remote", "code"] },
    slug: stringOf(24, { pattern: SLUG_RE.source }),
    remote: {
      type: "object",
      additionalProperties: false,
      required: ["auth"],
      properties: {
        url: httpsUrl$,
        userServer: {
          type: "object",
          additionalProperties: false,
          required: ["defaultPath"],
          properties: { defaultPath: stringOf(200, { pattern: "^/[A-Za-z0-9_.~\\-/]*$" }), sameOriginIssuer: { type: "boolean" } },
        },
        auth: {
          oneOf: [
            { type: "object", additionalProperties: false, required: ["type"], properties: { type: { const: "none" } } },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "headerName"],
              properties: { type: { const: "header" }, headerName: stringOf(100, { pattern: HEADER_RE.source }), prefix: stringOf(32, { pattern: "^[\\x21-\\x7e]+ ?$" }) },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type"],
              properties: {
                type: { const: "mcp_oauth" },
                broadScopes: { type: "array", maxItems: 50, uniqueItems: true, items: scope$ },
                scopeNotes: {
                  type: "array",
                  maxItems: 50,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["scope", "note"],
                    properties: { scope: stringOf(200, { pattern: SCOPE_RE.source }), note: stringOf(1000, noTemplate$) },
                  },
                },
              },
            },
          ],
        },
      },
      oneOf: [{ required: ["url"], not: { required: ["userServer"] } }, { required: ["userServer"], not: { required: ["url"] } }],
    },
    code: {
      type: "object",
      additionalProperties: false,
      required: ["entry", "auth"],
      properties: {
        entry: stringOf(200, { pattern: ENTRY_RE.source }),
        node: stringOf(64, { pattern: "^[<>=^~ 0-9.x|*-]+$" }),
        auth: {
          oneOf: [
            { type: "object", additionalProperties: false, required: ["type"], properties: { type: { const: "none" } } },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "authorizeUrl", "tokenUrl", "scopes", "clientIdInput", "clientSecretInput"],
              properties: {
                type: { const: "user_app" },
                authorizeUrl: httpsUrl$,
                tokenUrl: httpsUrl$,
                scopes: { type: "array", maxItems: 50, uniqueItems: true, items: scope$ },
                clientIdInput: stringOf(64, { pattern: INPUT_KEY_RE.source }),
                clientSecretInput: stringOf(64, { pattern: INPUT_KEY_RE.source }),
                refreshScope: stringOf(1000, { pattern: SCOPE_LIST_RE.source }),
              },
            },
            // Official extensions only (the validator's rule: the schema lives in the official repo).
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "scopes", "apis"],
              properties: {
                type: { const: "google" },
                scopes: {
                  type: "array",
                  minItems: 1,
                  maxItems: 20,
                  uniqueItems: true,
                  items: stringOf(200, { pattern: EXTENSION_SCOPE_RE.source, not: { enum: [...CORE_ONLY_SCOPES] } }),
                },
                apis: {
                  type: "array",
                  maxItems: 20,
                  uniqueItems: true,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["service", "label"],
                    properties: { service: stringOf(100, { pattern: GOOGLE_SERVICE_RE.source }), label: stringOf(80, noTemplate$) },
                  },
                },
              },
            },
          ],
        },
        network: { type: "array", maxItems: 50, uniqueItems: true, items: stringOf(253, { pattern: HOST_RE.source }) },
        events: { type: "array", maxItems: 50, uniqueItems: true, items: stringOf(90, { pattern: "^[a-z0-9-]{1,24}\\.[a-z0-9_]{1,64}$" }) },
      },
    },
    reconnectPolicy: {
      type: "object",
      additionalProperties: false,
      properties: { maxLifetimeDays: days$, idleDays: days$, tokenLifetimeCapDays: days$ },
    },
    setup: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "body"],
        properties: {
          id: stringOf(32, { pattern: STEP_ID_RE.source }),
          title: stringOf(120),
          body: stringOf(4000),
          link: {
            type: "object",
            additionalProperties: false,
            required: ["label", "url"],
            properties: { label: stringOf(120), url: stringOf(2048, { pattern: "^(https://|\\{\\{\\s*(publicUrl|redirectUri|webhookUrl)\\s*\\}\\}([/?#]|$))" }) },
          },
          copy: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: stringOf(120), value: stringOf(2048) } },
          input: {
            type: "object",
            additionalProperties: false,
            required: ["key", "label"],
            properties: {
              key: stringOf(64, { pattern: INPUT_KEY_RE.source }),
              label: stringOf(120, noTemplate$),
              secret: { type: "boolean" },
              pattern: stringOf(500),
              placeholder: stringOf(200, noTemplate$),
            },
          },
          when: { const: "webhookUrl" },
        },
      },
    },
    risk: {
      type: "object",
      additionalProperties: false,
      required: ["tools"],
      properties: {
        tools: {
          type: "object",
          maxProperties: 1000,
          propertyNames: { pattern: TOOL_NAME_RE.source, maxLength: 128 },
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            required: ["class"],
            properties: {
              class: { enum: ["read", "write", "risky"] },
              target: { oneOf: [pointer$, { type: "array", minItems: 1, maxItems: 16, uniqueItems: true, items: pointer$ }] },
            },
          },
        },
        nameCheckExempt: { type: "array", maxItems: 100, uniqueItems: true, items: toolName$ },
      },
    },
  },
  allOf: [
    { if: { properties: { kind: { const: "remote" } } }, then: { required: ["remote"], not: { required: ["code"] } } },
    { if: { properties: { kind: { const: "code" } } }, then: { required: ["code"], not: { required: ["remote"] } } },
  ],
} as const;

// ───────────── Setup copy ─────────────

/** The manifest's setup steps for this install: `when` applied, {{variables}} filled in. */
export function renderSetup(steps: readonly ManifestSetupStep[], ctx: SetupContext): SetupStep[] {
  // {{projectId}} validated only in a google manifest; outside a link it is shown as is, inside one it's encoded.
  const projectId = ctx.google?.projectId ?? UNKNOWN_PROJECT_ID;
  const vars: Record<TemplateVar, string> = { publicUrl: ctx.publicUrl, redirectUri: ctx.redirectUri, webhookUrl: ctx.webhookUrl ?? "", projectId };
  const fill = (s: string) => s.replace(TEMPLATE_RE, (_, name: string) => vars[name as TemplateVar] ?? "");
  const fillUrl = (s: string) => s.replace(TEMPLATE_RE, (_, name: string) => (name === PROJECT_ID_VAR ? encodeURIComponent(projectId) : (vars[name as TemplateVar] ?? "")));
  const out: SetupStep[] = [];
  for (const s of steps) {
    if (s.when === "webhookUrl" && !ctx.webhookUrl) continue;
    const step: SetupStep = { id: s.id, title: fill(s.title), body: fill(s.body) };
    if (s.link) step.link = { label: fill(s.link.label), url: fillUrl(s.link.url) };
    if (s.copy) step.copy = { label: fill(s.copy.label), value: fill(s.copy.value) };
    if (s.input) step.input = { ...s.input };
    out.push(step);
  }
  return out;
}

// ───────────── Risk map ─────────────

/** The risk map as IntegrationPreset.classify: exact names only; null (the generic rules) for anything unlisted. */
export function classifierFor(risk: Manifest["risk"]): (tool: ToolDef) => ToolClass | null {
  const tools = risk?.tools ?? {};
  return (tool) => {
    const entry = Object.hasOwn(tools, tool.name) ? tools[tool.name] : undefined;
    if (!entry) return null;
    return { risky: entry.class === "risky", read: entry.class === "read", source: "preset" };
  };
}

/**
 * A third-party risk map: it can make a tool stricter than the generic rules (annotations, the verb list), never
 * looser. risky = map's risky OR generic risky; read = map's read AND generic read (a write stays a write).
 */
export function stricterOnly(table: (tool: ToolDef) => ToolClass | null): (tool: ToolDef) => ToolClass | null {
  return (tool) => {
    const cls = table(tool);
    if (!cls) return null;
    const generic = classifyTool(tool, null);
    return { ...cls, risky: cls.risky || generic.risky, read: cls.read && generic.read && !generic.risky };
  };
}

// ───────────── Manifest → IntegrationPreset ─────────────

/** The IntegrationPreset for a validated manifest. `ext` is needed for code extensions (the host starts its entry). */
export function presetFromValidManifest(m: Manifest, ext: InstalledExtension | null, opts: { official: boolean }): IntegrationPreset {
  const setup = m.setup ?? [];
  const table = classifierFor(m.risk);
  const base = {
    id: m.name,
    displayName: m.displayName,
    slug: m.slug,
    official: opts.official,
    // A third-party risk map can only add risk: the generic rules still apply on top, and no name is exempt.
    classify: opts.official ? table : stricterOnly(table),
    setupSteps: (ctx: SetupContext) => renderSetup(setup, ctx),
    ...(opts.official && m.risk?.nameCheckExempt?.length ? { nameCheckExempt: [...m.risk.nameCheckExempt] } : {}),
    ...(m.reconnectPolicy && Object.keys(m.reconnectPolicy).length ? { reconnectPolicy: { ...m.reconnectPolicy } } : {}),
  };
  if (m.kind === "remote") {
    const r = m.remote!;
    const auth: PresetAuth =
      r.auth.type === "header"
        ? { type: "header", headerName: r.auth.headerName, ...(r.auth.prefix !== undefined ? { prefix: r.auth.prefix } : {}) }
        : r.auth.type === "mcp_oauth"
          ? {
              type: "mcp_oauth",
              ...(r.auth.broadScopes?.length ? { broadScopes: [...r.auth.broadScopes] } : {}),
              ...(r.auth.scopeNotes?.length ? { scopeNotes: r.auth.scopeNotes.map((n) => ({ ...n })) } : {}),
            }
          : { type: "none" };
    return {
      ...base,
      kind: "remote_http",
      auth,
      ...(r.url ? { url: r.url } : {}),
      ...(r.userServer ? { userServer: { defaultPath: r.userServer.defaultPath, sameOriginIssuer: r.userServer.sameOriginIssuer === true } } : {}),
    };
  }
  const c = m.code!;
  // A google auth survives only for an official extension (validateManifest refuses it otherwise; this is the second lock).
  const google = c.auth.type === "google" && opts.official ? { type: "google" as const, scopes: [...c.auth.scopes], apis: c.auth.apis.map((a) => ({ ...a })) } : null;
  if (c.auth.type === "google" && !google) throw new ManifestError(`${MANIFEST_FILE}: code.auth of type "google" is only for official extensions`);
  const auth: PresetAuth = c.auth.type === "user_app" ? { ...c.auth, scopes: [...c.auth.scopes] } : (google ?? { type: "none" });
  return {
    ...base,
    // A google auth: core's four Google steps (account, APIs, consent, done) come first, then the manifest's own.
    ...(google ? { setupSteps: (ctx: SetupContext) => [...googleSetupSteps(m.displayName, google, ctx), ...renderSetup(setup, ctx)] } : {}),
    kind: "native",
    auth,
    // The code host (server/extensions/host): one sandboxed child per connection. Before every start it re-checks
    // the integrity of exactly this install (what ExtensionStore.verify does for the recorded one).
    ...(ext ? { createSource: (deps) => codeExtensionSource(ext, deps, { verify: () => verifyInstall(ext) }) } : {}),
    ...(c.events?.length ? { events: { types: [...c.events] } } : {}),
  };
}

/** The install's files still hash to the integrity recorded at install (false on any read error). */
function verifyInstall(ext: InstalledExtension): boolean {
  try {
    return computeIntegrity(ext.installDir) === ext.integrity;
  } catch {
    return false;
  }
}

/** The IntegrationPreset of an installed extension. Throws ManifestError when its manifest is invalid or not its own. */
export function presetFromManifest(ext: InstalledExtension): IntegrationPreset {
  const m = validateManifest(ext.manifest, { official: ext.official });
  if (m.name !== ext.name) throw new ManifestError(`${MANIFEST_FILE}: name is "${m.name}", but the extension is installed as "${ext.name}"`);
  if (m.kind !== ext.kind) throw new ManifestError(`${MANIFEST_FILE}: kind is "${m.kind}", but the extension is installed as "${ext.kind}"`);
  return presetFromValidManifest(m, ext, { official: ext.official });
}
