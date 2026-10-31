// `"code.auth": { "type": "google" }` in the extension manifest (docs/EXTENSIONS.md "Google accounts for code
// extensions"): accepted for official extensions only, never with a Gmail, Calendar, Pub/Sub or Cloud scope, checked
// the same by the validator and the JSON Schema the extensions repo copies; refused at install for a third-party
// source; and core's four Google setup steps, with {{projectId}} kept to google manifests.

import { Ajv2020 } from "ajv/dist/2020.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SetupContext } from "../server/broker/types.ts";
import { Db } from "../server/db/index.ts";
import { MANIFEST_JSON_SCHEMA, presetFromManifest, presetFromValidManifest, renderSetup, validateManifest } from "../server/extensions/manifest.ts";
import { OFFICIAL_NAMES } from "../server/extensions/registry.ts";
import { ExtensionError, SqliteExtensionStore } from "../server/extensions/store.ts";
import { CALENDAR_EVENTS_SCOPE, GMAIL_SCOPE, WORKSPACE_SCOPES } from "../server/google/scopes.ts";
import { fixtureExtension } from "./extension-fixtures.ts";
import { googleManifest, WORKSPACE_APIS } from "./google-extension-fixtures.ts";

const G = "https://www.googleapis.com/auth/";
const ajv = new Ajv2020({ allErrors: true });
const schemaValid = ajv.compile(MANIFEST_JSON_SCHEMA);

const withScopes = (scopes: unknown) => {
  const m = googleManifest();
  (m.code as { auth: { scopes: unknown } }).auth.scopes = scopes;
  return m;
};
const withAuth = (auth: unknown) => {
  const m = googleManifest();
  (m.code as { auth: unknown }).auth = auth;
  return m;
};

const CTX: SetupContext = {
  publicUrl: "https://xaq.example",
  redirectUri: "https://xaq.example/oauth/connections/callback",
  google: {
    projectId: "my-project-123",
    appType: "external",
    accounts: [
      { id: "acc_1", email: "wynn@example.com", needsReauth: false, scopes: [GMAIL_SCOPE] },
      { id: "acc_2", email: "ops@example.com", needsReauth: false, scopes: [GMAIL_SCOPE, ...WORKSPACE_SCOPES] },
      { id: "acc_3", email: "old@example.com", needsReauth: true, scopes: [GMAIL_SCOPE] },
    ],
  },
};

