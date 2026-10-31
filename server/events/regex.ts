import { RE2JS } from "re2js";

/**
 * Subject filters run synchronously on attacker-controlled subjects during events.emit, so
 * they use RE2 (re2js): matching is linear in the input, with no catastrophic backtracking. RE2
 * syntax is JavaScript's minus lookarounds and backreferences.
 */

export const RE2_SYNTAX_HINT =
  "Subject patterns use RE2 syntax, which runs in linear time: lookarounds ((?=…), (?!…), (?<=…), (?<!…)) and backreferences (\\1) aren't supported.";

/** Compiled patterns by source; null marks a pattern RE2 rejects. Bounded so it can't grow forever. */
const cache = new Map<string, RE2JS | null>();
const CACHE_MAX = 1000;

/** RE2's reason for rejecting the pattern, or null when it compiles. */
export function subjectPatternError(pattern: string): string | null {
  try {
    RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
    return null;
  } catch (err) {
    return (err instanceof Error ? err.message : String(err)).replace(/^error parsing regexp: /, "");
  }
}

/** Case-insensitive search. A pattern RE2 rejects (e.g. stored before this check existed) never matches. */
export function subjectMatches(pattern: string, subject: string): boolean {
  let re = cache.get(pattern);
  if (re === undefined) {
    try {
      re = RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
    } catch {
      re = null;
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(pattern, re);
  }
  return re ? re.matcher(subject).find() : false;
}
