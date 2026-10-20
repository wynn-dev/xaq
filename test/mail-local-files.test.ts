// Attaching files by path: the security boundary (server/mail/local-files.ts). Off by default; only inside the
// owner's attachment directories after resolving symlinks and ".."; never xaq's own directories or secret-looking
// names; regular files only; the opened file must be the one checked (swaps between check and open are caught);
// errors never carry file contents. Plus the attachmentDirs setting and its CLI.

import { execFileSync } from "node:child_process";
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Never look at the real ~/.xaq or ~/.config: xaq's own directories are derived from HOME and XDG_*.
const HOME = mkdtempSync(join(tmpdir(), "xaq-home-"));
process.env.HOME = HOME;
for (const v of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) delete process.env[v];

// A hook run just before local-files opens a file: the tests use it to swap the file between check and open.
const race = vi.hoisted(() => ({ beforeOpen: null as null | ((path: string) => void) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: (async (...args: Parameters<typeof real.open>) => {
      const hook = race.beforeOpen;
      race.beforeOpen = null;
      hook?.(String(args[0]));
      return real.open(...args);
    }) as typeof real.open,
  };
});

const { AttachmentError } = await import("../server/mail/attachments.ts");
const { isSecretName, openLocalFile, readCapped } = await import("../server/mail/local-files.ts");
const { addAttachmentDir, listAttachmentDirs, removeAttachmentDir } = await import("../server/settings-cli.ts");
const { testContext } = await import("./helpers.ts");

type Policy = Parameters<typeof openLocalFile>[1];

let root: string;
let docs: string;
let data: string;
let outside: string;
let policy: Policy;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "xaq-files-")));
  docs = join(root, "docs");
  data = join(root, "data");
  outside = realpathSync(mkdtempSync(join(tmpdir(), "xaq-outside-")));
  mkdirSync(join(docs, "sub"), { recursive: true });
  mkdirSync(data);
  writeFileSync(join(docs, "report.pdf"), "%PDF-1.7 quarterly report");
  writeFileSync(join(docs, "sub", "notes.txt"), "notes");
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET CONTENTS");
  writeFileSync(join(data, "master.key"), "MASTER KEY BYTES");
  writeFileSync(join(data, "xaq.db"), "SQLite format 3");
  writeFileSync(join(data, "readme.txt"), "a harmless name, but in xaq's data directory");
  policy = { allowedDirs: [docs], dataDir: data };
});
afterAll(() => {
  for (const d of [root, outside, HOME]) rmSync(d, { recursive: true, force: true });
});

async function refusal(path: string, p: Policy = policy): Promise<InstanceType<typeof AttachmentError>> {
  try {
    const f = await openLocalFile(path, p);
    await f.handle.close();
  } catch (err) {
    if (err instanceof AttachmentError) {
      // Never the contents of anything that was looked at.
      for (const secret of ["TOP SECRET", "MASTER KEY", "SQLite format", "harmless name", "SECRET-XAQ"]) expect(err.message).not.toContain(secret);
      return err;
    }
    throw err;
  }
  throw new Error(`expected ${path} to be refused`);
}

async function read(path: string, p: Policy = policy) {
  const f = await openLocalFile(path, p);
  try {
    return { real: f.real, requested: f.requested, size: f.size, content: (await readCapped(f, 1_000_000))!.toString() };
  } finally {
    await f.handle.close();
  }
}

