// Files get_attachment saves for agents: where they go (default and configured folder), names that can't escape,
// no overwriting, ownership (only a folder xaq created is tightened and pruned), symlinks refused, size cap,
// retention, and the setting's validation.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasForeignFiles } from "../server/config.ts";
import {
  ATTACHMENT_RETENTION_DAYS,
  MAX_SAVED_BYTES,
  pruneSavedAttachments,
  SAVE_DIR_MARKER,
  SaveError,
  saveAttachment,
} from "../server/mail/saved-attachments.ts";
import { attachmentOutput } from "../server/mcp/attachments.ts";
import { testContext } from "./helpers.ts";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

function setup() {
  const t = testContext();
  cleanup.push(t.dispose);
  return t.ctx;
}

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "xaq-saved-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const old = () => (Date.now() - (ATTACHMENT_RETENTION_DAYS + 1) * 86_400_000) / 1000;

/** Marks a recorded file as saved before the retention (the manifest's savedAt, not the file's mtime, counts). */
function age(root: string, rel: string) {
  const path = join(root, SAVE_DIR_MARKER);
  const m = JSON.parse(readFileSync(path, "utf8")) as { files: Record<string, { savedAt: number }> };
  m.files[rel]!.savedAt = Date.now() - (ATTACHMENT_RETENTION_DAYS + 1) * 86_400_000;
  writeFileSync(path, JSON.stringify(m));
}

