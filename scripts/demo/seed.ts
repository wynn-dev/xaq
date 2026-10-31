// Demo environment for the web console: the real xaq server against test/fake-google.ts,
// seeded through the real APIs with a realistic, good-looking state (used for screenshots and
// manual UX passes). Binds to 127.0.0.1 only.
//
//   pnpm exec tsx scripts/demo/seed.ts --port 8531            seeded instance (prints the password)
//   pnpm exec tsx scripts/demo/seed.ts --port 8531 --fresh    unclaimed first run (prints the setup link)
//   --public-url <url>   publicUrl to store (default: https://inbox.acme.dev; use the local URL to click through OAuth)
//   --fresh --stage pubsub              claimed, client set, ops@acme.dev connected: the wizard's Pub/Sub step
//   --pubsub-fail org-policy|scope|api  make Pub/Sub provisioning fail the way real projects do
//   --hidden-chars                      add a pending send whose subject/body hide bidi and zero-width characters
//
// Serves the console from dist/web (run `pnpm build` or `pnpm exec vite build` first), or point
// Vite at it: XAQ_DEV_SERVER=http://127.0.0.1:8531 pnpm exec vite --host 127.0.0.1
//
// Writes /tmp/xaq-demo-<port>.json with { url, password, cookie } for screenshot scripts
// (--fresh: { url, setupUrl, client }, the OAuth client to import).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { PairingPoll, PairingStart, PairingStartInput } from "../../shared/agent-api.ts";
import type { Account, Agent, AgentWithKey, GrantInput, PairingRequest, Webhook, WebhookWithSecret } from "../../shared/types.ts";
import { readSetupToken } from "../../server/auth/setup-token.ts";
import { CALENDAR_SCOPES } from "../../server/google/scopes.ts";
import { loadConfig } from "../../server/config.ts";
import { startServer } from "../../server/server.ts";
import { GMAIL_SCOPE, startFakeGoogle } from "../../test/fake-google.ts";
import { seedCalendar } from "./calendar.ts";
import { authHeader, type DemoMail, OPS_MAIL, PERSONAL_MAIL } from "./mail.ts";
import { DEMO_CLIENT, startClientProxy } from "./proxy.ts";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "8531" },
    fresh: { type: "boolean", default: false },
    "public-url": { type: "string" },
    stage: { type: "string" },
    "pubsub-fail": { type: "string" },
    "hidden-chars": { type: "boolean", default: false },
  },
});

const PORT = Number(args.port);
const PASSWORD = "acme-demo-passphrase";
const OPS = "ops@acme.dev";
const PERSONAL = "wynn.personal@gmail.com";
const HOUR = 3600_000;
const log = (...a: unknown[]) => console.log("  \x1b[2m[demo]\x1b[0m", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

// ───────────── Boot ─────────────

const dataDir = mkdtempSync(join(tmpdir(), "xaq-demo-"));
const fake = await startFakeGoogle();
fake.pullWaitMs = 1000;
const proxy = await startClientProxy(fake.url);
// Report the real package version, so screenshots match what users install.
const pkgVersion = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const config = loadConfig({ dataDir, host: "127.0.0.1", port: PORT }, pkgVersion);
config.google = { oauthBase: proxy.url, authBase: proxy.url, gmailBase: proxy.url, pubsubBase: proxy.url, calendarBase: proxy.url };
const running = await startServer({ config });
const { ctx } = running;
const base = running.url;
const publicUrl = args["public-url"] ?? (args.fresh ? base : "https://inbox.acme.dev");
const receivers: { close(): void }[] = [];
const streams: AbortController[] = [];

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const s of streams) s.abort();
  for (const r of receivers) r.close();
  await running.close();
  await proxy.close();
  await fake.close();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

fake.addAccount(OPS, { name: "Acme Ops" });

const fail = args["pubsub-fail"];
if (fail === "org-policy") fake.orgPolicyBlocksIam(true);
if (fail === "api") fake.disableApi("pubsub", true);
// Gmail-only consent, as normal connects will be once Pub/Sub access is requested incrementally.
const consentScopes = fail === "scope" ? [GMAIL_SCOPE, "https://www.googleapis.com/auth/userinfo.email"] : undefined;

