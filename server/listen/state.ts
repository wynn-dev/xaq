import { readFileSync } from "node:fs";
import type { EventType } from "../../shared/types.ts";
import { writePrivateFile } from "./fsutil.ts";
import { statusPath } from "./paths.ts";

// ───────────── Status (for `listen status`) ─────────────

export interface RecentEvent {
  seq: number;
  id: string;
  type: EventType;
  outcome: "succeeded" | "failed" | "skipped" | "retrying";
  attempts: number;
  at: string;
  error?: string | null;
}

export interface ListenStatus {
  pid: number;
  url: string;
  consumer: string;
  version: string;
  startedAt: string;
  connected: boolean;
  connectedSince: string | null;
  lastDisconnect: { at: string; reason: string } | null;
  lastEventAt: string | null;
  receivedSeq: number;
  ackedSeq: number;
  running: number;
  recent: RecentEvent[];
  stoppedAt: string | null;
  exitReason: string | null;
  /** What the (last) run executed, flags included. */
  exec?: string | null;
  /** The (last) run's filters in words. */
  filters?: string;
  /** Events the filters skipped this run (acknowledged without running anything). */
  skipped?: number;
}

export function readStatus(): ListenStatus | null {
  try {
    return JSON.parse(readFileSync(statusPath(), "utf8")) as ListenStatus;
  } catch {
    return null;
  }
}

/** Writes status.json at most once a second (and immediately on `flush`). */
export class StatusWriter {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    readonly status: ListenStatus,
    /** false: keep the status in memory only (a one-off backfill must not overwrite the listener's status.json). */
    private readonly persist = true,
  ) {}

  update(patch: Partial<ListenStatus>): void {
    Object.assign(this.status, patch);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
    this.timer.unref();
  }

  addRecent(e: RecentEvent): void {
    this.status.recent = [e, ...this.status.recent.filter((r) => r.seq !== e.seq)].slice(0, 20);
    this.update({});
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.persist) return;
    try {
      writePrivateFile(statusPath(), JSON.stringify(this.status, null, 2) + "\n");
    } catch {
      // Status is best effort.
    }
  }
}

/** Whether a process with this pid is alive (status.json may be left over from a crash). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
