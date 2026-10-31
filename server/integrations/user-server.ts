// Presets whose server the user names (IntegrationPreset.userServer: T3 Code): the MCP URL as the connections API and
// the CLI take it. The path and slug rules are shared with the console (shared/user-server.ts).

import { withServerPath } from "../../shared/user-server.ts";
import { validateUpstreamUrl } from "../broker/upstream/fetch.ts";

/**
 * The MCP URL for a user-named server: the URL as given, with the preset's MCP path when only an origin was given.
 * Throws SourceError on a URL the upstream guard would refuse outright (not http(s), userinfo).
 */
export function presetServerUrl(raw: string, defaultPath: string): string {
  return withServerPath(validateUpstreamUrl(raw.trim()), defaultPath);
}
