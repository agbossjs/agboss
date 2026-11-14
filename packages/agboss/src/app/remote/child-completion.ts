import type { ChildExecutionQueueRepository } from "../../infrastructure/child-execution-queue.repository.js";
import type { QueuedChildExecution } from "../../infrastructure/child-execution-queue.repository.js";
import type { HeldExecutionLease } from "../execution-leases.js";
import { leaseScope } from "../lease-scope.js";
import type { AnnouncedPass } from "./child-end-event.js";
import { runQueuedChild, type QueuedChildParts } from "./queued-child-run.js";

/** A child's pass and whether its completion won the queue row. */
export interface CompletedChild {
  readonly pass: AnnouncedPass;
  readonly done: boolean;
}

/**
 * The child run and its completion in the queue under `lease` (#928): the lease is held up to and
 * including `completeByTenantIdAndExecutionId`, so an unanswered call there abandons it — never
 * released while the completion is in flight; the next holder finds a completion idempotent.
 */
export async function completedChild(
  parts: QueuedChildParts & { readonly queue: ChildExecutionQueueRepository },
  row: QueuedChildExecution,
  lease: HeldExecutionLease,
  signal: AbortSignal,
): Promise<CompletedChild | undefined> {
  return leaseScope(lease, async () => {
    const pass = await runQueuedChild(parts, row, lease, signal);
    if (pass === undefined) return undefined;
    const { tenantId, executionId } = row;
    const done = await parts.queue.completeByTenantIdAndExecutionId(
      tenantId,
      executionId,
      pass.end,
    );
    return { pass, done };
  });
}
