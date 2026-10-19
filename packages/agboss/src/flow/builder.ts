import type { Class } from "../components/injection.js";
import type { DtoClass } from "../dto/types.js";
import { NodeKind, type PathSource } from "./ast.js";
import type {
  AfterStep,
  AfterValue,
  BuiltPath,
  CaseHead,
  CasePath,
  KindCheck,
  KindLabel,
  ReturnsOptions,
  RouteContinuation,
  RouteTargetKind,
  RouteTargetLabel,
  SideHead,
  SourceHead,
  TargetCheck,
} from "./builder-types.js";
import type { LaunchCheck, TargetNames } from "./launch-types.js";
import {
  aboutTargets,
  fromComponent,
  fromSource,
  groupFrom,
  subPathFrom,
  type PathBuilder,
} from "./path-builder.js";
import type { GroupStart } from "./quorum-types.js";

/**
 * The path builder (#272): `start(S)…`, `agent(X)…`, `router(R)…`, `action(X)…`, `workflow(W)…`
 * (#263) begin a flow path; `route(X)…`, `caseOf(D)…` and the side-path starters `toAction(X)…`, `toAgent(A)…`,
 * `toRouter(R)…`, `toWorkflow(W)…` (#263 S85), `toFinish(F)` of `.onError(E, …)` and `group(A, …)…` of `.joinQuorumGroups(…)`
 * (#279) begin a sub-path and return the same builder; `anyOf(A, B)` goes inside `.acceptedBy(…)`.
 */

export { FlowSyntaxError } from "./path-builder.js";
export { anyOf } from "./quorum-step.js";

/** A path from a start: `start(S).returns(InputDto)…`. */
export function start<const TClass extends Class>(
  source: TClass & KindCheck<TClass, NodeKind.Start, KindLabel<NodeKind.Start>>,
): AfterStep<InstanceType<TClass>, SourceHead>;
export function start(source: Class): PathBuilder<PathSource> {
  return fromSource({ kind: NodeKind.Start, node: source });
}

/** The own path of an agent reached from two or more places. */
export function agent<const TClass extends Class>(
  source: TClass & KindCheck<TClass, NodeKind.Agent, KindLabel<NodeKind.Agent>>,
): AfterStep<InstanceType<TClass>, SourceHead>;
export function agent(source: Class): PathBuilder<PathSource> {
  return fromComponent(NodeKind.Agent, source);
}

/** The own path of a router reached from two or more places: `router(R).chooseOne(…)`. */
export function router<const TClass extends Class>(
  source: TClass & KindCheck<TClass, NodeKind.Router, KindLabel<NodeKind.Router>>,
): AfterStep<InstanceType<TClass>, SourceHead>;
export function router(source: Class): PathBuilder<PathSource> {
  return fromComponent(NodeKind.Router, source);
}

/** The own path of an action reached from two or more places. */
export function action<const TClass extends Class>(
  source: TClass & KindCheck<TClass, NodeKind.Action, KindLabel<NodeKind.Action>>,
): AfterStep<InstanceType<TClass>, SourceHead>;
export function action(source: Class): PathBuilder<PathSource> {
  return fromComponent(NodeKind.Action, source);
}

/**
 * The own path of a child workflow reached from two or more places (#263):
 * `workflow(W).onError(…).returns(oneOf(…)).switch(…)`.
 */
export function workflow<const TClass extends Class>(
  source: TClass & KindCheck<TClass, NodeKind.Workflow, KindLabel<NodeKind.Workflow>>,
): AfterStep<InstanceType<TClass>, SourceHead>;
export function workflow(source: Class): PathBuilder<PathSource> {
  return fromComponent(NodeKind.Workflow, source);
}

/** One target of `.chooseOne(…)` and what follows it. */
export function route<const TClass extends Class>(
  target: TClass & TargetCheck<TClass, RouteTargetKind, RouteTargetLabel>,
): RouteContinuation<InstanceType<TClass>>;
export function route(target: Class): PathBuilder<undefined> {
  return subPathFrom({ kind: "route", target });
}

/**
 * One case of `.switch(…)`: the class of the `oneOf` result, put on the path like `.returns`;
 * `caseOf(ChangesRequestedDto, { about: OfferDraftDto })` says what this variant is about (#299).
 */
export function caseOf<const TDto extends DtoClass>(
  dto: TDto,
  options?: ReturnsOptions,
): AfterValue<InstanceType<TDto>, CaseHead<InstanceType<TDto>>>;
export function caseOf(dto: DtoClass, options?: ReturnsOptions): CasePath {
  const about = aboutTargets(options);
  return subPathFrom(about === undefined ? { kind: "case", dto } : { kind: "case", dto, about });
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
 * The side path `.onError(E, toWorkflow(W)…)` (#263 S85): a child workflow handles the failure —
 * entered through its one start (or the start the path's value fits), its result continued like
 * after `.toWorkflow(W)`. A side path that can catch a limit leads only to actions and finishes
 * (`[graph.limit-handler-uses-model]`).
 */
export function toWorkflow<const TClass extends Class>(
  target: TClass & TargetCheck<TClass, NodeKind.Workflow, KindLabel<NodeKind.Workflow>>,
): AfterStep<InstanceType<TClass>, SideHead>;
export function toWorkflow(target: Class): PathBuilder<undefined> {
  return sidePath().toWorkflow(target);
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
