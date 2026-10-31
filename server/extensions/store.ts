// Installed extensions: fetched and verified into a temp directory under
// <dataDir>/extensions/.tmp, then renamed into <dataDir>/extensions/<name>/<integrity-hex-prefix>/ and made read-only.
// The `extensions` table records the source, commit, integrity, version and manifest. Nothing updates on its own, and
// nothing outside <dataDir>/extensions is ever written or removed.
//
// The broker binds connections (usedBy / onRemove through setHooks); the code host runs code extensions from installDir
// (verify() before each child start) and restarts children on onChange.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AppContext } from "../context.ts";
import { bool, type Db, json, now } from "../db/index.ts";
import type { Logger } from "../util/log.ts";
import { computeIntegrity, integrityDirName, IntegrityError } from "./integrity.ts";
import { defaultExtensionUrls, type ExtensionUrls, fetchIndex, OFFICIAL_NAMES, OFFICIAL_OWNER, OFFICIAL_REPO, type RegistryEntry, type RegistryIndex } from "./registry.ts";
import { ExtensionError, type FetchDeps, fetchGit, fetchGithubTarball, fetchLocal, fetchOfficial, parseSource, resolveGithubTree, type SourceSpec } from "./sources.ts";
import { type Manifest, MANIFEST_FILE, ManifestError, validateManifest } from "./manifest.ts";
import { type ExtractLimits, UnsafeArchiveError } from "./tar.ts";

export interface InstalledExtension {
  name: string;
  kind: "remote" | "code";
  version: string;
  /** What it was installed from: a registry name, a GitHub or git URL, or an absolute directory. */
  source: string;
  /** The resolved commit; null for a local directory. */
  commit: string | null;
  /** sha256-<base64> over the canonical listing (integrity.ts). */
  integrity: string;
  /** From the official registry (wynn-dev/xaq-extensions at the indexed or pinned commit). */
  official: boolean;
  installDir: string;
  manifest: unknown /* validated by manifest.ts */;
  installedAt: string;
}

/**
 * Filled by the broker (connection binding) and the code host. `usedBy` has one owner; `onChange` and
 * `onRemove` are listener lists (setHooks adds, never replaces; ExtensionStore.onChange/onRemove take an order).
 */
export interface ExtensionHooks {
  /** Names of the connections that use the extension. Removal is refused while any do, unless forced. */
  usedBy(name: string): string[];
  /** Before a removal; with `force`, the broker disables `usedBy` (credentials stay until the connections are removed). */
  onRemove?(ext: InstalledExtension, opts: { force: boolean; usedBy: string[] }): void;
  /** After an install, update or removal (the code host stops or restarts children). */
  onChange?(change: { from: InstalledExtension | null; to: InstalledExtension | null }): void;
}

/** Listener orders for onChange/onRemove (lower runs first). */
export const LISTENER_ORDER = { presets: 0, restart: 100 } as const;

interface Listener<F> {
  fn: F;
  order: number;
  seq: number;
}

function addListener<F>(list: Listener<F>[], l: Listener<F>): () => void {
  list.push(l);
  list.sort((a, b) => a.order - b.order || a.seq - b.seq);
  return () => {
    const i = list.indexOf(l);
    if (i >= 0) list.splice(i, 1);
  };
}

const MANIFEST_MAX_BYTES = 256 * 1024;

/** What the store itself needs from a manifest. */
export interface ManifestFacts {
  name: string;
  kind: "remote" | "code";
  version: string;
  displayName: string;
  /** kind "code": the declared network hosts. */
  network: string[];
  /** kind "remote": the MCP URL, when fixed. */
  remoteUrl: string | null;
}

/**
 * The manifest, checked by validateManifest (server/extensions/manifest.ts: schema 1, unknown keys rejected).
 * `official`: from the official registry; a third-party manifest with a google auth is refused (the store checks the
 * shape first, with official: true, and again once it knows where the extension comes from).
 */
export function checkManifest(raw: unknown, opts: { official: boolean }): ManifestFacts {
  let m: Manifest;
  try {
    m = validateManifest(raw, { official: opts.official });
  } catch (err) {
    if (err instanceof ManifestError) throw new ExtensionError("invalid", err.message);
    throw err;
  }
  return {
    name: m.name,
    kind: m.kind,
    version: m.version,
    displayName: m.displayName,
    network: m.code?.network ?? [],
    remoteUrl: m.remote?.url ?? null,
  };
}

