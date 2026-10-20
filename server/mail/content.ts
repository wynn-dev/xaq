// Content guardrails: clean, don't censor. Removes only what a human reader would never see
// (hidden HTML, invisible/smuggling unicode), converts HTML to markdown, and attaches informational
// signals. Content is never altered because of a signal.

import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { Address, ContentSignals, GmailLabel, MessageContent, MessageSummary } from "../../shared/types.ts";
import type { ParsedMessage } from "../google/types.ts";
import {
  backgroundColor,
  contrastRatio,
  DEFAULT_FONT_PX,
  type DomDocument,
  type DomElement,
  type DomNode,
  fontSizePx,
  hasBackgroundImage,
  isZeroLength,
  normalizeColor,
  parseStyle,
  type Style,
  type SheetEffects,
  stylesheetEffects,
} from "./css.ts";
import { stripInvisible } from "./invisible.ts";

export { normalizeColor } from "./css.ts";
// Invisible unicode lives in invisible.ts: the attachment parser child uses it too, and must not load this module.
export { stripInvisible } from "./invisible.ts";

const visibleText = (s: string | null) => stripInvisible(s ?? "").text.trim();

/** Tags delimiting untrusted third-party content in tool results: mail bodies and calendar event descriptions. */
export type UntrustedTag = "email_content" | "calendar_content";

/**
 * Every delimiter xaq wraps untrusted text in: mail bodies, calendar descriptions and upstream MCP
 * tool output (server/broker/policy/output.ts). escapeDelimiters neutralizes all of them everywhere.
 */
export const DELIMITER_TAGS = ["email_content", "calendar_content", "tool_output"] as const;

/**
 * Neutralizes our delimiters and look-alikes (`</ email_content >`, turndown's `calendar\_content`) in
 * untrusted text. Every tag is escaped everywhere: an event description or a tool's output must not close
 * a mail wrapper either.
 */
export const escapeDelimiters = (s: string) => s.replace(/<(?=\s{0,16}\/?\s{0,16}(?:email\\?_content|calendar\\?_content|tool\\?_output))/gi, "&lt;");

// ───────────── HTML cleaning ─────────────

const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;

/** Never rendered. Removed; text inside counts as hidden content only for the ones listed in HIDDEN_TEXT_TAGS. */
const NON_RENDERED = new Set(["SCRIPT", "STYLE", "HEAD", "TITLE", "META", "LINK", "TEMPLATE", "NOSCRIPT", "OBJECT", "EMBED", "IFRAME", "SVG"]);
const HIDDEN_TEXT_TAGS = new Set(["SCRIPT", "TEMPLATE", "NOSCRIPT"]);

/** Hidden in a way no descendant can undo: the element and its subtree are removed. */
function isCollapsed(style: Style): boolean {
  if (style.get("display") === "none") return true;
  const overflow = style.get("overflow");
  if (overflow !== "hidden" && overflow !== "clip") return false;
  return ["max-height", "height", "max-width", "width"].some((p) => isZeroLength(style.get(p)));
}

function parseOpacity(v: string | undefined): number {
  if (v === undefined) return 1;
  const n = v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v);
  return Number.isNaN(n) ? 1 : Math.max(0, Math.min(1, n));
}

/** Text an element would show (also for <template>, whose content linkedom keeps out of textContent). */
function elementText(el: DomElement): string {
  return visibleText(el.textContent || el.innerHTML.replace(/<[^<>]*>/g, " "));
}

const hasText = (n: DomNode) => visibleText(n.textContent).length > 0;

function isTrackingPixel(el: DomElement, style: Style): boolean {
  const small = (v: string | null | undefined) => v != null && /^\s*[01](?:px)?\s*$/.test(v);
  return (small(el.getAttribute("width")) && small(el.getAttribute("height"))) || (small(style.get("width")) && small(style.get("height")));
}

/** Rendering context inherited down the tree (inline styles plus hiding rules from top-level <style>). */
interface Inherited {
  color: string | null;
  bg: string | null;
  /** The real background may differ from `bg`: a background image, or a stylesheet rule setting colours. */
  bgUncertain: boolean;
  /** `background-clip: text` (gradient text): transparent text colour is still visible. */
  clipText: boolean;
  fontPx: number;
  /** Product of ancestor opacities. */
  opacity: number;
  /** visibility:hidden, which a descendant can undo with visibility:visible. */
  invisible: boolean;
}

