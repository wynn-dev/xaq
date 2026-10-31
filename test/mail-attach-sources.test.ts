// Attachment sources over MCP, against the fake Google (Gmail and Drive): bytes in the call, a path on xaq's machine,
// another message's attachment and a Drive file (downloaded, or exported for Google-native files), mixed in one
// message, on send_message, create_draft, reply and forward; Gmail's 25 MB of attachments and the API's 35 MB for the
// encoded message (with a Drive link in the error); the Drive grant (a Google Workspace connection bound to the same
// account) and the Drive scope; and what approval cards and the audit log say about each file's source.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Never look at the real ~/.xaq or ~/.config: xaq's own directories are derived from HOME and XDG_*.
const HOME = mkdtempSync(join(tmpdir(), "xaq-home-"));
process.env.HOME = HOME;
for (const v of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) delete process.env[v];

const { DRIVE_READONLY_SCOPE, GMAIL_SCOPE } = await import("../server/google/scopes.ts");
const { connectFakeAccount, recordingEvents, startFakeGoogle } = await import("./fake-google.ts");
const { connectAgent, grantInput } = await import("./mail-fakes.ts");
const { testContext } = await import("./helpers.ts");

import type { Account, AttachmentSource, GrantInput } from "../shared/types.ts";
import type { AppContext } from "../server/context.ts";
import type { GmailMessage } from "../server/google/types.ts";
import type { FakeGoogle } from "./fake-google.ts";

const ME = "office@example.com";
const NODRIVE = "nodrive@example.com";
const IDENTITY = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"];

let fake: FakeGoogle;
let ctx: AppContext;
let dispose: () => Promise<void>;
let me: Account;
let noDrive: Account;
let docs: string;
const closers: (() => Promise<void>)[] = [];

const pdf = (size: number, seed = 1) => {
  const out = Buffer.alloc(size);
  Buffer.from("%PDF-1.7\n").copy(out);
  for (let i = 9; i < size; i++) out[i] = (i * 31 + seed) % 256;
  return out;
};

let nextConnection = 1;
/**
 * A google-workspace connection (or another extension's), bound to `accountId` unless null: what the extension's
 * Google setup leaves behind (connections.google_account_id, migration 12).
 */
function workspaceConnection(accountId: string | null, opts: { preset?: string; status?: string } = {}): string {
  const id = `con_ws${nextConnection++}`;
  const t = new Date().toISOString();
  ctx.db.run(
    `INSERT INTO connections (id, kind, preset, slug, name, url, auth_type, level_default, status, google_account_id, created_at, updated_at)
     VALUES (?, 'remote_http', ?, ?, 'Google Workspace', 'https://workspace.example/mcp', 'none', 'read', ?, ?, ?, ?)`,
    id,
    opts.preset ?? "google-workspace",
    `gws-${nextConnection}`,
    opts.status ?? "active",
    accountId,
    t,
    t,
  );
  return id;
}
const grantConnection = (agentId: string, connectionId: string, level = "read") => {
  const t = new Date().toISOString();
  ctx.db.run("INSERT INTO connection_grants (agent_id, connection_id, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", agentId, connectionId, level, t, t);
};

/** An MCP agent with a mail grant on `accountId`; `workspace` also grants it a Google Workspace connection bound to that account. */
async function agent(name: string, accountId: string, g: Partial<GrantInput> = {}, workspace: false | "read" | "ask" | "full" = "read") {
  const { agent: a } = ctx.policy.createAgent({ name, grants: [grantInput(accountId, { capabilities: ["read", "draft", "send"], sendMode: "direct", ...g })] });
  if (workspace) grantConnection(a.id, workspaceConnection(accountId), workspace);
  const c = await connectAgent(ctx, a.id, name);
  closers.push(c.close);
  const json = async (tool: string, args: Record<string, unknown>) => {
    const r = await c.call(tool, args);
    if (r.isError) throw new Error(`${tool} failed: ${r.text}`);
    return JSON.parse(r.text) as Record<string, string>;
  };
  const audit = (action: string) => ctx.audit.list({ agentId: a.id, action, limit: 50 }).items;
  return { id: a.id, call: c.call, json, audit };
}

/** A stored message's files and their bytes. */
async function filesOf(accountId: string, msg: GmailMessage) {
  const parsed = ctx.google.mime.parse(msg);
  const gmail = ctx.google.gmail(accountId);
  return Promise.all(
    parsed.attachments.map(async (x) => ({ filename: x.filename, mimeType: x.mimeType, data: Buffer.from((await gmail.getAttachment(msg.id, x.id)).data, "base64url") })),
  );
}

