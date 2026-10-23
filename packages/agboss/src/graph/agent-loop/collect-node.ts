import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ApprovalRecord } from "../../pause/index.js";
import { invalidArgumentsMessage, rejectionMessage } from "../../prompts/agents.js";
import type { AsyncNode } from "../types.js";
import { callsOf, invalidCallsOf, type AgentLoopDeps, type ToolCallRequest } from "./deps.js";
import { loopUsage, type AgentLoopStateType, type AgentLoopUpdate } from "./state.js";
import { stopErrorOf } from "./tool-stops.js";
import type { StepFailedError } from "../errors.js";

/** What the model reads for a call: its stored result, or who rejected it and why. */
function contentOf(state: AgentLoopStateType, call: ToolCallRequest): string {
  const stored = state.results[call.callId];
  if (stored !== undefined) return stored.content;
  const decision = state.decisions[call.callId];
  return rejectionMessage(decision?.by ?? "the loop", decision?.reason);
}

/** The decided calls of this move, as the flow keeps them (#100: the turn ends after a decision). */
function decidedCalls(
  state: AgentLoopStateType,
  calls: readonly ToolCallRequest[],
  agent: string,
): ApprovalRecord[] {
  return calls.flatMap((call) => {
    const decision = state.decisions[call.callId];
    if (decision === undefined) return [];
    const result = contentOf(state, call);
    return [
      {
        agent,
        tool: call.tool,
        args: call.args,
        approved: decision.approved,
        by: decision.by,
        result,
      },
    ];
  });
}

/** The first call of the move a tool interceptor stopped (#384) fails the step, with the loop's spend. */
function stoppedErrorOf(
  state: AgentLoopStateType,
  calls: readonly ToolCallRequest[],
  agent: string,
): StepFailedError | undefined {
  for (const call of calls) {
    const stop = state.results[call.callId]?.stop;
    if (stop === undefined) continue;
    const stopped = { agent, tool: call.tool, callId: call.callId, runId: state.runId };
    return stopErrorOf(stopped, stop, loopUsage(state));
  }
  return undefined;
}

/**
 * Fan-in after the tool tasks: one tool message per call in the MOVE's order (not completion
 * order), the decisions recorded, the calls' records appended to the visit's trajectory in that
 * order (#395); then the model takes its next turn. A call a tool interceptor stopped fails the
 * step instead (#384).
 */
export function makeCollectNode(
  deps: AgentLoopDeps,
): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  return (state) => {
    const calls = callsOf(state.move);
    const stopped = stoppedErrorOf(state, calls, deps.agent.name);
    if (stopped !== undefined) return Promise.reject(stopped);
    const unread = invalidCallsOf(state.move);
    const messages: BaseMessage[] = calls.map(
      (call) => new ToolMessage({ tool_call_id: call.callId, content: contentOf(state, call) }),
    );
    // calls whose arguments were no JSON have no place in the move the model is sent back (#395)
    if (unread.length > 0) messages.push(new HumanMessage(invalidArgumentsMessage(unread)));
    const trajectory = [...calls, ...unread].flatMap((call) => {
      const record = state.callRecords[call.callId];
      return record === undefined ? [] : [record];
    });
    return Promise.resolve({
      messages,
      move: null,
      approvals: decidedCalls(state, calls, deps.agent.name),
      trajectory,
    });
  };
}
