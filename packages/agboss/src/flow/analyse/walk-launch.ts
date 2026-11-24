import { violation, type RuleViolation } from "../../graph/rule-error.js";
import {
  NodeKind,
  QuorumKind,
  StepKind,
  type ForEachItemStep,
  type InParallelStep,
  type JoinStep,
  type Step,
  type ToStep,
} from "../ast.js";
import { chooserOf, parallelLaunchOf } from "./walk-parallel.js";
import {
  EdgeKind,
  valueWrite,
  type FlowEdge,
  type FlowLaunch,
  type JoinEdge,
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
 * How the walk reads a launch and its join (#273, #1279, #1280): the values a branch reads besides
 * the scope at the launch (a per-item run's item), and the values written after `.join()`.
 */

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
  step: InParallelStep | ForEachItemStep,
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
  const launch = parallelLaunchOf(walker.table, launcher, step, at.writes);
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
