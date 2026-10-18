import type { ComponentClass, CountQuorum, ReturnedValue } from "../ast.js";
import { declarationOf } from "../decorators/declaration.js";
import { isValueShape, optional, Wrapper, type ValueShape } from "../dto-wrappers.js";
import type { ComponentName } from "../registry.js";
import { valueWrite, type FlowLaunch, type ValueWrite } from "./flow-graph.js";
import { joinGroupsOf, launchKeyOf, type JoinGroup, type NodeLookup } from "./join-groups.js";

/**
 * What a quorum join gives (#279, AC13, AC14). The shape comes from the launch: a repeated agent
 * class, or several agents with one `output`, is `listOf(XDto)` in every form. After
 * `.joinQuorum({ min })` a single answer may be left out — `optional(XDto)` — unless `min` is the
 * number of launched agents; in a group of `.joinQuorumGroups(…)` the agents it lists are counted
 * when it wins, so their values are required, and only theirs are on its path.
 */

/** `min` is the number of launched agents: then every answer is counted (never per item). */
export const isWholeQuorum = (launch: FlowLaunch, quorum: CountQuorum): boolean =>
  launch.items === undefined && quorum.min === launch.listed.length;

/** A single required answer the quorum may leave out becomes `optional(…)`; lists stay lists. */
function mayBeLeftOut(group: JoinGroup): JoinGroup {
  const { shape } = group;
  if (shape === undefined || group.isSeveral || typeof shape !== "function") return group;
  return { ...group, shape: optional(shape) };
}

/** The values of `.joinQuorum(…)`: the join's, singles optional unless the quorum is whole. */
export function countQuorumGroupsOf(
  launch: FlowLaunch,
  quorum: CountQuorum,
  nodeOf: NodeLookup,
): readonly JoinGroup[] {
  const groups = joinGroupsOf(launch, nodeOf);
  return isWholeQuorum(launch, quorum) ? groups : groups.map(mayBeLeftOut);
}

const required = (shape: ValueShape): ValueShape =>
  typeof shape !== "function" && shape.kind === Wrapper.Optional ? shape.inner : shape;

/** The values of one group: the join's values its agents give — present, a list stays a list. */
export function groupQuorumGroupsOf(
  launch: FlowLaunch,
  agents: readonly ComponentName[],
  nodeOf: NodeLookup,
): readonly JoinGroup[] {
  const listed = new Set(agents);
  return joinGroupsOf(launch, nodeOf).flatMap((group) => {
    const producers = group.producers.filter((producer) => listed.has(producer));
    if (producers.length === 0) return [];
    const { shape } = group;
    if (shape === undefined || group.isSeveral) return [{ ...group, producers }];
    return [{ ...group, producers, shape: required(shape) }];
  });
}

/** A group's agents by name, as listed; an undecorated class keeps its class name. */
export const groupAgentNames = (agents: readonly ComponentClass[]): readonly ComponentName[] =>
  agents.map(
    (agent) =>
      (declarationOf(agent)?.options.name ?? (agent.name || "(anonymous class)")) as ComponentName,
  );

/** The `JoinOutputs` key of a group: `<launch> group(<agents as listed>)`, as the builder spells it. */
export const groupKeyOf = (launch: FlowLaunch, agents: readonly ComponentName[]): string =>
  `${launchKeyOf(launch)} group(${agents.join(", ")})`;

/** The values of a `.returns(…)` chain a join (or a quorum group) writes. */
export function joinValuesOf(returns: readonly ReturnedValue[]): readonly ValueWrite[] {
  return returns.flatMap((value) =>
    isValueShape(value.shape) ? [valueWrite(value.shape, value.about, false)] : [],
  );
}
