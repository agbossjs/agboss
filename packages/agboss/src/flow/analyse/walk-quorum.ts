import { violation } from "../../graph/rule-error.js";
import { QuorumKind, StepKind, type GroupsQuorum, type Step } from "../ast.js";
import { EdgeKind, type JoinEdge } from "./flow-graph.js";
import { valuesOfGroups } from "./join-groups.js";
import { groupQuorumGroupsOf, groupTargetNames } from "./quorum-joins.js";
import { nextCursor, type Cursor } from "./walk-cursor.js";
import type { LaunchRecorder, SideWalk } from "./walk-launch.js";

/** `.joinQuorumGroups(…)`: its groups reach nodes of their own. */
export const isGroupsJoin = (step: Step): boolean =>
  step.kind === StepKind.Join && step.quorum?.kind === QuorumKind.Groups;

/**
 * How the walk reads `.joinQuorumGroups(…)` and its `.onGroup(…)`s (#279, #1284): each group continues
 * its own path — one join edge per group, from the launching step to the group's first node,
 * carrying the values its places give; the groups count as one nesting level. Nothing follows the
 * join. A join without a group is a dead end.
 */
export function walkGroups(
  walker: LaunchRecorder,
  quorum: GroupsQuorum,
  cursor: Cursor,
  walkSide: SideWalk,
): Cursor {
  const { current, launch } = cursor;
  if (current === undefined || launch === undefined) return cursor;
  if (quorum.groups.length === 0) {
    const message = `${current}: .joinQuorumGroups(…) has no .onGroup(…) — continue each group with .onGroup([targets], subPath)`;
    walker.violations.push(violation("graph.dead-end", message, [current]));
  }
  for (const group of quorum.groups) {
    const targets = groupTargetNames(group.targets);
    const groups = groupQuorumGroupsOf(launch, targets, (name) => walker.table.node(name));
    const join: JoinEdge = {
      launch,
      values: valuesOfGroups(groups),
      groups,
      quorum,
      group: group.priority === undefined ? { targets } : { targets, priority: group.priority },
    };
    const inner: Cursor = { ...cursor, entry: EdgeKind.Join, join, depth: cursor.depth + 1 };
    if (walkSide(group.path.steps, inner)) continue;
    const message = `${current}: .onGroup([${targets.join(", ")}], …) of .joinQuorumGroups(…) leads nowhere — continue it with .to…(…)`;
    walker.violations.push(violation("graph.dead-end", message, [current]));
  }
  return nextCursor(undefined, cursor.depth, cursor.path);
}