interface CleanState {
  /** Hidden elements/text that carried readable text. */
  removed: number;
  /** What the document's <style> blocks do: hiding rules and which elements' colours they may change. */
  sheet: SheetEffects;
}

/** Opacity below this, or text smaller than 1px, is invisible to a reader. */
const MIN_OPACITY = 0.1;
/** Text/background contrast below this is unreadable (#eeeeee on white is ~1.16 and stays). */
const MIN_CONTRAST = 1.1;

function textHidden(ctx: Inherited): boolean {
  if (ctx.invisible || ctx.fontPx < 1 || ctx.opacity < MIN_OPACITY) return true;
  if (ctx.color === "transparent") return !ctx.clipText;
  return !!ctx.color && !!ctx.bg && !ctx.bgUncertain && contrastRatio(ctx.color, ctx.bg) < MIN_CONTRAST;
}

function styleOf(el: DomElement, state: CleanState): Style {
  const inline = parseStyle(el.getAttribute("style"));
  const sheet = state.sheet.hiding.get(el);
  return sheet ? new Map([...sheet, ...inline]) : inline;
}

function childContext(el: DomElement, style: Style, parent: Inherited, state: CleanState): Inherited {
  const tag = el.tagName.toUpperCase();
  const visibility = style.get("visibility");
  const ownBg = backgroundColor(style, el);
  const bg = ownBg && ownBg !== "transparent" ? ownBg : null;
  const sheetColour =
    state.sheet.allColourUncertain ||
    state.sheet.colourStyled.has(el) ||
    (state.sheet.classedColourUncertain && (el.hasAttribute("class") || el.hasAttribute("id")));
  const clip = style.get("background-clip") ?? style.get("-webkit-background-clip");
  return {
    color: normalizeColor(style.get("color")) ?? (tag === "FONT" ? normalizeColor(el.getAttribute("color")) : null) ?? parent.color,
    bg: bg ?? parent.bg,
    bgUncertain: (bg ? false : parent.bgUncertain) || hasBackgroundImage(style, el) || sheetColour,
    clipText: parent.clipText || clip === "text",
    fontPx: fontSizePx(style, parent.fontPx),
    opacity: parent.opacity * parseOpacity(style.get("opacity")),
    invisible: visibility === "hidden" || visibility === "collapse" ? true : visibility === "visible" ? false : parent.invisible,
  };
}

/** Comment text a human could read if a client rendered it (conditional comments are rendered by Outlook). */
function commentText(text: string): string {
  return visibleText(text.replace(/^\s*\[if[^\]]*\]>?|<!\[endif\]\s*$|\[endif\]\s*$/gi, "").replace(/<[^<>]*>/g, " "));
}

const MAX_WHITESPACE_RUN = 64;
const LONG_WHITESPACE = /\s{65}/;
const LONG_WHITESPACE_G = /\s{65,}/g;

/** Iterative (deeply nested mail must not overflow the stack). */
function cleanTree(root: DomElement, rootCtx: Inherited, state: CleanState): void {
  const stack: [DomNode, Inherited][] = [[root, rootCtx]];
  while (stack.length) {
    const [node, ctx] = stack.pop()!;
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === COMMENT) {
        if (commentText(child.textContent ?? "")) state.removed++;
        child.remove();
        continue;
      }
      if (child.nodeType === TEXT) {
        if (hasText(child) && textHidden(ctx)) {
          state.removed++;
          child.remove();
          continue;
        }
        // Whitespace runs are capped: nobody reads 64+ blanks, and turndown's end-anchored whitespace
        // regexes are quadratic in run length.
        const text = child.textContent ?? "";
        if (text.length > MAX_WHITESPACE_RUN && LONG_WHITESPACE.test(text)) {
          child.textContent = text.replace(LONG_WHITESPACE_G, (m) => m.slice(0, MAX_WHITESPACE_RUN));
        }
        continue;
      }
      if (child.nodeType !== ELEMENT) continue;
      const el = child as DomElement;
      const tag = el.tagName.toUpperCase();
      if (NON_RENDERED.has(tag)) {
        const jsonLd = tag === "SCRIPT" && /ld\+json/i.test(el.getAttribute("type") ?? "");
        if (HIDDEN_TEXT_TAGS.has(tag) && !jsonLd && elementText(el)) state.removed++;
        el.remove();
        continue;
      }
      const style = styleOf(el, state);
      const inner = childContext(el, style, ctx, state);
      if (el.hasAttribute("hidden") || isCollapsed(style) || inner.opacity < MIN_OPACITY) {
        if (hasText(el)) state.removed++;
        el.remove();
        continue;
      }
      if (tag === "IMG") {
        // Images are never dropped for font-size; only when truly invisible or a tracking pixel.
        if (isTrackingPixel(el, style) || inner.invisible) el.remove();
        continue;
      }
      stack.push([el, inner]);
    }
  }
}

