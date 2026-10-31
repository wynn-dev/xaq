// E2E: files attached by an agent over MCP, against the fake Google. In-thread reply drafts with a PDF
// (JSON and /upload/ paths), approval-mode sends that show their files to the human and send them on
// approval, refusals (Gmail-blocked types, over 25 MB) before anything reaches Google, the audit record
// (names, types, sizes and hashes, never content) and the /mcp body limit (4 MB unless the agent key is valid).

import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Account, AgentWithKey, Approval, AuditEntry, GrantInput, Page } from "../shared/types.ts";
import type { GmailMessage } from "../server/google/types.ts";
import { HAS_AGENTS } from "./e2e/features.ts";
import { gmailHeader, grant, mailbox, type Stack, startStack } from "./e2e/harness.ts";
import type { Agent } from "./e2e/mcp.ts";

// Path attachments check against the home directory's secret places (~/.xaq, ~/.ssh, …): give them a temporary one.
process.env.HOME = mkdtempSync(join(tmpdir(), "xaq-e2e-home-"));
for (const v of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) delete process.env[v];

let s: Stack;
let email: string;
let account: Account;
const agents: Agent[] = [];

/** A small but real-looking PDF, padded to `size` bytes. */
const pdf = (size = 4096) => {
  const head = Buffer.from("%PDF-1.7\n% tenant form\n");
  const out = Buffer.alloc(size, 0x20);
  head.copy(out);
  for (let i = head.length; i < size; i++) out[i] = (i * 31) % 256;
  return out;
};
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function agentWith(name: string, g: Partial<GrantInput>): Promise<{ id: string; mcp: Agent; key: string }> {
  const { agent, apiKey }: AgentWithKey = await s.createAgent(name, [grant(account.id, g)]);
  const mcp = await s.agent(apiKey);
  agents.push(mcp);
  return { id: agent.id, mcp, key: apiKey };
}

const audit = async (agentId: string) => (await s.admin.get<Page<AuditEntry>>(`/api/audit?agentId=${agentId}`)).items;

/** The stored message's attachments and their bytes, through the Gmail client. */
async function filesOf(msg: GmailMessage) {
  const parsed = s.ctx.google.mime.parse(msg);
  const gmail = s.ctx.google.gmail(account.id);
  return Promise.all(
    parsed.attachments.map(async (a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      data: Buffer.from((await gmail.getAttachment(msg.id, a.id)).data, "base64url"),
    })),
  );
}

function leaseRequest(subject: string) {
  return s.fake.deliver(email, {
    from: "Landlord <leasing@offices.test>",
    subject,
    text: "Please fill in the attached tenant form and send it back.",
    labelIds: ["INBOX", "UNREAD"],
  });
}

