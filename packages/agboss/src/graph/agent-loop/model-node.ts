import { AIMessage, SystemMessage, type AIMessageChunk } from "@langchain/core/messages";
import type { ToolDefinition } from "@langchain/core/language_models/base";
import type { RunnableConfig } from "@langchain/core/runnables";
import { recordUsage, totalCost, type UsageRecord } from "../../finops/usage.js";
import type { AppState } from "../../core/observability.js";
import { withSortedKeys } from "../../flow/runtime/json.js";
import { toolDefinitionOf } from "../../tools/index.js";
import { AgentFailedError } from "../errors.js";
import type { AsyncNode } from "../types.js";
import { callsOf, isAnswerCall, type AgentDefinition, type AgentLoopDeps } from "./deps.js";
import { agentLimitError } from "./limits.js";
import { loopUsage, type AgentLoopStateType, type AgentLoopUpdate } from "./state.js";
import { normalisePromptText } from "../text.js";
import { extractRunContext, throwIfCancelled } from "../../core/run-context.js";

export class ToolCallingUnsupportedError extends Error {
  override name = "ToolCallingUnsupportedError";
}

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

/** One model turn: the agent's instructions and conversation, its tools bound. */
async function callModel(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  config: RunnableConfig | undefined,
): Promise<AIMessageChunk> {
  const { binding, instructions, name } = deps.agent;
  // cache markers, where the model needs them, are placed by its provider on the wire (#151)
  const messages = [new SystemMessage(normalisePromptText(instructions)), ...state.messages];
  const tools = toolDefinitionsOf(deps.agent);
  if (tools.length === 0) return binding.model.invoke(messages, config);
  if (binding.model.bindTools === undefined) {
    throw new ToolCallingUnsupportedError(`The model of agent "${name}" cannot call tools`);
  }
  return binding.model.bindTools([...tools]).invoke(messages, config);
}

/**
 * The move with an id on every tool call: results are stored by it and it is the tool's idempotency
 * key, so a call the model gave no id gets one unique within the run (run, visit, turn, position).
 */
function withCallIds(response: AIMessageChunk, state: AgentLoopStateType): AIMessage {
  const turn = state.modelCalls + 1;
  const toolCalls = (response.tool_calls ?? []).map((call, index) => ({
    ...call,
    id:
      call.id === undefined || call.id === ""
        ? `${state.runId}:${String(state.flowPath.length)}:${String(turn)}:${String(index)}`
        : call.id,
  }));
  return new AIMessage({ content: response.content, tool_calls: toolCalls });
}

/**
 * A budget of the execution is exhausted: no more model calls — the execution stops with
 * `BudgetExceededError` (the loop's spend so far travels with it to the ledger).
 */
function checkBudget(state: AgentLoopStateType, deps: AgentLoopDeps): void {
  deps.budgets.check(totalCost(state.usage), state.flowPath, loopUsage(state));
}

/** The model call between its observer events; a failed call fails the agent with the loop's spend. */
async function observedCall(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  config: RunnableConfig | undefined,
  appState: AppState,
): Promise<{ readonly response: AIMessageChunk; readonly usageRecord: UsageRecord }> {
  const { name, binding } = deps.agent;
  const modelName = binding.settings.model;
  await deps.observer?.onModelStart({
    modelName,
    callerName: name,
    rawPayload: state.messages,
    state: appState,
  });
  const response = await callModel(state, deps, config).catch((error: unknown) => {
    throw new AgentFailedError(name, loopUsage(state), error);
  });
  const usageRecord = recordUsage(name, binding.settings, response);
  await deps.observer?.onModelEnd({
    model: modelName,
    callerName: name,
    rawContent: response.content,
    usage: {
      promptTokens: usageRecord.inputTokens,
      completionTokens: usageRecord.outputTokens,
      totalTokens: usageRecord.inputTokens + usageRecord.outputTokens,
    },
    calculatedCost: usageRecord.costUsd,
    state: appState,
  });
  return { response, usageRecord };
}

/**
 * One model call = one node. Before it: the execution's budgets and `modelCalls`; after it: the usage record
 * and `toolCalls` for the calls the move asks for. A failed call fails the agent with the loop's spend.
 */
export function makeModelNode(deps: AgentLoopDeps): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  const { name, limits } = deps.agent;
  return async (state, config) => {
    const runCtx = extractRunContext(config, state.runId);
    throwIfCancelled(runCtx.run);
    checkBudget(state, deps);
    const turn = state.modelCalls + 1;
    if (turn > limits.modelCalls) {
      const breach = {
        agent: name,
        limit: "modelCalls",
        max: limits.modelCalls,
        actual: turn,
      } as const;
      throw agentLimitError(state, { ...breach, spent: [] });
    }
    const appState = { runId: state.runId, threadId: runCtx.threadId, activeNode: name };
    const { response, usageRecord } = await observedCall(state, deps, config, appState);
    const move = withCallIds(response, state);
    // answer tools are not tool calls: an invalid answer costs a retry, not `maxToolCalls` (S9)
    const calls = callsOf(move).filter((call) => !isAnswerCall(deps.agent, call)).length;
    const toolCalls = state.toolCalls + calls;
    if (toolCalls > limits.toolCalls) {
      const breach = {
        agent: name,
        limit: "toolCalls",
        max: limits.toolCalls,
        actual: toolCalls,
      } as const;
      throw agentLimitError(state, { ...breach, spent: [usageRecord] });
    }
    return { move, usage: [usageRecord], modelCalls: 1, toolCalls: calls };
  };
}
