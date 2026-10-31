// Where an extension comes from (docs/EXTENSIONS.md, "Sources, pinning and the registry"): a registry name, a GitHub
// URL (the codeload tarball of the resolved commit), any other git URL (the git CLI), or a local directory. Each
// fetch lands in a fresh directory the caller owns; nothing else on disk is touched.

import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { InstalledExtension } from "./store.ts";
import { COMMIT_RE, EXTENSION_NAME_RE, type ExtensionUrls, OFFICIAL_OWNER, OFFICIAL_REPO } from "./registry.ts";
import { bufferChunks, DEFAULT_LIMITS, type ExtractLimits, gunzipChunks, readTar, UnsafeArchiveError, writeFiles } from "./tar.ts";

export type SourceSpec =
  | { type: "registry"; name: string }
  | { type: "github"; owner: string; repo: string; /** Segments after /tree/: the ref, then the path (split when resolved). */ tree: string[] }
  | { type: "git"; url: string; ref: string | null; path: string }
  | { type: "local"; path: string };

export type ExtensionErrorCode =
  | "not_found"
  | "in_use"
  | "third_party_unconfirmed"
  | "integrity_mismatch"
  | "already_installed"
  | "changed"
  | "invalid"
  | "bad_source"
  | "fetch_failed"
  | "rate_limited"
  | "unsafe"
  | "official_name";

export class ExtensionError extends Error {
  constructor(
    readonly code: ExtensionErrorCode,
    message: string,
    readonly detail?: { usedBy?: string[]; warnings?: string[]; candidate?: InstalledExtension },
  ) {
    super(message);
    this.name = "ExtensionError";
  }
}

const GITHUB_PART = /^[A-Za-z0-9._-]{1,100}$/;
const validGithubPart = (p: string) => GITHUB_PART.test(p) && p !== "." && p !== "..";
const GIT_REF = /^[A-Za-z0-9._/-]{1,200}$/;
const GIT_URL = /^(?:(?:https|ssh|file):\/\/\S+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S+)$/;

export const ABSOLUTE_PATH_MESSAGE = "Use an absolute path to a directory on xaq's machine.";

export interface ParseOptions {
  /** Where a relative path is resolved (the CLI's cwd). */
  cwd?: string;
  /** The daemon's side: relative and `~` paths are refused (its cwd and HOME aren't the user's). */
  absoluteOnly?: boolean;
  /** Tests only: `file://` git URLs. */
  allowFileGit?: boolean;
}

/** Credentials in a URL would end up in `source`, the console and the audit log: refused. */
function refuseUserinfo(s: string): void {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return;
  }
  // ssh://git@host/… names the ssh user, not a secret; anything with a password, or a user on https, is refused.
  if (u.password || (u.username && u.protocol !== "ssh:")) {
    throw new ExtensionError("bad_source", "Don't put credentials in the URL: xaq would store and show them. Use a URL without user:password@.");
  }
}

/**
 * Parses what the user typed. A bare `[a-z0-9-]` word is a registry name; a path must look like one (`./x`, `../x`,
 * `/x`, `~/x`). Other git URLs take `#<ref>` and `#<ref>:<path>` (a colon can't appear in a git ref).
 */
