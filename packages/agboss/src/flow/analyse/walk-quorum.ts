import { violation } from "../../graph/rule-error.js";
import { QuorumKind, StepKind, type GroupsQuorum, type Step } from "../ast.js";
import { EdgeKind, type JoinEdge } from "./flow-graph.js";
import { groupAgentNames, groupQuorumGroupsOf, joinValuesOf } from "./quorum-joins.js";
import { nextCursor, type Cursor } from "./walk-cursor.js";
import type { LaunchRecorder, SideWalk } from "./walk-launch.js";

/** `.joinQuorumGroups(…)`: its groups reach nodes of their own. */
export const isGroupsJoin = (step: Step): boolean =>
  step.kind === StepKind.Join && step.quorum?.kind === QuorumKind.Groups;

/**
 * How the walk reads `.joinQuorumGroups(…)` (#279): each group continues its own path — one join
 * edge per group, from the launching step to the group's first node, carrying the values its
 * `.returns(…)` chain names; the groups count as one nesting level. Nothing follows the join.
 */
export function walkGroups(
  walker: LaunchRecorder,
  quorum: GroupsQuorum,
  cursor: Cursor,
  walkSide: SideWalk,
): Cursor {
  const { current, launch } = cursor;
  if (current === undefined || launch === undefined) return cursor;
  for (const group of quorum.groups) {
    const agents = groupAgentNames(group.agents);
    const join: JoinEdge = {
      launch,
      values: joinValuesOf(group.returns),
      written: group.returns.map((value) => value.shape),
      groups: groupQuorumGroupsOf(launch, agents, (name) => walker.table.node(name)),
      quorum,
      group: group.priority === undefined ? { agents } : { agents, priority: group.priority },
    };
    const inner: Cursor = { ...cursor, entry: EdgeKind.Join, join, depth: cursor.depth + 1 };
    if (walkSide(group.path.steps, inner)) continue;
    const message = `${current}: group(${agents.join(", ")}) of .joinQuorumGroups(…) leads nowhere — continue it with .to…(…)`;
    walker.violations.push(violation("graph.dead-end", message, [current]));
  }
  return nextCursor(undefined, cursor.depth, cursor.path);
}
