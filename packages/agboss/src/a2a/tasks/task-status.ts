import { AGBossError, ExecutionCancelledError } from "../../core/errors.js";
import { DurableExecutionStatus, type DurableExecutionState } from "../../app/execution-control.js";
import { A2ATaskState, type A2ATaskStatus } from "../../infrastructure/a2a-task.repository.js";
import type { PendingPause } from "../../pause/types.js";

/**
 * An execution's state as its A2A task's status (#807, design §3 and §4.1.7) — one mapping for the
 * projection of observer events and for the read repair from durable records.
 */

export const WORKING: A2ATaskStatus = { state: A2ATaskState.Working, pendingPauses: [] };

/** The code of a failure whose error names none (a project's own error), or read from a record. */
export const INTERNAL_FAILURE = "internal";

/**
 * The one text a caller reads of a failure (#807, security review): fixed per code. An error's own
 * message may carry internal details or unmasked PII (a model's, a tool's): it stays in the
 * execution's own records and logs, masked as they are, and never reaches the task.
 */
export const failureMessageOf = (code: string): string =>
  code === INTERNAL_FAILURE ? "the task failed" : `the task failed: ${code}`;

/** A failure with `code`: its code and its fixed text. */
const failedOf = (code: string): A2ATaskStatus => ({
  state: A2ATaskState.Failed,
  pendingPauses: [],
  errorCode: code,
  message: failureMessageOf(code),
});

/**
 * A rest at pauses: `INPUT_REQUIRED` with the pauses a caller may answer (those with a `pauseId`),
 * or — when only channels may answer — `WORKING` with a status message naming them (G13: a pause no
 * caller can answer invites no input). Pending pauses only channels answer are named in the message.
 */
export function pausedStatusOf(pending: readonly PendingPause[]): A2ATaskStatus {
  const answerable = pending.flatMap(({ pauseId, kind, ask }) =>
    pauseId === undefined ? [] : [{ pauseId, kind, ask }],
  );
  const channels = [
    ...new Set(
      pending.filter(({ pauseId }) => pauseId === undefined).map(({ channel }) => channel),
    ),
  ];
  const message =
    channels.length === 0 ? {} : { message: `awaiting ${channels.join(", ")} out of band` };
  return answerable.length === 0
    ? { ...WORKING, ...message }
    : { state: A2ATaskState.InputRequired, pendingPauses: answerable, ...message };
}

/** A finish reached: `COMPLETED` with the finish and its output. */
export const completedStatusOf = (finish: string, output: unknown): A2ATaskStatus => ({
  state: A2ATaskState.Completed,
  pendingPauses: [],
  finish,
  output,
});

const CANCELED: A2ATaskStatus = { state: A2ATaskState.Canceled, pendingPauses: [] };

/**
 * An execution's error as its task's end: a cancel is `CANCELED`; anything else `FAILED` with the
 * error's stable code (a limit's `limit.*`; `internal` for an error with none) and the code's fixed
 * text — never the error's message.
 */
export function failedStatusOf(error: Error): A2ATaskStatus {
  if (error instanceof ExecutionCancelledError) return CANCELED;
  return failedOf(error instanceof AGBossError ? error.code : INTERNAL_FAILURE);
}

/**
 * Where durable records put a task: `undefined` while its execution has not started (a sweep
 * decides, `a2a-task-repair.ts`). A failure read from a record has no code of its own (the
 * projection's event had it) and its reason stays in the record: `internal`, the fixed text.
 */
export function durableStatusOf(state: DurableExecutionState): A2ATaskStatus | undefined {
  switch (state.status) {
    case DurableExecutionStatus.NotStarted:
      return undefined;
    case DurableExecutionStatus.Running:
      return WORKING;
    case DurableExecutionStatus.Paused:
      return pausedStatusOf(state.pending);
    case DurableExecutionStatus.Finished:
      return completedStatusOf(state.finish, state.output);
    case DurableExecutionStatus.Cancelled:
      return CANCELED;
    case DurableExecutionStatus.Failed:
      return failedOf(INTERNAL_FAILURE);
  }
}
