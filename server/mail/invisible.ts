// Invisible and smuggling unicode, removed from everything third parties wrote before an agent reads it: mail bodies
// (content.ts) and text extracted from attachments (the parser child, server/mail/extract/child.ts). No imports, so
// the child's bundle stays small.

// Flagged and stripped: zero-width space/non-joiner/joiner (outside the contexts below), word joiner and
// invisible operators (U+2060–U+2064), BOM (except a leading one), bidi overrides LRO/RLO (U+202D/E),
// tag characters (U+E0000–U+E007F, "ASCII smuggling") and variation selectors that don't follow a base
// character ("emoji smuggling" hides bytes in runs of them).
// Stripped silently: soft hyphens (U+00AD, invisible line-break hints), bidi embeddings LRE/RLE, PDF
// (U+202A–U+202C) and isolates (U+2066–U+2069). These only change visual order, never the logical text an
// agent reads, and are common in legitimate RTL text; unbalanced ones are flagged.
// Kept: LRM/RLM/ALM (never matched); ZWNJ/ZWJ between characters of joining scripts (Persian, Indic, …),
// where they change spelling; ZWJ inside emoji sequences; one variation selector after its base character;
// tag characters forming an emoji flag tag sequence (U+1F3F4 + tag letters/digits + CANCEL TAG).
const JOINING_SCRIPTS = [
  "Arabic", "Syriac", "Nko", "Mongolian", "Thaana", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya",
  "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Myanmar", "Khmer", "Tibetan",
].map((s) => `\\p{Script_Extensions=${s}}`).join("");
const PICTO = "\\p{Extended_Pictographic}";
const VS = "\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}";
const KEEP_FLAG = "\\u{1F3F4}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{2,7}\\u{E007F}";
// Also a ZWJ after a virama at the end of a word (Malayalam chillu forms such as "ന്\u200D").
const KEEP_JOINER = `(?<=[${JOINING_SCRIPTS}])[\\u200C\\u200D](?=[${JOINING_SCRIPTS}])|(?<=[${JOINING_SCRIPTS}])(?<=\\p{M})\\u200D`;
const KEEP_EMOJI_ZWJ = `(?<=${PICTO}(?:\\uFE0F|\\p{Emoji_Modifier})?)\\u200D(?=${PICTO})`;
const KEEP_VS = `(?<=[^${VS}])[\\uFE00-\\uFE0F](?![${VS}])|(?<=\\p{Ideographic})[\\u{E0100}-\\u{E01EF}](?![${VS}])`;
const SILENT = "[\\u00AD\\u202A-\\u202C\\u2066-\\u2069]";
const FLAGGED = `[\\u200B-\\u200D\\u2060-\\u2064\\uFEFF\\u202D\\u202E\\u{E0000}-\\u{E007F}${VS}]`;
const INVISIBLE = new RegExp(`(${KEEP_FLAG})|(${KEEP_JOINER})|(${KEEP_EMOJI_ZWJ})|(${KEEP_VS})|(${SILENT})|${FLAGGED}`, "gu");

const BIDI_OPEN_EMBED = new Set([0x202a, 0x202b]);
const BIDI_OPEN_OVERRIDE = new Set([0x202d, 0x202e]);
const BIDI_OPEN_ISOLATE = new Set([0x2066, 0x2067, 0x2068]);

/**
 * Bidi embeddings/isolates without their matching PDF/PDI (per paragraph): these can reorder what follows.
 * Overrides are always flagged on their own, so they never count here.
 */
function unbalancedBidi(text: string): number {
  if (!/[\u202A-\u202E\u2066-\u2069]/.test(text)) return 0;
  // Linear: the stack is capped at UAX #9's max depth (125), so every pop/scan is O(1); openers beyond it
  // overflow and count as unmatched (no legitimate text nests that deep).
  const MAX_DEPTH = 125;
  let unmatched = 0;
  const stack: ("e" | "o" | "i")[] = [];
  const counted = (from: number) => stack.slice(from).filter((x) => x !== "o").length;
  for (const c of text) {
    const cp = c.codePointAt(0)!;
    const opener = BIDI_OPEN_EMBED.has(cp) ? "e" : BIDI_OPEN_OVERRIDE.has(cp) ? "o" : BIDI_OPEN_ISOLATE.has(cp) ? "i" : null;
    if (opener) {
      if (stack.length < MAX_DEPTH) stack.push(opener);
      else if (opener !== "o") unmatched++;
    } else if (cp === 0x202c) {
      if (stack.at(-1) === "e" || stack.at(-1) === "o") stack.pop();
      else unmatched++;
    } else if (cp === 0x2069) {
      const at = stack.lastIndexOf("i");
      if (at < 0) unmatched++;
      else {
        unmatched += counted(at + 1);
        stack.length = at;
      }
    } else if (c === "\n" || c === "\u2029") {
      unmatched += counted(0);
      stack.length = 0;
    }
  }
  return unmatched + counted(0);
}

/** Removes invisible/smuggling characters. `removed` counts only the ones that can hide or disguise text. */
export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = unbalancedBidi(text);
  const out = text.replace(
    INVISIBLE,
    (m: string, flag?: string, joiner?: string, zwj?: string, vs?: string, silent?: string, offset?: number) => {
      if (flag || joiner || zwj || vs) return m;
      if (!silent && !(m === "\uFEFF" && offset === 0)) removed++;
      return "";
    },
  );
  return { text: out, removed };
}
