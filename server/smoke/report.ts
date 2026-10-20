// The smoke run's report: a PASS/FAIL table per tool and step, then what was left behind. --json prints the same
// as JSON. Details never carry email or file content: only names, ids, counts, kinds and sizes.

import pc from "picocolors";
import { safeText } from "../listen/ui.ts";

export type StepStatus = "PASS" | "FAIL" | "SKIP";

export interface StepResult {
  /** The tool (upstream name for Workspace, the native name for mail) or "xaq" for the run's own steps. */
  tool: string;
  step: string;
  status: StepStatus;
  detail: string;
}

export interface SmokeReport {
  marker: string;
  account: string | null;
  connection: string | null;
  steps: StepResult[];
  /** Everything the run couldn't clean up, in plain words; empty when nothing was left. */
  leftBehind: string[];
  /**
   * What earlier runs left that the sweep can't remove (their drafts, their Drive folders), for the owner to check.
   * Not this run's doing, so it doesn't fail the run.
   */
  earlier: string[];
  interrupted: boolean;
  /** Every step passed and nothing was left behind. */
  ok: boolean;
}

export function finish(r: Omit<SmokeReport, "ok">): SmokeReport {
  return { ...r, ok: !r.interrupted && r.steps.length > 0 && r.steps.every((s) => s.status === "PASS") && r.leftBehind.length === 0 };
}

const colour = (s: StepStatus) => (s === "PASS" ? pc.green(s) : s === "FAIL" ? pc.red(s) : pc.yellow(s));

export function renderReport(r: SmokeReport): string[] {
  const rows = r.steps.map((s, i) => ({ n: String(i + 1), tool: safeText(s.tool, 40), step: safeText(s.step, 60), status: s.status, detail: safeText(s.detail, 160) }));
  const w = (k: "n" | "tool" | "step") => Math.max(k === "n" ? 2 : 4, ...rows.map((x) => x[k].length));
  const [wn, wt, ws] = [w("n"), w("tool"), w("step")];
  const out = [pc.bold(`Smoke run ${r.marker}`) + pc.dim(`  account ${r.account ?? "?"} · connection ${r.connection ?? "?"}`), ""];
  out.push(pc.dim(`${"#".padStart(wn)}  ${"TOOL".padEnd(wt)}  ${"STEP".padEnd(ws)}  RESULT  DETAIL`));
  for (const x of rows) out.push(`${x.n.padStart(wn)}  ${x.tool.padEnd(wt)}  ${x.step.padEnd(ws)}  ${colour(x.status)}${" ".repeat(6 - x.status.length)}  ${x.detail}`);
  const count = (s: StepStatus) => r.steps.filter((x) => x.status === s).length;
  out.push("", `${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped${r.interrupted ? ", interrupted (Ctrl-C)" : ""}.`);
  out.push("", pc.bold("Left behind"));
  if (!r.leftBehind.length) out.push("  nothing");
  else for (const l of r.leftBehind) out.push(pc.red(`  - ${safeText(l, 300)}`));
  if (r.earlier.length) {
    out.push("", pc.bold("From earlier runs (check these)"));
    for (const l of r.earlier) out.push(pc.yellow(`  - ${safeText(l, 300)}`));
  }
  out.push("", r.ok ? pc.green("PASS: every step passed and nothing was left behind.") : pc.red("FAIL: see the table and the left-behind list above."));
  return out;
}
