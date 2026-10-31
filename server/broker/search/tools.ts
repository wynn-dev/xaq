// Search mode's meta-tools: search_tools, call_read_tool, call_write_tool (docs/MCP-BROKER.md, "One endpoint
// with 100+ tools"). Inner calls run under their real names: native tools through their registered (audited)
// handler, broker tools through BrokerCalls.call, so policy and audit see the real tool.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AuditInput } from "../../audit.ts";
import { cleanLine } from "../../mail/content.ts";
import { safeResult } from "../../mcp/broker.ts";
import { errorMessage } from "../../util/errors.ts";
import type { BrokerCalls, RegisteredTool } from "../types.ts";
import { type SearchableTool, ToolIndex } from "./bm25.ts";

export const META_TOOL_NAMES = ["search_tools", "call_read_tool", "call_write_tool"] as const;
const META: ReadonlySet<string> = new Set(META_TOOL_NAMES);
export const isMetaTool = (name: string): boolean => META.has(name);

/** Audit action of a search: has a "." so the Overview doesn't count it as a tool call (isMcpToolAction). */
export const SEARCH_AUDIT_ACTION = "mcp.search_tools";

export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 10;

/** Appended to the server instructions in search mode: the flow in three lines. */
export const SEARCH_INSTRUCTIONS = `Search mode: most tools aren't listed; find them with search_tools. A tool you already know by name can still be called directly.
- search_tools(query) returns the best-matching tools with their full input schemas, each marked read or write.
- Run a read tool with call_read_tool(name, arguments) and any other with call_write_tool(name, arguments); access and the audit apply exactly as for a direct call.`;

type Extra = { signal: AbortSignal; requestId: RequestId };

const searchInput = {
  query: z.string().min(1).max(500).describe("What you want to do, in plain words."),
  limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional().describe(`How many tools to return. Default ${SEARCH_LIMIT_DEFAULT}, max ${SEARCH_LIMIT_MAX}.`),
};
const callInput = {
  name: z.string().min(1).max(200).describe("The tool's name, exactly as search_tools returned it."),
  arguments: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments, matching its input schema."),
};

/** Argument schemas of the meta-tools (for the rejection audit of calls the SDK refuses). */
export const META_TOOL_SHAPES: Record<(typeof META_TOOL_NAMES)[number], z.ZodRawShape> = {
  search_tools: searchInput,
  call_read_tool: callInput,
  call_write_tool: callInput,
};

/** A native tool captured at registration: its searchable form and the same audited handler a direct call runs. */
export interface NativeEntry {
  tool: SearchableTool;
  shape: z.ZodRawShape;
  run(args: unknown, extra: Extra): Promise<CallToolResult>;
}

export interface SearchDeps {
  agentId: string;
  natives: ReadonlyMap<string, NativeEntry>;
  /** The agent's broker tools (AgentBrokerView.tools: ToolRegistry.forAgent, levels applied). */
  brokerTools: readonly RegisteredTool[];
  calls: BrokerCalls;
  /** Aborted when the HTTP client disconnects. */
  signal?: AbortSignal;
  audit(input: AuditInput): void;
  log: { error(msg: string, meta?: Record<string, unknown>): void };
  /** Marks a tools/call as answered by a handler, so the rejection audit doesn't record it again. */
  handled(requestId: RequestId): void;
}

