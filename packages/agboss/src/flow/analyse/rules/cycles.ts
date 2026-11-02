import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import type { ComponentName } from "../../registry.js";
import type { FlowNode } from "../flow-graph.js";
import { isCycle, stronglyConnected } from "../strongly-connected.js";
import type { AnalysisContext } from "./context.js";

/**
 * `[graph.cycle-without-max-visits]` (#272 AC11, AC14): every cycle passes a router, an agent or a
 * question role's step (#659) with `maxVisits` — the only rule on cycles; a cycle may be entered at any of its nodes. Removing the
 * bounded nodes must leave no cycle: each strongly connected component left is a cycle no limit
 * stops.
 */

const isBounded = (node: FlowNode): boolean =>
  (node.declaration.kind === NodeKind.Agent ||
    node.declaration.kind === NodeKind.Router ||
    node.declaration.kind === NodeKind.Question) &&
  node.declaration.options.maxVisits !== undefined;

export function cycleRules(context: AnalysisContext): readonly RuleViolation[] {
  const unbounded = [...context.graph.nodes.values()].filter((node) => !isBounded(node));
  const names = new Set(unbounded.map((node) => node.name));
  const edges = context.graph.edges.filter((edge) => names.has(edge.from) && names.has(edge.to));
  const successors = (node: ComponentName): readonly ComponentName[] =>
    edges.filter((edge) => edge.from === node).map((edge) => edge.to);
  return stronglyConnected([...names], successors)
    .filter((component) => isCycle(component, successors))
    .map((component) => {
      const message =
        `the cycle through ${component.join(", ")} has no maxVisits — set maxVisits on one of ` +
        "its agents or routers";
      return violation("graph.cycle-without-max-visits", message, component);
    });
}
