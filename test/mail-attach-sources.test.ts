// Attachment sources over MCP, against the fake Google: bytes in the call and another message's attachment, mixed
// in one message, on send_message, create_draft, reply and forward; Gmail's 25 MB of attachments and the API's 35 MB
// for the encoded message; and what approval cards and the audit log say about each file's source.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Account, AttachmentSource, GrantInput } from "../shared/types.ts";
import type { AppContext } from "../server/context.ts";
import { GMAIL_SCOPE } from "../server/google/scopes.ts";
import type { GmailMessage } from "../server/google/types.ts";
import { connectFakeAccount, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";
import { connectAgent, grantInput } from "./mail-fakes.ts";

const ME = "office@example.com";
const IDENTITY = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"];

let fake: FakeGoogle;
let ctx: AppContext;
let dispose: () => Promise<void>;
let me: Account;
const closers: (() => Promise<void>)[] = [];

const pdf = (size: number, seed = 1) => {
  const out = Buffer.alloc(size);
  Buffer.from("%PDF-1.7\n").copy(out);
  for (let i = 9; i < size; i++) out[i] = (i * 31 + seed) % 256;
  return out;
};

/** An MCP agent with a mail grant on `accountId`. */
async function agent(name: string, accountId: string, g: Partial<GrantInput> = {}) {
  const { agent: a } = ctx.policy.createAgent({ name, grants: [grantInput(accountId, { capabilities: ["read", "draft", "send"], sendMode: "direct", ...g })] });
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
  me = await connectFakeAccount(ctx, fake, ME, { name: "Office", scopes: [GMAIL_SCOPE, ...IDENTITY] });
});
afterAll(async () => {
  for (const c of closers) await c().catch(() => {});
  await dispose();
  await fake.close();
});

