import type { Class } from "../components/injection.js";
import type { ErrorClass, FlowPath, NodeKind, SubPath } from "./ast.js";
import type {
  GeneratedTypeError,
  InputOf,
  KindOf,
  MissingGeneratedTypes,
  NameOf,
  NoOutput,
  ProducerOutputOf,
} from "./generated-types.js";
import type { Skip } from "./parallel-step.js";
import type { ChooseManyOf, ParallelLaunches } from "./launch-types.js";
import type { SideClaimsOf, OneOfCheck, WithFinishes } from "./one-of-types.js";
import type { RouteMore, RoutesOf } from "./route-types.js";
import type { ClassOf, TargetRef } from "./target-ref.js";

/**
 * The types of the path builder (#272 S3). A builder carries, in its type, how its path starts
 * (`SourceHead` for a flow path, `SideHead` for sub-paths) and the
 * value the chain carries; each state offers only the steps the grammar allows there. Kinds,
 * what a step gives (#1270: derived from its declaration) are checked against the
 * generated `.agboss/types.d.ts`.
 */

declare const pathHead: unique symbol;
declare const pathValue: unique symbol;

export interface SourceHead {
  readonly source: true;
}
/**
 * A side path (`.onError`, `.toOneOf`, `.onFinish`, `.onRoute`): `TClaims` are the DTOs its entry consumer
 * reads — `never` while no step that reads anything was entered (#1275c), `unknown` for any side path;
 * `TStart` is the class it starts with (#1278).
 */
export interface SideHead<TClaims = unknown, TStart = unknown> {
  readonly side: true;
  readonly claims?: TClaims;
  /** The class the side path starts with (`toAgent(A)…` → `typeof A`): what `.onRoute(…)` subtracts. */
  readonly start?: TStart;
}
export type PathHead = SourceHead | SideHead;

/** A path as built so far: a `FlowPath` from a source, a `SubPath` otherwise, its head in its type. */
export type BuiltPath<THead extends PathHead> = (THead extends SourceHead ? FlowPath : SubPath) & {
  readonly [pathHead]?: THead;
};

/** Any side path of `.onError(…)`. */
export type SidePath = BuiltPath<SideHead>;

/** How a message names each kind. */
export interface KindLabels {
  [NodeKind.Start]: "a workflow start";
  [NodeKind.Finish]: "a workflow finish";
  [NodeKind.Agent]: "an agent";
  [NodeKind.Action]: "an action";
  [NodeKind.Router]: "a router";
  [NodeKind.Workflow]: "a workflow";
  [NodeKind.Question]: "a question role";
}

export type KindLabel<TKind extends NodeKind> = KindLabels[TKind];

export interface WrongKind<TName extends string, TLabel extends string> {
  readonly __error: `${TName} is not ${TLabel}`;
}

/** `unknown` when the class is a branded component of the kind, else a readable error type. */
export type KindCheck<TClass extends Class, TKind extends NodeKind, TLabel extends string> = [
  NameOf<InstanceType<TClass>>,
] extends [never]
  ? MissingGeneratedTypes
  : [KindOf<InstanceType<TClass>>] extends [never]
    ? WrongKind<NameOf<InstanceType<TClass>>, TLabel>
    : [KindOf<InstanceType<TClass>>] extends [TKind]
      ? unknown
      : WrongKind<NameOf<InstanceType<TClass>>, TLabel>;

/**
 * The generated input of a target, when it reports a problem (`[input.missing-on-path]`, …); a
 * workflow launching itself (`toWorkflow(() => Self)`, #1287) is checked like any other child.
 */
export type InputCheck<TInstance> = [InputOf<TInstance>] extends [GeneratedTypeError]
  ? InputOf<TInstance>
  : unknown;

/** A transition's target: the right kind, and an input the paths into it can fill. */
export type TargetCheck<TClass extends Class, TKind extends NodeKind, TLabel extends string> =
  KindCheck<TClass, TKind, TLabel> extends infer TResult
    ? unknown extends TResult
      ? InputCheck<InstanceType<TClass>>
      : TResult
    : never;

/** The head after entering `TInstance`: a side path still without claims takes this step's. */
export type NextHead<THead extends PathHead, TInstance> =
  THead extends SideHead<infer TClaims, infer TStart>
    ? [TClaims] extends [never]
      ? SideHead<SideClaimsOf<TInstance>, TStart>
      : THead
    : THead;

/** The claims of a side path built by the starters (`toAction(X)…`). */
export type ClaimsOfPath<TPath> = TPath extends { readonly [pathHead]?: SideHead<infer TClaims> }
  ? TClaims
  : never;

/** The class a side path starts with (`toAgent(A)…` → `typeof A`); `never` for any other path. */
export type StartOfPath<TPath> = TPath extends {
  readonly [pathHead]?: SideHead<unknown, infer TStart>;
}
  ? TStart
  : never;

/** After a step (a transition or a path source): what its kind and output allow. */
export type AfterStep<TInstance, THead extends PathHead> = BuiltPath<THead> &
  StepContinuation<TInstance, THead>;

export type StepContinuation<TInstance, THead extends PathHead> = [KindOf<TInstance>] extends [
  never,
]
  ? Transitions<THead>
  : [KindOf<TInstance>] extends [NodeKind.Router]
    ? RouterStep<THead, TInstance> & ChooseManyOf<THead, TInstance>
    : [KindOf<TInstance>] extends [NodeKind.Start]
      ? ValueContinuation<ProducerOutputOf<TInstance>, THead>
      : ErrorHandling<TInstance, THead> &
          SkipOf<TInstance, THead> &
          OutputContinuation<ProducerOutputOf<TInstance>, THead> &
          WithFinishes<TInstance, THead>;

