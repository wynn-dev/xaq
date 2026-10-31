// Adversarial prompt-injection corpus for the content cleaner (server/mail/content.ts).
//
// Philosophy: clean, don't censor. Hidden payloads must be
// removed and flagged; legitimate mail must come through with full fidelity and no false signals.
// Fixtures live in test/fixtures/content/{adversarial,legit}/*.ts; each documents its own expectation.
// Fixtures with a `bug` field document a known cleaner defect and run as `it.fails` until fixed.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { ParsedMessage } from "../server/google/types.ts";
import { type BuiltContent, buildContent, renderMessage, stripInvisible } from "../server/mail/content.ts";
import type { ContentFixture } from "./fixtures/content/fixture.ts";

const ACCOUNT = "me@acme.test";
const DEFAULT_FROM = { name: "Sender", email: "sender@example.net" };
const KINDS = ["adversarial", "legit"] as const;
type Kind = (typeof KINDS)[number];

interface Entry {
  name: string;
  kind: Kind;
  fx: ContentFixture;
}

const root = fileURLToPath(new URL("./fixtures/content/", import.meta.url));
const corpus: Entry[] = [];
for (const kind of KINDS) {
  for (const file of readdirSync(join(root, kind)).filter((f) => f.endsWith(".ts")).sort()) {
    const mod = (await import(pathToFileURL(join(root, kind, file)).href)) as { default: ContentFixture };
    corpus.push({ name: `${kind}/${file.slice(0, -3)}`, kind, fx: mod.default });
  }
}

function toParsed(fx: ContentFixture): ParsedMessage {
  const attachments = fx.attachments ?? [];
  return {
    summary: {
      id: "m1",
      threadId: "t1",
      from: fx.from ?? DEFAULT_FROM,
      to: [{ name: null, email: ACCOUNT }],
      cc: [],
      subject: fx.subject ?? "Test message",
      snippet: "",
      date: "2026-10-15T09:00:00.000Z",
      labelIds: ["INBOX"],
      hasAttachments: attachments.length > 0,
    },
    headers: {},
    messageId: "<m1@example.net>",
    inReplyTo: null,
    references: [],
    replyTo: [],
    text: fx.text ?? null,
    html: fx.html ?? null,
    attachments,
    authenticationResults: fx.authenticationResults ?? null,
  };
}

/** HTML elements that must never leak into the markdown (visible text that merely looks like a tag is opted out per fixture). */
const TAG_LEAK =
  /<\/?(?:html|head|body|div|span|p|a|b|i|u|s|em|strong|table|tbody|thead|tfoot|tr|td|th|font|center|img|br|hr|ul|ol|li|h[1-6]|blockquote|style|script|noscript|template|meta|link|title|o:p|v:[a-z]+|w:[a-z]+)\b[^>]*>/i;
/** Anything a lenient reader could take for the delimiter: `</ email_content >`, turndown's `email\_content`, … */
const DELIMITER_LOOKALIKE = /<\s*\/?\s*email\\?_content\b/gi;
/** The markdown form of an href: turndown backslash-escapes parentheses. */
const mdHref = (href: string) => href.replace(/([()])/g, "\\$1");

interface Outcome {
  failures: string[];
  content: BuiltContent | null;
  rendered: string;
  ms: number;
}

