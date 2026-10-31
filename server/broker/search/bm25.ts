// BM25 over tool definitions (docs/MCP-BROKER.md, "One endpoint with 100+ tools"). Pure and deterministic:
// no I/O, ties broken by name. Built per /mcp request (stateless), which is cheap for a few hundred tools.

/** A tool as search mode sees it, native or broker. */
export interface SearchableTool {
  /** The exposed name (`list_accounts`, `notion__search`). */
  name: string;
  title?: string;
  description: string;
  /** Full JSON Schema of the arguments, returned with each hit. */
  inputSchema: Record<string, unknown>;
  /** Run through call_read_tool (true) or call_write_tool (false). */
  read: boolean;
  /** Irreversible (send, delete, …). */
  risky: boolean;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by can could do does for from had has have how i if in into is it its " +
    "me my of on or our please should so some than that the their them then there these this those to too up us " +
    "was we were what when where which who will with would you your all any just about via also one"
  ).split(" "),
);

/**
 * Light suffix stripping so "meetings", "scheduled" and "scheduling" meet "meeting" and "schedule". Not Porter:
 * the same rules run on documents and queries, which is all BM25 needs.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Words of a name or text: camelCase, `_`, `__`, `-`, `.` and punctuation split; lowercased, stopwords dropped, stemmed. */
export function tokenize(text: string): string[] {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const out: string[] = [];
  for (const raw of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** Argument names and descriptions, two levels deep (objects and arrays of objects). */
export function schemaText(schema: unknown, depth = 0): string[] {
  if (!schema || typeof schema !== "object" || depth > 2) return [];
  const s = schema as { properties?: Record<string, unknown>; items?: unknown };
  const out: string[] = [];
  for (const [key, prop] of Object.entries(s.properties ?? {})) {
    out.push(key);
    const p = prop as { description?: unknown; title?: unknown; enum?: unknown };
    if (typeof p?.description === "string") out.push(p.description);
    if (typeof p?.title === "string") out.push(p.title);
    if (Array.isArray(p?.enum)) out.push(p.enum.filter((x) => typeof x === "string").join(" "));
    out.push(...schemaText(prop, depth + 1));
  }
  if (s.items) out.push(...schemaText(s.items, depth + 1));
  return out;
}

/**
 * Query expansion: everyday task words → the verbs and nouns tool names use. Generic on purpose (no service
 * names); expansions count half as much as the words the agent wrote.
 */
const SYNONYMS: Record<string, string[]> = {
  find: ["search", "list"],
  look: ["search", "get"],
  lookup: ["search", "get"],
  open: ["get", "read", "fetch"],
  show: ["get", "list"],
  see: ["get", "list"],
  check: ["get", "list"],
  read: ["get", "fetch"],
  view: ["get", "fetch"],
  add: ["create"],
  new: ["create"],
  make: ["create"],
  file: ["create"],
  start: ["create"],
  write: ["create", "update"],
  change: ["update", "set"],
  edit: ["update"],
  mark: ["update", "set"],
  set: ["update"],
  remove: ["delete"],
  trash: ["delete"],
  erase: ["delete"],
  send: ["post"],
  tell: ["post", "send"],
  bug: ["issue"],
  ticket: ["issue"],
  task: ["issue"],
  pr: ["pull", "request"],
  sprint: ["cycle"],
  doc: ["document"],
  sheet: ["spreadsheet"],
  deck: ["presentation", "slide"],
  people: ["user", "member"],
  email: ["mail", "message"],
};
const EXPANSIONS = new Map(Object.entries(SYNONYMS).map(([k, v]) => [stem(k), v.map(stem)] as const));
const EXPANSION_WEIGHT = 0.5;

/** The query's terms with their weights: its own words at 1, their expansions at EXPANSION_WEIGHT. */
export function queryTerms(query: string): Map<string, number> {
  const terms = new Map<string, number>();
  const own = tokenize(query);
  for (const t of own) terms.set(t, 1);
  for (const t of own) for (const x of EXPANSIONS.get(t) ?? []) if (!terms.has(x)) terms.set(x, EXPANSION_WEIGHT);
  return terms;
}

// Field weights: the name says most about a tool, then its title, then the description and arguments.
const NAME_WEIGHT = 3;
const TITLE_WEIGHT = 2;
const K1 = 1.2;
const B = 0.75;

interface Doc {
  tool: SearchableTool;
  tf: Map<string, number>;
  len: number;
}

export interface SearchHit {
  tool: SearchableTool;
  score: number;
}

export class ToolIndex {
  private readonly docs: Doc[];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(tools: readonly SearchableTool[]) {
    this.docs = tools.map((tool) => {
      const tf = new Map<string, number>();
      const add = (tokens: string[], weight: number) => {
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + weight);
      };
      add(tokenize(tool.name), NAME_WEIGHT);
      if (tool.title) add(tokenize(tool.title), TITLE_WEIGHT);
      add(tokenize(tool.description), 1);
      add(tokenize(schemaText(tool.inputSchema).join(" ")), 1);
      let len = 0;
      for (const n of tf.values()) len += n;
      return { tool, tf, len };
    });
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.docs.length ? this.docs.reduce((a, d) => a + d.len, 0) / this.docs.length : 1;
  }

  get size(): number {
    return this.docs.length;
  }

  /** The top `limit` tools for `query`, best first; tools that share no word with it are left out. */
  search(query: string, limit: number): SearchHit[] {
    const terms = queryTerms(query);
    if (!terms.size) return [];
    const n = this.docs.length;
    const hits: SearchHit[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const [t, w] of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (w * idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / this.avgLen));
      }
      if (score > 0) hits.push({ tool: d.tool, score });
    }
    hits.sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0));
    return hits.slice(0, limit);
  }
}
