import { outputOf } from "../analyse/flow-graph.js";
import { THIS_WORKFLOW_NAME } from "../this-workflow.js";
import type { ImportTable } from "./imports.js";
import { childInputEntry, nodeInput } from "./inputs.js";
import { joinText, launchesThisWorkflow } from "./joins.js";
import { outputText } from "./shapes.js";
import type { AnalysedWorkflow, TypeTable } from "./tables.js";

/**
 * `ThisWorkflowOutputs` (#264 S112): `ThisWorkflow` is a different workflow in each recursive one,
 * so each gets its own entry, keyed by its name — the problems of launching it (`input`, from that
 * workflow's paths only), what one child gives (`output`) and, with a per-item launch, its join.
 */
export function thisWorkflowEntries(
  workflows: readonly AnalysedWorkflow[],
  names: ImportTable,
): TypeTable {
  const entries = new Map<string, string>();
  for (const workflow of workflows) {
    const { analysis } = workflow;
    const node = analysis.graph.nodes.get(THIS_WORKFLOW_NAME);
    if (node === undefined) continue;
    const input = childInputEntry(nodeInput([workflow], THIS_WORKFLOW_NAME), names).type;
    const members = [
      `readonly input: ${input}`,
      `readonly output: ${outputText(outputOf(node), names)}`,
    ];
    const launch = analysis.graph.edges.find(
      (edge) => edge.launch !== undefined && launchesThisWorkflow(edge.launch),
    )?.launch;
    if (launch !== undefined) members.push(`readonly join: ${joinText(analysis, launch, names)}`);
    entries.set(analysis.workflow, `{ ${members.join("; ")} }`);
  }
  return entries;
}