/** Deeper than this, elements are unwrapped (pathological nesting would overflow turndown's recursion). */
const MAX_DEPTH = 80;
const BLOCK_TAGS = new Set(["DIV", "P", "TABLE", "TBODY", "THEAD", "TFOOT", "TR", "TD", "TH", "LI", "UL", "OL", "SECTION", "ARTICLE", "BLOCKQUOTE", "CENTER", "H1", "H2", "H3", "H4", "H5", "H6"]);

/**
 * Replaces everything below MAX_DEPTH with its leaves (text, images, line breaks) in document order.
 * Linear: leaves are collected in one walk and moved individually (moving whole subtrees per level, as
 * unwrapping does, is quadratic in linkedom).
 */
function flattenDeepNesting(root: DomElement): void {
  const stack: [DomElement, number][] = [[root, 0]];
  while (stack.length) {
    const [el, depth] = stack.pop()!;
    if (depth < MAX_DEPTH) {
      for (const c of Array.from(el.childNodes)) if (c.nodeType === ELEMENT) stack.push([c as DomElement, depth + 1]);
      continue;
    }
    const leaves: (DomNode | string)[] = [];
    const walk: (DomNode | string)[] = Array.from(el.childNodes).reverse();
    while (walk.length) {
      const n = walk.pop()!;
      if (typeof n === "string") {
        leaves.push(n);
      } else if (n.nodeType === TEXT || n.nodeName === "IMG" || n.nodeName === "BR") {
        leaves.push(n);
      } else if (n.nodeType === ELEMENT) {
        // A block ends with a space so words from adjacent blocks don't run together.
        if (BLOCK_TAGS.has(n.nodeName)) walk.push(" ");
        walk.push(...Array.from(n.childNodes).reverse());
      }
    }
    for (const c of Array.from(el.childNodes)) c.remove();
    el.append(...leaves);
  }
}

/** Elements beyond this make a message too complex to convert (checked on the raw HTML before parsing). */
export const MAX_ELEMENTS = 20_000;

export class ContentTooComplexError extends Error {}

/** Counts start tags without building anything; stops at the cap. */
function tooManyElements(html: string): boolean {
  const re = /<[a-zA-Z]/g;
  let n = 0;
  while (re.exec(html)) if (++n > MAX_ELEMENTS) return true;
  return false;
}

// ───────────── HTML → markdown ─────────────

const BLOCK_IN_CELL = "div,p,table,ul,ol,h1,h2,h3,h4,h5,h6,blockquote,pre,hr";
/** Browsers ignore tabs/newlines/controls inside URL schemes ("java&#09;script:"). */
// oxlint-disable-next-line no-control-regex -- matching control characters is the point here
const schemeOf = (url: string) => url.replace(/[\x00-\x20\x7f]/g, "").toLowerCase();
const UNSAFE_SCHEME = /^(?:javascript|data|vbscript|file):/;

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    hr: "---",
  });
  td.use(gfm);
  td.addRule("images", {
    filter: "img",
    replacement: (_content, node) => {
      const el = node as unknown as DomElement;
      const alt = (el.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
      const src = (el.getAttribute("src") ?? "").trim();
      const scheme = schemeOf(src);
      if (!src || UNSAFE_SCHEME.test(scheme) || scheme.startsWith("cid:")) return alt ? `[image: ${alt}]` : "";
      return `![${alt.replace(/[[\]]/g, "")}](${src.replace(/[()\s]/g, encodeURIComponent)})`;
    },
  });
  td.addRule("unsafeLinks", {
    filter: (node) => {
      if (node.nodeName !== "A") return false;
      const href = (node as unknown as DomElement).getAttribute("href") ?? "";
      return !href.trim() || UNSAFE_SCHEME.test(schemeOf(href));
    },
    replacement: (content) => content,
  });
  return td;
}