describe.runIf(HAS_AGENTS)("MCP attachments", () => {
  beforeAll(async () => {
    s = await startStack();
    email = mailbox("attach");
    [account] = (await s.bootstrap({ accounts: [{ email, name: "Office Manager" }] })) as [Account];
  });
  afterAll(async () => {
    await Promise.allSettled(agents.map((a) => a.close()));
    await s.close();
  });

  it("reply in draft_only mode: an in-thread draft carrying the PDF (JSON body)", async () => {
    const msg = leaseRequest("Tenant form");
    const { id, mcp } = await agentWith("form-filler", { capabilities: ["read", "send"], sendMode: "draft_only" });
    const file = pdf(4096);
    const r = await mcp.json<{ status: string; draftId: string }>("reply", {
      message_id: msg.id,
      body: "Here is the completed form.",
      attachments: [{ filename: "Tenant form (filled).pdf", mime_type: "application/pdf", content_base64: file.toString("base64") }],
    });
    expect(r.status).toBe("draft_created");

    const draft = s.fake.drafts(email).find((d) => d.id === r.draftId)!;
    expect(draft.message.threadId).toBe(msg.threadId);
    expect(gmailHeader(draft.message, "Subject")).toBe("Re: Tenant form");
    expect(gmailHeader(draft.message, "In-Reply-To")).toBe(gmailHeader(msg, "Message-ID"));
    expect(gmailHeader(draft.message, "References")).toContain(gmailHeader(msg, "Message-ID")!);
    expect(draft.message.payload?.mimeType).toBe("multipart/mixed");
    const files = await filesOf(draft.message);
    expect(files.map((f) => [f.filename, f.mimeType])).toEqual([["Tenant form (filled).pdf", "application/pdf"]]);
    expect(files[0]!.data.equals(file)).toBe(true);

    const entry = (await audit(id)).find((e) => e.action === "reply")!;
    expect(entry.outcome).toBe("ok");
    expect(entry.detail).toMatchObject({ attachments: [{ filename: "Tenant form (filled).pdf", mimeType: "application/pdf", size: 4096, sha256: sha256(file) }] });
    expect(JSON.stringify(entry)).not.toContain(file.toString("base64").slice(0, 40));
  });

  it("create_draft in a thread with a 5 MB PDF: over the old 4 MB /mcp limit, sent through the multipart upload", async () => {
    const msg = leaseRequest("Lease documents");
    const { mcp } = await agentWith("drafter", { capabilities: ["read", "draft"] });
    const file = pdf(5 * 1024 * 1024);
    const before = s.fake.uploads.length;
    const out = await mcp.ok("create_draft", {
      to: "leasing@offices.test",
      subject: "Re: Lease documents",
      body: "Signed lease attached.",
      thread_id: msg.threadId,
      // url-safe base64 is accepted too, and the path in the name is dropped.
      attachments: [{ filename: "/home/me/Downloads/lease-signed.pdf", content_base64: file.toString("base64url") }],
    });
    expect(out).toContain("draft_created");
    expect(s.fake.uploads.slice(before)).toEqual([
      { path: "/upload/gmail/v1/users/me/drafts", uploadType: "multipart", metadata: { message: { threadId: msg.threadId } }, size: expect.any(Number) },
    ]);
    const draft = s.fake.drafts(email).find((d) => out.includes(d.id))!;
    expect(draft.message.threadId).toBe(msg.threadId);
    expect(gmailHeader(draft.message, "In-Reply-To")).toBe(gmailHeader(msg, "Message-ID"));
    const files = await filesOf(draft.message);
    expect(files.map((f) => [f.filename, f.mimeType])).toEqual([["lease-signed.pdf", "application/pdf"]]);
    expect(files[0]!.data.equals(file)).toBe(true);
  });

  it("approval mode: the console sees each file's name, type and size; approving sends them", async () => {
    const { mcp } = await agentWith("approval-sender", { capabilities: ["read", "send"], sendMode: "approval", allowTo: ["*@offices.test"] });
    const form = pdf(2048);
    const r = await mcp.json<{ status: string; approvalId: string }>("send_message", {
      to: "leasing@offices.test",
      subject: "Tenant application",
      body: "Application and ID attached.",
      reason: "user asked to apply for the office",
      attachments: [
        { filename: "application.pdf", mime_type: "application/pdf", content_base64: form.toString("base64") },
        { filename: "notes.txt", content_base64: Buffer.from("Move-in: March").toString("base64") },
      ],
    });
    expect(r.status).toBe("pending_approval");

    const approval = await s.admin.get<Approval>(`/api/approvals/${r.approvalId}`);
    expect(approval.attachments).toEqual([
      { filename: "application.pdf", mimeType: "application/pdf", size: 2048, source: { kind: "upload" } },
      { filename: "notes.txt", mimeType: "text/plain", size: 14, source: { kind: "upload" } },
    ]);
    expect(JSON.stringify(approval)).not.toContain(form.toString("base64").slice(0, 40));
    const draft = s.fake.drafts(email).find((d) => d.id === approval.draftId)!;
    expect((await filesOf(draft.message)).map((f) => f.filename)).toEqual(["application.pdf", "notes.txt"]);

    const decided = await s.admin.post<Approval>(`/api/approvals/${r.approvalId}/approve`);
    expect(decided).toMatchObject({ status: "sent", error: null });
    const sent = s.fake.sent(email).find((m) => m.id === decided.sentMessageId)!;
    expect(gmailHeader(sent, "To")).toContain("leasing@offices.test");
    const files = await filesOf(sent);
    expect(files.map((f) => [f.filename, f.mimeType])).toEqual([
      ["application.pdf", "application/pdf"],
      ["notes.txt", "text/plain"],
    ]);
    expect(files[0]!.data.equals(form)).toBe(true);
  });

  it("the grant still decides: no draft capability, recipients outside allowTo", async () => {
    const reader = await agentWith("reader-only", { capabilities: ["read"] });
    expect(await reader.mcp.tools()).not.toContain("create_draft");
    const { mcp } = await agentWith("allowlisted", { capabilities: ["read", "send"], sendMode: "direct", allowTo: ["*@offices.test"] });
    const before = s.fake.requests.length;
    const r = await mcp.call("send_message", {
      to: "someone@elsewhere.test",
      subject: "x",
      body: "y",
      attachments: [{ filename: "a.pdf", content_base64: pdf(100).toString("base64") }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Not allowed to send to someone@elsewhere.test");
    expect(s.fake.requests.slice(before).filter((q) => q.method === "POST")).toEqual([]);
  });

  it("refuses Gmail-blocked types and messages over 25 MB before anything reaches Google", async () => {
    const msg = leaseRequest("Refusals");
    const { id, mcp } = await agentWith("refused", { capabilities: ["read", "draft", "send"], sendMode: "direct" });
    const posts = () => s.fake.requests.filter((q) => q.method === "POST" && /\/(drafts|messages\/send)$/.test(q.path)).length;
    const before = posts();

    const blocked = await mcp.call("reply", { message_id: msg.id, body: "Installer attached", attachments: [{ filename: "setup.exe", content_base64: "TVqQAAMAAAAEAAAA" }] });
    expect(blocked).toMatchObject({ isError: true, text: expect.stringMatching(/setup\.exe: Gmail doesn't allow sending \.exe files/) });

    const big = Buffer.alloc(13_000_000, 1).toString("base64");
    const tooLarge = await mcp.call("create_draft", {
      to: "leasing@offices.test",
      subject: "Scans",
      body: "Two big scans",
      attachments: [
        { filename: "scan-1.pdf", content_base64: big },
        { filename: "scan-2.pdf", content_base64: big },
      ],
    });
    expect(tooLarge.isError).toBe(true);
    expect(tooLarge.text).toMatch(/Gmail sends at most 25 MB per message/);

    const badBase64 = await mcp.call("create_draft", { to: "leasing@offices.test", subject: "x", body: "y", attachments: [{ filename: "a.pdf", content_base64: "not base64!" }] });
    expect(badBase64.text).toMatch(/content_base64 is not valid base64/);

    expect(posts()).toBe(before);
    const reasons = (await audit(id)).map((e) => [e.action, e.outcome, e.reason]);
    expect(reasons).toEqual(
      expect.arrayContaining([
        ["reply", "error", "blocked_file_type"],
        ["create_draft", "error", "too_large"],
        ["create_draft", "error", "invalid_attachment"],
      ]),
    );
  });

  it("files by path: the admin allows a directory (agents can't), the approval card shows the path", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "xaq-e2e-docs-")));
    try {
      writeFileSync(join(dir, "lease.pdf"), pdf(1500));
      const { id, mcp, key } = await agentWith("path-sender", { capabilities: ["read", "send"], sendMode: "approval" });
      const args = { to: "leasing@offices.test", subject: "Lease", body: "Attached.", attachments: [{ path: join(dir, "lease.pdf") }] };
      expect((await mcp.call("send_message", args)).text).toMatch(/Attaching files from a path is off/);

      // The setting is admin-only: an agent key gets nowhere near /api/settings.
      const asAgent = await fetch(`${s.url}/api/settings`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-xaq-csrf": "1" },
        body: JSON.stringify({ attachmentDirs: [dir] }),
      });
      expect(asAgent.status).toBe(401);
      expect((await s.admin.get<{ attachmentDirs: string[] }>("/api/settings")).attachmentDirs).toEqual([]);

      await s.admin.patch("/api/settings", { attachmentDirs: [dir] });
      const r = await mcp.json<{ status: string; approvalId: string }>("send_message", args);
      expect(r.status).toBe("pending_approval");
      const approval = await s.admin.get<Approval>(`/api/approvals/${r.approvalId}`);
      expect(approval.attachments).toEqual([{ filename: "lease.pdf", mimeType: "application/pdf", size: 1500, source: { kind: "path", path: join(dir, "lease.pdf") } }]);
      expect((await audit(id)).find((e) => e.action === "send_message" && e.outcome === "ok")?.detail).toMatchObject({
        attachments: [{ filename: "lease.pdf", source: { kind: "path", path: join(dir, "lease.pdf") }, sha256: sha256(pdf(1500)) }],
      });
    } finally {
      await s.admin.patch("/api/settings", { attachmentDirs: [] });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/mcp buffers more than 4 MB only for a valid agent key", async () => {
    const { key } = await agentWith("big-body", { capabilities: ["read"] });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(5 * 1024 * 1024) } });
    const post = (auth?: string, chunked = false) =>
      fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
        body: chunked ? new Blob([body]).stream() : body,
        ...(chunked ? { duplex: "half" } : {}),
      } as RequestInit);

    // The server answers 413 without reading the rest, then drops the connection: the client may see either.
    const refused = async (auth: string | undefined, chunked: boolean) => {
      try {
        return (await post(auth, chunked)).status;
      } catch (err) {
        return (err as { cause?: { code?: string } }).cause?.code ?? String(err);
      }
    };
    const results: unknown[] = [];
    for (const auth of [undefined, "Bearer aib_not-a-real-key", "Basic Zm9vOmJhcg=="]) {
      // With Content-Length the body is refused before it's read; without, while reading.
      for (const chunked of [false, true]) results.push(await refused(auth, chunked));
    }
    for (const r of results) expect([413, "UND_ERR_SOCKET"]).toContain(r);
    expect(results).toContain(413);
    // The refusal closes the connection, so the next request doesn't go out on a socket that is about to close.
    const small = await fetch(`${s.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(4 * 1024 * 1024 + 1) });
    expect(small.status).toBe(413);
    expect(small.headers.get("connection")).toBe("close");
    const ok = await post(`Bearer ${key}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("list_accounts");
    expect((await post(`Bearer ${key}`, true)).status).toBe(200);
  });
});