describe("manifest validation: code.auth google", () => {
  it("is accepted for an official extension, as the lead settled it (validator and schema agree)", () => {
    const m = googleManifest();
    expect(validateManifest(m, { official: true })).toEqual(m);
    expect(schemaValid(m), JSON.stringify(schemaValid.errors)).toBe(true);
    expect(WORKSPACE_SCOPES).toEqual((m.code as { auth: { scopes: string[] } }).auth.scopes);
  });

  it("is refused for a third-party extension (the default), before its scopes are even read", () => {
    expect(() => validateManifest(googleManifest())).toThrow(/only for official extensions/);
    expect(() => validateManifest(googleManifest(), { official: false })).toThrow(/only for official extensions/);
    expect(() => validateManifest(withScopes([GMAIL_SCOPE]))).toThrow(/only for official extensions/);
    // A store row that somehow holds a third-party google manifest offers no preset either.
    const ext = { ...fixtureExtension("notion"), name: "google-workspace", kind: "code" as const, official: false, manifest: googleManifest() };
    expect(() => presetFromManifest(ext)).toThrow(/only for official extensions/);
    expect(presetFromManifest({ ...ext, official: true }).auth).toMatchObject({ type: "google", scopes: WORKSPACE_SCOPES });
  });

  it("refuses Gmail, Calendar, Pub/Sub and Cloud scopes, and anything not a googleapis auth URL", () => {
    const bad = [
      GMAIL_SCOPE,
      `${G}gmail.readonly`,
      `${G}gmail.send`,
      `${G}gmail.metadata`,
      "https://mail.google.com/",
      CALENDAR_EVENTS_SCOPE,
      `${G}calendar`,
      `${G}calendar.readonly`,
      `${G}calendar.events.freebusy`,
      `${G}pubsub`,
      `${G}cloud-platform`,
      `${G}cloud-platform.read-only`,
      "openid",
      "email",
      "https://example.com/auth/drive",
      `http://www.googleapis.com/auth/drive`,
      `${G}Drive`,
      `${G}drive extra`,
      `${G}`,
    ];
    for (const scope of bad) {
      const m = withScopes([`${G}documents`, scope]);
      expect(() => validateManifest(m, { official: true }), scope).toThrow(/code\.auth\.scopes\[1\]/);
      expect(schemaValid(m), scope).toBe(false);
    }
    // Legit Workspace scopes, including ones that only start like a forbidden word.
    for (const scope of [`${G}drive`, `${G}drive.metadata.readonly`, `${G}documents.readonly`, `${G}tasks`, `${G}contacts.readonly`]) {
      const m = withScopes([scope]);
      expect(() => validateManifest(m, { official: true }), scope).not.toThrow();
      expect(schemaValid(m), scope).toBe(true);
    }
  });

  it("checks the scopes and apis lists strictly", () => {
    const cases: [unknown, RegExp][] = [
      [withScopes([]), /at least one scope/],
      [withScopes([`${G}documents`, `${G}documents`]), /duplicates/],
      [withScopes(`${G}documents`), /must be an array/],
      [withAuth({ type: "google", scopes: [`${G}documents`] }), /missing "apis"/],
      [withAuth({ type: "google", scopes: [`${G}documents`], apis: [], tokenUrl: "https://x.example/token" }), /unknown key "tokenUrl"/],
      [withAuth({ type: "google", scopes: [`${G}documents`], apis: [{ service: "docs.example.com", label: "Docs" }] }), /apis\[0\]\.service/],
      [withAuth({ type: "google", scopes: [`${G}documents`], apis: [{ service: "docs.googleapis.com", label: "{{publicUrl}}" }] }), /can't use \{\{ \}\}/],
      [withAuth({ type: "google", scopes: [`${G}documents`], apis: [WORKSPACE_APIS[0], WORKSPACE_APIS[0]] }), /names a service twice/],
      [withAuth({ type: "google", scopes: [`${G}documents`], apis: [{ service: "docs.googleapis.com" }] }), /missing "label"/],
    ];
    for (const [m, why] of cases) {
      expect(() => validateManifest(m, { official: true }), String(why)).toThrow(why);
      expect(schemaValid(m), String(why)).toBe(false);
    }
  });

  it("allows {{projectId}} only in a google manifest's steps, and never at the start of a link", () => {
    const step = { id: "drive", title: "Drive for {{projectId}}", body: "Open it.", link: { label: "Open", url: "https://console.cloud.google.com/apis/credentials?project={{projectId}}" } };
    expect(() => validateManifest(googleManifest({ setup: [step] }), { official: true })).not.toThrow();
    // Another kind of manifest: {{projectId}} is an unknown variable.
    const remote = { schema: 1, name: "demo", displayName: "Demo", version: "1.0.0", description: "d", kind: "remote", slug: "demo", remote: { url: "https://mcp.demo.example/mcp", auth: { type: "none" } }, setup: [step] };
    expect(() => validateManifest(remote)).toThrow(/only an extension with "code.auth": \{ "type": "google" \} can use/);
    for (const url of ["{{projectId}}/x", "https://{{projectId}}.evil.example/"]) {
      const m = googleManifest({ setup: [{ ...step, link: { label: "Open", url } }] });
      expect(() => validateManifest(m, { official: true }), url).toThrow(/setup\[0\]\.link\.url/);
    }
    // xaq's own steps own the google- prefix.
    expect(() => validateManifest(googleManifest({ setup: [{ ...step, id: "google-apis" }] }), { official: true })).toThrow(/can't start with "google-"/);
    // Filled in from the install, encoded inside a link.
    const [filled] = renderSetup([step], { ...CTX, google: { ...CTX.google!, projectId: "my-project-123" } });
    expect(filled).toMatchObject({ title: "Drive for my-project-123", link: { url: "https://console.cloud.google.com/apis/credentials?project=my-project-123" } });
    const [unknown] = renderSetup([step], { ...CTX, google: null });
    expect(unknown!.title).toBe("Drive for YOUR_PROJECT_ID");
  });
});

describe("the setup view: core's Google steps", () => {
  const preset = () => presetFromValidManifest(validateManifest(googleManifest(), { official: true }), null, { official: true });

  it("leads with pick the account, enable the APIs (links, gcloud, Check again), consent and done", () => {
    const steps = preset().setupSteps(CTX);
    expect(steps.map((s) => s.id)).toEqual(["google-account", "google-apis", "google-consent", "google-done"]);
    const [account, apis, consent, done] = steps;
    expect(account!.input).toMatchObject({ key: "google_account", label: "Google account" });
    expect(account!.input!.choices).toEqual([
      { value: "wynn@example.com", label: "wynn@example.com" },
      { value: "ops@example.com", label: "ops@example.com", note: "already has this access" },
      { value: "old@example.com", label: "old@example.com", disabled: true, note: "needs reconnecting on the Accounts page first" },
    ]);
    expect(account!.link).toEqual({ label: "Add a Google account", url: "https://xaq.example/accounts" });
    expect(apis!.apis).toEqual(WORKSPACE_APIS.map((a) => ({ ...a, url: `https://console.cloud.google.com/apis/library/${a.service}?project=my-project-123` })));
    expect(apis!.copy).toEqual({
      label: "Or run this (Cloud Shell or gcloud)",
      value: "gcloud services enable docs.googleapis.com sheets.googleapis.com slides.googleapis.com drive.googleapis.com --project=my-project-123",
    });
    expect(apis!.check).toBe("google_apis");
    expect(consent!.body).toContain("see and download all your Google Drive files");
    expect(consent!.body).toContain("Tick every box");
    expect(consent!.body).toContain("Google hasn't verified this app");
    expect(done!.link).toEqual({ label: "Google account permissions", url: "https://myaccount.google.com/permissions" });
    expect(done!.body).toContain("doesn't take that access back");
  });

  it("an Internal app gets no unverified-app warning; no project ID means no gcloud command and a plain hint; no accounts says so", () => {
    const steps = preset().setupSteps({ ...CTX, google: { projectId: null, appType: "internal", accounts: [] } });
    expect(steps[0]!.body).toContain("No Google account is connected to xaq yet");
    expect(steps[0]!.input!.choices).toEqual([]);
    expect(steps[1]!.copy).toBeUndefined();
    expect(steps[1]!.apis![0]!.url).toBe("https://console.cloud.google.com/apis/library/docs.googleapis.com");
    expect(steps[1]!.body).toContain("doesn't know your project ID yet");
    expect(steps[2]!.body).not.toContain("hasn't verified");
  });
});

describe("install: a third-party google extension is refused", () => {
  const dirs: string[] = [];
  const stores: SqliteExtensionStore[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.cleanTemp();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("from a local directory (third-party): resolve and install both refuse it, and nothing is installed", async () => {
    const work = mkdtempSync(join(tmpdir(), "xaq-gext-"));
    dirs.push(work);
    const src = join(work, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(join(src, "xaq-extension.json"), JSON.stringify(googleManifest({ name: "my-docs", slug: "my-docs" })));
    writeFileSync(join(src, "dist", "server.mjs"), "export {};\n");
    const db = new Db(join(work, "x.db"));
    const store = new SqliteExtensionStore({
      db,
      dataDir: work,
      fetch: (async () => {
        throw new Error("no network in tests");
      }) as typeof fetch,
    });
    stores.push(store);
    for (const run of [() => store.resolve(src), () => store.install(src, { confirmThirdParty: true })]) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExtensionError);
      expect((err as ExtensionError).code).toBe("invalid");
      expect((err as Error).message).toMatch(/only for official extensions/);
    }
    expect(store.list()).toEqual([]);
    // The name is reserved too: a third-party extension can't take "google-workspace", even offline.
    const squat = join(work, "squat");
    mkdirSync(squat);
    writeFileSync(
      join(squat, "xaq-extension.json"),
      JSON.stringify({ schema: 1, name: "google-workspace", displayName: "GW", version: "1.0.0", description: "d", kind: "remote", slug: "gw", remote: { url: "https://mcp.gw.example/mcp", auth: { type: "none" } } }),
    );
    const err = await store.install(squat, { confirmThirdParty: true }).catch((e: unknown) => e);
    expect((err as ExtensionError).code).toBe("official_name");
    expect(OFFICIAL_NAMES).toContain("google-workspace");
    db.close();
  });
});
