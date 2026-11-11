import { TaskState, type Message, type Task, type TaskStatus } from "@a2a-js/sdk";
import type { DtoClass } from "../../dto/types.js";
import type { MeshLimitError } from "../../mesh/mesh-errors.js";
import { meshLimitErrorOf } from "../../mesh/mesh-wire.js";
import { A2A_MESH_EXTENSION } from "../a2a-extension-uris.js";
import { answerPartsOf, dataOf, rawOutputOf, textOf } from "./a2a-parts.js";
import { receivedFileOf } from "./a2a-client-files.js";
import type { A2ARemotePeer } from "./a2a-card.js";
import type { A2ATaskResult } from "./a2a-client-options.js";
import { A2ARemoteCallError, A2ARemoteCallReason, remoteCodeOf } from "./a2a-client-errors.js";
import {
  A2ATaskCanceledError,
  A2ATaskEnd,
  A2ATaskFailedError,
  A2ATaskInterruptedError,
  A2ATaskInterruption,
  safeTaskIdOf,
} from "./a2a-task-errors.js";

/**
 * How a remote task's state maps to the call's outcome (#809, design §4.2 "Outcomes"): COMPLETED is
 * the output, FAILED with an AGBoss mesh limit the same limit error, any other FAILED or REJECTED
 * `A2ATaskFailedError`, CANCELED `A2ATaskCanceledError`, INPUT_REQUIRED / AUTH_REQUIRED
 * `A2ATaskInterruptedError`.
 */

const TERMINAL = new Set<TaskState | undefined>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

const INTERRUPTED = new Set<TaskState | undefined>([
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
]);

/** A task's state; `undefined` for a task without a status. */
export const stateOf = (task: Task): TaskState | undefined => task.status?.state;

/** Whether the task's state ends the wait: terminal or interrupted. */
export const isSettled = (task: Task): boolean =>
  TERMINAL.has(stateOf(task)) || INTERRUPTED.has(stateOf(task));

export const isInterrupted = (task: Task): boolean => INTERRUPTED.has(stateOf(task));

/** The AGBoss failure facts of a failed task: `status.message.metadata[mesh].{ code, details }`. */
function meshFailureOf(status: TaskStatus): { readonly code: unknown; readonly details: unknown } {
  const entry: unknown = status.message?.metadata?.[A2A_MESH_EXTENSION];
  const read = (key: string): unknown =>
    typeof entry === "object" && entry !== null ? Reflect.get(entry, key) : undefined;
  return { code: read("code"), details: read("details") };
}

/**
 * The mesh limit an AGBoss agent refused a task with before anything ran (#849): a `REJECTED` task
 * whose status names a loop or the hop limit, with its facts (`rejectedStatusOf`); else `undefined`
 * — any other REJECTED task, or any other state, is no refusal.
 */
export function meshRefusalOf(task: Task): MeshLimitError | undefined {
  const { status } = task;
  if (status?.state !== TaskState.TASK_STATE_REJECTED) return undefined;
  return meshLimitErrorOf(meshFailureOf(status));
}

/**
 * The error of a settled task that gives no output — `undefined` for COMPLETED. A state the client
 * cannot read (none, unspecified, unknown) is `A2ARemoteCallError`.
 */
export function failureOf(task: Task, agent: string): Error | undefined {
  const ids = { agent, taskId: task.id, contextId: safeTaskIdOf(task.contextId) ?? "" };
  const malformed = new A2ARemoteCallError({
    agent,
    reason: A2ARemoteCallReason.MalformedAnswer,
    taskId: task.id,
  });
  const { status } = task;
  if (status === undefined) return malformed;
  const failedAs = (end: A2ATaskEnd): Error => {
    const failure = meshFailureOf(status);
    const remoteCode = remoteCodeOf(failure.code);
    return meshLimitErrorOf(failure) ?? new A2ATaskFailedError({ ...ids, end, remoteCode });
  };
  switch (status.state) {
    case TaskState.TASK_STATE_COMPLETED:
      return undefined;
    case TaskState.TASK_STATE_FAILED:
      return failedAs(A2ATaskEnd.Failed);
    case TaskState.TASK_STATE_REJECTED:
      return failedAs(A2ATaskEnd.Rejected);
    case TaskState.TASK_STATE_CANCELED:
      return new A2ATaskCanceledError(ids);
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return new A2ATaskInterruptedError({
        ...ids,
        interruption: A2ATaskInterruption.InputRequired,
      });
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return new A2ATaskInterruptedError({
        ...ids,
        interruption: A2ATaskInterruption.AuthRequired,
      });
    default:
      return malformed;
  }
}

/**
 * A typed call's raw output (#809 AC1): the COMPLETED task's artifact — or a stateless message's
 * parts — read for `output` (a data part, text for a text finish). A task that ended otherwise
 * throws its failure; an answer with no readable output is `A2ARemoteCallError`.
 */
export function outputOf(
  agent: string,
  output: DtoClass,
  task: Task | undefined,
  message: Message | undefined,
): unknown {
  const failure = task === undefined ? undefined : failureOf(task, agent);
  if (failure !== undefined) throw failure;
  const answer = task ?? message;
  const raw = answer === undefined ? undefined : rawOutputOf(output, answerPartsOf(answer));
  if (raw === undefined) {
    const reason = task === undefined ? A2ARemoteCallReason.NoTask : A2ARemoteCallReason.NoOutput;
    throw new A2ARemoteCallError({ agent, reason, taskId: task?.id });
  }
  return raw.value;
}

/** An untyped call's result: an interrupted task given back, any other failure thrown. */
export function untypedResultOf(
  settled: {
    readonly task: Task | undefined;
    readonly accepted: { readonly message: Message | undefined };
    readonly peer: A2ARemotePeer;
  },
  agent: string,
): A2ATaskResult {
  const { task, peer } = settled;
  const { message } = settled.accepted;
  const failure = task === undefined || isInterrupted(task) ? undefined : failureOf(task, agent);
  if (failure !== undefined) throw failure;
  const answer = task ?? message;
  // Stryker disable next-line ArrayDeclaration: any array of no part reads as no text and no data
  const parts = answer === undefined ? [] : answerPartsOf(answer);
  const files = parts.flatMap((part) => receivedFileOf(part) ?? []);
  return { task, message, text: textOf(parts), data: dataOf(parts)?.value, files, peer };
}
