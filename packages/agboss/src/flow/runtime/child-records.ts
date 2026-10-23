import type { ErrorRecord } from "../../core/error-record.js";
import type { CostReport } from "../../finops/usage.js";
import type { WorkflowRecord } from "../context/execution-context.js";
import type { PauseAnswerRecord } from "./execution-record.js";
import type { ComponentRecord } from "./records.js";
import type { ToolCallRecord } from "./tool-calls.js";
import type { ExecutionStepRecord } from "./step-records.js";

/**
 * What an execution keeps of its child executions (#263), as plain JSON: a child's own identity in
 * its state and its launching task's marker (made on first entry, read back after a pause or a
 * crash, ADR-0022), and one
 * nested record per child execution that ended — in the parent's state (`EndedChildRecord`), and in
 * `result.children` and `result.record.children` with the pauses each child asked (#267 S124 c,
 * `ChildExecutionRecord`); never in the conversation history of the parent's thread.
 */

/** How a child execution ended. */
export enum ChildExecutionStatus {
  /** It ended at one of its finishes: its output is the parent's value. */
  Finished = "finished",
  /** It failed: the parent's step failed with `ChildExecutionFailedError` (or a tree-wide limit). */
  Failed = "failed",
  /** A sibling failed first (FailFast) or the execution was cancelled: it stopped midway. */
  Cancelled = "cancelled",
}

/** A child's identity as its state and its marker keep it: the same after a pause or a crash. */
export interface ChildIdentityRecord {
  readonly executionId: string;
  readonly parentExecutionId: string;
  readonly rootExecutionId: string;
  /** Its item's index in a per-item launch, from 0; absent for a single child. */
  readonly itemIndex?: number;
  /** How many usage records it inherited from its parent: its own spend is what follows them. */
  readonly inheritedUsage: number;
}

/** The parent's step that launched a child: its node id and visit (its `checkpoint_ns` is the task's). */
export interface ChildLaunchRecord {
  /** The parent's node of the child: the child workflow's `name`. */
  readonly nodeId: string;
  /** The parent's pass through that node, from 1 (a loop's second pass is 2). */
  readonly visitNumber: number;
}

/**
 * One child execution that ended, as its parent's state keeps it: its identity, where it came from,
 * how it ended, what it cost. Its pauses are added when a result reports it (`ChildExecutionRecord`).
 */
export interface EndedChildRecord {
  /** The child's own execution id (`executionContext.executionId` inside it). */
  readonly executionId: string;
  /** The execution that launched it. */
  readonly parentExecutionId: string;
  /** The root of its tree: the `app.execute` it belongs to. */
  readonly rootExecutionId: string;
  /** The child workflow, by `name` and versions. */
  readonly workflow: WorkflowRecord;
  /** Its item's index in a per-item launch (`.toParallelWorkflows`), from 0. */
  readonly itemIndex?: number;
  /** Its level in the tree (`executionContext.depth`): the root is 1, its children 2 (#264). */
  readonly depth: number;
  /** The parent's step that launched it. */
  readonly launchedBy: ChildLaunchRecord;
  /** The start it entered through (chosen by class, per edge). */
  readonly start: ComponentRecord;
  /** Its start's validated input. */
  readonly input: unknown;
  /** How it ended. */
  readonly status: ChildExecutionStatus;
  /** The finish it ended at (`Finished` only). */
  readonly finish?: ComponentRecord;
  /** The finish's output: the parent's value (`Finished` only). */
  readonly output?: unknown;
  /** Why it failed or stopped (`Failed`, `Cancelled`). */
  readonly error?: ErrorRecord;
  /** The node ids it visited, its own path only. */
  readonly path: readonly string[];
  /** Its own spend (the parent's `result.spend` holds it too). */
  readonly spend: CostReport;
  /** Its own agents' tool calls (#395), in call order; its children's are in their records. */
  readonly toolCalls: readonly ToolCallRecord[];
  /** One record per visit of its own nodes (#395 S6), as `ExecutionRecord.steps`. */
  readonly steps: readonly ExecutionStepRecord[];
  /** Its own child executions, nested the same way. */
  readonly children: readonly EndedChildRecord[];
}

/** One child execution that ended, as a result reports it: with the pauses it asked (#267 S124 c). */
export interface ChildExecutionRecord extends Omit<EndedChildRecord, "children"> {
  /**
   * The resolved pauses its own steps asked, in the order asked — its children's are in their own
   * records; the root's `record.pauses` lists the whole tree's. Masked like the execution record.
   */
  readonly pauses: readonly PauseAnswerRecord[];
  /** Its own child executions, nested the same way. */
  readonly children: readonly ChildExecutionRecord[];
}

/** The children's records with the pauses each asked, from the tree's answers (nested). */
export function withChildPauses(
  children: readonly EndedChildRecord[],
  answers: readonly PauseAnswerRecord[],
): ChildExecutionRecord[] {
  return children.map((child) => ({
    ...child,
    pauses: answers.filter((answer) => answer.executionId === child.executionId),
    children: withChildPauses(child.children, answers),
  }));
}

/** A failure an `.onError` / `.onJoinError` side path took (#263 `toHaveHandledError`). */
export interface HandledErrorRecord {
  /** The failure, as a plain record (its class line and its causes). */
  readonly error: ErrorRecord;
  /** The node that failed: the step, or the launched node of a failed join's branch. */
  readonly at: ComponentRecord;
  /** The first node of the side path that took it. */
  readonly by: ComponentRecord;
}
