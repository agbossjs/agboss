import type { BaseMessageLike } from "@langchain/core/messages";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../llm/decisions.js";
import type { DtoClass } from "../dto/types.js";
import type { ListWrapper, OneOfWrapper, ValueOf, VariantOf } from "../flow/dto-wrappers.js";
import { recordComponent } from "./metadata.js";
import type { Class, ResolvedAll, Token } from "./injection.js";

/**
 * What a judge judges (#262 S115) — every shape an agent's `output` can have: one DTO class,
 * `oneOf(A, B)` (the reply is `A | B`, told apart by `variant`), `listOf(XDto)` (a `readonly` list),
 * `listOf(oneOf(A, B))` (a `readonly` list of `VariantOf<A | B>`) or `PlainTextDto` for a text
 * agent's reply (`{ text }`). The agent's output has the same shape and
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
 * `deps: [ExecutionContext]`, the agent as its `step.component`): `reply` — the agent's answer,
 * validated, a value of the judge's `reply` (`{ text }` for a text agent); `variant` — the class it
 * validated as (#262 S125), the class of the answer tool the agent used, never guessed from the
 * answer's shape; `task` — the run's task (the agent's input message); `attempt` — retries so far,
 * 0 for the agent's first reply.
 *
 * For a `oneOf(A, B)` reply a discriminated union on `variant`: `isVariant(input, A)` narrows
 * `reply` to `A`. A single DTO, `listOf(XDto)` or `PlainTextDto` judge has `variant` as that one
 * class; a `listOf(oneOf(A, B))` judge reads `reply: readonly VariantOf<A | B>[]`, each item with its
 * own `variant`, and has no `variant` of its own.
 */
export type JudgeInput<TReply> = TReply extends readonly VariantOf<unknown>[]
  ? { readonly reply: TReply; readonly task: string; readonly attempt: number }
  : TReply extends readonly (infer TItem)[]
    ? {
        readonly variant: DtoClass<TItem>;
        readonly reply: TReply;
        readonly task: string;
        readonly attempt: number;
      }
    : TReply extends unknown
      ? {
          readonly variant: DtoClass<TReply>;
          readonly reply: TReply;
          readonly task: string;
          readonly attempt: number;
        }
      : never;

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

/** Any judge's input as the agent's loop builds it (internal): one class, or items of several. */
export type AnyJudgeInput = JudgeInput<unknown> | JudgeInput<readonly VariantOf<unknown>[]>;

/** A judge's instance as the agent's loop calls it (internal), whatever reply it judges. */
export interface RunnableJudge {
  readonly judge: (input: AnyJudgeInput) => Promise<JudgeVerdict>;
}

/**
 * A judge as an agent's loop runs it (internal): its instance, created by the container, and what
 * it judges (`@Judge({ reply })`) — the shape of the input it is given (#262 S125).
 */
export interface JudgeInstance {
  readonly handler: RunnableJudge;
  readonly reply: JudgeReplyShape;
}

/** What `judges: [...]` takes: `@Judge` classes, whatever reply they judge. */
export type JudgeHandlerClass = Class<JudgeHandler<never>>;

/** The input a judge class reads: its `judge(input)`'s parameter. */
export type JudgeInputOf<TJudge extends JudgeHandlerClass> = Parameters<
  InstanceType<TJudge>["judge"]
>[0];

/** The reply a judge class judges: `JobReportDto` for `implements JudgeHandler<JobReportDto>`. */
export type JudgeReplyOf<TJudge extends JudgeHandlerClass> =
  JudgeInputOf<TJudge> extends { readonly reply: infer TReply } ? TReply : never;

/**
 * The value a judge of a `reply` shape reads: the shape's value (`ValueOf`), except a
 * `listOf(oneOf(A, B))`, whose items are `VariantOf<A | B>` — each with the class it validated as.
 */
export type JudgedValueOf<TShape extends JudgeReplyShape> =
  TShape extends ListWrapper<OneOfWrapper<infer TVariants>>
    ? readonly VariantOf<InstanceType<TVariants[number]>>[]
    : ValueOf<TShape>;

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
  return <C extends new (...args: ResolvedAll<D>) => JudgeHandler<JudgedValueOf<TReply>>>(
    value: C,
  ): C => {
    recordComponent(value, { kind: "judge", meta: { ...options, deps: options.deps ?? [] } });
    return value;
  };
}