const lastSent = (email: string) => fake.sent(email).at(-1)!;
const partId = (msg: GmailMessage, filename: string) => {
  const walk = (p: GmailMessage["payload"]): string | undefined => (p?.filename === filename ? p.partId : p?.parts?.map(walk).find(Boolean));
  return walk(msg.payload)!;
};

beforeAll(async () => {
  fake = await startFakeGoogle();
  const t = testContext({ events: recordingEvents().factory }, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
  me = await connectFakeAccount(ctx, fake, ME, { name: "Office", scopes: [GMAIL_SCOPE, ...IDENTITY, DRIVE_READONLY_SCOPE] });
  noDrive = await connectFakeAccount(ctx, fake, NODRIVE, { name: "No Drive", scopes: [GMAIL_SCOPE, ...IDENTITY] });
  docs = realpathSync(mkdtempSync(join(tmpdir(), "xaq-docs-")));
  mkdirSync(join(docs, "contracts"));
  writeFileSync(join(docs, "contracts", "lease.pdf"), pdf(3000, 7));
  writeFileSync(join(docs, "big.bin"), Buffer.alloc(10_000_000, 3));
  ctx.settings.update({ attachmentDirs: [docs] });
});
afterAll(async () => {
  for (const c of closers) await c().catch(() => {});
  await dispose();
  await fake.close();
  rmSync(docs, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

describe("attachment sources", () => {
  it("each source, mixed in one message: bytes, a path, another message's file, a Drive download and a Drive export", async () => {
    const a = await agent("mixer", me.id);
    const invoice = pdf(5000, 2);
    const src = fake.deliver(ME, { from: "Vendor <billing@vendor.test>", subject: "Invoice", text: "Attached.", attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", content: invoice }] });
    const photo = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const photoId = fake.drive.addFile(ME, { name: "site photo.png", mimeType: "image/png", content: photo });
    const docId = fake.drive.addFile(ME, { name: "Proposal", mimeType: "application/vnd.google-apps.document" });

    const r = await a.json("send_message", {
      to: "client@example.org",
      subject: "Documents",
      body: "Everything attached.",
      attachments: [
        { content_base64: Buffer.from("hello").toString("base64"), filename: "hello.txt" },
        { path: join(docs, "contracts", "lease.pdf") },
        { message_id: src.id, attachment_id: partId(src, "invoice.pdf") },
        { drive_file_id: photoId },
        { drive_file_id: docId },
      ],
    });
    expect(r.status).toBe("sent");
    const files = await filesOf(me.id, lastSent(ME));
    expect(files.map((f) => [f.filename, f.mimeType])).toEqual([
      ["hello.txt", "text/plain"],
      ["lease.pdf", "application/pdf"],
      ["invoice.pdf", "application/pdf"],
      ["site photo.png", "image/png"],
      ["Proposal.pdf", "application/pdf"],
    ]);
    expect(files[1]!.data.equals(pdf(3000, 7))).toBe(true);
    expect(files[2]!.data.equals(invoice)).toBe(true);
    expect(files[3]!.data.equals(photo)).toBe(true);
    expect(files[4]!.data.toString()).toMatch(/^%PDF-1\.7\n% Proposal exported/);

    // The audit log records each file's source (and name, type, size, sha256), never content.
    const detail = a.audit("send_message")[0]!.detail as { attachments: { filename: string; source: AttachmentSource; sha256: string }[] };
    expect(detail.attachments.map((x) => x.source)).toEqual([
      { kind: "upload" },
      { kind: "path", path: join(docs, "contracts", "lease.pdf") },
      { kind: "message", messageId: src.id, attachmentId: partId(src, "invoice.pdf"), filename: "invoice.pdf" },
      { kind: "drive", fileId: photoId, name: "site photo.png" },
      { kind: "drive", fileId: docId, name: "Proposal", exportedAs: "pdf" },
    ]);
    expect(detail.attachments.every((x) => /^[0-9a-f]{64}$/.test(x.sha256))).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(invoice.toString("base64").slice(0, 40));
  });

  it("approval cards show where each file came from", async () => {
    const a = await agent("approver", me.id, { sendMode: "approval" });
    const src = fake.deliver(ME, { from: "hr@example.org", subject: "Form", text: "Form attached", attachments: [{ filename: "form.pdf", mimeType: "application/pdf", content: pdf(800) }] });
    const sheet = fake.drive.addFile(ME, { name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet", exports: { "text/csv": Buffer.from("a,b\n1,2\n") } });
    writeFileSync(join(docs, "alias-target.txt"), "target");
    const r = await a.json("reply", {
      message_id: src.id,
      body: "Filled in, plus the budget.",
      reason: "user asked",
      attachments: [
        { path: `${docs}/contracts/../alias-target.txt`, filename: "notes.txt" },
        { message_id: src.id, attachment_id: partId(src, "form.pdf") },
        { drive_file_id: sheet, export_as: "csv" },
      ],
    });
    expect(r.status).toBe("pending_approval");
    const approval = ctx.mail.getApproval(r.approvalId!)!;
    expect(approval.attachments).toEqual([
      { filename: "notes.txt", mimeType: "text/plain", size: 6, source: { kind: "path", path: join(docs, "alias-target.txt"), requested: `${docs}/contracts/../alias-target.txt` } },
      { filename: "form.pdf", mimeType: "application/pdf", size: 800, source: { kind: "message", messageId: src.id, attachmentId: partId(src, "form.pdf"), filename: "form.pdf" } },
      { filename: "Budget.csv", mimeType: "text/csv", size: 8, source: { kind: "drive", fileId: sheet, name: "Budget", exportedAs: "csv" } },
    ]);
    // Approval follows the grant's policy, unchanged: nothing went out yet.
    expect(fake.sent(ME).some((m) => ctx.google.mime.parse(m).summary.subject === "Re: Form")).toBe(false);
  });

  it("create_draft and forward take new attachments too; forward keeps include_attachments", async () => {
    const a = await agent("forwarder", me.id);
    const draft = await a.json("create_draft", { to: "x@example.org", subject: "Draft", body: "b", attachments: [{ path: join(docs, "contracts", "lease.pdf") }] });
    expect(draft.status).toBe("draft_created");
    const stored = fake.drafts(ME).find((d) => d.id === draft.draftId)!;
    expect((await filesOf(me.id, stored.message)).map((f) => f.filename)).toEqual(["lease.pdf"]);

    const src = fake.deliver(ME, { from: "a@example.org", subject: "Plans", text: "See plan", attachments: [{ filename: "plan.pdf", mimeType: "application/pdf", content: pdf(1200) }] });
    const sent = await a.json("forward", { message_id: src.id, to: "team@example.org", include_attachments: true, attachments: [{ path: join(docs, "contracts", "lease.pdf") }] });
    expect(sent.status).toBe("sent");
    expect((await filesOf(me.id, lastSent(ME))).map((f) => f.filename)).toEqual(["plan.pdf", "lease.pdf"]);
    const detail = a.audit("forward")[0]!.detail as { attachments: { source: AttachmentSource }[] };
    expect(detail.attachments.map((x) => x.source.kind)).toEqual(["forward", "path"]);
  });

  it("Drive: export formats per type, downloads as they are, and plain refusals", async () => {
    const a = await agent("drive-user", me.id);
    const doc = fake.drive.addFile(ME, { name: "Notes", mimeType: "application/vnd.google-apps.document" });
    const sheet = fake.drive.addFile(ME, { name: "Numbers", mimeType: "application/vnd.google-apps.spreadsheet" });
    const zip = fake.drive.addFile(ME, { name: "archive.zip", mimeType: "application/zip", content: Buffer.from("PK\u0003\u0004") });
    const exe = fake.drive.addFile(ME, { name: "setup.exe", mimeType: "application/x-msdownload", content: Buffer.from("MZ") });
    const folder = fake.drive.addFile(ME, { name: "Stuff", mimeType: "application/vnd.google-apps.folder" });
    const send = (attachment: Record<string, unknown>) => a.call("send_message", { to: "x@example.org", subject: "s", body: "b", attachments: [attachment] });

    for (const [export_as, name, mime] of [
      ["docx", "Notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["md", "Notes.md", "text/markdown"],
      ["txt", "Notes.txt", "text/plain"],
    ] as const) {
      expect((await send({ drive_file_id: doc, export_as })).isError).toBe(false);
      expect((await filesOf(me.id, lastSent(ME))).map((f) => [f.filename, f.mimeType])).toEqual([[name, mime]]);
    }
    expect((await send({ drive_file_id: sheet, export_as: "xlsx" })).isError).toBe(false);
    expect((await filesOf(me.id, lastSent(ME)))[0]!.filename).toBe("Numbers.xlsx");
    expect((await send({ drive_file_id: zip })).isError).toBe(false);
    expect((await filesOf(me.id, lastSent(ME)))[0]).toMatchObject({ filename: "archive.zip", mimeType: "application/zip" });

    expect((await send({ drive_file_id: sheet, export_as: "docx" })).text).toMatch(/Numbers is a Google Sheet, which exports as pdf, xlsx, csv, not docx/);
    expect((await send({ drive_file_id: zip, export_as: "pdf" })).text).toMatch(/export_as only applies to Google Docs, Sheets, Slides and Drawings/);
    expect((await send({ drive_file_id: exe })).text).toMatch(/setup\.exe: Gmail doesn't allow sending \.exe files/);
    expect((await send({ drive_file_id: folder })).text).toMatch(/is a Drive folder/);
    expect((await send({ drive_file_id: "1doesNotExist" })).text).toMatch(/no Drive file 1doesNotExist that office@example\.com can open/);
    // An item mixing sources matches none of the four shapes.
    expect((await send({ drive_file_id: zip, path: "/etc/passwd" })).isError).toBe(true);
  });

  it("Drive without the scope: the plain message, and nothing is asked of Drive", async () => {
    const a = await agent("no-drive", noDrive.id);
    fake.drive.addFile(NODRIVE, { id: "1someFileId", name: "x.pdf", mimeType: "application/pdf", content: pdf(100) });
    const before = fake.requests.filter((q) => q.path.startsWith("/drive/")).length;
    const r = await a.call("send_message", { to: "x@example.org", subject: "s", body: "b", attachments: [{ drive_file_id: "1someFileId" }] });
    expect(r).toMatchObject({
      isError: true,
      text: expect.stringContaining(
        "Drive isn't enabled for nodrive@example.com: install the google-workspace extension and enable Drive in xaq (Connections → Google Workspace)",
      ),
    });
    expect(fake.requests.filter((q) => q.path.startsWith("/drive/")).length).toBe(before);
    expect(a.audit("send_message")[0]).toMatchObject({ outcome: "error", reason: "drive_not_enabled" });
  });

  it("Gmail's 25 MB of attachments: names the file and sizes, offers the Drive link, and downloads nothing", async () => {
    const a = await agent("big-sender", me.id);
    const posts = () => fake.requests.filter((q) => q.method === "POST" && /\/(drafts|messages\/send)$/.test(q.path)).length;
    const before = posts();
    const huge = fake.drive.addFile(ME, { name: "scan.tiff", mimeType: "image/tiff", content: Buffer.alloc(26_000_000, 5) });
    const served = fake.drive.served.length;
    const r = await a.call("send_message", { to: "x@example.org", subject: "s", body: "b", attachments: [{ drive_file_id: huge }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/scan\.tiff \(26\.0 MB\) doesn't fit: the message would be 26\.0 MB, and Gmail sends at most 25 MB per message \(body and attachments together\)\./);
    expect(r.text).toContain(`Put its Drive link in the body instead: https://drive.google.com/file/d/${huge}/view`);
    expect(fake.drive.served.length).toBe(served);

    // Mixed sources whose total is over: a 10 MB local file and 16 MB in the call. This agent can use Drive, so the
    // advice is a Drive link; the local file is never read.
    const mixed = await a.call("send_message", {
      to: "x@example.org",
      subject: "s",
      body: "b",
      attachments: [{ path: join(docs, "big.bin") }, { content_base64: Buffer.alloc(16_000_000, 1).toString("base64"), filename: "sixteen.bin" }],
    });
    expect(mixed.text).toMatch(/sixteen\.bin \(16\.0 MB\) doesn't fit: the message would be 26\.0 MB/);
    expect(mixed.text).toMatch(/Files: big\.bin 10\.0 MB, sixteen\.bin 16\.0 MB\./);
    expect(mixed.text).toMatch(/Share large files from Google Drive and put the link in the body instead\./);
    // Under the limit, the same two sources go out.
    const ok = await a.call("send_message", {
      to: "x@example.org",
      subject: "s",
      body: "b",
      attachments: [{ path: join(docs, "big.bin") }, { content_base64: Buffer.alloc(14_000_000, 1).toString("base64"), filename: "fourteen.bin" }],
    });
    expect(ok.isError).toBe(false);
    const sentNow = posts();

    // A Drive file whose metadata understates its size is cut off at what still fits, and refused.
    const liar = fake.drive.addFile(ME, { name: "liar.bin", mimeType: "application/octet-stream", content: Buffer.alloc(26_000_000, 9), size: "1000" });
    const cut = await a.call("send_message", { to: "x@example.org", subject: "s", body: "b", attachments: [{ drive_file_id: liar }] });
    expect(cut.text).toMatch(/liar\.bin \(over 25\.0 MB\) doesn't fit/);
    expect(cut.text).toContain(`https://drive.google.com/file/d/${liar}/view`);

    // A Google export over Drive's own 10 MB export limit.
    const deck = fake.drive.addFile(ME, { name: "Deck", mimeType: "application/vnd.google-apps.presentation", exports: { "application/pdf": Buffer.alloc(11 * 1024 * 1024, 1) } });
    const tooBig = await a.call("send_message", { to: "x@example.org", subject: "s", body: "b", attachments: [{ drive_file_id: deck }] });
    expect(tooBig.text).toMatch(/Deck is too large for Google Drive to export as a file \(Google exports at most 10 MB\)\. Put its link in the body instead: https:\/\/docs\.google\.com\/presentation\/d\//);

    // An agent that can't use Drive gets "smaller files or a link".
    const b = await agent("big-no-drive", me.id, {}, false);
    const plain = await b.call("send_message", {
      to: "x@example.org",
      subject: "s",
      body: "b",
      attachments: [{ path: join(docs, "big.bin") }, { path: join(docs, "big.bin") }, { path: join(docs, "big.bin") }],
    });
    expect(plain.text).toMatch(/big\.bin \(10\.0 MB\) doesn't fit.*Send fewer or smaller files, or share large ones as a link\./);

    expect(posts()).toBe(sentNow);
    expect(sentNow).toBe(before + 1);
    expect(a.audit("send_message").filter((e) => e.reason === "too_large").length).toBe(4);
  });

  it("the API's 35 MB for the encoded message: a body that grows when encoded is refused, with the Drive link", async () => {
    const a = await agent("long-body", me.id);
    const posts = () => fake.requests.filter((q) => q.method === "POST" && /\/(drafts|messages\/send)$/.test(q.path)).length;
    const before = posts();
    // 18 MB of body plus a small file: under 25 MB of bytes, but quoted-printable turns "a=" into "a=3D" (about
    // 37.5 MB once encoded), over the 36,700,160 bytes Gmail's upload endpoint accepts.
    const body = "a=".repeat(9_000_000);
    const pic = fake.drive.addFile(ME, { name: "pic.png", mimeType: "image/png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]) });
    const r = await a.call("send_message", { to: "x@example.org", subject: "s", body, attachments: [{ drive_file_id: pic }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^The message is 3[6-9]\.\d MB once encoded for email, and Gmail's API accepts at most 35 MB \(36,700,160 bytes\) per message once it is encoded for email\./);
    expect(r.text).toContain(`Put the Drive links in the body instead of attaching: pic.png: https://drive.google.com/file/d/${pic}/view`);
    // The same body without files, as a draft: refused too, with the general advice.
    const d = await a.call("create_draft", { to: "x@example.org", subject: "s", body });
    expect(d.text).toMatch(/36,700,160 bytes.*Share large files from Google Drive and put the link in the body instead\./);
    expect(posts()).toBe(before);
    expect(a.audit("send_message")[0]).toMatchObject({ outcome: "error", reason: "too_large" });
  });

  it("Drive needs the agent's grant on a Google Workspace connection bound to the same account", async () => {
    const id = fake.drive.addFile(ME, { name: "plan.pdf", mimeType: "application/pdf", content: pdf(400) });
    const send = (x: Awaited<ReturnType<typeof agent>>) => x.call("send_message", { to: "x@example.org", subject: "s", body: "b", attachments: [{ drive_file_id: id }] });
    const denied = "This agent has no access to Google Drive for office@example.com: grant it the Google Workspace connection.";
    const driveCalls = () => fake.requests.filter((q) => q.path.startsWith("/drive/")).length;
    const before = driveCalls();

    // Mail access alone (the account has the Drive scope): refused, audited as a denial, Drive never asked.
    const mailOnly = await agent("mail-only", me.id, {}, false);
    expect(await send(mailOnly)).toMatchObject({ isError: true, text: expect.stringContaining(denied) });
    expect(mailOnly.audit("send_message")[0]).toMatchObject({ outcome: "denied", reason: "capability" });

    // A grant on a Google Workspace connection bound to another account, on an unbound one, on a disabled one,
    // or on another extension's connection bound to this account: still refused.
    const elsewhere = await agent("elsewhere", me.id, {}, false);
    grantConnection(elsewhere.id, workspaceConnection(noDrive.id));
    grantConnection(elsewhere.id, workspaceConnection(null));
    grantConnection(elsewhere.id, workspaceConnection(me.id, { status: "disabled" }));
    grantConnection(elsewhere.id, workspaceConnection(me.id, { preset: "notion" }));
    expect((await send(elsewhere)).text).toContain(denied);
    expect(driveCalls()).toBe(before);

    // Any level on the bound connection is enough: read, ask or full.
    for (const level of ["read", "ask", "full"] as const) {
      const ok = await agent(`granted-${level}`, me.id, {}, level);
      const r = await send(ok);
      expect(r.isError).toBe(false);
      expect((await filesOf(me.id, lastSent(ME))).map((f) => f.filename)).toEqual(["plan.pdf"]);
    }

    // With connections switched off (Settings → MCP broker), connection grants give nothing.
    const granted = await agent("granted-off", me.id);
    ctx.settings.update({ brokerUpstreams: false });
    try {
      expect((await send(granted)).text).toContain(denied);
    } finally {
      ctx.settings.update({ brokerUpstreams: true });
    }
  });

  it("another message's attachment needs read access, the message in scope, and an id it lists", async () => {
    const src = fake.deliver(ME, { from: "a@example.org", subject: "Private", text: "x", attachments: [{ filename: "private.pdf", mimeType: "application/pdf", content: pdf(300) }] });
    const sendOnly = await agent("send-only", me.id, { capabilities: ["send"] });
    const att = { message_id: src.id, attachment_id: partId(src, "private.pdf") };
    expect((await sendOnly.call("send_message", { to: "x@example.org", subject: "s", body: "b", attachments: [att] })).text).toMatch(
      /Attaching another message's file needs permission to read and search mail/,
    );
    const label = fake.addLabel(ME, "Shared");
    const scoped = await agent("scoped", me.id, { labelScope: [label] });
    expect((await scoped.call("send_message", { to: "x@example.org", subject: "s", body: "b", attachments: [att] })).isError).toBe(true);
    const reader = await agent("reader", me.id);
    expect((await reader.call("send_message", { to: "x@example.org", subject: "s", body: "b", attachments: [{ message_id: src.id, attachment_id: "nope" }] })).text).toMatch(
      new RegExp(`Message ${src.id} has no attachment nope\\. Its attachments: .*private\\.pdf`),
    );
  });

  it("refused paths are audited with what was asked for; path attachments follow the setting", async () => {
    const a = await agent("path-user", me.id);
    const r = await a.call("send_message", { to: "x@example.org", subject: "s", body: "b", attachments: [{ path: join(ctx.config.dataDir, "master.key") }] });
    expect(r).toMatchObject({ isError: true, text: expect.stringMatching(/can never be attached|isn't inside a directory the owner allowed/) });
    expect(a.audit("send_message")[0]).toMatchObject({
      outcome: "error",
      reason: "path_not_allowed",
      detail: expect.objectContaining({ attachmentsRequested: [{ kind: "path", path: join(ctx.config.dataDir, "master.key") }] }),
    });

    ctx.settings.update({ attachmentDirs: [] });
    try {
      const off = await a.call("send_message", { to: "x@example.org", subject: "s", body: "b", attachments: [{ path: join(docs, "contracts", "lease.pdf") }] });
      expect(off.text).toMatch(/Attaching files from a path is off.*Settings → Attachments from files/);
    } finally {
      ctx.settings.update({ attachmentDirs: [docs] });
    }
  });

  it("no agent tool can change the attachment directories", async () => {
    const a = await agent("curious", me.id, { capabilities: ["read", "draft", "send", "organize", "trash"] });
    void a;
    const { agent: x } = ctx.policy.createAgent({ name: "lister", grants: [grantInput(me.id, { capabilities: ["read", "draft", "send", "organize", "trash"] })] });
    const c = await connectAgent(ctx, x.id, "lister");
    closers.push(c.close);
    const { tools } = await c.client.listTools();
    const schemas = JSON.stringify(tools);
    expect(schemas).not.toMatch(/attachmentDirs|attachment_dirs|attachment-dirs/);
    expect(tools.map((t) => t.name).filter((n) => /setting/i.test(n))).toEqual([]);
  });
});
