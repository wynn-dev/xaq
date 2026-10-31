import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { router } from "../api/util.ts";
import type { AppContext } from "../context.ts";
import { buildMcpServer } from "./server.ts";

/**
 * Largest /mcp body from a valid agent key: room for Gmail's 25 MB of attachments, base64-encoded in the
 * tool call (25 MB × 4/3 ≈ 33.4 MB), plus the message. server/app.ts keeps everyone else at 4 MB, checking
 * the key from the header before any body is read.
 */
export const MCP_AGENT_BODY_LIMIT = 36 * 1024 * 1024;

const bearer = (header: string | undefined): string | null => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return m ? m[1]! : null;
};

/** Streamable HTTP MCP endpoint (stateless: one server + transport per request). Mounted at the root; server/app.ts limits the body size. */
export function mcpRoutes(ctx: AppContext) {
  const app = router();

  app.all("/mcp", async (c) => {
    const key = bearer(c.req.header("authorization"));
    const principal = key ? ctx.policy.authenticate(key) : null;
    if (!principal) {
      c.header("WWW-Authenticate", 'Bearer realm="xaq"');
      return c.json(
        {
          error: {
            code: "unauthorized",
            message: key ? "Invalid or disabled agent API key." : "Missing agent API key.",
            hint: "Send the agent's key as `Authorization: Bearer aib_…`. Keys are created in the xaq console under Agents.",
          },
        },
        401,
      );
    }
    c.set("agent", principal);
    // Apart from lastUsedAt (also set by `listen`): proves the agent's tool reaches /mcp, even a bare tools/list.
    ctx.policy.markMcpUse(principal.agentId);

    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless; use POST." }, id: null }, 405);
    }

    const server = buildMcpServer(ctx, principal, { signal: c.req.raw.signal });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // The SDK's own cap (4 MiB by default); the app's body limit has already applied the smaller one to unauthenticated callers.
      maxRequestBodySize: MCP_AGENT_BODY_LIMIT,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });

  return app;
}