if (args.fresh) {
  const token = readSetupToken(dataDir);
  if (args.stage === "pubsub") {
    const post = (path: string, body: unknown, cookie = "") =>
      fetch(base + path, { method: path.includes("client") ? "PUT" : "POST", headers: { cookie, "x-agentinbox-csrf": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    const claim = await post("/api/setup/claim", { token, password: PASSWORD });
    const cookie = claim.headers.get("set-cookie")!.split(";")[0]!;
    await fetch(base + "/api/settings", { method: "PATCH", headers: { cookie, "x-agentinbox-csrf": "1", "content-type": "application/json" }, body: JSON.stringify({ publicUrl: base }) });
    await post("/api/google/client", { ...DEMO_CLIENT, projectId: "acme-xaq", appType: "internal" }, cookie);
    fake.consentAs(OPS, { scopes: consentScopes });
    const { authUrl } = (await (await post("/api/accounts/connect", {}, cookie)).json()) as { authUrl: string };
    const location = (await fetch(authUrl, { redirect: "manual" })).headers.get("location")!;
    await post("/api/accounts/connect/complete", { url: location }, cookie);
    writeFileSync(`/tmp/xaq-demo-${PORT}.json`, JSON.stringify({ url: base, password: PASSWORD, cookie, fresh: true }));
    console.log(`\n  xaq demo (wizard at the Pub/Sub step${fail ? `, provisioning fails: ${fail}` : ""}) on ${base}\n  Password: ${PASSWORD}\n`);
    if (consentScopes) setInterval(() => fake.consentAs(OPS, { scopes: [...consentScopes, "https://www.googleapis.com/auth/pubsub"] }), 3000).unref();
    await new Promise(() => {});
  }
  console.log(`
  xaq demo (fresh, unclaimed) on ${base}

  Setup link:     ${base}/setup?token=${token}
  OAuth client:   ${DEMO_CLIENT.clientId}
  Client secret:  ${DEMO_CLIENT.clientSecret}
  Fake accounts:  ${OPS} (consent is automatic; queue another with the next connect)
`);
  writeFileSync(`/tmp/xaq-demo-${PORT}.json`, JSON.stringify({ url: base, setupUrl: `${base}/setup?token=${token}`, fresh: true, client: DEMO_CLIENT }));
  // The only mailbox consents automatically; with --pubsub-fail scope, consent is Gmail-only.
  if (consentScopes) setInterval(() => fake.consentAs(OPS, { scopes: consentScopes }), 3000).unref();
  await new Promise(() => {});
}

fake.addAccount(PERSONAL, { name: "Wynn" });

// ───────────── Console API client ─────────────

let cookie = "";
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: { cookie, "x-agentinbox-csrf": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

await api("POST", "/api/setup/claim", { token: readSetupToken(dataDir), password: PASSWORD });
await api("PATCH", "/api/settings", { publicUrl, pollIntervalSeconds: 30, webhookAllowlist: ["localhost", "127.0.0.0/8", "::1", "*.localhost"] }).catch(
  async () => api("PATCH", "/api/settings", { publicUrl, pollIntervalSeconds: 30 }),
);
await api("PUT", "/api/google/client", { ...DEMO_CLIENT, projectId: "acme-xaq", appType: "internal" });
log("claimed, Google client configured");

/** `scopes` overrides what the user grants on the consent screen (e.g. adds Calendar). */
async function connect(email: string, scopes?: string[]): Promise<Account> {
  fake.consentAs(email, { scopes });
  const { authUrl } = await api<{ authUrl: string }>("POST", "/api/accounts/connect", {});
  const res = await fetch(authUrl, { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) throw new Error(`consent failed: ${res.status} ${await res.text()}`);
  return api<Account>("POST", "/api/accounts/connect/complete", { url: location });
}

// The ops account has Google Calendar; the personal one is mail-only (it never added Calendar).
const ops = await connect(OPS, [GMAIL_SCOPE, "openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", ...CALENDAR_SCOPES]);
const personal = await connect(PERSONAL);
// Pub/Sub access is requested incrementally, like the console's "Grant Pub/Sub access" button.
{
  fake.consentAs(OPS);
  const { authUrl } = await api<{ authUrl: string }>("POST", "/api/accounts/connect", { scopes: ["pubsub"], reauthAccountId: ops.id });
  const res = await fetch(authUrl, { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) throw new Error(`pubsub consent failed: ${res.status} ${await res.text()}`);
  await api("POST", "/api/accounts/connect/complete", { url: location });
}
await api("POST", "/api/google/pubsub/provision");
log("accounts connected, Pub/Sub provisioned");

const labelIds: Record<string, string> = {};
for (const name of ["Support", "Billing", "Vendors", "Newsletters", "Alerts"]) labelIds[name] = fake.addLabel(OPS, name);
const resolveLabels = (names: string[]) => names.map((n) => labelIds[n] ?? n);

// ───────────── Webhook receivers (n8n.localhost etc. resolve to 127.0.0.1) ─────────────

/** Listens on the preferred port (pretty URLs in screenshots), or any free port if another demo holds it. */
async function receiver(port: number, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => handler(req, res));
  });
  const bind = (p: number) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, "127.0.0.1", () => {
        server.off("error", reject);
        resolve((server.address() as { port: number }).port);
      });
    });
  const bound = await bind(port).catch(() => bind(0));
  receivers.push({ close: () => server.close() });
  return bound;
}
let relayCalls = 0;
const n8nPort = await receiver(5678, (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ message: "Workflow was started" }));
});
const relayPort = await receiver(8787, (_req, res) => {
  relayCalls++;
  if (relayCalls % 3 === 0) {
    res.writeHead(502, { "content-type": "text/html" }).end("<html><body><h1>502 Bad Gateway</h1><p>upstream connect error or disconnect/reset before headers</p></body></html>");
  } else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, channel: "#billing" }));
});

