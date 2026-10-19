// `xaq smoke google-workspace --scratch`: a live end-to-end check of Gmail attachments and the google-workspace
// extension on a real account, safe by construction (docs/reference.md, "smoke google-workspace").
//
// - Reads anywhere: a few existing Drive files (newest Doc, Sheet, Slides) and ONE email with attachments. Only
//   names, the subject, kinds and sizes are printed, never content.
// - Every write goes into ONE new Drive folder named after the run (xaq-smoke-<UTC timestamp>), through
//   ScratchGuard (guards.ts): the target must be that folder or a file this run created whose drive_get parents
//   include it. The only mail is ONE draft to the account's own address, deleted again; nothing is ever sent.
// - Tool calls go through /mcp as a temporary agent (mail read + draft, the Workspace connection at "ask"), so risky
//   calls really come back pending; the command approves its own calls (checked: agent, tool, exact arguments)
//   through the admin API.
// - Cleanup always runs (also on a failed step or Ctrl-C): the draft deleted, the folder trashed (drive_trash,
//   approved), the agent deleted, attachmentDirs restored, the temp dir removed. Then the leftover check.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Account, AgentWithKey, ConnectionView, McpCallApprovalView } from "../../shared/types.ts";
import { type SmokeDraftView, type SmokeLeftovers, smokeName, smokeSubjectPrefix } from "../../shared/smoke.ts";
import type { AdminChannel } from "../connections-cli/admin.ts";
import { NPX } from "../listen/version.ts";
import { type AgentMcp, type CallOutcome } from "./agent.ts";
import { type DriveFacts, GuardError, type Ledger, newLedger, READ_TOOLS, ScratchGuard, WRITE_TARGETS } from "./guards.ts";
import { solidPng } from "./png.ts";
import { finish, type SmokeReport, type StepResult } from "./report.ts";

/** The extension's id (its manifest name): the preset of its connections. */
export const WORKSPACE_PRESET = "google-workspace";
/** The scopes the extension asks Google for; a sign-in missing one makes some tools fail. */
export const WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly",
];
/** Mail tools the run calls (native, not prefixed). */
export const MAIL_TOOLS = ["search_threads", "get_thread", "get_message", "list_attachments", "get_attachment", "create_draft"] as const;
/** A fixed public https image (Google's own logo), for slides_insert_image's imageUrl path. */
export const PUBLIC_IMAGE_URL = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";

export interface SmokeFlags {
  scratch?: boolean;
  yes?: boolean;
  account?: string;
  connection?: string;
  json?: boolean;
}

export interface SmokeDeps {
  admin: Pick<AdminChannel, "request" | "baseUrl">;
  /** An MCP client on /mcp with this key (default: the SDK client on admin.baseUrl). */
  connectMcp: (apiKey: string) => Promise<AgentMcp>;
  /** Progress and the plan (stderr with --json). */
  print: (line?: string) => void;
  /** Asked once, after the plan; --yes answers it. */
  confirm: (question: string) => Promise<boolean>;
  /** Ctrl-C: no new step starts, cleanup runs. */
  signal: AbortSignal;
  now?: () => Date;
  /** Where the temp dir for the local attachment goes (default os.tmpdir()). */
  tmpRoot?: string;
  imageUrl?: string;
  /** get_call_status polling while an approved call runs. */
  pollMs?: number;
}

/** Setup problems found before anything is created: printed as they are, exit 1. */
export class SmokeSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeSetupError";
  }
}

class Skip extends Error {}
class Interrupted extends Error {
  constructor() {
    super("interrupted (Ctrl-C)");
  }
}

interface SettingsView {
  publicUrl: string;
  brokerUpstreams?: boolean;
  /** Writer A1's setting: directories create_draft may attach local files from. */
  attachmentDirs?: string[];
}

/**
 * The Google account a google-workspace connection is bound to (writer C), when the daemon says. Read defensively:
 * the field isn't final yet.
 */
export function boundAccountEmail(c: ConnectionView): string | null {
  const v = c as unknown as { googleAccount?: { email?: unknown } | null; accountEmail?: unknown; account?: { email?: unknown } | null };
  const email = v.googleAccount?.email ?? v.accountEmail ?? v.account?.email;
  return typeof email === "string" && email.includes("@") ? email : null;
}

