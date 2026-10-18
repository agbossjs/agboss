import { HumanMessage } from "@langchain/core/messages";
import { runJudgeCall } from "../../components/judge-call.js";
import type { JudgeVerdict } from "../../components/judge-decorators.js";
import type { UsageRecord } from "../../finops/usage.js";
import { AgentFailedError, QualityGateError, type JudgeFeedback } from "../errors.js";
import type { AsyncNode } from "../types.js";
import type { AgentLoopDeps } from "./deps.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";
import { meteredModel } from "./judge-model.js";
import { loopUsage, type AgentLoopStateType, type AgentLoopUpdate } from "./state.js";

/** The judges that rejected the reply, in the agent's order; every judge runs. */
async function rejectionsOf(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  reply: string,
  spent: UsageRecord[],
): Promise<JudgeFeedback[]> {
  const agent = deps.agent.name;
  const rejected: JudgeFeedback[] = [];
  for (const judge of deps.agent.judges ?? []) {
    const input = { reply, task: state.inputMessage, attempt: state.retries };
    const event = { name: judge.name, agentName: agent };
    await reportNodeEvent((base) => deps.observer?.onJudgeStart({ ...base, ...event, input: reply }));
    const verdict: JudgeVerdict = await runJudgeCall(meteredModel(judge, spent), () =>
      judge.handler.judge(input),
    ).catch((error: unknown) => {
      throw new AgentFailedError(agent, [...loopUsage(state), ...spent], error);
    });
    await reportNodeEvent((base) =>
      deps.observer?.onJudgeEnd({ ...base, ...event, update: verdict }),
    );
    if (!verdict.passed) {
      rejected.push({ judge: judge.name, feedback: verdict.feedback ?? "rejected (no feedback)" });
    }
  }
  return rejected;
}

/** What the agent reads before its retry: every rejecting judge's feedback. */
const retryPrompt = (rejected: readonly JudgeFeedback[]): string =>
  [
    "Your reply did not pass the quality gate. Fix the following and reply again:",
    ...rejected.map((r) => `- [${r.judge}] ${r.feedback}`),
  ].join("\n");

/**
 * The quality gate after the agent's reply: every `@Judge` of the agent judges it with its own model
 * (spend recorded as `judge:<name>`). All pass → the reply is the agent's answer. A rejection
 * sends the feedback back to the model for a retry; after `maxRetries` retries → `QualityGateError`.
 */
export function makeJudgeNode(deps: AgentLoopDeps): AsyncNode<AgentLoopStateType, AgentLoopUpdate> {
  const { name: agent, judges = [], maxRetries = 0 } = deps.agent;
  return async (state) => {
    if (judges.length === 0 || state.reply === null) return {};
    const spent: UsageRecord[] = [];
    const rejected = await rejectionsOf(state, deps, state.reply, spent);
    if (rejected.length === 0) return { usage: spent };
    if (state.retries >= maxRetries) {
      throw new QualityGateError(agent, [...loopUsage(state), ...spent], rejected, state.retries);
    }
    return {
      reply: null,
      answer: null,
      retries: 1,
      usage: spent,
      messages: [new HumanMessage(retryPrompt(rejected))],
    };
  };
}
