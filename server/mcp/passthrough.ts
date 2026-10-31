// Upstream prompts and resources on /mcp: the prompts and resources
// capabilities, and their five handlers over ctx.broker.passthrough (server/broker/passthrough.ts). Only with the
// broker on and at least one connection grant; the same in direct and search mode (search mode trims only tools/list).
// Each listing is checked against the SDK's own schema, so one odd upstream entry can't break the whole list.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  PromptSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  ResourceSchema,
  ResourceTemplateSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { PassthroughError } from "../broker/passthrough.ts";
import type { AgentBrokerView } from "../broker/service.ts";
import type { AppContext } from "../context.ts";
import type { AgentPrincipal } from "../policy/types.ts";
import { errorMessage } from "../util/errors.ts";

const valid = <T>(schema: z.ZodType, items: T[]): T[] => items.filter((x) => schema.safeParse(x).success);

function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  if (err instanceof PassthroughError) return new McpError(err.code === "unavailable" ? ErrorCode.InternalError : ErrorCode.InvalidParams, err.message);
  return new McpError(ErrorCode.InternalError, `Internal error: ${errorMessage(err)}`);
}

export function registerBrokerPassthrough(ctx: AppContext, server: McpServer, principal: AgentPrincipal, view: AgentBrokerView, opts: { signal?: AbortSignal } = {}): void {
  if (!view.connections.length) return;
  const pass = ctx.broker.passthrough;
  const agentId = principal.agentId;
  const signalOf = (extra: { signal: AbortSignal }) => (opts.signal ? AbortSignal.any([extra.signal, opts.signal]) : extra.signal);
  const s = server.server;
  // Before connect, and before the handlers (the SDK checks the capability when a handler is set).
  s.registerCapabilities({ prompts: {}, resources: {} });

  s.setRequestHandler(ListPromptsRequestSchema, async (_req, extra) => {
    try {
      return { prompts: valid(PromptSchema, await pass.listPrompts(agentId, signalOf(extra))) };
    } catch (err) {
      throw toMcpError(err);
    }
  });

  s.setRequestHandler(GetPromptRequestSchema, async (req, extra) => {
    try {
      const r = await pass.getPrompt(agentId, req.params.name, req.params.arguments ?? {}, signalOf(extra));
      const parsed = GetPromptResultSchema.safeParse(r);
      if (!parsed.success) throw new McpError(ErrorCode.InternalError, "The integration returned a prompt xaq can't pass on (it isn't a valid MCP prompt result)");
      return r as z.infer<typeof GetPromptResultSchema>;
    } catch (err) {
      throw toMcpError(err);
    }
  });

  s.setRequestHandler(ListResourcesRequestSchema, async (_req, extra) => {
    try {
      return { resources: valid(ResourceSchema, await pass.listResources(agentId, signalOf(extra))) };
    } catch (err) {
      throw toMcpError(err);
    }
  });

  s.setRequestHandler(ListResourceTemplatesRequestSchema, async (_req, extra) => {
    try {
      return { resourceTemplates: valid(ResourceTemplateSchema, await pass.listResourceTemplates(agentId, signalOf(extra))) };
    } catch (err) {
      throw toMcpError(err);
    }
  });

  s.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
    try {
      const r = await pass.readResource(agentId, req.params.uri, signalOf(extra));
      const parsed = ReadResourceResultSchema.safeParse(r);
      if (!parsed.success) throw new McpError(ErrorCode.InternalError, "The integration returned a resource xaq can't pass on (it isn't a valid MCP resource result)");
      return r as z.infer<typeof ReadResourceResultSchema>;
    } catch (err) {
      throw toMcpError(err);
    }
  });
}
