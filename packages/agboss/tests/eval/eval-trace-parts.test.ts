/**
 * #397 PR 2 — the parts of a run's trace that a scripted desk does not reach, built from records as
 * an execution writes them: judge verdicts with retries, guardrail decisions, a handled error,
 * pauses, undo actions, a nested child; where unstable attempts part ways, for every reason; and
 * the one reader on version 1 and version 2 artifacts.
 */
import { describe, expect, it } from "vitest";
import {
  ChildExecutionStatus,
  CompensationReason,
  CompensationStatus,
  ComponentKind,
  GuardrailSide,
  PauseAnswerer,
  PauseResolution,
  ToolCallStatus,
  type ChildExecutionRecord,
  type ComponentRecord,
  type ExecutionRecord,
  type ExecutionStepRecord,
  type StepRecord,
} from "../../src/index.js";
import { buildCostReport } from "../../src/finops/usage.js";
import { executionTraceOf } from "../../src/eval/run/trace-of.js";
import { attemptDivergenceOf, AttemptDivergenceReason } from "../../src/eval/run/divergence.js";
import { evalRunReportOf } from "../../src/eval/run/read-report.js";
import { caseReportOf, type EvalRunResult } from "../../src/eval/run/report.js";
import type { EvalExecutionTrace, EvalStepTrace } from "../../src/eval/run/trace.js";
import { CheckStatus, EvalCascade } from "../../src/eval/index.js";

const component = (name: string, kind: ComponentKind): ComponentRecord => ({
  name,
  kind,
  promptHash: undefined,
  schemaHash: undefined,
});

const stepOf = (
  name: string,
  kind: ComponentKind,
  overrides: Partial<StepRecord> = {},
): StepRecord => ({
  component: component(name, kind),
  nodeId: name,
  visitNumber: 1,
  idempotencyKey: `e1:${name}:1`,
  callId: undefined,
  itemIndex: undefined,
  copyNumber: 1,
  toolLoopIteration: undefined,
  validationAttempts: 0,
  ...overrides,
});

const visitOf = (
  step: StepRecord,
  parts: Partial<ExecutionStepRecord> = {},
): ExecutionStepRecord => ({
  step,
  inputHash: "hash-1",
  judgeVerdicts: [],
  guardrailDecisions: [],
  spend: buildCostReport([]),
  startedAt: "2026-01-05T09:00:00.000Z",
  endedAt: "2026-01-05T09:00:01.000Z",
  ...parts,
});

const error = { name: "Error", code: "x.failed", lineage: ["x.failed"], message: "it broke" };

const AGENT = stepOf("refund-agent", ComponentKind.Agent, { validationAttempts: 1 });

const CHILD: ChildExecutionRecord = {
  executionId: "e2",
  parentExecutionId: "e1",
  rootExecutionId: "e1",
  workflow: { name: "check-workflow", version: "1.0.0", startedVersion: "1.0.0", configHash: "c" },
  itemIndex: 0,
  depth: 2,
  launchedBy: { nodeId: "check-workflow", visitNumber: 1 },
  start: component("check-workflow-start", ComponentKind.WorkflowStart),
  input: {},
  status: ChildExecutionStatus.Failed,
  error,
  path: ["check-workflow-start"],
  spend: buildCostReport([]),
  toolCalls: [],
  steps: [visitOf(stepOf("check-workflow-start", ComponentKind.WorkflowStart))],
  pauses: [],
  children: [],
};

