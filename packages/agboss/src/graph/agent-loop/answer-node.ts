import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { readAnswer, type AnswerCall } from "../../flow/runtime/answer-tools.js";
import { AgentAnswerInvalidError } from "../../flow/runtime/errors.js";
import { sortedJson } from "../../flow/runtime/json.js";
import type { AsyncNode } from "../types.js";
import { callsOf, isAnswerCall, type AgentLoopDeps, type ToolCallRequest } from "./deps.js";
import { visitAgentAnswer, mergePolicies } from "./judge-points.js";
import { loopUsage, type AgentLoopStateType, type AgentLoopUpdate } from "./state.js";
import { extractRunContext } from "../../core/run-context.js";

/** Invalid answers an agent may give before its step fails (S9: 2 retries, 3 attempts). */
export const MAX_ANSWER_ATTEMPTS = 3;

/** What the model reads when it mixed an answer with other tools, or called two answer tools. */
export const ONE_ANSWER_MESSAGE =
  "Call regular tools first, and call exactly one answer tool when ready to finish — none of this message's tools ran.";

/** One more invalid answer: back to the model with the problem, or the step fails after the last attempt. */
export function invalidAnswer(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  problem: string,
  messages: readonly BaseMessage[],
): AgentLoopUpdate {
  const attempts = state.invalidAnswers + 1;
  if (attempts >= MAX_ANSWER_ATTEMPTS) {
    throw new AgentAnswerInvalidError(deps.agent.name, attempts, problem, loopUsage(state));
  }
  return { messages: [...messages], move: null, invalidAnswers: 1 };
}

const toolMessages = (calls: readonly ToolCallRequest[], content: string): ToolMessage[] =>
  calls.map((call) => new ToolMessage({ tool_call_id: call.callId, content }));

/** The calls of the move as answers, or why they are not a valid way to answer. */
function answerCallsOf(
  deps: AgentLoopDeps,
  calls: readonly ToolCallRequest[],
): readonly AnswerCall[] | undefined {
  const { answerTools } = deps.agent;
  const answers = calls.filter((call) => isAnswerCall(deps.agent, call));
  const several = answerTools.isList && answerTools.hasVariants;
  if (answers.length !== calls.length || (answers.length > 1 && !several)) return undefined;
  return answers.flatMap((call) => {
    const tool = answerTools.tools.find((candidate) => candidate.name === call.tool);
    return tool === undefined ? [] : [{ tool, args: call.args }];
  });
}

/**
 * A move with an answer tool (S6): exactly one answer tool and no regular tool ends the step with
 * the validated value (its class is the tool's); anything else goes back to the model as an invalid
 * answer — none of that message's tools runs.
 */
export function makeAnswerNode(
  deps: AgentLoopDeps,
): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  const agent = deps.agent.name;
  return async (state, config) => {
    const calls = callsOf(state.move);
    const move = state.move === null ? [] : [state.move];
    const answers = answerCallsOf(deps, calls);
    if (answers === undefined) {
      return invalidAnswer(state, deps, ONE_ANSWER_MESSAGE, [
        ...move,
        ...toolMessages(calls, `Tool error: ${ONE_ANSWER_MESSAGE}`),
      ]);
    }
    const reading = readAnswer(deps.agent.answerTools, answers);
    if (reading.kind === "invalid") {
      const content = `Tool error: the answer is invalid — ${reading.problem}`;
      return invalidAnswer(state, deps, reading.problem, [
        ...move,
        ...toolMessages(calls, content),
      ]);
    }
    const reply = sortedJson(reading.answer.value);
    const runCtx = extractRunContext(config, state.runId);
    const ctx = { agent, replyWith: reply, runId: runCtx.runId };
    await visitAgentAnswer(
      mergePolicies(deps.workflowGuardrails, deps.guardrails),
      ctx,
      deps.observer,
    );
    const received = toolMessages(calls, "Answer received.");
    return { messages: [...move, ...received], move: null, reply, answer: reading.answer };
  };
}