/** Facts for display (lists, warnings): the shape only. Whether an install may use a google auth is checked at install. */
export const manifestFacts = (ext: Pick<InstalledExtension, "manifest">): ManifestFacts => checkManifest(ext.manifest, { official: true });

/**
 * The warning a third-party extension gets before install: its source, kind, declared network
 * hosts, and that its code runs on this machine with network access. Empty for an official one.
 */
export function thirdPartyWarning(ext: Pick<InstalledExtension, "official" | "source" | "manifest" | "commit">): string[] {
  if (ext.official) return [];
  const f = manifestFacts(ext);
  const lines = [
    `${f.displayName} (${f.name} ${f.version}) is a third-party extension from ${ext.source}${ext.commit ? ` at ${ext.commit.slice(0, 12)}` : ""}, not from the official xaq-extensions registry. Install it only if you trust its author.`,
  ];
  if (f.kind === "code") {
    lines.push("Kind: code. This code runs on your machine with network access. Node's permission model limits its files, but not the network.");
    lines.push(f.network.length ? `Declared network hosts: ${f.network.join(", ")} (declared by the extension, not enforced).` : "Declared network hosts: none (declared by the extension, not enforced).");
  } else {
    lines.push(`Kind: remote. No code runs on your machine; xaq connects to ${f.remoteUrl ?? "the MCP server you name"}.`);
  }
  lines.push("Its risk map can make tools stricter than xaq's own rules (ask before more of them), never looser.");
  return lines;
}

interface Row {
  name: string;
  kind: string;
  version: string;
  source: string;
  commit_sha: string | null;
  integrity: string;
  manifest: string;
  official: number;
  installed_at: string;
}

export interface ExtensionStoreOptions {
  db: Db;
  dataDir: string;
  log?: Logger;
  fetch?: typeof fetch;
  urls?: Partial<ExtensionUrls>;
  /** The git binary (default "git"). */
  git?: string;
  limits?: Partial<ExtractLimits>;
  timeoutMs?: number;
  /** Tests only: allow file:// git URLs. */
  allowFileGit?: boolean;
}

/** A fetched, verified extension in a temp directory, not yet installed. */
interface Staged {
  candidate: InstalledExtension;
  /** The temp root (removed after install or on failure). */
  work: string;
  /** The extension's files. */
  dir: string;
}

const short = (c: string | null) => (c ? c.slice(0, 12) : "none");

export class ExtensionStore {
  readonly root: string;
  private readonly tmpRoot: string;
  private readonly deps: FetchDeps;
  private usedByHook: ExtensionHooks["usedBy"] = () => [];
  /** Listeners, called in `order` (then registration order); the preset reload and the code host's restarts. */
  private readonly changeListeners: Listener<NonNullable<ExtensionHooks["onChange"]>>[] = [];
  private readonly removeListeners: Listener<NonNullable<ExtensionHooks["onRemove"]>>[] = [];
  private listenerSeq = 0;
  /** One install, update or removal at a time. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ExtensionStoreOptions) {
    this.root = join(opts.dataDir, "extensions");
    this.tmpRoot = join(this.root, ".tmp");
    this.deps = {
      urls: { ...defaultExtensionUrls(), ...opts.urls },
      fetch: opts.fetch ?? fetch,
      git: opts.git ?? "git",
      limits: opts.limits,
      timeoutMs: opts.timeoutMs,
      allowFileGit: opts.allowFileGit,
    };
    try {
      this.cleanTemp();
    } catch (err) {
      opts.log?.warn("Couldn't clear old extension temp directories", { error: (err as Error).message });
    }
  }

  /**
   * `usedBy` replaces the previous one (there's one owner: the broker). `onChange` and `onRemove` are ADDED as listeners at
   * order 0, never replacing another writer's; use onChange()/onRemove() for an explicit order or to unsubscribe.
   */
  setHooks(hooks: Partial<ExtensionHooks>): void {
    if (hooks.usedBy) this.usedByHook = hooks.usedBy;
    if (hooks.onChange) this.onChange(hooks.onChange);
    if (hooks.onRemove) this.onRemove(hooks.onRemove);
  }

