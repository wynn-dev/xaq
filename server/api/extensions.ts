// /api/extensions: install, list, update and remove extensions (docs/EXTENSIONS.md). Console session + CSRF like
// every /api router (server/app.ts). The `xaq ext` CLI uses these routes through its local admin channel.

import type { Context } from "hono";
import { z } from "zod";
import type { ExtensionErrorBody, ExtensionRegistryEntryView, ExtensionResolveResult, ExtensionUpdateResult, ExtensionView } from "../../shared/extensions.ts";
import type { AppContext } from "../context.ts";
import { INTEGRITY_RE } from "../extensions/integrity.ts";
import { ExtensionError, type ExtensionErrorCode } from "../extensions/sources.ts";
import { extensionStore, type InstalledExtension, manifestFacts, thirdPartyWarning } from "../extensions/store.ts";
import { notFound } from "../util/errors.ts";
import { ADMIN_ACTOR, type AppEnv, readBody, router } from "./util.ts";

const source = z.string().trim().min(1, "Name an extension, a GitHub URL, a git URL or a directory").max(2048);
const integrity = z.string().regex(INTEGRITY_RE, "Not a sha256-<base64> integrity");
const resolveSchema = z.object({ source }).strict();
const installSchema = z.object({ source, confirmThirdParty: z.boolean().optional(), expectIntegrity: integrity.optional() }).strict();
const updateSchema = z.object({ confirm: z.boolean().optional(), expectIntegrity: integrity.optional() }).strict();

const STATUS: Record<ExtensionErrorCode, number> = {
  not_found: 404,
  in_use: 409,
  third_party_unconfirmed: 409,
  already_installed: 409,
  changed: 409,
  integrity_mismatch: 422,
  unsafe: 422,
  invalid: 422,
  bad_source: 400,
  fetch_failed: 502,
  rate_limited: 503,
  official_name: 409,
};

const HINTS: Partial<Record<ExtensionErrorCode, string>> = {
  in_use: "Remove those connections first, or remove it with force, which disables them.",
  third_party_unconfirmed: "Review the warning, then confirm.",
  changed: "Review it again before confirming.",
  integrity_mismatch: "The files don't match the pinned integrity. Nothing was installed.",
};

/**
 * usedBy for people: B2's hook returns connection ids; show each connection's slug (what the CLI and agents use).
 * Anything that isn't a connection id is shown as it is.
 */
export function connectionLabels(ctx: Pick<AppContext, "db">, usedBy: string[]): string[] {
  return usedBy.map((id) => ctx.db.get<{ slug: string }>("SELECT slug FROM connections WHERE id = ?", id)?.slug ?? id);
}

export function extensionView(ctx: AppContext, ext: InstalledExtension, usedBy?: string[]): ExtensionView {
  let displayName = ext.name;
  let network: string[] = [];
  try {
    const f = manifestFacts(ext);
    displayName = f.displayName;
    network = f.network;
  } catch {
    // A row from an older manifest check: show what the row has.
  }
  const m = ext.manifest as { description?: unknown } | null;
  return {
    name: ext.name,
    displayName,
    description: typeof m?.description === "string" ? m.description : "",
    kind: ext.kind,
    version: ext.version,
    source: ext.source,
    commit: ext.commit,
    integrity: ext.integrity,
    official: ext.official,
    network,
    usedBy: connectionLabels(ctx, usedBy ?? extensionStore(ctx).usedBy(ext.name)),
    installedAt: ext.installedAt,
  };
}

/** Runs `fn`, answering an ExtensionError with its status and, for 409s, what the caller needs to decide. */
async function handled(c: Context<AppEnv>, ctx: AppContext, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ExtensionError)) throw err;
    let message = err.message;
    let usedBy: string[] | undefined;
    if (err.detail?.usedBy) {
      usedBy = connectionLabels(ctx, err.detail.usedBy);
      message = message.replace(err.detail.usedBy.join(", "), usedBy.join(", "));
    }
    const body: ExtensionErrorBody = { error: { code: err.code, message, ...(HINTS[err.code] ? { hint: HINTS[err.code] } : {}) } };
    if (usedBy) body.usedBy = usedBy;
    if (err.detail?.warnings) body.warnings = err.detail.warnings;
    if (err.detail?.candidate) body.candidate = extensionView(ctx, err.detail.candidate, []);
    return c.json(body, STATUS[err.code] as 400);
  }
}

