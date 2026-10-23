import { isGraphInterrupt } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  CarriedOrder,
  carryRecords,
  type CarriedRecords,
} from "../../flow/runtime/carried-records.js";
import type { AsyncNode } from "../types.js";
import { callsOf, invalidCallsOf } from "./deps.js";
import type { AgentLoopStateType, AgentLoopUpdate } from "./state.js";

/**
 * What a failed agent visit carries (#395 S6): its tool calls so far — collected ones, then the
 * move under way's that ended — its judges' verdicts and its input guardrails' decisions, from the
 * loop's state around the node that threw. Put before what that node carried itself (a judge's
 * verdicts of this round, a guardrail's blocking decision): those happened last.
 */

/** The loop's records as its state holds them. */
export function loopRecordsOf(state: AgentLoopStateType): Partial<CarriedRecords> {
  const move = [...callsOf(state.move), ...invalidCallsOf(state.move)];
  const ended = move.flatMap((call) => {
    const record = state.callRecords[call.callId];
    return record === undefined ? [] : [record];
  });
  return {
    toolCalls: [...state.trajectory, ...ended],
    judgeVerdicts: state.judgeVerdicts,
    guardrailDecisions: state.guardrailDecisions,
  };
}

/** A loop node whose failure carries the loop's records; a pause passes as it is. */
export const carryingLoopRecords =
  (
    node: AsyncNode<AgentLoopStateType, AgentLoopUpdate>,
  ): AsyncNode<AgentLoopStateType, AgentLoopUpdate> =>
  async (state: AgentLoopStateType, config?: RunnableConfig): Promise<AgentLoopUpdate> => {
    try {
      return await node(state, config);
    } catch (error) {
      if (!isGraphInterrupt(error)) carryRecords(error, loopRecordsOf(state), CarriedOrder.Before);
      throw error;
    }
  };
