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
import type { Returning, ValuesLeft } from "./returns-types.js";

/**
 * The types of the path builder (#272 S3). A builder carries, in its type, how its path starts
 * (`SourceHead` for a flow path, `RouteHead` / `CaseHead` / `SideHead` for sub-paths) and the
 * value the chain carries; each state offers only the steps the grammar allows there. Kinds,
 * `.returns(…)` and `caseOf(…)` are checked against the generated `.agboss/types.d.ts`.
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
export type PathHead = SourceHead | RouteHead | CaseHead<unknown> | SideHead;

/** A path as built so far: a `FlowPath` from a source, a `SubPath` otherwise, its head in its type. */
export type BuiltPath<THead extends PathHead> = (THead extends SourceHead ? FlowPath : SubPath) & {
  readonly [pathHead]?: THead;
};

export type RoutePath = BuiltPath<RouteHead>;
export type CasePath = BuiltPath<CaseHead<unknown>>;
export type SidePath = BuiltPath<SideHead>;

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
export type RouteTargetLabel = "a route target (an agent, an action, a router or a finish)";

export type RouteTargetKind = NodeKind.Agent | NodeKind.Action | NodeKind.Router | NodeKind.Finish;

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

/** The generated input of a target, when it reports a problem (`[input.missing-on-path]`, …). */
type InputCheck<TInstance> = [InputOf<TInstance>] extends [GeneratedTypeError]
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
type CaseValueOf<TPath> = TPath extends { readonly [pathHead]?: CaseHead<infer TValue> }
  ? TValue
  : never;

export type SwitchCheck<TCases extends readonly CasePath[], TOutput> = [
  CaseValueOf<TCases[number]>,
] extends [TOutput]
  ? [TOutput] extends [CaseValueOf<TCases[number]>]
    ? unknown
    : { readonly __error: "the switch is not exhaustive — one caseOf(…) per class of the output" }
  : { readonly __error: "a caseOf(…) names a class the step does not give" };

/** After `.returns(…)` or `caseOf(…)`: the next transition. */
export type AfterValue<TValue, THead extends PathHead> = BuiltPath<THead> &
  Transitions<THead> & { readonly [pathValue]?: TValue };

/** After a step (a transition or a path source): what its kind and output allow. */
export type AfterStep<TInstance, THead extends PathHead> = BuiltPath<THead> &
  StepContinuation<TInstance, THead>;

type StepContinuation<TInstance, THead extends PathHead> = [KindOf<TInstance>] extends [never]
  ? Returning<TInstance, MissingGeneratedTypes, THead>
  : [KindOf<TInstance>] extends [NodeKind.Router]
    ? RouterStep<THead>
    : [KindOf<TInstance>] extends [NodeKind.Start]
      ? Returning<TInstance, ValuesLeft<ProducerOutputOf<TInstance>>, THead>
      : ErrorHandling<TInstance, THead> &
          OutputContinuation<TInstance, ProducerOutputOf<TInstance>, THead>;

/** A step with `output` names it with `.returns(…)` — a `oneOf` too, before its `.switch(…)`. */
type OutputContinuation<TInstance, TOutput, THead extends PathHead> = [TOutput] extends [
  GeneratedTypeError,
]
  ? Returning<TInstance, TOutput, THead>
  : [TOutput] extends [NoOutput]
    ? Transitions<THead>
    : Returning<TInstance, ValuesLeft<TOutput>, THead>;

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

export interface RouterStep<THead extends PathHead> {
  onError(error: ErrorClass, path: SidePath): BuiltPath<THead> & RouterStep<THead>;
  chooseOne(...routes: readonly [RoutePath, ...RoutePath[]]): BuiltPath<THead>;
}

/** What `route(X)` continues with: nothing after a finish, else the target's step. */
export type RouteContinuation<TInstance> = [KindOf<TInstance>] extends [NodeKind.Finish]
  ? RoutePath
  : AfterStep<TInstance, RouteHead>;
