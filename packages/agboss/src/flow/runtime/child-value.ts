import { childWorkflowOf } from "../analyse/child-workflow.js";
import { NodeKind } from "../ast.js";
import type { ChildGraph } from "./child.js";
import type { NodeOutcome } from "./node-runner.js";
import type { ExecutionStateType } from "./state.js";

/**
 * The child's value: its finish's output, with the class of the output when the child gives several
 * (`.toOneOf` pick by it) and the finish it ended at (`.onFinish(F, …)` picks by it, #1275b).
 */
export function valueOf(child: ChildGraph, state: ExecutionStateType): NodeOutcome["value"] {
  const finish = child.deps.graph.nodes.get(state.finish)?.declaration;
  const output = finish?.kind === NodeKind.Finish ? finish.options.output : undefined;
  // Stryker disable next-line ArrayDeclaration: equivalent: a list of one output is no choice of several (`outputs.length > 1`), as the empty one
  const outputs = childWorkflowOf(child.workflow.type)?.outputs ?? [];
  const isOneOf = outputs.length > 1 && typeof output === "function";
  const given = { value: state.output, finish: state.finish };
  return isOneOf ? { ...given, variant: output.name } : given;
}