  /**
   * Subscribes to installs, updates and removals. Lower `order` runs first: the preset reload uses the default (0);
   * the code host restarts children at LISTENER_ORDER.restart, after it, so restarts see the new preset. A throwing
   * listener is logged and the others still run. Returns the unsubscribe.
   */
  onChange(listener: NonNullable<ExtensionHooks["onChange"]>, opts: { order?: number } = {}): () => void {
    return addListener(this.changeListeners, { fn: listener, order: opts.order ?? 0, seq: this.listenerSeq++ });
  }

  /** Before a removal (the broker disables the connections when forced). Same ordering and unsubscribe as onChange. */
  onRemove(listener: NonNullable<ExtensionHooks["onRemove"]>, opts: { order?: number } = {}): () => void {
    return addListener(this.removeListeners, { fn: listener, order: opts.order ?? 0, seq: this.listenerSeq++ });
  }

  private emitChange(change: Parameters<NonNullable<ExtensionHooks["onChange"]>>[0]): void {
    for (const l of [...this.changeListeners]) {
      try {
        l.fn(change);
      } catch (err) {
        this.opts.log?.warn("An extension change listener failed", { error: (err as Error).message });
      }
    }
  }

  usedBy(name: string): string[] {
    return this.usedByHook(name);
  }

  /** The registry index (the console's browse list). */
  registry(): Promise<RegistryIndex> {
    return this.wrap(() => fetchIndex(this.deps.urls, this.deps.fetch));
  }

  list(): InstalledExtension[] {
    return this.opts.db.all<Row>("SELECT * FROM extensions ORDER BY name").map((r) => this.fromRow(r));
  }

  get(name: string): InstalledExtension | null {
    const r = this.opts.db.get<Row>("SELECT * FROM extensions WHERE name = ?", name);
    return r ? this.fromRow(r) : null;
  }

  async resolve(source: string): Promise<{ candidate: InstalledExtension; warnings: string[] }> {
    const staged = await this.stage(source);
    this.discard(staged.work);
    return { candidate: staged.candidate, warnings: thirdPartyWarning(staged.candidate) };
  }

  install(source: string, opts: { confirmThirdParty: boolean; expectIntegrity?: string }): Promise<InstalledExtension> {
    return this.serial(async () => {
      const staged = await this.stage(source);
      try {
        const c = staged.candidate;
        if (opts.expectIntegrity && opts.expectIntegrity !== c.integrity) {
          throw new ExtensionError("changed", `${source} changed since it was shown (now ${short(c.commit)}, ${c.integrity}). Review it again.`, { candidate: c });
        }
        const existing = this.get(c.name);
        if (existing) {
          if (existing.integrity === c.integrity) return existing;
          throw new ExtensionError("already_installed", `${c.name} is already installed (${existing.version}, ${short(existing.commit)}). Use update to change it.`);
        }
        if (!c.official && !opts.confirmThirdParty) {
          const warnings = thirdPartyWarning(c);
          throw new ExtensionError("third_party_unconfirmed", `${c.name} is a third-party extension and needs your confirmation.`, { warnings, candidate: c });
        }
        const installed = this.commit(staged, null);
        this.opts.log?.info("Extension installed", { name: installed.name, version: installed.version, commit: installed.commit, official: installed.official });
        this.emitChange({ from: null, to: installed });
        return installed;
      } finally {
        this.discard(staged.work);
      }
    });
  }

