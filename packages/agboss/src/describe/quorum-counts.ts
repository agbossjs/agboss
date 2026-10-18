import type { FlowAnalysis } from "../flow/analyse/analyse.js";
import type { ResolvedField } from "../flow/analyse/fields.js";
import { EdgeKind, reachableFrom, type FlowEdge } from "../flow/analyse/flow-graph.js";
import type { ComponentName } from "../flow/registry.js";

/**
 * How many counted answers of each producer a list field may get through a quorum (#279 AC9), as
 * `agboss describe` prints them: `critiques: critic-agent ×1–2` — a group counts at least the
 * copies it lists and at most the copies launched; a `.joinQuorum(…)` from none to all of them.
 */

/** The least and the most counted answers of one producer. */
interface CountRange {
  readonly least: number;
  readonly most: number;
}

function rangesOf(edge: FlowEdge, slot: string): ReadonlyMap<string, CountRange> {
  const { join } = edge;
  const ranges = new Map<string, CountRange>();
  const value = join?.groups.find((group) => group.slot === slot && group.isSeveral);
  if (join === undefined || value === undefined || join.launch.items !== undefined) return ranges;
  for (const producer of value.producers) {
    const most = join.launch.listed.filter((name) => name === producer).length;
    const listed = join.group?.agents.filter((name) => name === producer).length ?? 0;
    ranges.set(producer, { least: listed, most });
  }
  return ranges;
}

/** The range covering both. */
const widened = (known: CountRange | undefined, range: CountRange): CountRange => ({
  least: Math.min(known?.least ?? range.least, range.least),
  most: Math.max(known?.most ?? range.most, range.most),
});

/** `×1–2` per producer of a list field reached from a quorum join; empty for any other field. */
export function quorumCounts(
  analysis: FlowAnalysis,
  node: ComponentName,
  field: ResolvedField,
): ReadonlyMap<string, string> {
  const { edges } = analysis.graph;
  const merged = new Map<string, CountRange>();
  const feeding = edges.filter(
    (edge) =>
      edge.kind === EdgeKind.Join &&
      edge.join?.quorum !== undefined &&
      field.isList &&
      reachableFrom([edge.to], edges).has(node),
  );
  for (const edge of feeding)
    for (const [producer, range] of rangesOf(edge, field.slot))
      merged.set(producer, widened(merged.get(producer), range));
  return new Map(
    [...merged].map(([producer, { least, most }]) => [
      producer,
      least === most ? `×${String(most)}` : `×${String(least)}–${String(most)}`,
    ]),
  );
}
