import { StepError } from "../../core/error-families/step-errors.js";
import { LimitError } from "../../core/error-families/limit-errors.js";
import type { Frame } from "../context/frame.js";
import { childRecordOf, type EndedChild } from "./child-exit.js";
import { ChildExecutionStatus } from "./child-records.js";
import type { RuntimeGraph } from "./graph-model.js";

/**
 * The hard stop of a recursion (#264): a launch of the workflow itself that would run past the
 * workflow's `maxDepth` does not start — no execution, no `onExecutionStart` — and fails the
 * launching step with `StepError.Child` caused by `LimitError.Depth`, a child's own
 * limit (#263 S25): `.onError(LimitError, …)` right after the launch takes it. The refused
 * child is kept as a failed child record with an empty path, so `result.children` shows it. Only a
 * launch decided by code meets it: on the last level a model is not offered a recursive choice.
 */
export function refuseBeyondMaxDepth(
  graph: Pick<RuntimeGraph, "analysis">,
  frame: Frame,
  child: EndedChild,
  path: readonly string[],
): void {
  const maxDepth = graph.analysis.recursion?.maxDepth;
  if (maxDepth === undefined || child.depth <= maxDepth) return;
  const error = new LimitError.Depth({ workflowRecord: child.workflow, maxDepth, path });
  const failed = { status: ChildExecutionStatus.Failed, usage: [], error };
  frame.services.recordChild?.(childRecordOf(child, undefined, failed));
  const identity = { executionId: child.identity.executionId, workflow: child.workflow };
  throw new StepError.Child({
    childExecutionId: identity.executionId,
    workflow: identity.workflow,
    cause: error,
    usage: [],
  });
}
