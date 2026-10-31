// BrokerPolicy: the connection's state and the agent's level. Never runs the call.

import type { Db } from "../../db/index.ts";
import type { SettingsStore } from "../../settings.ts";
import type { BrokerPolicy, CallDecision, RegisteredTool } from "../types.ts";
import { connectionLabel, reconnectMessage } from "./errors.ts";
import { connectionInfo } from "./store.ts";

export function createBrokerPolicy(deps: { db: Db; settings: SettingsStore }): BrokerPolicy {
  const { db, settings } = deps;
  const deny = (reason: string, message: string): CallDecision => ({ kind: "deny", reason, message });

  function decide(tool: RegisteredTool): CallDecision {
    const conn = connectionInfo(db, tool.connectionId);
    if (!conn) return deny("unknown_connection", `${tool.exposedName} is no longer available: its connection was removed.`);
    if (conn.status === "disabled") {
      return deny("connection_disabled", `${conn.name} is turned off in xaq, so its tools can't be used. Nothing was sent. Only the owner can turn it back on.`);
    }
    // Expired (T3: 30 days, no refresh) counts even before the sweep marks it: never a 401 mid-task.
    const label = connectionLabel(conn, settings.publicUrl());
    if (conn.status === "needs_reauth" || label.expired) return deny(label.expired ? "expired" : "needs_reauth", reconnectMessage(label));
    // The registry lists read tools only at this level; a non-read tool here is a bug or a race.
    if (tool.level === "read" && (!tool.cls.read || tool.cls.risky)) {
      return deny("read_only", `You have read-only access to ${conn.name}, and ${tool.exposedName} can change things there. Nothing was sent.`);
    }
    return { kind: "allow" };
  }

  return { decide };
}
