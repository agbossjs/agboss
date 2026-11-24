import type { Class } from "../components/injection.js";
import type { DtoClass } from "../dto/types.js";
import {
  placementOptionOf,
  type ChildStepOptions,
  type QuestionStepOptions,
} from "./child-placement.js";
import { NodeKind, type PathSource } from "./ast.js";
import type {
  AfterStep,
  AfterValue,
  BuiltPath,
  CaseHead,
  CasePath,
  KindCheck,
  KindLabel,
  RouteContinuation,
  RouteTargetKind,
  RouteOptions,
  RouteTargetLabel,
  SideHead,
  SourceHead,
  TargetCheck,
} from "./builder-types.js";
import type { LaunchCheck, TargetNames } from "./launch-types.js";
import {
  fromComponent,
  fromSource,
  groupFrom,
  subPathFrom,
  type PathBuilder,
} from "./path-builder.js";
import type { GroupStart } from "./quorum-types.js";

/**
 * The path builder (#272): `onStart(S)…`, `onAgent(X)…`, `onRouter(R)…`, `onAction(X)…`, `onWorkflow(W)…`
 * (#263), `onExternalTask(Q)…` (#659) begin a flow path; `route(X)…`, `caseOf(D)…` and the side-path starters `toAction(X)…`, `toAgent(A)…`,
 * `toRouter(R)…`, `toExternalTask(Q)…` (#910), `toWorkflow(W)…` (#263 S85), `toFinish(F)` of `.onError(E, …)` and `group(A, …)…` of `.joinQuorumGroups(…)`
 * (#279) begin a sub-path and return the same builder; `anyOf(A, B)` goes inside `.acceptedBy(…)`.
 */

export { FlowSyntaxError } from "./path-builder.js";
export { anyOf } from "./quorum-step.js";

/** A path from a start: `onStart(S).returns(InputDto)…`. */
export function onStart<const TClass extends Class>(
  source: TClass & KindCheck<TClass, NodeKind.Start, KindLabel<NodeKind.Start>>,
): AfterStep<InstanceType<TClass>, SourceHead>;
export function onStart(source: Class): PathBuilder<PathSource> {
  return fromSource({ kind: NodeKind.Start, node: source });
}

/** The own path of an agent reached from two or more places. */
export function onAgent<const TClass extends Class>(
  source: TClass & KindCheck<TClass, NodeKind.Agent, KindLabel<NodeKind.Agent>>,
): AfterStep<InstanceType<TClass>, SourceHead>;
export function onAgent(source: Class): PathBuilder<PathSource> {
  return fromComponent(NodeKind.Agent, source);
}

/** The own path of a router reached from two or more places: `onRouter(R).chooseOne(…)`. */
export function onRouter<const TClass extends Class>(
  source: TClass & KindCheck<TClass, NodeKind.Router, KindLabel<NodeKind.Router>>,
): AfterStep<InstanceType<TClass>, SourceHead>;
export function onRouter(source: Class): PathBuilder<PathSource> {
  return fromComponent(NodeKind.Router, source);
}

/** The own path of an action reached from two or more places. */
export function onAction<const TClass extends Class>(
  source: TClass & KindCheck<TClass, NodeKind.Action, KindLabel<NodeKind.Action>>,
): AfterStep<InstanceType<TClass>, SourceHead>;
export function onAction(source: Class): PathBuilder<PathSource> {
  return fromComponent(NodeKind.Action, source);
}

/**
 * The own path of a child workflow reached from two or more places (#263):
 * `onWorkflow(W).onError(…).returns(oneOf(…)).switch(…)`.
 */
export function onWorkflow<const TClass extends Class>(
  source: TClass & KindCheck<TClass, NodeKind.Workflow, KindLabel<NodeKind.Workflow>>,
): AfterStep<InstanceType<TClass>, SourceHead>;
export function onWorkflow(source: Class): PathBuilder<PathSource> {
  return fromComponent(NodeKind.Workflow, source);
}

/**
 * The own path of a question role's step reached from two or more places (#659):
 * `onExternalTask(Q).returns(AnswerDto)…` — a question asked again on a cycle.
 */
export function onExternalTask<const TClass extends Class>(
  source: TClass & KindCheck<TClass, NodeKind.Question, KindLabel<NodeKind.Question>>,
): AfterStep<InstanceType<TClass>, SourceHead>;
export function onExternalTask(source: Class): PathBuilder<PathSource> {
  return fromComponent(NodeKind.Question, source);
}

