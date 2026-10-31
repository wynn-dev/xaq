// Upstream prompts and resources on /mcp, for every connection, remote and code:
// - prompts are `<slug>__<name>`;
// - resources are `xaq://<slug>/<encodeURIComponent(original uri)>`, their names `<slug>__<name>`;
// - resource templates the same way: the literal parts of the template are encoded, the `{…}` expressions kept, so
//   the URI a client expands decodes back to the upstream's own URI;
// - prompts/get and resources/read are routed to the connection by slug and un-namespaced.
// Both are "read" class: an agent sees them with any grant (any level) on an enabled connection. Lists aren't audited
// (like tools/list); prompts/get and resources/read are, like a read tool call. Results are cleaned as tool output is
// (ANSI, invisible characters, this connection's secrets, xaq's delimiters), and resource text is wrapped as
// untrusted tool output (wrapResourceText).

import type { AccessLevel } from "../../shared/types.ts";
import type { AuditInput } from "../audit.ts";
import type { Db } from "../db/index.ts";
import { cleanLine, escapeDelimiters, stripInvisible } from "../mail/content.ts";
import { errorMessage } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { connectionGrantsOf } from "./access.ts";
import { scrubText } from "./credentials/scrub.ts";
import { connectionSecrets, makeScrubber, MAX_BINARY_BYTES, newNonce, type Scrubber, stripAnsi } from "./policy/output.ts";
import type { CredentialStore } from "./credentials/store.ts";
import { type PromptDef, type PromptResult, type ResourceDef, type ResourceReadResult, type ResourceTemplateDef, SourceError, type ToolSource } from "./types.ts";

export const XAQ_RESOURCE_SCHEME = "xaq:";
/** Per connection, for the list fan-out: a slow upstream doesn't hold up everyone else's prompts. */
export const PASSTHROUGH_LIST_TIMEOUT_MS = 10_000;

export type PassthroughErrorCode = "invalid_params" | "not_found" | "unavailable";

/** A prompts/get or resources/read the broker can't serve; /mcp answers it as a JSON-RPC error. */
export class PassthroughError extends Error {
  constructor(
    readonly code: PassthroughErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PassthroughError";
  }
}

export interface BrokerPassthrough {
  listPrompts(agentId: string, signal: AbortSignal): Promise<PromptDef[]>;
  getPrompt(agentId: string, exposedName: string, args: Record<string, string>, signal: AbortSignal): Promise<PromptResult>;
  listResources(agentId: string, signal: AbortSignal): Promise<ResourceDef[]>;
  listResourceTemplates(agentId: string, signal: AbortSignal): Promise<ResourceTemplateDef[]>;
  readResource(agentId: string, uri: string, signal: AbortSignal): Promise<ResourceReadResult>;
}

export interface PassthroughDeps {
  db: Db;
  /** The connection's live source; null when it's disabled or missing (or the broker is off). */
  source(connectionId: string): ToolSource | null;
  credentials: Pick<CredentialStore, "tokens" | "header" | "client">;
  audit(input: AuditInput): void;
  log: Logger;
  listTimeoutMs?: number;
}

// ───────────── Names and URIs ─────────────

// oxlint-disable-next-line no-control-regex -- refusing control characters is the point
const UPSTREAM_NAME_RE = /^[^\s\u0000-\u001f\u007f]{1,128}$/u;

/**
 * A resource's or template's display name, made safe: invisible and control characters go, whitespace runs become
 * "_", at most 128 characters; null when nothing is left. (Prompts keep the strict check: their name is how
 * prompts/get routes. A resource routes by its URI, so its name is only a label.)
 */
export function safeResourceName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  // oxlint-disable-next-line no-control-regex -- dropping control characters is the point
  const out = stripInvisible(name).text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, "_").slice(0, 128);
  return out || null;
}
const SLUG_RE = /^[a-z0-9-]{1,24}$/;

export const exposedPromptName = (slug: string, name: string) => `${slug}__${name}`;

