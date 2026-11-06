import { ExecutionCancelOutcome } from "../../app/execution-control.js";
import {
  A2ATaskState,
  isTerminalA2ATaskState,
  type A2ATaskRecord,
  type A2ATaskStatus,
} from "../../infrastructure/a2a-task.repository.js";
import {
  endedUnstarted,
  ownedTask,
  repairedOf,
  taskKeyOf,
  type A2ARequestCaller,
  type A2AServerParts,
} from "./a2a-server-parts.js";
import { taskNotCancelable, taskNotFound } from "./a2a-wire-errors.js";

/**
 * `CancelTask` (#808, design §4.1.5): that task only — never another run of its context. A task
 * whose execution has not started is fenced first: its reserved id kept now, so no execution can
 * ever start under it, and it is `CANCELED` at once; one that started gets its tree's cancel request
 * (`cancelExecution`) — aborted here, ended paused, or stopped by its holder elsewhere within one
 * renewal (its task still `WORKING` until then, as the spec allows). A task that is over is
 * `-32002`.
 */

const CANCELED: A2ATaskStatus = { state: A2ATaskState.Canceled, pendingPauses: [] };

/** The task once its cancel is asked for: `CANCELED`, or still moving while its holder stops. */
export async function canceledTask(
  parts: A2AServerParts,
  caller: A2ARequestCaller,
  taskId: string,
): Promise<A2ATaskRecord> {
  const task = await ownedTask(parts, caller, taskId);
  if (isTerminalA2ATaskState(task.status.state)) throw taskNotCancelable();
  const identity = { executionId: task.taskId, tenantId: task.tenantId };
  if (
    task.status.state === A2ATaskState.Submitted &&
    (await parts.control.claimExecutionId(identity))
  )
    return canceledOrRefused(await endedUnstarted(parts, task, CANCELED));
  const outcome = await parts.control.cancelExecution({
    tenantId: task.tenantId,
    rootExecutionId: task.taskId,
    threadId: task.contextId,
    ownerId: task.ownerId,
  });
  // aborted here: its run's end is near, and its task's status with it
  if (outcome === ExecutionCancelOutcome.Aborted) await parts.runs.settledOf(taskKeyOf(task));
  const read = await parts.tasks.findById(taskKeyOf(task));
  if (read === undefined) throw taskNotFound();
  return canceledOrRefused(await repairedOf(parts, read, true));
}

/** The task after its cancel; one another end took first is not cancelable (`-32002`). */
function canceledOrRefused(task: A2ATaskRecord): A2ATaskRecord {
  const { state } = task.status;
  if (isTerminalA2ATaskState(state) && state !== A2ATaskState.Canceled) throw taskNotCancelable();
  return task;
}
