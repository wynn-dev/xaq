/**
 * Semver precedence: numeric core, then a pre-release sorts before its release, and pre-release
 * identifiers compare numerically when both are numbers ("nightly.10" > "nightly.9").
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const clean = v.trim().replace(/^v/, "").split("+")[0]!;
    const dash = clean.indexOf("-");
    const core = dash === -1 ? clean : clean.slice(0, dash);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: dash === -1 ? null : clean.slice(dash + 1).split(".") };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre || !y.pre) return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = Number(p) - Number(q);
      if (d) return Math.sign(d);
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}
