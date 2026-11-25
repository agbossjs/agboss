import { childTakeOf } from "./child-registry.js";
import { executeClaimed } from "./claimed-child-run.js";
import type { ChildWorkerParts, ChildWorkers } from "./child-workers.js";
import { requeueIfStillClaimed } from "./look-pacing.js";

/**
 * The worker of an isolated fork (#1286b): it claims the one child the process was started for, by
 * its id (`claimIsolatedWorkerByTenantIdAndExecutionId`), runs it under its lease like any claimed
 * child, and tells `onEnded` once — when the child's pass ended (answered, failed or paused), the claim
 * found nothing, or the lease was another worker's (the row is queued again). It sweeps nothing,
 * claims nothing else and reclaims no other child: a fork that dies mid-step leaves its child
 * `Running`, and a live worker takes the lease over once it is free.
 */

/** The child a fork runs, and what it tells when it is done. */
export interface ChildWorkerTarget {
  readonly tenantId: string;
  readonly executionId: string;
  readonly onEnded: () => void;
}

export function startTargetWorker(
  parts: ChildWorkerParts,
  target: ChildWorkerTarget,
): ChildWorkers {
  const { tenantId, executionId } = target;
  const run = async (): Promise<void> => {
    try {
      const row = await parts.queue
        .claimIsolatedWorkerByTenantIdAndExecutionId(tenantId, executionId)
        .catch((error: unknown) => {
          const text = `the child queue could not be read: ${String(error)}`;
          parts.log.warn("child-queue.failed", text, {});
          return undefined;
        });
      if (row === undefined) return;
      const take = childTakeOf(parts.queue, row, false);
      const lease = await parts.leases.tryHold({ tenantId, rootExecutionId: executionId }, take);
      if (lease === undefined) {
        await requeueIfStillClaimed(parts.queue, row, () => undefined);
        return;
      }
      await executeClaimed(parts, row, lease);
    } finally {
      target.onEnded();
    }
  };
  const done = run();
  return { stop: () => done.catch(() => undefined) };
}
