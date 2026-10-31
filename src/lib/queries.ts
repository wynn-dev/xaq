import type {
  Account,
  Agent,
  AgentToolMode,
  Approval,
  ApprovalStatus,
  AuditEntry,
  AuditOutcome,
  CalendarInfo,
  CalendarSetupState,
  Delivery,
  DeliveryStatus,
  EventType,
  GmailLabel,
  GoogleClientView,
  MailEvent,
  OverviewStats,
  Page,
  PairingRequest,
  PairingStatus,
  SelfUpdateInfo,
  SetupState,
  SetupStatus,
  Settings,
  SystemInfo,
  UpdateInfo,
  Webhook,
} from "@shared/types";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { apiGet } from "./api";
import type { ApprovalRule, ConnectionGrant, ConnectionView, McpCallApprovalView, PresetView } from "@shared/types";
import { agentConnections } from "../components/connections/connection-flow";
import type { ExtensionRegistryEntryView, ExtensionView } from "@shared/extensions";

export type * from "./broker-dto";

/** Query key roots. The live stream invalidates by root. */
export const keys = {
  setupStatus: ["setup-status"] as const,
  setupState: ["setup-state"] as const,
  system: ["system"] as const,
  systemLatest: ["system-latest"] as const,
  systemUpdate: ["system-update"] as const,
  settings: ["settings"] as const,
  googleClient: ["google-client"] as const,
  accounts: ["accounts"] as const,
  labels: (accountId: string) => ["labels", accountId] as const,
  calendarSetup: ["calendar-setup"] as const,
  accountCalendars: (accountId: string) => ["account-calendars", accountId] as const,
  agents: ["agents"] as const,
  agent: (id: string) => ["agents", id] as const,
  webhooks: ["webhooks"] as const,
  deliveries: ["deliveries"] as const,
  events: ["events"] as const,
  approvals: ["approvals"] as const,
  audit: ["audit"] as const,
  overview: ["overview"] as const,
  pairings: ["pairings"] as const,
  /** Paged history on /events and /audit: kept out of per-message invalidation (the pages merge live rows themselves and can be paused), refetched on mount and after a reconnect. */
  eventHistory: ["event-history"] as const,
  auditLog: ["audit-log"] as const,
  // MCP broker.
  connections: ["connections"] as const,
  connection: (id: string) => ["connections", id] as const,
  presets: ["connection-presets"] as const,
  agentConnections: (agentId: string) => ["agent-connections", agentId] as const,
  approvalRules: ["approval-rules"] as const,
  // Extensions.
  extensions: ["extensions"] as const,
  extensionRegistry: ["extension-registry"] as const,
};

export interface EventFilters {
  accountId?: string;
  type?: EventType;
}

export interface AuditFilters {
  agentId?: string;
  outcome?: AuditOutcome;
}

