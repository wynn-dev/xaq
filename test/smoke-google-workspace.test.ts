// `xaq smoke google-workspace --scratch` end to end, offline: the real daemon (startStack: real HTTP, the fake
// Google for Gmail and Drive), the real admin channel (a one-time session in the data dir), /mcp as the temporary
// agent, and a fake google-workspace extension (test/fake-workspace.ts) as an MCP upstream connection at "ask", bound
// to the account like the extension's Google setup leaves it (preset google-workspace, connections.google_account_id).
// Every mail tool is the real one: create_draft's { path } and { drive_file_id } (#86, #90), list_attachments and
// get_attachment's extraction (format "inline", which never saves) and saved files (#87). No stand-ins.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Account, AgentWithKey, ConnectAccountResponse, ConnectionView } from "../shared/types.ts";
import { isSmokeDir } from "../shared/smoke.ts";
import { type AdminChannel, openAdminChannel } from "../server/connections-cli/admin.ts";
import { DRIVE_READONLY_SCOPE, GMAIL_SCOPE } from "../server/google/scopes.ts";
import { GOOGLE_WORKSPACE_EXTENSION } from "../server/google/workspace-binding.ts";
import { AttachmentParser, setAttachmentParser } from "../server/mail/extract/sandbox.ts";
import { type AgentMcp, type CallOutcome, connectAgentMcp } from "../server/smoke/agent.ts";
import { installSmokeSignals, safeWriter } from "../server/smoke/cli.ts";
import { GuardError, newLedger, ScratchGuard, WRITE_TARGETS } from "../server/smoke/guards.ts";
import { renderReport } from "../server/smoke/report.ts";
import { chooseTargets, inlineKind, parseAttachmentList, SKIPPED_NOT_INLINE, SmokeRun, SmokeSetupError } from "../server/smoke/run.ts";
import { createLogger } from "../server/util/log.ts";
import { makePdf } from "./attachment-fixtures.ts";
import { HAS_AGENTS } from "./e2e/features.ts";
import { type Stack, startStack } from "./e2e/harness.ts";
import { startFakeMcpUpstream } from "./fake-mcp-upstream.ts";
import { type FakeWorkspace, fakeWorkspace } from "./fake-workspace.ts";

// attachmentDirs refuses directories holding the home directory's secret places: give the tests a temporary home.
process.env.HOME = mkdtempSync(join(tmpdir(), "xaq-smoke-home-"));
for (const v of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) delete process.env[v];

const EMAIL = "wynn@acme.test";
const IDENTITY = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"];
const SECRETS = ["TOP-SECRET-DOC-CONTENT", "TOP-SECRET-SHEET-CONTENT", "TOP-SECRET-SLIDE-CONTENT", "EMAIL-BODY-SECRET", "ATTACHMENT-SECRET"];
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

// ───────────── A recording wrapper (it changes nothing, except a lost create_draft answer on request) ─────────────

interface McpKnobs {
  /** Every get_attachment call the run made (file names, from what list_attachments listed). */
  extracted: string[];
  /** The format each get_attachment call asked for. */
  formats: unknown[];
  /** create_draft makes the draft, but its answer is lost (the run never learns the draft id). */
  dropDraftAnswer: boolean;
  /** get_attachment's format is dropped (an xaq that saves what it can't show anyway). */
  ignoreFormat: boolean;
}

function recordingMcp(mcp: AgentMcp, knobs: McpKnobs): AgentMcp {
  const names = new Map<string, string>();
  return {
    listTools: () => mcp.listTools(),
    async call(name, args) {
      if (name === "create_draft" && knobs.dropDraftAnswer) {
        await mcp.call(name, args);
        const text = "The connection dropped before the answer arrived.";
        return { isError: true, text, structured: null, content: [{ type: "text", text }] };
      }
      if (name === "get_attachment") {
        knobs.extracted.push(names.get(String(args.attachment_id)) ?? "?");
        knobs.formats.push(args.format);
        if (knobs.ignoreFormat) args = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "format"));
      }
      const out = await mcp.call(name, args);
      if (name === "list_attachments") for (const a of parseAttachmentList(out)) names.set(a.id, a.filename);
      return out;
    },
    close: () => mcp.close(),
  };
}

// ───────────── The world ─────────────

interface World {
  s: Stack;
  ws: FakeWorkspace;
  account: Account;
  connection: ConnectionView;
  admin: Pick<AdminChannel, "request" | "baseUrl">;
  out: string[];
  controller: AbortController;
  tmpRoot: string;
  knobs: McpKnobs;
  run: (flags?: Record<string, unknown>) => SmokeRun;
}

/** Connects `address` through the console API and the fake consent screen, granting exactly `scopes`. */
async function connectWith(s: Stack, address: string, scopes: string[]): Promise<Account> {
  s.fake.addAccount(address, { name: "Wynn" });
  const start = await s.admin.post<ConnectAccountResponse>("/api/accounts/connect", {});
  s.fake.consentAs(address, { scopes });
  const consent = await fetch(start.authUrl, { redirect: "manual" });
  const location = consent.headers.get("location");
  if (consent.status !== 302 || !location) throw new Error(`fake consent failed: HTTP ${consent.status}`);
  if (start.callbackMode === "paste") return s.admin.post<Account>("/api/accounts/connect/complete", { url: location });
  expect((await fetch(location)).status).toBe(200);
  return (await s.admin.get<Account[]>("/api/accounts")).find((a) => a.email === address)!;
}

