import type {
  A2ATaskKey,
  A2ATaskRecord,
  A2ATaskSave,
  A2ATaskStatus,
  NewA2ATask,
} from "../../infrastructure/a2a-task.repository.js";
import { StoreHoldPoint, type StoreMethod } from "./store-points.js";

/**
 * The A2A hold points (#811 AC4): the A2A task store's accept (`saveIfAbsent`) and status writes
 * (`compareAndSetStatus`), and the pause store's two atomic transitions a resume and a cancel race
 * on (`resolveByTenantIdAndPauseId`, `cancelByTenantIdAndPauseId`). The history keeps identities,
 * states and codes only — never a message, an answer or a pause's question.
 */

/** What the history keeps of a task's status: its state, its code, a cancel request's time. */
export const a2aStatusFacts = (status: A2ATaskStatus): Readonly<Record<string, unknown>> => ({
  state: status.state,
  ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  ...(status.cancelRequestedAt === undefined ? {} : { cancelRequested: true }),
});

/** What the history keeps of a task as written. */
const taskFacts = (task: A2ATaskRecord | undefined): unknown =>
  task === undefined ? null : { version: task.version, ...a2aStatusFacts(task.status) };

/** The A2A task store's accept and status writes. */
export const A2A_TASK_METHODS: Readonly<Record<string, StoreMethod>> = {
  saveIfAbsent: {
    point: StoreHoldPoint.A2ATaskSaveIfAbsent,
    keyOf: (args) => (args[0] as NewA2ATask).taskId,
    inputOf: (args) => {
      const { tenantId, taskId, messageId, skill } = args[0] as NewA2ATask;
      return { tenantId, taskId, messageId, skill };
    },
    outputOf: (save) => {
      const answer = save as A2ATaskSave;
      return {
        status: answer.status,
        ...("task" in answer ? { taskId: answer.task?.taskId } : {}),
      };
    },
  },
  compareAndSetStatus: {
    point: StoreHoldPoint.A2ATaskStatusWrite,
    keyOf: (args) => (args[0] as A2ATaskKey).taskId,
    inputOf: (args) => ({
      tenantId: (args[0] as A2ATaskKey).tenantId,
      expectedVersion: args[1],
      ...a2aStatusFacts(args[2] as A2ATaskStatus),
    }),
    outputOf: (written) => taskFacts(written as A2ATaskRecord | undefined),
  },
};

/** A pause store's method keyed by the pause's id (`(tenantId, pauseId, …)`). */
const onPause = (point: StoreHoldPoint): StoreMethod => ({
  point,
  keyOf: (args) => String(args[1]),
  inputOf: (args) => ({ tenantId: args[0], pauseId: args[1] }),
  outputOf: (answer) => ({ isChanged: answer !== undefined && answer !== false }),
});

/** The pause store's two transitions out of `Pending`, and its read of a pause by id. */
export const PAUSE_METHODS: Readonly<Record<string, StoreMethod>> = {
  resolveByTenantIdAndPauseId: onPause(StoreHoldPoint.PauseResolve),
  cancelByTenantIdAndPauseId: onPause(StoreHoldPoint.PauseCancel),
  findByTenantIdAndPauseId: {
    ...onPause(StoreHoldPoint.PauseFind),
    outputOf: (found) => ({ status: (found as { status?: unknown } | undefined)?.status }),
  },
};
