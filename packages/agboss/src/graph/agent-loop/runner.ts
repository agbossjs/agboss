import type { ExecutionStateType } from "../../flow/runtime/state.js";
import type { AgentAnswer } from "../../flow/runtime/answer-tools.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { ApprovalRecord } from "../../pause/index.js";
import type { AgentLoopStateType } from "./state.js";
import type { SensitiveValue } from "../../pii/policy-set.js";
import type { PiiTokenMap } from "../../pii/tokens.js";

/** What of PII an agent's loop is handed: the execution's tokens and its sensitive values (#120). */
export interface LoopPii {
  readonly tokens: PiiTokenMap;
  readonly values: readonly SensitiveValue[];
}

const NO_PII: LoopPii = { tokens: {}, values: [] };

/** What the execution hands an agent's loop: its run, spend, memory and input message. */
export function loopInputOf(
  state: ExecutionStateType,
  agent: string,
  input: string,
  pii: LoopPii = NO_PII,
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
    answeredWith: [],
    retries: 0,
    invalidAnswers: 0,
    piiTokens: { ...state.piiTokens, ...pii.tokens },
    piiMasked: {},
    piiValues: pii.values,
  };
}

/** What a finished loop gives the execution: its answer (or text reply), spend and decisions. */
export interface LoopResult {
  readonly answer?: AgentAnswer;
  readonly reply: string;
  readonly usage: readonly UsageRecord[];
  readonly approvals: readonly ApprovalRecord[];
  /** Every PII token of the loop (merged by key into the execution's). */
  readonly piiTokens: PiiTokenMap;
}

export const loopResultOf = (after: AgentLoopStateType): LoopResult => ({
  ...(after.answer === null ? {} : { answer: after.answer }),
  reply: after.reply ?? "",
  usage: after.usage.slice(after.from.usage),
  approvals: after.approvals.slice(after.from.approvals),
  piiTokens: after.piiTokens,
});
