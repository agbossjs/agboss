import {
  A2ATaskSaveStatus,
  A2ATaskState,
  type A2AMessageKey,
  type A2ATaskKey,
  type A2ATaskRecord,
  type A2ATaskRepository,
  type A2ATaskStatus,
  type NewA2ATask,
} from "../../infrastructure/a2a-task.repository.js";

/** The data of the A2A task contract's cases (#807). */

export const NINE = new Date("2026-01-05T09:00:00.000Z");
export const at = (minutes: number): Date => new Date(NINE.getTime() + minutes * 60_000);

export const SUBMITTED: A2ATaskStatus = { state: A2ATaskState.Submitted, pendingPauses: [] };
export const WORKING: A2ATaskStatus = { state: A2ATaskState.Working, pendingPauses: [] };
export const COMPLETED: A2ATaskStatus = {
  state: A2ATaskState.Completed,
  pendingPauses: [],
  finish: "receipt-workflow-finish",
  output: { orderId: "o-1", paid: true, lines: [{ sku: "a", amount: 12.5 }] },
};

/** A task of `ownerId` accepted with `messageId` at `acceptedAt`. */
export const newTask = (taskId: string, overrides: Partial<NewA2ATask> = {}): NewA2ATask => ({
  tenantId: "default",
  taskId,
  ownerId: "alice",
  contextId: "ctx-1",
  skill: "order-workflow-start",
  status: SUBMITTED,
  acceptedAt: NINE,
  messageId: `m-${taskId}`,
  requestHash: "h-1",
  ...overrides,
});

export const keyOf = (task: Pick<NewA2ATask, "tenantId" | "taskId">): A2ATaskKey => ({
  tenantId: task.tenantId,
  taskId: task.taskId,
});

export const messageKeyOf = (
  task: Pick<NewA2ATask, "tenantId" | "ownerId" | "messageId">,
): A2AMessageKey => ({
  tenantId: task.tenantId,
  ownerId: task.ownerId,
  messageId: task.messageId,
});

/** The task `saveIfAbsent` saved; fails the case when it did not. */
export async function saved(store: A2ATaskRepository, task: NewA2ATask): Promise<A2ATaskRecord> {
  const save = await store.saveIfAbsent(task);
  if (save.status !== A2ATaskSaveStatus.Saved) throw new Error(`${task.taskId}: ${save.status}`);
  return save.task;
}

/** Saves `count` tasks of alice, the n-th accepted n minutes after nine. */
export async function savedMany(store: A2ATaskRepository, count: number): Promise<void> {
  for (let n = 1; n <= count; n += 1)
    await saved(store, newTask(`t-${String(n)}`, { acceptedAt: at(n) }));
}

export const ids = (tasks: readonly A2ATaskRecord[]): readonly string[] =>
  tasks.map(({ taskId }) => taskId);
