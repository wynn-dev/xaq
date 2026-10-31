// E2E 7: restart durability. Mail that arrives while the server is down is ingested exactly once;
// resyncs never duplicate events; agent keys, cursors and pending approvals survive a restart.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Account, Approval, MailEvent, SetupStatus } from "../shared/types.ts";
import { HAS_AGENTS } from "./e2e/features.ts";
import { feedLastSeq, MCP_TEXT } from "./e2e/mcp.ts";
import { grant, mailbox, type Stack, startStack } from "./e2e/harness.ts";
import { sleep } from "./e2e/wait.ts";

let s: Stack;
let email: string;
let account: Account;
let apiKey: string;

beforeAll(async () => {
  s = await startStack();
  email = mailbox("restart");
  [account] = (await s.bootstrap({ accounts: [email] })) as [Account];
  if (!HAS_AGENTS) return;
  apiKey = (await s.createAgent("durable", [grant(account.id, { capabilities: ["read"] })])).apiKey;
});
afterAll(async () => {
  await s.close();
});

const bySubject = (events: MailEvent[], subject: string) => events.filter((e) => e.message?.subject === subject);

describe("restart durability", () => {
  it("keeps the admin session across a restart", async () => {
    await s.restart();
    expect(await s.admin.get<SetupStatus>("/api/setup/status")).toEqual({ claimed: true, authenticated: true });
  });

  it.runIf(HAS_AGENTS)("keeps agent keys and event cursors across a restart", async () => {
    const msg = s.fake.deliver(email, { from: "Ops <ops@vendor.test>", subject: "Before restart", text: "x" });
    await s.waitForEvent((e) => e.message?.id === msg.id);
    const mcp = await s.agent(apiKey);
    const before = await mcp.ok("list_events", { limit: 100 });
    const lastSeq = feedLastSeq(before);
    await mcp.ok("ack_events", { seq: lastSeq });
    await mcp.close();

    await s.restart();
    expect(await s.admin.get<SetupStatus>("/api/setup/status")).toEqual({ claimed: true, authenticated: true });
    const again = await s.agent(apiKey);
    try {
      expect(await again.ok("list_events")).toMatch(MCP_TEXT.emptyFeed(lastSeq, lastSeq));
    } finally {
      await again.close();
    }
  });

  it("ingests mail that arrived while the server was down exactly once, and resyncs don't duplicate events", async () => {
    await s.stopServer();
    const down1 = s.fake.deliver(email, { from: "a@vendor.test", subject: "While down 1", text: "1" });
    const down2 = s.fake.deliver(email, { from: "b@vendor.test", subject: "While down 2", text: "2" });
    await s.restart();

    await s.waitForEvent((e) => e.message?.id === down1.id);
    await s.waitForEvent((e) => e.message?.id === down2.id);
    const live = s.fake.deliver(email, { from: "c@vendor.test", subject: "After restart", text: "3" });
    await s.waitForEvent((e) => e.message?.id === live.id);
    await sleep(300); // let any late duplicate sync be processed

    // A manual resync and an expired history cursor both re-scan recent mail; dedupe keeps one event each.
    await s.admin.post(`/api/accounts/${account.id}/resync`);
    s.fake.expireHistory(email);
    const trigger = s.fake.deliver(email, { from: "d@vendor.test", subject: "After expiry", text: "4" });
    await s.waitForEvent((e) => e.message?.id === trigger.id);

    const events = await s.events({ accountId: account.id });
    for (const subject of ["While down 1", "While down 2", "After restart", "After expiry"]) {
      expect(bySubject(events, subject).filter((e) => e.type === "message.received"), subject).toHaveLength(1);
    }
    const gaps = events.filter((e) => e.type === "sync.gap");
    expect(gaps.map((e) => e.detail?.reason).sort()).toEqual(["history_expired", "manual"]);

  });

  it.runIf(HAS_AGENTS)("keeps a pending approval across a restart and sends it when approved afterwards", async () => {
    const sender = await s.createAgent("restart-sender", [grant(account.id, { capabilities: ["read", "send"], sendMode: "approval" })]);
    const msg = s.fake.deliver(email, { from: "Alice <alice@client.test>", subject: "Pending over restart", text: "?" });
    const mcp = await s.agent(sender.apiKey);
    const r = await mcp.json<{ approvalId: string }>("reply", { message_id: msg.id, body: "Answer after restart" });
    await mcp.close();

    await s.restart();
    const pending = await s.admin.get<Approval[]>("/api/approvals?status=pending");
    expect(pending.map((a) => a.id)).toContain(r.approvalId);
    const sent = await s.admin.post<Approval>(`/api/approvals/${r.approvalId}/approve`);
    expect(sent.status).toBe("sent");
    expect(s.fake.sent(email).some((m) => m.id === sent.sentMessageId && m.threadId === msg.threadId)).toBe(true);
  });
});
