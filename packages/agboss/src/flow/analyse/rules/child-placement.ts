import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { ChildPlacement } from "../../child-placement.js";
import { childWorkflowsOf, placementOfWorkflow } from "../child-placements.js";
import { classLabel } from "../labels.js";
import type { AnalysisContext } from "./context.js";

/**
 * The placement of child workflows (#1286): `IsolatedWorker` is in the enum, its runtime is #1286b —
 * a child resolved to it fails assembly (`[workflow.isolated-worker-unavailable]`) rather than
 * queue a row no worker would claim.
 */
export function childPlacementRules(context: AnalysisContext): readonly RuleViolation[] {
  const applicationDefault = context.options.applicationDefaults?.workflows?.placement;
  return [...childWorkflowsOf(context.workflow.flow)].flatMap((child) => {
    if (placementOfWorkflow(child, applicationDefault) !== ChildPlacement.IsolatedWorker) return [];
    const message =
      `${classLabel(child)} runs with ChildPlacement.IsolatedWorker, which this version does not run yet — ` +
      "use ChildPlacement.AnyWorker or ChildPlacement.OtherWorker";
    return [violation("workflow.isolated-worker-unavailable", message, [classLabel(child)])];
  });
}
