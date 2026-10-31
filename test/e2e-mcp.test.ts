// E2E 5: the agent journey over MCP (SDK client, streamable HTTP, bearer key) against the real server:
// tool sets per grant, reading cleaned content, label scope, drafts, every send mode including the
// console approval flow, allowlist and rate-limit denials in the audit log, and the event feed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Account, AgentTestResult, AgentWithKey, Approval, AuditEntry, GrantInput, Page, Settings } from "../shared/types.ts";
import { HAS_AGENTS } from "./e2e/features.ts";
import { gmailHeader, grant, mailbox, type Stack, startStack } from "./e2e/harness.ts";
import { type Agent, attachmentIds, feedCursor, feedLastSeq, MCP_TEXT, sendStatus } from "./e2e/mcp.ts";
import { waitFor } from "./e2e/wait.ts";

const READ_TOOLS = ["ack_events", "get_attachment", "get_message", "get_thread", "list_accounts", "list_attachments", "list_events", "list_labels", "search_threads", "wait_for_events"];
const SEND_TOOLS = ["forward", "get_send_status", "reply", "send_message"];

let s: Stack;
let email: string;
let account: Account;
let support: string;
const agents: Agent[] = [];

/** Creates an agent through the console API and connects an MCP client with its key. */
async function agentWith(name: string, g: Partial<GrantInput>, onAccount = account): Promise<{ id: string; mcp: Agent }> {
  const { agent, apiKey } = await s.createAgent(name, [grant(onAccount.id, g)]);
  const mcp = await s.agent(apiKey);
  agents.push(mcp);
  return { id: agent.id, mcp };
}

const audit = async (agentId: string, outcome?: string) =>
  (await s.admin.get<Page<AuditEntry>>(`/api/audit?agentId=${agentId}${outcome ? `&outcome=${outcome}` : ""}`)).items;

function deliverOrder(subject = "Order #42 is late") {
  return s.fake.deliver(email, {
    from: "Alice Client <alice@client.test>",
    subject,
    html: "<p>Where is order <b>#42</b>? See <a href=\"https://shop.test/o/42\">the order</a>.</p>",
    labelIds: ["INBOX", "UNREAD", support],
    headers: { "Authentication-Results": "mx.google.com; spf=pass; dkim=fail; dmarc=fail" },
  });
}

