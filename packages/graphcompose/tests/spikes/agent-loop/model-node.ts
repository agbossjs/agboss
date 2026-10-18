import { AIMessage, SystemMessage, type AIMessageChunk } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { LoopStateType, LoopStateUpdate } from "./state.js";
import type { LoopAgent, ToolCallMove } from "./types.js";

export class EmptyMoveError extends Error {
  override name = "EmptyMoveError";
}

/** The tool calls of a move (ids are assigned by the model node when the model gives none). */
export function callsOf(move: AIMessage): readonly ToolCallMove[] {
  return (move.tool_calls ?? []).map((call, index) => ({
    kind: "tool-call",
    callId: call.id ?? `call-${String(index)}`,
    tool: call.name,
    args: call.args,
  }));
}

/**
 * One model call = one node: streams the move (tokens reach `app.stream` through LangGraph's
 * `messages` mode) and stores it as the move under review — not yet part of the conversation.
 */
export function makeModelNode(
  agent: LoopAgent,
): (state: LoopStateType, config: LangGraphRunnableConfig) => Promise<LoopStateUpdate> {
  return async (state, config) => {
    const conversation = [new SystemMessage(agent.systemPrompt), ...state.messages];
    let full: AIMessageChunk | undefined;
    for await (const chunk of await agent.model(state.messages).stream(conversation, config)) {
      full = full === undefined ? chunk : full.concat(chunk);
    }
    if (full === undefined) throw new EmptyMoveError(`${agent.name}: the model returned nothing`);
    const toolCalls = (full.tool_calls ?? []).map((call, index) => ({
      ...call,
      id: call.id ?? `move-${String(state.messages.length)}-${String(index)}`,
    }));
    return { move: new AIMessage({ content: full.content, tool_calls: toolCalls }) };
  };
}
