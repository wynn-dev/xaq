// When /mcp serves search mode instead of every tool.

/** Above this many visible tools (native + broker), an agent gets search mode. */
export const SEARCH_MODE_THRESHOLD = 30;

/** The broker's approval-status tool; directly exposed in search mode whenever the agent has broker tools. */
export const CALL_STATUS_TOOL = "get_call_status";

export type ToolMode = "direct" | "search";

export function chooseMode(nativeCount: number, brokerCount: number): ToolMode {
  return nativeCount + brokerCount > SEARCH_MODE_THRESHOLD ? "search" : "direct";
}
