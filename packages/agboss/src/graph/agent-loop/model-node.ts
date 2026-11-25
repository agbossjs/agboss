import { ConfigError } from "../../core/error-families/config-errors.js";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import { shownMessagesOf } from "../../models/messages.js";
import type { ToolDefinition } from "@langchain/core/language_models/base";
import type { RunnableConfig } from "@langchain/core/runnables";
import { NO_PROVIDER, recordUsage, type UsageRecord } from "../../finops/usage.js";
import { withSortedKeys } from "../../flow/runtime/json.js";
import { toolDefinitionOf } from "../../tools/index.js";
import { AgentFailedError } from "../errors.js";
import type { AsyncNode } from "../types.js";
import {
  callsOf,
  invalidCallsOf,
  isAnswerCall,
  type AgentDefinition,
  type AgentLoopDeps,
} from "./deps.js";
import { agentLimitError } from "./limits.js";
import { loopUsage, type AgentLoopStateType, type AgentLoopUpdate } from "./state.js";
import { extractRunContext, throwIfCancelled } from "../../core/run-context.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";
import type { MaskedRequest } from "../../pii/model-boundary.js";
import { withCallIds } from "./call-ids.js";
import { loopPoliciesOf, maskedRequest, outgoingMove } from "./model-pii.js";
import { toolBindingOf } from "../../flow/runtime/answer-tools.js";
import type { AttemptStream } from "../../run/stream/agent-stream.js";
import { StreamDiscardReason } from "../../run/types.js";
import { answering, attemptOf } from "./answer-stream.js";
import { ChunkCounter, earlierSpendOf, partialSpendOf, withChunkCounter } from "./chunk-counter.js";

/**
 * The agent's tools as the model sees them — its own and its answer tools (S6), sorted by name,
 * every JSON schema with sorted keys: the static part of the request is the same bytes in every
 * execution (#270 AC9).
 */
export function toolDefinitionsOf(agent: AgentDefinition): readonly ToolDefinition[] {
  const own = agent.tools.map((tool) => withSortedKeys(toolDefinitionOf(tool)));
  const answers = agent.answerTools.tools.map((tool) => tool.definition);
  return [...own, ...answers].sort((first, second) =>
    first.function.name < second.function.name ? -1 : 1,
  );
}

/** The call's signal with the budgets' `exhausted` one. */
const withExhausted = (signal: AbortSignal | undefined, deps: AgentLoopDeps): AbortSignal =>
  signal === undefined ? deps.budgets.exhausted : AbortSignal.any([signal, deps.budgets.exhausted]);

/** One model turn: the agent's instructions and conversation (masked, #120), its tools bound. */
async function callModel(
  messages: readonly BaseMessage[],
  deps: AgentLoopDeps,
  config: RunnableConfig | undefined,
  attempt: AttemptStream | undefined,
  counter: ChunkCounter,
): Promise<AIMessageChunk> {
  const { binding, name } = deps.agent;
  // an exhausted budget (#338) aborts the call in flight: what it received is still spent (#1399)
  const answered = answering(config, attempt);
  const call = {
    ...answered,
    callbacks: withChunkCounter(answered?.callbacks, counter),
    signal: withExhausted(config?.signal, deps),
  };
  // cache markers, where the model needs them, are placed by its provider on the wire (#151)
  const tools = toolDefinitionsOf(deps.agent);
  if (tools.length === 0) return binding.model.invoke([...messages], call);
  if (binding.model.bindTools === undefined) {
    throw new ConfigError.ModelKind({
      message: `The model of agent "${name}" cannot call tools`,
    });
  }
  return binding.model.bindTools([...tools], toolBindingOf(deps.agent)).invoke([...messages], call);
}

/**
 * A budget of the execution is exhausted: no more model calls — the execution stops with
 * `BudgetExceededError` (the loop's spend so far travels with it to the ledger).
 */
function checkBudget(state: AgentLoopStateType, deps: AgentLoopDeps): void {
  deps.budgets.check(state.usage, state.flowPath, loopUsage(state));
}

/** The budgets right after a call, with what it cost: the error carries the loop's spend. */
function checkSpent(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  spent: readonly UsageRecord[],
): void {
  const usage = [...loopUsage(state), ...spent];
  deps.budgets.check([...state.usage, ...spent], state.flowPath, usage);
}

