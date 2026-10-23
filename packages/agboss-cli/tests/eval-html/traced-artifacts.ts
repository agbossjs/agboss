/**
 * Version 2 run artifacts for the timeline tests (#397 PR 2): runs that keep their trace — steps
 * with model calls, tool calls, guardrail decisions and judge verdicts, a handled error, a pause, an
 * undo action and a child — each case's expectation, and a comparison with a baseline.
 */
import {
  ChildExecutionStatus,
  CompensationReason,
  CompensationStatus,
  ComponentKind,
  GuardrailSide,
  PauseResolution,
  ToolCallStatus,
} from "agboss";
import { CaseComparison, CheckStatus } from "agboss/eval";
import type { EvalExecutionTrace, EvalRunReport, EvalRunResult, EvalStepTrace } from "agboss/eval";
import { artifactOf, caseOf } from "./artifacts.js";

/** One step of a trace; the agent's carries a model call, a tool call, a guardrail and a judge. */
export function stepOf(
  nodeId: string,
  kind: ComponentKind,
  parts: Partial<EvalStepTrace> = {},
): EvalStepTrace {
  return {
    component: nodeId,
    kind,
    nodeId,
    visitNumber: 1,
    copyNumber: 1,
    inputHash: `input-of-${nodeId}`,
    validationAttempts: 0,
    modelCalls: [],
    toolCalls: [],
    guardrailDecisions: [],
    judgeVerdicts: [],
    spentUsd: 0,
    startedAt: "2026-01-05T09:00:00.000Z",
    endedAt: "2026-01-05T09:00:00.850Z",
    ...parts,
  };
}

const agentStep = (orderId: string): EvalStepTrace =>
  stepOf("refund-agent", ComponentKind.Agent, {
    validationAttempts: 1,
    spentUsd: 0.012,
    modelCalls: [
      {
        caller: "refund-agent",
        model: "moonshotai/kimi-k2.6",
        inputTokens: 812,
        outputTokens: 64,
        cacheReadTokens: 512,
        costUsd: 0.012,
      },
    ],
    toolCalls: [
      {
        tool: "get-order-tool",
        toolLoopIteration: 1,
        status: ToolCallStatus.Succeeded,
        input: { orderId },
        output: { status: `order ${orderId} arrived broken`, contact: "<email>" },
        isResultTruncated: true,
        validationAttempts: 0,
      },
    ],
    guardrailDecisions: [
      {
        guardrail: "legal-advice-guardrail",
        side: GuardrailSide.Input,
        isBlocked: false,
        probability: 0.07,
      },
    ],
    judgeVerdicts: [
      { judge: "answer-grounded-judge", attempt: 0, passed: false, reason: "invents a fee" },
      { judge: "answer-grounded-judge", attempt: 1, passed: true, metrics: { score: 4 } },
    ],
  });

/** A run's trace: the start, the agent (with the order it looked up), the finish. */
export function traceOf(
  orderId: string,
  extra: Partial<EvalExecutionTrace> = {},
): EvalExecutionTrace {
  return {
    executionId: `execution-${orderId}`,
    path: ["refund-workflow-start", "refund-agent", "refund-workflow-finish"],
    steps: [
      stepOf("refund-workflow-start", ComponentKind.WorkflowStart),
      agentStep(orderId),
      stepOf("refund-workflow-finish", ComponentKind.WorkflowFinish),
    ],
    handledErrors: [],
    pauses: [],
    compensations: [],
    children: [],
    finish: "refund-workflow-finish",
    output: { text: `Refunded order ${orderId}.` },
    ...extra,
  };
}

const tracedRun = (run: number, passed: boolean, trace: EvalExecutionTrace): EvalRunResult => ({
  run,
  threadId: `thread-${String(run)}`,
  executionId: trace.executionId,
  finish: "refund-workflow-finish",
  passed,
  checks: [
    passed
      ? { check: "trajectory", status: CheckStatus.Passed }
      : {
          check: "trajectory",
          status: CheckStatus.Failed,
          reason: 'get-order-tool not called with {"orderId":"7"}',
        },
  ],
  spentUsd: 0.012,
  trace,
});

/** Everything else a trace may hold, on one run. */
const FULL_TRACE = traceOf("7", {
  handledErrors: [
    {
      error: { code: "step.agent", message: "the agent failed" },
      at: "refund-agent",
      by: "notify-action",
    },
  ],
  pauses: [
    {
      nodeId: "refund-agent",
      role: "refund-approval-channel",
      resolution: PauseResolution.Replied,
      responder: "owner-1",
      decision: { approved: true },
    },
  ],
  compensations: [
    {
      compensated: "charge-action",
      compensator: "refund-charge-action",
      reason: CompensationReason.SidePath,
      status: CompensationStatus.Compensated,
    },
  ],
  children: [
    {
      ...traceOf("7c"),
      workflow: "vendor-check-workflow",
      status: ChildExecutionStatus.Failed,
      launchedBy: "vendor-check-workflow",
      itemIndex: 0,
      error: { code: "step.failed", message: "the vendor check failed" },
    },
  ],
});

const withExpectation = <TCase extends ReturnType<typeof caseOf>>(found: TCase): TCase => ({
  ...found,
  expectation: {
    requiredTools: [{ tool: "get-order-tool", arguments: { orderId: "7" } }],
    forbiddenTools: ["delete-order-tool"],
    invariantTools: ["refund-tool"],
    checks: ["trajectory", "answer-grounded-judge"],
  },
});

/** A version 2 artifact: a stable case with a full trace, an unstable one, against a baseline. */
export const TRACED_ARTIFACT: EvalRunReport = {
  ...artifactOf(
    [
      withExpectation(
        caseOf("refund-within-policy", [
          tracedRun(1, true, FULL_TRACE),
          tracedRun(2, true, traceOf("7")),
        ]),
      ),
      withExpectation(
        caseOf("looks-the-order-up", [
          tracedRun(1, true, traceOf("7")),
          tracedRun(2, false, traceOf("8")),
        ]),
      ),
    ],
    2,
  ),
  schemaVersion: 2,
  baseline: {
    file: ".agboss/eval/main.json",
    configHash: "1b2c3d4e5f",
    startedAt: "2026-01-04T09:00:00.000Z",
    runs: 2,
    cases: [
      {
        name: "refund-within-policy",
        comparison: CaseComparison.Unchanged,
        baseline: { passed: 2, runs: 2 },
        candidate: { passed: 2, runs: 2 },
      },
      {
        name: "looks-the-order-up",
        comparison: CaseComparison.Regressed,
        baseline: { passed: 2, runs: 2 },
        candidate: { passed: 1, runs: 2 },
      },
      {
        name: "refund-by-phone",
        comparison: CaseComparison.Removed,
        baseline: { passed: 1, runs: 2 },
      },
    ],
    regressed: ["looks-the-order-up"],
  },
};
