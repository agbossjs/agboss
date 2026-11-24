/**
 * How an operator's `app.stop` / `app.pause` reaches the step that is running (#1341b): after the
 * step in flight, or at once.
 */
export enum InterruptMode {
  /** The step in flight finishes and commits; no new step starts. The default. */
  AfterStep = "after-step",
  /**
   * The step in flight is aborted (`executionContext.signal`, then `executionContext.onInterrupted`
   * callbacks, awaited) and every new write of the tree is fenced at once.
   */
  Immediate = "immediate",
}

/** Why a step was interrupted: what an `executionContext.onInterrupted` callback is told. */
export enum InterruptReason {
  /** `app.pause` froze the execution. */
  Paused = "paused",
  /** `app.stop` halted it where it stood: nothing is undone. */
  Stopped = "stopped",
  /** `app.cancel` aborted it: what it had undoable is undone. */
  Cancelled = "cancelled",
  /** The step ran out of its time. */
  TimedOut = "timed-out",
  /** Another instance took the tree's lease: this one is no longer its holder. */
  HandedOver = "handed-over",
}

/** `app.stop(threadId, { … })`: the thread's tenant, the caller's owner, why and how fast. */
export interface StopOptions {
  readonly tenantId?: string | undefined;
  /** The caller's owner: a key's text (#589). */
  readonly ownerId?: string | undefined;
  /**
   * Why the thread is stopped: kept in its status history and given to `onExecutionStop` and the
   * stopped output. Free text, never a key.
   */
  readonly reason?: string | undefined;
  /** How the step in flight is treated; default `InterruptMode.AfterStep`. */
  readonly mode?: InterruptMode | undefined;
}

/** Where a stop request stands (#1341b). */
export enum StopRequestState {
  /** The thread's execution halted before the call returned (a rest, an execution not running). */
  Stopped = "stopped",
  /** The stop is durable and the holder is winding down: the execution call resolves `Stopped`. */
  Stopping = "stopping",
  /** There is nothing to stop: no running or paused execution, or one already ended. */
  NotRunning = "not-running",
}

/** What `app.stop(thread)` did. */
export interface StopOutput {
  readonly state: StopRequestState;
}
