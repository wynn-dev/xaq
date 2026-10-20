// The smoke run's agent side: an MCP client on the daemon's /mcp with the temporary agent's key, exactly as Hermes
// connects (the SDK client over Streamable HTTP, `Authorization: Bearer <key>`). The key lives in this object only.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** One tool call's answer, as the run reads it. */
export interface CallOutcome {
  isError: boolean;
  /** Every text block joined, the broker's untrusted-output wrapper removed. Never printed. */
  text: string;
  structured: Record<string, unknown> | null;
  /** The raw content blocks (get_attachment: text, image or resource). */
  content: { type: string; text?: string; data?: string; mimeType?: string; resource?: { blob?: string; text?: string; mimeType?: string } }[];
}

export interface AgentMcp {
  listTools(): Promise<string[]>;
  call(name: string, args: Record<string, unknown>): Promise<CallOutcome>;
  close(): Promise<void>;
}

/** The broker wraps upstream text as `<tool_output source=… nonce=… untrusted>…</tool_output>`; the run wants the inside. */
export function unwrapToolOutput(text: string): string {
  return text.replace(/<tool_output [^>]*>\n?/g, "").replace(/\n?<\/tool_output>/g, "");
}

export function toOutcome(raw: { isError?: unknown; content?: unknown; structuredContent?: unknown }): CallOutcome {
  const content = (Array.isArray(raw.content) ? raw.content : []) as CallOutcome["content"];
  const text = unwrapToolOutput(
    content
      .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
      .filter(Boolean)
      .join("\n"),
  );
  const s = raw.structuredContent;
  return { isError: raw.isError === true, text, structured: s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : null, content };
}

export async function connectAgentMcp(baseUrl: string, apiKey: string, opts: { fetch?: typeof fetch; version?: string } = {}): Promise<AgentMcp> {
  const client = new Client({ name: "xaq-smoke", version: opts.version ?? "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    }),
  );
  return {
    async listTools() {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        names.push(...page.tools.map((t) => t.name));
        cursor = page.nextCursor;
      } while (cursor);
      return names;
    },
    async call(name, args) {
      return toOutcome((await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })) as Parameters<typeof toOutcome>[0]);
    },
    close: () => client.close(),
  };
}
