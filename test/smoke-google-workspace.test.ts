// `xaq smoke google-workspace --scratch` end to end, offline: the real daemon (startStack: real HTTP, the fake
// Google for Gmail), the real admin channel (a one-time session in the data dir), /mcp as the temporary agent, and a
// fake google-workspace extension (test/fake-workspace.ts) as an MCP upstream connection at "ask".
//
// Until writer A1 (attachment sources, attachmentDirs) and A2 (list_attachments) land, two small shims stand in for
// them, and only when the daemon lacks them: attachmentDirs on /api/settings, and create_draft's { path } and
// { drive_file_id } items turned into today's content_base64 items. Once A1/A2 are merged the shims switch off by
// themselves and the same tests run against the real thing.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Account, AgentWithKey, ConnectionView } from "../shared/types.ts";
import { type AdminChannel, openAdminChannel } from "../server/connections-cli/admin.ts";
import { type AgentMcp, type CallOutcome, connectAgentMcp } from "../server/smoke/agent.ts";
import { installSmokeSignals } from "../server/smoke/cli.ts";
import { GuardError, newLedger, ScratchGuard, WRITE_TARGETS } from "../server/smoke/guards.ts";
import { renderReport } from "../server/smoke/report.ts";
import { chooseTargets, parseAttachmentList, SmokeRun, SmokeSetupError } from "../server/smoke/run.ts";
import { HAS_AGENTS } from "./e2e/features.ts";
import { type Stack, startStack } from "./e2e/harness.ts";
import { startFakeMcpUpstream } from "./fake-mcp-upstream.ts";
import { type FakeWorkspace, fakeWorkspace } from "./fake-workspace.ts";

const EMAIL = "wynn@acme.test";
const SECRETS = ["TOP-SECRET-DOC-CONTENT", "TOP-SECRET-SHEET-CONTENT", "TOP-SECRET-SLIDE-CONTENT", "EMAIL-BODY-SECRET", "ATTACHMENT-SECRET"];
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

// ───────────── The A1/A2 stand-ins (inactive once the daemon has them) ─────────────

interface Shims {
  /** attachmentDirs as the shim keeps it (null when the daemon has the real setting). */
  dirs: () => string[] | null;
}

function shimAdmin(channel: AdminChannel): Pick<AdminChannel, "request" | "baseUrl"> & Shims {
  let native: boolean | null = null;
  let dirs: string[] = [];
  return {
    baseUrl: channel.baseUrl,
    dirs: () => (native === false ? dirs : null),
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (path === "/api/settings") {
        native ??= Array.isArray((await channel.request<{ attachmentDirs?: unknown }>("GET", path)).attachmentDirs);
        if (!native) {
          let rest = body as Record<string, unknown> | undefined;
          if (method === "PATCH" && rest && "attachmentDirs" in rest) {
            const { attachmentDirs, ...others } = rest;
            dirs = [...(attachmentDirs as string[])];
            rest = others;
          }
          const r = method === "PATCH" && rest && Object.keys(rest).length ? await channel.request<object>(method, path, rest) : await channel.request<object>("GET", path);
          return { ...r, attachmentDirs: [...dirs] } as T;
        }
      }
      return channel.request<T>(method, path, body);
    },
  };
}

