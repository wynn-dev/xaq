// Policy domain contract. Owned by the policy + MCP + mail work area.
// Members marked FROZEN are used by other domains: do not rename or change them. Adding members is fine.

import type { Agent, AgentOrigin, AgentWithKey, CreateAgentInput, EventType, Grant, GrantInput } from "../../shared/types.ts";
import type { Lifecycle } from "../context.ts";

/** An authenticated agent (from its `aib_…` bearer key). */
export interface AgentPrincipal {
  agentId: string;
  name: string;
}

export interface PolicyService extends Lifecycle {
  /** FROZEN. Looks up a key by sha256; null if unknown or the agent is disabled. Updates last_used_at. */
  authenticate(apiKey: string): AgentPrincipal | null;

  /** Records a request to /mcp (`lastMcpAt`, throttled like last_used_at; the first write is immediate). */
  markMcpUse(agentId: string): void;
  /**
   * Pushes the agent's current state to bus "agentState" (the console stream). Calls coalesce per
   * agent: the state is read when the push goes out, on the next macrotask, and pushes are at least
   * `minIntervalMs` apart (later calls in the window are folded into one trailing push).
   */
  publishAgent(agentId: string, minIntervalMs?: number): void;

  listAgents(): Agent[];
  getAgent(id: string): Agent | null;
  /** `origin` defaults to "key" (console); pairing approval passes "paired". Not settable through the API. */
  /**
   * `inheritAllAgents` (default true): the agent also gets every "All agents" connection at its default level.
   * Pairing passes false: there, only the connections the approver saw and chose (input.connections) are granted.
   */
  createAgent(input: CreateAgentInput, opts?: { origin?: AgentOrigin; inheritAllAgents?: boolean }): AgentWithKey;
  updateAgent(id: string, patch: { name?: string; description?: string | null; disabled?: boolean }): Agent;
  rotateKey(id: string): AgentWithKey;
  deleteAgent(id: string): void;
  upsertGrant(agentId: string, accountId: string, input: GrantInput): Grant;
  deleteGrant(agentId: string, accountId: string): void;

  /** FROZEN. */
  grant(agentId: string, accountId: string): Grant | null;
  /** FROZEN. */
  grants(agentId: string): Grant[];
  /**
   * FROZEN. Event visibility for the agent feed and webhooks: the agent needs a grant with `read`
   * on the account, and for message/label events the thread labels must intersect its label scope.
   * calendar.* events need `calendar.read` and the event's calendar in the grant's calendar scope.
   * Account-level events (account.auth_failed, sync.gap) need `read` or `calendar.read`.
   * Connection events (isConnectionEventType: connection.*, `<preset>.*`) need a connection grant on
   * ev.connectionId (any level). approval.requested is for the agent
   * that asked (detail.agentId), and for any webhook subscribed to it (`via: "webhook"`; it carries no arguments).
   */
  canSeeEvent(
    agentId: string,
    ev: {
      accountId: string;
      type: EventType;
      threadLabelIds: string[];
      calendarEvent?: { calendarId: string } | null;
      connectionId?: string | null;
      detail?: Record<string, unknown> | null;
    },
    via?: "feed" | "listener" | "webhook",
  ): boolean;
}
