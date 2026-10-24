import type { Class } from "../../../components/injection.js";
import { channelNameOf, channelUsesOf } from "../../../channels/discovery.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { ChildPlacement } from "../../child-placement.js";
import { isThisWorkflow } from "../../this-workflow.js";
import { childPlacementsOf } from "../child-placements.js";
import type { FlowNode } from "../flow-graph.js";
import type { AnalysisContext } from "./context.js";

/**
 * The placement of child workflows (#333 PR 2): one child class has one placement in a flow
 * (`[flow.conflicting-placement]` — one class is one node); a child on any instance cannot pause
 * yet (`[graph.remote-child-can-pause]`: its pause would wait on another instance, which #333 PR 4
 * brings) — the error names the child, the tool that pauses it and its channel, and the fix.
 */

/** The flow node of a child class: its own, or the `ThisWorkflow` node of a recursion. */
const nodeOf = (context: AnalysisContext, child: Class): FlowNode | undefined =>
  [...context.graph.nodes.values()].find((node) => node.component === child);

/** The workflow a child node runs: the class, or the enclosing workflow of `ThisWorkflow`. */
const workflowOf = (node: FlowNode): Class =>
  isThisWorkflow(node.component) ? (node.recursionOf ?? node.component) : node.component;

function conflictOf(node: FlowNode, placements: readonly ChildPlacement[]): RuleViolation[] {
  if (new Set(placements).size < 2) return [];
  const message =
    `${node.name} is launched with two placements — one child workflow is one node, so give every ` +
    "mention the same { placement }: ChildPlacement.AnyInstance or ChildPlacement.ParentInstance";
  return [violation("flow.conflicting-placement", message, [node.name])];
}

function pausesOf(node: FlowNode): RuleViolation[] {
  return channelUsesOf([workflowOf(node)]).map((use) => {
    const where = use.workflow === node.name ? "" : ` (in ${use.workflow})`;
    const message =
      `${node.name} runs on any instance (placement: ChildPlacement.AnyInstance), but its tool ` +
      `${use.tool}${where} pauses for ${channelNameOf(use.channel)} — a child on another instance ` +
      "cannot pause until #333 PR 4: launch it with placement: ChildPlacement.ParentInstance";
    return violation("graph.remote-child-can-pause", message, [node.name, use.tool]);
  });
}

export function childPlacementRules(context: AnalysisContext): readonly RuleViolation[] {
  const placements = childPlacementsOf(context.workflow.flow);
  return [...placements].flatMap(([child, listed]) => {
    const node = nodeOf(context, child);
    if (node === undefined) return [];
    const conflict = conflictOf(node, listed);
    if (conflict.length > 0 || !listed.includes(ChildPlacement.AnyInstance)) return conflict;
    return pausesOf(node);
  });
}
