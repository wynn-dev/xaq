// The built CLI ships the attachment parser: dist/attachment-parser.js next to cli.js, one self-contained file (no
// imports but node: builtins, so the sandboxed child needs no file access). Then the real thing: a data directory
// set up through the source server, served by the BUILT `xaq start`, and an agent reading a PDF and a spreadsheet.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Account } from "../shared/types.ts";
import { makePdf, makeXlsx } from "./attachment-fixtures.ts";
import { HAS_AGENTS } from "./e2e/features.ts";
import { grant, mailbox, type Stack, startStack } from "./e2e/harness.ts";
import { buildCli, cleanupListenTemp } from "./e2e/listen.ts";
import { type Agent, attachmentIds, connectAgent } from "./e2e/mcp.ts";
import { waitFor } from "./e2e/wait.ts";

let s: Stack | undefined;
let proc: ChildProcess | undefined;
let agent: Agent | undefined;
const home = mkdtempSync(join(tmpdir(), "xaq-built-home-"));

afterAll(async () => {
  await agent?.close().catch(() => undefined);
  proc?.kill("SIGKILL");
  await s?.close();
  cleanupListenTemp();
  rmSync(home, { recursive: true, force: true });
});

describe("built attachment parser", () => {
  it("is one self-contained file next to cli.js", () => {
    const bundle = readFileSync(join(dirname(buildCli()), "attachment-parser.js"), "utf8");
    const imports = [...bundle.matchAll(/(?:^|[\s;}])import\s*(?:[\w{},\s*]+from\s*)?["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((x) => !x.startsWith("node:"))).toEqual([]);
    expect(bundle).not.toMatch(/\brequire\(["'](?!node:)[^"']+["']\)/);
    expect(bundle).toMatch(/export\s*\{\s*run\s*\}/);
  });

  it.runIf(HAS_AGENTS)("the built `xaq start` reads a PDF and a spreadsheet for an agent", async () => {
    const cli = buildCli();
    s = await startStack();
    const email = mailbox("built-attach");
    const [account] = (await s.bootstrap({ accounts: [{ email }] })) as [Account];
    const { apiKey } = await s.createAgent("built-reader", [grant(account.id, { capabilities: ["read"] })]);
    const msg = s.fake.deliver(email, {
      from: "files@vendor.test",
      subject: "Built",
      text: "Attached.",
      attachments: [
        { filename: "built.pdf", mimeType: "application/pdf", content: makePdf(["Read by the built daemon"]) },
        { filename: "built.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: makeXlsx([{ name: "Data", rows: [["k", "v"], ["a", 1]] }]) },
      ],
    });
    const url = s.url;
    const port = s.config.port;
    await s.stopServer();

    const g = s.fake.google;
    proc = spawn(process.execPath, [cli, "start", "--data", s.dataDir, "--port", String(port), "--host", "127.0.0.1", "--no-open"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XAQ_GOOGLE_OAUTH_BASE: g.oauthBase,
        XAQ_GOOGLE_AUTH_BASE: g.authBase,
        XAQ_GOOGLE_GMAIL_BASE: g.gmailBase,
        XAQ_GOOGLE_PUBSUB_BASE: g.pubsubBase,
        XAQ_GOOGLE_CALENDAR_BASE: g.calendarBase,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    proc.stdout!.on("data", (d) => (output += d));
    proc.stderr!.on("data", (d) => (output += d));
    await waitFor(
      async () => {
        if (proc!.exitCode !== null) throw new Error(`xaq start exited: ${output}`);
        return fetch(`${url}/mcp`).then(
          () => true,
          () => false,
        );
      },
      { what: "the built xaq to listen", timeout: 20_000 },
    );

    agent = await connectAgent(url, apiKey);
    const [pdfId, xlsxId] = attachmentIds(await agent.ok("list_attachments", { message_id: msg.id }));
    const pdf = await agent.ok("get_attachment", { message_id: msg.id, attachment_id: pdfId });
    expect(pdf).toContain("--- Page 1 of 1 ---\nRead by the built daemon");
    const xlsx = await agent.ok("get_attachment", { message_id: msg.id, attachment_id: xlsxId });
    expect(xlsx).toContain("| k | v |\n| --- | --- |\n| a | 1 |");
  });
});
