import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { AgentTestResult } from "../../shared/types.ts";
import type { AppContext } from "../context.ts";
import { buildMcpServer } from "../mcp/server.ts";
import { grantInputSchema } from "../policy/grants.ts";
import { errorMessage, notFound } from "../util/errors.ts";
import { readBody, router } from "./util.ts";

const createSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  grants: z.array(grantInputSchema).optional(),
});

const patchSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  disabled: z.boolean().optional(),
});

/** The path carries the account id; a body accountId is optional. */
const grantSchema = grantInputSchema.extend({ accountId: z.string().optional() });

/** Runs MCP initialize + tools/list as the agent, in-process (no key needed). */
export async function testAgentConnection(ctx: AppContext, agentId: string): Promise<AgentTestResult> {
  const agent = ctx.policy.getAgent(agentId);
  if (!agent) throw notFound("Agent");
  if (agent.disabled) return { ok: false, tools: [], message: "This agent is disabled; enable it to let it connect." };
  const server = buildMcpServer(ctx, { agentId: agent.id, name: agent.name });
  const client = new Client({ name: "xaq-console-test", version: ctx.config.version });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    if (!agent.grants.length) {
      return { ok: false, tools: names, message: "Connected, but this agent has no account access yet. Add a grant to give it tools." };
    }
    const reauth = agent.grants
      .map((g) => ctx.accounts.get(g.accountId))
      .filter((a) => a && a.status === "needs_reauth")
      .map((a) => a!.email);
    if (reauth.length) {
      return { ok: false, tools: names, message: `Connected, but ${reauth.join(", ")} needs to be reconnected before the agent can use it.` };
    }
    return { ok: true, tools: names, message: `Connected as ${agent.name}: ${names.length} tools available.` };
  } catch (err) {
    return { ok: false, tools: [], message: `MCP handshake failed: ${errorMessage(err)}` };
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export function agentsApi(ctx: AppContext) {
  const app = router();
  const { policy } = ctx;

  app.get("/agents", (c) => c.json(policy.listAgents()));

  app.post("/agents", async (c) => {
    const body = await readBody(c, createSchema);
    return c.json(policy.createAgent(body), 201);
  });

  app.get("/agents/:id", (c) => {
    const agent = policy.getAgent(c.req.param("id"));
    if (!agent) throw notFound("Agent");
    return c.json(agent);
  });

  app.patch("/agents/:id", async (c) => {
    const body = await readBody(c, patchSchema);
    return c.json(policy.updateAgent(c.req.param("id"), body));
  });

  app.delete("/agents/:id", (c) => {
    policy.deleteAgent(c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/agents/:id/rotate-key", (c) => c.json(policy.rotateKey(c.req.param("id"))));

  app.put("/agents/:id/grants/:accountId", async (c) => {
    const body = await readBody(c, grantSchema);
    const accountId = c.req.param("accountId");
    return c.json(policy.upsertGrant(c.req.param("id"), accountId, { ...body, accountId: body.accountId ?? accountId }));
  });

  app.delete("/agents/:id/grants/:accountId", (c) => {
    policy.deleteGrant(c.req.param("id"), c.req.param("accountId"));
    return c.body(null, 204);
  });

  app.post("/agents/:id/test", async (c) => c.json(await testAgentConnection(ctx, c.req.param("id"))));

  return app;
}
