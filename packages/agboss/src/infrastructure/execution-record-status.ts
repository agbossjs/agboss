/**
 * Where an execution's record is (#265 S30): `Running` while its tree moves — what recovery looks
 * for — then how it ended, or `Paused`.
 */
export enum ExecutionRecordStatus {
  /** The tree moves (or its instance died while it moved: recovery continues it). */
  Running = "running",
  /** It reached a workflow finish. */
  Answered = "answered",
  /** A guard stopped it. */
  Guarded = "guarded",
  /** It failed (its error in the record's `stopReason`). */
  Failed = "failed",
  /** It was stopped (#1341): halted where it stood, nothing undone. */
  Stopped = "stopped",
  /** It was cancelled (#1341): aborted and its open undoable actions undone. */
  Cancelled = "cancelled",
  /** It waits for a decision. */
  Paused = "paused",
  /**
   * A child execution waiting in the application's queue for an instance to claim it (#333 PR 2,
   * `ChildPlacement.AnyWorker`): a `ChildExecutionQueueRepository` row only.
   */
  Queued = "queued",
  /**
   * A past turn an eval case wrote into its thread (#396 S6: `evalCase({ history })`), never run: a
   * turn its thread's memory reads, left out of `agboss eval score` and `agboss golden add`.
   */
  Written = "written",
}
