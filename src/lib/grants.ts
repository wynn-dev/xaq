// Relative (not @shared): unit tests load this file under the server config.
import type { Grant, GrantInput } from "../../shared/types.ts";

/** A grant's settings without the account it applies to (the account is the URL/context). */
export type GrantFields = Omit<GrantInput, "accountId">;

export const DEFAULT_GRANT: GrantFields = { level: "read", allowTo: [] };

export const toGrantFields = (g: Grant): GrantFields => ({ level: g.level, allowTo: g.allowTo });

/** The PUT/POST body for a grant on `accountId`. */
export const grantInput = (accountId: string, g: GrantFields): GrantInput => ({ ...g, accountId });

/** Exact address ("bob@example.com") or glob ("*@example.com", "*@*.example.com"). */
export function validateAddressGlob(v: string): string | null {
  if (/\s/.test(v)) return "no spaces allowed";
  const at = v.split("@");
  if (at.length !== 2 || !at[0] || !at[1]) return "use name@domain or *@domain";
  if (!/^[a-z0-9*][a-z0-9.*-]*\.[a-z*]{2,}$/i.test(at[1]) && at[1] !== "*") return "the domain doesn't look right";
  return null;
}

export const sameGrant = (a: GrantFields, b: GrantFields) => a.level === b.level && [...a.allowTo].sort().join() === [...b.allowTo].sort().join();

/** A grant in plain words: "Full access, sends only to 2 recipients" or "Read only". */
export function grantInWords(g: GrantFields): string {
  if (g.level === "read") return "Read only";
  return g.allowTo.length ? `Full access, sends only to ${g.allowTo.length} allowed recipient${g.allowTo.length === 1 ? "" : "s"}` : "Full access";
}
