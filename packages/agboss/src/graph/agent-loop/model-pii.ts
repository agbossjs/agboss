import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { UsageRecord } from "../../finops/usage.js";
import { maskForModel, revealFromModel, type MaskedRequest } from "../../pii/model-boundary.js";
import type { PiiFinding } from "../../pii/masking.js";
import { DetectionMode } from "../../pii/runtime-policy.js";
import { mappedStringsAsync } from "../../pii/strings.js";
import type { PiiPolicySet } from "../../pii/policy-set.js";
import { unknownTokenMessage } from "../../prompts/pii.js";
import { normalisePromptText } from "../text.js";
import { invalidAnswer } from "./answer-node.js";
import { callsOf, isAnswerCall, type AgentLoopDeps } from "./deps.js";
import { loopUsage, type AgentLoopStateType, type AgentLoopUpdate } from "./state.js";

/**
 * The agent's side of the model boundary (#120 S38): its request masked by its policies (a block
 * rule in what came in refuses the execution), its move revealed before anything validates it — a
 * token no map knows is an invalid answer (S9) — and its final answer checked against the block
 * rules (`PiiRefusedError`).
 */

/** The policies at the agent's model with the execution's sensitive values; none = no masking. */
const policiesOf = (state: AgentLoopStateType, deps: AgentLoopDeps): PiiPolicySet | undefined =>
  deps.pii?.withValues(state.piiValues);

/** The request as the model reads it: instructions, then the conversation, masked. */
export async function maskedRequest(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
): Promise<MaskedRequest> {
  const messages = [
    new SystemMessage(normalisePromptText(deps.agent.instructions)),
    ...state.messages,
  ];
  const set = policiesOf(state, deps);
  if (set === undefined) return { messages, tokens: {}, cache: {}, blocked: [], usage: [] };
  const request = await maskForModel(set, messages, state.piiTokens, state.piiMasked);
  const refused = await set.refusalError(request.blocked, [...loopUsage(state), ...request.usage]);
  if (refused !== undefined) throw refused;
  return request;
}

/** The move as the loop goes on with it, or the invalid answer it is. */
export type OutgoingMove =
  | { readonly kind: "move"; readonly move: AIMessage; readonly usage: readonly UsageRecord[] }
  | { readonly kind: "invalid"; readonly update: AgentLoopUpdate };

/** Whether the move ends the agent's turn: a text reply, or an answer tool. */
const isFinal = (move: AIMessage, deps: AgentLoopDeps): boolean => {
  const calls = callsOf(move);
  return calls.length === 0 || calls.some((call) => isAnswerCall(deps.agent, call));
};

/** A block rule in the model's final answer refuses the execution (in a tool call: the tool task). */
async function checkAnswer(
  move: AIMessage,
  set: PiiPolicySet,
  state: AgentLoopStateType,
  spent: readonly UsageRecord[],
): Promise<readonly UsageRecord[]> {
  const usage: UsageRecord[] = [];
  const blocked: PiiFinding[] = [];
  const check = async (text: string): Promise<string> => {
    const { masked, usage: cost } = await set.mask(text, state.piiTokens, DetectionMode.WithModel);
    usage.push(...cost);
    blocked.push(...masked.blocked);
    return text;
  };
  await mappedStringsAsync(
    [move.content, ...(move.tool_calls ?? []).map((call) => call.args)],
    check,
  );
  const refused = await set.refusalError(blocked, [...loopUsage(state), ...spent, ...usage]);
  if (refused !== undefined) throw refused;
  return usage;
}

/** What the model reads back for a move that used tokens nobody gave it. */
function unknownTokenMessages(move: AIMessage, tokens: readonly string[]): BaseMessage[] {
  const content = unknownTokenMessage(tokens);
  const calls = callsOf(move);
  if (calls.length === 0) return [move, new HumanMessage({ content })];
  return [move, ...calls.map((call) => new ToolMessage({ tool_call_id: call.callId, content }))];
}

/** The model's move revealed (its tokens back to their values), checked, or an invalid answer. */
export async function outgoingMove(
  move: AIMessage,
  request: MaskedRequest,
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  spent: readonly UsageRecord[],
): Promise<OutgoingMove> {
  const set = policiesOf(state, deps);
  if (set === undefined) return { kind: "move", move, usage: [] };
  const usage = isFinal(move, deps) ? await checkAnswer(move, set, state, spent) : [];
  const revealed = revealFromModel(move, { ...state.piiTokens, ...request.tokens });
  if (revealed.unknownTokens.length === 0) return { kind: "move", move: revealed.move, usage };
  const problem = unknownTokenMessage(revealed.unknownTokens);
  const messages = unknownTokenMessages(revealed.move, revealed.unknownTokens);
  return {
    kind: "invalid",
    update: { ...invalidAnswer(state, deps, problem, messages), usage: [...spent, ...usage] },
  };
}
