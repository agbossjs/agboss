import type { BaseMessageLike } from "@langchain/core/messages";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../llm/decisions.js";
import type { DtoClass } from "../dto/types.js";
import type { ListWrapper, OneOfWrapper, ValueOf } from "../flow/dto-wrappers.js";
import { recordComponent } from "./metadata.js";
import type { Class, ResolvedAll, Token } from "./injection.js";

/**
 * What a judge judges (#262 S115) — every shape an agent's `output` can have: one DTO class,
 * `oneOf(A, B)` (the reply is `A | B`), `listOf(XDto)` / `listOf(oneOf(A, B))` (a `readonly` list)
 * or `PlainTextDto` for a text agent's reply (`{ text }`). The agent's output has the same shape and
 * every class it may answer with is one of the judge's, else `[judge.wrong-reply]`.
 */
export type JudgeReplyShape = DtoClass | OneOfWrapper | ListWrapper;

/** `@Judge` — a quality gate of an agent's reply, with the model it judges with. */
export interface JudgeMeta<TReply extends JudgeReplyShape = JudgeReplyShape> {
  /** Unique in the workflow: the judge's settings key (`judges.<name>`) and its cost caller (`judge:<name>`). */
  readonly name: string;
  /**
   * The judge's own model, required (`judge.no-model`): a chat model (`judgeModel.invoke`) or a
   * decision model such as `openai/gpt-6-luna-decisions` or `typesafe/jev-1.13` (`judgeModel.decide`).
   */
  readonly model: string;
  /** What it judges: the agent's answer as this DTO (`judge(input)`'s `reply`). */
  readonly reply: TReply;
  readonly description?: string;
}

/**
 * The judge's own model (`@Judge({ model })`), through the model gateway: every call is in the
 * run's cost report. Injected through the constructor (`deps: [JudgeModel]`, #280); each call goes
 * to the model of the judge whose `judge()` is running.
 */
export abstract class JudgeModel {
  /** The model id (`@Judge({ model })`). */
  abstract readonly model: string;
  /** One chat call; returns the reply's text. On a decision model: `ModelKindError`. */
  abstract invoke(input: string | readonly BaseMessageLike[]): Promise<string>;
  /**
   * One decision (questions from `Decision.choice / noul / score`), its answers typed by them. On a
   * chat model: `ModelKindError`.
   */
  abstract decide<const Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
  ): Promise<AnswersOf<Q>>;
}

/**
 * What a judge judges (#280: data only, no context — the execution comes through
 * `deps: [ExecutionContext]`, the agent as its `step.component`).
 */
export interface JudgeInput<TReply> {
  /** The agent's answer, validated: a value of the judge's `reply` (`{ text }` for a text agent). */
  readonly reply: TReply;
  /** The run's task (the agent's input message). */
  readonly task: string;
  /** Retries so far: 0 for the agent's first reply. */
  readonly attempt: number;
}

/** What a verdict may carry for reports: named numbers, texts or flags. */
export type JudgeMetrics = Readonly<Record<string, number | string | boolean>>;

declare const judgeVerdict: unique symbol;

/** Only `JudgeVerdict.passed(…)` / `JudgeVerdict.failed(…)` build a verdict (one way, S115). */
interface BuiltVerdict {
  readonly [judgeVerdict]: true;
}

/** A passed verdict: the reply stands. */
export interface PassedJudgeVerdict extends BuiltVerdict {
  readonly passed: true;
  /** What the judge measured, for reports. */
  readonly metrics?: JudgeMetrics;
}

/** A failed verdict: its `reason` goes back to the agent for its retry. */
export interface FailedJudgeVerdict extends BuiltVerdict {
  readonly passed: false;
  /** What is wrong with the reply: the agent reads it before its retry. */
  readonly reason: string;
  /** What the judge measured, for reports. */
  readonly metrics?: JudgeMetrics;
}

/** A judge's verdict, built with `JudgeVerdict.passed(…)` or `JudgeVerdict.failed(…)`. */
export type JudgeVerdict = PassedJudgeVerdict | FailedJudgeVerdict;

/** `JudgeVerdict.passed({ metrics? })` — the options of a passed verdict. */
export interface PassedJudgeVerdictOptions {
  /** What the judge measured, for reports. */
  readonly metrics?: JudgeMetrics;
}

/** `JudgeVerdict.failed({ reason, metrics? })` — the options of a failed verdict. */
export interface FailedJudgeVerdictOptions {
  /** What is wrong with the reply: the agent reads it before its retry. */
  readonly reason: string;
  /** What the judge measured, for reports. */
  readonly metrics?: JudgeMetrics;
}

const metricsOf = (metrics: JudgeMetrics | undefined): { readonly metrics?: JudgeMetrics } =>
  metrics === undefined ? {} : { metrics: Object.freeze({ ...metrics }) };

/** The only way to build a verdict (#262 S115). */
export const JudgeVerdict = {
  /** The reply passes this judge. */
  passed(options: PassedJudgeVerdictOptions = {}): PassedJudgeVerdict {
    const verdict = { passed: true, ...metricsOf(options.metrics) } as const;
    return Object.freeze(verdict) as PassedJudgeVerdict;
  },
  /** The reply fails this judge: `reason` goes back to the agent for its retry. */
  failed(options: FailedJudgeVerdictOptions): FailedJudgeVerdict {
    const verdict = {
      passed: false,
      reason: options.reason,
      ...metricsOf(options.metrics),
    } as const;
    return Object.freeze(verdict) as FailedJudgeVerdict;
  },
} as const;

/** What a `@Judge` class implements: `JudgeHandler<JobReportDto>` judges a `JobReportDto` reply. */
export interface JudgeHandler<TReply> {
  /** Judges one reply of the agent: `JudgeVerdict.passed(…)` or `JudgeVerdict.failed({ reason })`. */
  judge: (input: JudgeInput<TReply>) => Promise<JudgeVerdict>;
}

/** What `judges: [...]` takes: `@Judge` classes, whatever reply they judge. */
export type JudgeHandlerClass = Class<JudgeHandler<never>>;

/** The reply a judge class judges: `JobReportDto` for `implements JudgeHandler<JobReportDto>`. */
export type JudgeReplyOf<TJudge extends JudgeHandlerClass> =
  InstanceType<TJudge> extends JudgeHandler<infer TReply> ? TReply : never;

/** `@Judge({ … })`'s options: its settings, what it judges and its constructor's dependencies. */
export interface JudgeOptions<
  TReply extends JudgeReplyShape,
  D extends readonly Token[],
> extends JudgeMeta<TReply> {
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: D;
}

/**
 * A quality gate of an agent's reply (`@Agent({ judges: [...], maxRetries })`), created by the
 * workflow's container with its `deps`; its model calls go through the model gateway.
 */
export function Judge<const TReply extends JudgeReplyShape, const D extends readonly Token[] = []>(
  options: JudgeOptions<TReply, D>,
) {
  return <C extends new (...args: ResolvedAll<D>) => JudgeHandler<ValueOf<TReply>>>(
    value: C,
  ): C => {
    recordComponent(value, { kind: "judge", meta: { ...options, deps: options.deps ?? [] } });
    return value;
  };
}
