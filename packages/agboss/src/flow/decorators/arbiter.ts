import { ConfigError } from "../../core/error-families/config-errors.js";
import { recordOptionKeys } from "../../components/option-keys.js";
import { ARBITER_KEYS } from "../../components/decorator-options.js";
import "../../polyfills/symbol-metadata.js";
import type { ModelMessage } from "../../models/messages.js";
import { callerFile } from "../../components/call-site.js";
import type { Class, ResolvedAll, Token } from "../../components/injection.js";
import type { PromptSource } from "../../components/prompt-source.js";
import type { AnswersOf, DecisionQuestions, DecisionRequest } from "../../llm/decisions.js";
import { METADATA_KEY } from "../../polyfills/symbol-metadata.js";
import type { NodeKind } from "../ast.js";
import { resolvedName } from "../names.js";
import type { KindCheck } from "../builder-types.js";
import type { WorkflowFinishTextDto } from "../../dto/standard/framework.js";
import type { KindOf, NoOutput, ProducerOutputOf } from "../generated-types.js";
import type { Tracked } from "../metadata.js";

/**
 * `@Arbiter` (#279, #1283): decides whether an arriving answer of a parallel launch counts for its
 * quorum — once per answer; it never chooses where the execution goes. Attached with
 * `.arbitratedBy(X)` between the launch and `.joinQuorum(…)` / `.joinQuorumGroups(…)`. How it
 * decides follows from what it declares:
 * - `criteria` (+ `prompt`, `model`) — a declarative model arbiter: its model judges each answer by
 *   the criterion of the target that gave it;
 * - `@Arbitrate(…targets)` methods — an arbiter of code (`$0`); with `ArbiterModel` in `deps` also
 *   its own model, asked only where the code needs it.
 * Every target of the launch is covered (`[arbiter.unhandled-target]`).
 */

/** What a model arbiter checks in one target's answers (every copy, every item). */
export interface ArbiterCriterion {
  /** An `@Agent`, `@ExternalTask`, `@Action` or `@Workflow` of the launch. */
  readonly target: Class;
  readonly prompt: string;
}

/** `@Arbiter({ criteria, prompt })`: one decision per answer, by its target's criterion. */
export interface ModelArbiterOptions {
  /** Kebab-case; the class name in kebab-case when left out (`ValidScore` → `valid-score`). */
  readonly name?: string;
  readonly description?: string;
  /**
   * A decision model or a chat model: a vendor name, or a role of its provider (`"fast"`). Left
   * out: the default model of its provider (#1313).
   */
  readonly model?: string;
  /** The `@ModelProvider` class its model is served from; left out: its workflow's, its application's (#1313). */
  readonly modelProvider?: Class;
  /** How to judge: a `.prompt.md` file next to the class (`./…`), `inline(…)` or a list of them; never stands in for a missing criterion. */
  readonly prompt: PromptSource;
  /** One per target of the launch it is attached to. */
  readonly criteria: readonly [ArbiterCriterion, ...ArbiterCriterion[]];
  readonly deps?: never;
}

/**
 * The injectable model of a hybrid arbiter (#1283), through the model gateway: every call is in the
 * run's cost report under `arbiter:<name>`, behind the execution's budget check, its spend kept
 * when the call fails. Injected through the constructor (`deps: [ArbiterModel]`); each call goes to
 * the model of the arbiter whose `@Arbitrate` method is running.
 */
export abstract class ArbiterModel {
  /** The model id (`@Arbiter({ model })`). */
  abstract readonly model: string;
  /** One chat call; returns the reply's text. On a decision model: `ModelKindError`. */
  abstract invoke(input: string | readonly ModelMessage[]): Promise<string>;
  /**
   * One decision (questions from `Decision.choice / boolean / score`), its answers typed by them. On
   * a chat model: `ModelKindError`.
   */
  abstract decide<const Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
  ): Promise<AnswersOf<Q>>;
}

/** The `model` / `modelProvider` an arbiter may name: only one that injects `ArbiterModel` has a model. */
export type HybridArbiterModelOptions<TDeps extends readonly Token[]> = [
  Extract<TDeps[number], typeof ArbiterModel>,
] extends [never]
  ? { readonly model?: never; readonly modelProvider?: never }
  : {
      /** The arbiter's own model: a chat model or a decision model; a role of its provider when left out. */
      readonly model?: string;
      /** The `@ModelProvider` that serves it: its workflow's, its application's when left out. */
      readonly modelProvider?: Class;
    };