function evaluate({ kind, fx }: Entry): Outcome {
  const parsed = toParsed(fx);
  const maxChars = fx.maxChars ?? 0;
  const t0 = performance.now();
  let content: BuiltContent;
  let rendered: string;
  try {
    content = buildContent(parsed, { accountEmail: ACCOUNT, maxChars });
    rendered = renderMessage(parsed.summary, content, null, maxChars);
  } catch (err) {
    return { failures: [`cleaner threw: ${String(err).slice(0, 160)}`], content: null, rendered: "", ms: performance.now() - t0 };
  }
  const ms = performance.now() - t0;
  const e = fx.expect;
  const body = content.body;
  const failures: string[] = [];
  const fail = (msg: string) => failures.push(msg);

  if (e.hidden !== undefined && content.signals.hiddenContentRemoved !== e.hidden) {
    fail(`hiddenContentRemoved is ${content.signals.hiddenContentRemoved}, expected ${e.hidden}`);
  }
  const lowerRendered = rendered.toLowerCase();
  for (const s of e.absent ?? []) if (lowerRendered.includes(s.toLowerCase())) fail(`hidden payload reached the agent: ${JSON.stringify(s)}`);
  for (const s of e.present ?? []) if (!body.includes(s)) fail(`visible text missing: ${JSON.stringify(s)}`);
  for (const l of e.links ?? []) {
    const md = `[${l.text}](${mdHref(l.href)}`;
    const at = body.indexOf(md);
    if (at < 0 || !/^(?:\)| ")/.test(body.slice(at + md.length))) fail(`link missing or altered: ${md})`);
  }
  for (const line of e.tables ?? []) if (!body.split("\n").includes(line)) fail(`table line missing: ${JSON.stringify(line)}`);
  if (!e.allowTags) {
    const m = TAG_LEAK.exec(body);
    if (m) fail(`HTML tag leaked into markdown: ${m[0].slice(0, 60)}`);
  }
  if (stripInvisible(rendered).removed > 0) fail("invisible/smuggling characters reached the rendered output");

  const hits = content.signals.suspiciousInstructions;
  const susp = e.suspicious ?? (kind === "legit" ? "none" : undefined);
  if (susp === "none" && hits.length) fail(`unexpected suspiciousInstructions: ${JSON.stringify(hits)}`);
  if (susp === "any" && !hits.length) fail("expected suspiciousInstructions, got none");
  if (Array.isArray(susp)) {
    for (const s of susp) {
      if (!hits.some((h) => h.toLowerCase().includes(s.toLowerCase()))) fail(`suspiciousInstructions lacks ${JSON.stringify(s)} (got ${JSON.stringify(hits)})`);
    }
  }

  const opens = rendered.match(/<email_content\b/gi)?.length ?? 0;
  const closes = rendered.match(/<\/email_content>/gi)?.length ?? 0;
  if (opens !== 1 || closes !== 1) fail(`wrapper broken: ${opens} opening / ${closes} closing delimiters`);
  const lookalikes = rendered.match(DELIMITER_LOOKALIKE)?.length ?? 0;
  if (lookalikes !== 2) fail(`${lookalikes - 2} delimiter look-alike(s) outside the real wrapper`);
  const from = parsed.summary.from!.email.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const opener = `<email_content from="${from}" untrusted>`;
  const start = rendered.indexOf(opener);
  const end = rendered.lastIndexOf("</email_content>");
  if (start < 0 || end < start) fail("wrapper opener/closer missing or out of order");
  else {
    const escaped = (body || "(empty body)").replace(/<(\/?)(email_content)/gi, "&lt;$1$2");
    if (rendered.slice(start + opener.length, end) !== `\n${escaped}\n`) fail("wrapper does not contain exactly the (escaped) body");
  }

  if (e.truncated !== undefined && content.truncated !== e.truncated) fail(`truncated is ${content.truncated}, expected ${e.truncated}`);
  if (e.maxMs !== undefined && ms > e.maxMs) fail(`took ${ms.toFixed(0)} ms (budget ${e.maxMs} ms)`);
  return { failures, content, rendered, ms };
}

describe("content corpus", () => {
  it("has fixtures of both kinds", () => {
    expect(corpus.filter((c) => c.kind === "adversarial").length).toBeGreaterThan(20);
    expect(corpus.filter((c) => c.kind === "legit").length).toBeGreaterThan(20);
  });

  for (const kind of KINDS) {
    describe(kind, () => {
      for (const entry of corpus.filter((c) => c.kind === kind)) {
        const run = () => {
          const { failures } = evaluate(entry);
          expect(failures, entry.name).toEqual([]);
        };
        // Known cleaner bugs are documented with `bug` and must keep failing until fixed.
        if (entry.fx.bug) it.fails(`${entry.name} [known bug: ${entry.fx.bug}]`, run);
        else it(entry.name, run);
      }
    });
  }

  it("summary: every fixture behaves as documented", () => {
    const rows = corpus.map((entry) => {
      const o = evaluate(entry);
      const s = o.content?.signals;
      const ok = o.failures.length === 0;
      return {
        fixture: entry.name,
        hidden: s ? (s.hiddenContentRemoved ? "yes" : "no") : "-",
        susp: s ? String(s.suspiciousInstructions.length) : "-",
        chars: o.content ? String(o.content.body.length) : "-",
        ms: o.ms.toFixed(1),
        result: ok ? (entry.fx.bug ? "UNEXPECTED PASS" : "pass") : entry.fx.bug ? "known bug" : "FAIL",
        note: entry.fx.bug ? `bug: ${o.failures[0] ?? ""}` : entry.fx.decision ? "decision" : "",
      };
    });
    const cols = Object.keys(rows[0]!) as (keyof (typeof rows)[number])[];
    const width = (c: (typeof cols)[number]) => Math.max(c.length, ...rows.map((r) => r[c].length));
    const fmt = (r: Record<string, string>) => cols.map((c) => (c === "note" ? r[c]!.slice(0, 110) : r[c]!.padEnd(width(c)))).join("  ");
    const count = (result: string) => rows.filter((r) => r.result === result).length;
    console.log(
      [
        fmt(Object.fromEntries(cols.map((c) => [c, c]))),
        ...rows.map(fmt),
        `${rows.length} fixtures: ${count("pass")} pass, ${count("known bug")} known bugs, ${count("FAIL")} unexpected failures, ${count("UNEXPECTED PASS")} unexpected passes`,
      ].join("\n"),
    );
    expect(rows.filter((r) => r.result === "FAIL" || r.result === "UNEXPECTED PASS").map((r) => r.fixture)).toEqual([]);
  });
});
