import type { FlowLaunch } from "../analyse/flow-graph.js";
import { joinGroupsOf, launchKeyOf } from "../analyse/join-groups.js";
import type { FlowAnalysis } from "../analyse/analyse.js";
import { TablesImport, type ImportTable } from "./imports.js";
import { valueText } from "./shapes.js";

/**
 * The `JoinOutputs` table (#273): what the join of each launch gives, keyed as the typed builder
 * spells the launch — one value per class (a tuple for several, in a canonical order: the chain
 * names them in any order), `NoOutput` when its actions give nothing, the rule's message when a
 * branch's output cannot be joined.
 */

/** The workflows the table is written from. */
interface Analysed {
  readonly analysis: FlowAnalysis;
}

const errorType = (message: string): string => `{ readonly __error: ${JSON.stringify(message)} }`;

function joinText(analysis: FlowAnalysis, launch: FlowLaunch, names: ImportTable): string {
  const groups = joinGroupsOf(launch, (name) => analysis.graph.nodes.get(name));
  const [problem] = groups.flatMap((group) => (group.problem === undefined ? [] : [group.problem]));
  if (problem !== undefined) return errorType(problem);
  const values = groups.flatMap((group) =>
    group.shape === undefined ? [] : [valueText(group.shape, names)],
  );
  const [one] = values;
  if (one === undefined) return names.use(TablesImport.NoOutput);
  return values.length === 1 ? one : `readonly [${values.join(", ")}]`;
}

/** Every launch of every workflow, by key; the first workflow's entry for a key wins. */
export function joinEntries(
  workflows: readonly Analysed[],
  names: ImportTable,
): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const { analysis } of workflows) {
    for (const edge of analysis.graph.edges) {
      const { launch } = edge;
      if (launch === undefined) continue;
      const key = launchKeyOf(launch);
      if (!entries.has(key)) entries.set(key, joinText(analysis, launch, names));
    }
  }
  return entries;
}