/** Picks the account and the connection (flags, else the only one) and checks both are usable. */
export function chooseTargets(
  flags: SmokeFlags,
  accounts: Account[],
  connections: ConnectionView[],
  publicUrl: string,
): { account: Account; connection: ConnectionView } {
  const base = publicUrl.replace(/\/+$/, "");
  let connection: ConnectionView | undefined;
  if (flags.connection) {
    connection = connections.find((c) => c.slug === flags.connection);
    if (!connection) throw new SmokeSetupError(`No connection "${flags.connection}". There are: ${connections.map((c) => c.slug).join(", ") || "none"}.`);
  } else {
    const ws = connections.filter((c) => c.preset === WORKSPACE_PRESET);
    if (!ws.length) {
      throw new SmokeSetupError(
        `Google Workspace isn't connected. Install it (${NPX} ext add ${WORKSPACE_PRESET}), then connect it in the console: ${base}/connections`,
      );
    }
    if (ws.length > 1) throw new SmokeSetupError(`There are ${ws.length} Google Workspace connections (${ws.map((c) => c.slug).join(", ")}): pick one with --connection <slug>.`);
    connection = ws[0]!;
  }
  const fix = `${base}/connections/${connection.id}`;
  if (connection.status !== "active") throw new SmokeSetupError(`${connection.name} is ${connection.status.replace("_", " ")}${connection.statusReason ? ` (${connection.statusReason})` : ""}. Fix it in the console: ${fix}`);
  if (connection.preset === WORKSPACE_PRESET && connection.grantedScopes) {
    const missing = WORKSPACE_SCOPES.filter((s) => !connection!.grantedScopes!.includes(s));
    if (missing.length) {
      throw new SmokeSetupError(`${connection.name} is missing Google permissions: ${missing.map((s) => s.split("/").pop()).join(", ")}. Reconnect it and approve all of them: ${fix}`);
    }
  }
  const bound = boundAccountEmail(connection);
  const want = flags.account ?? bound;
  let account: Account | undefined;
  if (want) {
    account = accounts.find((a) => a.email.toLowerCase() === want.toLowerCase());
    if (!account) throw new SmokeSetupError(`No Gmail account ${want} in xaq. There are: ${accounts.map((a) => a.email).join(", ") || "none"}. Add it in the console: ${base}/accounts`);
  } else {
    if (!accounts.length) throw new SmokeSetupError(`No Gmail account is connected. Add one in the console: ${base}/accounts`);
    if (accounts.length > 1) throw new SmokeSetupError(`There are ${accounts.length} Gmail accounts (${accounts.map((a) => a.email).join(", ")}): pick one with --account <email>.`);
    account = accounts[0]!;
  }
  if (bound && bound.toLowerCase() !== account.email.toLowerCase()) {
    throw new SmokeSetupError(`${connection.name} is signed in as ${bound}, not ${account.email}: pass --account ${bound}, or pick another connection.`);
  }
  if (account.status !== "active") throw new SmokeSetupError(`${account.email} is ${account.status.replace("_", " ")}. Fix it in the console: ${base}/accounts`);
  return { account, connection };
}

/** The plan, printed before anything happens. */
export function planLines(marker: string, account: string, connection: ConnectionView): string[] {
  return [
    `xaq smoke google-workspace will run as a temporary agent ${marker}, through /mcp:`,
    "",
    "Reads (existing files and mail, read only; prints names, the subject, kinds and sizes, never content):",
    "  - Drive: search the newest Doc, Sheet and Slides file, list the top of My Drive, get, read and export each",
    "  - Gmail: ONE email with attachments: list its attachments and extract each with get_attachment",
    `Writes (only inside a new Drive folder "${marker}" at the top of My Drive; every write is checked first):`,
    "  - Docs: create a doc from markdown, append, find and replace (count checked), comment, read back",
    "  - Sheets: create a sheet, write a range, append rows, read back",
    "  - Slides: create a deck from an outline, add a slide, replace text, upload a PNG and insert it (Drive",
    "    thumbnail path: a private image must be refused), insert a public https image, read back, delete a",
    "    slide through the approval path",
    `  - Gmail: ONE draft to ${account} only, with a local file and a scratch-folder file attached; checked, then`,
    "    deleted. Nothing is ever sent.",
    "Cleanup, also on failure or Ctrl-C: the folder goes to the Drive trash (drive_trash, approved here), the draft",
    `is deleted, the agent is deleted, attachmentDirs is restored. Temporary changes until then: the agent (mail read`,
    `and draft on ${account}, ${connection.slug} at "ask") and a temp dir added to attachmentDirs.`,
  ];
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 300);

/** Canonical JSON (sorted keys): the approval's stored arguments must be exactly the call the run made. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Attachments from list_attachments: its structured list when there is one, else the `name (type, size, attachment_id: x)` lines. */
export function parseAttachmentList(out: CallOutcome): { id: string; filename: string }[] {
  const s = out.structured?.attachments;
  if (Array.isArray(s)) {
    return s
      .map((a: Record<string, unknown>) => ({ id: String(a.attachment_id ?? a.attachmentId ?? a.id ?? ""), filename: String(a.filename ?? a.name ?? "") }))
      .filter((a) => a.id);
  }
  const found: { id: string; filename: string }[] = [];
  for (const segment of out.text.split(/;|\n/)) {
    const m = /^\s*(?:Attachments:\s*)?(?:[-*]|\d+\.)?\s*(.+?) \([^()]*attachment_id: ([^)\s]+)\)/.exec(segment);
    if (m) found.push({ filename: m[1]!.trim(), id: m[2]! });
  }
  return found;
}

/** What get_attachment returned, as the report may say it: a kind and a size, never the content. */
export function describeExtraction(out: CallOutcome): string {
  const blocks = out.content;
  const image = blocks.find((b) => b.type === "image");
  if (image) return `image, ${image.data?.length ?? 0} chars (base64)`;
  const res = blocks.find((b) => b.type === "resource");
  if (res?.resource?.blob !== undefined) return `binary, ${res.resource.blob.length} chars (base64)`;
  // Text: the first line is the header ("Attachment <name> (<type>, <size>) …"); the rest is the content.
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "");
  const body = text.join("\n").split("\n").slice(1).join("\n");
  return `text, ${body.length} chars`;
}

export class SmokeRun {
  readonly marker: string;
  readonly ledger: Ledger;
  private readonly steps: StepResult[] = [];
  private readonly leftBehind: string[] = [];
  private readonly guard: ScratchGuard;
  private mcp: AgentMcp | null = null;
  private account: Account | null = null;
  private connection: ConnectionView | null = null;
  private previousDirs: string[] | null = null;
  private dirsChanged = false;
  private cleaning = false;
  private interrupted = false;
  private readonly stamp: string;

