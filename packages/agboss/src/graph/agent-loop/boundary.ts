import { Send } from "@langchain/langgraph";
import { unknownToolMessage } from "../../prompts/agents.js";
import type { AsyncNode } from "../types.js";
import {
  callsOf,
  invalidCallsOf,
  toolNamed,
  type AgentLoopDeps,
  type ToolCallRequest,
} from "./deps.js";
import { unreadCallRecordOf } from "./call-records.js";
import { extractRunContext } from "../../core/run-context.js";
import {
  LOOP_NODE,
  loopProgressOf,
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
          piiKey: state.piiKey,
          progress: loopProgressOf(state),
        } satisfies ToolTask),
    );
  };
}

/**
 * The move boundary: the move joins the conversation. A call to a tool the agent does not have is
 * answered right here, as a finished call with a tool error.
 */
export function makeBoundaryNode(
  deps: AgentLoopDeps,
): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  return (state, config) => {
    const results: Record<string, StoredToolCall> = {};
    for (const call of callsOf(state.move)) {
      if (toolNamed(deps.agent, call.tool) !== undefined) continue;
      const content = unknownToolMessage(call.tool);
      results[call.callId] = { callId: call.callId, tool: call.tool, content };
    }
    const messages = state.move === null ? [] : [state.move];
    const unread = unreadCallsOf(state, deps, extractRunContext(config, state.runId).clock.now());
    return Promise.resolve({ messages, results, ...unread });
  };
}

/**
 * The move's calls whose arguments were no JSON (#395): each recorded as `InvalidArguments` and
 * counted as a failed validation of the step; the model reads why after the move's results.
 */
function unreadCallsOf(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  at: Date,
): Pick<AgentLoopUpdate, "callRecords" | "invalidArguments"> {
  const unread = invalidCallsOf(state.move);
  if (unread.length === 0) return {};
  const progress = loopProgressOf(state);
  const site = { agent: deps.agent.name, at };
  const callRecords = Object.fromEntries(
    unread.map((call) => [
      call.callId,
      unreadCallRecordOf(call, toolNamed(deps.agent, call.tool), progress, site),
    ]),
  );
  return { callRecords, invalidArguments: unread.length };
}
