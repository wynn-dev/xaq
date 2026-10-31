import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Account } from "../shared/types.ts";
import { accountsApi } from "../server/api/accounts.ts";
import type { AppContext } from "../server/context.ts";
import { connectFakeAccount, type FakeGoogle, recordingEvents, startFakeGoogle } from "./fake-google.ts";
import { testContext } from "./helpers.ts";

const ME = "me@example.com";
const CLIENT = "Client Person <client@acme.test>";

let fake: FakeGoogle;
let ctx: AppContext;
let rec: ReturnType<typeof recordingEvents>;
let dispose: () => Promise<void>;
let accountId: string;

/** Ingest's single-flight sync (not part of the frozen interface; deterministic for tests). */
const sync = () => (ctx.ingest as unknown as { sync(id: string): Promise<void> }).sync(accountId);
const subjects = (type: Parameters<typeof rec.ofType>[0]) => rec.ofType(type).map((e) => e.message?.subject);

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(async () => {
  fake = await startFakeGoogle();
  rec = recordingEvents();
  const t = testContext({ events: rec.factory }, { google: fake.google });
  ctx = t.ctx;
  dispose = t.dispose;
  accountId = (await connectFakeAccount(ctx, fake, ME, { name: "Me" })).id;
});

afterEach(async () => {
  await dispose();
  await fake.close();
});

async function reply(threadId: string, subject: string) {
  const raw = await ctx.google.mime.compose({
    from: { name: "Me", email: ME },
    to: [{ name: null, email: "client@acme.test" }],
    subject,
    text: "On it.",
  });
  return ctx.google.gmail(accountId).send(raw, threadId);
}