export function parseSource(source: string, opts: ParseOptions = {}): SourceSpec {
  const s = source.trim();
  if (!s) throw new ExtensionError("bad_source", "Name an extension, a GitHub URL, a git URL or a directory.");
  if (EXTENSION_NAME_RE.test(s)) return { type: "registry", name: s };
  if (s === "." || s === ".." || s.startsWith("./") || s.startsWith("../") || s.startsWith("/") || s === "~" || s.startsWith("~/")) {
    if (opts.absoluteOnly && !s.startsWith("/")) throw new ExtensionError("bad_source", ABSOLUTE_PATH_MESSAGE);
    const expanded = s === "~" || s.startsWith("~/") ? join(homedir(), s.slice(1)) : s;
    return { type: "local", path: isAbsolute(expanded) ? resolve(expanded) : resolve(opts.cwd ?? process.cwd(), expanded) };
  }
  refuseUserinfo(s.split("#")[0]!);
  if (/^(?:http|git):\/\//i.test(s)) {
    throw new ExtensionError("bad_source", `${s.slice(0, s.indexOf(":"))}:// isn't allowed: it isn't encrypted or authenticated. Use an https:// or ssh URL.`);
  }
  if (/^file:\/\//i.test(s) && !opts.allowFileGit) throw new ExtensionError("bad_source", "file:// git URLs aren't allowed. For a directory on xaq's machine, give its absolute path.");
  const gh = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?(?:\/tree\/([^#?]+?))?\/?$/.exec(s);
  if (gh) {
    const [, owner, repo, tree] = gh;
    if (!validGithubPart(owner!) || !validGithubPart(repo!)) throw new ExtensionError("bad_source", `"${s}" isn't a GitHub repository URL.`);
    let segs: string[];
    try {
      segs = tree ? tree.split("/").filter(Boolean).map(decodeURIComponent) : [];
    } catch {
      throw new ExtensionError("bad_source", `"${s}" has a badly encoded path.`);
    }
    if (segs.some((p) => p === ".." || p === "." || p.includes("\\"))) throw new ExtensionError("bad_source", `"${s}" has a bad path.`);
    return { type: "github", owner: owner!, repo: repo!, tree: segs };
  }
  if (/^https?:\/\/(?:www\.)?github\.com\//.test(s)) {
    throw new ExtensionError("bad_source", `Use a GitHub URL like https://github.com/<owner>/<repo> or https://github.com/<owner>/<repo>/tree/<ref>/<path>.`);
  }
  const hash = s.indexOf("#");
  const url = hash === -1 ? s : s.slice(0, hash);
  if (GIT_URL.test(url) && !url.startsWith("-")) {
    const frag = hash === -1 ? "" : s.slice(hash + 1);
    const colon = frag.indexOf(":");
    const ref = (colon === -1 ? frag : frag.slice(0, colon)) || null;
    const path = colon === -1 ? "" : frag.slice(colon + 1).replace(/^\/+|\/+$/g, "");
    if (ref && (!GIT_REF.test(ref) || ref.startsWith("-") || ref.includes(".."))) throw new ExtensionError("bad_source", `"${ref}" isn't a git ref xaq accepts.`);
    if (path.split("/").some((p) => p === ".." || p.includes("\\"))) throw new ExtensionError("bad_source", `"${path}" isn't a path inside the repository.`);
    return { type: "git", url, ref, path };
  }
  throw new ExtensionError("bad_source", `"${s}" isn't an extension name, a GitHub URL, a git URL or a directory (write a directory as ./${s}).`);
}

export interface FetchDeps {
  urls: ExtensionUrls;
  fetch: typeof fetch;
  /** The git binary. */
  git: string;
  limits?: Partial<ExtractLimits>;
  /** Network and git timeout, ms. */
  timeoutMs?: number;
  /** Tests only: allow file:// git URLs. */
  allowFileGit?: boolean;
}

export interface Fetched {
  /** The commit the files came from; null for a local directory. */
  commit: string | null;
}

const MAX_TARBALL = 64 * 1024 * 1024;
const UA = "xaq-extensions";

/** Reads a response body, refusing more than `max` bytes. */
async function readCapped(res: Response, max: number, what: string): Promise<Buffer> {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > max) {
    await res.body?.cancel().catch(() => {});
    throw new UnsafeArchiveError(`${what} is larger than ${Math.round(max / 1024 / 1024)} MB.`);
  }
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body ?? []) {
    total += (chunk as Uint8Array).length;
    if (total > max) throw new UnsafeArchiveError(`${what} is larger than ${Math.round(max / 1024 / 1024)} MB.`);
    parts.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(parts);
}

/** GitHub's unauthenticated limit is 60 API requests an hour per address: say so plainly. */
function rateLimitError(res: Response): ExtensionError | null {
  if ((res.status === 403 || res.status === 429) && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))) {
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? "0");
    const retry = Number(res.headers.get("retry-after") ?? "0");
    const when = reset ? `after ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : retry ? `in ${Math.ceil(retry / 60)} min` : "in a while";
    return new ExtensionError("rate_limited", `GitHub's API rate limit for this address is used up (60 requests an hour without a GitHub sign-in). Try again ${when}.`);
  }
  return null;
}

async function githubGet(url: string, deps: FetchDeps, accept: string): Promise<Response> {
  try {
    return await deps.fetch(url, { headers: { accept, "user-agent": UA }, signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000) });
  } catch (err) {
    throw new ExtensionError("fetch_failed", `Couldn't reach GitHub (${new URL(url).host}): ${(err as Error).message}`);
  }
}

