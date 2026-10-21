import { LimitExceededError } from "../../graph/limits.js";
import type { WorkflowRecord } from "../context/execution-context.js";

/**
 * A recursion launched by code went past its workflow's `maxDepth` (#264): the launch does not
 * start, and the level above gets `ChildExecutionFailedError` with this error as its `cause` — a
 * child's own limit (#263 S25), so `.onError(LimitExceededError, …)` right after
 * `.toWorkflow(ThisWorkflow)` (or `.onJoinError(…)` after a per-item launch's join) takes it. A model
 * never meets it: on the last level its recursive choices are not offered (the soft stop).
 */
export class DepthLimitExceededError extends LimitExceededError {
  static override readonly code: string = "limit.depth";
  override name = "DepthLimitExceededError";
  /** The recursive workflow, by `name` and versions. */
  readonly workflow: WorkflowRecord;
  /** `@Workflow({ maxDepth })`: the deepest level its executions may run at (the root is 1). */
  readonly maxDepth: number;
  /** The depth the launch would have started at. */
  readonly depth: number;

  constructor(workflow: WorkflowRecord, maxDepth: number, path: readonly string[]) {
    const depth = maxDepth + 1;
    const record = {
      name: workflow.name,
      version: workflow.version,
      startedVersion: workflow.startedVersion,
      configHash: workflow.configHash,
    };
    super({ key: "maxDepth", limit: maxDepth, actual: depth }, path, 0, [], {
      message: `${workflow.name} went ${String(depth)} levels deep; its maxDepth is ${String(maxDepth)}`,
      details: { workflow: record, maxDepth, depth },
    });
    this.workflow = record;
    this.maxDepth = maxDepth;
    this.depth = depth;
  }
}