let turndownInstance: TurndownService | undefined;
const turndown = () => (turndownInstance ??= createTurndown());

/** A table holding data (rendered as a GFM table) rather than email layout (unwrapped into blocks). */
function isDataTable(table: DomElement): boolean {
  const role = (table.getAttribute("role") ?? "").toLowerCase();
  if (role === "presentation" || role === "none") return false;
  if (table.querySelector("table")) return false;
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length < 2) return false;
  const widths = rows.map((r) => cellsOf(r).length);
  if (Math.max(...widths) < 2) return false;
  if (table.querySelector("th")) return true;
  return !table.querySelector(BLOCK_IN_CELL);
}

const cellsOf = (row: DomElement) => Array.from(row.childNodes).filter((n): n is DomElement => n.nodeName === "TD" || n.nodeName === "TH");

/** Data-table cells with markup converted through turndown per document; later ones keep only their text. */
const MAX_CONVERTED_CELLS = 2_000;

function cellMarkdown(cell: DomElement, budget: { cells: number }): string {
  // Plain-text cells (most of them) skip the full conversion.
  const plain = Array.from(cell.childNodes).every((n) => n.nodeType === TEXT);
  const md = plain || budget.cells-- <= 0 ? turndown().escape(cell.textContent ?? "") : turndown().turndown(cell.innerHTML);
  return md.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function tableToMarkdown(table: DomElement, budget: { cells: number }): string {
  const rows = Array.from(table.querySelectorAll("tr")).map((r) =>
    cellsOf(r).flatMap((c) => {
      const text = cellMarkdown(c, budget);
      // A spanned cell keeps its columns: the content, then empty cells.
      const span = Math.min(Math.max(parseInt(c.getAttribute("colspan") ?? "1", 10) || 1, 1), 20);
      return [text, ...Array<string>(span - 1).fill("")];
    }),
  );
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [line(head), line(Array(width).fill("---")), ...body.map(line)].join("\n");
}

/** Converts tables in place: data tables become placeholders (filled after turndown), layout tables become blocks. */
function prepareTables(doc: DomDocument, root: DomElement): Map<string, string> {
  const placeholders = new Map<string, string>();
  const tables = Array.from(root.querySelectorAll("table"));
  const data = new Set(tables.filter(isDataTable));
  const budget = { cells: MAX_CONVERTED_CELLS };
  for (const table of data) {
    const key = `AIBTABLE${placeholders.size}X`;
    placeholders.set(key, tableToMarkdown(table, budget));
    const p = doc.createElement("p");
    p.append(key);
    table.replaceWith(p);
  }
  for (const el of Array.from(root.querySelectorAll("table,thead,tbody,tfoot,tr,td,th,caption"))) {
    const div = doc.createElement("div");
    div.append(...Array.from(el.childNodes));
    el.replaceWith(div);
  }
  return placeholders;
}

function tidyMarkdown(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Rebuilds a well-formed document (linkedom misplaces head content that isn't inside <head>): everything
 * before <body> goes into <head>, the rest (including stray content after </body>) into <body>.
 */
function normalizeDocument(html: string): string {
  const open = /<body\b([^<>]{0,4000})>/i.exec(html);
  if (!open) return `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
  const strip = (x: string) => x.replace(/<!DOCTYPE[^<>]{0,4000}>|<\/?(?:html|head|body)\b[^<>]{0,4000}>/gi, "");
  const head = strip(html.slice(0, open.index));
  const body = strip(html.slice(open.index + open[0].length));
  return `<!DOCTYPE html><html><head>${head}</head><body${open[1]}>${body}</body></html>`;
}

/** Cleans hidden content out of an HTML body and converts it to markdown. */
export function htmlToMarkdown(html: string): { markdown: string; removed: number } {
  if (tooManyElements(html)) throw new ContentTooComplexError(`more than ${MAX_ELEMENTS} elements`);
  const doc = parseHTML(normalizeDocument(html)).document as unknown as DomDocument;
  const root = doc.body ?? doc.documentElement;
  const state: CleanState = { removed: 0, sheet: stylesheetEffects(doc) };
  const rootStyle = styleOf(root, state);
  const base: Inherited = { color: null, bg: null, bgUncertain: false, clipText: false, fontPx: DEFAULT_FONT_PX, opacity: 1, invisible: false };
  const rootCtx = childContext(root, rootStyle, base, state);
  if (root.hasAttribute("hidden") || isCollapsed(rootStyle) || rootCtx.opacity < MIN_OPACITY) {
    return { markdown: "", removed: hasText(root) ? 1 : 0 };
  }
  if (!rootCtx.color) rootCtx.color = normalizeColor(root.getAttribute("text"));
  cleanTree(root, rootCtx, state);
  flattenDeepNesting(root);
  const tables = prepareTables(doc, root);
  let md = turndown().turndown(root.innerHTML);
  for (const [key, table] of tables) md = md.replace(key, `\n\n${table}\n\n`);
  const stripped = stripInvisible(md);
  return { markdown: tidyMarkdown(stripped.text), removed: state.removed + stripped.removed };
}

/** Cleans a text/plain body. */
export function cleanPlainText(text: string): { text: string; removed: number } {
  const stripped = stripInvisible(text);
  return { text: tidyMarkdown(stripped.text), removed: stripped.removed };
}

// ───────────── Signals ─────────────

/** Drops RFC 5322 comments (nested parentheses) and the contents of quoted strings, in one pass. */
function withoutCommentsAndQuotes(s: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (quoted) {
      if (c === '"') {
        quoted = false;
        out += '"';
      }
    } else if (c === '"' && depth === 0) {
      quoted = true;
      out += '"';
    } else if (c === "(") {
      depth++;
    } else if (c === ")" && depth > 0) {
      if (--depth === 0) out += " ";
    } else if (depth === 0) {
      out += c;
    }
  }
  return out;
}

/**
 * SPF/DKIM/DMARC from the topmost Authentication-Results header only, which Gmail adds on receipt
 * (authserv-id mx.google.com). Lower headers can be supplied by the sender and never fill gaps. Comments
 * and quoted strings are removed first, and results are read only at the start of each resinfo.
 */
export function parseAuthResults(header: string | null): ContentSignals["auth"] {
  if (!header) return null;
  // Unfold continuation lines, then take the first header (several are joined with "\n").
  const top = header.slice(0, 8192).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)[0] ?? "";
  const s = withoutCommentsAndQuotes(top);
  const [servId = "", ...resinfo] = s.split(";");
  if (!/^(?:[a-z0-9-]+\.)*google\.com$/i.test(servId.trim().split(/\s+/)[0] ?? "")) return null;
  const result = (method: string) => {
    for (const r of resinfo) {
      const m = new RegExp(`^\\s*${method}\\s*=\\s*([a-z]+)`, "i").exec(r);
      if (m) return m[1]!.toLowerCase();
    }
    return null;
  };
  return { spf: result("spf"), dkim: result("dkim"), dmarc: result("dmarc") };
}

/** Consumer mailbox domains: senders on the same domain are still other people. */
const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Lower-cased address; Gmail addresses ignore dots and +tags in the local part, googlemail.com ≡ gmail.com. */
function canonicalAddress(email: string): { local: string; domain: string } {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (CONSUMER_DOMAINS.has(domain)) {
    domain = "gmail.com";
    local = local.replace(/\+.*$/, "").replace(/\./g, "");
  }
  return { local, domain };
}

/** Sender outside the account's organization (subdomains count as inside); for consumer Gmail, anyone but the account itself. */
export function isExternal(sender: string | null | undefined, accountEmail: string): boolean {
  if (!sender) return false;
  const s = canonicalAddress(sender);
  const own = canonicalAddress(accountEmail);
  if (own.domain === "gmail.com") return s.local !== own.local || s.domain !== own.domain;
  return !(s.domain === own.domain || s.domain.endsWith(`.${own.domain}`));
}

interface Pattern {
  re: RegExp;
  /** Skip the hit when its clause is negated ("we will never ask you to share your password"). */
  negatable?: boolean;
}

const SUSPICIOUS: Pattern[] = [
  {
    re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier|preceding|existing)\s+(?:instructions?|prompts?|directions|rules|guidelines|messages)\b/i,
    negatable: true,
  },
  // Persona switches, not "you are now a member/subscribed".
  { re: /\byou\s+are\s+now\s+(?:an?\s+(?:ai|assistant|agent|chatbot|language\s+model|llm)\b|acting\s+as\b|in\s+(?:developer|god|admin|debug|dan|jailbreak)\s+mode\b|dan\b|(?:the|my)\s+(?:assistant|agent)\b)/i },
  // Requests about a system prompt, not mentions of the term.
  {
    re: /\b(?:reveal|print|show|repeat|output|paste|share|send|leak|ignore|disregard|override|bypass)\s+(?:me\s+)?(?:your|the|this)\s+(?:system\s+prompt|hidden\s+instructions|initial\s+instructions)\b|\bnew\s+system\s+prompt\b/i,
    negatable: true,
  },
  { re: /\bnew\s+instructions\s*:/i },
  { re: /\bforward\s+(?:all|every|each)\s+(?:of\s+(?:the|your|my)\s+)?(?:e-?mails?|messages|mail|correspondence)\b/i, negatable: true },
  { re: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|notify|alert|mention\s+(?:this\s+)?to)\s+(?:the\s+)?(?:user|owner|human|recipient)\b/i },
  { re: /\bBEGIN\s+SYSTEM\b|\bEND\s+SYSTEM\b|<\/?system>|\[\/?system\]|<\|im_start\|>/i },
  // Transcript role spoofing ("Assistant: Sure, …"), not "System: macOS 15.1" or a job title.
  { re: /^[ \t]*(?:assistant|system|ai)[ \t]*:[ \t]*(?:you\b|ignore\b|disregard\b|from\s+now\b|new\s+instructions\b|sure\b|okay\b|ok\b|i\s+will\b|i'll\b|understood\b)/im },
  { re: /\b(?:reveal|send|share|leak|exfiltrate|give)\s+(?:me\s+)?(?:your|the)\s+(?:api\s+keys?|credentials|passwords?|secrets?|tokens?|instructions)\b/i, negatable: true },
  // Imperatives, not retention notices ("we will delete all messages older than 90 days").
  {
    re: /\b(?:delete|trash|purge)\s+(?:all|every)\s+(?:e-?mails?|messages)\b(?!\s+(?:and\s+\w+\s+)?(?:older|after|before|from\s+before|that\s+are|which\s+are)\b)/i,
    negatable: true,
  },
  { re: /\bnote\s+to\s+(?:the\s+)?(?:ai|assistant|agent|llm)\b/i },
];

const NEGATION = /\b(?:never|not|no\s+one|nobody|cannot|won't|don't|doesn't|didn't|isn't|aren't)\b|n't\b/i;

/** True when the clause before `index` (back to the sentence start) contains a negation. */
function negated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 80), index);
  const clause = before.split(/[.!?\n;:]/).at(-1) ?? "";
  return NEGATION.test(clause);
}

/** Phrases common in prompt-injection attempts. Informational only. */
export function suspiciousPhrases(text: string): string[] {
  const hits = new Set<string>();
  for (const { re, negatable } of SUSPICIOUS) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(g)) {
      if (negatable && negated(text, m.index)) continue;
      hits.add(m[0].replace(/\s+/g, " ").trim());
      break;
    }
  }
  return [...hits].slice(0, 5);
}

// ───────────── Truncation ─────────────

/** Truncates to `max` chars (0 = unlimited) at a paragraph, line or word boundary when one is close. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (!max || text.length <= max) return { text, truncated: false };
  let cut = max;
  // Never split a surrogate pair.
  if (/[\uD800-\uDBFF]/.test(text[cut - 1] ?? "")) cut--;
  const window = text.slice(0, cut);
  const floor = Math.floor(cut * 0.8);
  for (const sep of ["\n\n", "\n", " "]) {
    const i = window.lastIndexOf(sep);
    if (i >= floor) return { text: window.slice(0, i).trimEnd(), truncated: true };
  }
  return { text: window, truncated: true };
}

// ───────────── Message content ─────────────

export interface BuiltContent extends MessageContent {
  /** Untruncated length, for the "truncated" note. */
  totalChars: number;
}

const UNCONVERTIBLE = "[The HTML body of this message could not be converted to text.]";
const TOO_COMPLEX_NOTE = "[The HTML version of this message is too complex to display safely; showing the plain-text version.]";
/** Larger HTML bodies are not converted (bounded work per message); the text/plain part is used instead. */
export const MAX_HTML_CHARS = 500_000;

/**
 * Cleaned, markdown-converted content with signals. Prefers HTML (more faithful), else text/plain. The
 * text/plain part is not used when the HTML's text was all hidden: the human reading HTML never sees it.
 */
export function buildContent(parsed: ParsedMessage, opts: { accountEmail: string; maxChars: number }): BuiltContent {
  let body = "";
  let removed = 0;
  let allHidden = false;
  let failed = false;
  let note = "";
  if (parsed.html && parsed.html.length > MAX_HTML_CHARS) {
    failed = true;
    note = `[The HTML version of this message is too large to convert (${Math.round(parsed.html.length / 1024)} KB); showing the plain-text version.]`;
  } else if (parsed.html && parsed.html.trim()) {
    try {
      const r = htmlToMarkdown(parsed.html);
      body = r.markdown;
      removed = r.removed;
      allHidden = !body && r.removed > 0;
    } catch (err) {
      failed = true;
      if (err instanceof ContentTooComplexError) note = TOO_COMPLEX_NOTE;
    }
  }
  if (!body && !allHidden && parsed.text) {
    const r = cleanPlainText(parsed.text);
    body = r.text;
    removed += r.removed;
  }
  if (!body && failed) body = note ? note.replace(/; showing the plain-text version/, "") : UNCONVERTIBLE;
  else if (note) body = `${note}\n\n${body}`;
  body = escapeDelimiters(body);
  const subject = stripInvisible(parsed.summary.subject ?? "");
  removed += subject.removed;
  const t = truncateText(body, opts.maxChars);
  return {
    body: t.text,
    truncated: t.truncated,
    totalChars: body.length,
    attachments: parsed.attachments,
    signals: {
      hiddenContentRemoved: removed > 0,
      suspiciousInstructions: suspiciousPhrases(`${subject.text}\n${body}`),
      auth: parseAuthResults(parsed.authenticationResults),
      external: isExternal(parsed.summary.from?.email, opts.accountEmail),
    },
  };
}

// ───────────── Rendering for agents ─────────────

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Wraps untrusted content in the delimiter: `<email_content from="…" untrusted>` for mail,
 * `<calendar_content organizer="…" untrusted>` for event descriptions. Delimiter tags and look-alikes inside
 * the content are escaped.
 */
export function wrapUntrusted(from: string | null | undefined, body: string, tag: UntrustedTag = "email_content"): string {
  const attr = tag === "calendar_content" ? "organizer" : "from";
  return `<${tag} ${attr}="${escapeAttr(cleanLine(from ?? "unknown", 320))}" untrusted>\n${escapeDelimiters(body)}\n</${tag}>`;
}

const MAX_LINE_INPUT = 4096;

/** Untrusted header-ish text (subjects, names, snippets) on one line: cleaned, delimiter-escaped, optionally clipped. */
export function cleanLine(s: string, max = 0): string {
  // Clip first: header-ish values can be huge, and nothing past the clip is shown anyway.
  const one = escapeDelimiters(stripInvisible(s.slice(0, max ? max * 4 : MAX_LINE_INPUT)).text.replace(/\s+/g, " ").trim());
  return max && one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export function formatAddress(a: Address | null | undefined): string {
  if (!a) return "(unknown)";
  const name = a.name ? cleanLine(a.name, 100) : "";
  if (!name || name.toLowerCase() === a.email.toLowerCase()) return cleanLine(a.email);
  // A display name that looks like an address ("<ceo@acme.com>") must not read as the real sender.
  return /[<>@"]/.test(name) ? `"${name.replace(/[<>"]/g, "")}" <${cleanLine(a.email)}>` : `${name} <${cleanLine(a.email)}>`;
}

