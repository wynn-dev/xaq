// The `mcp.call` approval card's words as pure functions. The server's
// McpCallApprovalView already carries the escaped bytes, the pretty form, recipients and URLs; this adds what the
// console says around them: the target checkbox, warnings and the done states. Relative imports only.

import type { Approval, ApprovalStatus, McpCallApproval, McpCallApprovalView } from "../../../shared/types.ts";

/**
 * Characters a reviewer can't see (the console's hidden-chars set: zero-width, bidi controls, invisible operators,
 * BOM, soft hyphen, tag characters, variation selectors) plus C1 controls, odd spaces and lone surrogates.
 */
// oxlint-disable-next-line no-misleading-character-class
const INVISIBLE = /[\u0080-\u00A0\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2000-\u200F\u2028-\u202F\u205F-\u206F\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

const esc = (unit: number) => `\\u${unit.toString(16).toUpperCase().padStart(4, "0")}`;

// C0 controls and DEL. Line breaks and tabs stay readable in multi-line text (the pretty JSON, a reason) unless
// `oneLine` is set (recipients, URLs, targets, tool names: a newline there can fake a second line).
// oxlint-disable-next-line no-control-regex
const C0_MULTILINE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
// oxlint-disable-next-line no-control-regex
const C0_ALL = /[\u0000-\u001F\u007F]/g;

/**
 * Replaces every invisible or control character in `s` with its JSON escape (astral ones as a surrogate pair).
 * `oneLine`: newlines and tabs too.
 */
export function escapeInvisible(s: string, oneLine = false): string {
  const units = (ch: string) => {
    let out = "";
    for (let i = 0; i < ch.length; i++) out += esc(ch.charCodeAt(i));
    return out;
  };
  return s.replace(new RegExp(INVISIBLE.source, "gu"), units).replace(oneLine ? C0_ALL : C0_MULTILINE, units);
}

export function hasInvisible(s: string): boolean {
  return new RegExp(INVISIBLE.source, "u").test(s);
}

/** Whether stored JSON arguments carry invisible characters, raw or written as \u escapes. */
export function argsHaveInvisible(raw: string): boolean {
  if (hasInvisible(raw)) return true;
  try {
    return hasInvisible(JSON.stringify(JSON.parse(raw)));
  } catch {
    return false;
  }
}

/** An approvals-list item as an mcp.call approval, or null (mail and calendar kinds). */
export function asMcpApproval(a: Approval): McpCallApproval | null {
  return a.kind === "mcp.call" && a.call ? a : null;
}

/** GET /api/approvals/:id answers an mcp.call with its card view, other kinds with the Approval itself. */
export function isCallView(x: McpCallApprovalView | Approval): x is McpCallApprovalView {
  return "approval" in x && "pretty" in x;
}

/** A target value as the card shows it: strings bare, anything else as JSON; invisible characters escaped. */
export function targetValueText(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  const short = s.length > 80 ? `${s.slice(0, 77)}…` : s;
  return escapeInvisible(short, true);
}

/**
 * The "only for …" checkbox label. An array target (several ids in one call) becomes one rule per item, so it
 * reads "these N items".
 */
export function targetLabel(t: NonNullable<McpCallApprovalView["target"]>): string {
  if (Array.isArray(t.value)) return t.value.length === 1 ? `Only for this item (${targetValueText(t.value[0])})` : `Only for these ${t.value.length} items`;
  return `Only for ${targetName(t.path)} ${targetValueText(t.value)}`;
}

/** "/parent/page_id" → "page_id": the last segment of a JSON Pointer, unescaped. */
export function targetName(pointer: string): string {
  const last = pointer.split("/").at(-1) ?? pointer;
  return escapeInvisible(last.replace(/~1/g, "/").replace(/~0/g, "~") || pointer, true);
}

/** The value at a JSON Pointer (RFC 6901) in parsed arguments, or undefined. */
export function atPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) return undefined;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur) && /^(0|[1-9]\d*)$/.test(key)) cur = cur[Number(key)];
    else if (cur && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, key)) cur = (cur as Record<string, unknown>)[key];
    else return undefined;
  }
  return cur;
}

