import { AGBossError } from "../core/errors.js";

/**
 * The instance lost the lease of the tree it was moving (#265, Q58): the lease expired — the
 * holder was frozen or cut off longer than the lease — and another instance took it, which now
 * continues the tree. Not a failure of the execution: it reaches neither `.onError`, `onError` nor
 * the execution record; only the call that was moving the tree rejects with it.
 */
export class ExecutionLeaseLostError extends AGBossError {
  static override readonly code: string = "execution.lease-lost";
  override name = "ExecutionLeaseLostError";
  /** The root execution of the tree whose lease was lost. */
  readonly rootExecutionId: string;

  constructor(rootExecutionId: string) {
    super(
      `the lease of execution ${rootExecutionId} expired and another instance took it: it continues the execution`,
    );
    this.rootExecutionId = rootExecutionId;
  }
}

/** Whether the work was stopped because its instance lost the tree's lease. */
export const isLeaseLost = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true && signal.reason instanceof ExecutionLeaseLostError;