  update(name: string, opts: { confirm: boolean; expectIntegrity?: string }): Promise<{ from: InstalledExtension; to: InstalledExtension } | null> {
    const go = async () => {
      const from = this.get(name);
      if (!from) throw new ExtensionError("not_found", `${name} isn't installed.`);
      const staged = await this.stage(from.source, from);
      try {
        const to = staged.candidate;
        if (to.integrity === from.integrity) return null;
        if (to.name !== from.name) throw new ExtensionError("invalid", `${from.source} is now the extension "${to.name}", not "${from.name}".`);
        // A kind change (remote ↔ code) would turn the same connections into a different thing: a new install instead.
        if (to.kind !== from.kind) throw new ExtensionError("invalid", `${from.source} is now a ${to.kind} extension, not ${from.kind}. Remove ${name} and add it again.`);
        if (!opts.confirm) return { from, to };
        if (opts.expectIntegrity && opts.expectIntegrity !== to.integrity) {
          throw new ExtensionError("changed", `${name}'s update changed since it was shown (now ${to.version}, ${short(to.commit)}). Review it again.`, { candidate: to });
        }
        const installed = this.commit(staged, from);
        this.opts.log?.info("Extension updated", { name, from: from.commit ?? from.integrity, to: installed.commit ?? installed.integrity });
        this.emitChange({ from, to: installed });
        return { from, to: installed };
      } finally {
        this.discard(staged.work);
      }
    };
    // A preview doesn't take the lock (it changes nothing).
    return opts.confirm ? this.serial(go) : go();
  }

  /** In the same queue as install and update, so a removal never races one. */
  remove(name: string, opts: { force: boolean }): Promise<void> {
    return this.serial(async () => {
      const ext = this.get(name);
      if (!ext) throw new ExtensionError("not_found", `${name} isn't installed.`);
      const usedBy = this.usedByHook(name);
      if (usedBy.length && !opts.force) {
        throw new ExtensionError("in_use", `${name} is used by ${usedBy.join(", ")}. Remove those connections first, or force it (which disables them).`, { usedBy });
      }
      for (const l of [...this.removeListeners]) l.fn(ext, { force: opts.force, usedBy });
      this.opts.db.run("DELETE FROM extensions WHERE name = ?", name);
      this.removeTree(join(this.root, name));
      this.opts.log?.info("Extension removed", { name, forced: opts.force && usedBy.length > 0 });
      this.emitChange({ from: ext, to: null });
    });
  }

  verify(name: string): boolean {
    const ext = this.get(name);
    if (!ext) return false;
    try {
      return computeIntegrity(ext.installDir) === ext.integrity;
    } catch {
      return false;
    }
  }

  /** Clears temp directories a crash left behind. Only <dataDir>/extensions/.tmp is touched. */
  cleanTemp(): void {
    if (existsSync(this.tmpRoot)) this.removeTree(this.tmpRoot);
  }

