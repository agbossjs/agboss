import { AGBossError } from "../../core/errors.js";
import type { StepDescriptor } from "./execution-context.js";

/** Where a context read failed: outside any execution, or after the step it belongs to ended. */
export interface UnavailableRead {
  /** The class that read it (`AuditRepository`), or `the app` for a direct read. */
  readonly consumer: string;
  /** The field read, with its context (`executionContext.step`, `tenantContext.tenantId`). */
  readonly field: string;
}

const stepLabelOf = (step: StepDescriptor): string =>
  `${step.nodeId}:${String(step.visitNumber)}${step.callId === undefined ? "" : ` tool call ${step.callId}`}`;

/**
 * The execution context was read where there is none (#280 S18): outside an execution (e.g. in a
 * constructor at application start), or after its step or tool call ended (a stray promise). It is
 * never `undefined` instead. Injecting the context is always allowed; only reading it fails.
 */
export class ExecutionContextUnavailableError extends AGBossError {
  static override readonly code: string = "context.unavailable";
  override name = "ExecutionContextUnavailableError";

  /** A read outside any execution. */
  static outside(read: UnavailableRead): ExecutionContextUnavailableError {
    return new ExecutionContextUnavailableError(
      `${read.consumer} read ${read.field} outside an execution. Read it inside a method called during an execution, or take ApplicationContext.`,
    );
  }

  /** A read through the frame of a step (or tool call) that has ended. */
  static ended(step: StepDescriptor, executionId: string): ExecutionContextUnavailableError {
    return new ExecutionContextUnavailableError(
      `the execution context was read after its step ended (${stepLabelOf(step)} in execution ${executionId}). Read what you need before the step returns, or pass the value explicitly.`,
    );
  }

  /** A read of `executionContext.fence` where no lease is held (#471): `why` says where it was. */
  static noFence(read: UnavailableRead, why: string): ExecutionContextUnavailableError {
    return new ExecutionContextUnavailableError(
      `${read.consumer} read ${read.field} ${why}. Fence an external write from a step (an action, a tool, a router, a judge) that runs during the execution's pass.`,
    );
  }
}
