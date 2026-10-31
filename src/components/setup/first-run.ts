// First run with Google optional (docs/MCP-BROKER.md, "Setup UX"): the wizard first asks what to connect. Gmail &
// Calendar enters today's Google steps unchanged; Notion or a custom MCP server go to Add connection, then the agent
// step. WHOOP is an extension now (docs/EXTENSIONS.md), so it isn't a first-run card. Pure functions of the server's SetupState and this browser's draft. Relative imports only.

import type { SetupState } from "../../../shared/types.ts";
import type { SetupDraft } from "./steps.ts";

export const FIRST_CHOICES = ["notion", "custom", "google"] as const;
export type FirstChoice = (typeof FIRST_CHOICES)[number];

export const FIRST_CHOICE_INFO: Record<FirstChoice, { title: string; description: string; presetId: string | null }> = {
  notion: { title: "Notion", description: "Pages and databases in your workspace. About 2 minutes.", presetId: "notion" },
  custom: { title: "Another MCP server", description: "Paste its address. xaq finds out how it signs in.", presetId: null },
  google: { title: "Gmail & Calendar", description: "Mail and calendars of your Google accounts. About 10 minutes in Google Cloud.", presetId: null },
};

/** The short path's steps (anything but Google). */
export const BROKER_STEP_IDS = ["connect", "agent"] as const;
export type BrokerStepId = (typeof BROKER_STEP_IDS)[number];

export const BROKER_STEP_META: Record<BrokerStepId, { title: string; short: string }> = {
  connect: { title: "Add your first connection", short: "First connection" },
  agent: { title: "Connect your first agent", short: "First agent" },
};

/** The draft's first-run answer (SetupDraft.firstConnect), if any. */
export type FirstRunDraft = Pick<SetupDraft, "firstConnect" | "urlConfirmed" | "projectConfirmed" | "appType" | "newProjectId" | "existingProjectId">;

/**
 * What /get-started shows: the "what to connect" choice, today's Google wizard, or the short broker path.
 * Without the broker (setting off) it is always the Google wizard. An install already into the Google steps
 * (anything saved on the server, or answers in this browser) stays on them without being asked.
 */
export function firstRunView(state: Pick<SetupState, "googleClientConfigured" | "accountsConnected" | "gcpProjectId"> | undefined, draft: FirstRunDraft): "choose" | "google" | "broker" {
  if (draft.firstConnect === "google") return "google";
  if (draft.firstConnect) return "broker";
  const googleStarted =
    !!state?.googleClientConfigured ||
    (state?.accountsConnected ?? 0) > 0 ||
    !!state?.gcpProjectId ||
    !!draft.projectConfirmed ||
    !!draft.appType ||
    !!draft.newProjectId ||
    !!draft.existingProjectId;
  return googleStarted ? "google" : "choose";
}

/**
 * What /get-started renders: a `?step=` link (Settings, setup warnings, "Add Gmail later") always opens that Google
 * step, whatever was chosen on first run.
 */
export function shownWizard(view: "choose" | "google" | "broker", step: string | undefined): "choose" | "google" | "broker" {
  return step ? "google" : view;
}

export function brokerStatuses(connections: number, agents: number): Record<BrokerStepId, "done" | "todo"> {
  return { connect: connections > 0 ? "done" : "todo", agent: agents > 0 ? "done" : "todo" };
}