/** `<slug>__<name>` → its parts; null when it isn't one (a slug never has "_", so the first "__" splits it). */
export function splitExposedName(exposed: string): { slug: string; name: string } | null {
  const i = exposed.indexOf("__");
  if (i <= 0) return null;
  const slug = exposed.slice(0, i);
  const name = exposed.slice(i + 2);
  return SLUG_RE.test(slug) && name ? { slug, name } : null;
}

export const exposedResourceUri = (slug: string, uri: string) => `xaq://${slug}/${encodeURIComponent(uri)}`;

/** `xaq://<slug>/<encoded>` → the slug and the upstream URI; null when it isn't one. */
export function parseResourceUri(uri: string): { slug: string; uri: string } | null {
  const m = /^xaq:\/\/([a-z0-9-]{1,24})\/(.+)$/s.exec(uri);
  if (!m) return null;
  try {
    const inner = decodeURIComponent(m[2]!);
    return inner ? { slug: m[1]!, uri: inner } : null;
  } catch {
    return null;
  }
}

/** A template's literal parts encoded (as exposedResourceUri does), its `{…}` expressions kept for the client. */
export function exposedResourceTemplate(slug: string, template: string): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    if (open === -1) {
      out += encodeURIComponent(template.slice(i));
      break;
    }
    const close = template.indexOf("}", open);
    if (close === -1) {
      out += encodeURIComponent(template.slice(i));
      break;
    }
    out += encodeURIComponent(template.slice(i, open)) + template.slice(open, close + 1);
    i = close + 1;
  }
  return `xaq://${slug}/${out}`;
}

// ───────────── Cleaning ─────────────

const text = (s: unknown, max: number): string | undefined => (typeof s === "string" && s.trim() ? cleanLine(s, max) : undefined);
const MIME_RE = /^[\w.+-]{1,64}\/[\w.+-]{1,128}$/;

function cleanPrompt(slug: string, p: PromptDef): PromptDef | null {
  if (typeof p?.name !== "string" || !UPSTREAM_NAME_RE.test(p.name)) return null;
  const args = Array.isArray(p.arguments)
    ? p.arguments
        .filter((a) => typeof a?.name === "string" && UPSTREAM_NAME_RE.test(a.name))
        .slice(0, 50)
        .map((a) => ({ name: a.name, ...(text(a.description, 500) ? { description: text(a.description, 500) } : {}), ...(a.required === true ? { required: true } : {}) }))
    : undefined;
  const title = text(p.title, 200);
  const description = text(p.description, 2000);
  return { name: exposedPromptName(slug, p.name), ...(title ? { title } : {}), ...(description ? { description } : {}), ...(args?.length ? { arguments: args } : {}) };
}

function cleanResource(slug: string, r: ResourceDef): ResourceDef | null {
  const name = safeResourceName(r?.name);
  if (typeof r?.uri !== "string" || !r.uri || r.uri.length > 2048 || !name) return null;
  const title = text(r.title, 200);
  const description = text(r.description, 2000);
  return {
    uri: exposedResourceUri(slug, r.uri),
    name: `${slug}__${name}`,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(typeof r.mimeType === "string" && MIME_RE.test(r.mimeType) ? { mimeType: r.mimeType } : {}),
    ...(typeof r.size === "number" && Number.isSafeInteger(r.size) && r.size >= 0 ? { size: r.size } : {}),
  };
}

function cleanTemplate(slug: string, t: ResourceTemplateDef): ResourceTemplateDef | null {
  const name = safeResourceName(t?.name);
  if (typeof t?.uriTemplate !== "string" || !t.uriTemplate || t.uriTemplate.length > 2048 || !name) return null;
  const title = text(t.title, 200);
  const description = text(t.description, 2000);
  return {
    uriTemplate: exposedResourceTemplate(slug, t.uriTemplate),
    name: `${slug}__${name}`,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(typeof t.mimeType === "string" && MIME_RE.test(t.mimeType) ? { mimeType: t.mimeType } : {}),
  };
}

