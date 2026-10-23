import { ExecutionStatus, type ExecutionOutput } from "../app/types.js";
import { AGBossError, ExecutionCancelledError } from "../core/errors.js";
import { meshLimitBodyOf } from "../mesh/mesh-wire.js";
import { LimitExceededError } from "../graph/limits.js";
import type { ExecutionStreamEvent } from "../run/types.js";
import { A2AStatus, type A2AEvent, type A2AExecutionResponse } from "./types.js";

const unreachable = (value: never): never => {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
};

/** The A2A status of a run the app returned (every `ExecutionStatus` mapped; a new one fails to compile). */
export function statusOf(status: ExecutionStatus): A2AStatus {
  switch (status) {
    case ExecutionStatus.Finished:
      return A2AStatus.Finished;
    case ExecutionStatus.Paused:
      return A2AStatus.Paused;
    default:
      return unreachable(status);
  }
}

/** The A2A status of a run that threw: cancelled (its signal, `app.cancel`), a limit → limited, else failed. */
export function failureStatusOf(error: unknown, signal: AbortSignal | undefined): A2AStatus {
  if (signal?.aborted === true || error instanceof ExecutionCancelledError) {
    return A2AStatus.Cancelled;
  }
  if (error instanceof LimitExceededError) return A2AStatus.Limited;
  return A2AStatus.Failed;
}

/** The response for a run the app returned: its thread, status and finish output. */
/** The pauses a caller may answer (a `Channel` pause's id stays with its channel). */
function pauseIdsOf(output: ExecutionOutput): { readonly pauseIds?: readonly string[] } {
  const pauseIds = output.pending.flatMap((pause) =>
    pause.pauseId === undefined ? [] : [pause.pauseId],
  );
  return pauseIds.length === 0 ? {} : { pauseIds };
}

export function responseOf(output: ExecutionOutput): A2AExecutionResponse {
  return {
    threadId: output.threadId,
    status: statusOf(output.status),
    ...(output.finish === undefined ? {} : { finish: output.finish.name, output: output.output }),
    ...pauseIdsOf(output),
  };
}

/** The response for a run that threw. */
export function failureResponseOf(
  error: unknown,
  signal: AbortSignal | undefined,
  threadId: string | undefined,
): A2AExecutionResponse {
  const mesh = meshLimitBodyOf(error);
  return {
    ...(threadId === undefined ? {} : { threadId }),
    status: failureStatusOf(error, signal),
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof AGBossError ? { code: error.code } : {}),
    ...(mesh === undefined ? {} : { details: mesh.details }),
  };
}

/** A stream event of the run as an A2A progress event. */
export function eventOf(event: ExecutionStreamEvent): A2AEvent {
  switch (event.kind) {
    case "textDelta":
      return { type: "progress", payload: { step: "text", content: event.delta } };
    case "toolCall":
      return { type: "progress", payload: { step: "tool", content: event.tool } };
    default:
      return unreachable(event);
  }
}
