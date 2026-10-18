import { EdgeKind, type FlowGraph } from "../flow-graph.js";
import type { ResolvedField } from "../fields.js";
import type { ComponentName } from "../../registry.js";

/**
 * The hint `[input.missing-on-path]` gives when a quorum may leave the field's producer out (#279
 * AC8): `(skills-score-agent may be left out of the quorum) — make it optional(SkillsScoreDto) or
 * listOf(SkillsScoreDto)`; empty when no quorum join on the path writes the field's class optional.
 */
export function leftOutHint(
  graph: FlowGraph,
  field: ResolvedField,
  inner: string,
  path: readonly ComponentName[],
): string {
  for (const edge of graph.edges) {
    const { join } = edge;
    if (edge.kind !== EdgeKind.Join || join?.quorum === undefined) continue;
    const at = path.indexOf(edge.from);
    if (at === -1 || path[at + 1] !== edge.to) continue;
    const group = join.groups.find(
      (candidate) =>
        candidate.slot === field.slot &&
        typeof candidate.shape !== "function" &&
        candidate.shape !== undefined &&
        !candidate.isSeveral,
    );
    if (group === undefined) continue;
    return ` (${group.producers.join(", ")} may be left out of the quorum) — make it optional(${inner}) or listOf(${inner})`;
  }
  return "";
}
