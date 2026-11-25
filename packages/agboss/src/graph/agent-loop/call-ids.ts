import { AIMessage, type AIMessageChunk } from "@langchain/core/messages";
import type { AgentLoopStateType } from "./state.js";

/** What `withCallIds` reads of the loop's state: the run, the visit and the turn. */
export type CallIdSource = Pick<AgentLoopStateType, "runId" | "flowPath" | "modelCalls">;

/**
 * The move with a unique id on every tool call: results are stored by it and it is the tool's
 * idempotency key, so a call the model gave no id gets one unique within the run (run, visit, turn,
 * position), and an id the provider repeats within the move gets its position (`${id}:${index}`,
 * #335) — the same ids when a recovered step replays the move.
 */
export function withCallIds(response: AIMessageChunk, state: CallIdSource): AIMessage {
  const turn = state.modelCalls + 1;
  const calls = response.tool_calls ?? [];
  const given = calls.map((call) => call.id ?? "");
  const isRepeated = (id: string): boolean => given.indexOf(id) !== given.lastIndexOf(id);
  const toolCalls = calls.map((call, index) => {
    // Stryker disable next-line StringLiteral: equivalent: `given` holds an entry for every call, so the empty text is never read
    const id = given[index] ?? "";
    if (id === "") {
      const position = `${String(state.flowPath.length)}:${String(turn)}:${String(index)}`;
      return { ...call, id: `${state.runId}:${position}` };
    }
    return { ...call, id: isRepeated(id) ? `${id}:${String(index)}` : id };
  });
  // unparsable calls keep their place (#395): each gets an id, the model reads why it did not run
  const invalid = (response.invalid_tool_calls ?? []).map((call, index) => {
    const position = `${String(state.flowPath.length)}:${String(turn)}:invalid:${String(index)}`;
    return {
      ...call,
      id: call.id === undefined || call.id === "" ? `${state.runId}:${position}` : call.id,
    };
  });
  return new AIMessage({
    content: response.content,
    tool_calls: toolCalls,
    invalid_tool_calls: invalid,
  });
}