const RECORD: ExecutionRecord = {
  path: ["refund-workflow-start", "refund-agent"],
  scope: [],
  outdatedValues: [],
  spend: buildCostReport([]),
  children: [CHILD],
  pauses: [
    {
      pauseId: "p1",
      executionId: "e1",
      step: AGENT,
      role: "refund-approval-channel",
      answeredBy: PauseAnswerer.ThreadOwner,
      responder: "owner-1",
      resolution: PauseResolution.Replied,
      askedAt: "2026-01-05T09:00:00.000Z",
      resolvedAt: "2026-01-05T09:00:02.000Z",
      decision: { approved: true },
    },
  ],
  compensations: [
    {
      compensated: stepOf("charge-action", ComponentKind.Action),
      compensator: component("refund-charge-action", ComponentKind.Action),
      reason: CompensationReason.SidePath,
      status: CompensationStatus.Failed,
      error,
      startedAt: "2026-01-05T09:00:03.000Z",
      endedAt: "2026-01-05T09:00:04.000Z",
    },
  ],
  toolCalls: [
    {
      step: stepOf("refund-tool", ComponentKind.Tool, {
        nodeId: "refund-agent",
        callId: "c1",
        toolLoopIteration: 2,
        validationAttempts: 1,
      }),
      input: { orderId: "7" },
      output: undefined,
      status: ToolCallStatus.Failed,
      error,
      isResultTruncated: true,
      startedAt: "2026-01-05T09:00:00.000Z",
      endedAt: "2026-01-05T09:00:00.500Z",
    },
  ],
  steps: [
    visitOf(AGENT, {
      judgeVerdicts: [
        {
          judge: component("grounded-judge", ComponentKind.Judge),
          attempt: 0,
          passed: false,
          reason: "invents a fee",
        },
        {
          judge: component("grounded-judge", ComponentKind.Judge),
          attempt: 1,
          passed: true,
          metrics: { score: 4 },
        },
      ],
      guardrailDecisions: [
        {
          guardrail: component("legal-guardrail", ComponentKind.Guardrail),
          side: GuardrailSide.Input,
          isBlocked: false,
          probability: 0.1,
        },
      ],
      error,
    }),
  ],
};

describe("#397 PR 2: a trace from an execution record", () => {
  const trace = executionTraceOf({
    executionId: "e1",
    record: RECORD,
    handledErrors: [
      {
        error,
        at: component("refund-agent", ComponentKind.Agent),
        by: component("notify-action", ComponentKind.Action),
      },
    ],
  });

  it("a step's judge verdicts with retries, guardrail decisions, failed call and handled failure", () => {
    expect(trace.steps[0]).toMatchObject({
      component: "refund-agent",
      validationAttempts: 1,
      judgeVerdicts: [
        { judge: "grounded-judge", attempt: 0, passed: false, reason: "invents a fee" },
        { judge: "grounded-judge", attempt: 1, passed: true, metrics: { score: 4 } },
      ],
      guardrailDecisions: [
        { guardrail: "legal-guardrail", side: "input", isBlocked: false, probability: 0.1 },
      ],
      toolCalls: [
        {
          tool: "refund-tool",
          toolLoopIteration: 2,
          status: ToolCallStatus.Failed,
          error: { code: "x.failed", message: "it broke" },
          isResultTruncated: true,
          validationAttempts: 1,
        },
      ],
      error: { code: "x.failed", message: "it broke" },
    });
  });

  it("handled errors, its own pauses, undo actions and a nested child", () => {
    expect(trace.handledErrors).toEqual([
      { error: { code: "x.failed", message: "it broke" }, at: "refund-agent", by: "notify-action" },
    ]);
    expect(trace.pauses).toEqual([
      {
        nodeId: "refund-agent",
        role: "refund-approval-channel",
        resolution: PauseResolution.Replied,
        responder: "owner-1",
        decision: { approved: true },
      },
    ]);
    expect(trace.compensations).toEqual([
      {
        compensated: "charge-action",
        compensator: "refund-charge-action",
        reason: CompensationReason.SidePath,
        status: CompensationStatus.Failed,
        error: { code: "x.failed", message: "it broke" },
      },
    ]);
    expect(trace.children).toEqual([
      expect.objectContaining({
        executionId: "e2",
        workflow: "check-workflow",
        status: ChildExecutionStatus.Failed,
        launchedBy: "check-workflow",
        itemIndex: 0,
        error: { code: "x.failed", message: "it broke" },
        steps: [expect.objectContaining({ component: "check-workflow-start" })],
        pauses: [],
      }),
    ]);
  });
});

const step = (nodeId: string, parts: Partial<EvalStepTrace> = {}): EvalStepTrace => ({
  component: nodeId,
  kind: ComponentKind.Agent,
  nodeId,
  visitNumber: 1,
  copyNumber: 1,
  inputHash: "h",
  validationAttempts: 0,
  modelCalls: [],
  toolCalls: [],
  guardrailDecisions: [],
  judgeVerdicts: [],
  spentUsd: 0,
  startedAt: "2026-01-05T09:00:00.000Z",
  endedAt: "2026-01-05T09:00:00.000Z",
  ...parts,
});

