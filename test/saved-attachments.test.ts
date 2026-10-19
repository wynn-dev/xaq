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
  attachmentSaveDir,
  MAX_SAVED_BYTES,
  pruneSavedAttachments,
  SAVE_DIR_MARKER,
  SaveError,
  saveAttachment,
} from "../server/mail/saved-attachments.ts";
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

  it("deletes files past the retention, then empty folders, only in a folder xaq created", async () => {
    const ctx = setup();
    const a = await saveAttachment(ctx, "m6", "old.txt", "text/plain", Buffer.from("o"));
    const b = await saveAttachment(ctx, "m7", "new.txt", "text/plain", Buffer.from("n"));
    utimesSync(a, old(), old());
    expect(pruneSavedAttachments(ctx)).toBe(1);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(join(ctx.config.dataDir, "attachments", "m6"))).toBe(false);
    expect(existsSync(b)).toBe(true);
    // Something that isn't a message folder is left alone.
    const other = join(ctx.config.dataDir, "attachments", "not a message dir");
    mkdirSync(other);
    writeFileSync(join(other, "f"), "x");
    utimesSync(join(other, "f"), old(), old());
    pruneSavedAttachments(ctx);
    expect(existsSync(join(other, "f"))).toBe(true);
  });

  it("uses a configured folder; an existing folder with other files is used but never tightened or pruned", async () => {
    const ctx = setup();
    const mine = join(tmp(), "new-folder");
    ctx.settings.update({ attachmentSaveDir: mine });
    expect(attachmentSaveDir(ctx)).toBe(mine);
    const p = await saveAttachment(ctx, "m8", "a.txt", "text/plain", Buffer.from("a"));
    expect(p).toBe(join(mine, "m8", "a.txt"));
    expect(existsSync(join(mine, SAVE_DIR_MARKER))).toBe(true);

    const foreign = tmp();
    writeFileSync(join(foreign, "someone-elses.txt"), "x");
    chmodSync(foreign, 0o755);
    ctx.settings.update({ attachmentSaveDir: foreign });
    const q = await saveAttachment(ctx, "m9", "b.txt", "text/plain", Buffer.from("b"));
    expect(q).toBe(join(foreign, "m9", "b.txt"));
    expect(statSync(foreign).mode & 0o777).toBe(0o755);
    expect(existsSync(join(foreign, SAVE_DIR_MARKER))).toBe(false);
    utimesSync(q, old(), old());
    expect(pruneSavedAttachments(ctx)).toBe(0);
    expect(existsSync(q)).toBe(true);
  });

  it("refuses a symlinked save folder", async () => {
    const ctx = setup();
    const real = tmp();
    const link = join(tmp(), "link");
    symlinkSync(real, link);
    ctx.settings.update({ attachmentSaveDir: link });
    await expect(saveAttachment(ctx, "m10", "a.txt", "text/plain", Buffer.from("a"))).rejects.toThrow(/symlinks are refused/);
  });

  it("validates the setting: absolute paths only, empty for the default", () => {
    const ctx = setup();
    expect(() => ctx.settings.update({ attachmentSaveDir: "relative/dir" })).toThrow(/absolute path/);
    expect(ctx.settings.update({ attachmentSaveDir: "  " }).attachmentSaveDir).toBe("");
    expect(ctx.settings.update({ attachmentSaveDir: "/tmp/x/../y" }).attachmentSaveDir).toBe("/tmp/y");
  });
});
