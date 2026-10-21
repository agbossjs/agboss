import { HumanMessage } from "@langchain/core/messages";
import { runJudgeCall } from "../../components/judge-call.js";
import type {
  AnyJudgeInput,
  JudgeReplyShape,
  JudgeVerdict,
} from "../../components/judge-decorators.js";
import { PlainTextDto } from "../../dto/standard/framework.js";
import type { DtoClass } from "../../dto/types.js";
import { isWrapper, Wrapper } from "../../flow/dto-wrappers.js";
import type { UsageRecord } from "../../finops/usage.js";
import { AgentFailedError, QualityGateError, type JudgeRejection } from "../errors.js";
import type { AsyncNode } from "../types.js";
import type { AgentJudge, AgentLoopDeps } from "./deps.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";
import { meteredModel } from "./judge-model.js";
import { loopUsage, type AgentLoopStateType, type AgentLoopUpdate } from "./state.js";

/**
 * The class of each value of the answer (#262 S125): the class of the answer tool it was answered
 * with, by its position among the agent's answer tools — never by a name, never by the shape.
 */
function answeredClassesOf(state: AgentLoopStateType, deps: AgentLoopDeps): readonly DtoClass[] {
  const { tools } = deps.agent.answerTools;
  return state.answeredWith.map((position) => {
    const tool = tools[position];
    if (tool === undefined) {
      throw new TypeError(`${deps.agent.name}: no answer tool at position ${String(position)}`);
    }
    return tool.dto;
  });
}

/** The class of a list's item at an index. */
function classAt(classes: readonly DtoClass[], index: number): DtoClass {
  const dto = classes[index];
  if (dto === undefined) throw new TypeError(`no answer tool for item ${String(index)}`);
  return dto;
}

/** The items of a list answer as values: a `listOf(oneOf(…))` answer keeps `{ variant, value }`. */
function itemValuesOf(deps: AgentLoopDeps, value: unknown): readonly unknown[] {
  const items: readonly unknown[] = Array.isArray(value) ? value : [];
  if (!deps.agent.answerTools.hasVariants) return items;
  return items.map((item): unknown =>
    typeof item === "object" && item !== null ? Reflect.get(item, "value") : item,
  );
}

/**
 * The one class a `listOf(XDto)` judge's `variant` names: the class of the agent's list — or, when
 * the agent's list may hold several classes (each extending `XDto`), the judge's `XDto`.
 */
function listClassOf(deps: AgentLoopDeps, reply: JudgeReplyShape): DtoClass {
  const [only, ...others] = deps.agent.answerTools.tools;
  if (only !== undefined && others.length === 0) return only.dto;
  const element =
    typeof reply === "function" || reply.kind !== Wrapper.List ? reply : reply.element;
  if (typeof element !== "function") throw new TypeError("a list judge of one class has one class");
  return element;
}

/**
 * What a judge reads (#262 S115, S125), in the shape of its `reply`: the validated answer and the
 * class it validated as — a text agent's text as a `PlainTextDto`; one value with its answer
 * tool's class; a list with its one class, or, for a `listOf(oneOf(…))` judge, each item as
 * `{ variant, value }`. Each judge gets its own copy, so no judge changes the answer the step gives.
 */
function judgedInputOf(
  state: AgentLoopStateType,
  deps: AgentLoopDeps,
  judge: AgentJudge,
  text: string,
): AnyJudgeInput {
  const base = { task: state.inputMessage, attempt: state.retries };
  if (state.answer === null) return { ...base, variant: PlainTextDto, reply: { text } };
  const value: unknown = structuredClone(state.answer.value);
  const classes = answeredClassesOf(state, deps);
  if (!deps.agent.answerTools.isList) {
    const [variant] = classes;
    if (variant === undefined) throw new TypeError(`${deps.agent.name}: an answer without a class`);
    return { ...base, variant, reply: value };
  }
  const items = itemValuesOf(deps, value);
  const { reply } = judge;
  const judgesVariants =
    typeof reply !== "function" && reply.kind === Wrapper.List && isWrapper(reply.element);
  if (!judgesVariants) return { ...base, variant: listClassOf(deps, reply), reply: items };
  // a `listOf(oneOf(…))` judge: each item with its own class (`VariantOf`)
  return {
    ...base,
    reply: items.map((item, index) => ({ variant: classAt(classes, index), value: item })),
  };
}

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
    const input = judgedInputOf(state, deps, judge, text);
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
export const retryPrompt = (rejected: readonly JudgeRejection[]): string =>
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
      answeredWith: [],
      retries: 1,
      usage: spent,
      messages: [new HumanMessage(retryPrompt(rejected))],
    };
  };
}
