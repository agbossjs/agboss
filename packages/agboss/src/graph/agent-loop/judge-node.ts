import { HumanMessage } from "@langchain/core/messages";
import { runJudgeCall } from "../../components/judge-call.js";
import type { JudgeInput, JudgeVerdict } from "../../components/judge-decorators.js";
import type { UsageRecord } from "../../finops/usage.js";
import { AgentFailedError, QualityGateError, type JudgeRejection } from "../errors.js";
import type { AsyncNode } from "../types.js";
import type { AgentLoopDeps } from "./deps.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";
import { meteredModel } from "./judge-model.js";
import { loopUsage, type AgentLoopStateType, type AgentLoopUpdate } from "./state.js";

/** A `listOf(oneOf(…))` answer's item `{ variant, value }` as the judge reads it: its value. */
const itemValueOf = (item: unknown): unknown =>
  typeof item === "object" && item !== null && "value" in item ? item.value : item;

/**
 * What a judge reads as `reply` (#262 S115): the validated answer — a value of the agent's `output`
 * class (a `oneOf` variant's own value), a list's items (each variant's value for a list of
 * `oneOf`) — or, for a text agent, its text as a `PlainTextDto`. The agent's answer tools say which.
 */
function judgedReplyOf(state: AgentLoopStateType, deps: AgentLoopDeps, text: string): unknown {
  if (state.answer === null) return { text };
  const { value } = state.answer;
  const { isList, hasVariants } = deps.agent.answerTools;
  return isList && hasVariants && Array.isArray(value) ? value.map(itemValueOf) : value;
}

/** One judge's input: its own copy of the reply, so no judge changes the answer the step gives. */
const judgeInputOf = (
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  text: string,
): JudgeInput<unknown> => ({
  reply: structuredClone(judgedReplyOf(state, deps, text)),
  task: state.inputMessage,
  attempt: state.retries,
});

/** The judges that rejected the reply, in the agent's order; every judge runs. */
async function rejectionsOf(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  text: string,
  spent: UsageRecord[],
): Promise<JudgeRejection[]> {
  const agent = deps.agent.name;
  const rejected: JudgeRejection[] = [];
  for (const judge of deps.agent.judges ?? []) {
    const input = judgeInputOf(state, deps, text);
    const event = { name: judge.name, agentName: agent };
    await reportNodeEvent((base) =>
      deps.observer?.onJudgeStart({ ...base, ...event, input: text }),
    );
    const verdict: JudgeVerdict = await runJudgeCall(meteredModel(judge, spent), () =>
      judge.handler.judge(input),
    ).catch((error: unknown) => {
      throw new AgentFailedError(agent, [...loopUsage(state), ...spent], error);
    });
    await reportNodeEvent((base) =>
      deps.observer?.onJudgeEnd({ ...base, ...event, update: verdict }),
    );
    if (!verdict.passed) rejected.push({ judge: judge.name, reason: verdict.reason });
  }
  return rejected;
}

/** What the agent reads before its retry: every rejecting judge's reason. */
const retryPrompt = (rejected: readonly JudgeRejection[]): string =>
  [
    "Your reply did not pass the quality gate. Fix the following and reply again:",
    ...rejected.map((r) => `- [${r.judge}] ${r.reason}`),
  ].join("\n");

/**
 * The quality gate after the agent's reply: every `@Judge` of the agent judges its answer, as its
 * DTO, with its own model (spend recorded as `judge:<name>`). All pass → the reply is the agent's answer. A rejection
 * sends its reason back to the model for a retry; after `maxRetries` retries → `QualityGateError`.
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