export const formatAddresses = (list: Address[]) => list.map(formatAddress).join(", ");

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function labelNames(ids: string[], labels: GmailLabel[] | null): string[] {
  const byId = new Map((labels ?? []).map((l) => [l.id, l.name]));
  return ids.map((id) => cleanLine(byId.get(id) ?? id));
}

/** Only noteworthy signals, on one short line; null when there is nothing to say. */
export function signalLine(s: ContentSignals): string | null {
  const parts: string[] = [];
  if (s.auth) {
    const failed = (["spf", "dkim", "dmarc"] as const).filter((k) => {
      const v = s.auth![k];
      return v !== null && !["pass", "none", "neutral", "bestguesspass"].includes(v);
    });
    if (failed.length) parts.push(`sender authentication failed (${failed.map((k) => `${k.toUpperCase()}=${s.auth![k]}`).join(", ")})`);
  }
  if (s.external) parts.push("external sender");
  if (s.hiddenContentRemoved) parts.push("hidden content removed");
  if (s.suspiciousInstructions.length) {
    parts.push(`contains instruction-like text (${s.suspiciousInstructions.map((p) => `"${cleanLine(p, 60)}"`).join(", ")})`);
  }
  return parts.length ? `Signals: ${parts.join("; ")}` : null;
}

/** Compact header block + one wrapped body. Every header value is untrusted and goes through cleanLine. */
export function renderMessage(summary: MessageSummary, content: BuiltContent, labels: GmailLabel[] | null, maxChars: number): string {
  const lines = [`Message ${cleanLine(summary.id)} (thread ${cleanLine(summary.threadId)})`, `From: ${formatAddress(summary.from)}`];
  if (summary.to.length) lines.push(`To: ${formatAddresses(summary.to)}`);
  if (summary.cc.length) lines.push(`Cc: ${formatAddresses(summary.cc)}`);
  lines.push(`Date: ${cleanLine(summary.date)}`, `Subject: ${cleanLine(summary.subject) || "(no subject)"}`);
  if (summary.labelIds.length) lines.push(`Labels: ${labelNames(summary.labelIds, labels).join(", ")}`);
  if (content.attachments.length) {
    lines.push(
      `Attachments: ${content.attachments
        .map((a) => `${cleanLine(a.filename) || "(unnamed)"} (${cleanLine(a.mimeType)}, ${formatSize(a.size)}, attachment_id: ${cleanLine(a.id)})`)
        .join("; ")}`,
    );
  }
  const signals = signalLine(content.signals);
  if (signals) lines.push(signals);
  lines.push(wrapUntrusted(summary.from?.email, content.body || "(empty body)"));
  if (content.truncated) {
    lines.push(`[Body truncated at ${maxChars} of ${content.totalChars} characters (operator setting maxBodyChars).]`);
  }
  return lines.join("\n");
}

/**
 * Content when cleaning didn't finish in time (see server/mail/pool.ts): the cleaned text/plain part, or a
 * notice. Never the unconverted HTML. Marked truncated, with a note saying why.
 */
export function fallbackContent(parsed: ParsedMessage, opts: { accountEmail: string; maxChars: number }): BuiltContent {
  const text = parsed.text ? cleanPlainText(parsed.text.slice(0, MAX_HTML_CHARS)).text : "";
  const body = escapeDelimiters(
    text
      ? `[This message is too complex to display safely; showing its plain-text version.]\n\n${text}`
      : "[This message is too complex to display safely. Ask a human to read it in Gmail.]",
  );
  const subject = stripInvisible(parsed.summary.subject ?? "");
  const t = truncateText(body, opts.maxChars);
  return {
    body: t.text,
    truncated: true,
    totalChars: body.length,
    attachments: parsed.attachments,
    signals: {
      hiddenContentRemoved: false,
      suspiciousInstructions: suspiciousPhrases(`${subject.text}\n${body}`),
      auth: parseAuthResults(parsed.authenticationResults),
      external: isExternal(parsed.summary.from?.email, opts.accountEmail),
    },
  };
}
