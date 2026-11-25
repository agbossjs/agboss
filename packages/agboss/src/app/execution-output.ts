import type { CompensationRecord } from "../flow/compensation.js";
import type { LaunchRecord } from "../flow/runtime/launch/records.js";
import type { ChildExecutionRecord, HandledErrorRecord } from "../flow/runtime/child-records.js";
import type { CostReport } from "../finops/usage.js";
import type { ExecutionRecord } from "../flow/runtime/execution-record.js";
import type { ToolCallRecord } from "../flow/runtime/tool-calls.js";
import type { ComponentRecord } from "../flow/runtime/records.js";
import type { PendingPause } from "../pause/index.js";
import type { Compacted } from "../run/compaction.js";
import type { ExecutionStatus } from "./types.js";

/** What every outcome of an execution carries, whatever its status. */
export interface ExecutionOutputBase {
  /** The execution's thread: `options.threadId` to continue it. */
  readonly threadId: string;
  /** The tenant of the thread (#261): `"default"` when the execution named none. */
  readonly tenantId: string;
  /**
   * The execution's id: the same in its observer events, `executionContext.executionId`, its
   * record and its trace, and kept by its resumes.
   */
  readonly executionId: string;
  /** Node ids (component names) in the order the execution visited them. */
  readonly path: readonly string[];
  readonly spend: CostReport;
  /**
   * Its parallel launches (#273), in the order they joined: each one's id, how many items (or
   * listed targets) there were and were launched — `{ items: 200, taken: 50 }` after `takeFirst` —
   * and how each branch ended.
   */
  readonly launches: readonly LaunchRecord[];
  /**
   * Its child executions that ended (#263), in the order they ended: each one's id, workflow, item,
   * start, how it ended (`ChildExecutionStatus`), its finish or error, its own spend and its own
   * children — nested records, never in the thread's conversation history.
   */
  readonly children: readonly ChildExecutionRecord[];
  /** The failures an `.onError` side path took, in order (`toHaveHandledError`). */
  readonly handledErrors: readonly HandledErrorRecord[];
  /**
   * The undo actions that ran (#340), in the order they ended: on a side path
   * (`CompensationReason.SidePath`) or automatically — a failed join's finished branches
   * (`JoinFailed`), a cancel's open actions — each with the step it undid, how it ended and when
   * (`toHaveCompensated`).
   */
  readonly compensations: readonly CompensationRecord[];
  /**
   * Its own agents' tool calls (#395), in call order — each with its step (the tool and the agent's
   * visit), input, output, `ToolCallStatus`, error and times; a child's are in `result.children`.
   * Real values, like `output`; `result.record.toolCalls` holds them masked.
   */
  readonly toolCalls: readonly ToolCallRecord[];
  /** What the compactions did before this execution read its thread (#120 S132), when one did. */
  readonly compacted?: readonly Compacted[];
  /** The conversation in the tracing UI (session = thread), when tracing is on. */
  readonly traceUrl?: string;
  /** The full execution record, with `app.execute(…, { includeRecord: true })`. */
  readonly record?: ExecutionRecord;
}

/** The execution reached a workflow finish: `output` is the finish's output DTO, the business result only. */
export interface FinishedExecutionOutput<TOutput = unknown> extends ExecutionOutputBase {
  readonly status: ExecutionStatus.Finished;
  /** The workflow finish the execution reached. */
  readonly finish: ComponentRecord;
  readonly output: TOutput;
  readonly pending: readonly [];
  readonly reason?: undefined;
}

/** The execution waits for answers: `pending` lists every pause it waits for (#267 AC1). */
export interface PausedExecutionOutput extends ExecutionOutputBase {
  readonly status: ExecutionStatus.Paused;
  /**
   * Every pause the execution waits for — several when parallel branches each wait. A
   * `PauseRespondent.Delegate` pause comes without its `pauseId`.
   */
  readonly pending: readonly PendingPause[];
  /**
   * An operator's `app.pause` froze it (#1341c): `pending` may be empty (it was parked at a step
   * boundary) or list the business pauses that wait too (`dual_paused`); nothing but `app.unpause`
   * moves it.
   */
  readonly isExternallyPaused: boolean;
  /** Why the operator paused it, when they said (only with `isExternallyPaused`). */
  readonly reason?: string | undefined;
  readonly finish?: undefined;
  readonly output?: undefined;
}

/** The execution was stopped (#1341): halted where it stood, its partial results kept, nothing undone. */
export interface StoppedExecutionOutput extends ExecutionOutputBase {
  readonly status: ExecutionStatus.Stopped;
  readonly pending: readonly [];
  readonly reason?: string | undefined;
  readonly finish?: undefined;
  readonly output?: undefined;
}

/**
 * The execution was cancelled (#1341): aborted, and what it had left undoable undone
 * (`compensations`). A cancel whose undo failed rejects with `ExecutionError.CompensationFailed`
 * instead.
 */
export interface CancelledExecutionOutput extends ExecutionOutputBase {
  readonly status: ExecutionStatus.Cancelled;
  readonly pending: readonly [];
  readonly reason?: string | undefined;
  readonly finish?: undefined;
  readonly output?: undefined;
}

/**
 * What one execution (or resume) of the app ended with, a union on `status`: `output` and `finish`
 * when it reached a workflow finish, `pending` when it waits for answers, `reason` when it was
 * stopped or cancelled; `path` = the node ids it visited, `spend` = its cost; `record` only with
 * `{ includeRecord: true }`.
 */
export type ExecutionOutput<TOutput = unknown> =
  | FinishedExecutionOutput<TOutput>
  | PausedExecutionOutput
  | StoppedExecutionOutput
  | CancelledExecutionOutput;
