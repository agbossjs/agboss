import type { ComponentKind } from "../../flow/runtime/records.js";
import type { ToolCallStatus } from "../../flow/runtime/tool-calls.js";
import type { GuardrailSide } from "../../components/policy-decorators.js";
import type { JudgeMetrics } from "../../components/judge-decorators.js";
import type { CompensationReason, CompensationStatus } from "../../flow/compensation.js";
import type { PauseResolution } from "../../infrastructure/pause-record.js";
import type { ChildExecutionStatus } from "../../flow/runtime/child-records.js";

/**
 * What a run artifact keeps of the case's last execution (#397 PR 2, schemaVersion 2): its
 * trajectory, step by step — taken from its execution record (`{ record: true }`), so every value
 * is masked by the application's and the workflow's PII policies as the record is. Plain JSON,
 * smaller than the record: a step's spend is its model calls, a tool call names its tool.
 */

/** A failure as the trace keeps it: its code and message. */
export interface EvalTraceError {
  readonly code: string;
  readonly message: string;
}

/** One model call of a visit: its caller, model, tokens and cost. */
export interface EvalModelCallTrace {
  /** Who called, as the spend names it: the agent or router, `guardrail:<name>`, `judge:<name>`, … */
  readonly caller: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
}

/** One tool call of an agent's visit. */
export interface EvalToolCallTrace {
  readonly tool: string;
  /** The agent's model call that asked for it, from 1. */
  readonly toolLoopIteration?: number;
  readonly status: ToolCallStatus;
  /** The arguments, masked. */
  readonly input: unknown;
  /** The output, masked; absent when the tool gave none. */
  readonly output?: unknown;
  readonly error?: EvalTraceError;
  /** The model read its result cut to `maxResultSize` (#336). */
  readonly isResultTruncated: boolean;
  /** Answers and tool arguments of the visit that failed validation before this call. */
  readonly validationAttempts: number;
}

/** One guardrail's decision in a visit. */
export interface EvalGuardrailDecisionTrace {
  readonly guardrail: string;
  readonly side: GuardrailSide;
  readonly isBlocked: boolean;
  readonly probability: number;
}

/** One judge's verdict on one reply of an agent's visit: `attempt` 0 is its first reply. */
export interface EvalJudgeVerdictTrace {
  readonly judge: string;
  readonly attempt: number;
  readonly passed: boolean;
  readonly reason?: string;
  readonly metrics?: JudgeMetrics;
}

/** One visit of a node, in the order the visits ended. */
export interface EvalStepTrace {
  readonly component: string;
  readonly kind: ComponentKind;
  /** Its node in the path (`critic-agent#2` for a copy). */
  readonly nodeId: string;
  readonly visitNumber: number;
  readonly copyNumber: number;
  readonly itemIndex?: number;
  /** A stable hash of what the visit read: two runs that read the same have the same hash. */
  readonly inputHash: string;
  /** Answers and tool arguments that failed validation in the visit. */
  readonly validationAttempts: number;
  readonly modelCalls: readonly EvalModelCallTrace[];
  readonly toolCalls: readonly EvalToolCallTrace[];
  readonly guardrailDecisions: readonly EvalGuardrailDecisionTrace[];
  readonly judgeVerdicts: readonly EvalJudgeVerdictTrace[];
  readonly spentUsd: number;
  readonly startedAt: string;
  readonly endedAt: string;
  /** The failure an `.onError` side path took. */
  readonly error?: EvalTraceError;
}

/** A failure a side path took: where, and the side path's first node. */
export interface EvalHandledErrorTrace {
  readonly error: EvalTraceError;
  readonly at: string;
  readonly by: string;
}

/** A pause of the execution that was resolved. */
export interface EvalPauseTrace {
  /** The waiting step's node. */
  readonly nodeId: string;
  readonly role: string;
  readonly resolution: PauseResolution;
  readonly responder?: string;
  /** What was decided, masked. */
  readonly decision?: unknown;
}

/** An undo action that ran. */
export interface EvalCompensationTrace {
  /** The node of the step it undid. */
  readonly compensated: string;
  readonly compensator: string;
  readonly reason: CompensationReason;
  readonly status: CompensationStatus;
  readonly error?: EvalTraceError;
}

/** An execution's trajectory: its own steps, then its handled errors, pauses, undos and children. */
export interface EvalExecutionTrace {
  readonly executionId: string;
  readonly path: readonly string[];
  readonly steps: readonly EvalStepTrace[];
  readonly handledErrors: readonly EvalHandledErrorTrace[];
  readonly pauses: readonly EvalPauseTrace[];
  readonly compensations: readonly EvalCompensationTrace[];
  readonly children: readonly EvalChildTrace[];
  /** The finish it ended at and its output, masked. */
  readonly finish?: string;
  readonly output?: unknown;
}

/** A child execution's trajectory, nested in its parent's. */
export interface EvalChildTrace extends EvalExecutionTrace {
  readonly workflow: string;
  readonly status: ChildExecutionStatus;
  /** The parent's node that launched it. */
  readonly launchedBy: string;
  readonly itemIndex?: number;
  readonly error?: EvalTraceError;
}

/** A tool a case requires, with the partial its arguments must match (absent: any call). */
export interface EvalExpectedToolCallTrace {
  readonly tool: string;
  readonly arguments?: unknown;
}

/** What a case expects of a run, as written (masked): what the page sets beside the run's output. */
export interface EvalCaseExpectation {
  readonly requiredTools: readonly EvalExpectedToolCallTrace[];
  readonly forbiddenTools: readonly string[];
  /** Tools with an invariant every call must hold (the code itself is not kept). */
  readonly invariantTools: readonly string[];
  /** The checks, in order: `trajectory` and the judges, the case's own after the suite's. */
  readonly checks: readonly string[];
}
