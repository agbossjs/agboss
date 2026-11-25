import { ExecutionError } from "../core/error-families/run-errors.js";
import { ValidationError } from "../core/error-families/effect-errors.js";
import type { CompensationRecord } from "../flow/compensation.js";
import type { ExecutionOperation, ExecutionRejectedEvent } from "../core/observability.js";
import type { ExecutionObserverManager } from "../core/observer-manager.js";
import type { ExecutionEvent } from "../flow/observers/execution-event.js";
import { keyTextRuleOf } from "../core/errors.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
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
 * at a finish), it was stopped → `onExecutionStop`, cancelled → `onExecutionCancel`, it threw →
 * `onExecutionError` (and the error is rethrown) — except a lost lease or an interruption, which
 * is not a failure: another instance goes on with the execution (#265).
 */
export async function observeLeg(
  observer: ExecutionObserverManager,
  event: ExecutionEvent,
  leg: () => Promise<ExecutionOutput>,
  compensationsOf: () => readonly CompensationRecord[] = () => [],
  /** What the pause event shows of the pending pauses: a child's masked by its chain (#1150). */
  shownPending: (pending: ExecutionOutput["pending"]) => Promise<ExecutionOutput["pending"]> = (
    pending,
  ) => Promise.resolve(pending),
  /** What the end event shows of the output: its finish DTO's sensitive fields masked (#1301). */
  shownOutput: (result: ExecutionOutput) => unknown = (result) => result.output,
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
  await announcedResult(observer, event, result, { pending: shownPending, output: shownOutput });
  return result;
}

/** What the events of a leg's result show of it: the pending pauses (#1150) and the output (#1301). */
interface ShownResult {
  readonly pending: (pending: ExecutionOutput["pending"]) => Promise<ExecutionOutput["pending"]>;
  readonly output: (result: ExecutionOutput) => unknown;
}

/** The event of a leg's result: paused, finished, stopped or cancelled. */
async function announcedResult(
  observer: ExecutionObserverManager,
  event: ExecutionEvent,
  result: ExecutionOutput,
  shown: ShownResult,
): Promise<void> {
  // a pass that rests with answers already recorded is not a stop: the holder goes on (Q58)
  switch (result.status) {
    case ExecutionStatus.Paused:
      // frozen from outside (#1341c): told even with no business pause open (a parked tree)
      if (result.pending.length > 0 || result.isExternallyPaused)
        await observer.onExecutionPause({
          ...event,
          pending: await shown.pending(result.pending),
          isExternallyPaused: result.isExternallyPaused,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        });
      break;
    case ExecutionStatus.Finished:
      await observer.onExecutionEnd({
        ...event,
        finish: result.finish,
        output: shown.output(result),
        spend: result.spend,
      });
      break;
    case ExecutionStatus.Stopped:
      await observer.onExecutionStop({ ...event, reason: result.reason, spend: result.spend });
      break;
    case ExecutionStatus.Cancelled:
      await observer.onExecutionCancel({
        ...event,
        reason: result.reason,
        compensations: result.compensations,
        spend: result.spend,
      });
      break;
  }
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
  if (error instanceof ValidationError.DtoInvalid) {
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
  const threadId = error instanceof ExecutionError.InvalidThreadId ? undefined : request.threadId;
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
 * this app may not resume (`ExecutionError.IncompatibleResume`), `onExecutionError` on that execution — its
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
    if (error instanceof ExecutionError.IncompatibleResume) {
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
