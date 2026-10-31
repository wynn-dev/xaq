import { chmodSync, existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { AGENT_TOOLS, type AgentTool } from "../../shared/agent-api.ts";
import { type EventType, isEventType } from "../../shared/types.ts";
import { isTooOpen, writePrivateFile } from "./fsutil.ts";
import { profilePath } from "./paths.ts";
import { NPX } from "./version.ts";

/** The listener settings `listen service install` saves (and `listen` uses when given none). */
export interface ListenSettings {
  /** Run through the shell as a fixed string; the event goes to stdin/env/file only. */
  exec?: string;
  types?: EventType[];
  /** Senders to skip (globs). */
  notFrom?: string[];
  /** Don't skip Gmail's Promotions, Social and Forums tabs. */
  allCategories?: boolean;
  includeBody?: boolean;
}

/**
 * The pairing written by `connect` (one per machine) plus the saved listener settings. Holds the agent's
 * API key, so it is always 0600 inside a 0700 directory, and nothing ever prints it.
 */
export interface Profile extends ListenSettings {
  url: string;
  apiKey: string;
  agentId: string;
  agentName: string;
  /** Consumer name for the server-side cursor. */
  consumer: string;
  /** Allow plain http to a non-loopback, non-Tailscale host (loud warning). */
  insecure?: boolean;
  tool?: AgentTool;
  mcpUrl?: string;
  skillUrl?: string;
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
    includeBody: z.boolean().optional(),
    exec: z.string().min(1).optional(),
    notFrom: z.array(z.string().min(1).max(320)).max(50).optional(),
    allCategories: z.boolean().optional(),
    tool: z.enum(AGENT_TOOLS).optional(),
    mcpUrl: z.string().optional(),
    skillUrl: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .loose();

export const profileExists = () => existsSync(profilePath());

export function loadProfile(): Profile {
  const path = profilePath();
  if (!existsSync(path)) throw new Error(`This machine isn't paired yet (${path}). Run \`${NPX} connect <daemon-url>\` first.`);
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
    throw new Error(`${path} is not valid JSON (${(err as Error).message}). Fix it or run \`${NPX} connect\` again.`);
  }
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${path} is invalid: ${issue?.path.join(".") || "file"}: ${issue?.message}`);
  }
  return parsed.data as Profile;
}

export function saveProfile(profile: Profile): string {
  const path = profilePath();
  const clean = Object.fromEntries(Object.entries(profile).filter(([, v]) => v !== undefined));
  writePrivateFile(path, JSON.stringify(clean, null, 2) + "\n");
  return path;
}
