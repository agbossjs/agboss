import type { Class } from "../../components/injection.js";
import {
  NodeKind,
  QuorumKind,
  StepKind,
  type FlowPath,
  type LaunchStep,
  type Step,
  type SubPath,
  type ToStep,
} from "../ast.js";
import { declarationOf } from "../decorators/declaration.js";
import { isThisWorkflow } from "../this-workflow.js";
import { ChildPlacement } from "../child-placement.js";

/**
 * Where each child workflow of a flow runs (#333 PR 2): every `.toWorkflow(W, { placement })`,
 * `.toParallelWorkflows(W, { placement })` and `route(W, { placement })` of every path and sub-path
 * — absent is `ChildPlacement.ParentInstance`. One class is one node, so one child has one
 * placement (`[flow.conflicting-placement]` otherwise).
 */

/** Each child workflow class with the placements its mentions name, in path order. */
export type ChildPlacements = ReadonlyMap<Class, readonly ChildPlacement[]>;

class PlacementWalk {
  readonly found = new Map<Class, ChildPlacement[]>();

  add(child: Class, placement: ChildPlacement | undefined): void {
    const list = this.found.get(child) ?? [];
    list.push(placement ?? ChildPlacement.ParentInstance);
    this.found.set(child, list);
  }

  steps(steps: readonly Step[]): void {
    for (const step of steps) this.step(step);
  }

  private step(step: Step): void {
    if (step.kind === StepKind.To || step.kind === StepKind.Launch) this.mention(step);
    else this.branches(step);
  }

  /** A child named by `.toWorkflow(W, …)` or `.toParallelWorkflows(W, …)`. */
  private mention(step: ToStep | LaunchStep): void {
    if (step.targetKind !== NodeKind.Workflow) return;
    const targets = step.kind === StepKind.To ? [step.target] : step.targets;
    for (const target of targets) this.add(target, step.placement);
  }

  /** The sub-paths of a step: its routes (a child route a mention), cases, side paths, groups. */
  private branches(step: Exclude<Step, ToStep | LaunchStep>): void {
    for (const path of subPathsOf(step)) this.steps(path.steps);
    if (step.kind !== StepKind.ChooseOne) return;
    for (const route of step.routes)
      if (isThisWorkflow(route.target) || declarationOf(route.target)?.kind === NodeKind.Workflow)
        this.add(route.target, route.placement);
  }
}

/** The sub-paths a step holds. */
function subPathsOf(step: Exclude<Step, ToStep | LaunchStep>): readonly SubPath[] {
  switch (step.kind) {
    case StepKind.ChooseOne:
      return step.routes.map((route) => route.path);
    case StepKind.Switch:
      return step.cases.map((branch) => branch.path);
    case StepKind.OnError:
      return [step.path];
    case StepKind.Join:
      return [
        ...step.onJoinError.map((handler) => handler.path),
        ...(step.quorum?.kind === QuorumKind.Groups
          ? step.quorum.groups.map((group) => group.path)
          : []),
      ];
    case StepKind.Returns:
      return [];
  }
}

/**
 * The placements of the flow's child workflows; the path a child is continued in (`workflow(W)…`)
 * is its source, not a mention.
 */
export function childPlacementsOf(flow: readonly FlowPath[]): ChildPlacements {
  const walk = new PlacementWalk();
  for (const path of flow) walk.steps(path.steps);
  return walk.found;
}

/** The one placement of a child: `AnyInstance` when a mention names it (the rule refuses mixes). */
export const placementOfChild = (
  placements: ChildPlacements,
  child: Class,
): ChildPlacement | undefined =>
  placements.get(child)?.includes(ChildPlacement.AnyInstance) === true
    ? ChildPlacement.AnyInstance
    : undefined;