describe.runIf(HAS_AGENTS)("MCP agent journey", () => {
  beforeAll(async () => {
    s = await startStack();
    email = mailbox("mcp");
    [account] = (await s.bootstrap({ accounts: [{ email, name: "Support Desk" }] })) as [Account];
    support = s.fake.addLabel(email, "Support");
    s.fake.addLabel(email, "VIP");
  });
  afterAll(async () => {
    await Promise.allSettled(agents.map((a) => a.close()));
    await s.close();
  });

  it("rejects missing or unknown keys", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
    for (const auth of [undefined, "Bearer aib_not-a-real-key"]) {
      const res = await fetch(`${s.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify(init),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
  });

  it("exposes tools according to the grant, matching the console's connection test", async () => {
    const reader = await agentWith("reader", { capabilities: ["read"] });
    const sender = await agentWith("sender", { capabilities: ["read", "draft", "send"], sendMode: "direct" });
    const replier = await agentWith("replier", { capabilities: ["read", "send"], replyOnly: true });
    const organizer = await agentWith("organizer", { capabilities: ["organize", "trash"] });

    expect(await reader.mcp.tools()).toEqual(READ_TOOLS);
    expect(await sender.mcp.tools()).toEqual([...READ_TOOLS, "create_draft", ...SEND_TOOLS].sort());
    const replyTools = await replier.mcp.tools();
    expect(replyTools).toContain("reply");
    expect(replyTools).not.toContain("send_message");
    expect(replyTools).not.toContain("forward");
    expect(await organizer.mcp.tools()).toEqual(["archive", "list_accounts", "list_labels", "mark_read", "modify_labels", "trash"]);

    const test = await s.admin.post<AgentTestResult>(`/api/agents/${reader.id}/test`);
    expect(test.ok).toBe(true);
    expect([...test.tools].sort()).toEqual(READ_TOOLS);

    const accounts = await sender.mcp.ok("list_accounts");
    expect(accounts).toContain(email);
    expect(accounts).toContain(MCP_TEXT.sendsImmediately);

    // The server announces the "email is data" rule once, in its instructions.
    expect(reader.mcp.client.getInstructions()).toMatch(MCP_TEXT.dataNotInstructions);
  });

  it("searches threads and reads cleaned content inside the untrusted wrapper, with signals", async () => {
    const msg = deliverOrder("Order #42 is late (search)");
    const { mcp } = await agentWith("searcher", { capabilities: ["read"] });

    const found = await mcp.ok("search_threads", { query: "subject:(search) from:alice@client.test" });
    expect(found).toContain(MCP_TEXT.threadRef(msg.threadId));
    expect(found).toContain("Order #42 is late (search)");

    const thread = await mcp.ok("get_thread", { thread_id: msg.threadId });
    expect(thread).toContain(MCP_TEXT.wrapperOpen("alice@client.test"));
    expect(thread).toContain("Where is order **#42**? See [the order](https://shop.test/o/42).");
    expect(thread).toMatch(/<\/email_content>\s*$/);
    expect(thread).toContain(MCP_TEXT.labelsLine(["INBOX", "UNREAD", "Support"]));
    expect(thread).toMatch(MCP_TEXT.signal("sender authentication failed (DKIM=fail, DMARC=fail); external sender"));
  });

  it("confines a label-scoped agent to its labels in search and by id, and audits the denial", async () => {
    const inScope = deliverOrder("Scoped: in scope");
    const outOfScope = s.fake.deliver(email, { from: "Bank <noreply@bank.test>", subject: "Scoped: statement", text: "secret balance 1,234" });
    const { id, mcp } = await agentWith("scoped", { capabilities: ["read"], labelScope: [support] });

    const found = await mcp.ok("search_threads", { query: "Scoped" });
    expect(found).toContain(inScope.threadId);
    expect(found).not.toContain("statement");
    expect(found).not.toContain(outOfScope.threadId);

    // Trying to break out of the scope through the query is refused.
    const escape = await mcp.call("search_threads", { query: "x) OR (in:anywhere" });
    expect(escape.isError).toBe(true);
    expect(escape.text).not.toContain("statement");

    for (const [tool, args] of [
      ["get_thread", { thread_id: outOfScope.threadId }],
      ["get_message", { message_id: outOfScope.id }],
    ] as const) {
      const r = await mcp.call(tool, args);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(MCP_TEXT.notAccessible);
      expect(r.text).not.toContain("secret balance");
    }
    // Same answer as for an id that doesn't exist (no existence oracle).
    const missing = await mcp.call("get_message", { message_id: "ffffffffffffffff" });
    expect(missing.text).toMatch(MCP_TEXT.notAccessible);

    // Thread-level scope: a follow-up without the label is visible because its thread carries it.
    const followUp = s.fake.deliver(email, { from: "alice@client.test", subject: "Re: Scoped: in scope", text: "any news?", threadId: inScope.threadId });
    expect(followUp.threadId).toBe(inScope.threadId);
    expect(await mcp.ok("get_message", { message_id: followUp.id })).toContain("any news?");

    const denied = await audit(id, "denied");
    expect(denied.map((e) => [e.action, e.reason])).toEqual(expect.arrayContaining([["get_thread", "label_scope"], ["get_message", "label_scope"]]));
    expect(denied[0]).toMatchObject({ actorType: "agent", actorId: id, actorName: "scoped", accountId: account.id });
  });

  it("creates drafts", async () => {
    const { mcp } = await agentWith("drafter", { capabilities: ["read", "draft"] });
    const before = s.fake.drafts(email).length;
    const out = await mcp.ok("create_draft", { to: "Bob <bob@partner.test>", subject: "Proposal", body: "Draft **body**" });
    expect(out).toContain("draft_created");
    const drafts = s.fake.drafts(email);
    expect(drafts).toHaveLength(before + 1);
    const draft = drafts.find((d) => out.includes(d.id))!;
    expect(gmailHeader(draft.message, "Subject")).toBe("Proposal");
    expect(gmailHeader(draft.message, "To")).toContain("bob@partner.test");
    expect(gmailHeader(draft.message, "From")).toContain(email);
  });

  it("reply in draft_only mode saves a threaded draft and sends nothing", async () => {
    const msg = deliverOrder("Draft-only order");
    const { mcp } = await agentWith("draft-only", { capabilities: ["read", "send"], sendMode: "draft_only" });
    const sentBefore = s.fake.sent(email).length;
    const r = await mcp.json<{ status: string; draftId: string }>("reply", { message_id: msg.id, body: "Looking into it." });
    expect(r.status).toBe("draft_created");
    const draft = s.fake.drafts(email).find((d) => d.id === r.draftId)!;
    expect(draft.message.threadId).toBe(msg.threadId);
    expect(gmailHeader(draft.message, "In-Reply-To")).toBe(gmailHeader(msg, "Message-ID"));
    expect(s.fake.sent(email)).toHaveLength(sentBefore);
  });

  it("reply in approval mode queues an approval; approving in the console sends it threaded", async () => {
    const msg = deliverOrder("Approval order");
    const { id, mcp } = await agentWith("approver", { capabilities: ["read", "send"], sendMode: "approval", allowTo: ["*@client.test"] });
    const stream = await s.admin.stream();
    try {
      const r = await mcp.json<{ status: string; approvalId: string; expiresAt: string }>("reply", {
        message_id: msg.id,
        body: "It ships **today**.",
        reason: "customer asked for status",
      });
      expect(r.status).toBe("pending_approval");
      expect(s.fake.sent(email).some((m) => m.threadId === msg.threadId)).toBe(false);

      const pending = await s.admin.get<Approval[]>("/api/approvals?status=pending");
      const approval = pending.find((a) => a.id === r.approvalId)!;
      expect(approval).toMatchObject({
        agentId: id,
        agentName: "approver",
        accountId: account.id,
        accountEmail: email,
        kind: "reply",
        status: "pending",
        to: [{ email: "alice@client.test" }],
        subject: "Re: Approval order",
        body: "It ships **today**.",
        threadId: msg.threadId,
        reason: "customer asked for status",
      });
      expect(s.fake.drafts(email).map((d) => d.id)).toContain(approval.draftId);
      await stream.next("approval", (a) => a.id === r.approvalId && a.status === "pending");
      expect(sendStatus(await mcp.ok("get_send_status", { approval_id: r.approvalId }))).toBe("pending");

      const decided = await s.admin.post<Approval>(`/api/approvals/${r.approvalId}/approve`, { note: "lgtm" });
      expect(decided).toMatchObject({ status: "sent", decisionNote: "lgtm", error: null });
      expect(decided.sentMessageId).toBeTruthy();
      await stream.next("approval", (a) => a.id === r.approvalId && a.status === "sent");

      const sent = s.fake.sent(email).find((m) => m.id === decided.sentMessageId)!;
      expect(sent.threadId).toBe(msg.threadId);
      expect(gmailHeader(sent, "Subject")).toBe("Re: Approval order");
      expect(gmailHeader(sent, "To")).toContain("alice@client.test");
      expect(gmailHeader(sent, "In-Reply-To")).toBe(gmailHeader(msg, "Message-ID"));
      expect(gmailHeader(sent, "References")).toContain(gmailHeader(msg, "Message-ID")!);
      expect(s.fake.drafts(email).map((d) => d.id)).not.toContain(approval.draftId);

      expect(sendStatus(await mcp.ok("get_send_status", { approval_id: r.approvalId }))).toBe("sent");
      const twice = await s.admin.failure(s.admin.post(`/api/approvals/${r.approvalId}/approve`));
      expect(twice.status).toBe(409);

      // Ingest reports the send as message.sent.
      await s.waitForEvent((e) => e.type === "message.sent" && e.message?.id === decided.sentMessageId);
    } finally {
      stream.close();
    }
  });

  it("rejecting an approval deletes the draft and tells the agent", async () => {
    const msg = deliverOrder("Reject order");
    const { mcp } = await agentWith("rejected", { capabilities: ["read", "send"], sendMode: "approval" });
    const r = await mcp.json<{ approvalId: string }>("reply", { message_id: msg.id, body: "Refund approved!" });
    const approval = await s.admin.get<Approval>(`/api/approvals/${r.approvalId}`);
    expect(s.fake.drafts(email).map((d) => d.id)).toContain(approval.draftId);

    const decided = await s.admin.post<Approval>(`/api/approvals/${r.approvalId}/reject`, { note: "no refunds" });
    expect(decided).toMatchObject({ status: "rejected", decisionNote: "no refunds", sentMessageId: null });
    expect(s.fake.drafts(email).map((d) => d.id)).not.toContain(approval.draftId);
    expect(s.fake.sent(email).some((m) => m.threadId === msg.threadId)).toBe(false);
    const status = await mcp.ok("get_send_status", { approval_id: r.approvalId });
    expect(sendStatus(status)).toBe("rejected");
    expect(status).toContain("no refunds");
  });

  it("direct mode sends immediately; a reply into that thread raises thread.reply_received", async () => {
    const msg = deliverOrder("Direct order");
    const { mcp } = await agentWith("direct", { capabilities: ["read", "send"], sendMode: "direct" });
    const r = await mcp.json<{ status: string; messageId: string; threadId: string }>("reply", { message_id: msg.id, body: "Shipped." });
    expect(r).toMatchObject({ status: "sent", threadId: msg.threadId });
    const sent = s.fake.message(email, r.messageId)!;
    expect(sent.labelIds).toContain("SENT");
    expect(gmailHeader(sent, "In-Reply-To")).toBe(gmailHeader(msg, "Message-ID"));
    await s.waitForEvent((e) => e.type === "message.sent" && e.message?.id === r.messageId);

    const answer = s.fake.deliver(email, { from: "alice@client.test", subject: "Re: Direct order", text: "Thanks!", threadId: msg.threadId });
    await s.waitForEvent((e) => e.type === "thread.reply_received" && e.message?.id === answer.id);

    const fresh = await mcp.json<{ status: string; messageId: string }>("send_message", { to: "bob@partner.test", subject: "Hello", body: "New thread" });
    expect(fresh.status).toBe("sent");
    expect(gmailHeader(s.fake.message(email, fresh.messageId)!, "To")).toContain("bob@partner.test");
  });

  it("returns allowTo and rate-limit denials to the agent and records them in the audit log", async () => {
    const { id, mcp } = await agentWith("limited", {
      capabilities: ["read", "send"],
      sendMode: "direct",
      allowTo: ["*@client.test"],
      maxSendsPerHour: 1,
    });
    const sentBefore = s.fake.sent(email).length;

    const blocked = await mcp.call("send_message", { to: ["alice@client.test", "mallory@evil.test"], subject: "Data", body: "x" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain(MCP_TEXT.allowToDenied("mallory@evil.test"));
    expect(s.fake.sent(email)).toHaveLength(sentBefore);

    expect((await mcp.json<{ status: string }>("send_message", { to: "alice@client.test", subject: "One", body: "first" })).status).toBe("sent");
    const limited = await mcp.call("send_message", { to: "alice@client.test", subject: "Two", body: "second" });
    expect(limited.isError).toBe(true);
    expect(limited.text).toMatch(MCP_TEXT.rateLimited(1, 1));
    expect(s.fake.sent(email)).toHaveLength(sentBefore + 1);

    const denied = await audit(id, "denied");
    expect(denied.map((e) => [e.action, e.reason])).toEqual([
      ["send_message", "rate_limit"],
      ["send_message", "allow_to"],
    ]);
    for (const e of denied) expect(e).toMatchObject({ actorType: "agent", actorName: "limited", accountId: account.id, outcome: "denied" });
    expect((await audit(id, "ok")).filter((e) => e.action === "send_message")).toHaveLength(1);
  });

  it("wait_for_events resolves as soon as new mail arrives", async () => {
    const own = mailbox("feed-wait");
    const acc = await s.connectAccount(own);
    const { mcp } = await agentWith("waiter", { capabilities: ["read"] }, acc);
    expect(await mcp.ok("list_events")).toMatch(MCP_TEXT.noEvents);

    const started = Date.now();
    const waiting = mcp.ok("wait_for_events", { timeout_seconds: 20 });
    setTimeout(() => s.fake.deliver(own, { from: "Ping <ping@else.test>", subject: "Wake up", text: "now" }), 300);
    const out = await waiting;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out).toMatch(MCP_TEXT.eventCount(1));
    expect(out).toContain("message.received");
    expect(out).toContain("Subject: Wake up");
    // Thread labels are the console's (label scopes match them); agents never see them.
    expect(out).not.toMatch(/threadLabelIds|thread_label_ids/i);

    // Times out empty when nothing arrives.
    const quiet = await mcp.ok("wait_for_events", { timeout_seconds: 1, after: feedCursor(out) });
    expect(quiet).toMatch(MCP_TEXT.quietFor(1));
  });

  it("list_events / ack_events: cursor semantics", async () => {
    const own = mailbox("feed-ack");
    const acc = await s.connectAccount(own);
    const { mcp } = await agentWith("acker", { capabilities: ["read"] }, acc);
    for (const n of [1, 2, 3]) s.fake.deliver(own, { from: "seq@else.test", subject: `Feed ${n}`, text: String(n) });
    await s.waitForEvent((e) => e.accountId === acc.id && e.message?.subject === "Feed 3");
    const events = (await s.events({ accountId: acc.id })).sort((a, b) => a.seq - b.seq);
    expect(events.map((e) => e.message?.subject)).toEqual(["Feed 1", "Feed 2", "Feed 3"]);
    const [e1, e2, e3] = events as [(typeof events)[0], (typeof events)[0], (typeof events)[0]];

    const page = await mcp.ok("list_events", { limit: 2 });
    expect(page).toMatch(MCP_TEXT.eventCount(2));
    expect(page).not.toMatch(/threadLabelIds|thread_label_ids/i);
    expect(page).toContain(MCP_TEXT.eventLine(e1.seq));
    expect(page).toContain(MCP_TEXT.eventLine(e2.seq));
    expect(feedCursor(page)).toBe(e2.seq);
    expect(feedLastSeq(page)).toBe(e2.seq);

    // Not acked yet: listing again starts from the beginning.
    expect(await mcp.ok("list_events", { limit: 2 })).toContain(MCP_TEXT.eventLine(e1.seq));
    // Explicit cursor continues.
    const rest = await mcp.ok("list_events", { after: e2.seq });
    expect(rest).toMatch(MCP_TEXT.eventCount(1));
    expect(rest).toContain(MCP_TEXT.eventLine(e3.seq));

    expect(await mcp.ok("ack_events", { seq: e2.seq })).toBe(MCP_TEXT.acked(e2.seq));
    const afterAck = await mcp.ok("list_events");
    expect(afterAck).toMatch(MCP_TEXT.eventCount(1));
    expect(afterAck).toContain(MCP_TEXT.eventLine(e3.seq));

    // Acks never move backwards.
    await mcp.ok("ack_events", { seq: e1.seq });
    expect(await mcp.ok("list_events")).toContain(MCP_TEXT.eventLine(e3.seq));
    await mcp.ok("ack_events", { seq: e3.seq });
    expect(await mcp.ok("list_events")).toMatch(MCP_TEXT.emptyFeed());

    // Type filter.
    expect(await mcp.ok("list_events", { after: 0, types: ["message.sent"] })).toMatch(MCP_TEXT.noEvents);
    await waitFor(async () => (await mcp.ok("list_events", { after: 0, types: ["message.received"] })).match(MCP_TEXT.eventCount(3)) !== null, { what: "3 received events" });
  });

  it("lists attachments and returns text and image attachments", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const msg = s.fake.deliver(email, {
      from: "finance@vendor.test",
      subject: "Q3 report",
      text: "See attached.",
      attachments: [
        { filename: "report.csv", mimeType: "text/csv", content: "region,revenue\nEU,100\nUS,200" },
        { filename: "chart.png", mimeType: "image/png", content: png },
      ],
    });
    const ev = await s.waitForEvent((e) => e.message?.id === msg.id);
    expect(ev.message!.hasAttachments).toBe(true);

    const { mcp } = await agentWith("attachments", { capabilities: ["read"] });
    expect(await mcp.ok("search_threads", { query: "has:attachment subject:Q3" })).toContain(msg.threadId);
    const out = await mcp.ok("get_message", { message_id: msg.id });
    const ids = attachmentIds(out);
    expect(out).toMatch(/Attachments: report\.csv \(text\/csv, .*\); chart\.png \(image\/png, /);
    expect(ids).toHaveLength(2);

    const csv = await mcp.ok("get_attachment", { message_id: msg.id, attachment_id: ids[0] });
    expect(csv).toContain(MCP_TEXT.wrapperOpen("finance@vendor.test"));
    expect(csv).toContain("| EU | 100 |");
    const image = await mcp.call("get_attachment", { message_id: msg.id, attachment_id: ids[1] });
    expect(image.isError).toBe(false);
    const parts = image.raw.content as { type: string; data?: string; mimeType?: string }[];
    expect(parts.find((p) => p.type === "image")).toMatchObject({ mimeType: "image/png", data: png.toString("base64") });
  });

  it("organizes mail (labels, archive, read state) within the label scope", async () => {
    const inScope = deliverOrder("Organize me");
    const outside = s.fake.deliver(email, { from: "x@else.test", subject: "Not mine", text: "z" });
    // Ingested before the changes below, so they become label events (not part of message.received).
    await s.waitForEvent((e) => e.message?.id === inScope.id);
    const vip = s.fake.addLabel(email, "VIP"); // created in beforeAll
    const { id, mcp } = await agentWith("organizer-scoped", { capabilities: ["read", "organize"], labelScope: [support, vip] });

    expect(await mcp.ok("modify_labels", { thread_id: inScope.threadId, add: ["VIP"] })).toContain("VIP");
    expect(s.fake.message(email, inScope.id)!.labelIds).toContain(vip);
    await mcp.ok("mark_read", { message_id: inScope.id });
    expect(s.fake.message(email, inScope.id)!.labelIds).not.toContain("UNREAD");
    await mcp.ok("archive", { thread_id: inScope.threadId });
    expect(s.fake.message(email, inScope.id)!.labelIds).not.toContain("INBOX");
    await s.waitForEvent((e) => e.type === "label.removed" && e.message?.id === inScope.id && !!e.labelIds?.includes("INBOX"));

    const protectedLabel = await mcp.call("modify_labels", { thread_id: inScope.threadId, add: ["TRASH"] });
    expect(protectedLabel.isError).toBe(true);
    // A scoped agent can't name (or pull threads into) labels outside its scope.
    const narrow = await agentWith("organizer-narrow", { capabilities: ["read", "organize"], labelScope: [support] });
    const outsideLabel = await narrow.mcp.call("modify_labels", { thread_id: inScope.threadId, add: ["VIP"] });
    expect(outsideLabel.isError).toBe(true);
    expect((await audit(narrow.id, "denied")).map((e) => e.reason)).toEqual(["label_scope"]);
    for (const [tool, args] of [
      ["archive", { thread_id: outside.threadId }],
      ["mark_read", { message_id: outside.id }],
      ["modify_labels", { thread_id: outside.threadId, add: ["VIP"] }],
    ] as const) {
      const r = await mcp.call(tool, args);
      expect(r.isError, tool).toBe(true);
    }
    expect(s.fake.message(email, outside.id)!.labelIds).toEqual(expect.arrayContaining(["INBOX", "UNREAD"]));
    expect(s.fake.message(email, outside.id)!.labelIds).not.toContain(vip);
    expect((await audit(id, "denied")).filter((e) => e.reason === "label_scope")).toHaveLength(3);
  });

  it("can use a label that was created in Gmail moments ago", async () => {
    const msg = deliverOrder("Fresh label");
    const { mcp } = await agentWith("fresh-label", { capabilities: ["read", "organize"] });
    await mcp.ok("list_labels"); // warms the label cache, as any earlier tool call would
    const name = `Fresh ${Date.now()}`;
    const id = s.fake.addLabel(email, name);
    await mcp.ok("modify_labels", { thread_id: msg.threadId, add: [name] });
    expect(s.fake.message(email, msg.id)!.labelIds).toContain(id);
  });

  it("revokes MCP access when the agent is disabled, its key rotated or the agent deleted", async () => {
    const created = await s.createAgent("lifecycle", [grant(account.id)]);
    const mcp = await s.agent(created.apiKey);
    agents.push(mcp);
    expect(await mcp.tools()).toContain("list_accounts");

    await s.admin.patch(`/api/agents/${created.agent.id}`, { disabled: true });
    await expect(mcp.tools()).rejects.toThrow();
    expect((await s.admin.post<AgentTestResult>(`/api/agents/${created.agent.id}/test`)).ok).toBe(false);
    await s.admin.patch(`/api/agents/${created.agent.id}`, { disabled: false });
    expect(await mcp.tools()).toContain("list_accounts");

    const rotated = await s.admin.post<AgentWithKey>(`/api/agents/${created.agent.id}/rotate-key`);
    expect(rotated.apiKey).not.toBe(created.apiKey);
    await expect(mcp.tools()).rejects.toThrow();
    const fresh = await s.agent(rotated.apiKey);
    agents.push(fresh);
    expect(await fresh.tools()).toContain("list_accounts");

    await s.admin.del(`/api/agents/${created.agent.id}`);
    await expect(fresh.tools()).rejects.toThrow();
    expect((await s.admin.failure(s.admin.get(`/api/agents/${created.agent.id}`))).status).toBe(404);
  });

  it("only feeds an agent events from its own accounts and label scope; out-of-scope mail doesn't wake wait_for_events", async () => {
    const mine = mailbox("feed-mine");
    const theirs = mailbox("feed-theirs");
    const accMine = await s.connectAccount(mine);
    await s.connectAccount(theirs);
    const label = s.fake.addLabel(mine, "Agent");
    const { mcp } = await agentWith("isolated", { capabilities: ["read"], labelScope: [label] }, accMine);

    s.fake.deliver(theirs, { from: "o@else.test", subject: "Other account", text: "x" });
    s.fake.deliver(mine, { from: "o@else.test", subject: "Out of scope", text: "x" });
    await s.waitForEvent((e) => e.message?.subject === "Out of scope");
    await s.waitForEvent((e) => e.message?.subject === "Other account");
    const quiet = await mcp.ok("wait_for_events", { timeout_seconds: 1 });
    expect(quiet).toMatch(MCP_TEXT.quietFor(1));

    const waiting = mcp.ok("wait_for_events", { timeout_seconds: 20 });
    setTimeout(() => s.fake.deliver(mine, { from: "o@else.test", subject: "For the agent", text: "y", labelIds: ["INBOX", label] }), 200);
    const out = await waiting;
    expect(out).toMatch(MCP_TEXT.eventCount(1));
    expect(out).toContain("For the agent");
    expect(out).not.toContain("Out of scope");
    expect(out).not.toContain("Other account");
  });

  it("truncates bodies to the operator's maxBodyChars", async () => {
    const before = await s.admin.get<Settings>("/api/settings");
    const msg = s.fake.deliver(email, { from: "long@else.test", subject: "Long one", text: "word ".repeat(200) });
    const { mcp } = await agentWith("truncated", { capabilities: ["read"] });
    try {
      await s.admin.patch("/api/settings", { maxBodyChars: 100 });
      const out = await mcp.ok("get_message", { message_id: msg.id });
      expect(out).toMatch(MCP_TEXT.truncated(100));
      const body = MCP_TEXT.wrappedBody.exec(out)![1]!;
      expect(body.length).toBeLessThanOrEqual(100);
    } finally {
      await s.admin.patch("/api/settings", { maxBodyChars: before.maxBodyChars });
    }
  });

  it("forward respects the allowlist before reading the original", async () => {
    const msg = deliverOrder("Forward me");
    const { id, mcp } = await agentWith("forwarder", { capabilities: ["read", "send"], sendMode: "direct", allowTo: ["*@partner.test"] });
    const denied = await mcp.call("forward", { message_id: msg.id, to: "leak@evil.test" });
    expect(denied.isError).toBe(true);
    expect((await audit(id, "denied")).map((e) => [e.action, e.reason])).toEqual([["forward", "allow_to"]]);
    const ok = await mcp.json<{ status: string; messageId: string }>("forward", { message_id: msg.id, to: "bob@partner.test", body: "FYI" });
    expect(ok.status).toBe("sent");
    const sent = s.fake.message(email, ok.messageId)!;
    expect(gmailHeader(sent, "Subject")).toBe("Fwd: Forward me");
    expect(gmailHeader(sent, "To")).toContain("bob@partner.test");
  });

  it("asks multi-account agents to pick an account and resolves it by email or id", async () => {
    const second = mailbox("mcp-second");
    const acc2 = await s.connectAccount(second);
    const msg = s.fake.deliver(second, { from: "z@else.test", subject: "Second box", text: "hello two" });
    const { agent, apiKey } = await s.createAgent("multi", [grant(account.id), grant(acc2.id)]);
    const mcp = await s.agent(apiKey);
    agents.push(mcp);
    const list = await mcp.ok("list_accounts");
    expect(list).toContain(MCP_TEXT.accountCount(2));
    const ambiguous = await mcp.call("search_threads", { query: "Second box" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain(second);
    expect(await mcp.ok("search_threads", { account: second, query: "Second box" })).toContain(msg.threadId);
    expect(await mcp.ok("get_message", { account: acc2.id, message_id: msg.id })).toContain("hello two");
    const wrong = await mcp.call("get_message", { account: "nobody@nowhere.test", message_id: msg.id });
    expect(wrong.isError).toBe(true);
    expect((await audit(agent.id, "denied")).map((e) => e.reason)).toContain("capability");
  });

  it("sends exactly once when two admins approve the same request concurrently", async () => {
    const msg = deliverOrder("Double click");
    const { mcp } = await agentWith("double", { capabilities: ["read", "send"], sendMode: "approval" });
    const r = await mcp.json<{ approvalId: string }>("reply", { message_id: msg.id, body: "Once only" });
    const results = await Promise.allSettled([
      s.admin.post<Approval>(`/api/approvals/${r.approvalId}/approve`),
      s.admin.post<Approval>(`/api/approvals/${r.approvalId}/approve`),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { status: number }).status).toBe(409);
    expect(s.fake.sent(email).filter((m) => m.threadId === msg.threadId)).toHaveLength(1);
    expect((await s.admin.get<Approval>(`/api/approvals/${r.approvalId}`)).status).toBe("sent");
  });
});
