// E2E 4: events. Mail arriving at the fake Gmail becomes an event (real ingest, polling) and shows up in
// the console list, the live stream and the overview.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Account, MailEvent, OverviewStats, Page } from "../shared/types.ts";
import { mailbox, type Stack, startStack } from "./e2e/harness.ts";

const MAIL_EVENT_KEYS = ["id", "seq", "type", "accountId", "accountEmail", "message", "labelIds", "detail", "createdAt"];
/** The console's copy also has the thread labels (label scopes match them); agents never get them. */
const CONSOLE_KEYS = [...MAIL_EVENT_KEYS, "threadLabelIds"];

let s: Stack;
let email: string;
let account: Account;

beforeAll(async () => {
  s = await startStack();
  email = mailbox("events");
  [account] = (await s.bootstrap({ accounts: [email] })) as [Account];
});
afterAll(async () => {
  await s.close();
});

describe("events in the console", () => {
  it("turns delivered mail into an event in the list and the live stream", async () => {
    const stream = await s.admin.stream();
    try {
      const sent = s.fake.deliver(email, { from: "Ann Example <ann@client.test>", subject: "Console only", text: "hello" });
      const ev = await s.waitForEvent((e) => e.message?.id === sent.id);
      expect(ev).toMatchObject({
        type: "message.received",
        accountId: account.id,
        accountEmail: email,
        message: { id: sent.id, threadId: sent.threadId, from: { name: "Ann Example", email: "ann@client.test" }, subject: "Console only", hasAttachments: false },
      });
      expect(ev.id).toMatch(/^evt_/);
      expect(Object.keys(ev).filter((k) => !CONSOLE_KEYS.includes(k))).toEqual([]);
      expect(ev.threadLabelIds).toContain("INBOX");
      expect(await stream.next("event", (e) => e.id === ev.id)).toEqual(ev);
    } finally {
      stream.close();
    }
  });

  it("records label changes as label.added / label.removed events", async () => {
    const tag = s.fake.addLabel(email, "Tagged");
    const msg = s.fake.deliver(email, { from: "t@else.test", subject: "Tag me", text: "x" });
    await s.waitForEvent((e) => e.message?.id === msg.id);
    s.fake.setLabels(email, msg.id, [tag], []);
    expect((await s.waitForEvent((e) => e.type === "label.added" && e.message?.id === msg.id)).labelIds).toEqual([tag]);
    s.fake.setLabels(email, msg.id, [], [tag]);
    expect((await s.waitForEvent((e) => e.type === "label.removed" && e.message?.id === msg.id)).labelIds).toEqual([tag]);
  });

  it("lists events newest first with cursor paging and filters", async () => {
    for (let i = 0; i < 3; i++) s.fake.deliver(email, { from: "pager@else.test", subject: `Page ${i}`, text: String(i) });
    await s.waitForEvent((e) => e.message?.subject === "Page 2");
    await s.waitForEvent((e) => e.message?.subject === "Page 0");
    const first = await s.admin.get<Page<MailEvent>>(`/api/events?accountId=${account.id}&type=message.received&limit=2`);
    expect(first.items).toHaveLength(2);
    expect(first.items[0]!.seq).toBeGreaterThan(first.items[1]!.seq);
    expect(first.nextCursor).not.toBeNull();
    const second = await s.admin.get<Page<MailEvent>>(`/api/events?accountId=${account.id}&type=message.received&limit=2&cursor=${first.nextCursor}`);
    expect(second.items[0]!.seq).toBeLessThan(first.items[1]!.seq);
    const bad = await s.admin.failure(s.admin.get("/api/events?type=nope"));
    expect(bad.status).toBe(400);
  });

  it("keeps the console stream and event list behind the admin session", async () => {
    for (const path of ["/api/events", "/api/events/stream"]) {
      const res = await fetch(`${s.url}${path}`);
      expect(res.status, path).toBe(401);
    }
  });

  it("summarizes activity on the overview", async () => {
    const m = s.fake.deliver(email, { from: "o@else.test", subject: "Overview", text: "x" });
    await s.waitForEvent((e) => e.message?.id === m.id);
    const o = await s.admin.get<OverviewStats>("/api/overview");
    const accounts = await s.admin.get<Account[]>("/api/accounts");
    expect(o.accounts.total).toBe(accounts.length);
    expect(o.accounts.needsAttention).toBe(accounts.filter((a) => a.status === "needs_reauth" || a.status === "error").length);
    expect(o.events24h).toBeGreaterThanOrEqual((await s.events()).length);
    expect(o.activity).toHaveLength(24);
    expect(o.activity.reduce((n, h) => n + h.events, 0)).toBe(o.events24h);
  });
});
