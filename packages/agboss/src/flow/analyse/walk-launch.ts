import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { NodeKind, type JoinStep, type LaunchStep, type Step } from "../ast.js";
import { declarationOf } from "../decorators/declaration.js";
import {
  failurePolicyOf,
  FailurePolicy,
  routesOf,
  spawnPolicyOf,
  SpawnPolicy,
  type AnyRouterRoute,
  type RouterOptions,
} from "../decorators/router.js";
import { isValueShape, Wrapper, type ListWrapper } from "../dto-wrappers.js";
import type { ComponentName } from "../registry.js";
import {
  EdgeKind,
  valueWrite,
  type FlowEdge,
  type FlowLaunch,
  type FlowNode,
  type JoinEdge,
  type LaunchBranch,
  type ValueWrite,
} from "./flow-graph.js";
import { joinGroupsOf, type NodeLookup } from "./join-groups.js";
import type { NodeTable } from "./nodes.js";
import type { Cursor } from "./walk-cursor.js";
import { MentionKind, type JoinErrorSite, type Mention, type Placement } from "./walked-flow.js";

/**
 * How the walk reads a launch and its join (#273): the distinct targets with their copies and — on
 * a router's launch — their routes' policies, the list a per-item launch runs over, the item its
 * branches read, and the values written after `.join()`.
 */

/** The route of a router for one target, when it declares one. */
function routeFor(options: RouterOptions, target: ComponentName): AnyRouterRoute | undefined {
  return routesOf(options).find((route) => declarationOf(route.target)?.options.name === target);
}

/** One distinct target: the router's policies of its route, or `Always` + `FailFast`. */
function branchOf(launcher: FlowNode, node: ComponentName, copies: number): LaunchBranch {
  const { declaration } = launcher;
  if (declaration.kind !== NodeKind.Router)
    return { node, copies, isOptional: false, alwaysRuns: true };
  const route = routeFor(declaration.options, node);
  const spawn =
    route === undefined ? SpawnPolicy.Always : spawnPolicyOf(declaration.options, route);
  const failure = route === undefined ? FailurePolicy.FailFast : failurePolicyOf(route);
  const isSkipped = failure === FailurePolicy.Skip;
  const isOnDemand = spawn === SpawnPolicy.OnDemand;
  return {
    node,
    copies,
    isOptional: isSkipped || isOnDemand,
    alwaysRuns: !isSkipped && !isOnDemand,
  };
}

/** The list a per-item launch runs over: the `.returns(listOf(XDto))` written last. */
function itemsOf(writes: readonly ValueWrite[]): ListWrapper | undefined {
  const last = writes[writes.length - 1]?.shape;
  return last !== undefined && typeof last !== "function" && last.kind === Wrapper.List
    ? last
    : undefined;
}

/** The launch of `step` from `launcher` with the values `writes`; undefined when no target resolves. */
export function launchOf(
  table: NodeTable,
  launcher: FlowNode,
  step: LaunchStep,
  writes: readonly ValueWrite[],
): FlowLaunch | undefined {
  const listed = step.targets.flatMap((target) => table.resolve(target, step.targetKind) ?? []);
  if (listed.length === 0) return undefined;
  const copies = new Map<ComponentName, number>();
  for (const name of listed) copies.set(name, (copies.get(name) ?? 0) + 1);
  const items = step.perItem ? itemsOf(writes) : undefined;
  return {
    launcher: launcher.name,
    targetKind: step.targetKind,
    branches: [...copies].map(([node, count]) => branchOf(launcher, node, count)),
    listed,
    ...(items === undefined ? {} : { items }),
    ...(step.maxConcurrency === undefined ? {} : { maxConcurrency: step.maxConcurrency }),
    ...(step.maxItems === undefined ? {} : { maxItems: step.maxItems }),
    isRouterLaunch: launcher.kind === NodeKind.Router,
  };
}

/** What a branch of the launch reads besides the scope at the launch: a per-item run's item. */
export function itemWrites(launch: FlowLaunch): readonly ValueWrite[] {
  const element = launch.items?.element;
  return typeof element === "function" ? [valueWrite(element, undefined, false)] : [];
}

/** The join of a launch: the values written after `.join()`, and what the branches give. */
export function joinEdgeOf(launch: FlowLaunch, step: JoinStep, nodeOf: NodeLookup): JoinEdge {
  const written = step.returns.map((value) => value.shape);
  const values = step.returns.flatMap((value) =>
    isValueShape(value.shape) ? [valueWrite(value.shape, value.about, false)] : [],
  );
  return { launch, values, written, groups: joinGroupsOf(launch, nodeOf) };
}

/** What the walker keeps that a launch and its join add to. */
export interface LaunchRecorder {
  readonly table: NodeTable;
  readonly edges: FlowEdge[];
  readonly placements: Placement[];
  readonly mentions: Mention[];
  readonly launches: FlowLaunch[];
  readonly joinErrorHandlers: JoinErrorSite[];
  readonly violations: RuleViolation[];
}

/** A launch: one edge to each distinct target, the scope at the launch (+ its item) on it. */
export function walkLaunch(walker: LaunchRecorder, step: LaunchStep, cursor: Cursor): Cursor {
  const { current } = cursor;
  if (current === undefined) return cursor;
  const launch = launchOf(walker.table, walker.table.node(current), step, cursor.writes);
  if (launch === undefined) return cursor;
  walker.launches.push(launch);
  for (const node of launch.listed) {
    walker.placements.push({ node, depth: cursor.depth, path: cursor.path });
    walker.mentions.push({ node, kind: MentionKind.Entry, isContinued: false });
  }
  const writes = [...cursor.writes, ...itemWrites(launch)];
  for (const branch of launch.branches)
    walker.edges.push({ from: current, to: branch.node, kind: EdgeKind.Launch, writes, launch });
  return { ...cursor, launch };
}

/** Walks a side path; whether it reached a node of its own. */
export type SideWalk = (steps: readonly Step[], cursor: Cursor) => boolean;

/** A join: its `.onJoinError(…)` side paths, then the edge of the next `.to…(…)` (#273). */
export function walkJoin(
  walker: LaunchRecorder,
  step: JoinStep,
  cursor: Cursor,
  walkSide: SideWalk,
): Cursor {
  const { current, launch } = cursor;
  if (current === undefined || launch === undefined) return cursor;
  for (const handler of step.onJoinError) {
    walker.joinErrorHandlers.push({ node: current, launch, handler });
    const inner: Cursor = {
      ...cursor,
      entry: EdgeKind.JoinError,
      error: handler.error,
      depth: cursor.depth + 1,
    };
    if (walkSide(handler.path.steps, inner)) continue;
    const message = `${current}: .onJoinError(${handler.error.name}, …) leads nowhere — start it with toAction(…) or toFinish(…)`;
    walker.violations.push(violation("graph.dead-end", message, [current]));
  }
  const join = joinEdgeOf(launch, step, (name) => walker.table.node(name));
  return { ...cursor, entry: EdgeKind.Join, join };
}