  // ── internals ──

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return this.wrap(() => next);
  }

  /** Errors from the layers below as ExtensionError. */
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ExtensionError) throw err;
      if (err instanceof UnsafeArchiveError) throw new ExtensionError("unsafe", err.message);
      if (err instanceof IntegrityError) throw new ExtensionError("unsafe", err.message);
      if (err instanceof Error && err.name === "RegistryError") throw new ExtensionError("fetch_failed", err.message);
      throw err;
    }
  }

  private fromRow(r: Row): InstalledExtension {
    return {
      name: r.name,
      kind: r.kind as InstalledExtension["kind"],
      version: r.version,
      source: r.source,
      commit: r.commit_sha,
      integrity: r.integrity,
      official: bool(r.official),
      installDir: this.installDir(r.name, r.integrity),
      manifest: json.parse<unknown>(r.manifest, null),
      installedAt: r.installed_at,
    };
  }

  private installDir(name: string, integrity: string): string {
    return join(this.root, name, integrityDirName(integrity));
  }

  /** <dataDir>/extensions and its .tmp: created owner-only, only these (the data directory already exists). */
  private ensureRoot(): void {
    for (const d of [this.root, this.tmpRoot]) if (!existsSync(d)) mkdirSync(d, { mode: 0o700 });
  }

  private newWork(): string {
    this.ensureRoot();
    const work = join(this.tmpRoot, randomBytes(8).toString("hex"));
    mkdirSync(work, { mode: 0o700 });
    return work;
  }

  /**
   * Fetches `source` into a temp directory and verifies it. `current`: the installed extension being updated (an
   * official one follows the registry index, whatever its source string says).
   */
  private stage(source: string, current?: InstalledExtension): Promise<Staged> {
    return this.wrap(async () => {
      const staged = await this.stageSource(source, current);
      if (!staged.candidate.official) {
        try {
          // Only official extensions may use a connected Google account (code.auth "google"): refused before anything
          // is shown or installed.
          checkManifest(staged.candidate.manifest, { official: false });
          await this.refuseOfficialName(staged.candidate.name);
        } catch (err) {
          this.discard(staged.work);
          throw err;
        }
      }
      return staged;
    });
  }

  /**
   * A third-party extension can't take an official extension's name: connections made with that preset would be bound
   * to it. The names: the core's official ones, plus the registry index's when it can be read.
   */
  private async refuseOfficialName(name: string): Promise<void> {
    const index = await fetchIndex(this.deps.urls, this.deps.fetch).catch(() => null);
    const official = new Set([...OFFICIAL_NAMES, ...(index?.extensions.map((e) => e.name) ?? [])]);
    if (official.has(name)) {
      throw new ExtensionError(
        "official_name",
        `"${name}" is the name of an official extension; a third-party extension can't use it. Install the official one from Extensions in the console.`,
      );
    }
  }

  private stageSource(source: string, current?: InstalledExtension): Promise<Staged> {
    return this.wrap(async () => {
      const spec: SourceSpec = current?.official
        ? { type: "registry", name: current.name }
        : parseSource(source, { absoluteOnly: true, allowFileGit: this.deps.allowFileGit });
      switch (spec.type) {
        case "registry": {
          const index = await fetchIndex(this.deps.urls, this.deps.fetch);
          const entry = index.extensions.find((e) => e.name === spec.name);
          if (!entry) {
            const names = index.extensions.map((e) => e.name);
            throw new ExtensionError("not_found", `There's no extension "${spec.name}" in the registry.${names.length ? ` It has: ${names.join(", ")}.` : ""}`);
          }
          return this.stageRegistryEntry(entry);
        }
        case "github": {
          const { commit, ref, path } = await resolveGithubTree(spec, this.deps);
          const canonical = `https://github.com/${spec.owner}/${spec.repo}${ref === "HEAD" ? "" : `/tree/${ref}${path ? `/${path}` : ""}`}`;
          const staged = await this.stageWith(canonical, false, (dest) => fetchGithubTarball(spec.owner, spec.repo, commit, path, dest, this.deps));
          // The official repository at exactly an indexed commit and integrity is the official extension.
          if (spec.owner.toLowerCase() === OFFICIAL_OWNER && spec.repo.toLowerCase() === OFFICIAL_REPO) {
            const index = await fetchIndex(this.deps.urls, this.deps.fetch).catch(() => null);
            const entry = index?.extensions.find((e) => e.name === staged.candidate.name);
            if (entry && entry.commit === commit && entry.integrity === staged.candidate.integrity && path === entry.path) {
              staged.candidate = { ...staged.candidate, official: true, source: entry.name };
            }
          }
          return staged;
        }
        case "git": {
          const canonical = `${spec.url}${spec.ref || spec.path ? `#${spec.ref ?? "HEAD"}${spec.path ? `:${spec.path}` : ""}` : ""}`;
          return this.stageWith(canonical, false, (dest, work) => fetchGit(spec, work, dest, this.deps));
        }
        case "local":
          return this.stageWith(spec.path, false, async (dest) => fetchLocal(spec.path, dest, this.deps));
      }
    });
  }

  private async stageRegistryEntry(entry: RegistryEntry): Promise<Staged> {
    const staged = await this.stageWith(entry.name, true, (dest) => fetchOfficial(entry.name, entry.commit, dest, this.deps));
    if (staged.candidate.integrity !== entry.integrity) {
      this.discard(staged.work);
      throw new ExtensionError(
        "integrity_mismatch",
        `${entry.name} at ${short(entry.commit)} has integrity ${staged.candidate.integrity}, but the registry pins ${entry.integrity}. Refusing to install it.`,
      );
    }
    return staged;
  }

  private async stageWith(source: string, official: boolean, fetchInto: (dest: string, work: string) => Promise<{ commit: string | null }>): Promise<Staged> {
    const work = this.newWork();
    try {
      const dir = join(work, "x");
      mkdirSync(dir, { mode: 0o755 });
      const { commit } = await this.wrap(() => fetchInto(dir, work));
      const manifestPath = join(dir, MANIFEST_FILE);
      if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) throw new ExtensionError("invalid", `${source} has no ${MANIFEST_FILE} at its root.`);
      if (lstatSync(manifestPath).size > MANIFEST_MAX_BYTES) throw new ExtensionError("invalid", `${MANIFEST_FILE} is too large.`);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        throw new ExtensionError("invalid", `${MANIFEST_FILE} isn't valid JSON.`);
      }
      // The shape (every auth type); a third-party candidate's google auth is refused in stage(), once its origin is known.
      const facts = checkManifest(raw, { official: true });
      const integrity = await this.wrap(async () => computeIntegrity(dir));
      if (official && source !== facts.name) throw new ExtensionError("invalid", `The registry's ${source} has a manifest named "${facts.name}".`);
      const candidate: InstalledExtension = {
        name: facts.name,
        kind: facts.kind,
        version: facts.version,
        source,
        commit,
        integrity,
        official,
        installDir: this.installDir(facts.name, integrity),
        manifest: raw,
        installedAt: now(),
      };
      return { candidate, work, dir };
    } catch (err) {
      this.discard(work);
      throw err;
    }
  }

  /** Moves the staged files into place (atomic rename), makes them read-only and records the row. */
  private commit(staged: Staged, replacing: InstalledExtension | null): InstalledExtension {
    const c = staged.candidate;
    const parent = join(this.root, c.name);
    if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
    const dest = c.installDir;
    if (existsSync(dest)) {
      // Left from an earlier install of the same content: reuse it only if it still verifies.
      let same = false;
      try {
        same = computeIntegrity(dest) === c.integrity;
      } catch {
        same = false;
      }
      if (!same) this.removeTree(dest);
    }
    if (!existsSync(dest)) renameSync(staged.dir, dest);
    makeReadOnly(dest);
    const installed = { ...c, installedAt: now() };
    this.opts.db.run(
      `INSERT INTO extensions (name, kind, version, source, commit_sha, integrity, manifest, official, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, version = excluded.version, source = excluded.source, commit_sha = excluded.commit_sha,
         integrity = excluded.integrity, manifest = excluded.manifest, official = excluded.official, installed_at = excluded.installed_at`,
      installed.name,
      installed.kind,
      installed.version,
      installed.source,
      installed.commit,
      installed.integrity,
      json.str(installed.manifest),
      installed.official ? 1 : 0,
      installed.installedAt,
    );
    if (replacing && replacing.installDir !== dest) this.removeTree(replacing.installDir);
    return installed;
  }

  private discard(work: string): void {
    try {
      this.removeTree(work);
    } catch (err) {
      this.opts.log?.warn("Couldn't remove an extension temp directory", { path: work, error: (err as Error).message });
    }
  }

  /** Removes a directory under <dataDir>/extensions (read-only files included). Refuses anything else. */
  private removeTree(path: string): void {
    const rel = relative(this.root, path);
    if (!rel || rel.startsWith("..") || rel.startsWith(sep) || rel.includes(`..${sep}`)) throw new Error(`Refusing to remove ${path}: it isn't under ${this.root}.`);
    if (!existsSync(path)) return;
    makeWritable(path);
    rmSync(path, { recursive: true, force: true });
  }
}

/** chmod -R a-w: files 0444 (0555 when executable), directories 0555. Never follows a link. */
export function makeReadOnly(dir: string): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) makeReadOnly(abs);
    else chmodSync(abs, st.mode & 0o111 ? 0o555 : 0o444);
  }
  chmodSync(dir, 0o555);
}

/** Undoes makeReadOnly for the owner, so the tree can be removed. */
function makeWritable(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory()) return;
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (lstatSync(abs).isDirectory()) makeWritable(abs);
  }
}

const stores = new WeakMap<object, ExtensionStore>();

/** The store for this context (created on first use; `opts` apply only then: tests point it at fakes). */
export function extensionStore(ctx: Pick<AppContext, "db" | "config" | "log">, opts: Partial<ExtensionStoreOptions> = {}): ExtensionStore {
  let store = stores.get(ctx);
  if (!store) {
    store = new ExtensionStore({ db: ctx.db, dataDir: ctx.config.dataDir, log: ctx.log, ...opts });
    stores.set(ctx, store);
  }
  return store;
}