function shimMcp(mcp: AgentMcp, ws: FakeWorkspace, shims: Shims): AgentMcp {
  let natives: Set<string> | null = null;
  const listed = async () => (natives ??= new Set(await mcp.listTools()));
  const text = (t: string, isError = false): CallOutcome => ({ isError, text: t, structured: null, content: [{ type: "text", text: t }] });
  return {
    async listTools() {
      const names = [...(await listed())];
      return names.includes("list_attachments") ? names : [...names, "list_attachments"];
    },
    async call(name, args) {
      const have = await listed();
      if (name === "list_attachments" && !have.has("list_attachments")) {
        const m = await mcp.call("get_message", args);
        const line = /^Attachments: .*$/m.exec(m.text.split("<email_content ")[0] ?? "")?.[0];
        return line ? text(line) : text("No attachments.", m.isError);
      }
      const dirs = shims.dirs();
      if (name === "create_draft" && dirs && Array.isArray(args.attachments)) {
        const items = [];
        for (const a of args.attachments as Record<string, unknown>[]) {
          if (typeof a.path === "string") {
            const abs = resolve(a.path);
            if (!dirs.some((d) => abs.startsWith(resolve(d) + sep))) return text(`${a.path} isn't in an allowed attachment directory (attachmentDirs).`, true);
            items.push({ filename: basename(abs), content_base64: readFileSync(abs).toString("base64") });
          } else if (typeof a.drive_file_id === "string") {
            const pdf = ws.exportPdf(a.drive_file_id);
            items.push({ filename: pdf.filename, mime_type: "application/pdf", content_base64: pdf.bytes.toString("base64") });
          } else items.push(a);
        }
        return mcp.call(name, { ...args, attachments: items });
      }
      return mcp.call(name, args);
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
  admin: Pick<AdminChannel, "request" | "baseUrl"> & Shims;
  out: string[];
  controller: AbortController;
  tmpRoot: string;
  run: (flags?: Record<string, unknown>) => SmokeRun;
}

async function world(): Promise<World> {
  const s = await startStack();
  cleanup.push(() => s.close());
  const [account] = (await s.bootstrap({ accounts: [{ email: EMAIL, name: "Wynn" }] })) as [Account];
  await s.admin.patch("/api/settings", { brokerUpstreams: true });
  s.fake.deliver(EMAIL, {
    from: "Landlord <leasing@offices.test>",
    subject: "Lease papers",
    text: "EMAIL-BODY-SECRET: the papers are attached.",
    attachments: [
      { filename: "lease.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF-1.4 ATTACHMENT-SECRET-PDF") },
      { filename: "notes.txt", mimeType: "text/plain", content: "ATTACHMENT-SECRET-TEXT" },
    ],
  });
  s.kick(account.id);

  const ws = fakeWorkspace();
  const up = await startFakeMcpUpstream({ tools: ws.tools });
  cleanup.push(() => up.close());
  const conn = await s.admin.post<ConnectionView>("/api/connections", { url: up.url, slug: "workspace", name: "Google Workspace", levelDefault: "ask", agentIds: [] });
  await s.admin.put(`/api/connections/${conn.id}/private-target`, { allow: true });
  await s.admin.post(`/api/connections/${conn.id}/connect`, {});
  const connection = await s.admin.get<ConnectionView>(`/api/connections/${conn.id}`);
  expect(connection.status).toBe("active");

  const channel = openAdminChannel({ dataDir: s.dataDir, instance: { pid: process.pid, host: "127.0.0.1", port: s.config.port, startedAt: "" } });
  cleanup.push(() => channel.close());
  const admin = shimAdmin(channel);
  const out: string[] = [];
  const controller = new AbortController();
  const tmpRoot = mkdtempSync(join(tmpdir(), "xaq-smoke-test-"));
  cleanup.push(() => rmSync(tmpRoot, { recursive: true, force: true }));
  const run = (flags: Record<string, unknown> = {}) =>
    new SmokeRun(
      { scratch: true, yes: true, connection: "workspace", ...flags },
      {
        admin,
        connectMcp: async (key) => shimMcp(await connectAgentMcp(admin.baseUrl, key), ws, admin),
        print: (l = "") => out.push(l),
        confirm: async () => true,
        signal: controller.signal,
        tmpRoot,
        pollMs: 10,
      },
    );
  return { s, ws, account, connection, admin, out, controller, tmpRoot, run };
}

/** Nothing of the run is left in xaq, Gmail, Drive or on disk. */
async function expectClean(w: World, run: SmokeRun) {
  const agents = await w.s.admin.get<{ name: string }[]>("/api/agents");
  expect(agents.filter((a) => a.name.startsWith("xaq-smoke-"))).toEqual([]);
  expect(w.s.ctx.db.get("SELECT 1 AS x FROM settings WHERE key LIKE 'broker.search:%'")).toBeUndefined();
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
    expectOnlyScratchWrites(w, run);
    await expectClean(w, run);
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
    expect(report.leftBehind).toEqual([`Drive doc "${run.ledger.marker} doc" (doc-existing) was created outside the scratch folder: check Drive and remove it.`]);
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
    // The smoke agent can't be named anything else, and deleting it removes its tool-mode setting.
    await expect(w.admin.request("POST", "/api/smoke/agents", { name: "hermes-2", accountId: w.account.id, connectionId: w.connection.id })).rejects.toThrow(/xaq-smoke/);
    expect(w.s.ctx.db.get("SELECT 1 AS x FROM settings WHERE key = ?", `broker.search:${smoke.agent.id}`)).toBeDefined();
    await w.admin.request("DELETE", `/api/agents/${smoke.agent.id}`);
    expect(w.s.ctx.db.get("SELECT 1 AS x FROM settings WHERE key = ?", `broker.search:${smoke.agent.id}`)).toBeUndefined();
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
    expect(() => chooseTargets({}, [acc(EMAIL, "needs_reauth")], [conn({})], "https://x.test")).toThrow(/needs reauth.*\/accounts/);
    expect(() => chooseTargets({ connection: "nope" }, [acc(EMAIL)], [conn({})], "https://x.test")).toThrow(/No connection "nope"/);
  });

  it("uses the Google account the connection is signed in as, and refuses a mismatch", () => {
    const bound = conn({ googleAccount: { email: "b@x.test" } } as unknown as Partial<ConnectionView>);
    expect(chooseTargets({}, [acc(EMAIL), acc("b@x.test")], [bound], "https://x.test").account.email).toBe("b@x.test");
    expect(() => chooseTargets({ account: EMAIL }, [acc(EMAIL), acc("b@x.test")], [bound], "https://x.test")).toThrow(/signed in as b@x.test/);
  });

  it("reads list_attachments' structured list or its text lines", () => {
    const t = (text: string): CallOutcome => ({ isError: false, text, structured: null, content: [] });
    expect(parseAttachmentList(t("Attachments: a b.pdf (application/pdf, 2 KB, attachment_id: A1); c.txt (text/plain, 10 B, attachment_id: A2)"))).toEqual([
      { filename: "a b.pdf", id: "A1" },
      { filename: "c.txt", id: "A2" },
    ]);
    expect(parseAttachmentList(t("2 attachments:\n- x.png (image/png, 1 KB, attachment_id: X)\n- y.csv (text/csv, 1 KB, attachment_id: Y)"))).toEqual([
      { filename: "x.png", id: "X" },
      { filename: "y.csv", id: "Y" },
    ]);
    expect(parseAttachmentList({ ...t(""), structured: { attachments: [{ attachment_id: "Z", filename: "z.pdf" }] } })).toEqual([{ filename: "z.pdf", id: "Z" }]);
  });

  it("Ctrl-C: the first stops the run (cleanup follows), the second quits and says what may be left", () => {
    const controller = new AbortController();
    const printed: string[] = [];
    const exits: number[] = [];
    const before = new Set(process.listeners("SIGINT"));
    const remove = installSmokeSignals(controller, { print: (l) => printed.push(l), exit: (c) => exits.push(c), leftovers: () => "These may be left: the agent xaq-smoke-x." });
    try {
      const ours = process.listeners("SIGINT").find((l) => !before.has(l))!;
      expect(ours).toBeDefined();
      (ours as () => void)();
      expect(controller.signal.aborted).toBe(true);
      expect(exits).toEqual([]);
      expect(printed.join("\n")).toContain("cleaning up");
      (ours as () => void)();
      expect(exits).toEqual([130]);
      expect(printed.join("\n")).toContain("These may be left: the agent xaq-smoke-x.");
    } finally {
      remove();
    }
    expect(process.listeners("SIGINT").filter((l) => !before.has(l))).toEqual([]);
  });

  it("refuses without --scratch before touching the daemon", async () => {
    let calls = 0;
    const run = new SmokeRun({}, { admin: { baseUrl: "http://127.0.0.1:1", request: async () => (calls++, null) as never }, connectMcp: async () => ({}) as AgentMcp, print: () => {}, confirm: async () => true, signal: new AbortController().signal });
    await expect(run.run()).rejects.toBeInstanceOf(SmokeSetupError);
    expect(calls).toBe(0);
  });
});
