import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { queries } from "@/lib/queries";
import { BROKER_STEP_IDS, brokerStatuses, firstRunView } from "./first-run";
import { allStepsDone, type SetupDraft, STEP_IDS, stepStatuses } from "./steps";

// Per instance: the same browser may set up several xaq daemons.
const KEY = `xaq.setup:${typeof window === "undefined" ? "" : window.location.host}`;
const listeners = new Set<() => void>();
let cache: SetupDraft | null = null;

/** The current draft outside React (event handlers). */
export const readDraft = (): SetupDraft => read();

function read(): SetupDraft {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}") as SetupDraft;
  } catch {
    cache = {};
  }
  return cache;
}

export function updateDraft(patch: Partial<SetupDraft>) {
  cache = { ...read(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* private mode: keep in memory */
  }
  for (const l of listeners) l();
}

/** Removes answers the server now owns (once the OAuth client is saved, it stores project id and app type). */
export function clearServerOwnedDraft() {
  const d = read();
  if (d.projectId === undefined && d.appType === undefined && d.productionConfirmed === undefined && d.projectConfirmed === undefined) return;
  // projectMode stays: later steps (and Settings) still adapt their advice for a shared project.
  const { projectId: _p, appType: _a, productionConfirmed: _c, projectConfirmed: _pc, ...rest } = d;
  cache = rest;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

export function useSetupDraft(): SetupDraft {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    read,
  );
}

export { generateProjectId, PROJECT_ID_RE } from "@/lib/gcp-project";
export { allStepsDone, type SetupDraft, STEP_IDS, STEP_META, type StepId, type StepStatus, showsSetupLink, skippedPatch, startsVerify, stepStatuses, verifiedPatch, verifyDoneHeading, wizardStep } from "./steps";

/** Setup checklist state shared by the wizard, the overview card and the sidebar. */
export function useSetupProgress() {
  const query = useQuery(queries.setupState());
  const draft = useSetupDraft();
  const configured = !!query.data?.googleClientConfigured;
  useEffect(() => {
    if (configured) clearServerOwnedDraft();
  }, [configured]);
  const statuses = stepStatuses(query.data, draft);
  const firstTodo = STEP_IDS.find((id) => statuses[id] === "todo");
  // First run with Google optional: Notion or a custom server take the short path (first-run.ts).
  const view = firstRunView(query.data, draft);
  const connections = useQuery({ ...queries.connections(), enabled: view === "broker" });
  const broker = brokerStatuses(connections.data?.length ?? 0, query.data?.agentsCreated ?? 0);
  if (view === "broker") {
    const finished = BROKER_STEP_IDS.filter((id) => broker[id] === "done").length;
    const brokerTodo = BROKER_STEP_IDS.find((id) => broker[id] === "todo");
    return { query, state: query.data, draft, statuses, finished, total: BROKER_STEP_IDS.length, firstTodo, allDone: !brokerTodo, view, broker, brokerTodo };
  }
  const finished = STEP_IDS.filter((id) => statuses[id] !== "todo").length;
  const allDone = allStepsDone(statuses);
  return { query, state: query.data, draft, statuses, finished, total: STEP_IDS.length, firstTodo, allDone, view, broker, brokerTodo: undefined };
}