const BINARY_KEYS = new Set(["data", "blob"]);

/** Like tool output (server/broker/policy/output.ts): ANSI and controls, invisible characters, secrets, delimiters. */
function cleanText(text: string, scrubber: Scrubber): string {
  return escapeDelimiters(scrubber.scrub(stripInvisible(stripAnsi(text).text).text).text);
}

/**
 * Resource text is third-party data, wrapped the way tool output is (one `<tool_output … untrusted>` per text, a fresh
 * nonce per response). Prompt messages aren't: a prompt is instructions the user picked to send, and wrapping it would
 * defeat it; they're cleaned all the same.
 */
function wrapResourceText(text: string, source: string, nonce: string): string {
  return `<tool_output source="${source.replace(/["<>&]/g, "")}" nonce="${nonce}" untrusted>\n${text}\n</tool_output>`;
}

interface Clean {
  slug: string;
  scrubber: Scrubber;
  /** Wraps resource text as untrusted (wrapResourceText). */
  wrap: (text: string) => string;
}

/**
 * Every string cleaned (cleanText; base64 payloads untouched), upstream resource URIs rewritten to their xaq:// form.
 * `inResource`: the value is a resource's contents (resources/read, or an embedded `resource` block), whose `text` is
 * wrapped as untrusted.
 */
function scrubDeep(value: unknown, c: Clean, inResource: boolean, key = ""): unknown {
  if (typeof value === "string") {
    if (BINARY_KEYS.has(key)) return value;
    const t = cleanText(value, c.scrubber);
    return inResource && key === "text" ? c.wrap(t) : t;
  }
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, c, inResource));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "uri" && typeof v === "string") out[k] = exposedResourceUri(c.slug, v);
    else out[k] = scrubDeep(v, c, inResource || k === "resource", k);
  }
  return out;
}

const tooBig = (b64: unknown) => typeof b64 === "string" && Math.floor((b64.length * 3) / 4) > MAX_BINARY_BYTES;

// ───────────── The service part ─────────────

interface Grant {
  connectionId: string;
  slug: string;
  level: AccessLevel;
}

