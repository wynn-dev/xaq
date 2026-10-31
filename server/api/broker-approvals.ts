// Admin API for mcp.call approvals, "always allow" rules and the connection kill switch (docs/MCP-BROKER.md).
// Mounted before approvalsApi: the /approvals/:id routes answer for mcp.call ids and pass anything else on to the
// mail/calendar handlers. Same admin session and CSRF guard as the rest of /api (server/app.ts).
//
//   GET    /api/approvals/:id                      → McpCallApprovalView (mcp.call; else the mail handler)
//   POST   /api/approvals/:id/approve McpCallApproveInput → Approval
//   POST   /api/approvals/:id/reject {note?}       → Approval
//   GET    /api/approval-rules?agentId&connectionId → ApprovalRule[]
//   DELETE /api/approval-rules/:id                 → 204
//   POST   /api/connections/:id/kill               → 204   (disable, cancel pending, delete credentials, close)

import type { Context, Next } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { brokerPolicyOf } from "../broker/policy/index.ts";
import { mcpCallRow } from "../broker/policy/store.ts";
import { HttpError } from "../util/errors.ts";
import { type AppEnv, readBody, router } from "./util.ts";

const approveSchema = z
  .object({
    note: z.string().max(2000).nullable().optional(),
    alwaysAllow: z
      .object({ target: z.boolean().optional(), targetPath: z.string().startsWith("/").max(512).optional() })
      .strict()
      .optional(),
  })
  .strict();
const rejectSchema = z.object({ note: z.string().max(2000).nullable().optional() });

const off = () => new HttpError(404, "not_found", "No such API route");

export function brokerApprovalsApi(ctx: AppContext) {
  const app = router();
  const runtime = () => brokerPolicyOf(ctx);
  /** The runtime when `:id` is an mcp.call approval; null hands the request to the next handler. */
  const forCall = (c: Context<AppEnv>) => {
    const rt = runtime();
    return rt && mcpCallRow(ctx.db, c.req.param("id") ?? "") ? rt : null;
  };

  app.get("/approvals/:id", async (c, next: Next) => {
    const rt = forCall(c);
    if (!rt) return next();
    return c.json(rt.detail(c.req.param("id")));
  });

  app.post("/approvals/:id/approve", async (c, next: Next) => {
    const rt = forCall(c);
    if (!rt) return next();
    const body = await readBody(c, approveSchema);
    return c.json(await rt.approve(c.req.param("id"), body));
  });

  app.post("/approvals/:id/reject", async (c, next: Next) => {
    const rt = forCall(c);
    if (!rt) return next();
    const { note } = await readBody(c, rejectSchema);
    return c.json(rt.reject(c.req.param("id"), note));
  });

  app.get("/approval-rules", (c) => {
    const rt = runtime();
    if (!rt) throw off();
    return c.json(rt.listRules({ agentId: c.req.query("agentId") || undefined, connectionId: c.req.query("connectionId") || undefined }));
  });

  app.delete("/approval-rules/:id", (c) => {
    const rt = runtime();
    if (!rt) throw off();
    rt.deleteRule(c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/connections/:id/kill", async (c) => {
    const rt = runtime();
    if (!rt) throw off();
    await rt.killConnection(c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
