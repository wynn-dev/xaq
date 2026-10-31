// Presets whose server the user names (IntegrationPreset.userServer: T3 Code): the MCP URL's path and the default
// slug, the same in the connections API, the CLI and the console.

/** The URL with the preset's MCP path when only an origin was given (`http://100.104.249.49:3773` → `…:3773/mcp`). */
export function withServerPath(u: URL, defaultPath: string): string {
  if (u.pathname === "/" || u.pathname === "") u.pathname = defaultPath;
  return u.toString();
}

/** A slug part naming a host: an IP's digits with dashes, else its first DNS label (forge.tail1.ts.net → forge). */
export function hostSlugPart(url: string): string {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const part = /^[\d.]+$/.test(host) || host.includes(":") ? host : (host.split(".")[0] ?? host);
  return part.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The default slug for a user-named server: `<preset slug>-<host>`, at most 24 characters (t3-100-104-249-49). */
export function presetServerSlug(presetSlug: string, url: string): string {
  let part: string;
  try {
    part = hostSlugPart(url);
  } catch {
    return presetSlug;
  }
  return `${presetSlug}-${part}`.slice(0, 24).replace(/-+$/, "");
}
