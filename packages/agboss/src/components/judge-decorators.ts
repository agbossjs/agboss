import { recordOptionKeys } from "./option-keys.js";
import { JUDGE_KEYS } from "./decorator-options.js";
import type { ModelMessage } from "../models/messages.js";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../llm/decisions.js";
import type { DtoClass } from "../dto/types.js";
import type { ToolCallRecord } from "../flow/runtime/tool-calls.js";
import type { FileContent } from "../files/file-bytes.js";
import type { ListWrapper, OneOfWrapper, ValueOf, VariantOf } from "../flow/dto-wrappers.js";
import type {
  AGBossTypes,
  GeneratedEntry,
  InstanceOrSelf,
  MissingGeneratedTypes,
  NameOf,
} from "../flow/generated-types.js";
import { resolvedName } from "../flow/names.js";
import { recordComponent } from "./metadata.js";
import { callerFile } from "./call-site.js";
import type { DeclarativeJudgeClass, ModelJudgeOptions } from "./judge-declaration.js";
import type { PromptSource } from "./prompt-source.js";
import type { Class, ResolvedAll, Token } from "./injection.js";

/**
 * What a judge judges (#262 S115) — every shape an agent's `output` can have: one DTO class,
 * `oneOf(A, B)` (the output is `A | B`, told apart by `variant`), `listOf(XDto)` (a `readonly` list),
 * `listOf(oneOf(A, B))` (a `readonly` list of `VariantOf<A | B>`) or `PlainTextDto` for a text
 * agent's reply (`{ text }`). The agent's output has the same shape and
 * every class it may answer with is one of the judge's, else `[judge.wrong-output]`.
 */
export type JudgeOutputShape = DtoClass | OneOfWrapper | ListWrapper;

/**
 * `@Judge({ … })`'s options of a judge that decides by its class's `judge(input)`: by code alone
 * (`$0`, no model call), or — with `JudgeModel` in `deps` — by code and its own model (hybrid).
 * Without `JudgeModel` in `deps` a `model` / `modelProvider` does not compile.
 */
export interface CodeJudgeOptions<
  TOutput extends JudgeOutputShape = JudgeOutputShape,
  TDeps extends readonly Token[] = readonly Token[],
> {
  /**
   * Unique in the workflow: the judge's settings key (`judges.<name>`) and its cost caller
   * (`judge:<name>`); the class name in kebab-case when left out (`JobReport` → `job-report`).
   */
  readonly name?: string;
  /** What it judges: the agent's answer as this DTO (`judge(input)`'s `output`). */
  readonly output: TOutput;
  readonly description?: string;
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: TDeps;
  /** A judge with its own model does not declare a `prompt`: its class asks `JudgeModel`. */
  readonly prompt?: never;
}

/** The `model` / `modelProvider` a judge may name: only one that injects `JudgeModel` has a model. */
export type HybridJudgeModelOptions<TDeps extends readonly Token[]> = [
  Extract<TDeps[number], typeof JudgeModel>,
] extends [never]
  ? { readonly model?: never; readonly modelProvider?: never }
  : {
      /**
       * The judge's own model: a chat model (`judgeModel.invoke`) or a decision model such as
       * `openai/gpt-6-luna-decisions` (`judgeModel.decide`); a role of its provider when left out.
       */
      readonly model?: string;
      /** The `@ModelProvider` that serves it: its workflow's, its application's when left out. */
      readonly modelProvider?: Class;
    };

/** `@Judge` — a quality gate of an agent's output: decided by code, or by code and its own model. */
export type JudgeOptions<TOutput extends JudgeOutputShape = JudgeOutputShape> =
  CodeJudgeOptions<TOutput> & {
    readonly model?: string;
    readonly modelProvider?: Class;
  };

/** What `@Judge` recorded on a class: its options with the name and `deps` resolved. */
export type JudgeRecord = Omit<JudgeOptions, "name" | "deps" | "prompt"> & {
  readonly name: string;
  readonly deps: readonly Token[];
  /** A declarative model judge's criterion, as written. */
  readonly prompt?: PromptSource;
  /** A declarative model judge's pass score, in `(0, 1]`. */
  readonly threshold?: number;
  /** The file that declared it (where `./` prompt files are read from). */
  readonly source?: string;
};

/** Whether a judge is declarative (#1290): an empty class with a `prompt`, decided by its model alone. */
export const isDeclarativeJudge = (meta: Pick<JudgeRecord, "prompt">): boolean =>
  meta.prompt !== undefined;

/**
 * Whether a judge decides by its class's code alone: it injects no `JudgeModel` and is not
 * declarative (a declarative judge always has its model).
 */
export const isCodeJudge = (meta: Pick<JudgeRecord, "deps" | "prompt">): boolean =>
  !isDeclarativeJudge(meta) && !meta.deps.includes(JudgeModel);

