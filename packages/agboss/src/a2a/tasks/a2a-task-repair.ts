import { isDeepStrictEqual } from "node:util";
import { ExecutionCancelOutcome, type ExecutionControl } from "../../app/execution-control.js";
import type { Clock } from "../../infrastructure/clock.js";
import {
  A2ATaskState,
  isTerminalA2ATaskState,
  type A2ATaskRecord,
  type A2ATaskRepository,
  type A2ATaskStatus,
} from "../../infrastructure/a2a-task.repository.js";
import type { Milliseconds } from "../../units/index.js";
import { durableStatusOf } from "./task-status.js";

/** The code of a task whose execution never started (design §4.3.2). */
export const A2A_START_LOST = "a2a.start-lost";

/** What repairing a task on read needs. */
export interface A2ATaskRepairParts {
  readonly tasks: A2ATaskRepository;
  readonly control: ExecutionControl;
  readonly clock: Pick<Clock, "now">;
  /** A task not terminal and unchanged this long is checked against its records (a lease period). */
  readonly staleAfter: Milliseconds;
  /** A submitted task with no execution this long after it was accepted is fenced (2 × lease). */
  readonly startTimeout: Milliseconds;
}

const START_LOST: A2ATaskStatus = {
  state: A2ATaskState.Failed,
  pendingPauses: [],
  errorCode: A2A_START_LOST,
  message: "the task's execution never started",
};

/**
 * A task as its execution's durable records say it is (#807, design §4.1.3 step 7 and §4.3.2):
 * observer events are at most once, so a read of a task that is not over and has not changed for
 * `staleAfter` checks its execution's records and writes what they say, by compare-and-set (a
 * writer that moved it meanwhile wins: the task is read again). A submitted task whose execution
 * never started is settled once `startTimeout` passed since it was accepted: the task's id is
 * fenced first — kept by the sweep, so that no execution can ever start under it — and when a start
 * kept it before (a starter frozen between keeping the id and its first record) that tree gets a
 * cancel request, which stops it before its first step; either way the task fails
 * `a2a.start-lost`, unless the records show the execution began meanwhile.
 */
export async function repairedTask(
  parts: A2ATaskRepairParts,
  task: A2ATaskRecord,
): Promise<A2ATaskRecord> {
  const { tasks, control, clock } = parts;
  if (isTerminalA2ATaskState(task.status.state)) return task;
  const now = clock.now();
  if (now.getTime() - task.statusAt.getTime() < parts.staleAfter) return task;
  const tree = { tenantId: task.tenantId, rootExecutionId: task.taskId, threadId: task.contextId };
  const status =
    durableStatusOf(await control.executionStateOf(tree)) ?? (await lostStartOf(parts, task, now));
  if (status === undefined || isDeepStrictEqual(status, task.status)) return task;
  const key = { tenantId: task.tenantId, taskId: task.taskId };
  const written = await tasks.compareAndSetStatus(key, task.version, status, now);
  return written ?? (await tasks.findById(key)) ?? task;
}

/** A submitted task whose execution has not started: settled once its start timed out. */
async function lostStartOf(
  parts: A2ATaskRepairParts,
  task: A2ATaskRecord,
  now: Date,
): Promise<A2ATaskStatus | undefined> {
  const { control } = parts;
  if (task.status.state !== A2ATaskState.Submitted) return undefined;
  if (now.getTime() - task.acceptedAt.getTime() < parts.startTimeout) return undefined;
  if (await control.claimExecutionId({ executionId: task.taskId, tenantId: task.tenantId }))
    return START_LOST;
  const tree = { tenantId: task.tenantId, rootExecutionId: task.taskId, threadId: task.contextId };
  const outcome = await control.cancelExecution({ ...tree, ownerId: task.ownerId });
  if (outcome === ExecutionCancelOutcome.AwaitingStart) return START_LOST;
  // it began meanwhile: its true state (its cancel ends it, and its events say so)
  return durableStatusOf(await control.executionStateOf(tree));
}
