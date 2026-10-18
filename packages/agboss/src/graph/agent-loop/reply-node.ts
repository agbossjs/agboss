import { HumanMessage } from "@langchain/core/messages";
import type { AsyncNode } from "../types.js";
import type { AgentLoopDeps } from "./deps.js";
import { visitAgentAnswer, mergePolicies } from "./judge-points.js";
import { invalidAnswer } from "./answer-node.js";
import type { AgentLoopStateType, AgentLoopUpdate } from "./state.js";
import { extractRunContext } from "../../core/run-context.js";

/** What the model reads when it answered with text while it has answer tools (S6). */
export const answerWithToolMessage = (tools: readonly string[]): string =>
  `Answer with one of the answer tools (${tools.join(", ")}), not with text.`;

/**
 * A move without tool calls. A text agent's reply: `beforeAgentAnswer`, then it leaves the loop. An
 * agent with `output` must answer with an answer tool: plain text is an invalid answer (S6, S9).
 */
export function makeReplyNode(deps: AgentLoopDeps): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  const agent = deps.agent.name;
  return async (state, config) => {
    const move = state.move === null ? [] : [state.move];
    const answerTools = deps.agent.answerTools.tools.map((tool) => tool.name);
    if (answerTools.length > 0) {
      const problem = answerWithToolMessage(answerTools);
      return invalidAnswer(state, deps, problem, [...move, new HumanMessage(problem)]);
    }
    const runCtx = extractRunContext(config, state.runId);
    const text = state.move?.text.trim() ?? "";
    const ctx = { agent, replyWith: text, runId: runCtx.runId };
    const guardrails = mergePolicies(deps.workflowGuardrails, deps.guardrails);
    await visitAgentAnswer(guardrails, ctx, deps.observer);
    return { messages: move, move: null, reply: text };
  };
}