describe("history sync", () => {
  it("starts from the connect-time cursor without backfilling", async () => {
    await sync();
    expect(rec.events).toHaveLength(0);
  });

  it("emits received, sent and reply events with thread-level label unions", async () => {
    const label = fake.addLabel(ME, "Clients");
    const first = fake.deliver(ME, { from: CLIENT, subject: "Question", text: "Can you help?", labelIds: ["INBOX", "UNREAD", label] });
    await sync();
    expect(rec.events.map((e) => e.type)).toEqual(["message.received"]);
    const received = rec.events[0]!;
    expect(received.dedupeKey).toBe(`${accountId}:${first.id}:message.received`);
    expect(received.message).toMatchObject({
      id: first.id,
      threadId: first.threadId,
      subject: "Question",
      from: { name: "Client Person", email: "client@acme.test" },
      to: [{ name: "Me", email: ME }],
      snippet: "Can you help?",
    });
    expect(received.threadLabelIds).toEqual(expect.arrayContaining(["INBOX", "UNREAD", label]));

    const sent = await reply(first.threadId, "Re: Question");
    await sync();
    const sentEv = rec.ofType("message.sent");
    expect(sentEv).toHaveLength(1);
    expect(sentEv[0]!.message!.id).toBe(sent.id);
    // The sent message has no "Clients" label itself, but its thread does.
    expect(sentEv[0]!.message!.labelIds).not.toContain(label);
    expect(sentEv[0]!.threadLabelIds).toEqual(expect.arrayContaining([label, "SENT"]));
    expect(ctx.db.get("SELECT * FROM sent_threads WHERE account_id = ? AND gmail_thread_id = ?", accountId, first.threadId)).toBeTruthy();

    const answer = fake.deliver(ME, { from: CLIENT, subject: "Re: Question", text: "Thanks!", threadId: first.threadId });
    fake.deliver(ME, { from: "news@letter.test", subject: "Weekly digest", text: "news" });
    await sync();
    expect(subjects("message.received")).toEqual(["Question", "Re: Question", "Weekly digest"]);
    const replies = rec.ofType("thread.reply_received");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ dedupeKey: `${accountId}:${answer.id}:thread.reply_received` });
    expect(replies[0]!.threadLabelIds).toEqual(expect.arrayContaining([label, "SENT", "INBOX"]));

    const acct = ctx.accounts.get(accountId)!;
    const profile = await ctx.google.gmail(accountId).getProfile();
    expect(acct.historyId).toBe(profile.historyId);
    expect(acct.lastSyncAt).not.toBeNull();
  });

  it("detects replies in threads the account sent into before xaq saw it", async () => {
    const first = fake.deliver(ME, { from: CLIENT, subject: "Old thread", text: "hi" });
    await reply(first.threadId, "Re: Old thread");
    // Reset the cursor past those messages, as if they happened before connecting.
    ctx.db.run("UPDATE accounts SET history_id = ?", (await ctx.google.gmail(accountId).getProfile()).historyId);
    fake.deliver(ME, { from: CLIENT, subject: "Re: Old thread", text: "follow-up", threadId: first.threadId });
    await sync();
    expect(rec.ofType("thread.reply_received")).toHaveLength(1);
  });

  it("emits label changes, skipping labels on messages added in the same batch", async () => {
    const label = fake.addLabel(ME, "Billing");
    const m = fake.deliver(ME, { from: CLIENT, subject: "Invoice", text: "attached" });
    await sync();
    fake.setLabels(ME, m.id, [label, "STARRED"], ["UNREAD"]);
    const fresh = fake.deliver(ME, { from: CLIENT, subject: "Fresh", text: "new" });
    fake.setLabels(ME, fresh.id, [label], []);
    await sync();

    const added = rec.ofType("label.added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ labelIds: [label, "STARRED"], message: { id: m.id } });
    expect(added[0]!.threadLabelIds).toContain(label);
    expect(added[0]!.dedupeKey).toMatch(new RegExp(`^${accountId}:${m.id}:label\\.added:\\d+$`));
    const removed = rec.ofType("label.removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ labelIds: ["UNREAD"] });
    // The new message carries its labels in message.received instead.
    const freshEv = rec.ofType("message.received").find((e) => e.message!.id === fresh.id)!;
    expect(freshEv.message!.labelIds).toContain(label);
  });

  it("reports a message rescued from spam as received, and drops auto-classification label noise", async () => {
    const spam = fake.deliver(ME, { from: CLIENT, subject: "Not spam", text: "x", labelIds: ["SPAM", "UNREAD"] });
    await sync();
    expect(rec.events).toHaveLength(0);
    fake.setLabels(ME, spam.id, ["INBOX"], ["SPAM"]);
    await sync();
    expect(subjects("message.received")).toEqual(["Not spam"]);
    expect(rec.ofType("label.added").map((e) => e.labelIds)).toEqual([["INBOX"]]);
    expect(rec.ofType("label.removed").map((e) => e.labelIds)).toEqual([["SPAM"]]);
    // Archiving and moving back to the inbox doesn't re-announce it (dedupe key).
    fake.setLabels(ME, spam.id, [], ["INBOX"]);
    fake.setLabels(ME, spam.id, ["INBOX"], []);
    await sync();
    expect(rec.ofType("message.received")).toHaveLength(1);

    const before = rec.events.length;
    fake.setLabels(ME, spam.id, ["IMPORTANT", "CATEGORY_UPDATES"], []);
    await sync();
    expect(rec.events.length).toBe(before);
    fake.setLabels(ME, spam.id, ["STARRED", "CATEGORY_PROMOTIONS"], ["UNREAD", "IMPORTANT"]);
    await sync();
    expect(rec.events.slice(before).map((e) => [e.type, e.labelIds])).toEqual([
      ["label.added", ["STARRED"]],
      ["label.removed", ["UNREAD"]],
    ]);
  });

  it("doesn't re-announce old mail that is un-archived or restored from trash", async () => {
    const old = fake.deliver(ME, { from: CLIENT, subject: "Old", text: "x" });
    const trashed = fake.deliver(ME, { from: CLIENT, subject: "Trashed", text: "y" });
    await reply(old.threadId, "Re: Old");
    fake.setLabels(ME, old.id, [], ["INBOX"]);
    fake.setLabels(ME, trashed.id, ["TRASH"], ["INBOX"]);
    // These happened before xaq saw the mailbox.
    ctx.db.run("UPDATE accounts SET history_id = ?", (await ctx.google.gmail(accountId).getProfile()).historyId);
    fake.setLabels(ME, old.id, ["INBOX"], []);
    fake.setLabels(ME, trashed.id, ["INBOX"], ["TRASH"]);
    await sync();
    expect(rec.ofType("message.received")).toHaveLength(0);
    expect(rec.ofType("thread.reply_received")).toHaveLength(0);
    expect(rec.ofType("label.added").map((e) => [e.message!.subject, e.labelIds])).toEqual([
      ["Old", ["INBOX"]],
      ["Trashed", ["INBOX"]],
    ]);
  });

  it("advances the cursor to the last fully processed record when a sync fails midway", async () => {
    const first = fake.deliver(ME, { from: CLIENT, subject: "First", text: "1" });
    const second = fake.deliver(ME, { from: CLIENT, subject: "Second", text: "2" });
    fake.failNext({ method: "GET", path: `/messages/${second.id}`, status: 400, message: "boom" });
    await expect(sync()).rejects.toMatchObject({ status: 400 });
    expect(subjects("message.received")).toEqual(["First"]);
    expect(ctx.accounts.get(accountId)!.historyId).toBe(first.historyId);
    const fetchesOfFirst = () => fake.requests.filter((r) => r.path.endsWith(`/messages/${first.id}`)).length;
    const n = fetchesOfFirst();
    await sync();
    expect(subjects("message.received")).toEqual(["First", "Second"]);
    expect(fetchesOfFirst()).toBe(n);
    expect(ctx.accounts.get(accountId)!.historyId).toBe((await ctx.google.gmail(accountId).getProfile()).historyId);
  });

  it("ignores drafts, then reports the sent draft once", async () => {
    const gmail = ctx.google.gmail(accountId);
    const raw = await ctx.google.mime.compose({ from: { name: null, email: ME }, to: [{ name: null, email: "x@y.test" }], subject: "Draft", text: "wip" });
    const draft = await gmail.createDraft(raw);
    await sync();
    expect(rec.events).toHaveLength(0);
    const sent = await gmail.sendDraft(draft.id);
    await sync();
    expect(rec.events.map((e) => [e.type, e.message?.id])).toEqual([["message.sent", sent.id]]);
  });

  it("skips spam and dedupes when history is replayed", async () => {
    fake.deliver(ME, { from: "spam@bad.test", subject: "WIN", text: "$$$", labelIds: ["SPAM"] });
    const before = (await ctx.google.gmail(accountId).getProfile()).historyId;
    fake.deliver(ME, { from: CLIENT, subject: "Once", text: "x" });
    await sync();
    expect(subjects("message.received")).toEqual(["Once"]);
    ctx.db.run("UPDATE accounts SET history_id = ?", before);
    const emitted = rec.events.length;
    await sync();
    expect(rec.events.length).toBe(emitted);
  });

  it("runs a bounded resync and emits sync.gap when the history cursor expired", async () => {
    const old = ctx.accounts.get(accountId)!.historyId;
    fake.deliver(ME, { from: CLIENT, subject: "Before", text: "x" });
    await sync();
    fake.expireHistory(ME);
    fake.deliver(ME, { from: CLIENT, subject: "During gap", text: "y" });
    fake.deliver(ME, { from: CLIENT, subject: "Ancient", text: "z", date: new Date(Date.now() - 5 * 86400e3) });
    await sync();
    expect(subjects("message.received")).toEqual(["Before", "During gap"]);
    const gap = rec.ofType("sync.gap");
    expect(gap).toHaveLength(1);
    expect(gap[0]!.detail).toMatchObject({ reason: "history_expired", window: "newer_than:2d" });
    expect(gap[0]!.detail!.previousHistoryId).not.toBe(old);
    const acct = ctx.accounts.get(accountId)!;
    expect(acct.historyId).toBe((await ctx.google.gmail(accountId).getProfile()).historyId);

    fake.deliver(ME, { from: CLIENT, subject: "After", text: "w" });
    await sync();
    expect(subjects("message.received")).toEqual(["Before", "During gap", "After"]);
    expect(rec.ofType("sync.gap")).toHaveLength(1);
  });

  it("resyncs from the console", async () => {
    fake.deliver(ME, { from: CLIENT, subject: "Recent", text: "x" });
    const res = await accountsApi(ctx).request(`/accounts/${accountId}/resync`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Account).id).toBe(accountId);
    expect(subjects("message.received")).toEqual(["Recent"]);
    expect(rec.ofType("sync.gap")[0]!.detail).toMatchObject({ reason: "manual" });
    expect(ctx.audit.list({ action: "account.resync" }).items).toHaveLength(1);
  });

  it("skips paused accounts and resumes", async () => {
    const app = accountsApi(ctx);
    const call = async (path: string) => (await (await app.request(`/accounts/${accountId}/${path}`, { method: "POST" })).json()) as Account;
    expect((await call("pause")).status).toBe("paused");
    fake.deliver(ME, { from: CLIENT, subject: "While paused", text: "x" });
    await sync();
    expect(rec.events).toHaveLength(0);
    expect((await call("resume")).status).toBe("active");
    await waitFor(() => rec.events.length > 0);
    expect(subjects("message.received")).toEqual(["While paused"]);
  });

  it("refuses to pause an account that needs reauth", async () => {
    ctx.accounts.setStatus(accountId, "needs_reauth", "revoked");
    await expect(ctx.ingest.pause(accountId)).rejects.toThrow(/needs to be reconnected/);
    await expect(ctx.ingest.resume(accountId)).rejects.toThrow(/needs to be reconnected/);
    expect(ctx.accounts.get(accountId)!.status).toBe("needs_reauth");
  });

  it("stops syncing an account whose refresh token was revoked", async () => {
    fake.failRefresh(ME);
    fake.deliver(ME, { from: CLIENT, subject: "Unseen", text: "x" });
    await expect(sync()).resolves.toBeUndefined();
    expect(ctx.accounts.get(accountId)!.status).toBe("needs_reauth");
    expect(rec.ofType("account.auth_failed")).toHaveLength(1);
    const calls = fake.requests.length;
    await sync();
    expect(fake.requests.length).toBe(calls);
    expect(rec.ofType("message.received")).toHaveLength(0);
  });

  it("marks the account errored on persistent failures and recovers", async () => {
    fake.failNext({ path: "/history", status: 400, message: "Bad request" });
    fake.deliver(ME, { from: CLIENT, subject: "Later", text: "x" });
    await expect(sync()).rejects.toMatchObject({ status: 400 });
    expect(ctx.accounts.get(accountId)).toMatchObject({ status: "error", lastError: "Sync failed: Bad request" });
    await sync();
    expect(ctx.accounts.get(accountId)).toMatchObject({ status: "active", lastError: null });
    expect(subjects("message.received")).toEqual(["Later"]);
  });
});

describe("poll loop", () => {
  it("syncs on start, on kick, reacts to settings and stops promptly", async () => {
    ctx.settings.update({ pollIntervalSeconds: 5 });
    ctx.ingest.start?.();
    await waitFor(() => ctx.ingest.status().lastPullAt !== null);
    expect(ctx.ingest.status()).toMatchObject({ running: true, lastError: null });
    fake.deliver(ME, { from: CLIENT, subject: "Polled", text: "x" });
    ctx.ingest.kick();
    await waitFor(() => rec.events.length === 1);
    // Changing the interval restarts the loop (which syncs immediately).
    const pulled = ctx.ingest.status().lastPullAt;
    fake.deliver(ME, { from: CLIENT, subject: "After restart", text: "y" });
    ctx.settings.update({ pollIntervalSeconds: 6 });
    await waitFor(() => rec.events.length === 2);
    expect(ctx.ingest.status().lastPullAt).not.toBe(pulled);
    const t = Date.now();
    await ctx.ingest.stop?.();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(ctx.ingest.status().running).toBe(false);
    ctx.ingest.kick();
  });
});