  constructor(
    private readonly flags: SmokeFlags,
    private readonly deps: SmokeDeps,
  ) {
    this.marker = smokeName((deps.now ?? (() => new Date()))());
    this.stamp = this.marker.slice("xaq-smoke-".length);
    this.ledger = newLedger(this.marker);
    this.guard = new ScratchGuard(this.ledger, (id) => this.driveFacts(id));
  }

  // ───────────── Plumbing ─────────────

  private record(tool: string, step: string, status: StepResult["status"], detail: string): void {
    this.steps.push({ tool, step, status, detail });
    this.deps.print(`  ${status.padEnd(4)}  ${tool} · ${step}${detail ? ` · ${detail}` : ""}`);
  }

  /** Runs one step; a thrown Skip is SKIP, anything else FAIL. Returns whether it passed. */
  private async step(tool: string, step: string, fn: () => Promise<string>): Promise<boolean> {
    if (!this.cleaning && this.deps.signal.aborted) {
      this.interrupted = true;
      return false;
    }
    try {
      this.record(tool, step, "PASS", await fn());
      return true;
    } catch (err) {
      if (err instanceof Interrupted) {
        this.interrupted = true;
        this.record(tool, step, "SKIP", "interrupted (Ctrl-C)");
      } else if (err instanceof Skip) this.record(tool, step, "SKIP", err.message);
      else this.record(tool, step, "FAIL", errText(err));
      return false;
    }
  }

  private need<T>(value: T | null | undefined, what: string): T {
    if (value === null || value === undefined) throw new Skip(`needs ${what}, which an earlier step didn't produce`);
    return value;
  }

  /** `force`: bookkeeping reads (drive_get for the guards and the ledger) still run after Ctrl-C. */
  private async rawCall(name: string, args: Record<string, unknown>, force = false): Promise<CallOutcome> {
    if (!force && !this.cleaning && this.deps.signal.aborted) throw new Interrupted();
    if (!this.mcp) throw new Skip("no MCP session (the temporary agent wasn't created)");
    return this.mcp.call(name, args);
  }

  private exposed(tool: string): string {
    return `${this.connection!.slug}__${tool}`;
  }

  /**
   * A Workspace tool call. Reads go straight through; writes are checked by the guard first. A write that comes back
   * pending is approved here (its own call only); `approved` says which approval ran it.
   */
  private async ws(tool: string, args: Record<string, unknown>, force = false): Promise<{ out: CallOutcome; approved: string | null }> {
    const write = tool in WRITE_TARGETS;
    if (write) await this.guard.checkWrite(tool, args);
    else if (!READ_TOOLS.has(tool)) throw new GuardError(`${tool} isn't one of the calls the smoke run makes`);
    const out = await this.rawCall(this.exposed(tool), args, force && !write);
    const pending = /^pending_approval:/.test(out.text) ? /approval_id: (apr_[A-Za-z0-9_-]+)/.exec(out.text)?.[1] : undefined;
    if (pending) {
      if (!write) throw new Error(`${tool} is a read, but it came back pending approval`);
      return { out: await this.approveOwn(pending, tool, args), approved: pending };
    }
    if (out.isError) throw new Error(`${tool}: ${out.text}`);
    return { out, approved: null };
  }

  private async read(tool: string, args: Record<string, unknown>, force = false): Promise<CallOutcome> {
    return (await this.ws(tool, args, force)).out;
  }

