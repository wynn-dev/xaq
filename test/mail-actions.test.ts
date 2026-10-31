import { afterEach, describe, expect, it } from "vitest";
import type { GrantInput } from "../shared/types.ts";
import { connectAgent, decodeRaw, type FakeGmail, grantInput, mailTestContext } from "./mail-fakes.ts";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

const ME = "me@acme.com";

function seed(gmail: FakeGmail) {
  gmail.labels.push({ id: "Label_support", name: "Support", type: "user" }, { id: "Label_private", name: "Private", type: "user" });
  gmail
    .add({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD", "Label_support"],
      from: { name: "Alice", email: "alice@client.com" },
      to: [{ name: null, email: ME }],
      cc: [{ name: "Carol", email: "carol@client.com" }],
      subject: "Help with order",
      text: "plain",
      html: "<p>Hi, my order <b>#42</b> is late.</p>",
      messageId: "<m1@client.com>",
      references: ["<m0@client.com>"],
      attachments: [
        { id: "att-txt", filename: "notes.txt", mimeType: "text/plain", data: Buffer.from("order notes") },
        { id: "att-bin", filename: "photo.png", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ],
    })
    // A later message in t1 without the scope label: the thread stays in scope (thread-level).
    .add({
      id: "m2",
      threadId: "t1",
      labelIds: ["SENT"],
      from: { name: "Me", email: ME },
      to: [{ name: "Alice", email: "alice@client.com" }],
      subject: "Re: Help with order",
      text: "On it.",
    })
    .add({
      id: "m3",
      threadId: "t2",
      labelIds: ["INBOX", "Label_private"],
      from: { name: "Bank", email: "noreply@bank.com" },
      to: [{ name: null, email: ME }],
      subject: "Your statement",
      text: "Balance: $1,000,000",
    });
}

async function setup(grant: Partial<GrantInput> = {}, extraAccount = false) {
  const t = mailTestContext();
  cleanup.push(t.dispose);
  const gmail = t.addAccount("acc_a", ME);
  seed(gmail);
  const grants = [grantInput("acc_a", { level: "full", ...grant })];
  if (extraAccount) {
    t.addAccount("acc_b", "ops@acme.com");
    grants.push(grantInput("acc_b", { level: "full" }));
  }
  const { agent } = t.addAgent("bot", grants);
  const mcp = await connectAgent(t.ctx, agent.id, "bot");
  cleanup.push(mcp.close);
  const audits = (action?: string) => t.ctx.audit.list({ agentId: agent.id, action, limit: 200 }).items;
  return { ...t, gmail, agent, ...mcp, audits };
}

describe("reading", () => {
  it("lists accounts with their rules", async () => {
    const s = await setup({ allowTo: ["*@client.com"] });
    const r = await s.call("list_accounts");
    expect(r.text).toContain("me@acme.com (account id acc_a)");
    expect(r.text).toContain("access: full");
    expect(r.text).toContain("recipients and attendees limited to *@client.com");
  });

  it("reads a thread with cleaned, wrapped content", async () => {
    const s = await setup();
    const r = await s.call("get_thread", { thread_id: "t1" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Thread t1 in me@acme.com (2 messages");
    expect(r.text).toContain('<email_content from="alice@client.com" untrusted>\nHi, my order **#42** is late.\n</email_content>');
    expect(r.text).toContain("Labels: INBOX, UNREAD, Support");
    // Agents see stable part ids, not Gmail's per-fetch attachment ids.
    expect(r.text).toContain("notes.txt (text/plain, 11 B, attachment_id: 1)");
    expect(s.audits("get_thread")[0]).toMatchObject({ outcome: "ok", accountId: "acc_a", target: "t1", detail: { messages: 2 } });
  });

  it("returns text attachments as wrapped text and images as image content", async () => {
    const s = await setup();
    const txt = await s.call("get_attachment", { message_id: "m1", attachment_id: "att-txt" });
    expect(txt.text).toContain("Attachment notes.txt (text/plain, 11 B)");
    expect(txt.text).toContain("untrusted>\norder notes\n</email_content>");
    const img = await s.call("get_attachment", { message_id: "m1", attachment_id: "att-bin" });
    expect(img.content.map((c) => c.type)).toEqual(["text", "image"]);
  });

  it("requires an account argument when several accounts qualify", async () => {
    const s = await setup({}, true);
    const r = await s.call("get_thread", { thread_id: "t1" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/pass "account" as one of: me@acme.com, ops@acme.com/);
    expect((await s.call("get_thread", { thread_id: "t1", account: "ME@acme.com" })).isError).toBe(false);
    const nope = await s.call("get_thread", { thread_id: "t1", account: "ceo@acme.com" });
    expect(nope.text).toMatch(/no access to the account/);
    expect(s.audits("get_thread")[0]).toMatchObject({ outcome: "denied", reason: "no_access" });
  });

  it("tells the agent to ask for a reconnect when the account needs re-auth", async () => {
    const s = await setup();
    s.ctx.db.run("UPDATE accounts SET status = 'needs_reauth' WHERE id = 'acc_a'");
    const r = await s.call("search_threads", { query: "" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/needs to be reconnected.*operator.*console/);
    expect(s.audits("search_threads")[0]).toMatchObject({ outcome: "error", reason: "needs_reauth" });
  });

  it("reports missing ids as not found or not accessible", async () => {
    const s = await setup();
    const r = await s.call("get_message", { message_id: "nope" });
    expect(r.text).toMatch(/Message nope was not found or is not accessible/);
    expect(s.audits("get_message")[0]).toMatchObject({ outcome: "error", reason: "not_found" });
  });
});

describe("send rules", () => {
  it("checks the allowlist on every recipient, including reply-all and forward", async () => {
    const s = await setup({ allowTo: ["alice@client.com"] });
    const send = await s.call("send_message", { to: "alice@client.com", cc: ["eve@evil.com"], subject: "s", body: "b" });
    expect(send.text).toMatch(/Not allowed to send to eve@evil.com.*only lets you send to: alice@client.com/);
    const all = await s.call("reply", { message_id: "m1", body: "ok", reply_all: true });
    expect(all.text).toMatch(/carol@client.com/);
    const fwd = await s.call("forward", { message_id: "m1", to: "boss@elsewhere.com" });
    expect(fwd.text).toMatch(/boss@elsewhere.com/);
    expect(s.audits().filter((e) => e.reason === "allow_to")).toHaveLength(3);
    const ok = await s.call("reply", { message_id: "m1", body: "ok" });
    expect(ok.isError).toBe(false);
    expect(s.gmail.sent).toHaveLength(1);
  });

  it("sends and kicks ingest", async () => {
    const s = await setup({});
    const r = await s.call("send_message", { to: "Alice <alice@client.com>, bob@client.com", subject: "Hello", body: "Body" });
    expect(JSON.parse(r.text)).toMatchObject({ status: "sent", messageId: "sent1" });
    const raw = decodeRaw(s.gmail.sent[0]!.raw);
    expect(raw.to).toEqual([
      { name: "Alice", email: "alice@client.com" },
      { name: null, email: "bob@client.com" },
    ]);
    expect(raw.from).toEqual({ name: "Test User", email: ME });
    expect(s.kicks).toEqual(["acc_a"]);
    expect(s.audits("send_message")[0]).toMatchObject({ outcome: "ok", detail: { recipients: 2, domains: ["client.com"] } });
  });

  it("rejects invalid recipients", async () => {
    const s = await setup();
    const r = await s.call("send_message", { to: "not-an-address", subject: "s", body: "b" });
    expect(r.text).toMatch(/not a valid email address/);
    expect(s.audits("send_message")[0]).toMatchObject({ outcome: "error", reason: "invalid_recipient" });
  });
});

describe("replies and forwards", () => {
  it("threads replies and computes reply-all recipients minus the account", async () => {
    const s = await setup();
    await s.call("reply", { message_id: "m1", body: "Thanks!", reply_all: true });
    const sent = s.gmail.sent[0]!;
    expect(sent.threadId).toBe("t1");
    const raw = decodeRaw(sent.raw);
    expect(raw.subject).toBe("Re: Help with order");
    expect(raw.inReplyTo).toBe("<m1@client.com>");
    expect(raw.references).toEqual(["<m0@client.com>", "<m1@client.com>"]);
    expect(raw.to?.map((a) => a.email)).toEqual(["alice@client.com"]);
    expect(raw.cc?.map((a) => a.email)).toEqual(["carol@client.com"]);
  });

  it("replying to the account's own message goes to its original recipients", async () => {
    const s = await setup();
    await s.call("reply", { message_id: "m2", body: "Following up" });
    const raw = decodeRaw(s.gmail.sent[0]!.raw);
    expect(raw.to?.map((a) => a.email)).toEqual(["alice@client.com"]);
    expect(raw.subject).toBe("Re: Help with order");
  });

  it("forwards with a quoted, cleaned original and optional attachments", async () => {
    const s = await setup();
    await s.call("forward", { message_id: "m1", to: "team@acme.com", body: "FYI", include_attachments: true });
    const raw = decodeRaw(s.gmail.sent[0]!.raw);
    expect(s.gmail.sent[0]!.threadId).toBeNull();
    expect(raw.subject).toBe("Fwd: Help with order");
    expect(raw.text).toMatch(/^FYI\n\n---------- Forwarded message ---------\nFrom: Alice <alice@client.com>/);
    expect(raw.text).toContain("Hi, my order **#42** is late.");
    expect(raw.attachments.map((a) => a.filename)).toEqual(["notes.txt", "photo.png"]);
  });
});

describe("read only", () => {
  it("lists only reading tools and denies writes on a read-only account", async () => {
    const s = await setup({ level: "read" });
    const tools = (await s.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("search_threads");
    for (const n of ["send_message", "reply", "forward", "create_draft", "modify_labels", "trash"]) expect(tools).not.toContain(n);

    const mixed = await setup({ level: "read" }, true);
    const r = await mixed.call("send_message", { account: ME, to: "alice@client.com", subject: "s", body: "b" });
    expect(r.text).toBe("You have read-only access to me@acme.com. Accounts with full access: ops@acme.com.");
    expect(mixed.audits("send_message")[0]).toMatchObject({ outcome: "denied", reason: "read_only" });
    expect((await mixed.call("send_message", { account: "ops@acme.com", to: "alice@client.com", subject: "s", body: "b" })).isError).toBe(false);
  });
});

describe("organize and trash", () => {
  it("modifies labels by name or id and blocks protected labels", async () => {
    const s = await setup();
    const r = await s.call("modify_labels", { thread_id: "t1", add: ["support", "STARRED"], remove: ["UNREAD"] });
    expect(r.text).toMatch(/Updated thread t1\. Labels now: .*Starred|STARRED/);
    expect(s.gmail.messages.get("m1")!.labelIds).toEqual(expect.arrayContaining(["STARRED", "Label_support"]));
    expect(s.gmail.messages.get("m1")!.labelIds).not.toContain("UNREAD");
    expect((await s.call("modify_labels", { message_id: "m3", add: ["TRASH"] })).text).toMatch(/Use the trash tool/);
    expect((await s.call("modify_labels", { message_id: "m3", add: ["Nope"] })).text).toMatch(/No label named "Nope"/);
    expect((await s.call("modify_labels", { thread_id: "t1", message_id: "m1", add: ["STARRED"] })).text).toMatch(/exactly one/);
  });

  it("archives, marks read/unread and trashes", async () => {
    const s = await setup();
    await s.call("archive", { thread_id: "t2" });
    expect(s.gmail.messages.get("m3")!.labelIds).not.toContain("INBOX");
    await s.call("mark_read", { message_id: "m1" });
    expect(s.gmail.messages.get("m1")!.labelIds).not.toContain("UNREAD");
    await s.call("mark_read", { thread_id: "t2", read: false });
    expect(s.gmail.messages.get("m3")!.labelIds).toContain("UNREAD");
    const r = await s.call("trash", { thread_id: "t2" });
    expect(r.text).toBe("Moved thread t2 to the trash.");
    expect(s.gmail.messages.get("m3")!.labelIds).toContain("TRASH");
  });
});

describe("events", () => {
  it("lists visible events, formats them compactly and acks", async () => {
    const s = await setup({});
    const msg = (id: string, labelIds: string[]) => ({
      id,
      threadId: `t-${id}`,
      from: { name: "Alice", email: "alice@client.com" },
      to: [{ name: null, email: ME }],
      cc: [],
      subject: `Subject ${id}`,
      snippet: "snippet text",
      date: "2026-10-14T09:00:00.000Z",
      labelIds,
      hasAttachments: false,
    });
    const base = { accountId: "acc_a", accountEmail: ME, createdAt: "2026-10-14T09:00:00.000Z" };
    s.events.events = [
      { ...base, id: "evt_1", seq: 1, type: "message.received", message: msg("x1", ["INBOX", "Label_support"]) },
      { ...base, id: "evt_2", seq: 2, type: "message.received", message: msg("x2", ["INBOX"]) },
      { ...base, id: "evt_3", seq: 3, type: "sync.gap", message: null, detail: { reason: "history expired" } },
    ];
    const r = await s.call("list_events", { types: ["message.received", "sync.gap"] });
    expect(r.text).toContain("#1 message.received · me@acme.com");
    expect(r.text).toContain("From: Alice <alice@client.com> · To: me@acme.com · Subject: Subject x1");
    expect(r.text).toContain("thread_id: t-x1 · message_id: x1 · labels: INBOX, Support");
    expect(r.text).toContain("message_id: x2");
    expect(r.text).toContain("#3 sync.gap");
    expect(r.text).toContain("call ack_events with seq=3");
    expect((await s.call("ack_events", { seq: 3 })).text).toBe("Acknowledged up to seq 3.");
    expect((await s.call("wait_for_events", { timeout_seconds: 1 })).text).toMatch(/No new events in the last 1 s/);
    expect((await s.call("list_events", { account: "nobody@x.com" })).isError).toBe(true);
  });
});