/**
 * The judge's own model (`@Judge({ model })`), through the model gateway: every call is in the
 * run's cost report. Injected through the constructor (`deps: [JudgeModel]`, #280); each call goes
 * to the model of the judge whose `judge()` is running.
 */
export abstract class JudgeModel {
  /** The model id (`@Judge({ model })`). */
  abstract readonly model: string;
  /** One chat call; returns the reply's text. On a decision model: `ModelKindError`. */
  abstract invoke(input: string | readonly ModelMessage[]): Promise<string>;
  /**
   * One decision (questions from `Decision.choice / boolean / score`), its answers typed by them. On a
   * chat model: `ModelKindError`.
   */
  abstract decide<const Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
  ): Promise<AnswersOf<Q>>;
}

/**
 * What a judge judges (#280: data only, no context — the execution comes through
 * `deps: [ExecutionContext]`, the agent as its `step.component`): `output` — the agent's answer,
 * validated, a value of the judge's `output` (`{ text }` for a text agent); `variant` — the class it
 * validated as (#262 S125), the class of the answer tool the agent used, never guessed from the
 * answer's shape; `task` — the run's task (the agent's input message); `attempt` — retries so far,
 * 0 for the agent's first reply; `toolCalls` — the agent's tool calls in this visit, every attempt's,
 * in call order (#395: `toolCallsOf(Tool, toolCalls)` types one tool's), with real values; `files` —
 * what the model read of files (#899).
 *
 * `T` is the `@Judge` class itself (`JudgeInput<Self>`, its `output` read from the generated
 * `AGBossTypes.JudgeOutputs`), or the output value it judges (`JudgeInput<PlainTextDto>`, for a
 * library with no generated types).
 *
 * For a `oneOf(A, B)` output a discriminated union on `variant`: `isVariant(input, A)` narrows
 * `output` to `A`. A single DTO, `listOf(XDto)` or `PlainTextDto` judge has `variant` as that one
 * class; a `listOf(oneOf(A, B))` judge reads `output: readonly VariantOf<A | B>[]`, each item with its
 * own `variant`, and has no `variant` of its own.
 */
export type JudgeInput<T> = JudgedOutput<JudgeOutputValueOf<T>>;

/**
 * The output value a `JudgeInput<T>` reads: the `JudgeOutputs` entry of a `@Judge` class (named by
 * its generated brand), `MissingGeneratedTypes` for a judge class before `agboss check`, else `T`
 * itself — the output value a library without generated types names.
 */
export type JudgeOutputValueOf<T> = [NameOf<InstanceOrSelf<T>>] extends [never]
  ? false extends (
      InstanceOrSelf<T> extends infer TInstance
        ? TInstance extends unknown
          ? // a `judge` method, or no members at all (a declarative judge): a judge, not a DTO value
            "judge" extends keyof TInstance
            ? true
            : [keyof TInstance] extends [never]
              ? true
              : false
          : never
        : never
    )
    ? T
    : MissingGeneratedTypes
  : GeneratedEntry<AGBossTypes.JudgeOutputs, InstanceOrSelf<T>>;

/**
 * What a judge reads of a value of its `output`, in the shape of that output: the output itself, the
 * run's task, the retry count and the visit's trajectory — `toolCalls` and `files`. One interface for
 * a code judge's `judge(input)` and a declarative judge's model alike.
 */
export type JudgedOutput<TOutput> = TOutput extends readonly VariantOf<unknown>[]
  ? JudgedBase & { readonly output: TOutput }
  : TOutput extends readonly (infer TItem)[]
    ? JudgedBase & { readonly variant: DtoClass<TItem>; readonly output: TOutput }
    : TOutput extends unknown
      ? JudgedBase & { readonly variant: DtoClass<TOutput>; readonly output: TOutput }
      : never;

export interface JudgedBase {
  readonly task: string;
  readonly attempt: number;
  readonly toolCalls: readonly ToolCallRecord[];
  /**
   * The files the agent's model read in this visit (#899 §8), in the views it got them — an original
   * as the file, a transcription as a `text/plain` file of its masked text; none for an agent without
   * `files`. A judge's own model reads them too: `judgeModel.invoke` and `judgeModel.decide` carry them
   * as parts of their input.
   */
  readonly files: readonly FileContent[];
}

/** What a verdict may carry for reports: named numbers, texts or flags. */
export type JudgeMetrics = Readonly<Record<string, number | string | boolean>>;

declare const judgeVerdict: unique symbol;

/** A passed verdict: the reply stands. */
export interface PassedJudgeVerdict {
  /** A mark only `JudgeVerdict.passed` / `.failed` give. */
  readonly [judgeVerdict]: true;
  readonly passed: true;
  /** What the judge measured, for reports. */
  readonly metrics?: JudgeMetrics;
}

