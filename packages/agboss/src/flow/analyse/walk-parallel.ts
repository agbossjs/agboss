import {
  StepKind,
  type ForEachItemStep,
  type Step,
  type InParallelStep,
  type ParallelBranchStep,
} from "../ast.js";
import { Wrapper, type ListWrapper } from "../dto-wrappers.js";
import type { ComponentName } from "../registry.js";
import type { FlowLaunch, FlowNode, LaunchBranch, ValueWrite } from "./flow-graph.js";
import type { NodeTable } from "./nodes.js";

/**
 * How the walk reads `.inParallel([…])` and `.forEachItem(…)` (#1279, #1280): each branch with its own
 * kind and `skip()`, a repeated target as copies, and — for `.forEachItem` — the list it runs over.
 */

/** The list a per-item launch runs over: the one the step before it gives, last. */
export function itemsOf(writes: readonly ValueWrite[]): ListWrapper | undefined {
  const last = writes[writes.length - 1]?.shape;
  return last !== undefined && typeof last !== "function" && last.kind === Wrapper.List
    ? last
    : undefined;
}

const sameSkips = (found: LaunchBranch, branch: ParallelBranchStep): boolean =>
  found.skip.length === branch.skip.length && found.skip.every((cls) => branch.skip.includes(cls));

/** A listed target as a distinct branch of the launch: first listing, or one more copy of it. */
function branchOf(
  found: LaunchBranch | undefined,
  node: ComponentName,
  branch: ParallelBranchStep,
  isChosen: boolean,
): LaunchBranch {
  if (found !== undefined)
    return {
      ...found,
      copies: found.copies + 1,
      ...(sameSkips(found, branch) ? {} : { skipDiffers: true as const }),
    };
  const isOptional = branch.skip.length > 0 || isChosen;
  return {
    node,
    kind: branch.targetKind,
    skip: branch.skip,
    copies: 1,
    isOptional,
    alwaysRuns: !isOptional,
  };
}

interface Entry {
  readonly one: ParallelBranchStep;
  readonly isChosen: boolean;
}

/** The branches as launched: a router branch stands for the branches it picks among. */
const entriesOf = (given: readonly ParallelBranchStep[]): readonly Entry[] =>
  given.flatMap((one): readonly Entry[] =>
    one.chooses === undefined
      ? [{ one, isChosen: false }]
      : one.chooses.map((chosen) => ({ one: chosen, isChosen: true })),
  );

/** The launch of `.inParallel([…])` / `.forEachItem(…)`: undefined when no target resolves. */
export function parallelLaunchOf(
  table: NodeTable,
  launcher: FlowNode,
  step: InParallelStep | ForEachItemStep,
  writes: readonly ValueWrite[],
): FlowLaunch | undefined {
  const given = step.kind === StepKind.ForEachItem ? [step.branch] : step.branches;
  const listed: ComponentName[] = [];
  const chosen = new Set<ComponentName>();
  const branches = new Map<ComponentName, LaunchBranch>();
  for (const { one, isChosen } of entriesOf(given)) {
    const node = table.resolve(one.target, one.targetKind);
    if (node === undefined) continue;
    listed.push(node);
    if (isChosen) chosen.add(node);
    branches.set(node, branchOf(branches.get(node), node, one, isChosen));
  }
  if (listed.length === 0) return undefined;
  return {
    ...(step.kind === StepKind.ForEachItem
      ? forEachOf(step, writes)
      : { call: "inParallel", form: "in-parallel" as const }),
    launcher: launcher.name,
    branches: [...branches.values()],
    listed,
    ...(step.maxConcurrency === undefined ? {} : { maxConcurrency: step.maxConcurrency }),
    ...(chosen.size === 0 ? {} : { chooser: { routes: [...chosen] } }),
    isRouterLaunch: chosen.size > 0,
  };
}

/** The router branch of `.inParallel([…])`: `toRouter(R).chooseMany([…])`, when it has one. */
export const chooserOf = (step: Step): ParallelBranchStep | undefined =>
  step.kind === StepKind.InParallel ? step.branches.find((branch) => branch.chooses) : undefined;

/** What `.forEachItem(…)` adds to its launch: the list, `maxItems` or `takeFirst`. */
function forEachOf(
  step: ForEachItemStep,
  writes: readonly ValueWrite[],
): Partial<FlowLaunch> & {
  readonly call: string;
  readonly form: "for-each-item";
} {
  const items = itemsOf(writes);
  return {
    call: "forEachItem",
    form: "for-each-item",
    ...(items === undefined ? {} : { items }),
    ...(step.maxItems === undefined ? {} : { maxItems: step.maxItems }),
    ...(step.takeFirst === undefined ? {} : { takeFirst: step.takeFirst }),
  };
}
