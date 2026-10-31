import { chmodSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { AGENT_TOOLS, type AgentTool, type ListenerConfig } from "../../shared/agent-api.ts";
import { type EventType, isEventType } from "../../shared/types.ts";
import { webhookFilterSchema } from "../webhooks/filter.ts";
import { isTooOpen, writePrivateFile } from "./fsutil.ts";
import { isServerName, mcpServerName } from "./names.ts";
import { DEFAULT_PROFILE, profilePath, profilesDir, validProfileName } from "./paths.ts";
import { NPX } from "./version.ts";

/**
 * A profile file: the shared ListenerConfig plus a few agent-side extras. Holds the agent's API key,
 * so it is always 0600 inside a 0700 directory, and nothing ever prints it.
 */
export interface Profile extends ListenerConfig {
  tool?: AgentTool;
  mcpUrl?: string;
  skillUrl?: string;
  /** Forward-mode signing secret while no forward URL is saved (see forwardSecret()). */
  forwardSecret?: string;
  /** Working directory for --exec commands (default: a private dir in the state dir). */
  cwd?: string;
  /** Senders / labels to skip (listener-side; `--not-from`, `--not-label`). */
  exclude?: { from?: string[]; labelIds?: string[] };
  /** Gmail category labels to skip; absent = the default (promotions, social, forums), [] = none. */
  skipCategories?: string[];
  /** `--batch`: seconds to collect events into one --exec run. */
  batchSeconds?: number;
  /**
   * The MCP server name (also the Hermes route) registered for this profile: `xaq[-<profile>]`, or the
   * pre-rename `agentinbox[-<profile>]` it was set up with. Filled in on save; see names.ts. (rename-xaq: keep)
   */
  mcpServer?: string;
  createdAt?: string;
}

const profileSchema = z
  .object({
    url: z.string().refine((u) => URL.canParse(u), "url must be a full URL"),
    apiKey: z.string().min(8),
    agentId: z.string().min(1),
    agentName: z.string(),
    consumer: z.string().min(1).max(100),
    insecure: z.boolean().optional(),
    types: z
      .array(z.string().refine(isEventType))
      .transform((t) => t as EventType[])
      .optional(),
    filter: webhookFilterSchema.optional(),
    includeBody: z.boolean().optional(),
    exec: z.string().min(1).optional(),
    forward: z.object({ url: z.string(), secret: z.string().startsWith("whsec_") }).optional(),
    concurrency: z.number().int().min(1).max(32).optional(),
    timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
    maxAttempts: z.number().int().min(1).max(100).optional(),
    tool: z.enum(AGENT_TOOLS).optional(),
    mcpUrl: z.string().optional(),
    skillUrl: z.string().optional(),
    forwardSecret: z.string().startsWith("whsec_").optional(),
    cwd: z.string().startsWith("/").optional(),
    exclude: webhookFilterSchema.pick({ from: true, labelIds: true }).optional(),
    skipCategories: z.array(z.string().regex(/^CATEGORY_[A-Z]+$/)).max(10).optional(),
    batchSeconds: z.number().int().min(1).max(3600).optional(),
    mcpServer: z.string().refine(isServerName, "mcpServer must be a plain name").optional(),
    createdAt: z.string().optional(),
  })
  .loose();

export const profileExists = (name: string) => existsSync(profilePath(validProfileName(name)));

export function listProfiles(): string[] {
  if (!existsSync(profilesDir())) return [];
  return readdirSync(profilesDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function loadProfile(name: string = DEFAULT_PROFILE): Profile {
  const n = validProfileName(name);
  const path = profilePath(n);
  if (!existsSync(path)) {
    const others = listProfiles();
    const hint = others.length ? ` Known profiles: ${others.join(", ")} (pick one with --profile).` : ` Run \`${NPX} connect <daemon-url>\` first.`;
    throw new Error(`No xaq profile "${n}" (${path}).${hint}`);
  }
  // Someone loosened the permissions: tighten them, and say the key may have been read meanwhile.
  if (isTooOpen(path)) {
    chmodSync(path, 0o600);
    process.stderr.write(
      `warning: ${path} was readable by other users; it is 0600 again. If anyone else could have read it, rotate the agent's key in the console and run \`${NPX} connect … --force\`.\n`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Profile ${path} is not valid JSON (${(err as Error).message}). Fix it or run \`${NPX} connect\` again.`);
  }
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Profile ${path} is invalid: ${issue?.path.join(".") || "file"}: ${issue?.message}`);
  }
  return parsed.data as Profile;
}

export function saveProfile(name: string, profile: Profile): string {
  const path = profilePath(validProfileName(name));
  // The server name is pinned on every save: a new profile gets xaq…, one from before the rename (or one
  // replaced by `connect --force`) keeps the name its agent tools and Hermes routes already use.
  const withName: Profile = { ...profile, mcpServer: profile.mcpServer ?? mcpServerName(name) };
  const clean = Object.fromEntries(Object.entries(withName).filter(([, v]) => v !== undefined));
  writePrivateFile(path, JSON.stringify(clean, null, 2) + "\n");
  return path;
}

export function deleteProfile(name: string): void {
  rmSync(profilePath(validProfileName(name)), { force: true });
}
