// Pure (relative imports only, no React): unit tests load it.

import type { AccessLevel, ConnectionView } from "../../../shared/types.ts";
import type { GrantFields } from "../../lib/grants.ts";

/**
 * A connection's starting level on the pairing card: the card's choices are all a paired agent gets, so only an
 * "All agents" connection starts with access (its default level); every other one starts at No access.
 */
export const pairingConnectionDefault = (c: Pick<ConnectionView, "allAgents" | "levelDefault">): AccessLevel | "none" => (c.allAgents ? c.levelDefault : "none");

/** What a new pairing starts with, regardless of what the agent asked for: read only. */
export const PAIRING_DEFAULT: GrantFields = { level: "read", allowTo: [] };