// ───────────── Agents ─────────────

const grant = (accountId: string, patch: Partial<GrantInput>): GrantInput => ({ accountId, level: "read", allowTo: [], ...patch });

const support = await api<AgentWithKey>("POST", "/api/agents", {
  name: "Support triage",
  description: "Reads new support tickets and drafts a first reply for a human to send.",
  grants: [grant(ops.id, { level: "full", allowTo: ["*@acme.dev"] })],
});
const billing = await api<AgentWithKey>("POST", "/api/agents", {
  name: "Billing bot",
  description: "Matches vendor invoices to POs and answers billing questions.",
  grants: [grant(ops.id, { level: "full", allowTo: ["*@acme.dev", "*@northwind.io", "ap@stripe.com"] })],
});
await api<AgentWithKey>("POST", "/api/agents", {
  name: "Scheduling assistant",
  description: "Watches the ops calendar, answers vendor invitations and books follow-ups.",
  grants: [grant(ops.id, { level: "full", allowTo: ["*@acme.dev", "*@northwind.io"] })],
});
const digest = await api<AgentWithKey>("POST", "/api/agents", {
  name: "Weekly digest (old)",
  description: "Summarized the week's newsletters every Friday. Replaced by the n8n workflow.",
  grants: [grant(ops.id, {})],
});
log("agents created");

// ───────────── Pairing: an approved agent with a live listener, and a pending request ─────────────

async function startPairing(input: PairingStartInput): Promise<PairingStart> {
  const res = await fetch(`${base}/agent/v1/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`pairing start → ${res.status} ${await res.text()}`);
  return (await res.json()) as PairingStart;
}
async function poll(deviceCode: string): Promise<PairingPoll> {
  const res = await fetch(`${base}/agent/v1/pairings/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode }) });
  return (await res.json()) as PairingPoll;
}
const setPairingIp = (userCode: string, ip: string) => ctx.db.run("UPDATE pairings SET ip = ? WHERE user_code = ?", ip, userCode);

