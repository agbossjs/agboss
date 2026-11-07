/**
 * The custom LangChain event an agent's loop dispatches as a tool call starts (#848): its loop
 * (ADR-0015) calls a tool itself, so no LangChain tool callback fires; the run's streaming handler
 * turns it into `{ kind: "toolCall", tool }`. Its data: `{ tool }`, the tool's name only.
 */
export const TOOL_CALL_EVENT = "agboss/tool-call";
