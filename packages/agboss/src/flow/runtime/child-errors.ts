import type { UsageRecord } from "../../finops/usage.js";
import { StepFailedError, stepCoordinatesOf } from "../../graph/errors.js";
import type { WorkflowRecord } from "../context/execution-context.js";
import { ComponentKind } from "./records.js";

/**
 * A child execution failed (#263 S25): an uncaught error of the child — its step's failure or one
 * of its own limits (its `maxSteps`, the `maxVisits` of its nodes) — fails the parent's step with
 * this `StepFailedError`, the child's error as its `cause`. Tree-wide limits (budgets) and a
 * cancellation are never wrapped: they stop the whole execution as they are. `.onError(…)` /
 * `.onJoinError(…)` catch it by this class or by the cause (codes match through the cause chain).
 */
export class ChildExecutionFailedError extends StepFailedError {
  static override readonly code: string = "step.child";
  override name = "ChildExecutionFailedError";
  /** The failed child's own execution id. */
  readonly childExecutionId: string;
  /** The child workflow, by `name` and versions. */
  readonly workflow: WorkflowRecord;

  constructor(
    child: { readonly executionId: string; readonly workflow: WorkflowRecord },
    cause: unknown,
    usage: readonly UsageRecord[],
  ) {
    const step = stepCoordinatesOf(child.workflow.name, ComponentKind.Workflow);
    const item = step.itemIndex === undefined ? "" : `, item ${String(step.itemIndex)}`;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const message = `Child workflow "${child.workflow.name}" (execution ${child.executionId}${item}) failed: ${reason}`;
    const workflow = {
      name: child.workflow.name,
      version: child.workflow.version,
      startedVersion: child.workflow.startedVersion,
      configHash: child.workflow.configHash,
    };
    super(message, usage, cause, step, { childExecutionId: child.executionId, workflow });
    this.childExecutionId = child.executionId;
    this.workflow = workflow;
  }
}
