import type { WorkflowStartInput } from "../decorators/workflow-start.js";
import { childWorkflowOf } from "../analyse/child-workflow.js";
import { childClassOf, outputOf, reachableFrom, type FlowNode } from "../analyse/flow-graph.js";
import { NodeKind } from "../ast.js";
import type { ComponentName } from "../registry.js";
import type { ImportTable } from "./imports.js";
import { outputText, startInputText, startOutputText, valueText } from "./shapes.js";
import type { AnalysedWorkflow } from "./tables.js";

/** The entries of the start and the child-workflow nodes of the tables (`tables.ts`). */

export interface StartTables {
  readonly producerOutputs: Map<string, string>;
  readonly inputs: Map<string, string>;
  readonly workflowStarts: Map<string, string>;
  readonly workflowFinishes: Map<string, string>;
}

/** The outputs and the names of the finishes a start reaches, in every workflow it is in. */
function startOutputs(
  workflows: readonly AnalysedWorkflow[],
  start: ComponentName,
  names: ImportTable,
): { readonly output: string; readonly finishes: string } {
  const outputs = new Set<string>();
  const finishes = new Set<string>();
  for (const { analysis } of workflows) {
    const { graph } = analysis;
    if (!graph.nodes.has(start)) continue;
    for (const reached of reachableFrom([start], graph.edges)) {
      const node = graph.nodes.get(reached);
      if (node?.declaration.kind !== NodeKind.Finish) continue;
      outputs.add(valueText(node.declaration.options.output, names));
      finishes.add(JSON.stringify(node.name));
    }
  }
  const union = (members: ReadonlySet<string>): string =>
    members.size === 0 ? "never" : [...members].sort().join(" | ");
  return { output: union(outputs), finishes: union(finishes) };
}

/** A start: what it gives on its path, what it takes, and the outputs and finishes it reaches. */
export function writeStart(
  node: FlowNode,
  input: WorkflowStartInput,
  workflows: readonly AnalysedWorkflow[],
  names: ImportTable,
  tables: StartTables,
): void {
  const { name } = node;
  tables.producerOutputs.set(name, startOutputText(input, names));
  tables.inputs.set(name, startInputText(input, names));
  const { output, finishes } = startOutputs(workflows, name, names);
  const entry = `{ input: ${startInputText(input, names)}; output: ${output}; readonly finishes: ${finishes} }`;
  tables.workflowStarts.set(name, entry);
}

/**
 * A child workflow gives its finishes' outputs (#263): one class or a `oneOf(…)`. It ends at one of
 * its finishes, which `.onFinish(F, …)` names by class (#1275b).
 */
export function writeChild(node: FlowNode, names: ImportTable, tables: StartTables): void {
  tables.producerOutputs.set(node.name, outputText(outputOf(node), names));
  const finishes = childWorkflowOf(childClassOf(node))?.finishes ?? [];
  if (finishes.length === 0) return;
  const union = finishes.map((finish) => `typeof ${names.ref(finish)}`).join(" | ");
  tables.workflowFinishes.set(node.name, union);
}