export function extensionsApi(ctx: AppContext) {
  const r = router();
  const store = () => extensionStore(ctx);
  const audit = (action: string, target: string, detail: Record<string, unknown>) =>
    ctx.audit.record({ ...ADMIN_ACTOR, action, target, outcome: "ok", detail });

  r.get("/extensions", (c) => c.json<ExtensionView[]>(store().list().map((e) => extensionView(ctx, e))));

  r.get("/extensions/registry", (c) =>
    handled(c, ctx, async () => {
      const index = await store().registry();
      const installed = new Map(store().list().map((e) => [e.name, e]));
      return c.json<ExtensionRegistryEntryView[]>(
        index.extensions.map((e) => {
          const i = installed.get(e.name);
          return {
            name: e.name,
            displayName: e.displayName,
            description: e.description,
            kind: e.kind,
            version: e.version,
            commit: e.commit,
            integrity: e.integrity,
            installed: i ? { version: i.version, integrity: i.integrity, official: i.official } : null,
          };
        }),
      );
    }),
  );

  r.post("/extensions/resolve", async (c) => {
    const body = await readBody(c, resolveSchema);
    return handled(c, ctx, async () => {
      const { candidate, warnings } = await store().resolve(body.source);
      const installed = store().get(candidate.name);
      return c.json<ExtensionResolveResult>({ candidate: extensionView(ctx, candidate, []), warnings, installed: installed ? extensionView(ctx, installed) : null });
    });
  });

  r.post("/extensions", async (c) => {
    const body = await readBody(c, installSchema);
    return handled(c, ctx, async () => {
      const ext = await store().install(body.source, { confirmThirdParty: !!body.confirmThirdParty, expectIntegrity: body.expectIntegrity });
      audit("extension.install", ext.name, { source: ext.source, version: ext.version, commit: ext.commit, integrity: ext.integrity, official: ext.official });
      return c.json<ExtensionView>(extensionView(ctx, ext));
    });
  });

  r.get("/extensions/:name", (c) => {
    const ext = store().get(c.req.param("name"));
    if (!ext) throw notFound("Extension");
    return c.json<ExtensionView>(extensionView(ctx, ext));
  });

  r.post("/extensions/:name/update", async (c) => {
    const body = await readBody(c, updateSchema);
    const name = c.req.param("name");
    return handled(c, ctx, async () => {
      const result = await store().update(name, { confirm: !!body.confirm, expectIntegrity: body.expectIntegrity });
      if (!result) return c.json<ExtensionUpdateResult>({ update: null, installed: false });
      if (body.confirm) {
        audit("extension.update", name, {
          from: { version: result.from.version, commit: result.from.commit, integrity: result.from.integrity },
          to: { version: result.to.version, commit: result.to.commit, integrity: result.to.integrity },
        });
      }
      const usedBy = store().usedBy(name);
      return c.json<ExtensionUpdateResult>({
        update: { from: extensionView(ctx, result.from, usedBy), to: extensionView(ctx, result.to, usedBy), warnings: thirdPartyWarning(result.to) },
        installed: !!body.confirm,
      });
    });
  });

  r.post("/extensions/:name/verify", (c) => {
    const name = c.req.param("name");
    if (!store().get(name)) throw notFound("Extension");
    return c.json({ ok: store().verify(name) });
  });

  r.delete("/extensions/:name", (c) => {
    const name = c.req.param("name");
    const force = c.req.query("force") === "true" || c.req.query("force") === "1";
    return handled(c, ctx, async () => {
      const usedBy = store().usedBy(name);
      await store().remove(name, { force });
      audit("extension.remove", name, { force, usedBy: connectionLabels(ctx, usedBy) });
      return c.body(null, 204);
    });
  });

  return r;
}
