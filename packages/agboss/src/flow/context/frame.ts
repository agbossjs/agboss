import { AsyncLocalStorage } from "node:async_hooks";
import type { UsageRecord } from "../../finops/usage.js";
import { idempotencyKeyOf } from "./idempotency.js";
import type { StepDescriptor, WorkflowDescriptor } from "./execution-context.js";
import type { ContextFields } from "./context-values.js";
import type { TenantContext } from "./tenant-context.js";

/**
 * The frame of a step (#280 S18): what the injected `ExecutionContext` reads. The node runner
 * enters one per node visit, the agent loop a nested one per tool call (with `callId`); each is
 * closed in `finally` when its step or tool call ends, and a read through a closed frame fails —
 * it never falls back to the frame around it.
 */

/** The flat fields of one execution, the same in every frame of it. */
export interface ExecutionFacts {
  readonly executionId: string;
  readonly threadId: string;
  readonly ownerId: string | undefined;
  readonly signal: AbortSignal;
  readonly workflow: WorkflowDescriptor;
  /** The execution's tenant (#261): frozen, linked to the application. */
  readonly tenant: TenantContext;
  /** The project's own fields of the execution (`execute(…, { execution })`), frozen. */
  readonly values: ContextFields;
}

/**
 * What the framework's own code needs inside a frame (internal, never on the context): where a
 * tool call's model spend goes (a model call a framework service makes for a tool).
 */
export interface FrameServices {
  readonly reportUsage?: (usage: UsageRecord) => void;
}

/** What a frame is opened with. */
export interface FrameSpec {
  readonly execution: ExecutionFacts;
  readonly step: StepDescriptor;
  readonly services?: FrameServices;
}

/** An open (or closed) frame. */
export interface Frame extends FrameSpec {
  readonly services: FrameServices;
  readonly isClosed: () => boolean;
}

const storage = new AsyncLocalStorage<Frame>();

/** The frame the current async context runs in; `undefined` outside any execution. */
export const currentFrame = (): Frame | undefined => storage.getStore();

/** Runs `work` in a new frame, closed when `work` settles (also when it throws or pauses). */
export async function runInFrame<TResult>(
  spec: FrameSpec,
  work: () => Promise<TResult>,
): Promise<TResult> {
  let closed = false;
  const frame: Frame = { ...spec, services: spec.services ?? {}, isClosed: () => closed };
  return storage.run(frame, async () => {
    try {
      return await work();
    } finally {
      closed = true;
    }
  });
}

/**
 * A tool call's frame inside its agent's: the same step with the call's id and its own key; with
 * `signal`, the call's own (the execution's and the call's timeout, #280 S45).
 */
export function toolCallFrameOf(
  parent: FrameSpec,
  callId: string,
  services: FrameServices = {},
  signal?: AbortSignal,
): FrameSpec {
  const { step, execution } = parent;
  const idempotencyKey = idempotencyKeyOf({
    executionId: execution.executionId,
    nodeId: step.nodeId,
    visitNumber: step.visitNumber,
    itemIndex: step.itemIndex,
    callId,
  });
  const callExecution = signal === undefined ? execution : Object.freeze({ ...execution, signal });
  return {
    execution: callExecution,
    step: Object.freeze({ ...step, callId, idempotencyKey }),
    services,
  };
}

/**
 * Runs a tool call's work in its own frame inside the current step's (#280): `step.callId` set,
 * closed when the call ends while the agent's step goes on. Outside any step (an agent loop run on
 * its own) the work runs as it is.
 */
export function inToolCallFrame<TResult>(
  callId: string,
  services: FrameServices,
  work: () => Promise<TResult>,
  signal?: AbortSignal,
): Promise<TResult> {
  const step = currentFrame();
  return step === undefined
    ? work()
    : runInFrame(toolCallFrameOf(step, callId, services, signal), work);
}