export const brokerSearchable = (t: RegisteredTool): SearchableTool => ({
  name: t.exposedName,
  title: t.def.title ?? t.def.annotations?.title,
  description: t.def.description,
  inputSchema: t.def.inputSchema,
  read: t.cls.read,
  risky: t.cls.risky,
});

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export function registerSearchTools(server: McpServer, deps: SearchDeps): void {
  let index: ToolIndex | null = null;
  const catalog = () => (index ??= new ToolIndex([...[...deps.natives.values()].map((n) => n.tool), ...deps.brokerTools.map(brokerSearchable)]));

  server.registerTool(
    "search_tools",
    {
      title: "Search tools",
      description:
        "Find the tools for a task: describe what you want to do in plain words (e.g. \"create a page in Notion\", \"unread email from Alice\"). " +
        "Returns the best matches with their full input schemas and whether each is a read or a write tool. Then run one with call_read_tool or call_write_tool.",
      inputSchema: searchInput,
      annotations: { title: "Search tools", ...READ_ONLY },
    },
    async (args: { query: string; limit?: number }, extra: Extra) => {
      deps.handled(extra.requestId);
      const started = Date.now();
      const hits = catalog().search(args.query, args.limit ?? SEARCH_LIMIT_DEFAULT);
      // The query is the agent's words about its task: only its length is kept.
      deps.audit({
        actorType: "agent",
        actorId: deps.agentId,
        action: SEARCH_AUDIT_ACTION,
        outcome: "ok",
        durationMs: Date.now() - started,
        detail: { queryLength: args.query.length, results: hits.length },
      });
      if (!hits.length) return text("No tools match that. Try other words for the task, or the service's name.");
      const tools = hits.map(({ tool: t }) => ({
        name: t.name,
        ...(t.title ? { title: t.title } : {}),
        kind: t.read ? "read" : "write",
        risky: t.risky,
        call_with: t.read ? "call_read_tool" : "call_write_tool",
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return text(JSON.stringify({ tools }, null, 2));
    },
  );

  const dispatch = async (via: "read" | "write", args: { name: string; arguments?: Record<string, unknown> }, extra: Extra): Promise<CallToolResult> => {
    deps.handled(extra.requestId);
    const inner = args.arguments ?? {};
    const record = (action: string, outcome: "denied" | "error", reason: string, detail: Record<string, unknown> | null = null) =>
      deps.audit({ actorType: "agent", actorId: deps.agentId, action, outcome, reason, detail });

    const native = deps.natives.get(args.name);
    const broker = native ? null : (deps.brokerTools.find((t) => t.exposedName === args.name) ?? null);
    const tool = native?.tool ?? (broker ? brokerSearchable(broker) : null);
    if (!tool) {
      record("unknown_tool", "error", "unknown_tool", { tool: cleanLine(args.name).slice(0, 64) });
      return text(`No tool named "${cleanLine(args.name).slice(0, 64)}" is available to you. Find tools with search_tools.`, true);
    }
    if (tool.read !== (via === "read")) {
      record(tool.name, "denied", "wrong_call_tool");
      return text(
        tool.read
          ? `${tool.name} is a read tool: run it with call_read_tool.`
          : `${tool.name} changes something, so it isn't run by call_read_tool: run it with call_write_tool.`,
        true,
      );
    }

    if (native) {
      // The same validation the SDK applies to a direct call, audited like rejectedCall does.
      const parsed = z.object(native.shape).safeParse(inner);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((i) => i.path.map(String).join(".") || "(arguments)"))].slice(0, 10);
        record(tool.name, "error", "invalid_arguments", fields.length ? { fields } : null);
        return text(`Invalid arguments for tool ${tool.name}: check ${fields.join(", ")} against its input schema (search_tools shows it).`, true);
      }
      return native.run(parsed.data, extra);
    }

    // Broker tools: BrokerCalls resolves, decides (levels) and audits under the real name, once.
    // Same handling as a direct call (server/mcp/broker.ts).
    const started = Date.now();
    const signal = deps.signal ? AbortSignal.any([extra.signal, deps.signal]) : extra.signal;
    try {
      return safeResult(await deps.calls.call(deps.agentId, tool.name, inner, signal));
    } catch (err) {
      deps.log.error(`Tool ${tool.name} failed`, { agent: deps.agentId, error: errorMessage(err) });
      deps.audit({ actorType: "agent", actorId: deps.agentId, action: tool.name, outcome: "error", reason: "internal", durationMs: Date.now() - started });
      return text(`Internal error: ${errorMessage(err)}. Retry later; if it persists, tell the operator.`, true);
    }
  };

  server.registerTool(
    "call_read_tool",
    {
      title: "Call a read tool",
      description: "Run a read tool found with search_tools (one marked kind \"read\"). Write tools are refused here: use call_write_tool.",
      inputSchema: callInput,
      annotations: { title: "Call a read tool", ...READ_ONLY },
    },
    (args: { name: string; arguments?: Record<string, unknown> }, extra: Extra) => dispatch("read", args, extra),
  );

  server.registerTool(
    "call_write_tool",
    {
      title: "Call a write tool",
      description:
        "Run a tool that changes something, found with search_tools (kind \"write\"). " +
        "Read tools are refused here: use call_read_tool.",
      inputSchema: callInput,
      annotations: { title: "Call a write tool", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args: { name: string; arguments?: Record<string, unknown> }, extra: Extra) => dispatch("write", args, extra),
  );
}
