import { useQuery } from "@tanstack/react-query";
import { KeyRoundIcon, ShieldAlertIcon } from "lucide-react";
import { CodeBlock, ExternalLink } from "@/components/common";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NPX, shellQuote, transportOf } from "@/lib/cli";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { queries } from "@/lib/queries";

export const KEY_PLACEHOLDER = "<your-xaq-key>";

export function snippets(publicUrl: string, key: string) {
  const mcp = `${publicUrl}/mcp`;
  return {
    claude: `claude mcp add --transport http --scope user xaq ${shellQuote(mcp)} \\\n  --header "Authorization: Bearer ${key}"`,
    codexToml: `[mcp_servers.xaq]\nurl = ${JSON.stringify(mcp)}\nbearer_token_env_var = "XAQ_API_KEY"`,
    codexEnv: `export XAQ_API_KEY="${key}"`,
    cursor: JSON.stringify({ mcpServers: { xaq: { url: mcp, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
    generic: JSON.stringify(
      { mcpServers: { xaq: { type: "http", url: mcp, headers: { Authorization: `Bearer ${key}` } } } },
      null,
      2,
    ),
    hermes: `mcp_servers:\n  xaq:\n    url: ${JSON.stringify(mcp)}\n    headers:\n      Authorization: "Bearer ${key}"`,
    skill: `${NPX} skill install --url ${shellQuote(publicUrl)}`,
    mcpUrl: mcp,
    skillUrl: `${publicUrl}/skill.md`,
  };
}

/**
 * Copy-paste setup for common MCP clients. Uses the real key when this tab still has it
 * (right after creation/rotation), otherwise a placeholder.
 */
export function ConnectSnippets({ apiKey }: { apiKey?: string }) {
  const settings = useQuery(queries.settings());
  const publicUrl = settings.data?.publicUrl ?? window.location.origin;
  const s = snippets(publicUrl, apiKey ?? KEY_PLACEHOLDER);

  return (
    <div className="space-y-3">
      {transportOf(publicUrl) === "insecure" && (
        <Alert variant="destructive">
          <ShieldAlertIcon />
          <AlertTitle>{new URL(publicUrl).host} is plain http</AlertTitle>
          <AlertDescription>
            With these settings the agent's key and every email it reads cross the network unencrypted. Use https or Tailscale for the public URL
            (Settings) before connecting agents on other machines.
          </AlertDescription>
        </Alert>
      )}
      {!apiKey && (
        <p className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <KeyRoundIcon className="mt-px size-3.5 shrink-0" />
          <span>
            Replace <code className="font-mono text-foreground">{KEY_PLACEHOLDER}</code> with the agent's API key. Keys are only shown once; if
            you've lost it, rotate the key to get a new one.
          </span>
        </p>
      )}
      <Tabs defaultValue="claude">
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList>
            <TabsTrigger value="claude">Claude Code</TabsTrigger>
            <TabsTrigger value="codex">Codex</TabsTrigger>
            <TabsTrigger value="cursor">Cursor</TabsTrigger>
            <TabsTrigger value="hermes">Hermes</TabsTrigger>
            <TabsTrigger value="generic">Other MCP</TabsTrigger>
            <TabsTrigger value="skill">Skill</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="claude" className="space-y-2">
          <p className="text-sm text-muted-foreground">Run in a terminal on the machine where Claude Code runs:</p>
          <CodeBlock code={s.claude} wrap />
        </TabsContent>
        <TabsContent value="codex" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Add to <code className="font-mono text-foreground">~/.codex/config.toml</code>:
          </p>
          <CodeBlock code={s.codexToml} title="~/.codex/config.toml" />
          <p className="text-sm text-muted-foreground">Then set the key in your shell profile (Codex reads it from the environment):</p>
          <CodeBlock code={s.codexEnv} title="~/.zshrc or ~/.bashrc" />
        </TabsContent>
        <TabsContent value="cursor" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Add to <code className="font-mono text-foreground">~/.cursor/mcp.json</code> (or the project's{" "}
            <code className="font-mono text-foreground">.cursor/mcp.json</code>):
          </p>
          <CodeBlock code={s.cursor} title="~/.cursor/mcp.json" />
        </TabsContent>
        <TabsContent value="hermes" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Add to <code className="font-mono text-foreground">~/.hermes/config.yaml</code>, then restart Hermes:
          </p>
          <CodeBlock code={s.hermes} title="~/.hermes/config.yaml" />
        </TabsContent>
        <TabsContent value="generic" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Any MCP client with Streamable HTTP support: server URL <code className="font-mono text-foreground">{s.mcpUrl}</code> with a bearer token.
          </p>
          <CodeBlock code={s.generic} title="mcp.json" />
        </TabsContent>
        <TabsContent value="skill" className="space-y-2">
          <p className="text-sm text-muted-foreground">
            The xaq skill teaches agents how to use the tools well: triage, replying in threads and treating email
            content as untrusted data. Install it next to your agent:
          </p>
          <CodeBlock code={s.skill} wrap />
          <p className="text-sm text-muted-foreground">
            Or read it first: <ExternalLink href={s.skillUrl}>{s.skillUrl}</ExternalLink>
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}
