import { HumanMessage } from "@langchain/core/messages";
import type { AsyncNode } from "../types.js";
import type { AgentLoopDeps } from "./deps.js";
import { invalidAnswer } from "./answer-node.js";
import type { AgentLoopStateType, AgentLoopUpdate } from "./state.js";

/** What the model reads when it answered with text while it has answer tools (S6). */
export const answerWithToolMessage = (tools: readonly string[]): string =>
  `Answer with one of the answer tools (${tools.join(", ")}), not with text.`;

/**
 * A move without tool calls. A text agent's reply leaves the loop. An agent with `output` must
 * answer with an answer tool: plain text is an invalid answer (S6, S9).
 */
export function makeReplyNode(deps: AgentLoopDeps): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  return (state) => {
    const move = state.move === null ? [] : [state.move];
    const answerTools = deps.agent.answerTools.tools.map((tool) => tool.name);
    if (answerTools.length > 0) {
      const problem = answerWithToolMessage(answerTools);
      return Promise.resolve(
        invalidAnswer(state, deps, problem, [...move, new HumanMessage(problem)]),
      );
    }
    const text = state.move?.text.trim() ?? "";
    return Promise.resolve({ messages: move, move: null, reply: text });
  };
}