async function world(opts: { attachments?: { filename: string; mimeType: string; content: string | Buffer }[] } = {}): Promise<World> {
  const s = await startStack();
  cleanup.push(() => s.close());
  await s.bootstrap({});
  const account = await connectWith(s, EMAIL, [GMAIL_SCOPE, ...IDENTITY, DRIVE_READONLY_SCOPE]);
  s.fake.deliver(EMAIL, {
    from: "Landlord <leasing@offices.test>",
    subject: "Lease papers",
    text: "EMAIL-BODY-SECRET: the papers are attached.",
    attachments: opts.attachments ?? [
      { filename: "lease.pdf", mimeType: "application/pdf", content: makePdf(["ATTACHMENT-SECRET-PDF: the lease"]) },
      { filename: "notes.txt", mimeType: "text/plain", content: "ATTACHMENT-SECRET-TEXT" },
    ],
  });
  s.kick(account.id);

  const ws = fakeWorkspace();
  // The extension and Gmail's Drive reads see one Drive: new Google Docs appear in the fake Google's Drive too.
  ws.hooks.onCreate = (f) => {
    if (f.kind === "doc") s.fake.drive.addFile(EMAIL, { id: f.id, name: f.name, mimeType: f.mimeType });
  };
  const up = await startFakeMcpUpstream({ tools: ws.tools });
  cleanup.push(() => up.close());
  const conn = await s.admin.post<ConnectionView>("/api/connections", { url: up.url, slug: "workspace", name: "Google Workspace", levelDefault: "ask", agentIds: [] });
  await s.admin.put(`/api/connections/${conn.id}/private-target`, { allow: true });
  await s.admin.post(`/api/connections/${conn.id}/connect`, {});
  // What the extension's Google setup leaves: a google-workspace connection bound to the account.
  s.ctx.db.run("UPDATE connections SET preset = ?, google_account_id = ? WHERE id = ?", GOOGLE_WORKSPACE_EXTENSION, account.id, conn.id);
  const connection = await s.admin.get<ConnectionView>(`/api/connections/${conn.id}`);
  expect(connection.status).toBe("active");

  const channel = openAdminChannel({ dataDir: s.dataDir, instance: { pid: process.pid, host: "127.0.0.1", port: s.config.port, startedAt: "" } });
  cleanup.push(() => channel.close());
  const admin = channel;
  const out: string[] = [];
  const controller = new AbortController();
  const tmpRoot = mkdtempSync(join(tmpdir(), "xaq-smoke-test-"));
  cleanup.push(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const knobs: McpKnobs = { extracted: [], formats: [], dropDraftAnswer: false, ignoreFormat: false };
  const run = (flags: Record<string, unknown> = {}) =>
    new SmokeRun(
      { scratch: true, yes: true, connection: "workspace", ...flags },
      {
        admin,
        connectMcp: async (key) => recordingMcp(await connectAgentMcp(admin.baseUrl, key), knobs),
        print: (l = "") => out.push(l),
        confirm: async () => true,
        signal: controller.signal,
        tmpRoot,
        pollMs: 10,
      },
    );
  return { s, ws, account, connection, admin, out, controller, tmpRoot, knobs, run };
}

/** Nothing of the run is left in xaq, Gmail, Drive or on disk. */
async function expectClean(w: World, run: SmokeRun) {
  const agents = await w.s.admin.get<{ name: string }[]>("/api/agents");
  expect(agents.filter((a) => a.name.startsWith("xaq-smoke-"))).toEqual([]);
  expect(w.s.fake.drafts(EMAIL)).toEqual([]);
  expect(w.s.fake.sent(EMAIL)).toEqual([]);
  expect((await w.admin.request<{ attachmentDirs: string[] }>("GET", "/api/settings")).attachmentDirs).toEqual([]);
  expect(run.ledger.tempDir && existsSync(run.ledger.tempDir)).toBeFalsy();
  if (run.ledger.folder) expect(w.ws.isTrashed(run.ledger.folder.id)).toBe(true);
  for (const id of run.ledger.files.keys()) expect(w.ws.isTrashed(id)).toBe(true);
}

/** Every write the fake saw targeted the scratch folder or a file in it (drive_create_folder: My Drive's top). */
function expectOnlyScratchWrites(w: World, run: SmokeRun) {
  const folder = run.ledger.folder?.id;
  for (const write of w.ws.writes) {
    if (write.tool === "drive_create_folder") expect(write.target).toBe("root");
    else expect(write.target === folder || w.ws.files.get(write.target)?.parents.includes(folder ?? "-")).toBe(true);
  }
  for (const id of ["doc-existing", "doc-older", "sheet-existing", "slides-existing"]) expect(w.ws.isTrashed(id)).toBe(false);
  expect(w.ws.files.get("doc-existing")!.text).toBe("# Plan\n\nTOP-SECRET-DOC-CONTENT");
}

const statusOf = (run: { steps: { tool: string; step: string; status: string }[] }, tool: string, step?: RegExp) =>
  run.steps.filter((s) => s.tool === tool && (!step || step.test(s.step))).map((s) => s.status);

describe.runIf(HAS_AGENTS)("xaq smoke google-workspace", () => {
  it("a full run passes every step, approves its own two risky calls, prints no content and leaves nothing behind", async () => {
    const w = await world();
    const run = w.run();
    const report = await run.run();
    const failed = report.steps.filter((s) => s.status !== "PASS");
    expect(failed).toEqual([]);
    expect(report.leftBehind).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.interrupted).toBe(false);
    // The steps the owner asked for, in order.
    const tools = report.steps.map((s) => s.tool);
    for (const t of ["drive_search", "drive_list_folder", "drive_get", "docs_read", "sheets_read", "slides_read", "drive_export", "search_threads", "list_attachments", "get_attachment", "drive_create_folder", "docs_create", "docs_append", "docs_replace_text", "docs_comment_add", "sheets_create", "sheets_write", "sheets_append_rows", "slides_create", "slides_add_slide", "slides_replace_text", "drive_upload", "slides_insert_image", "slides_delete_slide", "create_draft", "drive_trash"]) {
      expect(tools).toContain(t);
    }
    expect(statusOf(report, "get_attachment")).toEqual(["PASS", "PASS"]);
    expect(report.steps.find((s) => s.tool === "slides_delete_slide")!.detail).toMatch(/^pending, approved \(apr_/);
    expect(report.steps.find((s) => s.tool === "drive_trash")!.detail).toMatch(/^pending, approved \(apr_/);
    expect(run.ledger.approvals).toHaveLength(2);
    // The private PNG is refused (never shared), the public image goes in.
    expect(report.steps.filter((s) => s.tool === "slides_insert_image").map((s) => `${s.step}: ${s.status} ${s.detail}`)).toEqual([
      "Drive image (private): PASS refused as expected",
      expect.stringMatching(/^insert a public https image: PASS image img/),
    ]);
    expect([...w.ws.files.values()].some((f) => f.shared)).toBe(false);
    // The draft was real: two attachments, to the account itself, then deleted.
    expect(report.steps.find((s) => /check the draft/.test(s.step))!.detail).toMatch(/xaq-smoke-\d{8}T\d{6}Z\.txt" \d+ B, "xaq-smoke-\d{8}T\d{6}Z doc\.pdf" \d+ B/);
    // Prints only names, the subject, kinds and sizes.
    const printed = [...w.out, ...renderReport(report), JSON.stringify(report)].join("\n");
    for (const secret of SECRETS) expect(printed).not.toContain(secret);
    expect(printed).toContain('subject "Lease papers"');
    expect(printed).toContain('"lease.pdf"');
    expect(printed).toMatch(/text, \d+ chars/);
    expect(w.knobs.extracted).toEqual(["lease.pdf", "notes.txt"]);
    // The local file lived in a private 0700 directory, not the shared temp dir.
    const privateDir = join(w.tmpRoot, "xaq-smoke");
    expect(run.ledger.tempDir!.startsWith(`${privateDir}/xaq-smoke-`)).toBe(true);
    expect(statSync(privateDir).mode & 0o777).toBe(0o700);
    expect(report.earlier).toEqual([]);
    expect(report.steps.find((s) => s.step === "sweep earlier runs' leftovers")!.detail).toBe(
      "0 agent(s) deleted, 0 attachmentDirs entries removed, 0 temp dir(s) removed, 0 draft(s) to check",
    );
    expectOnlyScratchWrites(w, run);
    await expectClean(w, run);
  });

  it("extracts only attachments get_attachment can show inline: anything else is skipped, never downloaded", async () => {
    const w = await world({
      attachments: [
        { filename: "photos.zip", mimeType: "application/zip", content: Buffer.from("PK\u0003\u0004 ATTACHMENT-SECRET") },
        { filename: "setup.bin", mimeType: "application/octet-stream", content: Buffer.from("ATTACHMENT-SECRET") },
        { filename: "notes.txt", mimeType: "text/plain", content: "ATTACHMENT-SECRET-TEXT" },
      ],
    });
    const report = await w.run().run();
    expect(report.steps.filter((s) => s.tool === "get_attachment").map((s) => `${s.step}: ${s.status} ${s.detail}`)).toEqual([
      `extract "photos.zip": PASS ${SKIPPED_NOT_INLINE}`,
      `extract "setup.bin": PASS ${SKIPPED_NOT_INLINE}`,
      expect.stringMatching(/^extract "notes.txt": PASS text: text, \d+ chars$/),
    ]);
    expect(w.knobs.extracted).toEqual(["notes.txt"]);
    expect(w.knobs.formats).toEqual(["inline"]);
    expect(report.ok).toBe(true);
  });

  const extractions = (report: { steps: { tool: string; step: string; status: string; detail: string }[] }) =>
    report.steps.filter((s) => s.tool === "get_attachment").map((s) => `${s.step}: ${s.status} ${s.detail}`);

  it("an encrypted PDF passes as \"couldn't read (…)\" (the file's own doing), and nothing is saved or left behind", async () => {
    // Listed as a small PDF, so the run asks for it; with format "inline" get_attachment says why and saves nothing.
    const w = await world({
      attachments: [
        { filename: "locked.pdf", mimeType: "application/pdf", content: makePdf(["ATTACHMENT-SECRET-LOCKED"], { encrypted: true }) },
        { filename: "notes.txt", mimeType: "text/plain", content: "ATTACHMENT-SECRET-TEXT" },
      ],
    });
    const run = w.run();
    const report = await run.run();
    expect(extractions(report)).toEqual([
      `extract "locked.pdf": PASS pdf: couldn't read (The PDF is password-protected)`,
      expect.stringMatching(/^extract "notes.txt": PASS text: text, \d+ chars$/),
    ]);
    expect(w.knobs.formats).toEqual(["inline", "inline"]);
    expect(report.leftBehind).toEqual([]);
    expect(report.ok).toBe(true);
    // Nothing saved: the attachment folder was never even created.
    expect(existsSync(join(w.s.dataDir, "attachments"))).toBe(false);
    for (const secret of SECRETS) expect([...w.out, JSON.stringify(report)].join("\n")).not.toContain(secret);
    await expectClean(w, run);
  });

  it("a corrupt PDF fails the step with the reason (it could be a parser regression), and still nothing is saved", async () => {
    const w = await world({ attachments: [{ filename: "broken.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF-1.4 ATTACHMENT-SECRET not really a pdf") }] });
    const run = w.run();
    const report = await run.run();
    expect(extractions(report)).toEqual([`extract "broken.pdf": FAIL get_attachment couldn't read "broken.pdf" (corrupt: The file isn't a readable PDF)`]);
    expect(report.leftBehind).toEqual([]);
    expect(report.ok).toBe(false);
    expect(existsSync(join(w.s.dataDir, "attachments"))).toBe(false);
    for (const secret of SECRETS) expect([...w.out, JSON.stringify(report)].join("\n")).not.toContain(secret);
    await expectClean(w, run);
  });

  it("a document parser that isn't available (attachment-parser.js missing) fails the step, with the reason", async () => {
    const w = await world();
    // What a package without dist/attachment-parser.js does: the parser code can't be loaded.
    setAttachmentParser(w.s.ctx, new AttachmentParser(createLogger("test").child("parser"), { loadCode: async () => Promise.reject(new Error("ENOENT: attachment-parser.js")) }));
    const report = await w.run().run();
    expect(extractions(report)).toEqual([
      `extract "lease.pdf": FAIL get_attachment couldn't read "lease.pdf" (unavailable: the document parser isn't available on this server)`,
      expect.stringMatching(/^extract "notes.txt": PASS text: text, \d+ chars$/),
    ]);
    expect(report.leftBehind).toEqual([]);
    expect(report.ok).toBe(false);
  });

  it("a get_attachment answer that saved the file anyway (an xaq that ignores format \"inline\") fails the step and lists the saved copy", async () => {
    // Listed as a small PDF, so the run asks for it; this get_attachment can't parse it and saves it instead.
    const w = await world({ attachments: [{ filename: "broken.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF-1.4 ATTACHMENT-SECRET not really a pdf") }] });
    w.knobs.ignoreFormat = true;
    const report = await w.run().run();
    const step = report.steps.find((s) => s.step === 'extract "broken.pdf"')!;
    expect(step.status).toBe("FAIL");
    expect(step.detail).toContain("saved");
    expect(report.leftBehind).toHaveLength(1);
    const saved = /^A copy of the email attachment "broken\.pdf" was saved at (.+): delete it\.$/.exec(report.leftBehind[0]!)?.[1];
    expect(saved).toBeDefined();
    expect(existsSync(saved!)).toBe(true);
    expect(report.ok).toBe(false);
    for (const secret of SECRETS) expect([...w.out, JSON.stringify(report)].join("\n")).not.toContain(secret);
  });

  it("sweeps earlier runs first: their agents deleted, their temp dirs out of attachmentDirs, their drafts and folders listed", async () => {
    const w = await world();
    // An earlier run that died: its agent, a draft it made, its temp dir in attachmentDirs and on disk, its folder.
    const old = await w.admin.request<AgentWithKey>("POST", "/api/smoke/agents", { name: "xaq-smoke-20250101T000000Z", accountId: w.account.id, connectionId: w.connection.id });
    const oldMcp = await connectAgentMcp(w.admin.baseUrl, old.apiKey);
    cleanup.push(() => oldMcp.close());
    const oldDraft = JSON.parse((await oldMcp.call("create_draft", { to: [EMAIL], subject: "[xaq-smoke-20250101T000000Z] old", body: "x" })).text) as { draftId: string };
    const oldDir = join(w.tmpRoot, "xaq-smoke", "xaq-smoke-20250101T000000Z-abc123");
    mkdirSync(oldDir, { recursive: true });
    const keep = mkdtempSync(join(w.tmpRoot, "outgoing-"));
    await w.admin.request("PATCH", "/api/settings", { attachmentDirs: [keep, oldDir] });
    const folder = w.ws.addFile({ name: "xaq-smoke-20250101T000000Z", kind: "folder" });

    const run = w.run();
    const report = await run.run();
    expect(report.steps.find((s) => s.step === "sweep earlier runs' leftovers")!.detail).toBe(
      "1 agent(s) deleted (xaq-smoke-20250101T000000Z), 1 attachmentDirs entry removed, 1 temp dir(s) removed, 1 draft(s) to check",
    );
    expect(report.earlier).toEqual([
      `An earlier run's (xaq-smoke-20250101T000000Z) draft ${oldDraft.draftId} is still in ${EMAIL}: check it in Gmail (Drafts) and delete it.`,
      `An earlier run's Drive folder "xaq-smoke-20250101T000000Z" (${folder.id}) isn't in the trash: check it and trash it.`,
    ]);
    expect(renderReport(report).join("\n")).toContain("From earlier runs (check these)");
    // Not this run's doing: it still passes, and the owner's own attachment dir stays.
    expect(report.leftBehind).toEqual([]);
    expect(report.ok).toBe(true);
    expect(existsSync(oldDir)).toBe(false);
    expect((await w.admin.request<{ attachmentDirs: string[] }>("GET", "/api/settings")).attachmentDirs).toEqual([keep]);
    expect((await w.s.admin.get<{ name: string }[]>("/api/agents")).filter((a) => a.name.startsWith("xaq-smoke-"))).toEqual([]);
    // Reported, never deleted, and never touched.
    expect(w.s.fake.drafts(EMAIL).map((d) => d.id)).toEqual([oldDraft.draftId]);
    expect(w.ws.isTrashed(folder.id)).toBe(false);
  });

  it("the sweep deletes only agents a smoke run created (the audit log), never an owner's agent with a lookalike name", async () => {
    const w = await world();
    // The owner's own agent, made in the console, that happens to be named like a run.
    const lookalike = await w.s.createAgent("xaq-smoke-20240101T000000Z", [
      { accountId: w.account.id, capabilities: ["read"], labelScope: null, sendMode: "draft_only", allowTo: [], replyOnly: false, maxSendsPerHour: null, maxSendsPerDay: null },
    ]);
    const report = await w.run().run();
    expect(report.steps.find((s) => s.step === "sweep earlier runs' leftovers")!.detail).toMatch(/^0 agent\(s\) deleted,/);
    expect((await w.s.admin.get<{ id: string }[]>("/api/agents")).map((a) => a.id)).toEqual([lookalike.agent.id]);
    // Not a smoke run's agent, so not this run's leftover either.
    expect(report.leftBehind).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("the sweep removes only a run's own temp dir from attachmentDirs, never an owner's dir named xaq-smoke-…", async () => {
    const w = await world();
    const docs = join(w.tmpRoot, "Documents");
    const notes = join(docs, "xaq-smoke-notes");
    const lookalike = join(docs, "xaq-smoke-20250101T000000Z-abc123"); // the right name, but not in the private dir
    const runDir = join(w.tmpRoot, "xaq-smoke", "xaq-smoke-20250101T000000Z-def456");
    for (const d of [notes, lookalike, runDir]) mkdirSync(d, { recursive: true });
    await w.admin.request("PATCH", "/api/settings", { attachmentDirs: [notes, lookalike, runDir] });
    const report = await w.run().run();
    expect(report.steps.find((s) => s.step === "sweep earlier runs' leftovers")!.detail).toContain("1 attachmentDirs entry removed");
    expect((await w.admin.request<{ attachmentDirs: string[] }>("GET", "/api/settings")).attachmentDirs).toEqual([notes, lookalike]);
    expect(existsSync(notes) && existsSync(lookalike)).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("the leftover check finds creates the run never recorded: a Drive file with its name, a draft from the audit log", async () => {
    const w = await world();
    // A sheet created outside the folder whose answer got lost, and a draft whose answer got lost.
    w.ws.fault("sheets_create", (a) => {
      w.ws.addFile({ name: String(a.title), kind: "sheet" });
      throw new Error("the answer got lost");
    });
    w.knobs.dropDraftAnswer = true;
    const run = w.run();
    const report = await run.run();
    const drafts = w.s.fake.drafts(EMAIL);
    expect(drafts).toHaveLength(1);
    const lost = [...w.ws.files.values()].find((f) => f.name === `${run.ledger.marker} sheet`)!;
    expect(report.leftBehind).toEqual([
      `Drive sheet "${run.ledger.marker} sheet" (${lost.id}) carries this run's name and isn't in the trash: check it and trash it.`,
      `The draft ${drafts[0]!.id} still exists in ${EMAIL}: delete it in Gmail (Drafts).`,
    ]);
    expect(report.ok).toBe(false);
  });

  it("an injected failure mid-run: the rest still runs, cleanup still happens, and the run fails", async () => {
    const w = await world();
    w.ws.fault("sheets_write", () => {
      throw new Error("Sheets is having a bad day");
    });
    const run = w.run();
    const report = await run.run();
    expect(statusOf(report, "sheets_write")).toEqual(["FAIL"]);
    expect(report.steps.find((s) => s.tool === "sheets_write")!.detail).toContain("bad day");
    // Later sections still ran.
    expect(statusOf(report, "slides_delete_slide")).toEqual(["PASS"]);
    expect(statusOf(report, "create_draft")).toEqual(["PASS"]);
    expect(report.ok).toBe(false);
    expect(report.leftBehind).toEqual([]);
    await expectClean(w, run);
  });

  it("a private Drive image that does get inserted is a failure (it would mean the PNG was shared)", async () => {
    const w = await world();
    w.ws.fault("slides_insert_image", () => {
      for (const f of w.ws.files.values()) f.shared = true;
    });
    const run = w.run();
    const report = await run.run();
    const step = report.steps.find((s) => s.step === "Drive image (private)")!;
    expect(step.status).toBe("FAIL");
    expect(step.detail).toContain("inserted a private Drive image");
    expect(report.ok).toBe(false);
    expect(report.leftBehind).toEqual([]);
  });

  it("files inside the trashed scratch folder count as gone while Drive is still trashing them (no false leftover)", async () => {
    const w = await world();
    w.ws.lazyTrashCascade = true;
    const run = w.run();
    const report = await run.run();
    expect(report.leftBehind).toEqual([]);
    expect(report.ok).toBe(true);
    // The children really are still marked untrashed on their own: only the folder carries the flag.
    const children = [...w.ws.files.values()].filter((f) => f.parents.includes(run.ledger.folder!.id));
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((f) => !f.trashed)).toBe(true);
  });

  it("a file the run made outside the trashed folder is still reported", async () => {
    const w = await world();
    w.ws.lazyTrashCascade = true;
    w.ws.fault("drive_trash", () => {
      // The doc got moved out of the scratch folder before cleanup (to My Drive's top level).
      for (const f of w.ws.files.values()) if (f.kind === "doc" && f.name.endsWith(" doc")) f.parents = ["root"];
      w.ws.fault("drive_trash", () => {});
    });
    const report = await w.run().run();
    expect(report.leftBehind.some((l) => /Drive doc ".* doc" .* is not in the trash/.test(l))).toBe(true);
  });

  it("when cleanup itself fails, what's left is reported, and the agent and settings are still removed", async () => {
    const w = await world();
    w.ws.fault("drive_trash", () => {
      throw new Error("Drive refused");
    });
    const run = w.run();
    const report = await run.run();
    expect(statusOf(report, "drive_trash")).toEqual(["FAIL"]);
    expect(report.ok).toBe(false);
    expect(report.leftBehind.join("\n")).toMatch(new RegExp(`Drive folder "${run.ledger.marker}" \\(.+\\) is not in the trash`));
    expect(report.leftBehind.some((l) => /Drive doc ".* doc" .* is not in the trash/.test(l))).toBe(true);
    expect(renderReport(report).join("\n")).toContain("is not in the trash");
    // Everything else is gone.
    const agents = await w.s.admin.get<{ name: string }[]>("/api/agents");
    expect(agents.filter((a) => a.name.startsWith("xaq-smoke-"))).toEqual([]);
    expect(w.s.fake.drafts(EMAIL)).toEqual([]);
    expect((await w.admin.request<{ attachmentDirs: string[] }>("GET", "/api/settings")).attachmentDirs).toEqual([]);
  });

  it("the guard refuses to write to an id outside the scratch folder (an extension answering with an existing file's id)", async () => {
    const w = await world();
    w.ws.wrongDocId = "doc-existing";
    const run = w.run();
    const report = await run.run();
    const create = report.steps.find((s) => s.tool === "docs_create")!;
    expect(create.status).toBe("FAIL");
    expect(create.detail).toMatch(/guard refused: .*isn't in the scratch folder/);
    // Nothing touched the existing doc: the later doc steps were skipped, the draft had no doc to attach.
    for (const t of ["docs_append", "docs_replace_text", "docs_comment_add"]) expect(statusOf(report, t)).toEqual(["SKIP"]);
    expect(w.ws.calls.filter((c) => c.tool in WRITE_TARGETS && Object.values(c.args).includes("doc-existing"))).toEqual([]);
    expectOnlyScratchWrites(w, run);
    // Its real name, and a warning that it may be the owner's file.
    expect(report.leftBehind).toEqual([
      `Drive doc "Quarterly plan" (doc-existing) came back from a create call but isn't in the scratch folder. It may be an existing file: check it before removing anything.`,
    ]);
    expect(report.ok).toBe(false);
    const agents = await w.s.admin.get<{ name: string }[]>("/api/agents");
    expect(agents.filter((a) => a.name.startsWith("xaq-smoke-"))).toEqual([]);
  });

  it("Ctrl-C mid-run: no new step starts, cleanup runs, nothing is left, the run says it was interrupted", async () => {
    const w = await world();
    w.ws.fault("sheets_create", () => w.controller.abort());
    const run = w.run();
    const report = await run.run();
    expect(report.interrupted).toBe(true);
    expect(report.ok).toBe(false);
    // sheets_create itself finished (its sheet is in the ledger); nothing after it ran.
    expect(statusOf(report, "sheets_create")).toEqual(["PASS"]);
    expect([...run.ledger.files.values()].map((f) => f.kind)).toEqual(["doc", "sheet"]);
    expect(w.ws.calls.some((c) => c.tool === "sheets_write")).toBe(false);
    expect(w.ws.calls.some((c) => c.tool === "slides_create")).toBe(false);
    expect(statusOf(report, "create_draft")).toEqual([]);
    expect(statusOf(report, "drive_trash")).toEqual(["PASS"]);
    expect(report.leftBehind).toEqual([]);
    expect(w.out.join("\n")).toContain("Interrupted: cleaning up");
    await expectClean(w, run);
  });

  it("refuses to run without --scratch, and creates nothing", async () => {
    const w = await world();
    await expect(w.run({ scratch: false }).run()).rejects.toThrow(/Pass --scratch/);
    expect(w.ws.calls).toEqual([]);
    expect((await w.s.admin.get<{ name: string }[]>("/api/agents")).length).toBe(0);
  });

  it("the daemon only lets the run read or delete its own draft: created by the smoke agent, in the ledger, with the marker", async () => {
    const w = await world();
    // An ordinary agent's draft (to someone else): the smoke endpoints refuse it.
    const other: AgentWithKey = await w.s.createAgent("hermes", [
      { accountId: w.account.id, capabilities: ["read", "draft"], labelScope: null, sendMode: "draft_only", allowTo: [], replyOnly: false, maxSendsPerHour: null, maxSendsPerDay: null },
    ]);
    const mcp = await connectAgentMcp(w.admin.baseUrl, other.apiKey);
    cleanup.push(() => mcp.close());
    const made = JSON.parse((await mcp.call("create_draft", { to: ["bob@else.test"], subject: "[xaq-smoke-20261019T000000Z] lookalike", body: "hi" })).text) as { draftId: string };
    const smoke = await w.admin.request<AgentWithKey>("POST", "/api/smoke/agents", { name: "xaq-smoke-20261019T000000Z", accountId: w.account.id, connectionId: w.connection.id });
    const input = { agentId: smoke.agent.id, accountId: w.account.id, draftId: made.draftId, ledger: [made.draftId] };
    await expect(w.admin.request("POST", "/api/smoke/drafts/delete", input)).rejects.toThrow(/didn't create that draft/);
    await expect(w.admin.request("POST", "/api/smoke/drafts/inspect", input)).rejects.toThrow(/didn't create that draft/);
    // Not a smoke agent at all.
    await expect(w.admin.request("POST", "/api/smoke/drafts/delete", { ...input, agentId: other.agent.id })).rejects.toThrow(/isn't a smoke run's agent/);
    // The smoke agent's own draft, but not in the ledger.
    const sm = await connectAgentMcp(w.admin.baseUrl, smoke.apiKey);
    cleanup.push(() => sm.close());
    const own = JSON.parse((await sm.call("create_draft", { to: [EMAIL], subject: "no marker", body: "x" })).text) as { draftId: string };
    const ownInput = { ...input, draftId: own.draftId, ledger: [own.draftId] };
    await expect(w.admin.request("POST", "/api/smoke/drafts/delete", { ...ownInput, ledger: [] })).rejects.toThrow(/ledger/);
    // In the ledger and created by it, but without the marker in the subject.
    await expect(w.admin.request("POST", "/api/smoke/drafts/delete", ownInput)).rejects.toThrow(/subject doesn't carry/);
    expect(w.s.fake.drafts(EMAIL)).toHaveLength(2);
    // The smoke agent can't be named anything else.
    await expect(w.admin.request("POST", "/api/smoke/agents", { name: "hermes-2", accountId: w.account.id, connectionId: w.connection.id })).rejects.toThrow(/xaq-smoke/);
    // The leftover check without an agent of its own still lists every smoke agent, and finds drafts in the audit log.
    const noAgent = await w.admin.request<{ otherSmokeAgents: { name: string }[]; agent: boolean }>("POST", "/api/smoke/leftovers", { agentId: null, accountId: w.account.id, draftIds: [] });
    expect(noAgent).toMatchObject({ agent: false, otherSmokeAgents: [{ name: "xaq-smoke-20261019T000000Z" }] });
    const viaAudit = await w.admin.request<{ drafts: string[] }>("POST", "/api/smoke/leftovers", { agentId: smoke.agent.id, accountId: w.account.id, draftIds: [] });
    expect(viaAudit.drafts).toEqual([own.draftId]);
  });
});

describe("the smoke run's guards", () => {
  const folder = { id: "fold1", name: "xaq-smoke-20261019T203000Z" };
  const setup = () => {
    const ledger = newLedger(folder.name);
    ledger.folder = folder;
    ledger.tempDir = "/tmp/xaq-smoke-abc";
    ledger.files.set("doc1", { kind: "doc", name: "d" });
    ledger.files.set("moved", { kind: "doc", name: "m" });
    const where: Record<string, string[]> = { fold1: ["root"], doc1: ["fold1"], moved: ["elsewhere"], "doc-existing": ["root"] };
    const seen: string[] = [];
    const guard = new ScratchGuard(ledger, async (id) => {
      seen.push(id);
      return { id, name: id === "fold1" ? folder.name : id, parents: where[id] ?? [], trashed: false };
    });
    return { ledger, guard, seen };
  };

  it("allows writes into the scratch folder and to its files", async () => {
    const { guard, seen } = setup();
    await guard.checkWrite("docs_create", { title: "x", folderId: "fold1" });
    await guard.checkWrite("docs_append", { documentId: "doc1", markdown: "x" });
    await guard.checkWrite("drive_trash", { fileId: "fold1" });
    expect(seen).toEqual(["fold1", "doc1", "fold1"]);
  });

  it("refuses a write to an id outside the scratch folder, one the run didn't create, or a create elsewhere", async () => {
    const { guard } = setup();
    await expect(guard.checkWrite("docs_append", { documentId: "doc-existing", markdown: "x" })).rejects.toThrow(/isn't a file this run created/);
    // In the ledger, but drive_get says it's no longer in the folder.
    await expect(guard.checkWrite("docs_append", { documentId: "moved", markdown: "x" })).rejects.toThrow(/isn't in the scratch folder/);
    await expect(guard.checkWrite("docs_create", { title: "x" })).rejects.toThrow(/folderId must be the scratch folder/);
    await expect(guard.checkWrite("docs_create", { title: "x", folderId: "root" })).rejects.toThrow(GuardError);
    await expect(guard.checkWrite("drive_trash", { fileId: "doc-existing" })).rejects.toThrow(/must be the scratch folder/);
    await expect(guard.checkWrite("slides_insert_image", { presentationId: "doc1", slideId: "s", driveFileId: "doc-existing" })).rejects.toThrow(/driveFileId/);
    await expect(guard.checkWrite("docs_overwrite", { documentId: "doc1" })).rejects.toThrow(/isn't one of the writes/);
    await expect(guard.checkWrite("drive_create_folder", { name: folder.name })).rejects.toThrow(/already exists/);
    // Every file argument is required (a missing one is never "no target"), except driveFileId.
    await expect(guard.checkWrite("docs_append", { markdown: "x" })).rejects.toThrow(/documentId must be a file id/);
    await expect(guard.checkWrite("slides_delete_slide", { slideId: "s" })).rejects.toThrow(/presentationId must be a file id/);
    await guard.checkWrite("slides_insert_image", { presentationId: "doc1", slideId: "s", imageUrl: "https://x.test/a.png" });
  });

  it("refuses everything when there is no scratch folder", async () => {
    const { ledger, guard } = setup();
    ledger.folder = null;
    await expect(guard.checkWrite("docs_create", { title: "x", folderId: "fold1" })).rejects.toThrow(/no scratch folder/);
    await expect(guard.checkWrite("drive_create_folder", { name: "other" })).rejects.toThrow(/must be named/);
    await expect(guard.checkWrite("drive_create_folder", { name: folder.name, parentId: "x" })).rejects.toThrow(/top of My Drive/);
    await guard.checkWrite("drive_create_folder", { name: folder.name });
  });

  it("refuses a draft to anyone but the account's own address, and attachments from elsewhere", async () => {
    const { guard } = setup();
    const ok = { to: ["Wynn@Acme.test"], subject: "s", body: "b", attachments: [{ path: "/tmp/xaq-smoke-abc/f.txt" }, { drive_file_id: "doc1" }] };
    await guard.checkDraft(ok, EMAIL);
    await expect(guard.checkDraft({ ...ok, to: ["bob@else.test"] }, EMAIL)).rejects.toThrow(/exactly wynn@acme.test/);
    await expect(guard.checkDraft({ ...ok, to: [EMAIL, "bob@else.test"] }, EMAIL)).rejects.toThrow(GuardError);
    await expect(guard.checkDraft({ ...ok, to: EMAIL }, EMAIL)).rejects.toThrow(GuardError);
    await expect(guard.checkDraft({ ...ok, cc: ["bob@else.test"] }, EMAIL)).rejects.toThrow(/no cc/);
    await expect(guard.checkDraft({ ...ok, bcc: ["bob@else.test"] }, EMAIL)).rejects.toThrow(/no bcc/);
    await expect(guard.checkDraft({ ...ok, thread_id: "t" }, EMAIL)).rejects.toThrow(/no thread_id/);
    await expect(guard.checkDraft({ ...ok, attachments: [{ path: "/home/wynn/.ssh/id_ed25519" }] }, EMAIL)).rejects.toThrow(/temp dir/);
    await expect(guard.checkDraft({ ...ok, attachments: [{ path: "/tmp/xaq-smoke-abc/../x" }] }, EMAIL)).rejects.toThrow(/temp dir/);
    await expect(guard.checkDraft({ ...ok, attachments: [{ drive_file_id: "doc-existing" }] }, EMAIL)).rejects.toThrow(/isn't a file this run created/);
    await expect(guard.checkDraft({ ...ok, attachments: [{ message_id: "m", attachment_id: "a" }] }, EMAIL)).rejects.toThrow(/temp-dir file or a scratch-folder file/);
    // Exactly one source per item, and nothing else riding along.
    await expect(guard.checkDraft({ ...ok, attachments: [{ path: "/tmp/xaq-smoke-abc/f.txt", drive_file_id: "doc-existing" }] }, EMAIL)).rejects.toThrow(/exactly one source, not path \+ drive_file_id/);
    await expect(guard.checkDraft({ ...ok, attachments: [{ drive_file_id: "doc1", content_base64: "eA==" }] }, EMAIL)).rejects.toThrow(/exactly one source/);
    await expect(guard.checkDraft({ ...ok, attachments: [{ export_as: "pdf" }] }, EMAIL)).rejects.toThrow(/exactly one source, not none/);
    await expect(guard.checkDraft({ ...ok, attachments: [{ path: "/tmp/xaq-smoke-abc/f.txt", to: "bob@else.test" }] }, EMAIL)).rejects.toThrow(/unexpected attachment keys to/);
  });
});

describe("the smoke command's setup", () => {
  const conn = (over: Partial<ConnectionView>): ConnectionView =>
    ({ id: "con_1", slug: "workspace", name: "Google Workspace", preset: "google-workspace", status: "active", statusReason: null, grantedScopes: null, ...over }) as ConnectionView;
  const acc = (email: string, status = "active") => ({ id: `acc_${email}`, email, status }) as Account;

  it("picks the only account and the only Workspace connection, or says what to pass", () => {
    expect(chooseTargets({}, [acc(EMAIL)], [conn({})], "https://x.test").account.email).toBe(EMAIL);
    expect(() => chooseTargets({}, [acc(EMAIL), acc("b@x.test")], [conn({})], "https://x.test")).toThrow(/--account/);
    expect(() => chooseTargets({}, [acc(EMAIL)], [conn({}), conn({ id: "con_2", slug: "ws2" })], "https://x.test")).toThrow(/--connection/);
    expect(chooseTargets({ account: "B@x.test" }, [acc(EMAIL), acc("b@x.test")], [conn({})], "https://x.test").account.email).toBe("b@x.test");
  });

  it("fails clearly when Workspace isn't connected, isn't working or misses scopes, with the console path", () => {
    expect(() => chooseTargets({}, [acc(EMAIL)], [], "https://x.test/")).toThrow(/ext add google-workspace.*https:\/\/x\.test\/connections$/);
    expect(() => chooseTargets({}, [acc(EMAIL)], [conn({ status: "needs_reauth" })], "https://x.test")).toThrow(/needs reauth.*https:\/\/x\.test\/connections\/con_1/);
    expect(() => chooseTargets({}, [acc(EMAIL)], [conn({ grantedScopes: ["https://www.googleapis.com/auth/documents"] })], "https://x.test")).toThrow(
      /missing Google permissions: spreadsheets, presentations, drive.file, drive.readonly.*connections\/con_1/,
    );
    // C's view: google.missing lists { scope, grants, without }.
    const lacking = conn({
      google: {
        email: EMAIL,
        accountId: "acc_1",
        scopes: [],
        granted: [],
        missing: [
          { scope: "https://www.googleapis.com/auth/presentations", grants: "Edit Slides", without: "Slides tools fail" },
          { scope: "https://www.googleapis.com/auth/drive.file", grants: "Create files", without: null },
        ],
      },
    });
    expect(() => chooseTargets({}, [acc(EMAIL)], [lacking], "https://x.test")).toThrow(/missing Google permissions: presentations, drive\.file\. .*connections\/con_1/);
    const complete = conn({ google: { email: EMAIL, accountId: "acc_1", scopes: [], granted: [], missing: [] } });
    expect(chooseTargets({}, [acc(EMAIL)], [complete], "https://x.test").connection.id).toBe("con_1");
    expect(() => chooseTargets({}, [acc(EMAIL, "needs_reauth")], [conn({})], "https://x.test")).toThrow(/needs reauth.*\/accounts/);
    expect(() => chooseTargets({ connection: "nope" }, [acc(EMAIL)], [conn({})], "https://x.test")).toThrow(/No connection "nope"/);
  });

  it("uses the Google account the connection is signed in as, and refuses a mismatch", () => {
    const bound = conn({ google: { email: "b@x.test", accountId: "acc_b", scopes: [], granted: [], missing: [] } });
    expect(chooseTargets({}, [acc(EMAIL), acc("b@x.test")], [bound], "https://x.test").account.email).toBe("b@x.test");
    expect(() => chooseTargets({ account: EMAIL }, [acc(EMAIL), acc("b@x.test")], [bound], "https://x.test")).toThrow(/signed in as b@x.test/);
    // Not bound yet (google.email null): the usual default applies.
    const unbound = conn({ google: { email: null, accountId: null, scopes: [], granted: [], missing: [] } });
    expect(chooseTargets({}, [acc(EMAIL)], [unbound], "https://x.test").account.email).toBe(EMAIL);
  });

  it("reads list_attachments' structured list (A2) or its text lines, with types and sizes", () => {
    const t = (text: string): CallOutcome => ({ isError: false, text, structured: null, content: [] });
    expect(parseAttachmentList(t("Attachments: a b.pdf (application/pdf, 2 KB, attachment_id: A1); c.txt (text/plain, 10 B, attachment_id: A2)"))).toEqual([
      { filename: "a b.pdf", mimeType: "application/pdf", size: 2048, id: "A1" },
      { filename: "c.txt", mimeType: "text/plain", size: 10, id: "A2" },
    ]);
    expect(parseAttachmentList(t("2 attachments:\n- x.png (image/png, 1 KB) · message_id: m · attachment_id: X · 2026-10-01\n- y.csv (text/csv, 1.5 MB) · message_id: m · attachment_id: Y"))).toEqual([
      { filename: "x.png", mimeType: "image/png", size: 1024, id: "X" },
      { filename: "y.csv", mimeType: "text/csv", size: 1572864, id: "Y" },
    ]);
    expect(parseAttachmentList({ ...t(""), structured: { attachments: [{ attachmentId: "Z", filename: "z.pdf", mimeType: "application/pdf", size: 9 }] } })).toEqual([
      { filename: "z.pdf", mimeType: "application/pdf", size: 9, id: "Z" },
    ]);
  });

  it("a run's temp dir is recognised only by its exact shape inside the private smoke directory", () => {
    expect(isSmokeDir("/home/w/.cache/xaq-smoke/xaq-smoke-20261019T203000Z-a1B2c3")).toBe(true);
    expect(isSmokeDir("/home/w/.cache/xaq-smoke/xaq-smoke-20261019T203000Z-a1B2c3/")).toBe(true);
    expect(isSmokeDir("/home/w/Documents/xaq-smoke-notes")).toBe(false);
    expect(isSmokeDir("/home/w/Documents/xaq-smoke-20261019T203000Z-a1B2c3")).toBe(false);
    expect(isSmokeDir("/home/w/.cache/xaq-smoke/xaq-smoke-notes")).toBe(false);
    expect(isSmokeDir("/home/w/.cache/xaq-smoke/xaq-smoke-20261019T203000Z-a1B2c3/inner")).toBe(false);
    expect(isSmokeDir("/home/w/.cache/xaq-smoke")).toBe(false);
    expect(isSmokeDir("/tmp/xaq-smoke-abc123")).toBe(false);
  });

  it("extracts only what get_attachment can show inline (A2's kinds and caps); anything else is skipped", () => {
    const k = (filename: string, mimeType: string, size = 1000) => inlineKind({ filename, mimeType, size });
    expect([k("a.pdf", "application/pdf"), k("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), k("a.xlsx", "application/octet-stream")]).toEqual(["pdf", "docx", "xlsx"]);
    expect([k("a.csv", "text/csv"), k("a.pptx", "application/zip"), k("a.txt", "text/plain"), k("a.html", "text/html"), k("a.md", "application/octet-stream")]).toEqual(["csv", "pptx", "text", "html", "text"]);
    expect(k("a.png", "image/png")).toBe("image");
    // Not shown inline (auto would save them): other types, images at or over 5 MB, documents at or over 25 MB, unknown sizes.
    expect([k("a.zip", "application/zip"), k("a.exe", "application/x-msdownload"), k("a.heic", "image/heic"), k("noext", "application/octet-stream")]).toEqual([null, null, null, null]);
    expect(k("big.png", "image/png", 5 * 1024 * 1024)).toBeNull();
    expect(k("big.pdf", "application/pdf", 25 * 1024 * 1024)).toBeNull();
    expect(k("a.pdf", "application/pdf", Number.NaN)).toBeNull();
    expect(k("huge.txt", "text/plain", 500 * 1024 * 1024)).toBe("text");
  });

  const handler = (sig: "SIGINT" | "SIGTERM" | "SIGHUP", before: Set<unknown>) => process.listeners(sig).find((l) => !before.has(l)) as () => void;

  it("Ctrl-C: the first stops the run (cleanup follows); the second runs the quick cleanup, says what's left and quits", async () => {
    const controller = new AbortController();
    const printed: string[] = [];
    const exits: number[] = [];
    let fast = 0;
    const before = new Set(process.listeners("SIGINT"));
    const remove = installSmokeSignals(controller, {
      print: (l) => printed.push(l),
      exit: (c) => exits.push(c),
      fastCleanup: async () => {
        fast++;
      },
      leftovers: () => "These may be left: the Drive folder xaq-smoke-x.",
    });
    try {
      const ours = handler("SIGINT", before);
      ours();
      expect(controller.signal.aborted).toBe(true);
      expect(exits).toEqual([]);
      expect(printed.join("\n")).toContain("cleaning up");
      ours();
      ours(); // a third press while quitting changes nothing
      await new Promise((r) => setTimeout(r, 10));
      expect(fast).toBe(1);
      expect(exits).toEqual([130]);
      expect(printed.join("\n")).toContain("deleting the temporary agent and restoring attachmentDirs first");
      expect(printed.join("\n")).toContain("These may be left: the Drive folder xaq-smoke-x.");
    } finally {
      remove();
    }
    expect(process.listeners("SIGINT").filter((l) => !before.has(l))).toEqual([]);
  });

  it("the second Ctrl-C quits within its bound even when the quick cleanup hangs", async () => {
    const exits: number[] = [];
    const before = new Set(process.listeners("SIGINT"));
    const remove = installSmokeSignals(new AbortController(), { print: () => {}, exit: (c) => exits.push(c), fastCleanup: () => new Promise(() => {}), leftovers: () => "", quitWithinMs: 20 });
    try {
      const ours = handler("SIGINT", before);
      ours();
      ours();
      await new Promise((r) => setTimeout(r, 60));
      expect(exits).toEqual([130]);
    } finally {
      remove();
    }
  });

  it("SIGTERM and SIGHUP act like the first Ctrl-C, however often: they stop the run and never skip its cleanup", () => {
    for (const sig of ["SIGTERM", "SIGHUP"] as const) {
      const controller = new AbortController();
      const exits: number[] = [];
      const before = new Set(process.listeners(sig));
      const remove = installSmokeSignals(controller, { print: () => {}, exit: (c) => exits.push(c), fastCleanup: async () => {}, leftovers: () => "" });
      try {
        const ours = handler(sig, before);
        ours();
        ours();
        ours();
        expect(controller.signal.aborted).toBe(true);
        expect(exits).toEqual([]);
      } finally {
        remove();
      }
    }
  });

  it("printing can't kill the run: a terminal that went away (EIO) drops the lines", async () => {
    const { Writable } = await import("node:stream");
    let writes = 0;
    const tty = new Writable({
      write(_chunk, _enc, cb) {
        writes++;
        cb(Object.assign(new Error("write EIO"), { code: "EIO" }));
      },
    });
    const w = safeWriter(tty);
    w.print("one");
    await new Promise((r) => setTimeout(r, 5));
    expect(() => w.print("two")).not.toThrow();
    expect(writes).toBe(1);
    const throwing = { on: () => throwing, removeListener: () => throwing, write: () => { throw new Error("EIO"); } } as unknown as NodeJS.WritableStream;
    const t = safeWriter(throwing);
    expect(() => t.print("x")).not.toThrow();
    w.dispose();
  });

  it("refuses without --scratch before touching the daemon", async () => {
    let calls = 0;
    const run = new SmokeRun({}, { admin: { baseUrl: "http://127.0.0.1:1", request: async () => (calls++, null) as never }, connectMcp: async () => ({}) as AgentMcp, print: () => {}, confirm: async () => true, signal: new AbortController().signal });
    await expect(run.run()).rejects.toBeInstanceOf(SmokeSetupError);
    expect(calls).toBe(0);
  });
});
