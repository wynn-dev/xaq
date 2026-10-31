// Feature detection for areas that land in separate PRs, so the E2E suite is green on main today and
// switches scenarios on automatically as each PR merges (use with describe.runIf / it.runIf).
// Placeholders on main carry a "PLACEHOLDER" marker; real implementations don't.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const file = (p: string) => resolve(REPO, p);
const real = (p: string) => existsSync(file(p)) && !readFileSync(file(p), "utf8").includes("PLACEHOLDER");

/** feat/policy-mcp: agents/grants API, MCP endpoint, mail actions, content cleaning. */
export const HAS_AGENTS = ["server/policy/index.ts", "server/mcp/index.ts", "server/mail/index.ts", "server/api/agents.ts"].every(real);

/** feat/listen-server: device-flow pairing and the /agent/v1 event stream (needs policy). */
export const HAS_AGENT_API = HAS_AGENTS && existsSync(file("server/agentapi/index.ts")) && existsSync(file("server/api/pairings.ts"));

/** feat/listen-client: `xaq connect` / `listen` in the CLI (end to end it also needs the server side). */
export const HAS_LISTEN_CLIENT = existsSync(file("server/listen/listen.ts")) && existsSync(file("server/listen/connect.ts"));

export const REPO_ROOT = REPO;

/**
 * E2E_REQUIRE=agents,agent-api,listen-client (CI on main) turns a missing feature into a failure
 * instead of a silently skipped suite. Checked when any E2E file loads.
 */
export const FEATURES = { agents: HAS_AGENTS, "agent-api": HAS_AGENT_API, "listen-client": HAS_LISTEN_CLIENT } as const;

export function missingRequiredFeatures(required = process.env.E2E_REQUIRE ?? ""): string[] {
  const names = required.split(",").map((n) => n.trim()).filter(Boolean);
  const unknown = names.filter((n) => !(n in FEATURES));
  if (unknown.length) throw new Error(`E2E_REQUIRE: unknown feature(s) ${unknown.join(", ")}; known: ${Object.keys(FEATURES).join(", ")}`);
  return names.filter((n) => !FEATURES[n as keyof typeof FEATURES]);
}

const missing = missingRequiredFeatures();
if (missing.length) {
  throw new Error(`E2E_REQUIRE lists ${missing.join(", ")}, but this checkout doesn't have it (test/e2e/features.ts detection). Refusing to skip those suites.`);
}