/** Whether an output is a `oneOf(…)`: a union of two or more DTOs, not a list or a single DTO. */
export type IsOneOf<TOutput> = [TOutput] extends [readonly unknown[]]
  ? false
  : true extends IsUnion<Exclude<TOutput, undefined>>
    ? true
    : false;

export type IsUnion<TValue, TAll = TValue> = TValue extends unknown
  ? [TAll] extends [TValue]
    ? false
    : true
  : never;

/**
 * After the value a step gives (#1270: derived from its declaration — nothing is written for it):
 * a `oneOf(…)` is branched by `.toOneOf([…])`, any other goes on with a transition or a launch (#273).
 */
export type ValueContinuation<TValue, THead extends PathHead> =
  IsOneOf<TValue> extends true
    ? BuiltPath<THead> & Switching<TValue, THead>
    : AfterValue<TValue, THead>;

/** After a step with `output`: what it gives; one without goes on at once (#273). */
export type OutputContinuation<TOutput, THead extends PathHead> = [TOutput] extends [
  GeneratedTypeError,
]
  ? TOutput
  : [TOutput] extends [NoOutput]
    ? Transitions<THead> & ParallelLaunches<never, THead>
    : ValueContinuation<TOutput, THead>;

/** After a value: the next transition, or a parallel launch (#273). */
export type AfterValue<TValue, THead extends PathHead> = BuiltPath<THead> &
  Transitions<THead> &
  ParallelLaunches<TValue, THead> & { readonly [pathValue]?: TValue };

export interface Transitions<THead extends PathHead> {
  toAgent<const TClass extends Class>(
    target: TClass & TargetCheck<TClass, NodeKind.Agent, KindLabel<NodeKind.Agent>>,
  ): AfterStep<InstanceType<TClass>, NextHead<THead, InstanceType<TClass>>>;
  toRouter<const TClass extends Class>(
    target: TClass & TargetCheck<TClass, NodeKind.Router, KindLabel<NodeKind.Router>>,
  ): AfterStep<InstanceType<TClass>, NextHead<THead, InstanceType<TClass>>>;
  toAction<const TClass extends Class>(
    target: TClass & TargetCheck<TClass, NodeKind.Action, KindLabel<NodeKind.Action>>,
  ): AfterStep<InstanceType<TClass>, NextHead<THead, InstanceType<TClass>>>;
  toFinish<const TClass extends Class>(
    target: TClass & TargetCheck<TClass, NodeKind.Finish, KindLabel<NodeKind.Finish>>,
  ): BuiltPath<NextHead<THead, InstanceType<TClass>>>;
  /**
   * A question role's step (#659): it reads the role's `ask` from the path, pauses on the role's
   * channel and gives its `answer`; `.onError(…)` right after takes a failed `send`.
   */
  toExternalTask<const TClass extends Class>(
    target: TClass & TargetCheck<TClass, NodeKind.Question, KindLabel<NodeKind.Question>>,
  ): AfterStep<InstanceType<TClass>, NextHead<THead, InstanceType<TClass>>>;
  /**
   * One child execution of `W` (#263) — the class, or `() => W` for one declared below (#1287, its own
   * `@Workflow` included): it enters through the start whose input takes the chain's value, gives one of its finishes' outputs — one class, or a `oneOf(…)` and a `.onFinish(F, …)` per finish — and its failure is caught by `.onError(…)` right after.
   */
  toWorkflow<const TRef extends TargetRef>(
    target: TRef & TargetCheck<ClassOf<TRef>, NodeKind.Workflow, KindLabel<NodeKind.Workflow>>,
  ): AfterStep<InstanceType<ClassOf<TRef>>, NextHead<THead, InstanceType<ClassOf<TRef>>>>;
}

export interface Switching<TOutput, THead extends PathHead> {
  /**
   * One side path per variant of the `oneOf(…)` the step gives (#1275): no DTO is named, each
   * branch takes the variant its entry consumer reads.
   */
  toOneOf<const TBranches extends readonly [SidePath, SidePath, ...SidePath[]]>(
    branches: TBranches & OneOfCheck<TBranches, TOutput>,
  ): BuiltPath<THead>;
}

/** `.onError(E, toAction(X)…)` right after the step that throws; the main path goes on. */
export interface ErrorHandling<TInstance, THead extends PathHead> {
  onError(error: ErrorClass, path: SidePath): AfterStep<TInstance, THead>;
}

/** `.onError(E, skip())` after the step of a branch of `.inParallel([…])` / `.forEachItem(…)` (#1279). */
export interface SkipHandling<TInstance, THead extends PathHead> {
  onError(error: ErrorClass, path: Skip): AfterStep<TInstance, THead>;
}

/** A side path's step offers `skip()` too; a flow path's does not. */
export type SkipOf<TInstance, THead extends PathHead> = THead extends SideHead
  ? SkipHandling<TInstance, THead>
  : unknown;

/**
 * After a router: its `.onError(…)`, then its choice — `.onRoute(subPath)` once per route (#1278). `TRemaining` are the routes not yet named.
 */
export interface RouterStep<
  THead extends PathHead,
  TInstance = unknown,
  TRemaining = RoutesOf<TInstance>,
> extends RouteMore<THead, TRemaining> {
  onError(
    error: ErrorClass,
    path: SidePath,
  ): BuiltPath<THead> & RouterStep<THead, TInstance, TRemaining>;
}
