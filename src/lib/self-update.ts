import type { HealthResponse, SelfUpdateStatus } from "../../shared/types.ts";

/** An update this tab started (kept in sessionStorage across the reload that picks up the new console). */
export interface PendingUpdate {
  id: string;
  from: string;
  to: string;
  /** Set just before the tab reloads into the new version, so it reloads once. */
  reloaded?: boolean;
}

const PENDING_KEY = "xaq.update.pending";

export function loadPending(): PendingUpdate | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingUpdate) : null;
  } catch {
    return null;
  }
}

export function savePending(pending: PendingUpdate | null): void {
  try {
    if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage blocked: the outcome just isn't shown after the reload.
  }
}

/**
 * What a tab waiting on an update does next. `failed`: the job ended without the new version. `reload`:
 * /api/health answers with the version asked for, so load its console. `succeeded`: that already happened. Otherwise `wait`: the service is restarting or the job is still going.
 */
export function updateVerdict(pending: PendingUpdate, status: SelfUpdateStatus | null, health: HealthResponse | null): "wait" | "reload" | "succeeded" | "failed" {
  const mine = status?.id === pending.id ? status : null;
  if (mine && mine.state !== "running" && mine.state !== "succeeded") return "failed";
  if (health?.version !== pending.to && mine?.state !== "succeeded") return "wait";
  return pending.reloaded ? "succeeded" : "reload";
}

/** A finished job, for a toast or the dialog. */
export function outcomeText(status: SelfUpdateStatus): { ok: boolean; title: string; description: string } {
  if (status.state === "succeeded") return { ok: true, title: `Updated to xaq ${status.to}`, description: "" };
  return { ok: false, title: `The update to ${status.to} failed`, description: `${status.message ?? ""} Check the service on the server (xaq service status).`.trim() };
}