export interface TargetChoice {
  /** JSON Pointer sent as alwaysAllow.targetPath. */
  path: string;
  label: string;
  /** The tool's own target (sent without targetPath: the server uses the tool's). */
  own: boolean;
}

/**
 * What "Always allow this" may be limited to: the tool's own target when it has one, else (generic tools) any of
 * the call's arguments the server offers (argumentPaths), labelled with this call's value.
 */
export function targetChoices(v: Pick<McpCallApprovalView, "target" | "argumentPaths"> & { approval: { call: { args: string } } }): TargetChoice[] {
  if (v.target) {
    // An empty array target has nothing to limit to: no "only for".
    if (Array.isArray(v.target.value) && v.target.value.length === 0) return [];
    return [{ path: v.target.path, label: targetLabel(v.target), own: true }];
  }
  let args: unknown;
  try {
    args = JSON.parse(v.approval.call.args);
  } catch {
    return [];
  }
  return v.argumentPaths.flatMap((path) => {
    const value = atPointer(args, path);
    return value === undefined ? [] : [{ path, label: targetLabel({ path, value }), own: false }];
  });
}

/** The approve body's alwaysAllow for a choice (null = any call to this tool). */
export function alwaysAllowFor(choice: TargetChoice | null): { target?: boolean; targetPath?: string } {
  if (!choice) return { target: false };
  return choice.own ? { target: true } : { target: true, targetPath: choice.path };
}

/** Problems a reviewer must see before deciding, most serious first. */
export function cardWarnings(v: Pick<McpCallApprovalView, "argsIntact" | "tool" | "connection">): string[] {
  const out: string[] = [];
  if (!v.argsIntact) out.push("The stored arguments no longer match their fingerprint. Reject this request.");
  if (!v.connection) out.push("Its connection was removed. Approving can't run it.");
  else if (v.connection.status !== "active") out.push(`${v.connection.name} isn't working right now (${v.connection.status.replace("_", " ")}). Approving fails until it's fixed.`);
  if (!v.tool) out.push("The agent can't reach this tool anymore (access removed, or the tool was removed). Approving can't run it.");
  else if (!v.tool.pinMatches) out.push("The tool's definition changed since the agent asked. Approving can't run it: reject it, and the agent can ask again.");
  return out;
}

export type McpDecision = "approve" | "always" | "reject";

/** The one-tap page's done state after a decision (or when it was already decided). */
export function doneState(
  a: Pick<McpCallApproval, "status" | "error"> & { call: Pick<McpCallApproval["call"], "outcomeUnknown"> },
  decision: McpDecision | null,
): { title: string; description: string; tone: "good" | "bad" | "idle" } {
  switch (a.status) {
    case "sent":
      return {
        title: decision === "always" ? "Approved, and always allowed" : "Approved",
        description:
          "The call ran. " +
          (decision === "always" ? "Matching calls from this agent won't ask again. You can remove the rule on the agent's page." : "The agent gets the result when it checks back."),
        tone: "good",
      };
    case "approved":
      return { title: "Approved", description: "The call is running. The agent gets the result when it checks back.", tone: "good" };
    case "failed":
      return a.call.outcomeUnknown
        ? {
            title: "Approved: outcome unknown",
            description: "The call was interrupted, so it may or may not have run. xaq won't retry it. Check before the agent tries again.",
            tone: "bad",
          }
        : { title: "Approved, but the call failed", description: `${a.error ?? "The upstream returned an error."} The agent is told it failed.`, tone: "bad" };
    case "rejected":
      return { title: "Rejected", description: a.error ?? "Nothing ran. The agent is told you rejected it.", tone: "idle" };
    case "expired":
      return { title: "This request expired", description: "Nothing ran. The agent can ask again.", tone: "idle" };
    case "pending":
      // Approved, but it provably never left (re-auth, rate limit): back to pending with the reason.
      return { title: "Not run yet", description: a.error ?? "", tone: "bad" };
  }
}

/** History rows: what happened, in the call's words. */
export function callStatusLabel(status: ApprovalStatus, outcomeUnknown: boolean | undefined): string | null {
  if (status === "failed" && outcomeUnknown) return "May have run: outcome unknown";
  return null;
}
