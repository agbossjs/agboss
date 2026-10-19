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
import type { DtoClass } from "../dto/types.js";
import type { Launches, RouterLaunches } from "./launch-types.js";
import type { Returning, StepValues, ValuesLeft } from "./returns-types.js";
import type { ThisWorkflowName, ThisWorkflowReturning, WithClaims } from "./this-workflow-types.js";

/**
 * The types of the path builder (#272 S3). A builder carries, in its type, how its path starts
 * (`SourceHead` for a flow path, `RouteHead` / `CaseHead` / `SideHead` for sub-paths) and the
 * value the chain carries; each state offers only the steps the grammar allows there. Kinds,
 * `.returns(…)` and `caseOf(…)` are checked against the generated `.agboss/types.d.ts`.
 */

declare const pathHead: unique symbol;
declare const pathValue: unique symbol;

/**
 * Every head carries `claims`: what the path promised of `ThisWorkflow` so far (#264 S112, S114) —
 * a `ThisWorkflowStepClaim` per `.returns(…)` after a `ThisWorkflow` step, a `ThisWorkflowJoinClaim`
 * per `.returns(…)` after its per-item join, those of its sub-paths added by `.switch(…)`,
 * `.chooseOne(…)`, `.onError(…)`, `.onJoinError(…)` and `.joinQuorumGroups(…)`. `never` for none;
 * `@Workflow({ name, flow })` checks them against its own `ThisWorkflowOutputs` entry.
 */
export interface SourceHead<TClaims = never> {
  readonly source: true;
  readonly claims: TClaims;
}
export interface RouteHead<TClaims = never> {
  readonly route: true;
  readonly claims: TClaims;
}
export interface CaseHead<TValue, TClaims = never> {
  readonly case: TValue;
  readonly claims: TClaims;
}
export interface SideHead<TClaims = never> {
  readonly side: true;
  readonly claims: TClaims;
}
/**
 * A `group(…)` of `.joinQuorumGroups(…)` (#279): the agents' names as listed and the values its
 * `.returns(…)` chain named, checked by `.joinQuorumGroups(…)` against its `JoinOutputs` entry.
 */
export interface GroupHead<
  TNames extends string,
  TGiven extends readonly unknown[],
  TClaims = never,
> {
  readonly group: TNames;
  readonly given: TGiven;
  readonly claims: TClaims;
}
export type PathHead =
  | SourceHead<unknown>
  | RouteHead<unknown>
  | CaseHead<unknown, unknown>
  | SideHead<unknown>
  | GroupHead<string, readonly unknown[], unknown>;

/** A path as built so far: a `FlowPath` from a source, a `SubPath` otherwise, its head in its type. */
export type BuiltPath<THead extends PathHead> = (THead extends SourceHead<unknown>
  ? FlowPath
  : SubPath) & {
  readonly [pathHead]?: THead;
};

/** Any route of `.chooseOne(…)`, whatever it claims of `ThisWorkflow`. */
export type RoutePath = BuiltPath<RouteHead<unknown>>;
/** Any case of `.switch(…)`. */
export type CasePath = BuiltPath<CaseHead<unknown, unknown>>;
/** Any side path of `.onError(…)` / `.onJoinError(…)`. */
export type SidePath = BuiltPath<SideHead<unknown>>;

/** The `ThisWorkflow` claims a path carries (`never` for a path built without the typed builder). */
export type ClaimsOf<TPath> = TPath extends { readonly [pathHead]?: infer THead }
  ? THead extends { readonly claims: infer TClaims }
    ? TClaims
    : never
  : never;

/**
 * `.returns(CritiqueDto, { about: PlanDto })`, `caseOf(ChangesRequestedDto, { about: OfferDraftDto })`
 * (#299, S54): what the value is about — a new value of one of these classes outdates it, and it
 * never outdates them (#271).
 */
export interface ReturnsOptions {
  readonly about?: DtoClass | readonly [DtoClass, ...DtoClass[]];
}

/** How a message names each kind. */
interface KindLabels {
  [NodeKind.Start]: "a workflow start";
  [NodeKind.Finish]: "a workflow finish";
  [NodeKind.Agent]: "an agent";
  [NodeKind.Action]: "an action";
  [NodeKind.Router]: "a router";
  [NodeKind.Workflow]: "a workflow";
}

export type KindLabel<TKind extends NodeKind> = KindLabels[TKind];

/** The label of a route target. */
export type RouteTargetLabel =
  "a route target (an agent, an action, a router, a child workflow or a finish)";

