import { WorkflowFinishTextDto } from "../../dto/standard/framework.js";
import { listOf, optional, Wrapper, type OutputShape, type ValueShape } from "../dto-wrappers.js";
import { LAUNCH_CALLS } from "../launch-step.js";
import type { ComponentName } from "../registry.js";
import {
  isTextAgent,
  outputOf,
  type FlowLaunch,
  type FlowNode,
  type LaunchBranch,
} from "./flow-graph.js";
import { shapeLabel } from "./labels.js";
import { slotOfValue, writtenValue, type SlotKey } from "./scope.js";

/**
 * What the join of a launch gives (#273): one value per class the branches give — `listOf(XDto)`
 * for a repeated agent, two agents with one `output` and a per-item launch; `optional(XDto)` for a
 * branch whose router route is `OnDemand` or `Skip`; nothing for an action without `output`. A
 * branch whose output no join value can carry (a list of lists, a lone `oneOf`) is a problem.
 */

/** One value of a join: the branches that give it, and the shape `.join().returns(…)` names. */
export interface JoinGroup {
  readonly slot: SlotKey;
  readonly producers: readonly ComponentName[];
  /** Several values of one class (copies, several agents, a per-item launch): always a list. */
  readonly isSeveral: boolean;
  /** What `.join().returns(…)` writes for it; undefined when nothing can (`problem` says why). */
  readonly shape?: ValueShape;
  readonly problem?: string;
}

/** Looks a node up by name. */
export type NodeLookup = (name: ComponentName) => FlowNode | undefined;

/** What a branch gives: its `output`, a text agent's reply, nothing for an action without one. */
function branchOutput(node: FlowNode | undefined): OutputShape | undefined {
  if (node === undefined) return undefined;
  return isTextAgent(node) ? WorkflowFinishTextDto : outputOf(node);
}

interface Gathered {
  readonly output: OutputShape;
  readonly branches: readonly LaunchBranch[];
}

function gather(launch: FlowLaunch, nodeOf: NodeLookup): readonly Gathered[] {
  const byOutput = new Map<string, Gathered>();
  for (const branch of launch.branches) {
    const output = branchOutput(nodeOf(branch.node));
    if (output === undefined) continue;
    const key = shapeLabel(output);
    const found = byOutput.get(key);
    byOutput.set(key, { output, branches: [...(found?.branches ?? []), branch] });
  }
  return [...byOutput.values()];
}

function groupOf(launch: FlowLaunch, gathered: Gathered): JoinGroup {
  const { output, branches } = gathered;
  const producers = branches.map((branch) => branch.node).sort();
  const copies = branches.reduce((total, branch) => total + branch.copies, 0);
  const isList = launch.items !== undefined || copies > 1;
  const names = producers.join(", ");
  const label = shapeLabel(output);
  const slot = `join:${label}` as SlotKey;
  const isSeveral = isList;
  if (typeof output !== "function" && output.kind === Wrapper.List)
    return isList
      ? { slot, producers, isSeveral, problem: `${names} gives ${label}, several times — a join holds no list of lists; launch it once, or give it one value per run` }
      : withShape(producers, output, false);
  if (isList) return withShape(producers, listOf(output), true);
  if (typeof output !== "function")
    return { slot, producers, isSeveral, problem: `${names} gives ${label} — a join takes one class per branch; branch it with .toAgent(…).returns(${label}).switch(…) instead` };
  const [branch] = branches;
  return withShape(producers, branch?.isOptional === true ? optional(output) : output, false);
}

const withShape = (
  producers: readonly ComponentName[],
  shape: ValueShape,
  isSeveral: boolean,
): JoinGroup => ({ slot: slotOfValue(writtenValue(shape).value), producers, isSeveral, shape });

/** The values of a launch's join, in a canonical order. */
export function joinGroupsOf(launch: FlowLaunch, nodeOf: NodeLookup): readonly JoinGroup[] {
  return gather(launch, nodeOf)
    .map((gathered) => groupOf(launch, gathered))
    .sort((first, second) => first.slot.localeCompare(second.slot));
}

/** The producers of a value the join writes into `slot`: its group's, else every branch. */
export function producersOfSlot(
  launch: FlowLaunch,
  groups: readonly JoinGroup[],
  slot: SlotKey,
): readonly ComponentName[] {
  const group = groups.find((candidate) => candidate.slot === slot);
  return group?.producers ?? launch.branches.map((branch) => branch.node).sort();
}

/** How a message names a launch: `planner-agent → toParallelAgents(researcher-agent, critic-agent)`. */
export function launchLabel(launch: FlowLaunch): string {
  return `${launch.launcher} → ${LAUNCH_CALLS[launch.targetKind]}(${launch.listed.join(", ")})`;
}

/**
 * The key of a launch's `JoinOutputs` entry, as the typed builder spells it from the launch as
 * written: `toParallelAgents(researcher-agent, critic-agent, critic-agent)`, a router's
 * `support-router.toParallelAgents(…)`, a per-item `toParallelAgents(company-check-agent) per item`.
 */
export function launchKeyOf(launch: FlowLaunch): string {
  const prefix = launch.isRouterLaunch ? `${launch.launcher}.` : "";
  const suffix = launch.items === undefined ? "" : " per item";
  return `${prefix}${LAUNCH_CALLS[launch.targetKind]}(${launch.listed.join(", ")})${suffix}`;
}
