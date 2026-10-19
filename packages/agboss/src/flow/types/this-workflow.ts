import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { outputOf } from "../analyse/flow-graph.js";
import { THIS_WORKFLOW_NAME } from "../this-workflow.js";
import type { ImportTable } from "./imports.js";
import { outputText } from "./shapes.js";
import type { AnalysedWorkflow } from "./tables.js";

/**
 * `ThisWorkflow` in the generated types (#264): one class, so one entry of the project's tables —
 * `ProducerOutputs["this-workflow"]`, its join's `JoinOutputs` — typed as the recursive workflow's
 * own finishes. Two recursive workflows whose finishes give different classes cannot share it:
 * generation fails with `[types.this-workflow-outputs]`, naming both, rather than type one of them
 * wrong.
 */
export function thisWorkflowClashes(
  workflows: readonly AnalysedWorkflow[],
  names: ImportTable,
): readonly RuleViolation[] {
  const byOutput = new Map<string, string[]>();
  for (const { analysis } of workflows) {
    const node = analysis.graph.nodes.get(THIS_WORKFLOW_NAME);
    if (node === undefined) continue;
    const output = outputText(outputOf(node), names);
    byOutput.set(output, [...(byOutput.get(output) ?? []), analysis.workflow]);
  }
  if (byOutput.size < 2) return [];
  const each = [...byOutput].map(([output, owners]) => `${owners.join(", ")} give ${output}`);
  const message =
    `ThisWorkflow is typed once per project, and the recursive workflows differ: ${each.join("; ")} — ` +
    "give their finishes the same output classes, or keep them in separate projects";
  return [violation("types.this-workflow-outputs", message, [THIS_WORKFLOW_NAME])];
}