  /** Approves a pending call after checking it is exactly this run's: its agent, connection, tool and arguments. */
  private async approveOwn(approvalId: string, tool: string, args: Record<string, unknown>): Promise<CallOutcome> {
    const view = await this.deps.admin.request<McpCallApprovalView>("GET", `/api/approvals/${encodeURIComponent(approvalId)}`);
    const mine =
      view.approval.agentId === this.ledger.agent?.id &&
      view.connection?.id === this.connection?.id &&
      view.tool?.name === tool &&
      view.argsIntact &&
      canonical(JSON.parse(view.argsDisplay)) === canonical(args);
    if (!mine) throw new GuardError(`approval ${approvalId} isn't exactly this run's ${tool} call, so it wasn't approved`);
    await this.deps.admin.request("POST", `/api/approvals/${encodeURIComponent(approvalId)}/approve`, { note: `${this.marker}: approved by xaq smoke` });
    this.ledger.approvals.push(approvalId);
    for (let i = 0; ; i++) {
      const status = await this.rawCall("get_call_status", { approval_id: approvalId });
      if (/^running:/.test(status.text) && i < 60) {
        await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 1000));
        continue;
      }
      if (status.isError || !/^done:/.test(status.text)) throw new Error(`${tool} after approval: ${status.text}`);
      return status;
    }
  }

  /** drive_get, as the guards and the leftover check read it. */
  private async driveFacts(fileId: string): Promise<DriveFacts> {
    const out = await this.read("drive_get", { fileId }, true);
    const s = out.structured;
    if (!s || typeof s.id !== "string") throw new GuardError(`drive_get gave no details for ${fileId}`);
    return { id: s.id, name: typeof s.name === "string" ? s.name : "", parents: Array.isArray(s.parents) ? s.parents.map(String) : [], trashed: s.trashed === true };
  }

  /** A file a create call made: recorded in the ledger once drive_get says it's in the scratch folder. */
  private async recordCreated(kind: string, id: unknown, name: string): Promise<string> {
    if (typeof id !== "string" || !id) throw new Error(`the ${kind} create call returned no id`);
    const folder = this.ledger.folder!;
    const f = await this.driveFacts(id);
    if (!f.parents.includes(folder.id)) {
      this.ledger.strays.set(id, { kind, name });
      throw new GuardError(`the new ${kind} ${id} isn't in the scratch folder, so nothing more is written to it`);
    }
    this.ledger.files.set(id, { kind, name });
    return id;
  }

  // ───────────── The run ─────────────

  async run(): Promise<SmokeReport> {
    if (!this.flags.scratch) {
      throw new SmokeSetupError(
        "smoke google-workspace runs live on the connected Google account. It only reads existing files and mail, and writes only into a new scratch folder and ONE draft to the account itself, which it removes again. Pass --scratch to run it.",
      );
    }
    const settings = await this.deps.admin.request<SettingsView>("GET", "/api/settings");
    if (settings.brokerUpstreams !== true) throw new SmokeSetupError(`Connections are turned off in this xaq. Turn them on in the console: ${settings.publicUrl.replace(/\/+$/, "")}/settings`);
    if (!Array.isArray(settings.attachmentDirs)) {
      throw new SmokeSetupError("This xaq has no attachmentDirs setting, which the draft's local attachment needs. Update xaq, then run this again.");
    }
    const accounts = await this.deps.admin.request<Account[]>("GET", "/api/accounts");
    const connections = await this.deps.admin.request<ConnectionView[]>("GET", "/api/connections");
    const { account, connection } = chooseTargets(this.flags, accounts, connections, settings.publicUrl);
    this.account = account;
    this.connection = connection;

    for (const l of planLines(this.marker, account.email, connection)) this.deps.print(l);
    this.deps.print();
    if (!(await this.deps.confirm("Run it?"))) throw new SmokeSetupError("Nothing was done.");

    this.deps.print();
    try {
      await this.main();
    } finally {
      this.cleaning = true;
      await this.cleanup();
    }
    if (this.deps.signal.aborted) this.interrupted = true;
    return finish({ marker: this.marker, account: account.email, connection: connection.slug, steps: this.steps, leftBehind: this.leftBehind, interrupted: this.interrupted });
  }

  private async main(): Promise<void> {
    const account = this.account!;
    const connection = this.connection!;
    const created = await this.step("xaq", "create the temporary agent", async () => {
      const r = await this.deps.admin.request<AgentWithKey>("POST", "/api/smoke/agents", { name: this.marker, accountId: account.id, connectionId: connection.id });
      this.ledger.agent = { id: r.agent.id, name: r.agent.name };
      this.mcp = await this.deps.connectMcp(r.apiKey);
      return `${r.agent.name}: ${account.email} read + draft, ${connection.slug} at "ask"`;
    });
    if (!created) return;
    const tools = await this.step("xaq", "tools/list has every tool the run uses", async () => {
      const listed = new Set(await this.mcp!.listTools());
      const wanted = [...[...READ_TOOLS, ...Object.keys(WRITE_TARGETS)].map((t) => this.exposed(t)), "get_call_status", ...MAIL_TOOLS];
      const missing = wanted.filter((t) => !listed.has(t));
      if (missing.length) throw new Error(`missing: ${missing.join(", ")} (update xaq and the ${WORKSPACE_PRESET} extension)`);
      return `${wanted.length} tools`;
    });
    if (!tools) return;

    await this.driveReads();
    await this.mailReads();
    if (!(await this.createFolder())) {
      this.record("xaq", "writes", "SKIP", "no scratch folder: nothing was written");
      return;
    }
    const doc = await this.docs();
    await this.sheets();
    await this.slides();
    await this.draft(doc);
  }

  // ───────────── Reads ─────────────

  private async driveReads(): Promise<void> {
    const picks: { kind: "doc" | "sheet" | "slides"; id: string; name: string }[] = [];
    for (const kind of ["doc", "sheet", "slides"] as const) {
      await this.step("drive_search", `newest ${kind}`, async () => {
        const out = await this.read("drive_search", { type: kind, pageSize: 5 });
        const files = (Array.isArray(out.structured?.files) ? out.structured.files : []) as { id: string; name: string; modifiedTime?: string; shortcutTo?: unknown }[];
        const real = files.filter((f) => f.id && !f.shortcutTo).sort((a, b) => String(b.modifiedTime ?? "").localeCompare(String(a.modifiedTime ?? "")));
        if (!real.length) throw new Skip(`no ${kind} files in this Drive`);
        picks.push({ kind, id: real[0]!.id, name: real[0]!.name });
        return `${files.length} found; newest "${real[0]!.name}"`;
      });
    }
    await this.step("drive_list_folder", "top of My Drive", async () => {
      const out = await this.read("drive_list_folder", { folderId: "root", pageSize: 10 });
      const files = Array.isArray(out.structured?.files) ? out.structured.files : [];
      return `${files.length} items`;
    });
    const formats = { doc: "markdown", sheet: "csv", slides: "text" } as const;
    for (const p of picks) {
      await this.step("drive_get", `${p.kind} details`, async () => {
        const f = await this.driveFacts(p.id);
        return `"${f.name}"`;
      });
      await this.step(p.kind === "doc" ? "docs_read" : p.kind === "sheet" ? "sheets_read" : "slides_read", `read the ${p.kind}`, async () => {
        if (p.kind === "doc") {
          const out = await this.read("docs_read", { documentId: p.id });
          return `text, ${Number(out.structured?.totalChars ?? out.text.length)} chars`;
        }
        if (p.kind === "sheet") {
          const out = await this.read("sheets_read", { spreadsheetId: p.id, range: "A1:Z50" });
          const rows = Array.isArray(out.structured?.rows) ? out.structured.rows.length : 0;
          return `${rows} rows, ${out.text.length} chars`;
        }
        const out = await this.read("slides_read", { presentationId: p.id });
        return `${Number(out.structured?.slideCount ?? 0)} slides, ${out.text.length} chars`;
      });
      await this.step("drive_export", `export the ${p.kind} as ${formats[p.kind]}`, async () => {
        const out = await this.read("drive_export", { fileId: p.id, format: formats[p.kind] });
        return `${formats[p.kind]}, ${Number(out.structured?.totalChars ?? out.text.length)} chars`;
      });
    }
  }

  private async mailReads(): Promise<void> {
    const account = this.account!.email;
    let threadIds: string[] = [];
    let message: { id: string; subject: string } | null = null;
    await this.step("search_threads", "find an email with attachments", async () => {
      const out = await this.rawCall("search_threads", { account, query: "has:attachment -in:drafts -in:chats", max_results: 5 });
      if (out.isError) throw new Error(out.text);
      threadIds = [...out.text.matchAll(/^\s+thread_id: (\S+)/gm)].map((m) => m[1]!);
      if (!threadIds.length) throw new Skip("no email with attachments in this mailbox");
      return `${threadIds.length} threads`;
    });
    await this.step("get_thread", "pick ONE message with attachments", async () => {
      const threadId = this.need(threadIds[0], "a thread");
      const out = await this.rawCall("get_thread", { account, thread_id: threadId });
      if (out.isError) throw new Error(out.text);
      const ids = [...out.text.matchAll(/^Message (\S+) \(thread /gm)].map((m) => m[1]!);
      for (const id of ids.slice(0, 5)) {
        const m = await this.rawCall("get_message", { account, message_id: id });
        if (m.isError) continue;
        const head = m.text.split(/<email_content /)[0] ?? m.text;
        if (/^Attachments: /m.test(head)) {
          message = { id, subject: /^Subject: (.*)$/m.exec(head)?.[1]?.trim() ?? "(no subject)" };
          return `subject "${message.subject}"`;
        }
      }
      throw new Skip("the thread's messages have no attachments");
    });
    let attachments: { id: string; filename: string }[] = [];
    await this.step("list_attachments", "list its attachments", async () => {
      const m = this.need(message as { id: string; subject: string } | null, "a message with attachments");
      const out = await this.rawCall("list_attachments", { account, message_id: m.id });
      if (out.isError) throw new Error(out.text);
      attachments = parseAttachmentList(out);
      if (!attachments.length) throw new Error("listed no attachments");
      return attachments.map((a) => `"${a.filename}"`).join(", ");
    });
    for (const a of attachments.slice(0, 10)) {
      await this.step("get_attachment", `extract "${a.filename}"`, async () => {
        const m = message as { id: string; subject: string } | null;
        const out = await this.rawCall("get_attachment", { account, message_id: m!.id, attachment_id: a.id });
        if (out.isError) throw new Error(out.text);
        return describeExtraction(out);
      });
    }
  }

  // ───────────── Writes ─────────────

  private async createFolder(): Promise<boolean> {
    return this.step("drive_create_folder", `create the scratch folder ${this.marker}`, async () => {
      const { out } = await this.ws("drive_create_folder", { name: this.marker });
      const id = out.structured?.folderId;
      if (typeof id !== "string" || !id) throw new Error("drive_create_folder returned no folder id");
      // Recorded at once: from here on cleanup trashes it.
      this.ledger.folder = { id, name: this.marker };
      const f = await this.driveFacts(id);
      if (f.name !== this.marker || f.trashed) {
        this.ledger.folder = null;
        this.leftBehind.push(`Drive item ${id}: drive_create_folder returned it, but it isn't a live folder named ${this.marker}. Check Drive.`);
        throw new Error(`folder ${id} isn't the scratch folder`);
      }
      return `folder ${id}`;
    });
  }

  private async docs(): Promise<string | null> {
    let doc: string | null = null;
    const title = `${this.marker} doc`;
    const old = `REPLACE-ME-${this.stamp}`;
    const fresh = `REPLACED-${this.stamp}`;
    await this.step("docs_create", "create a doc from markdown in the folder", async () => {
      const markdown = `# ${this.marker}\n\nDOC-MARKER-A, written by xaq smoke.\n\n- ${old}\n- ${old}\n`;
      const { out } = await this.ws("docs_create", { title, markdown, folderId: this.ledger.folder!.id });
      doc = await this.recordCreated("doc", out.structured?.documentId, title);
      return `doc ${doc}`;
    });
    await this.step("docs_append", "append", async () => {
      await this.ws("docs_append", { documentId: this.need(doc, "the doc"), markdown: "DOC-MARKER-B, appended by xaq smoke." });
      return "appended";
    });
    await this.step("docs_replace_text", "find and replace (2 matches)", async () => {
      const { out } = await this.ws("docs_replace_text", { documentId: this.need(doc, "the doc"), find: old, replace: fresh });
      const n = Number(out.structured?.occurrencesChanged);
      if (n !== 2) throw new Error(`changed ${n} occurrences, expected 2`);
      return "2 occurrences changed";
    });
    let comment: string | null = null;
    await this.step("docs_comment_add", "add a comment", async () => {
      const { out } = await this.ws("docs_comment_add", { documentId: this.need(doc, "the doc"), text: `${this.marker}: a comment from xaq smoke` });
      comment = typeof out.structured?.commentId === "string" ? out.structured.commentId : null;
      if (!comment) throw new Error("no comment id returned");
      return `comment ${comment}`;
    });
    await this.step("docs_read", "read back: markers, replacements", async () => {
      const out = await this.read("docs_read", { documentId: this.need(doc, "the doc") });
      const t = out.text;
      const problems = [
        !t.includes("DOC-MARKER-A") && "the created text",
        !t.includes("DOC-MARKER-B") && "the appended text",
        t.split(fresh).length - 1 !== 2 && "2 replacements",
        t.includes(old) && "no text left to replace",
      ].filter(Boolean);
      if (problems.length) throw new Error(`missing: ${problems.join(", ")}`);
      return "all markers present";
    });
    await this.step("docs_comments_list", "the comment is there", async () => {
      const out = await this.read("docs_comments_list", { documentId: this.need(doc, "the doc") });
      const list = (Array.isArray(out.structured?.comments) ? out.structured.comments : []) as { id?: string }[];
      if (!list.some((c) => c.id === this.need(comment, "the comment"))) throw new Error("the comment isn't listed");
      return `${list.length} comment(s)`;
    });
    return doc;
  }

  private async sheets(): Promise<void> {
    let sheet: string | null = null;
    const title = `${this.marker} sheet`;
    const written = [
      ["name", "kind", "marker"],
      ["alpha", "write", this.stamp],
    ];
    const appended = [
      ["beta", "append", this.stamp],
      ["gamma", "append", this.stamp],
    ];
    await this.step("sheets_create", "create a sheet in the folder", async () => {
      const { out } = await this.ws("sheets_create", { title, folderId: this.ledger.folder!.id });
      sheet = await this.recordCreated("sheet", out.structured?.spreadsheetId, title);
      return `sheet ${sheet}`;
    });
    await this.step("sheets_write", "write A1:C2", async () => {
      const { out } = await this.ws("sheets_write", { spreadsheetId: this.need(sheet, "the sheet"), range: "A1:C2", values: written, input: "RAW" });
      if (Number(out.structured?.updatedCells) !== 6) throw new Error(`updated ${String(out.structured?.updatedCells)} cells, expected 6`);
      return "6 cells";
    });
    await this.step("sheets_append_rows", "append 2 rows", async () => {
      const { out } = await this.ws("sheets_append_rows", { spreadsheetId: this.need(sheet, "the sheet"), range: "A:C", rows: appended, input: "RAW" });
      if (Number(out.structured?.updatedRows) !== 2) throw new Error(`appended ${String(out.structured?.updatedRows)} rows, expected 2`);
      return "2 rows";
    });
    await this.step("sheets_read", "read back and compare", async () => {
      const out = await this.read("sheets_read", { spreadsheetId: this.need(sheet, "the sheet"), range: "A1:C4" });
      const rows = out.structured?.rows;
      if (canonical(rows) !== canonical([...written, ...appended])) throw new Error("the cells differ from what was written");
      return "4 rows match";
    });
  }

  private async slides(): Promise<void> {
    let deck: string | null = null;
    let first: string | null = null;
    let extra: string | null = null;
    let png: string | null = null;
    const title = `${this.marker} deck`;
    const old = `SLIDE-MARKER-${this.stamp}`;
    const fresh = `SLIDE-REPLACED-${this.stamp}`;
    await this.step("slides_create", "create a deck from an outline in the folder", async () => {
      const { out } = await this.ws("slides_create", {
        title,
        slides: [
          { title: "Smoke one", bullets: [old] },
          { title: "Smoke two", bullets: [old] },
        ],
        folderId: this.ledger.folder!.id,
      });
      deck = await this.recordCreated("deck", out.structured?.presentationId, title);
      const made = (Array.isArray(out.structured?.slides) ? out.structured.slides : []) as { slideId?: string; title?: string }[];
      first = made.find((s) => s.title === "Smoke one")?.slideId ?? null;
      return `deck ${deck}, ${made.length} slides`;
    });
    await this.step("slides_add_slide", "add a slide", async () => {
      const { out } = await this.ws("slides_add_slide", { presentationId: this.need(deck, "the deck"), title: "Smoke: deleted through approval", bullets: ["xaq smoke deletes this slide"] });
      extra = typeof out.structured?.slideId === "string" ? out.structured.slideId : null;
      if (!extra) throw new Error("no slide id returned");
      return `slide ${extra}`;
    });
    await this.step("slides_replace_text", "replace text (2 matches)", async () => {
      const { out } = await this.ws("slides_replace_text", { presentationId: this.need(deck, "the deck"), find: old, replace: fresh });
      const n = Number(out.structured?.occurrencesChanged);
      if (n !== 2) throw new Error(`changed ${n} occurrences, expected 2`);
      return "2 occurrences changed";
    });
    await this.step("drive_upload", "upload a PNG into the folder", async () => {
      const name = `${this.marker}.png`;
      const { out } = await this.ws("drive_upload", { name, folderId: this.ledger.folder!.id, mimeType: "image/png", content_base64: solidPng().toString("base64") });
      png = await this.recordCreated("image", out.structured?.fileId, name);
      return `image ${png}`;
    });
    // Slides fetches a Drive image without credentials, so only an image shared "anyone with the link" works, and
    // the extension never changes sharing. The run's own PNG is private: the tool must refuse it and leave the deck
    // as it was. An insert would mean the file got shared somehow, which is a failure.
    const imagesOnFirst = async () => {
      const out = await this.read("slides_read", { presentationId: deck! });
      const slides = (Array.isArray(out.structured?.slides) ? out.structured.slides : []) as { slideId?: string; images?: number }[];
      return slides.find((s) => s.slideId === first)?.images ?? 0;
    };
    await this.step("slides_insert_image", "Drive image (private)", async () => {
      const args = { presentationId: this.need(deck, "the deck"), slideId: this.need(first, "the first slide"), driveFileId: this.need(png, "the PNG") };
      const before = await imagesOnFirst();
      let refusal: string | null = null;
      try {
        await this.ws("slides_insert_image", args);
      } catch (err) {
        if (err instanceof GuardError || err instanceof Interrupted) throw err;
        refusal = errText(err);
      }
      if (refusal === null) throw new Error("inserted a private Drive image: check the PNG's sharing in Drive");
      if (!/shared publicly/i.test(refusal)) throw new Error(refusal);
      if ((await imagesOnFirst()) !== before) throw new Error("refused, but the deck changed");
      return "refused as expected";
    });
    await this.step("slides_insert_image", "insert a public https image", async () => {
      const { out } = await this.ws("slides_insert_image", { presentationId: this.need(deck, "the deck"), slideId: this.need(first, "the first slide"), imageUrl: this.deps.imageUrl ?? PUBLIC_IMAGE_URL });
      return `image ${String(out.structured?.imageId ?? "?")}`;
    });
    await this.step("slides_read", "read back: text replaced, the image there", async () => {
      const out = await this.read("slides_read", { presentationId: this.need(deck, "the deck") });
      const slides = (Array.isArray(out.structured?.slides) ? out.structured.slides : []) as { slideId?: string; images?: number }[];
      const problems = [
        out.text.split(fresh).length - 1 !== 2 && "2 replacements",
        out.text.includes(old) && "no text left to replace",
        (slides.find((s) => s.slideId === first)?.images ?? 0) !== 1 && "the public image on the first slide",
        !slides.some((s) => s.slideId === extra) && "the added slide",
      ].filter(Boolean);
      if (problems.length) throw new Error(`missing: ${problems.join(", ")}`);
      return `${slides.length} slides`;
    });
    await this.step("slides_delete_slide", "delete a slide through the approval path", async () => {
      const slideId = this.need(extra, "the added slide");
      const { approved } = await this.ws("slides_delete_slide", { presentationId: this.need(deck, "the deck"), slideId });
      if (!approved) throw new Error("the call wasn't held for approval (the connection should be at \"ask\")");
      const out = await this.read("slides_read", { presentationId: deck! });
      const slides = (Array.isArray(out.structured?.slides) ? out.structured.slides : []) as { slideId?: string }[];
      if (slides.some((s) => s.slideId === slideId)) throw new Error("approved, but the slide is still there");
      return `pending, approved (${approved}), gone`;
    });
  }

  private async draft(doc: string | null): Promise<void> {
    const own = this.account!.email;
    let local: { path: string; size: number } | null = null;
    let draftId: string | null = null;
    await this.step("xaq", "allow a temp dir in attachmentDirs", async () => {
      const dir = mkdtempSync(join(this.deps.tmpRoot ?? tmpdir(), "xaq-smoke-"));
      this.ledger.tempDir = dir;
      const path = join(dir, `${this.marker}.txt`);
      const bytes = Buffer.from(`${this.marker}\nA local file attached by xaq smoke google-workspace.\n${"0123456789abcdef".repeat(64)}\n`);
      writeFileSync(path, bytes);
      local = { path, size: bytes.length };
      const settings = await this.deps.admin.request<SettingsView>("GET", "/api/settings");
      this.previousDirs = [...(settings.attachmentDirs ?? [])];
      await this.deps.admin.request("PATCH", "/api/settings", { attachmentDirs: [...this.previousDirs, dir] });
      this.dirsChanged = true;
      return `${basename(path)} (${bytes.length} bytes)`;
    });
    const subject = `${smokeSubjectPrefix(this.marker)} attachments check, never sent`;
    await this.step("create_draft", `ONE draft to ${own}, 2 attachments`, async () => {
      const file = this.need(local as { path: string; size: number } | null, "the local file");
      const args = {
        account: own,
        to: [own],
        subject,
        body: "Created by `xaq smoke google-workspace`, which deletes this draft again. Nothing is sent.",
        attachments: [{ path: file.path }, { drive_file_id: this.need(doc, "the scratch doc"), export_as: "pdf" }],
      };
      await this.guard.checkDraft(args, own);
      const out = await this.rawCall("create_draft", args);
      if (out.isError) throw new Error(out.text);
      const r = JSON.parse(out.text) as { status?: string; draftId?: string };
      if (r.status !== "draft_created" || !r.draftId) throw new Error(`expected a draft, got ${r.status ?? "nothing"}`);
      draftId = r.draftId;
      this.ledger.drafts.set(r.draftId, { deleted: false });
      return `draft ${r.draftId}`;
    });
    await this.step("xaq", "check the draft: recipient, 2 attachments, names, sizes", async () => {
      const id = this.need(draftId, "the draft");
      const file = local as { path: string; size: number } | null;
      const v = await this.deps.admin.request<SmokeDraftView>("POST", "/api/smoke/drafts/inspect", this.draftInput(id));
      if (v.recipients.length !== 1 || v.recipients[0] !== own.toLowerCase()) throw new Error(`recipients ${v.recipients.join(", ")}, expected only ${own}`);
      if (v.attachments.length !== 2) throw new Error(`${v.attachments.length} attachments, expected 2`);
      const name = basename(file!.path);
      const a = v.attachments.find((x) => x.filename === name);
      if (!a || a.size !== file!.size) throw new Error(`the local file ${name} isn't attached at ${file!.size} bytes`);
      const docTitle = this.ledger.files.get(doc!)?.name ?? "";
      const d = v.attachments.find((x) => x !== a);
      if (!d || !d.filename.startsWith(docTitle) || d.size <= 0) throw new Error(`the scratch doc "${docTitle}" isn't attached`);
      return `"${a.filename}" ${a.size} B, "${d.filename}" ${d.size} B`;
    });
    await this.step("xaq", "delete the draft", async () => {
      await this.deleteDraft(this.need(draftId, "the draft"));
      return "deleted";
    });
  }

  private draftInput(draftId: string) {
    return { agentId: this.ledger.agent!.id, accountId: this.account!.id, draftId, ledger: [...this.ledger.drafts.keys()] };
  }

  private async deleteDraft(id: string): Promise<void> {
    await this.deps.admin.request("POST", "/api/smoke/drafts/delete", this.draftInput(id));
    this.ledger.drafts.set(id, { deleted: true });
  }

  // ───────────── Cleanup and the leftover check ─────────────

  private async cleanup(): Promise<void> {
    if (this.deps.signal.aborted) this.deps.print("Interrupted: cleaning up (this takes a moment)…");
    const agent = this.ledger.agent;
    for (const [id, d] of this.ledger.drafts) {
      if (d.deleted) continue;
      await this.step("xaq", "cleanup: delete the draft", async () => {
        await this.deleteDraft(id);
        return `draft ${id}`;
      });
    }
    const folder = this.ledger.folder;
    if (folder) {
      await this.step("drive_trash", "cleanup: trash the scratch folder through the approval path", async () => {
        const { approved } = await this.ws("drive_trash", { fileId: folder.id });
        if (!approved) throw new Error("the call wasn't held for approval (the connection should be at \"ask\")");
        const f = await this.driveFacts(folder.id);
        if (!f.trashed) throw new Error("approved, but the folder isn't in the trash");
        return `pending, approved (${approved}), in the trash`;
      });
      // The leftover check on Drive, while the agent can still look.
      for (const [id, f] of [[folder.id, { kind: "folder", name: folder.name }] as const, ...this.ledger.files]) {
        try {
          if (!(await this.driveFacts(id)).trashed) this.leftBehind.push(`Drive ${f.kind} "${f.name}" (${id}) is not in the trash.`);
        } catch (err) {
          this.leftBehind.push(`Drive ${f.kind} "${f.name}" (${id}): couldn't check it (${errText(err)}).`);
        }
      }
    }
    for (const [id, f] of this.ledger.strays) this.leftBehind.push(`Drive ${f.kind} "${f.name}" (${id}) was created outside the scratch folder: check Drive and remove it.`);

    await this.mcp?.close().catch(() => {});
    this.mcp = null;
    if (agent) {
      await this.step("xaq", "cleanup: delete the temporary agent", async () => {
        await this.deps.admin.request("DELETE", `/api/agents/${encodeURIComponent(agent.id)}`);
        return agent.name;
      });
    }
    if (this.dirsChanged && this.previousDirs) {
      await this.step("xaq", "cleanup: restore attachmentDirs", async () => {
        await this.deps.admin.request("PATCH", "/api/settings", { attachmentDirs: this.previousDirs });
        return `${this.previousDirs!.length} dir(s), as before`;
      });
    }
    if (this.ledger.tempDir) rmSync(this.ledger.tempDir, { recursive: true, force: true });
    await this.leftovers();
  }

  private async leftovers(): Promise<void> {
    const agent = this.ledger.agent;
    if (this.ledger.tempDir && existsSync(this.ledger.tempDir)) this.leftBehind.push(`The temp dir ${this.ledger.tempDir} still exists.`);
    try {
      if (agent && this.account) {
        const l = await this.deps.admin.request<SmokeLeftovers>("POST", "/api/smoke/leftovers", { agentId: agent.id, accountId: this.account.id, draftIds: [...this.ledger.drafts.keys()] });
        if (l.agent) this.leftBehind.push(`The temporary agent ${agent.name} (${agent.id}) still exists: delete it in the console (Agents).`);
        if (l.agentSettings) this.leftBehind.push(`The temporary agent's settings (tool mode) are still stored.`);
        for (const d of l.drafts) this.leftBehind.push(`The draft ${d} still exists in ${this.account.email}: delete it in Gmail (Drafts).`);
        for (const a of l.otherSmokeAgents) this.leftBehind.push(`An earlier smoke run's agent ${a.name} (${a.id}) still exists: delete it in the console (Agents).`);
      }
      if (this.previousDirs) {
        const s = await this.deps.admin.request<SettingsView>("GET", "/api/settings");
        if (canonical(s.attachmentDirs ?? []) !== canonical(this.previousDirs)) this.leftBehind.push(`attachmentDirs isn't back to what it was (${this.previousDirs.join(", ") || "empty"}).`);
      }
    } catch (err) {
      this.leftBehind.push(`The leftover check couldn't finish: ${errText(err)}`);
    }
  }
}

export async function runSmoke(flags: SmokeFlags, deps: SmokeDeps): Promise<{ report: SmokeReport; exitCode: number }> {
  const report = await new SmokeRun(flags, deps).run();
  return { report, exitCode: report.ok ? 0 : report.interrupted ? 130 : 1 };
}
