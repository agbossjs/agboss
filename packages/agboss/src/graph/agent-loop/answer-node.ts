import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { invalidArgumentsMessage } from "../../prompts/agents.js";
import { readAnswer, type AnswerCall } from "../../flow/runtime/answer-tools.js";
import { AgentAnswerInvalidError } from "../../flow/runtime/errors.js";
import { sortedJson } from "../../flow/runtime/json.js";
import type { AsyncNode } from "../types.js";
import {
  callsOf,
  invalidCallsOf,
  isAnswerCall,
  type AgentLoopDeps,
  type InvalidToolCallRequest,
  type ToolCallRequest,
} from "./deps.js";
import { loopUsage, type AgentLoopStateType, type AgentLoopUpdate } from "./state.js";

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

/** The move's answers, or why they are not a valid way to answer (the step's error if it is the last). */
type AnswerCalls =
  | { readonly kind: "answers"; readonly answers: readonly AnswerCall[] }
  | { readonly kind: "refused"; readonly problem: string };

/**
 * The move's answer calls with a call that repeats an earlier one — the same answer tool, the same
 * arguments — left out (#649): a model that answers twice the same way has given one answer.
 */
const withoutRepeats = (answers: readonly ToolCallRequest[]): readonly ToolCallRequest[] => {
  const seen = new Set<string>();
  return answers.filter((call) => {
    const key = `${call.tool}\u0000${sortedJson(call.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * The calls of the move as answers (S6): answer tools only; one answer, unless the output is a list
 * of variants (several answer tools, their items joined). Several different answers to an agent that
 * answers once are refused, never one of them picked (#649).
 */
function answerCallsOf(deps: AgentLoopDeps, calls: readonly ToolCallRequest[]): AnswerCalls {
  const { answerTools } = deps.agent;
  const answers = calls.filter((call) => isAnswerCall(deps.agent, call));
  if (answers.length !== calls.length) return { kind: "refused", problem: ONE_ANSWER_MESSAGE };
  const several = answerTools.isList && answerTools.hasVariants;
  const taken = several ? answers : withoutRepeats(answers);
  if (taken.length > 1) {
    const tools = [...new Set(taken.map((call) => call.tool))].join(", ");
    const problem = `${String(taken.length)} different answers in one move (${tools}): the agent answers once`;
    return { kind: "refused", problem };
  }
  return {
    kind: "answers",
    answers: taken.flatMap((call) => {
      const tool = answerTools.tools.find((candidate) => candidate.name === call.tool);
      return tool === undefined ? [] : [{ tool, args: call.args }];
    }),
  };
}

/**
 * A move with an answer whose arguments are no JSON (#395: truncated): an invalid answer — the
 * model reads why, none of the move's tools runs.
 */
function unreadAnswer(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  calls: readonly ToolCallRequest[],
  unread: readonly InvalidToolCallRequest[],
): AgentLoopUpdate {
  const problem = invalidArgumentsMessage(unread);
  const move = state.move === null ? [] : [state.move];
  const replies = calls.length === 0 ? [new HumanMessage(problem)] : toolMessages(calls, problem);
  return invalidAnswer(state, deps, problem, [...move, ...replies]);
}

/**
 * A move with an answer tool (S6): exactly one answer tool and no regular tool ends the step with
 * the validated value (its class is the tool's) — a call repeating it exactly is the same answer
 * (#649); anything else goes back to the model as an invalid answer — none of that message's tools
 * runs.
 */
export function makeAnswerNode(
  deps: AgentLoopDeps,
): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  return (state) => Promise.resolve(answered(state, deps));
}

/** The answer node's update for the move. */
function answered(state: AgentLoopStateType, deps: AgentLoopDeps): AgentLoopUpdate {
  const calls = callsOf(state.move);
  const move = state.move === null ? [] : [state.move];
  const unread = invalidCallsOf(state.move);
  if (unread.length > 0) return unreadAnswer(state, deps, calls, unread);
  const answers = answerCallsOf(deps, calls);
  if (answers.kind === "refused") {
    return invalidAnswer(state, deps, answers.problem, [
      ...move,
      ...toolMessages(calls, `Tool error: ${ONE_ANSWER_MESSAGE}`),
    ]);
  }
  const reading = readAnswer(deps.agent.answerTools, answers.answers);
  if (reading.kind === "invalid") {
    const content = `Tool error: the answer is invalid — ${reading.problem}`;
    return invalidAnswer(state, deps, reading.problem, [...move, ...toolMessages(calls, content)]);
  }
  const reply = sortedJson(reading.answer.value);
  const received = toolMessages(calls, "Answer received.");
  const { answer, answeredWith } = reading;
  return {
    messages: [...move, ...received],
    move: null,
    reply,
    answer,
    answeredWith: [...answeredWith],
  };
}
