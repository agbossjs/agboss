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
import type { ChildStepOptions, QuestionStepOptions } from "./child-placement.js";
import type { Launches, RouterLaunches } from "./launch-types.js";
import type { ClassOf, TargetRef } from "./target-ref.js";

/**
 * The types of the path builder (#272 S3). A builder carries, in its type, how its path starts
 * (`SourceHead` for a flow path, `RouteHead` / `CaseHead` / `SideHead` for sub-paths) and the
 * value the chain carries; each state offers only the steps the grammar allows there. Kinds,
 * what a step gives (#1270: derived from its declaration) and `caseOf(…)` are checked against the
 * generated `.agboss/types.d.ts`.
 */

declare const pathHead: unique symbol;
declare const pathValue: unique symbol;

export interface SourceHead {
  readonly source: true;
}
export interface RouteHead {
  readonly route: true;
}
export interface CaseHead<TValue> {
  readonly case: TValue;
}
export interface SideHead {
  readonly side: true;
}
/** A `group(…)` of `.joinQuorumGroups(…)` (#279): the path of the group's own steps. */
export interface GroupHead {
  readonly group: true;
}
export type PathHead = SourceHead | RouteHead | CaseHead<unknown> | SideHead | GroupHead;

/** A path as built so far: a `FlowPath` from a source, a `SubPath` otherwise, its head in its type. */
export type BuiltPath<THead extends PathHead> = (THead extends SourceHead ? FlowPath : SubPath) & {
  readonly [pathHead]?: THead;
};

/** Any route of `.chooseOne(…)`. */
export type RoutePath = BuiltPath<RouteHead>;
/** Any case of `.switch(…)`. */
export type CasePath = BuiltPath<CaseHead<unknown>>;
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

/** The label of a route target. */
export type RouteTargetLabel =
  "a route target (an agent, an action, a router, a child workflow or a finish)";

export type RouteTargetKind =
  NodeKind.Agent | NodeKind.Action | NodeKind.Router | NodeKind.Finish | NodeKind.Workflow;

/**
 * The options a route's target takes (#333 PR 2): a child workflow its `{ placement }`, any other
 * target none.
 */
export type RouteOptions<TClass extends Class> = [KindOf<InstanceType<TClass>>] extends [
  NodeKind.Workflow,
]
  ? readonly [options?: ChildStepOptions]
  : readonly [];

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

/** The values of the cases of a `.switch(…)`. */
export type CaseValueOf<TPath> = TPath extends { readonly [pathHead]?: CaseHead<infer T> }
  ? T
  : never;

/** Whether a path was built from `group(…)…` (#279). */
export type IsGroupPath<TPath> = TPath extends {
  readonly [pathHead]?: GroupHead;
}
  ? true
  : false;

export type SwitchCheck<TCases extends readonly CasePath[], TOutput> = [
  CaseValueOf<TCases[number]>,
] extends [TOutput]
  ? [TOutput] extends [CaseValueOf<TCases[number]>]
    ? unknown
    : { readonly __error: "the switch is not exhaustive — one caseOf(…) per class of the output" }
  : { readonly __error: "a caseOf(…) names a class the step does not give" };

/** After a step (a transition or a path source): what its kind and output allow. */
export type AfterStep<TInstance, THead extends PathHead> = BuiltPath<THead> &
  StepContinuation<TInstance, THead>;

export type StepContinuation<TInstance, THead extends PathHead> = [KindOf<TInstance>] extends [
  never,
]
  ? Transitions<THead>
  : [KindOf<TInstance>] extends [NodeKind.Router]
    ? RouterStep<THead, TInstance>
    : [KindOf<TInstance>] extends [NodeKind.Start]
      ? ValueContinuation<ProducerOutputOf<TInstance>, THead>
      : ErrorHandling<TInstance, THead> & OutputContinuation<ProducerOutputOf<TInstance>, THead>;

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
 * a `oneOf(…)` is branched by `.switch(…)`, any other goes on with a transition or a launch (#273).
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
    ? Transitions<THead> & Launches<never, THead>
    : ValueContinuation<TOutput, THead>;

/** After a value: the next transition, or a parallel launch (#273). */
export type AfterValue<TValue, THead extends PathHead> = BuiltPath<THead> &
  Transitions<THead> &
  Launches<TValue, THead> & { readonly [pathValue]?: TValue };

export interface Transitions<THead extends PathHead> {
  toAgent<const TClass extends Class>(
    target: TClass & TargetCheck<TClass, NodeKind.Agent, KindLabel<NodeKind.Agent>>,
  ): AfterStep<InstanceType<TClass>, THead>;
  toRouter<const TClass extends Class>(
    target: TClass & TargetCheck<TClass, NodeKind.Router, KindLabel<NodeKind.Router>>,
  ): AfterStep<InstanceType<TClass>, THead>;
  toAction<const TClass extends Class>(
    target: TClass & TargetCheck<TClass, NodeKind.Action, KindLabel<NodeKind.Action>>,
  ): AfterStep<InstanceType<TClass>, THead>;
  toFinish<const TClass extends Class>(
    target: TClass & TargetCheck<TClass, NodeKind.Finish, KindLabel<NodeKind.Finish>>,
  ): BuiltPath<THead>;
  /**
   * A question role's step (#659): it reads the role's `ask` from the path, pauses on the role's
   * channel and gives its `answer`; `.onError(…)` right after takes a failed `send`.
   */
  toExternalTask<const TClass extends Class>(
    target: TClass & TargetCheck<TClass, NodeKind.Question, KindLabel<NodeKind.Question>>,
    options?: QuestionStepOptions,
  ): AfterStep<InstanceType<TClass>, THead>;
  /**
   * One child execution of `W` (#263) — the class, or `() => W` for one declared below (#1287, its own
   * `@Workflow` included): it enters through the start whose input takes the chain's value, gives one of its finishes' outputs — one class, or a `oneOf(…)` and a `.switch(…)` with
   * one case per class — and its failure is caught by `.onError(…)` right after.
   */
  toWorkflow<const TRef extends TargetRef>(
    target: TRef & TargetCheck<ClassOf<TRef>, NodeKind.Workflow, KindLabel<NodeKind.Workflow>>,
    options?: ChildStepOptions,
  ): AfterStep<InstanceType<ClassOf<TRef>>, THead>;
}

export interface Switching<TOutput, THead extends PathHead> {
  switch<const TCases extends readonly [CasePath, ...CasePath[]]>(
    ...cases: TCases & SwitchCheck<TCases, TOutput>
  ): BuiltPath<THead>;
}

/** `.onError(E, toAction(X)…)` right after the step that throws; the main path goes on. */
export interface ErrorHandling<TInstance, THead extends PathHead> {
  onError(error: ErrorClass, path: SidePath): AfterStep<TInstance, THead>;
}

/** After a router: its `.onError(…)`, then its choice — `.chooseOne(…)` or a launch (#273). */
export interface RouterStep<
  THead extends PathHead,
  TInstance = unknown,
> extends RouterLaunches<THead> {
  onError(error: ErrorClass, path: SidePath): BuiltPath<THead> & RouterStep<THead, TInstance>;
  chooseOne(...routes: readonly [RoutePath, ...RoutePath[]]): BuiltPath<THead>;
}

/** What `route(X)` continues with: nothing after a finish, else the target's step. */
export type RouteContinuation<TInstance> = [KindOf<TInstance>] extends [NodeKind.Finish]
  ? BuiltPath<RouteHead>
  : AfterStep<TInstance, RouteHead>;
