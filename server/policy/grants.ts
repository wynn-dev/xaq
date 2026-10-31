import { z } from "zod";
import { ACCESS_LEVELS, type Grant, type GrantInput } from "../../shared/types.ts";
import { json } from "../db/index.ts";
import { badRequest } from "../util/errors.ts";

/** Address glob: exactly one "@" with a non-empty local part and domain; "*" wildcards allowed. */
const ADDRESS_GLOB = /^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+$/;

export const grantInputSchema = z.object({
  accountId: z.string().min(1),
  level: z.enum(ACCESS_LEVELS),
  allowTo: z
    .array(
      z
        .string()
        .trim()
        .transform((g) => g.replace(/[A-Z]/g, (c) => c.toLowerCase()))
        .pipe(z.string().regex(ADDRESS_GLOB, 'Recipient rules must look like "alice@example.com", "*@example.com" or "billing@*"')),
    )
    .max(200)
    .transform((globs) => [...new Set(globs)])
    .default([]),
});

/** Validates and normalizes a grant. Throws HttpError(400). */
export function parseGrantInput(input: unknown): GrantInput {
  const r = grantInputSchema.safeParse(input);
  if (!r.success) throw badRequest(`Invalid grant: ${z.prettifyError(r.error)}`);
  return r.data;
}

export interface GrantRow {
  id: string;
  agent_id: string;
  account_id: string;
  level: Grant["level"];
  allow_to: string;
  created_at: string;
}

export const toGrant = (r: GrantRow): Grant => ({
  id: r.id,
  agentId: r.agent_id,
  accountId: r.account_id,
  level: r.level === "full" ? "full" : "read",
  allowTo: json.parse(r.allow_to, []),
  createdAt: r.created_at,
});
