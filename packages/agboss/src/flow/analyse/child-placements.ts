import { ComponentKind } from "../runtime/records.js";
import type { Class } from "../../components/injection.js";
import {
  QuorumKind,
  StepKind,
  type FlowPath,
  type ForEachItemStep,
  type InParallelStep,
  type Step,
  type SubPath,
  type ToStep,
} from "../ast.js";
import { declarationOf } from "../decorators/declaration.js";
import { ChildPlacement, isQueued } from "../child-placement.js";

/**
 * Where each child workflow of a flow runs (#333 PR 2, #1286): the child's own `@Workflow({ placement
 * })`, else the application's `defaults.workflows.placement`, else `ChildPlacement.CurrentProcess`.
 * Never the parent's: a child inherits nothing from the workflow that launches it.
 */

/** The child workflow classes a flow names: `.toWorkflow(W)`, a `.forEachItem(toWorkflow(W), …)` branch, a route. */
class ChildWalk {
  readonly found = new Set<Class>();

  steps(steps: readonly Step[]): void {
    for (const step of steps) this.step(step);
  }

  private step(step: Step): void {
    if (step.kind === StepKind.To) this.mention(step);
    else if (step.kind === StepKind.InParallel || step.kind === StepKind.ForEachItem)
      this.mentionBranches(step);
    else this.branches(step);
  }

  private mentionBranches(step: InParallelStep | ForEachItemStep): void {
    const given = step.kind === StepKind.InParallel ? step.branches : [step.branch];
    for (const branch of given)
      if (branch.targetKind === ComponentKind.Workflow) this.found.add(branch.target);
  }

  private mention(step: ToStep): void {
    if (step.targetKind === ComponentKind.Workflow) this.found.add(step.target);
  }

  /** The sub-paths of a step; a route to a child workflow names it too. */
  private branches(step: Exclude<Step, ToStep | InParallelStep | ForEachItemStep>): void {
    for (const path of subPathsOf(step)) this.steps(path.steps);
    if (step.kind !== StepKind.ChooseOne) return;
    for (const route of step.routes)
      if (declarationOf(route.target)?.kind === ComponentKind.Workflow)
        this.found.add(route.target);
  }
}

/** The sub-paths a step holds. */
export function subPathsOf(
  step: Exclude<Step, ToStep | InParallelStep | ForEachItemStep>,
): readonly SubPath[] {
  switch (step.kind) {
    case StepKind.ChooseOne:
      return step.routes.map((route) => route.path);
    case StepKind.OneOf:
      return step.branches;
    case StepKind.OnFinish:
    case StepKind.OnError:
      return [step.path];
    case StepKind.Join:
      return [
        ...step.onError.map((handler) => handler.path),
        ...(step.quorum?.kind === QuorumKind.Groups
          ? step.quorum.groups.map((group) => group.path)
          : []),
      ];
  }
}

/** The child workflow classes the flow's paths name; the path a child is continued in is its source, not a mention. */
export function childWorkflowsOf(flow: readonly FlowPath[]): ReadonlySet<Class> {
  const walk = new ChildWalk();
  for (const path of flow) walk.steps(path.steps);
  return walk.found;
}

/** The placement of a child workflow: its own, else its application's default, else the current process. */
export function placementOfWorkflow(
  workflow: Class,
  applicationDefault: ChildPlacement | undefined,
  overrides: Placements | undefined,
): ChildPlacement {
  const declaration = declarationOf(workflow);
  const own =
    declaration?.kind === ComponentKind.Workflow ? declaration.options.placement : undefined;
  return overrides?.get(workflow) ?? own ?? applicationDefault ?? ChildPlacement.CurrentProcess;
}

/** What the selected profiles give child workflows (#1318c): their placement, by workflow class, over the declared one. */
export type Placements = ReadonlyMap<Class, ChildPlacement>;

/** A runtime node as far as its placement goes. */
interface PlacedNode {
  readonly placement?: ChildPlacement;
}

/** Whether one of a graph's nodes launches its children through the child queue. */
export const launchesQueued = (nodes: Iterable<PlacedNode>): boolean =>
  [...nodes].some((node) => isQueued(node.placement));

/** The flow a `@Workflow` class declares; none for anything else. */
const flowOf = (workflow: Class): readonly FlowPath[] => {
  const declaration = declarationOf(workflow);
  return declaration?.kind === ComponentKind.Workflow ? declaration.options.flow : [];
};

const treesQueued = new WeakMap<Class, Map<ChildPlacement | undefined, boolean>>();

/**
 * Whether a tree rooted at `workflow` can launch a child through the queue (#333 PR 3): a child
 * workflow in its flow, or in the flow of any child below it, whose placement is not
 * `CurrentProcess` — such a tree keeps its slots where every instance counts them. Known from the
 * declarations and the application's default alone.
 */
export function treeLaunchesQueued(
  workflow: Class,
  applicationDefault: ChildPlacement | undefined,
  overrides: Placements | undefined,
): boolean {
  // the memo knows the declarations and the default alone: a profile's placements are asked afresh
  if (overrides !== undefined && overrides.size > 0)
    return launchesQueuedUnder(workflow, applicationDefault, overrides);
  const byDefault = treesQueued.get(workflow) ?? new Map<ChildPlacement | undefined, boolean>();
  treesQueued.set(workflow, byDefault);
  const known = byDefault.get(applicationDefault);
  if (known !== undefined) return known;
  const launches = launchesQueuedUnder(workflow, applicationDefault, undefined);
  byDefault.set(applicationDefault, launches);
  return launches;
}

/** Whether a tree rooted at `workflow` can launch a child through the queue, under these placements. */
function launchesQueuedUnder(
  workflow: Class,
  applicationDefault: ChildPlacement | undefined,
  overrides: Placements | undefined,
): boolean {
  const seen = new Set<Class>([workflow]);
  const pending: Class[] = [workflow];
  let launches = false;
  for (let next = pending.pop(); next !== undefined && !launches; next = pending.pop()) {
    for (const child of childWorkflowsOf(flowOf(next))) {
      if (isQueued(placementOfWorkflow(child, applicationDefault, overrides))) launches = true;
      if (seen.has(child)) continue;
      seen.add(child);
      pending.push(child);
    }
  }
  return launches;
}
