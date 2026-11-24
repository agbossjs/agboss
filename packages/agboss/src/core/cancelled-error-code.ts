/** The codes of `ExecutionCancelledError` and its subclasses (`switch (error.code)` narrows): a cancel, a stop, and each one's fenced write (#909, #1341b). */
export type CancelledErrorCode =
  | "execution.cancelled"
  | "execution.cancelled.fenced"
  | "execution.stopped"
  | "execution.stopped.fenced"
  | "execution.paused.fenced"
  | "execution.paused";
