import { ExecutionCancelledError } from "../core/errors.js";
import type { ExecutionOperation, ExecutionRejectedEvent } from "../core/observability.js";
import type { ExecutionObserverManager } from "../core/observer-manager.js";
import { DtoValidationError } from "../dto/errors.js";
import type { ExecutionEvent } from "../flow/observers/execution-event.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { IncompatibleResumeError } from "../run/resume-guard.js";
import { ExecutionStatus, type ExecutionOutput } from "./types.js";
import { isHandedOver } from "./handed-over.js";

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** The workflow an app runs: its name and the version it runs now. */
export interface RunningWorkflow {
  readonly name: string;
  readonly version: string;
}

/** An execution as its events name it: its id, thread, tenant and the version it started on. */
export interface ObservedExecution {
  readonly runId: string;
  readonly threadId: string;
  readonly tenantId: string;
  readonly startedVersion: string;
}

/** The common part of a root execution's events: it is its own root (a child's are `child.ts`'s). */
export const executionEventAt = (
  execution: ObservedExecution,
  workflow: RunningWorkflow,
): ExecutionEvent => ({
  executionId: execution.runId,
  parentExecutionId: undefined,
  rootExecutionId: execution.runId,
  threadId: execution.threadId,
  tenantId: execution.tenantId,
  workflow: { ...workflow, startedVersion: execution.startedVersion },
});

/**
 * One leg of an execution (its `execute`, or a `resume`), observed: it paused →
 * `onExecutionPause`, it finished → `onExecutionEnd` (once per execution: only the leg that ends
 * at a finish), it threw → `onExecutionError` (and the error is rethrown) — except a lost lease or
 * an interruption, which is not a failure: another instance goes on with the execution (#265).
 */
export async function observeLeg(
  observer: ExecutionObserverManager,
  event: ExecutionEvent,
  leg: () => Promise<ExecutionOutput>,
): Promise<ExecutionOutput> {
  let result: ExecutionOutput;
  try {
    result = await leg();
  } catch (error) {
    if (!isHandedOver(error)) await observer.onExecutionError({ ...event, error: asError(error) });
    throw error;
  }
  // a pass that rests with answers already recorded is not a stop: the holder goes on (Q58)
  if (result.status === ExecutionStatus.Paused && result.pending.length > 0)
    await observer.onExecutionPause({ ...event, pending: result.pending });
  else if (result.finish !== undefined)
    await observer.onExecutionEnd({ ...event, finish: result.finish, spend: result.spend });
  return result;
}

/** A paused execution was cancelled instead of resumed: it ends as failed, `ExecutionCancelledError`. */
export function observeCancelledPause(
  observer: ExecutionObserverManager,
  event: ExecutionEvent,
): Promise<void> {
  const error = new ExecutionCancelledError(
    `thread "${event.threadId}" was cancelled while paused`,
  );
  return observer.onExecutionError({ ...event, error });
}

/** What a caller asked for, before the app found (or started) its execution. */
export interface ExecutionRequest {
  readonly operation: ExecutionOperation;
  readonly threadId?: string | undefined;
  /** The tenant it named, when known (invalid tenant values name none: `"default"`). */
  readonly tenantId?: string | undefined;
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

/** The `onExecutionRejected` event of a refused request: no execution id, no input values. */
function rejectionOf(request: ExecutionRequest, error: unknown): ExecutionRejectedEvent {
  const { operation, threadId } = request;
  return {
    operation,
    ...(threadId === undefined ? {} : { threadId }),
    tenantId: request.tenantId ?? DEFAULT_TENANT_ID,
    code: codeOf(error),
    message: safeMessageOf(error),
  };
}

/**
 * The checks a request passes before its execution starts or is located (owner, paused, input,
 * budgets). A refusal is observed and rethrown: `onExecutionRejected`; or, for a paused execution
 * this app may not resume (`IncompatibleResumeError`), `onExecutionError` on that execution — its
 * id, its thread; it stays paused.
 */
export async function admitRequest<T>(
  observer: ExecutionObserverManager,
  workflow: RunningWorkflow,
  request: ExecutionRequest,
  checks: () => Promise<T>,
): Promise<T> {
  try {
    return await checks();
  } catch (error) {
    if (error instanceof IncompatibleResumeError) {
      const paused = {
        runId: error.runId,
        threadId: error.thread,
        tenantId: request.tenantId ?? DEFAULT_TENANT_ID,
        startedVersion: error.paused.workflowVersion,
      };
      await observer.onExecutionError({ ...executionEventAt(paused, workflow), error });
    } else await observer.onExecutionRejected(rejectionOf(request, error));
    throw error;
  }
}