export const queries = {
  setupStatus: () =>
    queryOptions({ queryKey: keys.setupStatus, queryFn: () => apiGet<SetupStatus>("/api/setup/status"), staleTime: 0 }),
  setupState: () => queryOptions({ queryKey: keys.setupState, queryFn: () => apiGet<SetupState>("/api/setup/state") }),
  system: () => queryOptions({ queryKey: keys.system, queryFn: () => apiGet<SystemInfo>("/api/system"), refetchInterval: 30_000 }),
  systemLatest: () =>
    queryOptions({
      queryKey: keys.systemLatest,
      queryFn: () => apiGet<UpdateInfo>("/api/system/latest"),
      staleTime: 30 * 60_000,
      retry: false,
    }),
  systemUpdate: () => queryOptions({ queryKey: keys.systemUpdate, queryFn: () => apiGet<SelfUpdateInfo>("/api/system/update") }),
  settings: () => queryOptions({ queryKey: keys.settings, queryFn: () => apiGet<Settings>("/api/settings") }),
  googleClient: () => queryOptions({ queryKey: keys.googleClient, queryFn: () => apiGet<GoogleClientView>("/api/google/client") }),
  accounts: () => queryOptions({ queryKey: keys.accounts, queryFn: () => apiGet<Account[]>("/api/accounts") }),
  labels: (accountId: string) =>
    queryOptions({
      queryKey: keys.labels(accountId),
      queryFn: () => apiGet<GmailLabel[]>(`/api/accounts/${encodeURIComponent(accountId)}/labels`),
      staleTime: 5 * 60_000,
    }),
  /** The install's "Add Google Calendar" state (API, scopes, per-account status). */
  calendarSetup: () => queryOptions({ queryKey: keys.calendarSetup, queryFn: () => apiGet<CalendarSetupState>("/api/google/calendar") }),
  /**
   * The account's calendar list (live from Google), for the grant editor's calendar scope. Fails with 409
   * calendar_not_granted / calendar_api_disabled / needs_reauth while the account can't read it: no retry.
   */
  accountCalendars: (accountId: string) =>
    queryOptions({
      queryKey: keys.accountCalendars(accountId),
      queryFn: () => apiGet<CalendarInfo[]>(`/api/accounts/${encodeURIComponent(accountId)}/calendars`),
      staleTime: 5 * 60_000,
      retry: false,
    }),
  agents: () => queryOptions({ queryKey: keys.agents, queryFn: () => apiGet<Agent[]>("/api/agents") }),
  agent: (id: string) => queryOptions({ queryKey: keys.agent(id), queryFn: () => apiGet<Agent>(`/api/agents/${encodeURIComponent(id)}`) }),
  /** How /mcp lists the agent's tools (full list or search). Under the agent's key, so grant changes refresh it. */
  agentToolMode: (id: string) =>
    queryOptions({ queryKey: [...keys.agent(id), "tool-mode"], queryFn: () => apiGet<AgentToolMode>(`/api/agents/${encodeURIComponent(id)}/tool-mode`) }),
  webhooks: (agentId?: string) =>
    queryOptions({
      queryKey: [...keys.webhooks, { agentId: agentId ?? null }],
      queryFn: () => apiGet<Webhook[]>("/api/webhooks", { agentId }),
    }),
  approvals: (status?: ApprovalStatus) =>
    queryOptions({
      queryKey: [...keys.approvals, status ?? "all"],
      queryFn: () => apiGet<Approval[]>("/api/approvals", { status }),
      refetchInterval: 60_000,
    }),
  pairings: (status?: PairingStatus) =>
    queryOptions({
      queryKey: [...keys.pairings, status ?? "all"],
      queryFn: () => apiGet<PairingRequest[]>("/api/pairings", { status }),
      refetchInterval: 30_000,
    }),
  overview: () => queryOptions({ queryKey: keys.overview, queryFn: () => apiGet<OverviewStats>("/api/overview"), refetchInterval: 60_000 }),
  /** Newest events (first page only), for the overview. */
  recentEvents: () =>
    queryOptions({ queryKey: [...keys.events, "recent"], queryFn: () => apiGet<Page<MailEvent>>("/api/events") }),
  /** Older events, page by page. Refetched whenever the page mounts and after a stream reconnect. */
  eventHistory: (f: EventFilters) =>
    infiniteQueryOptions({
      queryKey: [...keys.eventHistory, f],
      queryFn: ({ pageParam }) => apiGet<Page<MailEvent>>("/api/events", { ...f, cursor: pageParam }),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
      staleTime: Infinity,
      refetchOnMount: "always",
    }),
  deliveries: (webhookId: string, status?: DeliveryStatus) =>
    infiniteQueryOptions({
      queryKey: [...keys.deliveries, webhookId, status ?? "all"],
      queryFn: ({ pageParam }) => apiGet<Page<Delivery>>("/api/deliveries", { webhookId, status, cursor: pageParam }),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
    }),
  /** Audit pages. Refetched whenever the page mounts and after a stream reconnect; new entries are announced live. */
  audit: (f: AuditFilters) =>
    infiniteQueryOptions({
      queryKey: [...keys.auditLog, f],
      queryFn: ({ pageParam }) => apiGet<Page<AuditEntry>>("/api/audit", { ...f, cursor: pageParam }),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextCursor,
      staleTime: Infinity,
      refetchOnMount: "always",
    }),
  /** Upstream connections (broker). */
  connections: () => queryOptions({ queryKey: keys.connections, queryFn: () => apiGet<ConnectionView[]>("/api/connections"), refetchInterval: 60_000 }),
  connection: (id: string) =>
    queryOptions({ queryKey: keys.connection(id), queryFn: () => apiGet<ConnectionView>(`/api/connections/${encodeURIComponent(id)}`) }),
  presets: () => queryOptions({ queryKey: keys.presets, queryFn: () => apiGet<PresetView[]>("/api/connections/presets"), staleTime: 10 * 60_000 }),
  connectionGrants: (connectionId: string) =>
    queryOptions({
      queryKey: [...keys.connection(connectionId), "grants"],
      queryFn: () => apiGet<ConnectionGrant[]>(`/api/connections/${encodeURIComponent(connectionId)}/grants`),
    }),
  /** One agent's level on every connection (adapter: the API keeps grants per connection). */
  agentConnections: (agentId: string) =>
    queryOptions({
      queryKey: keys.agentConnections(agentId),
      queryFn: async () => {
        const list = await apiGet<ConnectionView[]>("/api/connections");
        const grants = await Promise.all(list.map((c) => apiGet<ConnectionGrant[]>(`/api/connections/${encodeURIComponent(c.id)}/grants`)));
        return agentConnections(agentId, list, Object.fromEntries(list.map((c, i) => [c.id, grants[i]!])));
      },
    }),
  approvalRules: (agentId: string) =>
    queryOptions({ queryKey: [...keys.approvalRules, agentId], queryFn: () => apiGet<ApprovalRule[]>("/api/approval-rules", { agentId }) }),
  /** One approval: an mcp.call answers with its card (McpCallApprovalView), mail and calendar kinds with the Approval. */
  approval: (id: string) =>
    queryOptions({
      queryKey: [...keys.approvals, "one", id],
      queryFn: () => apiGet<McpCallApprovalView | Approval>(`/api/approvals/${encodeURIComponent(id)}`),
      retry: false,
    }),
  /** Installed extensions, with the connections using each. */
  extensions: () => queryOptions({ queryKey: keys.extensions, queryFn: () => apiGet<ExtensionView[]>("/api/extensions") }),
  /** The official registry (index.json), fetched by the daemon. */
  extensionRegistry: () =>
    queryOptions({ queryKey: keys.extensionRegistry, queryFn: () => apiGet<ExtensionRegistryEntryView[]>("/api/extensions/registry"), staleTime: 5 * 60_000, retry: false }),
  /** First audit page only, for an agent's detail page. */
  recentAudit: (agentId: string) =>
    queryOptions({
      queryKey: [...keys.audit, "agent", agentId],
      queryFn: () => apiGet<Page<AuditEntry>>("/api/audit", { agentId }),
    }),
};