describe("attachment sources", () => {
  it("both sources, mixed in one message: bytes and another message's file", async () => {
    const a = await agent("mixer", me.id);
    const invoice = pdf(5000, 2);
    const src = fake.deliver(ME, { from: "Vendor <billing@vendor.test>", subject: "Invoice", text: "Attached.", attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", content: invoice }] });

    const r = await a.json("send_message", {
      to: "client@example.org",
      subject: "Documents",
      body: "Everything attached.",
      attachments: [
        { content_base64: Buffer.from("hello").toString("base64"), filename: "hello.txt" },
        { message_id: src.id, attachment_id: partId(src, "invoice.pdf") },
      ],
    });
    expect(r.status).toBe("sent");
    const files = await filesOf(me.id, lastSent(ME));
    expect(files.map((f) => [f.filename, f.mimeType])).toEqual([
      ["hello.txt", "text/plain"],
      ["invoice.pdf", "application/pdf"],
    ]);
    expect(files[1]!.data.equals(invoice)).toBe(true);

    // The audit log records each file's source (and name, type, size, sha256), never content.
    const detail = a.audit("send_message")[0]!.detail as { attachments: { filename: string; source: AttachmentSource; sha256: string }[] };
    expect(detail.attachments.map((x) => x.source)).toEqual([
      { kind: "upload" },
      { kind: "message", messageId: src.id, attachmentId: partId(src, "invoice.pdf"), filename: "invoice.pdf" },
    ]);
    expect(detail.attachments.every((x) => /^[0-9a-f]{64}$/.test(x.sha256))).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(invoice.toString("base64").slice(0, 40));
  });

  it("approval cards show where each file came from", async () => {
    const a = await agent("approver", me.id, { sendMode: "approval" });
    const src = fake.deliver(ME, { from: "hr@example.org", subject: "Form", text: "Form attached", attachments: [{ filename: "form.pdf", mimeType: "application/pdf", content: pdf(800) }] });
    const r = await a.json("reply", {
      message_id: src.id,
      body: "Filled in, plus my notes.",
      reason: "user asked",
      attachments: [
        { content_base64: Buffer.from("target").toString("base64"), filename: "notes.txt" },
        { message_id: src.id, attachment_id: partId(src, "form.pdf") },
      ],
    });
    expect(r.status).toBe("pending_approval");
    const approval = ctx.mail.getApproval(r.approvalId!)!;
    expect(approval.attachments).toEqual([
      { filename: "notes.txt", mimeType: "text/plain", size: 6, source: { kind: "upload" } },
      { filename: "form.pdf", mimeType: "application/pdf", size: 800, source: { kind: "message", messageId: src.id, attachmentId: partId(src, "form.pdf"), filename: "form.pdf" } },
    ]);
    // Approval follows the grant's policy, unchanged: nothing went out yet.
    expect(fake.sent(ME).some((m) => ctx.google.mime.parse(m).summary.subject === "Re: Form")).toBe(false);
  });

  it("create_draft and forward take new attachments too; forward keeps include_attachments", async () => {
    const a = await agent("forwarder", me.id);
    const lease = { content_base64: pdf(3000, 7).toString("base64"), filename: "lease.pdf" };
    const draft = await a.json("create_draft", { to: "x@example.org", subject: "Draft", body: "b", attachments: [lease] });
    expect(draft.status).toBe("draft_created");
    const stored = fake.drafts(ME).find((d) => d.id === draft.draftId)!;
    expect((await filesOf(me.id, stored.message)).map((f) => f.filename)).toEqual(["lease.pdf"]);

    const src = fake.deliver(ME, { from: "a@example.org", subject: "Plans", text: "See plan", attachments: [{ filename: "plan.pdf", mimeType: "application/pdf", content: pdf(1200) }] });
    const sent = await a.json("forward", { message_id: src.id, to: "team@example.org", include_attachments: true, attachments: [lease] });
    expect(sent.status).toBe("sent");
    expect((await filesOf(me.id, lastSent(ME))).map((f) => f.filename)).toEqual(["plan.pdf", "lease.pdf"]);
    const detail = a.audit("forward")[0]!.detail as { attachments: { source: AttachmentSource }[] };
    expect(detail.attachments.map((x) => x.source.kind)).toEqual(["forward", "upload"]);
  });

  it("Gmail's 25 MB of attachments: names the file and sizes, and downloads nothing", async () => {
    const a = await agent("big-sender", me.id);
    const posts = () => fake.requests.filter((q) => q.method === "POST" && /\/(drafts|messages\/send)$/.test(q.path)).length;
    const downloads = () => fake.requests.filter((q) => q.path.includes("/attachments/")).length;
    const before = posts();
    const scan = fake.deliver(ME, { from: "a@example.org", subject: "Scan", text: "x", attachments: [{ filename: "scan.tiff", mimeType: "image/tiff", content: Buffer.alloc(26_000_000, 5) }] });
    const big = fake.deliver(ME, { from: "a@example.org", subject: "Big", text: "x", attachments: [{ filename: "big.bin", mimeType: "application/octet-stream", content: Buffer.alloc(10_000_000, 3) }] });
    const fetched = downloads();
    const r = await a.call("send_message", { to: "x@example.org", subject: "s", body: "b", attachments: [{ message_id: scan.id, attachment_id: partId(scan, "scan.tiff") }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/scan\.tiff \(26\.0 MB\) doesn't fit: the message would be 26\.0 MB, and Gmail sends at most 25 MB per message \(body and attachments together\)\./);
    expect(r.text).toContain("Send fewer or smaller files, or share large ones as a link.");

    // Mixed sources whose total is over: another message's 10 MB file and 16 MB in the call. The file is never fetched.
    const bigPart = { message_id: big.id, attachment_id: partId(big, "big.bin") };
    const mixed = await a.call("send_message", {
      to: "x@example.org",
      subject: "s",
      body: "b",
      attachments: [bigPart, { content_base64: Buffer.alloc(16_000_000, 1).toString("base64"), filename: "sixteen.bin" }],
    });
    expect(mixed.text).toMatch(/sixteen\.bin \(16\.0 MB\) doesn't fit: the message would be 26\.0 MB/);
    expect(mixed.text).toMatch(/Files: big\.bin 10\.0 MB, sixteen\.bin 16\.0 MB\./);
    expect(downloads()).toBe(fetched);
    // Under the limit, the same two sources go out.
    const ok = await a.call("send_message", {
      to: "x@example.org",
      subject: "s",
      body: "b",
      attachments: [bigPart, { content_base64: Buffer.alloc(14_000_000, 1).toString("base64"), filename: "fourteen.bin" }],
    });
    expect(ok.isError).toBe(false);
    const sentNow = posts();

    // A forward whose original files are over: the advice is to leave them out.
    const fwd = await a.call("forward", { message_id: scan.id, to: "team@example.org", include_attachments: true });
    expect(fwd.text).toMatch(/scan\.tiff \(26\.0 MB\) doesn't fit.*Forward without include_attachments\./);

    expect(posts()).toBe(sentNow);
    expect(sentNow).toBe(before + 1);
    expect(a.audit("send_message").filter((e) => e.reason === "too_large").length).toBe(2);
  });

  it("the API's 35 MB for the encoded message: a body that grows when encoded is refused", async () => {
    const a = await agent("long-body", me.id);
    const posts = () => fake.requests.filter((q) => q.method === "POST" && /\/(drafts|messages\/send)$/.test(q.path)).length;
    const before = posts();
    // 18 MB of body plus a small file: under 25 MB of bytes, but quoted-printable turns "a=" into "a=3D" (about
    // 37.5 MB once encoded), over the 36,700,160 bytes Gmail's upload endpoint accepts.
    const body = "a=".repeat(9_000_000);
    const pic = { content_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]).toString("base64"), filename: "pic.png" };
    const r = await a.call("send_message", { to: "x@example.org", subject: "s", body, attachments: [pic] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^The message is 3[6-9]\.\d MB once encoded for email, and Gmail's API accepts at most 35 MB \(36,700,160 bytes\) per message once it is encoded for email\./);
    expect(r.text).toContain("Send fewer or smaller files, or share large ones as a link.");
    // The same body without files, as a draft: refused too.
    const d = await a.call("create_draft", { to: "x@example.org", subject: "s", body });
    expect(d.text).toMatch(/36,700,160 bytes/);
    expect(posts()).toBe(before);
    expect(a.audit("send_message")[0]).toMatchObject({ outcome: "error", reason: "too_large" });
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
});