/** A listener like `xaq listen`: holds the stream open and acks what it receives. */
function listen(apiKey: string, consumer: string, client: { hostname: string; platform: string; version: string }) {
  const ac = new AbortController();
  streams.push(ac);
  void (async () => {
    while (!ac.signal.aborted) {
      try {
        const res = await fetch(`${base}/agent/v1/events/stream?consumer=${encodeURIComponent(consumer)}`, {
          headers: { authorization: `Bearer ${apiKey}`, "x-agentinbox-client": JSON.stringify(client), "user-agent": `xaq-cli/${client.version}` },
          signal: ac.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        const decoder = new TextDecoder();
        let maxSeq = 0;
        for await (const chunk of res.body) {
          for (const m of decoder.decode(chunk as Uint8Array, { stream: true }).matchAll(/^id: (\d+)$/gm)) maxSeq = Math.max(maxSeq, Number(m[1]));
          if (maxSeq) {
            await fetch(`${base}/agent/v1/events/ack`, {
              method: "POST",
              headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
              body: JSON.stringify({ consumer, seq: maxSeq }),
            });
          }
        }
      } catch {
        if (ac.signal.aborted) return;
      }
      await sleep(3000);
    }
  })();
}

const claudeStart = await startPairing({
  name: "Claude Code on wynn-mbp",
  description: "Personal assistant: triages the ops inbox and drafts replies.",
  requested: { accounts: [OPS], reason: "Wake me when support mail arrives so I can draft replies." },
  client: { hostname: "wynn-mbp", platform: "darwin-arm64", tool: "claude-code", version: pkgVersion },
});
setPairingIp(claudeStart.userCode, "100.101.34.7");
const pendingClaude = (await api<PairingRequest[]>("GET", "/api/pairings?status=pending")).find((p) => p.userCode === claudeStart.userCode)!;
await api<Agent>("POST", `/api/pairings/${pendingClaude.id}/approve`, {
  userCode: claudeStart.userCode,
  grants: [
    grant(ops.id, { level: "full", allowTo: ["*@acme.dev"] }),
    grant(personal.id, {}),
  ],
});
const claudePoll = await poll(claudeStart.deviceCode);
if (claudePoll.status !== "approved") throw new Error(`pairing poll: ${JSON.stringify(claudePoll)}`);
const claudeKey = claudePoll.apiKey;
const claudeAgentId = claudePoll.agent.id;
listen(claudeKey, "wynn-mbp", { hostname: "wynn-mbp", platform: "darwin-arm64", version: pkgVersion });
log("paired Claude Code agent, listener connected");

/** Keeps one pending request around, polled like a real `connect` would (approve it in the console to see the key delivered). */
let pending: { start: PairingStart; done: boolean } | null = null;
async function ensurePendingPairing() {
  if (pending && !pending.done) return;
  const start = await startPairing({
    name: "Codex on build-01",
    description: "CI helper: reads build failure emails and opens issues.",
    requested: {
      accounts: [OPS],
      reason: "Triage CI and Datadog alert emails, then email the on-call engineer a summary.",
    },
    client: { hostname: "build-01", platform: "linux-x64", tool: "codex", version: pkgVersion },
  });
  setPairingIp(start.userCode, "100.87.120.44");
  const entry = { start, done: false };
  pending = entry;
  log(`pending pairing: ${start.userCode}  ${start.verificationUrl}`);
  void (async () => {
    while (!entry.done && !shuttingDown) {
      await sleep(start.interval * 1000 + 200);
      const r = await poll(start.deviceCode).catch(() => ({ status: "pending" }) as PairingPoll);
      if (r.status === "approved") {
        log(`pairing ${start.userCode} approved: key delivered to the demo CLI, listener starting`);
        listen(r.apiKey, "build-01", { hostname: "build-01", platform: "linux-x64", version: pkgVersion });
        entry.done = true;
      } else if (r.status === "denied" || r.status === "expired" || r.status === "consumed") {
        log(`pairing ${start.userCode} ${r.status}`);
        entry.done = true;
      }
    }
    // Leave the outcome visible for a while, then queue a fresh request.
    await sleep(r_delay());
    void ensurePendingPairing();
  })();
}
const r_delay = () => 45_000;
await ensurePendingPairing();

// ───────────── Webhooks ─────────────

const n8n = await api<WebhookWithSecret>("POST", "/api/webhooks", {
  agentId: support.agent.id,
  name: "n8n · support triage",
  url: `http://n8n.localhost:${n8nPort}/webhook/support-triage`,
  eventTypes: ["message.received", "thread.reply_received"],
  filter: { labelIds: [labelIds.Support!] },
  includeBody: true,
  enabled: true,
});
await api<WebhookWithSecret>("POST", "/api/webhooks", {
  agentId: billing.agent.id,
  name: "Slack relay · #billing",
  url: `http://relay.localhost:${relayPort}/hooks/billing`,
  eventTypes: ["message.received"],
  filter: { labelIds: [labelIds.Billing!], from: ["*@stripe.com", "*@northwind.io", "*@amazon.com", "*@vercel.com", "*@gusto.com"] },
  includeBody: false,
  enabled: true,
});
const zap = await api<WebhookWithSecret>("POST", "/api/webhooks", {
  agentId: digest.agent.id,
  name: "Zapier · newsletter digest",
  url: "http://legacy.localhost:9/hooks/catch/48213/digest",
  eventTypes: ["message.received"],
  filter: { labelIds: [labelIds.Newsletters!] },
  includeBody: true,
  enabled: true,
});
log("webhooks created");

// ───────────── Mail ─────────────

const planned = new Map<string, number>(); // gmail message id → hoursAgo
const msgIds: Record<string, { id: string; threadId: string }> = {};

function deliver(email: string, m: DemoMail) {
  const threadId = m.inThreadOf ? msgIds[m.inThreadOf]?.threadId : undefined;
  if (threadId && email === OPS) {
    // The human answered from Gmail first, so the follow-up counts as a reply to a thread we sent into.
    const orig = OPS_MAIL.find((x) => x.key === m.inThreadOf)!;
    const sent = fake.deliver(email, {
      from: `Acme Ops <${OPS}>`,
      to: orig.from,
      subject: m.subject,
      text: "Thanks for reaching out, we're on it and will follow up shortly.\n\nAcme Ops",
      threadId,
      labelIds: ["SENT"],
      date: new Date(Date.now() - (m.hoursAgo + 0.2) * HOUR),
    });
    planned.set(sent.id, m.hoursAgo + 0.2);
  }
  const msg = fake.deliver(email, {
    from: m.from,
    to: email === OPS ? `Acme Ops <${OPS}>` : `Wynn <${PERSONAL}>`,
    subject: m.subject,
    text: m.text,
    html: m.html,
    threadId,
    labelIds: email === OPS ? resolveLabels(m.labels) : m.labels,
    headers: { "Authentication-Results": authHeader(m.auth) },
    attachments: m.attachments,
    date: new Date(Date.now() - m.hoursAgo * HOUR),
  });
  planned.set(msg.id, m.hoursAgo);
  msgIds[m.key] = { id: msg.id, threadId: msg.threadId };
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > timeoutMs) {
      log(`timed out waiting for ${what}`);
      return;
    }
    await sleep(250);
  }
}
const eventCount = () => ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE gmail_message_id IS NOT NULL")!.n;
// One message at a time, so events (and their deliveries) are stored in delivery order.
for (const [email, m] of [...PERSONAL_MAIL.map((m) => [PERSONAL, m] as const), ...[...OPS_MAIL].sort((a, b) => b.hoursAgo - a.hoursAgo).map((m) => [OPS, m] as const)]) {
  deliver(email, m);
  await waitFor(`ingest of "${m.subject}"`, () => eventCount() >= planned.size, 8000);
}
log(`ingested ${eventCount()} message events`);

