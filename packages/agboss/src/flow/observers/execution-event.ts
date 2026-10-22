import type { StepDescriptor, StepRecord, WorkflowRecord } from "../context/execution-context.js";
import { plainRecordOf } from "../runtime/records.js";
import {
  currentFrame,
  rootFactsOf,
  type ExecutionFacts,
  type FrameSpec,
} from "../context/frame.js";

/**
 * What every observer event carries (#261): one event object per hook, plain data — never the
 * framework's internal state. Execution events name the execution, its thread, tenant and workflow;
 * node events add the step they are about (`StepRecord`, the serialized `executionContext.step`).
 */

/** What every execution event carries: which execution, thread, tenant and workflow. */
export interface ExecutionEvent {
  /** Unique per execution; the same after a resume (`result.runId`). */
  readonly executionId: string;
  /** The parent execution (#263); `undefined` at the root. */
  readonly parentExecutionId: string | undefined;
  /** The root execution's id; the execution's own at the root. */
  readonly rootExecutionId: string;
  readonly threadId: string;
  /** The tenant the execution works for (`"default"` when it names none). */
  readonly tenantId: string;
  /** Which workflow: filter with `event.workflow.name === nameOf(SupportWorkflow)`. */
  readonly workflow: WorkflowRecord;
}

/** An event about one step of an execution: an agent, a router, an action, a tool call, a model call. */
export interface NodeEvent extends ExecutionEvent {
  /** The step: `step.component.name`, `step.nodeId` (`critic-agent#2`), `step.copyNumber`, … */
  readonly step: StepRecord;
}

/** The step as plain data: its component's record without its class, its join keys (#268 S93). */
export const stepRecordOf = (step: StepDescriptor): StepRecord => ({
  component: plainRecordOf(step.component),
  nodeId: step.nodeId,
  visitNumber: step.visitNumber,
  copyNumber: step.copyNumber,
  itemIndex: step.itemIndex,
  idempotencyKey: step.idempotencyKey,
  callId: step.callId,
  toolLoopIteration: step.toolLoopIteration,
  validationAttempts: step.validationAttempts,
  ...(step.compensates === undefined ? {} : { compensates: step.compensates }),
});

/** The workflow as plain data: no class. */
export const workflowRecordOf = ({
  name,
  version,
  startedVersion,
  configHash,
}: WorkflowRecord): WorkflowRecord => ({ name, version, startedVersion, configHash });

/** The execution's part of an event: a child's names its parent and its root (#263). */
export function executionEventOf(execution: ExecutionFacts): ExecutionEvent {
  const { executionId, threadId, workflow } = execution;
  return {
    executionId,
    parentExecutionId: execution.parent?.execution.executionId,
    rootExecutionId: rootFactsOf(execution).executionId,
    threadId,
    tenantId: execution.tenant.tenantId,
    workflow: workflowRecordOf(workflow),
  };
}

/** The common part of a node event, from a step's frame. */
export const nodeEventOf = (frame: FrameSpec): NodeEvent => ({
  ...executionEventOf(frame.execution),
  step: stepRecordOf(frame.step),
});

/** The common part of a node event of the current step; `undefined` outside any step. */
export function currentNodeEvent(): NodeEvent | undefined {
  const frame = currentFrame();
  return frame === undefined ? undefined : nodeEventOf(frame);
}

/** Reports a node event of the current step; outside any step (a bare graph) nothing is reported. */
export async function reportNodeEvent(report: (base: NodeEvent) => unknown): Promise<void> {
  const base = currentNodeEvent();
  if (base !== undefined) await report(base);
}
