import "../../polyfills/symbol-metadata.js";
import { callerFile } from "../../components/call-site.js";
import type { Class, ResolvedAll, Token } from "../../components/injection.js";
import { METADATA_KEY } from "../../polyfills/symbol-metadata.js";
import type { ComponentClass, NodeKind } from "../ast.js";
import type { KindCheck, KindLabel } from "../builder-types.js";
import type { ProducerOutputOf } from "../generated-types.js";
import { FlowSyntaxError } from "../launch-step.js";
import { DecidedBy } from "./router.js";

/**
 * `@Arbiter` (#279): decides whether an arriving answer of a parallel launch counts for its quorum
 * — once per answer; it never chooses where the execution goes. Attached with `.acceptedBy(X)`
 * between the launch and `.joinQuorum(…)` / `.joinQuorumGroups(…)`. How it decides is declared with
 * `decidedBy`: `DecidedBy.Model` — its `model` judges each answer by the `criteria` of the agent that
 * gave it (`prompt` says how); `DecidedBy.Code` — one `@OnAnswer(Agent)` method per agent of the
 * launch, taking the plain answer. Every agent of the launch is covered (`[arbiter.unhandled-agent]`).
 */

/** What a model arbiter checks in one agent's answers (every copy, every item). */
export interface ArbiterCriterion {
  readonly agent: ComponentClass;
  readonly prompt: string;
}

/** `@Arbiter({ decidedBy: DecidedBy.Model })`: one decision per answer, by its agent's criterion. */
export interface ModelArbiterOptions {
  /** Ends with `-arbiter` (`valid-score-arbiter`). */
  readonly name: string;
  readonly decidedBy: DecidedBy.Model;
  /** A decision model (Jev, …) or a chat model. */
  readonly model: string;
  /** How to judge; never stands in for a missing criterion. */
  readonly prompt: string;
  /** One per agent of the launch it is attached to. */
  readonly criteria: readonly [ArbiterCriterion, ...ArbiterCriterion[]];
  readonly deps?: never;
}

/** `@Arbiter({ decidedBy: DecidedBy.Code })`: one `@OnAnswer(Agent)` method per agent. */
export interface CodeArbiterOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Ends with `-arbiter` (`good-score-arbiter`). */
  readonly name: string;
  readonly decidedBy: DecidedBy.Code;
  /** Constructor dependencies, in order (`[ExecutionContext]` for the copy / item); compiler-checked. */
  readonly deps?: TDeps;
  readonly model?: never;
  readonly prompt?: never;
  readonly criteria?: never;
}

/** `@Arbiter` options: a union discriminated by `decidedBy`. */
export type ArbiterOptions = ModelArbiterOptions | CodeArbiterOptions;

/** One `@OnAnswer(Agent)` method as recorded: its name and the agent whose answers it judges. */
export interface AnswerMethod {
  readonly method: string;
  readonly agent: ComponentClass;
}

/** What `@Arbiter` recorded on a class: its options and the file it is declared in. */
export interface ArbiterDeclaration {
  readonly options: ArbiterOptions;
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

/** An arbiter its model decides (`DecidedBy.Model`): `criteria` per agent. */
export function Arbiter(options: ModelArbiterOptions): ArbiterDecorator<[]>;
/** An arbiter its class decides (`DecidedBy.Code`): `@OnAnswer(Agent)` methods, `deps` in its constructor. */
export function Arbiter<const TDeps extends readonly Token[] = []>(
  options: CodeArbiterOptions<TDeps>,
): ArbiterDecorator<TDeps>;
export function Arbiter(options: ArbiterOptions): <TClass extends Class>(value: TClass) => TClass {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    arbiters.set(value, source === undefined ? { options } : { options, source });
    return value;
  };
}

/** What `@Arbiter` recorded on a class; undefined for an undecorated one. */
export const arbiterOf = (arbiter: Class): ArbiterDeclaration | undefined => arbiters.get(arbiter);

/** Whether an arbiter is decided by code. */
export const isCodeArbiter = (options: ArbiterOptions): options is CodeArbiterOptions =>
  options.decidedBy === DecidedBy.Code;

/** The answer an `@OnAnswer(Agent)` method takes: the agent's output as a plain DTO. */
export type ArbiterAnswerOf<TAgent extends Class> = ProducerOutputOf<InstanceType<TAgent>>;

/** What a method judging `TAgent`'s answers is: one parameter, the answer; whether it counts. */
export type AnswerJudgement<This, TAgent extends Class> = (
  this: This,
  answer: ArbiterAnswerOf<TAgent>,
) => boolean | Promise<boolean>;

/** The method decorator `@OnAnswer(Agent)` returns. */
export type OnAnswerDecorator<TAgent extends Class> = <This>(
  value: AnswerJudgement<This, TAgent>,
  context: ClassMethodDecoratorContext<This, AnswerJudgement<This, TAgent>> & {
    readonly static: false;
  },
) => void;

/**
 * `@OnAnswer(ScoreAAgent) fromScoreA(answer: ScoreDto): boolean` (#279): the method judging that
 * agent's answers — exactly one agent class; a wrong answer type, a wrong return type or an extra
 * required parameter does not compile. Which copy or item it is comes from `ExecutionContext`.
 */
export function OnAnswer<const TAgent extends Class>(
  agent: TAgent & KindCheck<TAgent, NodeKind.Agent, KindLabel<NodeKind.Agent>>,
): OnAnswerDecorator<TAgent> {
  return (_value, context) => {
    const { metadata } = context;
    if (metadata === undefined)
      throw new FlowSyntaxError(
        `@OnAnswer on ${String(context.name)}: decorator metadata is missing — import "@agboss/core" first`,
      );
    const methods = answerMethods.get(metadata) ?? [];
    answerMethods.set(metadata, [...methods, { method: String(context.name), agent }]);
  };
}

/** The `@OnAnswer(…)` methods of an arbiter class, in declaration order. */
export function answerMethodsOf(arbiter: Class): readonly AnswerMethod[] {
  const metadata: unknown = Reflect.get(arbiter, METADATA_KEY);
  return typeof metadata === "object" && metadata !== null
    ? (answerMethods.get(metadata) ?? [])
    : [];
}
