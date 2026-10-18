import type { ExecutionStateType } from "../../flow/runtime/state.js";
import type { AgentAnswer } from "../../flow/runtime/answer-tools.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { ApprovalRecord } from "../../pause/index.js";
import type { AgentLoopStateType } from "./state.js";

/** What the execution hands an agent's loop: its run, spend, memory and input message. */
export function loopInputOf(
  state: ExecutionStateType,
  agent: string,
  input: string,
): AgentLoopStateType {
  return {
    runId: state.runId,
    usage: state.usage,
    approvals: state.approvals,
    history: state.history,
    summaries: state.summaries,
    inputMessage: input,
    flowPath: [...state.path, agent],
    from: { usage: state.usage.length, approvals: state.approvals.length },
    messages: [],
    move: null,
    results: {},
    decisions: {},
    modelCalls: 0,
    toolCalls: 0,
    reply: null,
    answer: null,
    retries: 0,
    invalidAnswers: 0,
  };
}

/** What a finished loop gives the execution: its answer (or text reply), spend and decisions. */
export interface LoopResult {
  readonly answer?: AgentAnswer;
  readonly reply: string;
  readonly usage: readonly UsageRecord[];
  readonly approvals: readonly ApprovalRecord[];
}

export const loopResultOf = (after: AgentLoopStateType): LoopResult => ({
  ...(after.answer === null ? {} : { answer: after.answer }),
  reply: after.reply ?? "",
  usage: after.usage.slice(after.from.usage),
  approvals: after.approvals.slice(after.from.approvals),
});
