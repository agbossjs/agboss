import { ExecutionRecordStatus } from "../../../infrastructure/execution-record.repository.js";
import type { QueuedChildExecution } from "../../../infrastructure/child-execution-queue.repository.js";
import { ChildPlacement } from "../../child-placement.js";
import { StepError } from "../../../core/error-families/step-errors.js";
import { stepCoordinatesOf } from "../../../graph/step-coordinates.js";
import { ComponentKind } from "../records.js";
import { encodedRun, type RemoteChildRun } from "./remote-child-run.js";
import type { RemoteChildSite } from "./remote-child.js";

/**
 * Whether an `OtherWorker` child's claim timeout is up and a worker claimed it just now (#1286a).
 * Past the timeout the row is withdrawn atomically, only while it is still `Queued`, and the
 * parent's step fails (D9): a worker that comes later never runs a child its parent gave up on.
 * When a claim won the race the child is no longer the parent's to give up: `true`, the parent
 * reads the row again and waits for it. `false`: nothing is due.
 */
export async function lostToClaim(
  site: RemoteChildSite,
  row: QueuedChildExecution,
): Promise<boolean> {
  const { clock, claimTimeout, queue } = site.children;
  if (site.placement !== ChildPlacement.OtherWorker) return false;
  if (row.status !== ExecutionRecordStatus.Queued) return false;
  const waitedMs = clock.now().getTime() - row.queuedAt.getTime();
  if (waitedMs < claimTimeout) return false;
  const isWithdrawn = await queue.withdrawByTenantIdAndExecutionIdIfQueued(
    site.tenantId,
    site.executionId,
  );
  if (!isWithdrawn) return true;
  throw new StepError.ChildWorkerUnavailable({
    ...stepCoordinatesOf(site.workflow, ComponentKind.Workflow),
    childExecutionId: site.executionId,
    workflow: site.workflow,
    waitedMs,
    message: `Child workflow "${site.workflow}" (execution ${site.executionId}) was claimed by no other worker in ${String(waitedMs)} ms: ChildPlacement.OtherWorker never runs on the instance that launched it`,
    details: { childExecutionId: site.executionId, workflow: site.workflow, waitedMs },
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