/**
 * `@Arbiter({ name?, deps? })` of an arbiter its class decides: `@Arbitrate(…targets)` methods —
 * by code alone (`$0`), or, with `ArbiterModel` in `deps`, by code and its own model.
 */
export interface CodeArbiterOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Kebab-case; the class name in kebab-case when left out (`GoodScore` → `good-score`). */
  readonly name?: string;
  readonly description?: string;
  /** Constructor dependencies, in order (`[ExecutionContext]` for the copy / item); compiler-checked. */
  readonly deps?: TDeps;
  readonly prompt?: never;
  readonly criteria?: never;
}

/** What `@Arbiter` records of a class its code decides. */
export type RecordedCodeArbiterOptions = CodeArbiterOptions & {
  readonly model?: string;
  readonly modelProvider?: Class;
};

/** `@Arbiter` options as recorded: declarative, or by code. */
export type ArbiterOptions = ModelArbiterOptions | RecordedCodeArbiterOptions;

/** One `@Arbitrate(…targets)` method as recorded: its name and the targets whose answers it judges. */
export interface AnswerMethod {
  readonly method: string;
  readonly targets: readonly Class[];
}

/** What `@Arbiter` recorded on a class: its options and the file it is declared in. */
export interface ArbiterDeclaration {
  /** The options, with `name` resolved: given, or the class name in kebab-case. */
  readonly options: ArbiterOptions & { readonly name: string };
  readonly source?: string;
}

const arbiters = new WeakMap<Class, ArbiterDeclaration>();
const answerMethods = new WeakMap<object, AnswerMethod[]>();

/** The decorator of an arbiter; a code arbiter's constructor takes its `deps`. */
export type ArbiterDecorator<TDeps extends readonly Token[]> = <
  TClass extends new (...args: ResolvedAll<TDeps>) => object,
>(
  value: TClass,
) => TClass;

/** An arbiter its model decides: `criteria` per target. */
export function Arbiter(options: ModelArbiterOptions): ArbiterDecorator<[]>;
/** An arbiter its class decides: `@Arbitrate(…targets)` methods, `deps` in its constructor; `ArbiterModel` in `deps` adds a model. */
export function Arbiter<const TDeps extends readonly Token[] = []>(
  options?: CodeArbiterOptions<TDeps> & HybridArbiterModelOptions<TDeps>,
): ArbiterDecorator<TDeps>;
export function Arbiter(
  options: ArbiterOptions = {},
): <TClass extends Class>(value: TClass) => TClass {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    recordOptionKeys(value, "Arbiter", options, ARBITER_KEYS);
    const named = { ...options, name: resolvedName(options.name, value) };
    arbiters.set(value, source === undefined ? { options: named } : { options: named, source });
    return value;
  };
}

/** What `@Arbiter` recorded on a class; undefined for an undecorated one. */
export const arbiterOf = (arbiter: Class): ArbiterDeclaration | undefined => arbiters.get(arbiter);

/** Whether an arbiter is declarative: its model judges by `criteria`. */
export const isDeclarativeArbiter = (options: ArbiterOptions): options is ModelArbiterOptions =>
  options.criteria !== undefined;

/** Whether an arbiter is decided by its class's code (with or without its own model). */
export const isCodeArbiter = (options: ArbiterOptions): options is RecordedCodeArbiterOptions =>
  options.criteria === undefined;

/** Whether an arbiter has a model: a declarative one always, a code one when it injects `ArbiterModel`. */
export const hasArbiterModel = (options: ArbiterOptions): boolean =>
  isDeclarativeArbiter(options) || (options.deps ?? []).includes(ArbiterModel);

/**
 * The answer an `@Arbitrate(Target)` method takes: the target's output as a plain DTO — an
 * `@Agent` without `output` (a text agent) answers with its reply as a `WorkflowFinishTextDto`; an
 * `@ExternalTask` its reply DTO; an `@Workflow` the output of its finishes (#1283b).
 */