/** A failed verdict: its `reason` goes back to the agent for its retry. */
export interface FailedJudgeVerdict {
  /** A mark only `JudgeVerdict.passed` / `.failed` give. */
  readonly [judgeVerdict]: true;
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

/** `JudgeVerdict.failed(reason, { metrics? })` — the options of a failed verdict. */
export interface FailedJudgeVerdictOptions {
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
  failed(reason: string, options: FailedJudgeVerdictOptions = {}): FailedJudgeVerdict {
    const verdict = {
      passed: false,
      reason,
      ...metricsOf(options.metrics),
    } as const;
    return Object.freeze(verdict) as FailedJudgeVerdict;
  },
} as const;

/** What a `@Judge` class with a `judge(input)` reads: `JudgeHandler<JobReportDto>` judges a `JobReportDto` output. */
export interface JudgeHandler<TOutput> {
  /** Judges one output of the agent: `JudgeVerdict.passed(…)` or `JudgeVerdict.failed(reason)`; sync or async. */
  judge: (input: JudgeInput<TOutput>) => JudgeVerdict | Promise<JudgeVerdict>;
}

/** Any judge's input as the agent's loop builds it (internal): one class, or items of several. */
export type AnyJudgeInput = JudgedOutput<unknown> | JudgedOutput<readonly VariantOf<unknown>[]>;

/** A judge's instance as the agent's loop calls it (internal), whatever output it judges. */
export interface RunnableJudge {
  readonly judge: (input: AnyJudgeInput) => JudgeVerdict | Promise<JudgeVerdict>;
}

/**
 * A judge as an agent's loop runs it (internal): its instance, created by the container, and what
 * it judges (`@Judge({ output })`) — the shape of the input it is given (#262 S125).
 */
export interface JudgeInstance {
  readonly handler: RunnableJudge;
  readonly output: JudgeOutputShape;
  /** Whether it has its own model (`JudgeModel` in its `deps`): a code judge has none (`$0`). */
  readonly hasModel: boolean;
  /** A declarative judge's criterion (#1290): read at assembly; its model decides it. */
  readonly declared?: { readonly prompt: string; readonly threshold?: number };
}

/**
 * The value a judge of an `output` shape reads: the shape's value (`ValueOf`), except a
 * `listOf(oneOf(A, B))`, whose items are `VariantOf<A | B>` — each with the class it validated as.
 */
export type JudgedValueOf<TShape extends JudgeOutputShape> =
  TShape extends ListWrapper<OneOfWrapper<infer TVariants>>
    ? readonly VariantOf<InstanceType<TVariants[number]>>[]
    : ValueOf<TShape>;

/**
 * The output a judge class judges: the value its `judge(input)` reads as `output`, or — for a judge
 * without `judge` — its generated `JudgeOutputs` entry.
 */
export type JudgeOutputOf<TJudge extends Class<object>> = "judge" extends keyof InstanceType<TJudge>
  ? Parameters<
      Extract<InstanceType<TJudge>["judge" & keyof InstanceType<TJudge>], (input: never) => unknown>
    >[0] extends {
      readonly output: infer TOutput;
    }
    ? TOutput
    : never
  : GeneratedEntry<AGBossTypes.JudgeOutputs, InstanceType<TJudge>>;

/** The class `@Judge({ … })` decorates: `judge(input)` reads the declared output. */
export interface JudgeMethod<TOutput extends JudgeOutputShape> {
  judge(input: JudgedOutput<JudgedValueOf<TOutput>>): JudgeVerdict | Promise<JudgeVerdict>;
}

/**
 * A quality gate of an agent's output (`@Agent({ judges: [...], maxRetries })`), created by the
 * workflow's container with its `deps`; its model calls go through the model gateway. An empty class
 * with a `prompt` is a declarative model judge (#1290); a class with `judge(input)` decides by code at
 * `$0`; with `JudgeModel` in `deps` it asks its own model too (hybrid).
 */
export function Judge<const TOutput extends JudgeOutputShape>(
  options: ModelJudgeOptions<TOutput>,
): <C extends Class>(value: DeclarativeJudgeClass<C>) => C;
export function Judge<
  const TOutput extends JudgeOutputShape,
  const TDeps extends readonly Token[] = [],
>(
  options: CodeJudgeOptions<TOutput, TDeps> & HybridJudgeModelOptions<TDeps>,
): <C extends new (...args: ResolvedAll<TDeps>) => JudgeMethod<TOutput>>(value: C) => C;
export function Judge(
  options: Omit<JudgeRecord, "name" | "deps"> & {
    readonly name?: string;
    readonly deps?: readonly Token[];
  },
): <C extends Class>(value: C) => C {
  const source = callerFile();
  return <C extends Class>(value: C): C => {
    recordOptionKeys(value, "Judge", options, JUDGE_KEYS);
    const name = resolvedName(options.name, value);
    recordComponent(value, {
      kind: "judge",
      meta: {
        ...options,
        name,
        deps: options.deps ?? [],
        ...(options.prompt === undefined || source === undefined ? {} : { source }),
      },
    });
    return value;
  };
}