const traceWith = (steps: readonly EvalStepTrace[], output?: unknown): EvalExecutionTrace => ({
  executionId: "e",
  path: steps.map((each) => each.nodeId),
  steps,
  handledErrors: [],
  pauses: [],
  compensations: [],
  children: [],
  ...(output === undefined ? {} : { output }),
});

const runWith = (run: number, trace?: EvalExecutionTrace): EvalRunResult => ({
  run,
  threadId: `t${String(run)}`,
  passed: run === 1,
  checks: [],
  spentUsd: 0,
  ...(trace === undefined ? {} : { trace }),
});

const divergenceOf = (...traces: (EvalExecutionTrace | undefined)[]) =>
  attemptDivergenceOf(
    caseReportOf(
      "c",
      "h",
      traces.map((trace, index) => runWith(index + 1, trace)),
    ),
  );

describe("#397 PR 2: where unstable attempts part ways", () => {
  const router = step("main-router");

  it("another next node: the step before chose it", () => {
    expect(
      divergenceOf(traceWith([router, step("a-agent")]), traceWith([router, step("b-agent")])),
    ).toMatchObject({
      nodeId: "main-router",
      stepIndex: 0,
      reason: AttemptDivergenceReason.NextStep,
    });
  });

  it("the same node, another input; the same input, other verdicts", () => {
    expect(
      divergenceOf(
        traceWith([router, step("a-agent")]),
        traceWith([router, step("a-agent", { inputHash: "x" })]),
      ),
    ).toMatchObject({
      nodeId: "a-agent",
      reason: AttemptDivergenceReason.Input,
    });
    const blocked = step("a-agent", {
      guardrailDecisions: [
        { guardrail: "g", side: GuardrailSide.Input, isBlocked: true, probability: 1 },
      ],
    });
    expect(divergenceOf(traceWith([step("a-agent")]), traceWith([blocked]))).toMatchObject({
      reason: AttemptDivergenceReason.Verdicts,
    });
  });

  it("one run ended earlier; the same steps with another output", () => {
    expect(divergenceOf(traceWith([router]), traceWith([router, step("a-agent")]))).toMatchObject({
      nodeId: "main-router",
      reason: AttemptDivergenceReason.Length,
    });
    expect(
      divergenceOf(traceWith([router], { text: "a" }), traceWith([router], { text: "b" })),
    ).toMatchObject({
      nodeId: "main-router",
      reason: AttemptDivergenceReason.Output,
    });
  });

  it("nothing to compare: fewer than two traced runs, or every run alike", () => {
    expect(divergenceOf(traceWith([router]), undefined)).toBeUndefined();
    expect(divergenceOf(traceWith([router]), traceWith([router]))).toBeUndefined();
  });
});

describe("#397 PR 2: the one reader on both versions", () => {
  const v1 = {
    kind: "agboss.eval-run",
    schemaVersion: 1,
    suite: "s-eval-suite",
    application: { name: "a", version: "1" },
    workflow: { name: "w", version: "1" },
    configHash: "c",
    start: "s",
    environment: "dev",
    runs: 1,
    cascade: EvalCascade.RunAll,
    startedAt: "2026-01-05T09:00:00.000Z",
    endedAt: "2026-01-05T09:00:00.000Z",
    cases: [
      {
        name: "c",
        caseHash: "h",
        passed: 1,
        runs: 1,
        passAtK: true,
        passHatK: true,
        isUnstable: false,
        runResults: [
          {
            run: 1,
            threadId: "t",
            passed: true,
            checks: [{ check: "trajectory", status: CheckStatus.Passed }],
            spentUsd: 0,
          },
        ],
      },
    ],
    summary: { cases: 1, passAtK: 1, passHatK: 1, unstable: 0, judgeCalls: 0, skippedByCascade: 0 },
    spend: { totalUsd: 0 },
  };

  it("a version 1 artifact still reads: no traces, no expectations", () => {
    expect(evalRunReportOf(v1)).toEqual({ kind: "read", report: v1 });
  });

  it("a version 2 trace that does not fit is refused, naming the field", () => {
    const [found] = v1.cases;
    const broken = {
      ...v1,
      schemaVersion: 2,
      cases: [{ ...found, runResults: [{ ...found?.runResults[0], trace: { executionId: "e" } }] }],
    };

    expect(evalRunReportOf(broken)).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/^cases\.0\.runResults\.0\.trace\.path: /) as unknown,
    });
  });
});
