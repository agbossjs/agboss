import type { UsageRecord } from "../../finops/usage.js";
import { StepFailedError, stepCoordinatesOf } from "../../graph/errors.js";
import type { WorkflowRecord } from "../context/execution-context.js";
import { ComponentKind } from "./records.js";

/** What a failed child takes (#906): its execution and workflow, the spend and its error. */
export interface ChildExecutionFailedErrorOptions {
  /** The failed child's own execution id. */
  readonly childExecutionId: string;
  /** The child workflow, by `name` and versions. */
  readonly workflow: WorkflowRecord;
  readonly usage: readonly UsageRecord[];
  /** The child's uncaught error. */
  readonly cause?: unknown;
}

/**
 * A child execution failed (#263 S25): an uncaught error of the child — its step's failure or one
 * of its own limits (its `maxSteps`, the `maxVisits` of its nodes) — fails the parent's step with
 * this `StepFailedError`, the child's error as its `cause`. Tree-wide limits (budgets) and a
 * cancellation are never wrapped: they stop the whole execution as they are. `.onError(…)` /
 * `.onJoinError(…)` catch it by this class or by the cause (codes match through the cause chain).
 */
export class ChildExecutionFailedError extends StepFailedError {
  static override readonly code = "step.child" as const;
  declare readonly code: typeof ChildExecutionFailedError.code;
  override name = "ChildExecutionFailedError";
  /** The failed child's own execution id. */
  readonly childExecutionId: string;
  /** The child workflow, by `name` and versions. */
  readonly workflow: WorkflowRecord;

  constructor(options: ChildExecutionFailedErrorOptions) {
    const { childExecutionId, usage, cause } = options;
    const step = stepCoordinatesOf(options.workflow.name, ComponentKind.Workflow);
    const item = step.itemIndex === undefined ? "" : `, item ${String(step.itemIndex)}`;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const message = `Child workflow "${options.workflow.name}" (execution ${childExecutionId}${item}) failed: ${reason}`;
    const workflow = {
      name: options.workflow.name,
      version: options.workflow.version,
      startedVersion: options.workflow.startedVersion,
      configHash: options.workflow.configHash,
    };
    super({ message, usage, cause, ...step, details: { childExecutionId, workflow } });
    this.childExecutionId = childExecutionId;
    this.workflow = workflow;
  }
}

/** A child workflow cannot be built: it runs only in its application, or it launches an ancestor. */
export class ChildWorkflowUnavailableError extends Error {
  override name = "ChildWorkflowUnavailableError";
}