describe("path attachments: the boundary", () => {
  it("are off by default (no directories), and the error says where the owner turns them on", async () => {
    const err = await refusal(join(docs, "report.pdf"), { allowedDirs: [], dataDir: data });
    expect(err.code).toBe("path_attachments_off");
    expect(err.message).toMatch(/Attaching files from a path is off/);
    expect(err.message).toMatch(/Settings → Attachments from files/);
    expect(err.message).toContain("npx xaq-cli settings attachment-dirs add <dir>");
  });

  it("read a regular file inside an allowed directory, subdirectories included", async () => {
    expect(await read(join(docs, "report.pdf"))).toMatchObject({ real: join(docs, "report.pdf"), size: 25, content: "%PDF-1.7 quarterly report" });
    expect((await read(join(docs, "sub", "notes.txt"))).content).toBe("notes");
  });

  it("refuse anything outside the allowed directories, without saying what's there", async () => {
    const err = await refusal(join(outside, "secret.txt"));
    expect(err).toMatchObject({ code: "path_not_allowed", message: expect.stringMatching(/isn't inside a directory the owner allowed for attachments/) });
    // Lexically outside: the same answer whether or not the file exists.
    expect((await refusal(join(outside, "missing.txt"))).message).toBe(err.message.replace("secret.txt", "missing.txt"));
    expect((await refusal("/etc/passwd")).code).toBe("path_not_allowed");
    // A sibling whose name starts like the allowed directory isn't inside it.
    mkdirSync(`${docs}-evil`, { recursive: true });
    writeFileSync(join(`${docs}-evil`, "x.txt"), "x");
    expect((await refusal(join(`${docs}-evil`, "x.txt"))).code).toBe("path_not_allowed");
  });

  it('resolve ".." before checking', async () => {
    expect((await refusal(`${docs}/../../${outside.split("/").at(-1)}/secret.txt`)).code).toBe("path_not_allowed");
    expect((await refusal(join(docs, "..", "data", "readme.txt"))).code).toBe("path_not_allowed");
    // ".." that stays inside is fine; the source records the real path.
    expect(await read(`${docs}/sub/../report.pdf`)).toMatchObject({ real: join(docs, "report.pdf"), content: "%PDF-1.7 quarterly report" });
  });

  it("refuse a symlink that escapes the allowed directory, and follow one that stays inside", async () => {
    symlinkSync(join(outside, "secret.txt"), join(docs, "innocent.pdf"));
    const err = await refusal(join(docs, "innocent.pdf"));
    expect(err).toMatchObject({ code: "path_not_allowed", message: `Can't attach ${join(docs, "innocent.pdf")}: it leads through a symlink to something that can't be attached.` });
    // Where the link leads is never named.
    expect(err.message).not.toContain(outside);
    symlinkSync(outside, join(docs, "linked-dir"));
    expect((await refusal(join(docs, "linked-dir", "secret.txt"))).message).toMatch(/leads through a symlink to something that can't be attached/);
    symlinkSync(join(docs, "sub", "notes.txt"), join(docs, "notes-link.txt"));
    expect(await read(join(docs, "notes-link.txt"))).toMatchObject({ real: join(docs, "sub", "notes.txt"), requested: join(docs, "notes-link.txt"), content: "notes" });
  });

  it("say nothing about what exists behind a symlink: missing and existing targets get the same answer", async () => {
    // A dangling link, and a missing file under a linked directory that leads out: the symlink refusal, not "no file".
    symlinkSync(join(outside, "does-not-exist.txt"), join(docs, "dangling.pdf"));
    const dangling = await refusal(join(docs, "dangling.pdf"));
    const behind = await refusal(join(docs, "linked-dir", "does-not-exist.txt"));
    const existing = await refusal(join(docs, "linked-dir", "secret.txt"));
    for (const e of [dangling, behind, existing]) {
      expect(e.code).toBe("path_not_allowed");
      expect(e.message).toMatch(/: it leads through a symlink to something that can't be attached\.$/);
      expect(e.message).not.toContain(outside);
    }
    // A missing file under a link that stays inside the allowed directory is simply not there.
    symlinkSync(join(docs, "sub"), join(docs, "sub-link"));
    expect((await refusal(join(docs, "sub-link", "nope.txt"))).code).toBe("not_found");
  });

  it("accept an allowed directory that is itself a symlink", async () => {
    const alias = join(root, "docs-alias");
    symlinkSync(docs, alias);
    expect((await read(join(alias, "report.pdf"), { allowedDirs: [alias], dataDir: data })).real).toBe(join(docs, "report.pdf"));
  });

  it("always refuse xaq's own data directory, even inside an allowed directory", async () => {
    const wide: Policy = { allowedDirs: [root], dataDir: data };
    for (const name of ["master.key", "xaq.db", "readme.txt"]) {
      expect(await refusal(join(data, name), wide)).toMatchObject({ code: "path_not_allowed", message: expect.stringMatching(/xaq's own files .* can never be attached|can never be attached/) });
    }
    expect((await refusal(join(data, "readme.txt"), wide)).message).toMatch(/xaq's own files/);
    // Through a symlink or a hard link placed in an allowed directory, too.
    symlinkSync(join(data, "master.key"), join(docs, "key-link.txt"));
    expect((await refusal(join(docs, "key-link.txt"), wide)).message).toMatch(/leads through a symlink to something that can't be attached/);
    linkSync(join(data, "readme.txt"), join(docs, "hardlink.txt"));
    expect((await refusal(join(docs, "hardlink.txt"), wide)).message).toMatch(/hard-linked files can't be attached/);
    // ~/.xaq, ~/.agentinbox and the CLI's ~/.config/xaq count as xaq's own wherever the data directory is.
    for (const dir of [join(HOME, ".xaq"), join(HOME, ".agentinbox"), join(HOME, ".config", "xaq", "profiles")]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "default.json"), "{}");
      expect((await refusal(join(dir, "default.json"), { allowedDirs: [HOME], dataDir: data })).message).toMatch(/xaq's own files/);
    }
  });

  it("refuse secret-looking names anywhere: master.key, *.db, .env, id_*, *.pem, *.key, .netrc, .npmrc, *.xaq-backup-*", async () => {
    const names = [
      "master.key", "app.db", "app.db-wal", ".env", ".env.local", "id_ed25519", "id_rsa.pub", "server.pem", "tls.key", "Server.PEM",
      ".netrc", ".npmrc", ".pgpass", ".claude.json", ".mcp.json", "config.toml.xaq-backup-2026-10-19T12-00-00-000Z",
    ];
    for (const name of names) {
      writeFileSync(join(docs, name), "secret");
      expect(await refusal(join(docs, name))).toMatchObject({ code: "path_not_allowed", message: expect.stringMatching(/can never be attached/) });
    }
    expect(isSecretName("keynote.pdf")).toBe(false);
    expect(isSecretName("db-report.pdf")).toBe(false);
  });

  it("refuse any hard-linked file, and say why", async () => {
    writeFileSync(join(docs, "original.txt"), "fine");
    linkSync(join(docs, "original.txt"), join(docs, "second-name.txt"));
    for (const name of ["original.txt", "second-name.txt"]) {
      expect(await refusal(join(docs, name))).toMatchObject({
        code: "path_not_allowed",
        message: expect.stringMatching(/hard-linked files can't be attached \(a hard link can make any file look like it's in an allowed directory\); attach a copy\./),
      });
    }
  });

  it("refuse the CLI's profiles at their default location even when XDG_CONFIG_HOME points elsewhere", async () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "elsewhere-config");
    try {
      const profiles = join(HOME, ".config", "xaq", "profiles");
      mkdirSync(profiles, { recursive: true });
      writeFileSync(join(profiles, "laptop.json"), '{"key":"aib_SECRET-XAQ"}');
      expect((await refusal(join(profiles, "laptop.json"), { allowedDirs: [HOME], dataDir: data })).message).toMatch(/xaq's own files/);
      // ...and where XDG_CONFIG_HOME points too.
      mkdirSync(join(root, "elsewhere-config", "xaq", "profiles"), { recursive: true });
      writeFileSync(join(root, "elsewhere-config", "xaq", "profiles", "x.json"), "SECRET-XAQ");
      expect((await refusal(join(root, "elsewhere-config", "xaq", "profiles", "x.json"), { allowedDirs: [root], dataDir: data })).message).toMatch(/xaq's own files/);
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });

  it("probe like the reviewer's: with HOME allowed, the secrets xaq writes and common credentials are all refused", async () => {
    const files: Record<string, string> = {
      "Library/LaunchAgents/sh.xaq.daemon.plist": "<key>XAQ_MASTER_KEY</key><string>SECRET-XAQ</string>",
      "Library/LaunchAgents/com.other.agent.plist": "SECRET-XAQ",
      ".config/systemd/user/xaq.service": "Environment=XAQ_MASTER_KEY=SECRET-XAQ",
      ".config/systemd/user/xaq-listen-default.service": "SECRET-XAQ",
      ".codex/config.toml": 'http_headers = { Authorization = "Bearer aib_SECRET-XAQ" }',
      ".codex/config.toml.xaq-backup-2026-10-19T12-00-00-000Z": "aib_SECRET-XAQ",
      ".codex/auth.json": "SECRET-XAQ",
      ".cursor/mcp.json": '{"headers":{"Authorization":"Bearer aib_SECRET-XAQ"}}',
      ".cursor/mcp.json.xaq-backup-2026-10-19T12-00-00-000Z": "SECRET-XAQ",
      ".claude.json": "SECRET-XAQ",
      ".claude.json.xaq-backup-2026-10-19T12-00-00-000Z": "SECRET-XAQ",
      ".claude/.credentials.json": "SECRET-XAQ",
      ".hermes/config.yaml": "SECRET-XAQ",
      ".hermes/.env": "SECRET-XAQ",
      ".ssh/id_ed25519": "SECRET-XAQ",
      ".ssh/config": "SECRET-XAQ",
      ".aws/credentials": "SECRET-XAQ",
      ".config/gh/hosts.yml": "SECRET-XAQ",
      ".gnupg/private-keys-v1.d/x.key": "SECRET-XAQ",
      "Library/Keychains/login.keychain-db": "SECRET-XAQ",
      ".netrc": "SECRET-XAQ",
      ".npmrc": "//registry.npmjs.org/:_authToken=SECRET-XAQ",
      ".docker/config.json": "SECRET-XAQ",
      ".kube/config": "SECRET-XAQ",
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(HOME, rel, ".."), { recursive: true });
      writeFileSync(join(HOME, rel), content);
    }
    const homePolicy: Policy = { allowedDirs: [HOME], dataDir: data };
    for (const rel of Object.keys(files)) {
      expect((await refusal(join(HOME, rel), homePolicy)).code, rel).toBe("path_not_allowed");
    }
    // Reached through a symlink from an ordinary folder: the same refusal, without naming the target.
    mkdirSync(join(HOME, "Documents"), { recursive: true });
    symlinkSync(join(HOME, ".codex", "config.toml"), join(HOME, "Documents", "notes.toml"));
    const viaLink = await refusal(join(HOME, "Documents", "notes.toml"), homePolicy);
    expect(viaLink.message).toMatch(/leads through a symlink to something that can't be attached/);
    expect(viaLink.message).not.toContain(".codex");
    // An ordinary file in the same allowed directory still works.
    writeFileSync(join(HOME, "Documents", "report.pdf"), "%PDF-1.7");
    expect((await read(join(HOME, "Documents", "report.pdf"), homePolicy)).content).toBe("%PDF-1.7");
  });

  it("refuse directories, FIFOs and devices; a FIFO doesn't hang the open", async () => {
    expect((await refusal(join(docs, "sub"))).message).toMatch(/it's a directory/);
    execFileSync("mkfifo", [join(docs, "pipe.pdf")]);
    expect((await refusal(join(docs, "pipe.pdf"))).message).toMatch(/only regular files/);
    symlinkSync("/dev/zero", join(docs, "zero.bin"));
    expect((await refusal(join(docs, "zero.bin"))).code).toBe("path_not_allowed");
    expect((await refusal(join(docs, "zero.bin"), { allowedDirs: [docs, "/dev"], dataDir: data })).message).toMatch(/only regular files/);
  });

  it("refuse relative paths, control characters and missing files in plain words", async () => {
    expect(await refusal("docs/report.pdf")).toMatchObject({ code: "invalid_attachment", message: expect.stringMatching(/must be absolute/) });
    expect(await refusal("~/report.pdf")).toMatchObject({ code: "invalid_attachment" });
    expect(await refusal(`${docs}/a\nb.pdf`)).toMatchObject({ code: "invalid_attachment" });
    expect(await refusal(join(docs, "nope.pdf"))).toMatchObject({ code: "not_found", message: `There is no file at ${join(docs, "nope.pdf")}.` });
  });

  it("catch a swap between the check and the open: a symlink, another file, or a directory turned into a symlink", async () => {
    // The final component replaced by a symlink to a secret: O_NOFOLLOW refuses it.
    const a = join(docs, "swap-a.txt");
    writeFileSync(a, "fine");
    race.beforeOpen = () => {
      rmSync(a);
      symlinkSync(join(outside, "secret.txt"), a);
    };
    expect((await refusal(a)).message).toMatch(/changed into a symlink while being checked/);

    // Replaced by a different regular file: not the file that was checked (device and inode differ).
    const b = join(docs, "swap-b.txt");
    writeFileSync(b, "fine");
    writeFileSync(join(docs, "other.txt"), "other");
    race.beforeOpen = () => renameSync(join(docs, "other.txt"), b);
    expect((await refusal(b)).message).toMatch(/changed while being checked/);

    // A directory on the way swapped for a symlink out of the allowed directory.
    mkdirSync(join(docs, "box"));
    writeFileSync(join(docs, "box", "secret.txt"), "fine");
    race.beforeOpen = () => {
      renameSync(join(docs, "box"), join(docs, "box-old"));
      symlinkSync(outside, join(docs, "box"));
    };
    expect((await refusal(join(docs, "box", "secret.txt"))).message).toMatch(/changed while being checked|moved while being checked/);
  });

  it("never read more than the limit, even when the file grew after the check", async () => {
    const path = join(docs, "growing.log");
    writeFileSync(path, "0123456789");
    const f = await openLocalFile(path, policy);
    try {
      expect(f.size).toBe(10);
      appendFileSync(path, "x".repeat(90));
      expect(await readCapped(f, 50)).toBeNull();
      expect((await readCapped(f, 100))!.length).toBe(100);
      expect(await readCapped(f, 99)).toBeNull();
    } finally {
      await f.handle.close();
    }
  });
});

describe("the attachmentDirs setting", () => {
  it("is empty by default, takes existing absolute directories, and refuses xaq's own", async () => {
    const t = testContext();
    try {
      const { settings, config } = t.ctx;
      expect(settings.get().attachmentDirs).toEqual([]);
      expect(settings.update({ attachmentDirs: [`${docs}/`, docs] }).attachmentDirs).toEqual([docs]);
      expect(() => settings.update({ attachmentDirs: ["relative/dir"] })).toThrow(/isn't an absolute directory path/);
      expect(() => settings.update({ attachmentDirs: [join(root, "nope")] })).toThrow(/doesn't exist/);
      expect(() => settings.update({ attachmentDirs: [join(docs, "report.pdf")] })).toThrow(/isn't a directory/);
      expect(() => settings.update({ attachmentDirs: [config.dataDir] })).toThrow(/is, contains or is inside xaq's own directory/);
      // A directory saved earlier that's gone (an unmounted disk) doesn't block other changes.
      const gone = mkdtempSync(join(tmpdir(), "xaq-gone-"));
      settings.update({ attachmentDirs: [docs, gone] });
      rmSync(gone, { recursive: true });
      expect(settings.update({ retentionDays: 7 }).attachmentDirs).toEqual([docs, gone]);
    } finally {
      await t.dispose();
    }
  });

  it("refuses directories that are or contain $HOME or /, or are, contain or sit inside a secret place", async () => {
    const t = testContext();
    try {
      const { settings } = t.ctx;
      const narrower = /Pick a narrower folder, for example ~\/Documents\/xaq-outbox\./;
      const refused = (dir: string, why: RegExp) => {
        let err: unknown;
        try {
          settings.update({ attachmentDirs: [dir] });
        } catch (e) {
          err = e;
        }
        expect(err, dir).toBeDefined();
        const text = `${(err as Error).message} ${(err as { hint?: string }).hint ?? ""}`;
        expect(text, dir).toMatch(why);
        expect(text, dir).toMatch(narrower);
      };
      refused("/", /too broad: it is the root directory/);
      refused(HOME, /too broad: it is or contains your home directory/);
      refused(join(HOME, ".."), /too broad: it is or contains your home directory/);
      for (const rel of [".ssh", ".codex", ".cursor", ".config/gh", "Library/LaunchAgents", ".config/systemd/user", ".hermes"]) {
        mkdirSync(join(HOME, rel), { recursive: true });
        refused(join(HOME, rel), /is, contains or is inside .* where credentials, service definitions or agent keys are kept/);
      }
      // Inside one, too.
      mkdirSync(join(HOME, ".ssh", "keys"), { recursive: true });
      refused(join(HOME, ".ssh", "keys"), /is, contains or is inside/);
      // xaq's own directories, at the default XDG location as well.
      mkdirSync(join(HOME, ".config", "xaq", "profiles"), { recursive: true });
      refused(join(HOME, ".config", "xaq", "profiles"), /xaq's own directory/);
      refused(join(HOME, ".config", "xaq"), /xaq's own directory/);
      // A narrower folder is fine.
      mkdirSync(join(HOME, "Documents", "xaq-outbox"), { recursive: true });
      expect(settings.update({ attachmentDirs: [join(HOME, "Documents", "xaq-outbox")] }).attachmentDirs).toEqual([join(HOME, "Documents", "xaq-outbox")]);
    } finally {
      await t.dispose();
    }
  });

  it("is managed by `xaq settings attachment-dirs` through the admin settings API", async () => {
    const t = testContext();
    try {
      const calls: string[] = [];
      const channel = {
        request: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
          calls.push(`${method} ${path}`);
          return (method === "GET" ? t.ctx.settings.get() : t.ctx.settings.update(body as object)) as T;
        },
      };
      const out: string[] = [];
      const deps = { channel, print: (l = "") => out.push(l), cwd: root };
      expect(await listAttachmentDirs(deps)).toBe(0);
      expect(out.join("\n")).toMatch(/No directories are allowed/);
      expect(await addAttachmentDir("docs", deps)).toBe(0);
      expect(t.ctx.settings.get().attachmentDirs).toEqual([docs]);
      expect(await addAttachmentDir(docs, deps)).toBe(0);
      expect(out.join("\n")).toContain(`${docs} is already allowed`);
      await expect(addAttachmentDir(join(root, "missing"), deps)).rejects.toThrow(/doesn't exist/);
      expect(await removeAttachmentDir(docs, deps)).toBe(0);
      expect(t.ctx.settings.get().attachmentDirs).toEqual([]);
      expect(await removeAttachmentDir(docs, deps)).toBe(1);
      expect(calls).toContain("PATCH /api/settings");
    } finally {
      await t.dispose();
    }
  });
});