/** The commit a ref names (a 40-hex sha is taken as is), or null when GitHub doesn't know the ref. */
async function resolveGithubRef(owner: string, repo: string, ref: string, deps: FetchDeps): Promise<string | null> {
  if (COMMIT_RE.test(ref)) return ref;
  const url = `${deps.urls.githubApi}/repos/${owner}/${repo}/commits/${ref.split("/").map(encodeURIComponent).join("/")}`;
  const res = await githubGet(url, deps, "application/vnd.github.sha");
  const limited = rateLimitError(res);
  if (limited) throw limited;
  const text = (await res.text()).trim();
  if (res.status === 404 || res.status === 422) return null;
  if (!res.ok) throw new ExtensionError("fetch_failed", `GitHub answered HTTP ${res.status} resolving ${owner}/${repo}@${ref}.`);
  if (!COMMIT_RE.test(text)) throw new ExtensionError("fetch_failed", `GitHub didn't return a commit for ${owner}/${repo}@${ref}.`);
  return text;
}

/**
 * Splits `/tree/<ref>/<path>` (a ref may contain slashes) by asking GitHub for the shortest prefix that's a ref. With
 * no tree, the default branch (HEAD) and the repository root.
 */
export async function resolveGithubTree(spec: Extract<SourceSpec, { type: "github" }>, deps: FetchDeps): Promise<{ commit: string; ref: string; path: string }> {
  if (!spec.tree.length) {
    const commit = await resolveGithubRef(spec.owner, spec.repo, "HEAD", deps);
    if (!commit) throw new ExtensionError("not_found", `GitHub has no repository ${spec.owner}/${spec.repo} (or it's private).`);
    return { commit, ref: "HEAD", path: "" };
  }
  for (let i = 1; i <= spec.tree.length; i++) {
    const ref = spec.tree.slice(0, i).join("/");
    const commit = await resolveGithubRef(spec.owner, spec.repo, ref, deps);
    if (commit) return { commit, ref, path: spec.tree.slice(i).join("/") };
  }
  throw new ExtensionError("not_found", `GitHub has no branch, tag or commit "${spec.tree.join("/")}" in ${spec.owner}/${spec.repo} (or the repository is private).`);
}

/** Downloads the codeload tarball of `owner/repo` at `commit` and writes the files under `path` into `dest`. */
export async function fetchGithubTarball(owner: string, repo: string, commit: string, path: string, dest: string, deps: FetchDeps): Promise<Fetched> {
  if (!COMMIT_RE.test(commit)) throw new ExtensionError("bad_source", `"${commit}" isn't a commit.`);
  const url = `${deps.urls.codeload}/${owner}/${repo}/tar.gz/${commit}`;
  const res = await githubGet(url, deps, "application/x-gzip");
  const limited = rateLimitError(res);
  if (limited) throw limited;
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    throw new ExtensionError("not_found", `GitHub has no commit ${commit.slice(0, 12)} in ${owner}/${repo}.`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ExtensionError("fetch_failed", `GitHub answered HTTP ${res.status} for the ${owner}/${repo} tarball.`);
  }
  const data = await readCapped(res, MAX_TARBALL, "The tarball");
  let files;
  try {
    files = await readTar(gunzipChunks(data), { strip: 1, subpath: path, limits: deps.limits });
  } catch (err) {
    if (err instanceof UnsafeArchiveError) throw err;
    throw new UnsafeArchiveError(`The tarball couldn't be read: ${(err as Error).message}`);
  }
  writeFiles(dest, files);
  return { commit };
}

/** The official repository at `commit`, the extension at `extensions/<name>`. */
export function fetchOfficial(name: string, commit: string, dest: string, deps: FetchDeps): Promise<Fetched> {
  return fetchGithubTarball(OFFICIAL_OWNER, OFFICIAL_REPO, commit, `extensions/${name}`, dest, deps);
}

/**
 * git's environment, built from scratch: nothing of xaq's (XAQ_MASTER_KEY and the rest never reach git or its
 * helpers), a throwaway HOME, no global or system config, no prompts (a private repo fails instead of hanging).
 */
export function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    LANG: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
  };
}

function run(file: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer?: number }): Promise<Buffer> {
  return new Promise((ok, fail) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: opts.maxBuffer ?? 1024 * 1024,
        encoding: "buffer",
        env: opts.env,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr as Buffer | undefined)?.toString("utf8").trim().split("\n").slice(-3).join(" ") || err.message;
          fail(new ExtensionError("fetch_failed", (err as { killed?: boolean }).killed ? `git timed out (${Math.round(opts.timeoutMs / 1000)} s).` : `git failed: ${msg}`));
        } else ok(stdout as Buffer);
      },
    );
  });
}