export type RouteTargetKind =
  NodeKind.Agent | NodeKind.Action | NodeKind.Router | NodeKind.Finish | NodeKind.Workflow;

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
 * The generated input of a target, when it reports a problem (`[input.missing-on-path]`, …);
 * `ThisWorkflow`'s is its workflow's own, checked by `@Workflow({ name, flow })` (#264 S112).
 */
type InputCheck<TInstance> =
  ThisWorkflowName extends NameOf<TInstance>
    ? unknown
    : [InputOf<TInstance>] extends [GeneratedTypeError]
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
type CaseValueOf<TPath> = TPath extends { readonly [pathHead]?: CaseHead<infer TValue, unknown> }
  ? TValue
  : never;

/** The group a path was built from (`group(…)…`, #279); `never` for any other path. */
export type GroupOfPath<TPath> = TPath extends {
  readonly [pathHead]?: GroupHead<infer TNames, infer TGiven, unknown>;
}
  ? GroupHead<TNames, TGiven>
  : never;

export type SwitchCheck<TCases extends readonly CasePath[], TOutput> = [
  CaseValueOf<TCases[number]>,
] extends [TOutput]
  ? [TOutput] extends [CaseValueOf<TCases[number]>]
    ? unknown
    : { readonly __error: "the switch is not exhaustive — one caseOf(…) per class of the output" }
  : { readonly __error: "a caseOf(…) names a class the step does not give" };

/**
 * After `.returns(…)` or `caseOf(…)`: the next transition, or a parallel launch (#273) — not right
 * after a join's values (`TCanLaunch` false).
 */
export type AfterValue<
  TValue,
  THead extends PathHead,
  TCanLaunch extends boolean = true,
> = BuiltPath<THead> &
  Transitions<THead> &
  (TCanLaunch extends true ? Launches<TValue, THead> : unknown) & { readonly [pathValue]?: TValue };

/** After a step (a transition or a path source): what its kind and output allow. */
export type AfterStep<TInstance, THead extends PathHead> = BuiltPath<THead> &
  StepContinuation<TInstance, THead>;

type StepContinuation<TInstance, THead extends PathHead> = [KindOf<TInstance>] extends [never]
  ? Returning<StepValues<TInstance>, MissingGeneratedTypes, THead>
  : [KindOf<TInstance>] extends [NodeKind.Router]
    ? RouterStep<THead, TInstance>
    : [KindOf<TInstance>] extends [NodeKind.Start]
      ? Returning<StepValues<TInstance>, ValuesLeft<ProducerOutputOf<TInstance>>, THead>
      : ThisWorkflowName extends NameOf<TInstance>
        ? ErrorHandling<TInstance, THead> & ThisWorkflowReturning<THead>
        : ErrorHandling<TInstance, THead> &
            OutputContinuation<TInstance, ProducerOutputOf<TInstance>, THead>;

/**
 * A step with `output` names it with `.returns(…)` — a `oneOf` too, before its `.switch(…)`; one
 * without goes on at once, with a transition or a launch (#273).
 */
type OutputContinuation<TInstance, TOutput, THead extends PathHead> = [TOutput] extends [
  GeneratedTypeError,
]
  ? Returning<StepValues<TInstance>, TOutput, THead>
  : [TOutput] extends [NoOutput]
    ? Transitions<THead> & Launches<never, THead>
    : Returning<StepValues<TInstance>, ValuesLeft<TOutput>, THead>;

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
   * One child execution of `W` (#263): it enters through the start whose input takes the chain's
   * value, gives one of its finishes' outputs — `.returns(XDto)`, or `.returns(oneOf(…))` and a
   * `.switch(…)` with one case per class — and its failure is caught by `.onError(…)` right after.
   */
  toWorkflow<const TClass extends Class>(
    target: TClass & TargetCheck<TClass, NodeKind.Workflow, KindLabel<NodeKind.Workflow>>,
  ): AfterStep<InstanceType<TClass>, THead>;
}

export interface Switching<TOutput, THead extends PathHead> {
  switch<const TCases extends readonly [CasePath, ...CasePath[]]>(
    ...cases: TCases & SwitchCheck<TCases, TOutput>
  ): BuiltPath<WithClaims<THead, ClaimsOf<TCases[number]>>>;
}

/** `.onError(E, toAction(X)…)` right after the step that throws; the main path goes on. */
export interface ErrorHandling<TInstance, THead extends PathHead> {
  onError<const TPath extends SidePath>(
    error: ErrorClass,
    path: TPath,
  ): AfterStep<TInstance, WithClaims<THead, ClaimsOf<TPath>>>;
}

/** After a router: its `.onError(…)`, then its choice — `.chooseOne(…)` or a launch (#273). */
export interface RouterStep<THead extends PathHead, TInstance = unknown> extends RouterLaunches<
  NameOf<TInstance>,
  THead
> {
  onError<const TPath extends SidePath>(
    error: ErrorClass,
    path: TPath,
  ): BuiltPath<WithClaims<THead, ClaimsOf<TPath>>> &
    RouterStep<WithClaims<THead, ClaimsOf<TPath>>, TInstance>;
  chooseOne<const TRoutes extends readonly [RoutePath, ...RoutePath[]]>(
    ...routes: TRoutes
  ): BuiltPath<WithClaims<THead, ClaimsOf<TRoutes[number]>>>;
}

/** What `route(X)` continues with: nothing after a finish, else the target's step. */
export type RouteContinuation<TInstance> = [KindOf<TInstance>] extends [NodeKind.Finish]
  ? BuiltPath<RouteHead>
  : AfterStep<TInstance, RouteHead>;
