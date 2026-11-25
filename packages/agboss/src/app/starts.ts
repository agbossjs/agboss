import { ConfigError } from "../core/error-families/config-errors.js";
import type { Class } from "../components/injection.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import {
  startNamed,
  textStartOf as textStartNodeOf,
  validStartInput,
} from "../flow/runtime/start-input.js";

/** The start class a plain text goes to: the one taking `WorkflowStartTextDto`, if any. */
export const textStartOf = (graph: RuntimeGraph): Class | undefined =>
  textStartNodeOf(graph)?.component;

/** A start of the workflow (by class) and its input, checked against the start's `input`. */
export function checkedStart(
  start: Class,
  input: unknown,
  graph: RuntimeGraph,
): { readonly name: string; readonly input: unknown } {
  const name = declarationOf(start)?.options.name ?? start.name;
  const node = startNamed(graph, name);
  if (node.component !== start) {
    throw new ConfigError.NotAWorkflowStart({
      message: `${start.name} is not a workflow start of "${graph.workflow}"`,
    });
  }
  return { name, input: validStartInput(node, input) };
}