/**
 * Any other git URL, through the git CLI: argv only, a timeout, no hooks, no `ext::` transport. Shallow-fetches the
 * ref into a bare repository under `work` (never checked out) and reads the extension with `git archive`, through the
 * same tar checks as a tarball.
 */
export async function fetchGit(spec: Extract<SourceSpec, { type: "git" }>, work: string, dest: string, deps: FetchDeps): Promise<Fetched> {
  const timeoutMs = deps.timeoutMs ?? 120_000;
  if (/^file:/i.test(spec.url) && !deps.allowFileGit) throw new ExtensionError("bad_source", "file:// git URLs aren't allowed.");
  const repo = join(work, "repo.git");
  const home = join(work, "home");
  mkdirSync(home, { mode: 0o700 });
  const env = gitEnv(home);
  const safe = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "init.templateDir=",
    // Only https and ssh (file:// for tests): no ext::, git://, http:// or anything a config could add.
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "protocol.ssh.allow=always",
    ...(deps.allowFileGit ? ["-c", "protocol.file.allow=always"] : []),
  ];
  await run(deps.git, [...safe, "init", "-q", "--bare", repo], { env, timeoutMs });
  await run(deps.git, [...safe, "-C", repo, "fetch", "-q", "--depth", "1", "--no-tags", "--", spec.url, spec.ref ?? "HEAD"], { env, timeoutMs });
  const commit = (await run(deps.git, [...safe, "-C", repo, "rev-parse", "--verify", "FETCH_HEAD^{commit}"], { env, timeoutMs })).toString("utf8").trim();
  if (!COMMIT_RE.test(commit)) throw new ExtensionError("fetch_failed", "git didn't report a commit for the fetched ref.");
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const tar = await run(deps.git, [...safe, "-C", repo, "archive", "--format=tar", commit, ...(spec.path ? ["--", spec.path] : [])], {
    env,
    timeoutMs,
    maxBuffer: limits.maxArchiveBytes,
  }).catch((err: Error) => {
    throw /maxBuffer/i.test(err.message) ? new UnsafeArchiveError("The repository archive is too large.") : err;
  });
  writeFiles(dest, await readTar(bufferChunks(tar), { strip: 0, subpath: spec.path, limits: deps.limits }));
  return { commit };
}

/**
 * A local directory (development and tests): copied file by file with the same caps, refusing symlinks and anything
 * that isn't a file. A `.git` directory isn't copied (it isn't part of the extension).
 */
export function fetchLocal(dir: string, dest: string, deps: Pick<FetchDeps, "limits">): Fetched {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw new ExtensionError("not_found", `There's no directory ${dir}.`);
  }
  if (!st.isDirectory()) throw new ExtensionError("bad_source", `${dir} isn't a directory.`);
  let files = 0;
  let bytes = 0;
  const copy = (from: string, to: string, rel: string) => {
    for (const name of readdirSync(from)) {
      if (!rel && name === ".git") continue;
      const abs = join(from, name);
      const path = rel ? `${rel}/${name}` : name;
      const s = lstatSync(abs);
      if (s.isSymbolicLink()) throw new UnsafeArchiveError(`${path} is a symlink; extensions can't contain links.`);
      if (s.isDirectory()) {
        mkdirSync(join(to, name), { mode: 0o755 });
        copy(abs, join(to, name), path);
      } else if (s.isFile()) {
        if (++files > limits.maxFiles) throw new UnsafeArchiveError(`The extension has more than ${limits.maxFiles} files.`);
        bytes += s.size;
        if (bytes > limits.maxBytes) throw new UnsafeArchiveError(`The extension is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`);
        const exec = (s.mode & 0o111) !== 0;
        writeFileSync(join(to, name), readFileSync(abs), { mode: exec ? 0o755 : 0o644, flag: "wx" });
        chmodSync(join(to, name), exec ? 0o755 : 0o644);
      } else throw new UnsafeArchiveError(`${path} isn't a regular file or a directory.`);
    }
  };
  copy(dir, dest, "");
  if (!files) throw new ExtensionError("bad_source", `${dir} is empty.`);
  return { commit: null };
}