describe("saved attachments", () => {
  it("saves to attachments/ in the data dir, 0700/0600, as <message id>/<cleaned name>", async () => {
    const ctx = setup();
    const path = await saveAttachment(ctx, "18f00aa", "../../../etc/passwd", "text/plain", Buffer.from("x"));
    expect(path).toBe(join(ctx.config.dataDir, "attachments", "18f00aa", "passwd"));
    expect(statSync(join(ctx.config.dataDir, "attachments")).mode & 0o777).toBe(0o700);
    expect(statSync(join(ctx.config.dataDir, "attachments", "18f00aa")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The data dir still counts as ours (attachments/ is one of our entries).
    expect(hasForeignFiles(ctx.config.dataDir)).toBe(false);
  });

  it("cleans hostile names: no hidden files, no control or bidi characters, encoded words decoded", async () => {
    const ctx = setup();
    expect(await saveAttachment(ctx, "m1", ".bashrc", "text/plain", Buffer.from("a"))).toMatch(/\/m1\/_bashrc$/);
    expect(await saveAttachment(ctx, "m1", "inv‮oice\u0000.pdf", "application/pdf", Buffer.from("b"))).toMatch(/\/m1\/invoice\.pdf$/);
    expect(await saveAttachment(ctx, "m1", "=?UTF-8?B?Li4vZXZpbC5zaA==?=", "text/plain", Buffer.from("c"))).toMatch(/\/m1\/evil\.sh$/);
    expect(await saveAttachment(ctx, "m1", "..", "application/pdf", Buffer.from("d"))).toMatch(/\/m1\/attachment\.pdf$/);
    await expect(saveAttachment(ctx, "../m1", "x.txt", "text/plain", Buffer.from("e"))).rejects.toThrow(SaveError);
  });

  it("never overwrites a different file; the same bytes reuse the file", async () => {
    const ctx = setup();
    const a = await saveAttachment(ctx, "m2", "r.pdf", "application/pdf", Buffer.from("one"));
    expect(await saveAttachment(ctx, "m2", "r.pdf", "application/pdf", Buffer.from("one"))).toBe(a);
    const b = await saveAttachment(ctx, "m2", "r.pdf", "application/pdf", Buffer.from("two"));
    expect(b).toMatch(/\/m2\/r \(2\)\.pdf$/);
    expect(readFileSync(a, "utf8")).toBe("one");
    expect(readFileSync(b, "utf8")).toBe("two");
  });

  it("never writes through a symlink planted at the file's name or as the message folder", async () => {
    const ctx = setup();
    const target = join(tmp(), "victim");
    writeFileSync(target, "keep");
    const dir = join(ctx.config.dataDir, "attachments", "m3");
    await saveAttachment(ctx, "m3", "first.txt", "text/plain", Buffer.from("x"));
    symlinkSync(target, join(dir, "evil.txt"));
    const p = await saveAttachment(ctx, "m3", "evil.txt", "text/plain", Buffer.from("payload"));
    expect(p).toMatch(/evil \(2\)\.txt$/);
    expect(readFileSync(target, "utf8")).toBe("keep");

    const elsewhere = tmp();
    symlinkSync(elsewhere, join(ctx.config.dataDir, "attachments", "m4"));
    await expect(saveAttachment(ctx, "m4", "x.txt", "text/plain", Buffer.from("x"))).rejects.toThrow(/isn't a plain directory/);
    expect(existsSync(join(elsewhere, "x.txt"))).toBe(false);
  });

  it("refuses files over the size cap", async () => {
    const ctx = setup();
    await expect(saveAttachment(ctx, "m5", "big.bin", "application/octet-stream", Buffer.alloc(MAX_SAVED_BYTES + 1))).rejects.toThrow(/limit for saved files/);
  });

  it("deletes recorded files past the retention, then the empty folders it created, and nothing else", async () => {
    const ctx = setup();
    const root = join(ctx.config.dataDir, "attachments");
    const a = await saveAttachment(ctx, "m6", "old.txt", "text/plain", Buffer.from("o"));
    const b = await saveAttachment(ctx, "m7", "new.txt", "text/plain", Buffer.from("n"));
    age(root, "m6/old.txt");
    // A user's own files, even in id-like folders and old: never recorded, never deleted.
    mkdirSync(join(root, "deadbeef"));
    writeFileSync(join(root, "deadbeef", "notes.txt"), "mine");
    writeFileSync(join(root, "m7", "mine.txt"), "mine");
    utimesSync(join(root, "deadbeef", "notes.txt"), old(), old());
    expect(pruneSavedAttachments(ctx)).toBe(1);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(join(root, "m6"))).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(pruneSavedAttachments(ctx, Date.now() + (ATTACHMENT_RETENTION_DAYS + 1) * 86_400_000)).toBe(1);
    expect(existsSync(b)).toBe(false);
    expect(readFileSync(join(root, "deadbeef", "notes.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(root, "m7", "mine.txt"), "utf8")).toBe("mine");
  });

  it("an adopted empty folder: later user files in id-like folders are never deleted, by retention or the quota", async () => {
    const ctx = setup();
    const folder = join(tmp(), "adopted");
    mkdirSync(folder, { mode: 0o755 });
    ctx.settings.update({ attachmentSaveDir: folder });
    const quotaBytes = 1000;
    const ours = await saveAttachment(ctx, "a1", "ours.bin", "application/octet-stream", Buffer.alloc(300), { quotaBytes });
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    // The user later puts their own files there (one replacing ours by hand).
    mkdirSync(join(folder, "1234abcd"));
    writeFileSync(join(folder, "1234abcd", "tax.pdf"), Buffer.alloc(900));
    const replaced = await saveAttachment(ctx, "a2", "r.bin", "application/octet-stream", Buffer.alloc(100), { quotaBytes });
    rmSync(replaced);
    writeFileSync(replaced, Buffer.alloc(100, 1));
    age(folder, "a1/ours.bin");
    // Quota: only recorded files count (300), so 600 more fits; then 800 needs ours deleted, never theirs.
    await saveAttachment(ctx, "a3", "x.bin", "application/octet-stream", Buffer.alloc(600), { quotaBytes });
    await expect(saveAttachment(ctx, "a4", "y.bin", "application/octet-stream", Buffer.alloc(800), { quotaBytes })).resolves.toMatch(/y\.bin$/);
    expect(existsSync(ours)).toBe(false);
    expect(existsSync(join(folder, "1234abcd", "tax.pdf"))).toBe(true);
    expect(existsSync(replaced)).toBe(true);
    expect(pruneSavedAttachments(ctx, Date.now() + 30 * 86_400_000)).toBe(1);
    expect(existsSync(join(folder, "1234abcd", "tax.pdf"))).toBe(true);
    expect(existsSync(replaced)).toBe(true);
  });

  it("uses a folder that already holds other files without tightening it, and deletes only what it saved there", async () => {
    const ctx = setup();
    const foreign = tmp();
    writeFileSync(join(foreign, "someone-elses.txt"), "x");
    chmodSync(foreign, 0o755);
    ctx.settings.update({ attachmentSaveDir: foreign });
    const q = await saveAttachment(ctx, "m9", "b.txt", "text/plain", Buffer.from("b"));
    expect(q).toBe(join(foreign, "m9", "b.txt"));
    expect(statSync(foreign).mode & 0o777).toBe(0o755);
    expect(pruneSavedAttachments(ctx, Date.now() + 30 * 86_400_000)).toBe(1);
    expect(existsSync(q)).toBe(false);
    expect(existsSync(join(foreign, "someone-elses.txt"))).toBe(true);
  });

  it("refuses a world-writable folder, and one owned by another user", async () => {
    const ctx = setup();
    const open = tmp();
    chmodSync(open, 0o777);
    ctx.settings.update({ attachmentSaveDir: open });
    await expect(saveAttachment(ctx, "w1", "a.txt", "text/plain", Buffer.from("a"))).rejects.toThrow(/writable by every user/);
    expect(existsSync(join(open, "w1"))).toBe(false);
    // /: owned by root (tests never run as root).
    if (process.getuid?.() !== 0) {
      ctx.settings.update({ attachmentSaveDir: "/" });
      await expect(saveAttachment(ctx, "w2", "a.txt", "text/plain", Buffer.from("a"))).rejects.toThrow(/belongs to another user/);
    }
  });

  it("refuses a symlinked save folder", async () => {
    const ctx = setup();
    const real = tmp();
    const link = join(tmp(), "link");
    symlinkSync(real, link);
    ctx.settings.update({ attachmentSaveDir: link });
    await expect(saveAttachment(ctx, "m10", "a.txt", "text/plain", Buffer.from("a"))).rejects.toThrow(/symlinks are refused/);
  });

  it("keeps the recorded files within the total quota by deleting the oldest first", async () => {
    const ctx = setup();
    const root = join(ctx.config.dataDir, "attachments");
    const quotaBytes = 1000;
    const kb = (c: string) => Buffer.alloc(400, c);
    const a = await saveAttachment(ctx, "q1", "a.bin", "application/octet-stream", kb("a"), { quotaBytes });
    const b = await saveAttachment(ctx, "q2", "b.bin", "application/octet-stream", kb("b"), { quotaBytes });
    age(root, "q1/a.bin");
    // The same bytes again need no room: nothing is deleted.
    expect(await saveAttachment(ctx, "q2", "b.bin", "application/octet-stream", kb("b"), { quotaBytes })).toBe(b);
    expect(existsSync(a)).toBe(true);
    // 800 + 400 > 1000: the oldest (a) goes, and its empty message folder with it.
    const c = await saveAttachment(ctx, "q3", "c.bin", "application/octet-stream", kb("c"), { quotaBytes });
    expect(existsSync(a)).toBe(false);
    expect(existsSync(join(root, "q1"))).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(c)).toBe(true);
    // A file larger than the whole quota is refused, and nothing is deleted for it.
    await expect(saveAttachment(ctx, "q4", "huge.bin", "application/octet-stream", Buffer.alloc(1001), { quotaBytes })).rejects.toThrow(/larger than the 1000 B quota/);
    expect(existsSync(b) && existsSync(c)).toBe(true);
  });

  it("deletes only files it saved and that are unchanged to make room", async () => {
    const ctx = setup();
    const quotaBytes = 1000;
    const a = await saveAttachment(ctx, "f1", "a.bin", "application/octet-stream", Buffer.alloc(600), { quotaBytes });
    // Ours, but replaced by hand: no longer ours to delete, and no longer counted. A user file never counts.
    rmSync(a);
    writeFileSync(a, Buffer.alloc(600, 2));
    const b = await saveAttachment(ctx, "f2", "b.bin", "application/octet-stream", Buffer.alloc(900), { quotaBytes });
    await expect(saveAttachment(ctx, "f3", "c.bin", "application/octet-stream", Buffer.alloc(200), { quotaBytes })).resolves.toMatch(/c\.bin$/);
    expect(existsSync(b)).toBe(false);
    expect(existsSync(a)).toBe(true);
  });

  it("never deletes a file rewritten in place or recreated with a reused inode (same size)", async () => {
    const ctx = setup();
    const inPlace = await saveAttachment(ctx, "r1", "a.bin", "application/octet-stream", Buffer.alloc(64, 1));
    const recreated = await saveAttachment(ctx, "r2", "b.bin", "application/octet-stream", Buffer.alloc(64, 1));
    const ino = statSync(inPlace).ino;
    // Same inode, same size, often the same coarse mtime: only the content hash tells it apart.
    writeFileSync(inPlace, Buffer.alloc(64, 2));
    expect(statSync(inPlace).ino).toBe(ino);
    // Deleted and written again: ext4 and others commonly hand the freed inode straight back.
    rmSync(recreated);
    writeFileSync(recreated, Buffer.alloc(64, 3));
    expect(pruneSavedAttachments(ctx, Date.now() + 30 * 86_400_000)).toBe(0);
    expect(readFileSync(inPlace)[0]).toBe(2);
    expect(readFileSync(recreated)[0]).toBe(3);
  });

  it("get_attachment still answers with the file's metadata when it can't be saved", async () => {
    const ctx = setup();
    const link = join(tmp(), "link");
    symlinkSync(tmp(), link);
    ctx.settings.update({ attachmentSaveDir: link });
    const out = await attachmentOutput(
      ctx,
      { messageId: "m11", attachmentId: "2", from: "x@evil.test", filename: "blob.bin", mimeType: "application/octet-stream", data: Buffer.alloc(10), maxChars: 0 },
      {},
    );
    if (typeof out === "string" || Array.isArray(out)) throw new Error("expected structured output");
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain("Attachment blob.bin (application/octet-stream, 10 B) from message m11, attachment_id 2");
    expect(text).toMatch(/It couldn't be saved to a file: the attachment folder isn't a plain directory/);
    expect(out.structuredContent).toMatchObject({ attachment: { filename: "blob.bin", size: 10, savedPath: null } });
  });

  it("validates the setting: absolute paths only, empty for the default", () => {
    const ctx = setup();
    expect(() => ctx.settings.update({ attachmentSaveDir: "relative/dir" })).toThrow(/absolute path/);
    expect(ctx.settings.update({ attachmentSaveDir: "  " }).attachmentSaveDir).toBe("");
    expect(ctx.settings.update({ attachmentSaveDir: "/tmp/x/../y" }).attachmentSaveDir).toBe("/tmp/y");
  });
});
