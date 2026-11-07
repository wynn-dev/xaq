import type { Agent, ConsoleStreamMessage, SetupState } from "@shared/types";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { type LiveStreamHandlers, openLiveStream, type StreamState } from "./live-stream";
import { keys } from "./queries";

type Listener = (msg: ConsoleStreamMessage) => void;

interface StreamContextValue {
  state: StreamState;
  subscribe: (fn: Listener) => () => void;
}

const StreamContext = createContext<StreamContextValue>({ state: "connecting", subscribe: () => () => {} });

/** Which cached queries each kind of stream message makes stale. */
const STALE: Record<ConsoleStreamMessage["kind"], readonly (readonly string[])[]> = {
  event: [keys.events, keys.overview],
  audit: [keys.audit, keys.agents, keys.overview],
  account: [keys.accounts, keys.setupState, keys.overview, keys.calendarSetup],
  pairing: [keys.pairings, keys.agents],
  // Written into the cache instead (applyAgent): acks arrive up to once a second.
  agent: [],
};
const ALL_STALE = [...new Set([...Object.values(STALE).flat(), keys.eventHistory, keys.auditLog])];

/**
 * An `agent` message carries the whole Agent: put it in the list and detail caches without a refetch.
 * A fetch already in flight may have read the agent before this change and would overwrite it, so
 * such a query is refetched (invalidate cancels the running fetch and starts a new one).
 */
function applyAgent(qc: QueryClient, agent: Agent) {
  let known = false;
  qc.setQueryData<Agent[]>(keys.agents, (old) =>
    old?.map((a) => {
      if (a.id !== agent.id) return a;
      known = true;
      return agent;
    }),
  );
  if (qc.getQueryData(keys.agent(agent.id))) qc.setQueryData<Agent>(keys.agent(agent.id), agent);
  for (const queryKey of [keys.agents, keys.agent(agent.id)]) {
    if (qc.isFetching({ queryKey, exact: true })) void qc.invalidateQueries({ queryKey, exact: true });
  }
  // An agent the list hasn't seen yet (created elsewhere): fetch the list.
  if (!known && qc.getQueryData(keys.agents)) void qc.invalidateQueries({ queryKey: keys.agents, exact: true });
  // The first sign that an agent works completes setup (SetupState.verified is computed server-side:
  // an MCP call, or a listener that acked past where it started).
  const setup = qc.getQueryData<SetupState>(keys.setupState);
  if (setup && !setup.verified && (agent.lastMcpAt || agent.listeners.some((l) => l.ackedSeq > (l.startSeq ?? 0)))) {
    void qc.invalidateQueries({ queryKey: keys.setupState });
  }
}

function isMessage(v: unknown): v is ConsoleStreamMessage {
  return !!v && typeof v === "object" && typeof (v as { kind?: unknown }).kind === "string" && "data" in v;
}

/**
 * Holds the console's single live stream on /api/events/stream (openLiveStream keeps it open). Each message
 * refreshes the queries it affects (batched) and is handed to subscribers (the live events page, the OAuth
 * connect flow). After any reconnect, everything stream-fed is refetched since messages may have been missed.
 */
export function StreamProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<StreamState>("connecting");
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Map<string, readonly string[]>();

    const invalidate = (roots: readonly (readonly string[])[]) => {
      for (const r of roots) pending.set(r.join("/"), r);
      flushTimer ??= setTimeout(() => {
        flushTimer = undefined;
        for (const key of pending.values()) void qc.invalidateQueries({ queryKey: key });
        pending.clear();
      }, 300);
    };

    const handlers: LiveStreamHandlers = {
      state: setState,
      open: (resumed) => {
        if (resumed) invalidate(ALL_STALE);
      },
      message: (data) => {
        let msg: unknown;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (!isMessage(msg)) return;
        if (msg.kind === "agent") applyAgent(qc, msg.data);
        invalidate(STALE[msg.kind] ?? []);
        for (const l of listeners.current) l(msg);
      },
    };
    const close = openLiveStream("/api/events/stream", handlers, { EventSource, window, document });
    return () => {
      close();
      clearTimeout(flushTimer);
    };
  }, [qc]);

  const [subscribe] = useState(() => (fn: Listener) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  });

  return <StreamContext value={{ state, subscribe }}>{children}</StreamContext>;
}

export const useStreamState = () => useContext(StreamContext).state;

/** Calls `fn` for every stream message while mounted. `fn` may change between renders. */
export function useStreamListener(fn: Listener) {
  const { subscribe } = useContext(StreamContext);
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => subscribe((m) => ref.current(m)), [subscribe]);
}
