import { ExecutionRecordStatus } from "./execution-record.repository.js";
import type {
  ChildExecutionQueueCounts,
  QueuedChildExecution,
} from "./child-execution-queue.repository.js";

/** How a child queue counts and orders its rows: the same in memory and in a store of the application's own. */

/** The depth of `children`: what `countByStatus()` answers for these rows. */
export function queueCountsOf(children: Iterable<QueuedChildExecution>): ChildExecutionQueueCounts {
  let queued = 0;
  let running = 0;
  let oldest: number | undefined;
  for (const child of children) {
    if (child.status === ExecutionRecordStatus.Running) running += 1;
    if (child.status !== ExecutionRecordStatus.Queued) continue;
    queued += 1;
    const at = child.queuedAt.getTime();
    oldest = oldest === undefined ? at : Math.min(oldest, at);
  }
  return { queued, running, oldestQueuedAt: oldest === undefined ? undefined : new Date(oldest) };
}

/** The order of the claims: the deepest first, then the longest waiting. */
export const claimOrder = (left: QueuedChildExecution, right: QueuedChildExecution): number =>
  right.depth - left.depth || left.queuedAt.getTime() - right.queuedAt.getTime();
