// The wizard's steps and their done/todo state as a pure function of the server's SetupState and this
// browser's draft, so it can be tested directly. No React and relative imports only (no @ aliases):
// vitest and the server/test typecheck load this module too.

import type { GoogleAppType, SetupState } from "../../../shared/types.ts";
import { PROJECT_ID_RE } from "../../lib/gcp-project.ts";

/**
 * Wizard answers the server can't store yet: the Google client endpoint only accepts the project id
 * and app type together with the OAuth client, so those are kept here (per browser) until step 4
 * saves everything. Also remembers acknowledgements like "public URL confirmed".
 */
export interface SetupDraft {
  /** First run's "what do you want to connect?" answer (first-run.ts). Unset: not asked yet. */
  firstConnect?: "notion" | "custom" | "google";
  urlConfirmed?: boolean;
  /** "new" (default): a dedicated project created for xaq; "existing": reuse one (advanced). */
  projectMode?: "new" | "existing";
  /** Pre-generated ID for the new project (xaq-123456), editable. Kept so the command stays the same. */
  newProjectId?: string;
  /** The ID typed for an existing project. */
  existingProjectId?: string;
  /** How the new project gets created: one Cloud Shell command, or clicks in the console. */
  projectMethod?: "shell" | "console";
  /** Create the new project inside the user's Google Workspace organization (needed for Internal). */
  projectInOrg?: boolean;
  /** The project the later steps use, set when step 2 is confirmed. */
  projectId?: string;
  projectConfirmed?: boolean;
  appType?: GoogleAppType;
  productionConfirmed?: boolean;
  /**
   * Set when this browser first opens "Check that it works" before it is done. From then on only
   * this browser's own result (verified) completes that step, not the server's weaker evidence.
   */
  verifyStarted?: boolean;
  /** Set by the "Check that it works" step: as soon as every check is green, or by "Finish without checking". */
  verified?: boolean;
  /** How step 7 was finished in this browser: every check green, or "Finish without checking". Unset before this was recorded. */
  verifiedBy?: "checks" | "skip";
}

export const STEP_IDS = ["url", "project", "consent", "client", "accounts", "agent", "verify"] as const;
export type StepId = (typeof STEP_IDS)[number];
export type StepStatus = "done" | "todo";

export const STEP_META: Record<StepId, { title: string; short: string }> = {
  url: { title: "Choose the address of xaq", short: "Address" },
  project: { title: "Create a Google Cloud project", short: "Google Cloud project" },
  consent: { title: "Set up the Google sign-in screen", short: "Sign-in screen" },
  client: { title: "Create the OAuth client", short: "OAuth client" },
  accounts: { title: "Connect Google accounts", short: "Google accounts" },
  agent: { title: "Connect your first agent", short: "First agent" },
  verify: { title: "Check that it works", short: "Check it works" },
};

export function stepStatuses(state: SetupState | undefined, draft: SetupDraft): Record<StepId, StepStatus> {
  const s = state;
  const clientDone = !!s?.googleClientConfigured;
  const accountsDone = (s?.accountsConnected ?? 0) > 0;
  return {
    url: draft.urlConfirmed || clientDone || accountsDone ? "done" : "todo",
    project: s?.gcpProjectId || (draft.projectConfirmed && draft.projectId && PROJECT_ID_RE.test(draft.projectId)) ? "done" : "todo",
    consent:
      s?.googleAppType || (draft.appType && (draft.appType === "internal" || draft.productionConfirmed)) ? "done" : "todo",
    client: clientDone ? "done" : "todo",
    accounts: accountsDone ? "done" : "todo",
    agent: (s?.agentsCreated ?? 0) > 0 ? "done" : "todo",
    // Started here but not finished: stay todo (the server's evidence turns up long before the test email).
    verify: draft.verified || (!draft.verifyStarted && s?.verified) ? "done" : "todo",
  };
}

/**
 * Whether showing `step` starts the end-to-end check in this browser (sets SetupDraft.verifyStarted),
 * so the server's weaker evidence can't complete step 7 behind the user's back. Opening step 6 while
 * no agent exists counts too: the agent's first tool call often lands before step 7 is opened.
 * Never on an install that is already verified (opening the guide later changes nothing).
 */
export function startsVerify(step: StepId, statuses: Record<StepId, StepStatus>, draft: SetupDraft): boolean {
  if (draft.verifyStarted || draft.verified || statuses.verify !== "todo") return false;
  return step === "verify" || (step === "agent" && statuses.agent === "todo");
}

/**
 * The draft change once step 7's required checks are all green ("Setup complete"): the step is done
 * right away, so leaving without "Finish setup" doesn't leave setup at 6 of 7. null when nothing changes.
 */
export function verifiedPatch(complete: boolean, draft: SetupDraft): Partial<SetupDraft> | null {
  // Also after "Finish without checking" (or before verifiedBy existed): the checks have passed now.
  return complete && (!draft.verified || draft.verifiedBy !== "checks") ? { verified: true, verifiedBy: "checks" } : null;
}

/** "Finish without checking": done, recorded as skipped unless the checks already passed. */
export function skippedPatch(draft: SetupDraft): Partial<SetupDraft> {
  return { verified: true, verifiedBy: draft.verifiedBy === "checks" ? "checks" : "skip" };
}

/**
 * The heading once step 7's checks are done: "Setup complete" only when every required step is (or
 * only step 7 is left, about to be marked); otherwise "This check is done" and the first required
 * step still to do, for a link.
 */
export function verifyDoneHeading(statuses: Record<StepId, StepStatus>): { title: string; nextStep: StepId | null } {
  const next = STEP_IDS.find((id) => id !== "verify" && statuses[id] === "todo");
  return next ? { title: "This check is done", nextStep: next } : { title: "Setup complete", nextStep: null };
}

/** The sidebar's "Get started" entry: while setup is unfinished, and on /get-started itself (it goes on navigating away). */
export function showsSetupLink(loaded: boolean, allDone: boolean, pathname: string): boolean {
  return loaded && (!allDone || pathname.startsWith("/get-started"));
}

/** Setup counts as done once every step is. */
export function allStepsDone(statuses: Record<StepId, StepStatus>): boolean {
  return STEP_IDS.every((id) => statuses[id] !== "todo");
}

/**
 * The step /get-started shows: `?step=`, else the first unfinished one. Without `?step=`, `pin` is
 * that choice once progress has loaded, for the page to write into the URL (a replace navigation):
 * otherwise finishing the shown step's requirements would move the first unfinished step on, and
 * the user with it, past Continue and the step's optional parts.
 */
export function wizardStep(step: StepId | undefined, progress: { loaded: boolean; firstTodo: StepId | undefined }): { shown: StepId; pin: StepId | null } {
  const shown = step ?? progress.firstTodo ?? "verify";
  return { shown, pin: step || !progress.loaded ? null : shown };
}
