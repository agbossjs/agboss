import { AsyncLocalStorage } from "node:async_hooks";
import type { UsageRecord } from "../../finops/usage.js";
import { idempotencyKeyOf } from "./idempotency.js";
import type { StepDescriptor, WorkflowDescriptor } from "./execution-context.js";
import type { ContextFields } from "./context-values.js";
import type { TenantContext } from "./tenant-context.js";
import type { PiiTokenMap } from "../../pii/tokens.js";
import type { EndedChildRecord } from "../runtime/child-records.js";
import type { CompensationEntry } from "../compensation.js";
import type { InboundMesh } from "../../mesh/inbound-mesh.js";

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
  /** The index of a child launched per item (#263); `undefined` for a root or a single child. */
  readonly itemIndex?: number | undefined;
  /** The execution that launched this one and its launching step (#263); `undefined` at the root. */
  readonly parent?: ParentExecution | undefined;
  /**
   * The call chain a mesh call of this tree carries (#398): set on a root's frames — the chain its
   * request arrived with and its own hop; a child's calls carry its root's.
   */
  readonly mesh?: InboundMesh | undefined;
}

/** A child's parent (#263): its execution and the step that launched the child. */
export interface ParentExecution {
  readonly execution: ExecutionFacts;
  readonly step: StepDescriptor;
}

/** The root of an execution's tree: the execution itself when it has no parent. */
export function rootFactsOf(execution: ExecutionFacts): ExecutionFacts {
  let current = execution;
  while (current.parent !== undefined) current = current.parent.execution;
  return current;
}

/** The executions from the root of its tree down to `execution`. */
export function executionsFromRootOf(execution: ExecutionFacts): readonly ExecutionFacts[] {
  const line: ExecutionFacts[] = [execution];
  for (let parent = execution.parent; parent !== undefined; parent = parent.execution.parent)
    line.unshift(parent.execution);
  return line;
}

/** The level of an execution in its tree, from 1 at the root. */
export function depthOf(execution: ExecutionFacts): number {
  let depth = 1;
  for (let current = execution.parent; current !== undefined; current = current.execution.parent)
    depth += 1;
  return depth;
}

/**
 * What the framework's own code needs inside a frame (internal, never on the context): where a
 * tool call's model spend goes (a model call a framework service makes for a tool).
 */
export interface FrameServices {
  readonly reportUsage?: (usage: UsageRecord) => void;
  /**
   * The step's input as its node reads it (`InputOf<X>`, read when asked): what a test's
   * `when(…)` script binds a model call to (#262). Absent in a tool call's frame.
   */
  readonly input?: () => Readonly<Record<string, unknown>>;
  /** Where a child execution the step launched is recorded when it ends (#263). */
  readonly recordChild?: (record: EndedChildRecord) => void;
  /**
   * Where a failed child's PII tokens go (#263, #120): into the parent's state with the error, so
   * the side path that takes it reveals what the child masked — never on the error itself.
   */
  readonly keepPiiTokens?: (tokens: PiiTokenMap) => void;
  /**
   * Where a failed child's undone entries go (#340): into the parent's state with the error, so a
   * later pass never undoes them again.
   */
  readonly keepCompensations?: (entries: readonly CompensationEntry[]) => void;
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

/** Where an agent's loop is (#268 S93): its model call in the visit, the failed validations so far. */
export interface LoopProgress {
  readonly toolLoopIteration: number;
  readonly validationAttempts: number;
}

/**
 * Runs a part of an agent's loop — a model call, a tool call, an approval — in a frame of the
 * current step with the loop's progress on `step` (#268 S93), closed when the work ends; outside
 * any step the work runs as it is.
 */
export function inLoopFrame<TResult>(
  progress: LoopProgress,
  work: () => Promise<TResult>,
): Promise<TResult> {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed()) return work();
  const step = Object.freeze({ ...frame.step, ...progress });
  return runInFrame({ execution: frame.execution, step, services: frame.services }, work);
}
