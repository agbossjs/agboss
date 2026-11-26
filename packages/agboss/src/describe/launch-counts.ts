import { ComponentKind } from "../flow/runtime/records.js";
import type { FlowAnalysis } from "../flow/analyse/analyse.js";
import type { ResolvedField } from "../flow/analyse/fields.js";
import { EdgeKind, itemBoundOf, reachableFrom, type FlowEdge } from "../flow/analyse/flow-graph.js";
import type { ComponentName } from "../flow/registry.js";

/**
 * How many results of a per-item child launch a list field may get (#264 AC11), as `agboss
 * describe` prints them: `results: deep-research-workflow ×0–5` — from none (an empty list) to the launch's
 * `maxItems`.
 */
export function launchCounts(
  analysis: FlowAnalysis,
  node: ComponentName,
  field: ResolvedField,
): ReadonlyMap<string, string> {
  const { edges } = analysis.graph;
  const counts = new Map<string, string>();
  if (!field.isList) return counts;
  for (const edge of edges.filter((candidate) => isPerItemChildJoin(candidate))) {
    if (!reachableFrom([edge.to], edges).has(node)) continue;
    const group = edge.join?.groups.find((candidate) => candidate.slot === field.slot);
    const most = mostOf(edge);
    for (const producer of group?.producers ?? []) counts.set(producer, `×0–${most}`);
  }
  return counts;
}

/** The most items the join's launch runs (`maxItems` or `takeFirst`). */
const mostOf = (edge: FlowEdge): string => String(itemBoundOf(edge.join?.launch ?? {}) ?? 0);

/** The join of a per-item launch of child workflows. */
const isPerItemChildJoin = (edge: FlowEdge): boolean =>
  edge.kind === EdgeKind.Join &&
  edge.join?.launch.branches[0]?.kind === ComponentKind.Workflow &&
  edge.join.launch.items !== undefined;