export function createPassthrough(deps: PassthroughDeps): BrokerPassthrough {
  const listTimeout = deps.listTimeoutMs ?? PASSTHROUGH_LIST_TIMEOUT_MS;
  const grants = (agentId: string): Grant[] => connectionGrantsOf(deps.db, agentId).map((g) => ({ connectionId: g.connectionId, slug: g.slug, level: g.level }));

  /** The agent's granted connections whose source has prompts and resources. */
  const withSources = (agentId: string) =>
    grants(agentId).flatMap((g) => {
      const s = deps.source(g.connectionId);
      return s?.prompts ? [{ ...g, prompts: s.prompts }] : [];
    });

  /** One list per connection, in parallel; a failing or slow connection is skipped (and logged). */
  async function fanOut<T>(agentId: string, signal: AbortSignal, what: string, op: (p: NonNullable<ToolSource["prompts"]>, s: AbortSignal) => Promise<T[]>, clean: (slug: string, x: T) => T | null): Promise<T[]> {
    const lists = await Promise.all(
      withSources(agentId).map(async (g) => {
        try {
          const items = await op(g.prompts, AbortSignal.any([signal, AbortSignal.timeout(listTimeout)]));
          return (Array.isArray(items) ? items : []).flatMap((x) => clean(g.slug, x) ?? []);
        } catch (err) {
          if (signal.aborted) throw err;
          deps.log.warn(`Listing a connection's ${what} failed`, { connection: g.connectionId, error: scrubText(errorMessage(err), [], 200) });
          return [];
        }
      }),
    );
    return lists.flat();
  }

  function resolve(agentId: string, slug: string): Grant & { source: ToolSource & { prompts: NonNullable<ToolSource["prompts"]> } } {
    const g = grants(agentId).find((x) => x.slug === slug);
    if (!g) throw new PassthroughError("not_found", `No connection named ${slug} is available to you`);
    const s = deps.source(g.connectionId);
    if (!s) throw new PassthroughError("unavailable", `The ${slug} connection is turned off`);
    if (!s.prompts) throw new PassthroughError("not_found", `The ${slug} connection has no prompts or resources`);
    return { ...g, source: s as ToolSource & { prompts: NonNullable<ToolSource["prompts"]> } };
  }

  async function audited<T>(agentId: string, action: "prompts/get" | "resources/read", g: Grant, detail: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const record = (outcome: "ok" | "error", reason: string | null) =>
      deps.audit({ actorType: "agent", actorId: agentId, action, target: g.connectionId, outcome, reason, durationMs: Date.now() - started, detail: { broker: true, connectionId: g.connectionId, slug: g.slug, level: g.level, ...detail } });
    try {
      const r = await run();
      record("ok", null);
      return r;
    } catch (err) {
      record("error", err instanceof SourceError ? err.code : "upstream_error");
      if (err instanceof SourceError) throw new PassthroughError("unavailable", scrubText(err.message, [], 300));
      throw new PassthroughError("unavailable", `${g.slug}: ${scrubText(errorMessage(err), [], 300)}`);
    }
  }

  return {
    listPrompts: (agentId, signal) => fanOut(agentId, signal, "prompts", (p, s) => p.listPrompts(s), cleanPrompt),
    listResources: (agentId, signal) => fanOut(agentId, signal, "resources", (p, s) => p.listResources(s), cleanResource),
    listResourceTemplates: (agentId, signal) => fanOut(agentId, signal, "resource templates", (p, s) => p.listResourceTemplates(s), cleanTemplate),

    async getPrompt(agentId, exposedName, args, signal) {
      const parts = splitExposedName(exposedName);
      if (!parts || !UPSTREAM_NAME_RE.test(parts.name)) throw new PassthroughError("not_found", `${cleanLine(exposedName, 64)} isn't a prompt you can use`);
      const g = resolve(agentId, parts.slug);
      const scrubber = makeScrubber(connectionSecrets(deps.credentials, g.connectionId));
      return audited(agentId, "prompts/get", g, { prompt: parts.name.slice(0, 128) }, async () => {
        const r = await g.source.prompts.getPrompt(parts.name, args, signal);
        const nonce = newNonce();
        const messages = (Array.isArray(r?.messages) ? r.messages : []).filter((m) => !(m?.content && (tooBig(m.content.data) || tooBig((m.content.resource as { blob?: unknown } | undefined)?.blob))));
        const description = text(r?.description, 2000);
        return { ...(description ? { description } : {}), messages: scrubDeep(messages, { slug: g.slug, scrubber, wrap: (t) => wrapResourceText(t, `${g.slug}/${parts.name}`, nonce) }, false) as PromptResult["messages"] };
      });
    },

    async readResource(agentId, uri, signal) {
      const parsed = parseResourceUri(uri);
      if (!parsed) throw new PassthroughError("invalid_params", "Not a resource URI from this server (they start with xaq://<connection>/)");
      const g = resolve(agentId, parsed.slug);
      const scrubber = makeScrubber(connectionSecrets(deps.credentials, g.connectionId));
      return audited(agentId, "resources/read", g, { resource: scrubText(parsed.uri, [], 200) }, async () => {
        const r = await g.source.prompts.readResource(parsed.uri, signal);
        const nonce = newNonce();
        const contents = (Array.isArray(r?.contents) ? r.contents : []).map((c) =>
          "blob" in c && tooBig(c.blob) ? { uri: c.uri, mimeType: "text/plain", text: `[xaq left out a binary resource over ${MAX_BINARY_BYTES / 1024 / 1024} MB]` } : c,
        );
        return { contents: scrubDeep(contents, { slug: g.slug, scrubber, wrap: (t) => wrapResourceText(t, `${g.slug}/resource`, nonce) }, true) as ResourceReadResult["contents"] };
      });
    },
  };
}
