import type { ErrorRecord } from "../../core/error-record.js";
import type { ExecutionStepRecord } from "../../flow/runtime/step-records.js";
import type { ToolCallRecord } from "../../flow/runtime/tool-calls.js";
import type { ChildExecutionRecord, HandledErrorRecord } from "../../flow/runtime/child-records.js";
import type { ExecutionRecord, PauseAnswerRecord } from "../../flow/runtime/execution-record.js";
import type { CompensationRecord } from "../../flow/compensation.js";
import type { StepRecord } from "../../flow/context/execution-context.js";
import type {
  EvalChildTrace,
  EvalCompensationTrace,
  EvalExecutionTrace,
  EvalPauseTrace,
  EvalStepTrace,
  EvalToolCallTrace,
  EvalTraceError,
} from "./trace.js";

/**
 * A run's trajectory from the case's last execution record (#397 PR 2): the record as
 * `{ record: true }` returns it — masked by the application's and the workflow's PII policies — cut
 * down to what the report shows; a step's tool calls are the calls of its visit.
 */

/** What the trace is built from: the masked record, and what the result keeps outside it (masked). */
export interface TracedExecution {
  readonly executionId: string;
  readonly record: ExecutionRecord;
  readonly handledErrors: readonly HandledErrorRecord[];
  readonly finish?: string;
  readonly output?: unknown;
}

const errorOf = (error: ErrorRecord): EvalTraceError => ({
  code: error.code,
  message: error.message,
});

/** The same visit: node, visit and item (a copy's node id names its copy). */
const isOfVisit = (call: StepRecord, visit: StepRecord): boolean =>
  call.nodeId === visit.nodeId &&
  call.visitNumber === visit.visitNumber &&
  call.itemIndex === visit.itemIndex;

function toolCallOf(call: ToolCallRecord): EvalToolCallTrace {
  return {
    tool: call.step.component.name,
    ...(call.step.toolLoopIteration === undefined
      ? {}
      : { toolLoopIteration: call.step.toolLoopIteration }),
    status: call.status,
    input: call.input,
    ...(call.output === undefined ? {} : { output: call.output }),
    ...(call.error === undefined ? {} : { error: errorOf(call.error) }),
    isResultTruncated: call.isResultTruncated,
    validationAttempts: call.step.validationAttempts,
  };
}

function stepOf(record: ExecutionStepRecord, calls: readonly ToolCallRecord[]): EvalStepTrace {
  const { step } = record;
  const toolCalls = calls.filter((call) => isOfVisit(call.step, step)).map(toolCallOf);
  return {
    component: step.component.name,
    kind: step.component.kind,
    nodeId: step.nodeId,
    visitNumber: step.visitNumber,
    copyNumber: step.copyNumber,
    ...(step.itemIndex === undefined ? {} : { itemIndex: step.itemIndex }),
    inputHash: record.inputHash,
    validationAttempts: Math.max(
      step.validationAttempts,
      ...toolCalls.map((call) => call.validationAttempts),
    ),
    modelCalls: record.spend.trace.map((line) => ({
      caller: line.caller,
      model: line.model,
      inputTokens: line.inputTokens,
      outputTokens: line.outputTokens,
      cacheReadTokens: line.cacheReadTokens,
      costUsd: line.costUsd,
    })),
    toolCalls,
    guardrailDecisions: record.guardrailDecisions.map((decision) => ({
      guardrail: decision.guardrail.name,
      side: decision.side,
      isBlocked: decision.isBlocked,
      probability: decision.probability,
    })),
    judgeVerdicts: record.judgeVerdicts.map((verdict) => ({
      judge: verdict.judge.name,
      attempt: verdict.attempt,
      passed: verdict.passed,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      ...(verdict.metrics === undefined ? {} : { metrics: verdict.metrics }),
    })),
    spentUsd: record.spend.totalUsd,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    ...(record.error === undefined ? {} : { error: errorOf(record.error) }),
  };
}

const pauseOf = (pause: PauseAnswerRecord): EvalPauseTrace => ({
  nodeId: pause.step.nodeId,
  role: pause.role,
  resolution: pause.resolution,
  ...(pause.responder === undefined ? {} : { responder: pause.responder }),
  ...(pause.decision === undefined ? {} : { decision: pause.decision }),
});

const compensationOf = (compensation: CompensationRecord): EvalCompensationTrace => ({
  compensated: compensation.compensated.nodeId,
  compensator: compensation.compensator.name,
  reason: compensation.reason,
  status: compensation.status,
  ...(compensation.error === undefined ? {} : { error: errorOf(compensation.error) }),
});

/** The parts every execution's trace has, its own and a child's. */
interface TracedParts {
  readonly executionId: string;
  readonly path: readonly string[];
  readonly steps: readonly ExecutionStepRecord[];
  readonly toolCalls: readonly ToolCallRecord[];
  readonly pauses: readonly PauseAnswerRecord[];
  readonly children: readonly ChildExecutionRecord[];
}

function traceOf(parts: TracedParts): Omit<EvalExecutionTrace, "handledErrors" | "compensations"> {
  return {
    executionId: parts.executionId,
    path: parts.path,
    steps: parts.steps.map((step) => stepOf(step, parts.toolCalls)),
    // the root's record lists the tree's pauses: each execution keeps its own
    pauses: parts.pauses.filter((pause) => pause.executionId === parts.executionId).map(pauseOf),
    children: parts.children.map(childOf),
  };
}

function childOf(child: ChildExecutionRecord): EvalChildTrace {
  return {
    ...traceOf(child),
    handledErrors: [],
    compensations: [],
    workflow: child.workflow.name,
    status: child.status,
    launchedBy: child.launchedBy.nodeId,
    ...(child.itemIndex === undefined ? {} : { itemIndex: child.itemIndex }),
    ...(child.finish === undefined ? {} : { finish: child.finish.name, output: child.output }),
    ...(child.error === undefined ? {} : { error: errorOf(child.error) }),
  };
}

/** The trace of the case's last execution. */
export function executionTraceOf(traced: TracedExecution): EvalExecutionTrace {
  const { record } = traced;
  return {
    ...traceOf({ executionId: traced.executionId, ...record }),
    handledErrors: traced.handledErrors.map((handled) => ({
      error: errorOf(handled.error),
      at: handled.at.name,
      by: handled.by.name,
    })),
    compensations: record.compensations.map(compensationOf),
    ...(traced.finish === undefined ? {} : { finish: traced.finish, output: traced.output }),
  };
}