await seedCalendar(fake, ctx, OPS, ops.id);
log("calendars seeded");

// The personal account's refresh token stops working (password change, revoked access…).
fake.failRefresh(PERSONAL);
fake.expireAccessTokens(PERSONAL);
await api("POST", `/api/accounts/${personal.id}/resync`).catch(() => {});
log("personal account now needs re-auth");

// ───────────── Agent activity over MCP (fills the audit log, incl. denials) ─────────────

async function mcp(apiKey: string) {
  const client = new Client({ name: "demo-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } }));
  return {
    call: async (name: string, a: Record<string, unknown> = {}) => {
      try {
        const r = await client.callTool({ name, arguments: a });
        return (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
      } catch (err) {
        return String(err);
      }
    },
    close: () => client.close(),
  };
}
const lastAuditId = () => ctx.db.get<{ id: number }>("SELECT COALESCE(MAX(id), 0) AS id FROM audit_log")!.id;
const auditPlan: { from: number; to: number; minutesAgo: number }[] = [];
// Every action is planned at a time on the last day's timeline, then run in chronological order so
// audit ids and timestamps agree (the audit log is ordered by id).
const plan: { minutesAgo: number; fn: () => Promise<unknown> }[] = [];
const at = (minutesAgo: number, fn: () => Promise<unknown>) => void plan.push({ minutesAgo, fn });

const sup = await mcp(support.apiKey);
const cc = await mcp(claudeKey);
const bill = await mcp(billing.apiKey);

for (const [mins, key] of [
  [1300, "trial-ending"],
  [1080, "sso-question"],
  [690, "export-csv"],
  [470, "integration-broken"],
  [345, "bulk-pricing"],
  [220, "refund"],
  [150, "login-issue"],
] as const) {
  at(mins, () => sup.call("search_threads", { query: "in:inbox newer_than:1d" }));
  at(mins - 1, () => sup.call("get_thread", { thread_id: msgIds[key]!.threadId }));
  at(mins - 2, () =>
    sup.call("create_draft", { to: ["customer@example.com"], subject: "Re: ticket", body: "Thanks for reaching out, looking into this now.", thread_id: msgIds[key]!.threadId }),
  );
}
at(95, () => sup.call("get_message", { message_id: msgIds["northwind-invoice"]!.id })); // label_scope denial
at(94, () => sup.call("get_message", { message_id: msgIds["payroll-phish"]!.id })); // label_scope denial
at(20, () => sup.call("modify_labels", { thread_id: msgIds.refund!.threadId, add: ["STARRED"] }));

for (const mins of [1260, 900, 610, 380, 175, 60, 12]) {
  at(mins, () => cc.call("list_events", {}));
  at(mins - 1, () => cc.call("search_threads", { account: OPS, query: "is:unread" }));
}
at(170, () => cc.call("get_thread", { account: OPS, thread_id: msgIds["datadog-alert"]!.threadId }));
at(8, () => cc.call("send_message", { account: OPS, to: ["jules@personal.example"], subject: "Heads up", body: "Latency alert fired." })); // allow_to denial

at(600, () => bill.call("search_threads", { query: "label:Billing newer_than:2d" }));
at(420, () => bill.call("get_thread", { thread_id: msgIds["aws-bill"]!.threadId }));
at(290, () => bill.call("get_thread", { thread_id: msgIds["stripe-paid"]!.threadId }));
at(52, () => bill.call("get_thread", { thread_id: msgIds["northwind-invoice"]!.threadId }));
at(50, () =>
  bill.call("send_message", {
    to: ["ap@acme.dev"],
    subject: "AR summary: week 42",
    body: "Hi AP team,\n\nThree vendor invoices arrived this week: AWS ($4,318.27), Vercel ($480.00) and Northwind (INV-2291, $3,940.00). All match open POs except Northwind's incident-response line (6 h), which needs sign-off.\n\nBilling bot",
  }),
);
at(44, () => bill.call("send_message", { to: ["dana@northwind.io"], subject: "Payment scheduled", body: "Hi Dana, payment is scheduled for tomorrow." }));
at(40, () =>
  bill.call("send_message", {
    to: ["dana.whitfield@gmail.com"],
    subject: "Invoice INV-2291",
    body: "Forwarding the remittance advice as requested.",
  }),
); // allow_to denial
at(31, () =>
  bill.call("reply", {
    message_id: msgIds["northwind-invoice"]!.id,
    body:
      "Hi Dana,\n\nThanks for invoice INV-2291 ($3,940.00). The Postgres and retainer lines match PO-7731. " +
      "The incident-response line (6 hours on Oct 9) isn't on the PO yet, so I've asked our ops lead to sign it off.\n\n" +
      "We'll pay the matched amount ($3,040.00) this week and the remainder once it's approved, well within your net-15 terms.\n\n" +
      "Best,\nAcme Billing",
  }),
);
if (args["hidden-chars"]) {
  at(33, () =>
    bill.call("reply", {
      message_id: msgIds["northwind-invoice"]!.id,
      body: "Hi Dana,\n\nPlease use the updated bank details: IBAN \u202EGB29 NWBK\u202C 6016 1331 9268 19.\u200B\n\nThanks",
    }),
  );
}
at(5, () => bill.call("send_message", { to: ["ap@acme.dev"], subject: "One more thing", body: "…" }));
// The old digest agent gets turned off (its webhook keeps failing), and the n8n hook gets a test send.
at(15, () => api("PATCH", `/api/agents/${digest.agent.id}`, { disabled: true }));
at(3, () => api("POST", `/api/webhooks/${n8n.webhook.id}/test`).catch(() => {}));

for (const step of plan.sort((a, b) => b.minutesAgo - a.minutesAgo)) {
  const from = lastAuditId();
  await step.fn();
  auditPlan.push({ from, to: lastAuditId(), minutesAgo: step.minutesAgo });
}
await Promise.all([sup.close(), cc.close(), bill.close()]);
log("agent activity recorded");

// Let ingest pick up what the agents did (sends, labels), then let the worker attempt the deliveries once.
await sleep(5000);
await waitFor("first delivery attempts", () => ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE attempts = 0")!.n === 0, 20_000);

// ───────────── Backdate, so timelines look like a day of real traffic ─────────────

ctx.db.tx(() => {
  // Planned messages get their delivery time; everything else (labels, sends, auth failure) follows in
  // sequence order, so the event feed stays chronological.
  const events = ctx.db.all<{ seq: number; gmail_message_id: string | null; type: string }>("SELECT seq, gmail_message_id, type FROM events ORDER BY seq");
  let prev = Date.now() - 24 * HOUR;
  for (const e of events) {
    const h = e.gmail_message_id && e.type === "message.received" ? planned.get(e.gmail_message_id) : e.gmail_message_id ? planned.get(e.gmail_message_id) : undefined;
    const t = h !== undefined && Date.now() - h * HOUR >= prev ? Date.now() - h * HOUR : Math.min(prev + 40_000, Date.now() - 60_000);
    prev = t;
    const at = new Date(t).toISOString();
    ctx.db.run("UPDATE events SET created_at = ? WHERE seq = ?", at, e.seq);
    ctx.db.run(
      "UPDATE deliveries SET created_at = ?, updated_at = ? WHERE event_seq = ?",
      at,
      new Date(Date.parse(at) + 1500).toISOString(),
      e.seq,
    );
  }
  // The legacy Zapier endpoint has been unreachable for a while: its deliveries used up their retries.
  ctx.db.run(
    `UPDATE deliveries SET status = 'dead', attempts = 9, next_attempt_at = NULL WHERE webhook_id = ? AND event_seq > 0 AND created_at < ?`,
    zap.webhook.id,
    iso(6 * HOUR),
  );
  for (const p of auditPlan) {
    ctx.db.run("UPDATE audit_log SET ts = ? WHERE id > ? AND id <= ?", iso(p.minutesAgo * 60_000), p.from, p.to);
  }
  // Setup happened a few days ago.
  const firstPlanned = auditPlan.length ? auditPlan[0]!.from : lastAuditId();
  ctx.db.run("UPDATE audit_log SET ts = ? WHERE id <= ?", iso(3 * 24 * HOUR), firstPlanned);
  ctx.db.run("UPDATE accounts SET created_at = ?", iso(3 * 24 * HOUR));
  ctx.db.run("UPDATE agents SET created_at = ?", iso(2 * 24 * HOUR + 3 * HOUR));
  ctx.db.run("UPDATE agents SET created_at = ? WHERE id = ?", iso(26 * HOUR), claudeAgentId);
  ctx.db.run("UPDATE webhooks SET created_at = ?", iso(2 * 24 * HOUR));
  ctx.db.run("UPDATE agents SET last_used_at = ?, created_at = ? WHERE id = ?", iso(9 * 24 * HOUR), iso(40 * 24 * HOUR), digest.agent.id);
  ctx.db.run("UPDATE webhooks SET created_at = ? WHERE id = ?", iso(40 * 24 * HOUR), zap.webhook.id);
});

const webhooks = await api<Webhook[]>("GET", "/api/webhooks");
for (const w of webhooks) log(`webhook ${w.name}: ${w.stats.succeeded24h} ok / ${w.stats.failed24h} failed`);

const state = { url: base, password: PASSWORD, cookie, publicUrl, dataDir };
writeFileSync(`/tmp/xaq-demo-${PORT}.json`, JSON.stringify(state, null, 2));
console.log(`
  xaq demo ready on ${base}  (publicUrl ${publicUrl})

  Password:   ${PASSWORD}
  Session:    ${cookie}
  State file: /tmp/xaq-demo-${PORT}.json
  Pairing:    ${pending ? `${base}/approvals?pairing=${(pending as { start: PairingStart }).start.userCode}` : "-"}

  Ctrl-C to stop (the temp data dir is removed).
`);
await new Promise(() => {});
