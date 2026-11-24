import { ExecutionRecordStatus } from "../../../infrastructure/execution-record.repository.js";
import type { QueuedChildExecution } from "../../../infrastructure/child-execution-queue.repository.js";
import { ChildPlacement } from "../../child-placement.js";
import { ChildWorkerUnavailableError } from "../child-errors.js";
import { encodedRun, type RemoteChildRun } from "./remote-child-run.js";
import type { RemoteChildSite } from "./remote-child.js";

/** An `OtherWorker` child no other worker claimed within the claim timeout fails its parent's step (D9). */
export function checkClaimed(site: RemoteChildSite, row: QueuedChildExecution): void {
  const { clock, claimTimeout } = site.children;
  if (site.placement !== ChildPlacement.OtherWorker) return;
  if (row.status !== ExecutionRecordStatus.Queued) return;
  const waitedMs = clock.now().getTime() - row.queuedAt.getTime();
  if (waitedMs < claimTimeout) return;
  throw new ChildWorkerUnavailableError({
    childExecutionId: site.executionId,
    workflow: site.workflow,
    waitedMs,
  });
}

/** A queue row for `site` with `run`. */
export async function rowOf(
  site: RemoteChildSite,
  run: RemoteChildRun,
): Promise<QueuedChildExecution> {
  return {
    tenantId: site.tenantId,
    executionId: site.executionId,
    rootExecutionId: site.rootExecutionId,
    parentExecutionId: site.parentExecutionId,
    rootWorkflow: site.rootWorkflow,
    workflow: site.workflow,
    depth: site.depth,
    status: ExecutionRecordStatus.Queued,
    run: await encodedRun(site.checkpointer.serde, run),
    queuedAt: site.children.clock.now(),
    placement: site.placement,
    // an OtherWorker child is never claimed by the instance that launches it (#1286)
    ...(site.placement === ChildPlacement.OtherWorker
      ? { excludeInstanceId: site.children.instanceId }
      : {}),
  };
}