/** One target of `.chooseOne(…)` and what follows it. */
export function route<const TClass extends Class>(
  target: TClass & TargetCheck<TClass, RouteTargetKind, RouteTargetLabel>,
  ...options: RouteOptions<TClass>
): RouteContinuation<InstanceType<TClass>>;
export function route(target: Class, options?: unknown): PathBuilder<undefined> {
  const placement = placementOptionOf(options, "route(W, { placement })");
  return subPathFrom({ kind: "route", target, ...(placement && { placement }) });
}

/**
 * One case of `.switch(…)`: the class of the `oneOf` result, put on the path like `.returns`.
 */
export function caseOf<const TDto extends DtoClass>(
  dto: TDto,
): AfterValue<InstanceType<TDto>, CaseHead<InstanceType<TDto>>>;
export function caseOf(dto: DtoClass): CasePath {
  return subPathFrom({ kind: "case", dto });
}

/** A side path of `.onError(E, …)`. */
const sidePath = (): PathBuilder<undefined> => subPathFrom({ kind: "side" });

/** The side path `.onError(E, toAction(X)…)`. */
export function toAction<const TClass extends Class>(
  target: TClass & TargetCheck<TClass, NodeKind.Action, KindLabel<NodeKind.Action>>,
): AfterStep<InstanceType<TClass>, SideHead>;
export function toAction(target: Class): PathBuilder<undefined> {
  return sidePath().toAction(target);
}

/** The side path `.onError(E, toAgent(A)…)`. */
export function toAgent<const TClass extends Class>(
  target: TClass & TargetCheck<TClass, NodeKind.Agent, KindLabel<NodeKind.Agent>>,
): AfterStep<InstanceType<TClass>, SideHead>;
export function toAgent(target: Class): PathBuilder<undefined> {
  return sidePath().toAgent(target);
}

/** The side path `.onError(E, toRouter(R).chooseOne(…))`. */
export function toRouter<const TClass extends Class>(
  target: TClass & TargetCheck<TClass, NodeKind.Router, KindLabel<NodeKind.Router>>,
): AfterStep<InstanceType<TClass>, SideHead>;
export function toRouter(target: Class): PathBuilder<undefined> {
  return sidePath().toRouter(target);
}

/**
 * The side path `.onError(E, toExternalTask(Q)…)` (#910): a question role's step handles the failure —
 * it reads its `ask` from the path like `.toExternalTask(Q)` does, pauses on the role's channel and puts
 * its `answer` on the path. A side path that can catch a limit leads only to actions and finishes
 * (`[graph.limit-handler-uses-model]`: a reply interpreter may call a model).
 */
export function toExternalTask<const TClass extends Class>(
  target: TClass & TargetCheck<TClass, NodeKind.Question, KindLabel<NodeKind.Question>>,
  options?: QuestionStepOptions,
): AfterStep<InstanceType<TClass>, SideHead>;
export function toExternalTask(target: Class, options?: unknown): PathBuilder<undefined> {
  return sidePath().toExternalTask(target, options);
}

/**
 * The side path `.onError(E, toWorkflow(W)…)` (#263 S85): a child workflow handles the failure —
 * entered through its one start (or the start the path's value fits), its result continued like
 * after `.toWorkflow(W)`. A side path that can catch a limit leads only to actions and finishes
 * (`[graph.limit-handler-uses-model]`).
 */
export function toWorkflow<const TClass extends Class>(
  target: TClass & TargetCheck<TClass, NodeKind.Workflow, KindLabel<NodeKind.Workflow>>,
  options?: ChildStepOptions,
): AfterStep<InstanceType<TClass>, SideHead>;
export function toWorkflow(target: Class, options?: unknown): PathBuilder<undefined> {
  return sidePath().toWorkflow(target, options);
}

/** The side path `.onError(E, toFinish(F))`: the failure ends the execution at a finish. */
export function toFinish<const TClass extends Class>(
  target: TClass & TargetCheck<TClass, NodeKind.Finish, KindLabel<NodeKind.Finish>>,
): BuiltPath<SideHead>;
export function toFinish(target: Class): PathBuilder<undefined> {
  return sidePath().toFinish(target);
}

/**
 * One group of `.joinQuorumGroups(…)` (#279): `group(LegalAgent, CriticAgent).priority(1)
 * .returns(…)….to…(…)` — complete when every place is counted (a repeat needs one more copy); it
 * names its values and continues its own path.
 */
export function group<const TAgents extends readonly [Class, ...Class[]]>(
  ...agents: TAgents & LaunchCheck<TAgents, NodeKind.Agent>
): GroupStart<TargetNames<TAgents>>;
export function group(...agents: readonly Class[]): unknown {
  return groupFrom(agents);
}
