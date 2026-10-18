import { WorkflowCancelledError } from "../core/errors.js";
import type { AppState, RunOperation, RunRejectedEvent } from "../core/observability.js";
import type { ObserverManager } from "../core/observer-manager.js";
import { DtoValidationError } from "../dto/errors.js";
import { IncompatibleResumeError } from "../run/resume-guard.js";
import type { ExecutionOutput } from "./types.js";
import { isHandedOver } from "./handed-over.js";

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * One leg of a run (its `execute`, or a `resume`), observed: it paused → `onWorkflowPause`, it
 * finished → `onWorkflowEnd`, it threw → `onError` (and the error is rethrown) — except a lost
 * lease or an interruption, which is not a failure: another instance goes on with the run (#265).
 */
export async function observeLeg(
  observer: ObserverManager,
  state: AppState,
  leg: () => Promise<ExecutionOutput>,
): Promise<ExecutionOutput> {
  let result: ExecutionOutput;
  try {
    result = await leg();
  } catch (error) {
    if (!isHandedOver(error)) await observer.onError(asError(error), state);
    throw error;
  }
  await (result.pause === undefined
    ? observer.onWorkflowEnd(result, state)
    : observer.onWorkflowPause({ pause: result.pause, state }));
  return result;
}

/** A paused run was cancelled instead of resumed: it ends as failed, `WorkflowCancelledError`. */
export function observeCancelledPause(observer: ObserverManager, state: AppState): Promise<void> {
  const thread = state.threadId ?? "";
  return observer.onError(
    new WorkflowCancelledError(`thread "${thread}" was cancelled while paused`),
    state,
  );
}

/** What a caller asked for, before the app found (or started) its run. */
interface RunRequest {
  readonly operation: RunOperation;
  readonly threadId?: string | undefined;
}

const codeOf = (error: unknown): string =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "error";

/** The error's message without the input values: a DTO's issues name only their fields. */
const safeMessageOf = (error: unknown): string => {
  if (error instanceof DtoValidationError) {
    return `invalid ${error.dto} at ${error.issues.map((issue) => issue.path).join(", ")}`;
  }
  return asError(error).message;
};

/** The `onRunRejected` event of a refused request: no run id, no input values. */
function rejectionOf(request: RunRequest, error: unknown): RunRejectedEvent {
  const { operation, threadId } = request;
  const thread = threadId === undefined ? {} : { threadId };
  return {
    operation,
    ...thread,
    code: codeOf(error),
    message: safeMessageOf(error),
    state: thread,
  };
}

/**
 * The checks a request passes before its run starts or is located (owner, paused, input). A refusal
 * is observed and rethrown: `onRunRejected`; or, for a paused run this app may not resume
 * (`IncompatibleResumeError`), `onError` on that run — its id, its thread; it stays paused.
 */
export async function admitRequest<T>(
  observer: ObserverManager,
  request: RunRequest,
  checks: () => Promise<T>,
): Promise<T> {
  try {
    return await checks();
  } catch (error) {
    await (error instanceof IncompatibleResumeError
      ? observer.onError(error, { runId: error.runId, threadId: error.thread })
      : observer.onRunRejected(rejectionOf(request, error)));
    throw error;
  }
}
