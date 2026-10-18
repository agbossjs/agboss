import { Send } from "@langchain/langgraph";
import { unknownToolMessage } from "../../prompts/agents.js";
import type { AsyncNode } from "../types.js";
import { callsOf, toolNamed, type AgentLoopDeps, type ToolCallRequest } from "./deps.js";
import { JudgePoint, visitToolThenAgent, mergePolicies } from "./judge-points.js";
import { extractRunContext } from "../../core/run-context.js";
import {
  LOOP_NODE,
  type AgentLoopStateType,
  type AgentLoopUpdate,
  type StoredToolCall,
  type ToolTask,
} from "./state.js";

/** Calls of the move that wait for a decision: their tool needs one and nobody decided yet. */
export function awaitingApproval(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
): ToolCallRequest[] {
  const approval = deps.approval;
  if (approval === undefined) return [];
  return callsOf(state.move).filter((call) => {
    const tool = toolNamed(deps.agent, call.tool);
    return (
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
      tool !== undefined &&
      tool.channel !== undefined &&
      state.decisions[call.callId] === undefined &&
      state.results[call.callId] === undefined
    );
  });
}

/** Calls of the move allowed to run that have no stored result yet. */
export const runnableCalls = (state: AgentLoopStateType): ToolCallRequest[] =>
  callsOf(state.move).filter(
    (call) =>
      state.results[call.callId] === undefined && state.decisions[call.callId]?.approved !== false,
  );

/**
 * After the boundary (and after each decision): ask about the next call that waits (one per pause),
 * else run every allowed call as its own task, else collect the results.
 */
export function routeToActions(
  deps: AgentLoopDeps,
): (state: AgentLoopStateType) => string | Send[] {
  return (state) => {
    if (awaitingApproval(state, deps).length > 0) return LOOP_NODE.approval;
    const calls = runnableCalls(state);
    if (calls.length === 0) return LOOP_NODE.collect;
    return calls.map(
      (call) =>
        new Send(LOOP_NODE.tool, {
          callId: call.callId,
          tool: call.tool,
          args: state.decisions[call.callId]?.overrideArguments ?? call.args,
          runId: state.runId,
        } satisfies ToolTask),
    );
  };
}

/**
 * The move boundary: the move joins the conversation; for each call, in order, the tool's judges
 * and the agent's judges look at it (`beforeToolCall`). A call to a tool the agent does not have
 * is answered right here, as a finished call with a tool error.
 */
export function makeBoundaryNode(
  deps: AgentLoopDeps,
): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  return async (state, config) => {
    const results: Record<string, StoredToolCall> = {};
    for (const call of callsOf(state.move)) {
      if (toolNamed(deps.agent, call.tool) === undefined) {
        const content = unknownToolMessage(call.tool);
        results[call.callId] = { callId: call.callId, tool: call.tool, content };
        continue;
      }

      const runCtx = extractRunContext(config, state.runId);
      const ctx = {
        agent: deps.agent.name,
        call,
        runId: runCtx.runId,
      };

      const combinedGuardrails = mergePolicies(
        deps.workflowGuardrails,
        deps.guardrails,
        deps.toolGuardrails?.(call.tool),
      );

      await visitToolThenAgent(
        combinedGuardrails,
        JudgePoint.BeforeToolCall,
        ctx,
        undefined,
        deps.observer,
      );
    }
    return { messages: state.move === null ? [] : [state.move], results };
  };
}
