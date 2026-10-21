import { AGBossError } from "../core/errors.js";

/**
 * The instance lost the lease of the tree it was moving (#265, Q58): the lease expired — the
 * holder was frozen or cut off longer than the lease — and another instance took it, or may take
 * it now (#335: the lease store did not answer until the lease ran out); the other instance
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

/**
 * The lease ran out without a renewal the store confirmed (#335 S1): no other instance took it
 * yet, so only the message differs — the class, `code` and fields are `ExecutionLeaseLostError`'s.
 */
export function leaseExpiredError(rootExecutionId: string): ExecutionLeaseLostError {
  const error = new ExecutionLeaseLostError(rootExecutionId);
  error.message = `the lease of execution ${rootExecutionId} expired before its store confirmed a renewal: this instance stops, another instance continues the execution`;
  return error;
}
