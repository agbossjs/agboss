import { ExecutionCancelledError } from "../../core/errors.js";
import { ExecutionPausedError, ExecutionStoppedError, isPause } from "../../app/lease-stopped.js";
import { isStop } from "../interrupt-requests.js";
import type { HeldExecutionLease } from "../execution-leases.js";
import type { QueuedChildExecution } from "../../infrastructure/child-execution-queue.repository.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import { treeKeyOf } from "../../infrastructure/in-memory-database.js";
import { remoteChildSignals } from "../../flow/runtime/remote/remote-child-signals.js";
import { watchRunningChild } from "./child-registry.js";
import { completedChild } from "./child-completion.js";
import { announcePass } from "./child-end-event.js";
import type { ChildWorkerParts } from "./child-workers.js";

/**
 * A claimed child run under its held lease (#333 PR 2, PR 4): by a general worker, and by the fork of an
 * isolated worker (#1286b). A cancel of its tree, a lease lost and the worker's interruption stop it; a
 * pass that ended answered or failed retires the lease, a paused one leaves it for the resume.
 */
export async function executeClaimed(
  parts: ChildWorkerParts,
  row: QueuedChildExecution,
  lease: HeldExecutionLease,
): Promise<void> {
  const { tenantId, executionId } = row;
  const { queue, interruption, log } = parts;
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, interruption, lease.signal]);
  const watching = watchRunningChild(parts, row, stop, lease);
  // a write of the child refused by its root's cancel stops it at once (#909)
  lease.whenCancelFound((cause) => {
    // a write refused by the tree's `Immediate` pause (#1341c) parks the child, as the watch does
    if (isPause(cause))
      stop.abort(new ExecutionPausedError({ message: "the child's tree was paused" }));
    else
      stop.abort(
        isStop(cause)
          ? new ExecutionStoppedError({ message: "the child's tree was stopped" })
          : new ExecutionCancelledError({ message: "the child's tree was cancelled" }),
      );
  });
  let isRetired = false;
  try {
    const ran = await completedChild(parts, row, lease, signal);
    if (ran === undefined) return;
    const { pass, done } = ran;
    // answered or failed: its lease is retired, no stale worker takes it again (#520)
    isRetired = pass.end.status !== ExecutionRecordStatus.Paused;
    // announced by the completion that won, never by its parent (#562), while this pass still
    // holds the lease; then the waiting parent reads the row, before the lease's cleanup (#917)
    await announcePass(queue, pass, done);
    remoteChildSignals.ended(treeKeyOf(tenantId, executionId));
    if (!done && !stop.signal.aborted) {
      const text = `child execution ${executionId} ended, but its tree no longer waits for it`;
      log.warn("child-queue.not-completed", text, { executionId, tenantId });
    }
  } finally {
    stop.abort();
    await watching;
    await lease.release({ isRetired });
  }
}
