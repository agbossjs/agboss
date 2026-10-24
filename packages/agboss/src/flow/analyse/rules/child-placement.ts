import type { Class } from "../../../components/injection.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { ChildPlacement } from "../../child-placement.js";
import { childPlacementsOf } from "../child-placements.js";
import type { FlowNode } from "../flow-graph.js";
import type { AnalysisContext } from "./context.js";

/**
 * The placement of child workflows (#333 PR 2): one child class has one placement in a flow
 * (`[flow.conflicting-placement]` — one class is one node).
 */

/** The flow node of a child class: its own, or the `ThisWorkflow` node of a recursion. */
const nodeOf = (context: AnalysisContext, child: Class): FlowNode | undefined =>
  [...context.graph.nodes.values()].find((node) => node.component === child);

function conflictOf(node: FlowNode, placements: readonly ChildPlacement[]): RuleViolation[] {
  if (new Set(placements).size < 2) return [];
  const message =
    `${node.name} is launched with two placements — one child workflow is one node, so give every ` +
    "mention the same { placement }: ChildPlacement.AnyInstance or ChildPlacement.ParentInstance";
  return [violation("flow.conflicting-placement", message, [node.name])];
}

export function childPlacementRules(context: AnalysisContext): readonly RuleViolation[] {
  const placements = childPlacementsOf(context.workflow.flow);
  return [...placements].flatMap(([child, listed]) => {
    const node = nodeOf(context, child);
    return node === undefined ? [] : conflictOf(node, listed);
  });
}
