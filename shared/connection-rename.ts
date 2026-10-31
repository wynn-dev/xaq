// Changing a connection's short name (slug): PATCH /api/connections/:id {slug}, from the console's "Change short
// name".

const SLUG_RE = /^[a-z0-9-]{1,24}$/;

/** What changing a slug breaks: agents' calls by the old tool names. */
export const renameWarning = (from: string, to: string) =>
  `Agents see its tools as ${to}__<tool> from now on: anything that calls ${from}__<tool> (prompts, skills, scripts, saved tool lists) stops working until it uses the new names.`;

/** Why `next` can't be this connection's new slug, or null. `all`: every connection (this one included). */
export function slugProblem(next: string, current: { id: string; slug: string }, all: { id: string; slug: string; name: string }[]): string | null {
  if (next === current.slug) return "That's its short name already.";
  if (!SLUG_RE.test(next)) return "Use 1-24 lowercase letters, digits and dashes.";
  const clash = all.find((c) => c.slug === next && c.id !== current.id);
  if (clash) return `There's already a connection "${next}" (${clash.name}).`;
  return null;
}
