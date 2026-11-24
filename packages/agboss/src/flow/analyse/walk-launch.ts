import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { StepFailedError } from "../../graph/errors.js";
import {
  NodeKind,
  QuorumKind,
  StepKind,
  type ForEachItemStep,
  type InParallelStep,
  type JoinStep,
  type LaunchStep,
  type ParallelTargetKind,
  type Step,
  type ToStep,
} from "../ast.js";
import { LAUNCH_CALLS } from "../launch-step.js";
import { chooserOf, itemsOf, parallelLaunchOf } from "./walk-parallel.js";
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
import { joinGroupsOf, valuesOfGroups, type NodeLookup } from "./join-groups.js";
import type { NodeTable } from "./nodes.js";
import { countQuorumGroupsOf } from "./quorum-joins.js";
import type { Cursor } from "./walk-cursor.js";
import { walkGroups } from "./walk-quorum.js";
import {
  MentionKind,
  type JoinErrorSite,
  type Mention,
  type Placement,
  type QuorumSite,
} from "./walked-flow.js";

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
function branchOf(
  launcher: FlowNode,
  node: ComponentName,
  copies: number,
  kind: ParallelTargetKind,
): LaunchBranch {
  const { declaration } = launcher;
  if (declaration.kind !== NodeKind.Router)
    return { node, kind, skip: [], copies, isOptional: false, alwaysRuns: true };
  const route = routeFor(declaration.options, node);
  const spawn =
    route === undefined ? SpawnPolicy.Always : spawnPolicyOf(declaration.options, route);
  const failure = route === undefined ? FailurePolicy.FailFast : failurePolicyOf(route);
  const isSkipped = failure === FailurePolicy.Skip;
  const isOnDemand = spawn === SpawnPolicy.OnDemand;
  return {
    node,
    kind,
    skip: isSkipped ? [StepFailedError] : [],
    copies,
    isOptional: isSkipped || isOnDemand,
    alwaysRuns: !isSkipped && !isOnDemand,
  };
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
  const items = step.targets.length === 1 ? itemsOf(writes) : undefined;
  return {
    launcher: launcher.name,
    call: LAUNCH_CALLS[step.targetKind],
    branches: [...copies].map(([node, count]) => branchOf(launcher, node, count, step.targetKind)),
    listed,
    ...(items === undefined ? {} : { items }),
    ...(step.maxConcurrency === undefined ? {} : { maxConcurrency: step.maxConcurrency }),
    ...(step.maxItems === undefined ? {} : { maxItems: step.maxItems }),
    isRouterLaunch: launcher.kind === NodeKind.Router,
    ...(step.arbitratedBy === undefined ? {} : { arbitratedBy: step.arbitratedBy }),
  };
}

/** What a branch of the launch reads besides the scope at the launch: a per-item run's item. */
export function itemWrites(launch: FlowLaunch): readonly ValueWrite[] {
  const element = launch.items?.element;
  return typeof element === "function" ? [valueWrite(element, false)] : [];
}

/**
 * The join of a launch: the values written after `.join()`, and what the branches give — after
 * `.joinQuorum(…)` the answers a quorum may leave out are optional (#279).
 */
export function joinEdgeOf(launch: FlowLaunch, step: JoinStep, nodeOf: NodeLookup): JoinEdge {
  const { quorum } = step;
  const groups =
    quorum?.kind === QuorumKind.Count
      ? countQuorumGroupsOf(launch, quorum, nodeOf)
      : joinGroupsOf(launch, nodeOf);
  const joined = { launch, values: valuesOfGroups(groups), groups };
  return quorum?.kind === QuorumKind.Count ? { ...joined, quorum } : joined;
}

/** What the walker keeps that a launch and its join add to. */
export interface LaunchRecorder {
  readonly table: NodeTable;
  /** Enters a node from the cursor: its placement, mention and edge. */
  enter(step: ToStep, cursor: Cursor, isContinued: boolean): Cursor;
  readonly edges: FlowEdge[];
  readonly placements: Placement[];
  readonly mentions: Mention[];
  readonly launches: FlowLaunch[];
  readonly joinErrorHandlers: JoinErrorSite[];
  readonly quorumJoins: QuorumSite[];
  readonly violations: RuleViolation[];
}

/** A launch: one edge to each distinct target, the scope at the launch (+ its item) on it. */
export function walkLaunch(
  walker: LaunchRecorder,
  step: LaunchStep | InParallelStep | ForEachItemStep,
  cursor: Cursor,
): Cursor {
  const router = step.kind === StepKind.InParallel ? chooserOf(step) : undefined;
  // a router that picks branches is entered first; it launches (`chooseMany`, #1279b)
  const at =
    router === undefined
      ? cursor
      : walker.enter(
          { kind: StepKind.To, target: router.target, targetKind: NodeKind.Router },
          cursor,
          true,
        );
  const { current } = at;
  if (current === undefined) return at;
  const launcher = walker.table.node(current);
  const launch =
    step.kind === StepKind.Launch
      ? launchOf(walker.table, launcher, step, at.writes)
      : parallelLaunchOf(walker.table, launcher, step, at.writes);
  if (launch === undefined) return at;
  walker.launches.push(launch);
  for (const node of launch.listed) {
    walker.placements.push({ node, depth: at.depth, path: at.path });
    walker.mentions.push({ node, kind: MentionKind.Entry, isContinued: false });
  }
  const writes = [...at.writes, ...itemWrites(launch)];
  for (const branch of launch.branches)
    walker.edges.push({
      from: current,
      to: branch.node,
      kind: EdgeKind.Launch,
      writes,
      launch,
    });
  return { ...at, launch };
}

/** Walks a side path; whether it reached a node of its own. */
export type SideWalk = (steps: readonly Step[], cursor: Cursor) => boolean;

/** A join: its `.onError(…)` side paths, then the edge of the next `.to…(…)` (#273). */
export function walkJoin(
  walker: LaunchRecorder,
  step: JoinStep,
  cursor: Cursor,
  walkSide: SideWalk,
): Cursor {
  const { current, launch } = cursor;
  if (current === undefined || launch === undefined) return cursor;
  for (const handler of step.onError) {
    walker.joinErrorHandlers.push({ node: current, launch, handler });
    const inner: Cursor = {
      ...cursor,
      entry: EdgeKind.JoinError,
      error: handler.error,
      settled: joinGroupsOf(launch, (name) => walker.table.node(name)),
      depth: cursor.depth + 1,
    };
    if (walkSide(handler.path.steps, inner)) continue;
    const message = `${current}: .onError(${handler.error.name}, …) leads nowhere — start it with toAction(…) or toFinish(…)`;
    walker.violations.push(violation("graph.dead-end", message, [current]));
  }
  const { quorum } = step;
  if (quorum !== undefined) walker.quorumJoins.push({ node: current, launch, quorum });
  if (quorum?.kind === QuorumKind.Groups) return walkGroups(walker, quorum, cursor, walkSide);
  const join = joinEdgeOf(launch, step, (name) => walker.table.node(name));
  return { ...cursor, entry: EdgeKind.Join, join };
}