export type ArbiterAnswerOf<TTarget extends Class> = [
  ProducerOutputOf<InstanceType<TTarget>>,
] extends [NoOutput]
  ? [KindOf<InstanceType<TTarget>>] extends [NodeKind.Agent]
    ? WorkflowFinishTextDto
    : NoOutput
  : ProducerOutputOf<InstanceType<TTarget>>;

/** What `@Arbitrate(…)` accepts: what a quorum branch is that gives an answer. */
export type ArbitrableKind =
  NodeKind.Agent | NodeKind.Action | NodeKind.Workflow | NodeKind.Question;

/** One target's answer as the method reads it: its output, tracked as given by that target (#1274). */
export type TrackedAnswerOf<TTarget extends Class> =
  ArbiterAnswerOf<TTarget> extends infer TOutput extends object
    ? Tracked<TOutput, TTarget>
    : ArbiterAnswerOf<TTarget>;

/** What a method judging the answers of `TTargets` takes: the union of each target's answer. */
export type ArbitratedAnswerOf<TTargets extends readonly Class[]> = {
  [K in keyof TTargets]: TTargets[K] extends Class ? TrackedAnswerOf<TTargets[K]> : never;
}[number];

/** What a method judging `TTargets`' answers is: one parameter, the answer; whether it counts. */
export type AnswerJudgement<This, TTargets extends readonly Class[]> = (
  this: This,
  answer: ArbitratedAnswerOf<TTargets>,
) => boolean | Promise<boolean>;

/** A void `@Action` (no `output`) gives nothing to judge. */
export interface NoAnswerToJudge {
  readonly __error: "an @Action without an output gives an arbiter nothing to judge — give it an output";
}

/** `unknown` for a target an arbiter may judge, else a readable error type. */
export type ArbitrateCheck<TTarget extends Class> =
  KindCheck<
    TTarget,
    ArbitrableKind,
    "an agent, an external task, an action or a workflow"
  > extends infer TResult
    ? unknown extends TResult
      ? [ArbiterAnswerOf<TTarget>] extends [NoOutput]
        ? NoAnswerToJudge
        : unknown
      : TResult
    : never;

/** Every target of `@Arbitrate(…)` checked. */
export type ArbitrateChecks<TTargets extends readonly Class[]> = {
  [K in keyof TTargets]: TTargets[K] extends Class ? ArbitrateCheck<TTargets[K]> : unknown;
};

/** The method decorator `@Arbitrate(…targets)` returns. */
export type ArbitrateDecorator<TTargets extends readonly Class[]> = <This>(
  value: AnswerJudgement<This, TTargets>,
  context: ClassMethodDecoratorContext<This, AnswerJudgement<This, TTargets>> & {
    readonly static: false;
  },
) => void;

/**
 * `@Arbitrate(SkillsScoreAgent, CultureScoreAgent) isMeaningful(answer: ScoreDto): boolean` (#1283):
 * the method judging those targets' answers — one or more `@Agent` / `@ExternalTask` / `@Action` /
 * `@Workflow` classes; a wrong answer type, a wrong return type or an extra required parameter does
 * not compile. Which copy or item it is comes from `ExecutionContext`; `Metadata.createdBy(answer)`
 * is the target that gave it.
 */
export function Arbitrate<const TTargets extends readonly [Class, ...Class[]]>(
  ...targets: TTargets & ArbitrateChecks<TTargets>
): ArbitrateDecorator<TTargets> {
  return (_value, context) => {
    const { metadata } = context;
    if (metadata === undefined)
      throw new ConfigError.FlowSyntax({
        message: `@Arbitrate on ${String(context.name)}: decorator metadata is missing — import "@agboss/core" first`,
      });
    const methods = answerMethods.get(metadata) ?? [];
    answerMethods.set(metadata, [
      ...methods,
      { method: String(context.name), targets: Object.freeze([...(targets as readonly Class[])]) },
    ]);
  };
}

/** The `@Arbitrate(…)` methods of an arbiter class, in declaration order. */
export function answerMethodsOf(arbiter: Class): readonly AnswerMethod[] {
  const metadata: unknown = Reflect.get(arbiter, METADATA_KEY);
  return typeof metadata === "object" && metadata !== null
    ? (answerMethods.get(metadata) ?? [])
    : [];
}