/** The model call between its observer events; a failed call fails the agent with the loop's spend. */
async function observedCall(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  request: MaskedRequest,
  config: RunnableConfig | undefined,
  attempt: AttemptStream | undefined,
): Promise<{ readonly response: AIMessageChunk; readonly records: readonly UsageRecord[] }> {
  const { name, binding } = deps.agent;
  const modelName = binding.settings.model;
  // what the model was sent, masked: the conversation without the instructions
  const shown = shownMessagesOf(request.messages.slice(1));
  await reportNodeEvent((base) =>
    deps.observer?.onModelStart({
      ...base,
      model: modelName,
      provider: binding.settings.modelProvider ?? NO_PROVIDER,
      caller: name,
      messages: shown,
    }),
  );
  const counter = new ChunkCounter();
  const response = await callModel(request.messages, deps, config, attempt, counter).catch(
    (error: unknown) => {
      // the text of a call that broke is retracted before the failure goes on (#1006)
      attempt?.discard(StreamDiscardReason.StreamBroken);
      // what it had used is spent all the same (#1399): counted in the budgets, carried to the ledger
      const spent = partialSpendOf(deps, state.flowPath, request.messages, error, counter);
      throw new AgentFailedError({
        agent: name,
        usage: [...loopUsage(state), ...request.usage, ...spent],
        cause: error,
      });
    },
  );
  attempt?.end(); // what was held back for a possible PII token is text now (#1007)
  const usageRecord = recordUsage(name, binding.settings, response);
  const ended = {
    model: modelName,
    provider: usageRecord.provider,
    caller: name,
    content: response.text,
    usage: {
      inputTokens: usageRecord.inputTokens,
      outputTokens: usageRecord.outputTokens,
      cacheReadTokens: usageRecord.cacheReadTokens,
      cacheWriteTokens: usageRecord.cacheWriteTokens,
    },
    costUsd: usageRecord.costUsd,
  };
  await reportNodeEvent((base) => deps.observer?.onModelEnd({ ...base, ...ended }));
  // what providers that failed before a fallback answered billed is recorded under them (#1399)
  const earlier = earlierSpendOf(deps, request.messages, response);
  return { response, records: [...earlier, usageRecord] };
}

/** The agent's `maxModelCalls` per visit: the call about to start is over it. */
function checkModelCalls(state: AgentLoopStateType, deps: AgentLoopDeps, turn: number): void {
  const { name, limits } = deps.agent;
  if (turn <= limits.modelCalls) return;
  const breach = {
    agent: name,
    limit: "modelCalls",
    max: limits.modelCalls,
    actual: turn,
  } as const;
  throw agentLimitError(state, { ...breach, spent: [] });
}

/**
 * One model call = one node. Before it: the execution's budgets and `modelCalls`; after it: the usage record
 * and `toolCalls` for the calls the move asks for. A failed call fails the agent with the loop's spend.
 */
export function makeModelNode(deps: AgentLoopDeps): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  const { name, limits } = deps.agent;
  return async (state, config) => {
    const runCtx = extractRunContext(config, state.runId);
    // stopped by an exhausted budget (#338): its error, with the loop's spend so far
    if (deps.budgets.exhausted.aborted) checkBudget(state, deps);
    throwIfCancelled(runCtx.run);
    checkBudget(state, deps);
    const turn = state.modelCalls + 1;
    checkModelCalls(state, deps, turn);
    const request = await maskedRequest(state, deps);
    // an agent that reads through PII policies has its tokens revealed in the stream as in its reply
    const tokens =
      loopPoliciesOf(state, deps) === undefined
        ? undefined
        : { ...state.piiTokens, ...request.tokens };
    const attempt = attemptOf(config, deps, turn, tokens);
    const { response, records } = await observedCall(state, deps, request, config, attempt);
    // counted at once (#338) and in the ledger (#727): the branches running beside this one, and
    // the tree's steps on other instances, see it at their next check
    const spent = deps.budgets.tally([...request.usage, ...records], state.flowPath);
    const outgoing = await outgoingMove(withCallIds(response, state), request, state, deps, spent);
    const pii = { piiTokens: request.tokens, piiMasked: request.cache };
    if (outgoing.kind === "invalid") {
      attempt?.discard(StreamDiscardReason.InvalidAnswer);
      return { ...outgoing.update, modelCalls: 1, ...pii };
    }
    const checked = deps.budgets.tally(outgoing.usage, state.flowPath);
    const move = outgoing.move;
    // answer tools are not tool calls: an invalid answer costs a retry, not `maxToolCalls` (S9)
    const calls =
      callsOf(move).filter((call) => !isAnswerCall(deps.agent, call)).length +
      invalidCallsOf(move).filter((call) => !isAnswerCall(deps.agent, call)).length;
    // a turn that goes to tools is no reply: its text is retracted (#1006)
    if (calls > 0) attempt?.discard(StreamDiscardReason.ToolTurn);
    const toolCalls = state.toolCalls + calls;
    if (toolCalls > limits.toolCalls) {
      const breach = {
        agent: name,
        limit: "toolCalls",
        max: limits.toolCalls,
        actual: toolCalls,
      } as const;
      throw agentLimitError(state, { ...breach, spent: [...spent, ...checked] });
    }
    // the call exhausted a budget: no tool runs on it (an answer is kept — the next step stops)
    if (calls > 0) checkSpent(state, deps, [...spent, ...checked]);
    return {
      move,
      usage: [...spent, ...checked],
      modelCalls: 1,
      toolCalls: calls,
      ...pii,
    };
  };
}
