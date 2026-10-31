import type { CompensationRecord } from "../flow/compensation.js";
import type { ExecutionOperation, ExecutionRejectedEvent } from "../core/observability.js";
import type { ExecutionObserverManager } from "../core/observer-manager.js";
import { DtoValidationError } from "../dto/errors.js";
import type { ExecutionEvent } from "../flow/observers/execution-event.js";
import { keyTextRuleOf } from "../core/errors.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { IncompatibleResumeError } from "../run/resume-guard.js";
import { InvalidThreadIdError } from "../run/thread.js";
import { ExecutionStatus, type ExecutionOutput } from "./types.js";
import { isHandedOver } from "./handed-over.js";
import type { GraphDeps } from "../graph/deps.js";
import { joinKeysOf } from "../flow/runtime/workflow-keys.js";
import type { ExecutionOrigin } from "../mesh/mesh-envelope.js";

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** The workflow an app runs: its name, the version it runs now and its `configHash` (#268 S93). */
export interface RunningWorkflow {
  readonly name: string;
  readonly version: string;
  readonly configHash: string;
}

/** The workflow its run dependencies run. */
const runningWorkflowOf = (deps: GraphDeps<string>): RunningWorkflow => ({
  name: deps.config.name,
  version: deps.config.version,
  configHash: joinKeysOf(deps).configHash,
});

/** An execution as its events name it: its id, thread, tenant and the version it started on. */
export interface ObservedExecution {
  readonly runId: string;
  readonly threadId: string;
  readonly tenantId: string;
  readonly startedVersion: string;
  /** Where its request came from (#398 PR 2): a trusted mesh peer's. */
  readonly origin?: ExecutionOrigin | undefined;
}

/** The common part of a root execution's events: it is its own root (a child's are `child.ts`'s). */
export const executionEventAt = (
  execution: ObservedExecution,
  deps: GraphDeps<string>,
): ExecutionEvent => eventOfWorkflow(execution, runningWorkflowOf(deps));

const eventOfWorkflow = (
  execution: ObservedExecution,
  workflow: RunningWorkflow,
): ExecutionEvent => ({
  executionId: execution.runId,
  parentExecutionId: undefined,
  rootExecutionId: execution.runId,
  threadId: execution.threadId,
  tenantId: execution.tenantId,
  workflow: {
    name: workflow.name,
    version: workflow.version,
    startedVersion: execution.startedVersion,
    configHash: workflow.configHash,
  },
  ...(execution.origin === undefined ? {} : { origin: execution.origin }),
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
  compensationsOf: () => readonly CompensationRecord[] = () => [],
): Promise<ExecutionOutput> {
  let result: ExecutionOutput;
  try {
    result = await leg();
  } catch (error) {
    if (!isHandedOver(error)) {
      const failed = { ...event, error: asError(error), compensations: compensationsOf() };
      await observer.onExecutionError(failed);
    }
    throw error;
  }
  // a pass that rests with answers already recorded is not a stop: the holder goes on (Q58)
  if (result.status === ExecutionStatus.Paused && result.pending.length > 0)
    await observer.onExecutionPause({ ...event, pending: result.pending });
  else if (result.finish !== undefined)
    await observer.onExecutionEnd({ ...event, finish: result.finish, spend: result.spend });
  return result;
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

/**
 * The tenant a rejection names (#568): the request's, `"default"` when it named none or one that is
 * no key's text — an id refused for its text is never echoed, as a thread id is not.
 */
const shownTenantIdOf = (tenantId: string | undefined): string =>
  tenantId === undefined || keyTextRuleOf(tenantId) !== undefined ? DEFAULT_TENANT_ID : tenantId;

/**
 * The `onExecutionRejected` event of a refused request: no execution id, no input values — and no
 * thread id that is not one (#538: an id refused for its text is never echoed, the rule names it).
 */
function rejectionOf(request: ExecutionRequest, error: unknown): ExecutionRejectedEvent {
  const { operation } = request;
  const threadId = error instanceof InvalidThreadIdError ? undefined : request.threadId;
  return {
    operation,
    ...(threadId === undefined ? {} : { threadId }),
    tenantId: shownTenantIdOf(request.tenantId),
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
  deps: GraphDeps<string>,
  request: ExecutionRequest,
  checks: () => Promise<T>,
): Promise<T> {
  try {
    return await checks();
  } catch (error) {
    if (error instanceof IncompatibleResumeError) {
      const paused = {
        runId: error.executionId,
        threadId: error.threadId,
        tenantId: request.tenantId ?? DEFAULT_TENANT_ID,
        startedVersion: error.paused.workflowVersion,
      };
      const event = executionEventAt(paused, deps);
      await observer.onExecutionError({ ...event, error, compensations: [] });
    } else await observer.onExecutionRejected(rejectionOf(request, error));
    throw error;
  }
}
