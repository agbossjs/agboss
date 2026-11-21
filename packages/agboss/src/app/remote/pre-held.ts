import type { QueuedChildExecution } from "../../infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import type { HeldExecutionLease } from "../execution-leases.js";

/**
 * A reclaimed child's lease kept for one look's own claim (#720): the look took it out of `preHeld` when it
 * started the child, so one still there is the look's that started nothing — it gets its lease back, once,
 * and is forgotten, never taken by the child's next claim.
 */
export async function releasedUnlessUsed(
  preHeld: Map<string, HeldExecutionLease>,
  key: string,
  lease: HeldExecutionLease,
): Promise<void> {
  if (preHeld.get(key) !== lease) return;
  preHeld.delete(key);
  await lease.release();
}

/** The row of a running child a reclaim puts back in the queue: queued, as of `queuedAt`. */
export const requeuedOf = (
  current: QueuedChildExecution,
  queuedAt: Date,
): QueuedChildExecution => ({
  ...current,
  status: ExecutionRecordStatus.Queued,
  queuedAt,
});
