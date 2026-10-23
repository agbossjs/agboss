/**
 * #397 PR 2 — a run's trajectory in the run artifact: the case's last execution step by step from
 * its record (component, kind, visit, inputHash, model calls, tool calls, the finish and its
 * output), masked by the application's PII policies like the record; the case's expectation; and
 * where an unstable case's attempts part ways.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  EvalCascade,
  EvalSuite,
  checkTrajectory,
  evalCase,
  toolCall,
  toolInvariant,
  turn,
} from "../../src/eval/index.js";
import { runEvalSuite } from "../../src/eval/run/run-suite.js";
import { attemptDivergenceOf, AttemptDivergenceReason } from "../../src/eval/run/divergence.js";
import { evalRunReportOf } from "../../src/eval/run/read-report.js";
import { ComponentKind, ToolCallStatus } from "../../src/index.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import type { BuiltApplication } from "../../src/application/create-app.js";
import { frameworkPackageJson } from "../../src/package-json.js";
import {
  DeleteOrderTool,
  DeskAgent,
  DeskAnswerDto,
  DeskWorkflowStart,
  EvalDeskApplication,
  GetOrderTool,
  RefundTool,
  judgeReadings,
} from "../flow/fixtures/eval-desk.fixture.js";

@EvalSuite({
  name: "traced-eval-suite",
  description: "One case, looked up by order",
  start: DeskWorkflowStart,
  checks: [checkTrajectory()],
  cascade: EvalCascade.StopAtFirstFailure,
  cases: [
    evalCase({
      name: "looks-order-9-up",
      tenant: { tenantId: "eval-acme", plan: "pro" },
      execution: { userId: "eval-user-9" },
      turns: [turn({ text: "Where is order 9? Mail alice@example.com" })],
      tools: {
        required: [toolCall(GetOrderTool, { orderId: "9" })],
        forbidden: [DeleteOrderTool],
        invariants: [toolInvariant(RefundTool, (input) => input.amountCents <= 10_000)],
      },
    }),
  ],
})
class TracedEvalSuite {}

/** The framework's version as its package.json says. */
const frameworkVersion = (): unknown => (frameworkPackageJson() as { version: unknown }).version;

let environment: TestEnvironment | undefined;

async function evalApp(): Promise<{ env: TestEnvironment; built: BuiltApplication }> {
  const env = await TestEnvironment.of(EvalDeskApplication);
  environment = env;
  return { env, built: await env.newApp() };
}

afterEach(async () => {
  await environment?.close();
  environment = undefined;
  judgeReadings.length = 0;
});

const answer = (text: string, cost = 0.01) =>
  replyWith(DeskAnswerDto, { text }, { cost: usd(cost) });

describe("#397 PR 2: a run's trace in the artifact", () => {
  it("the last execution step by step: kind, visit, inputHash, model calls, tool calls, output", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        callTool(GetOrderTool, { orderId: "9" }),
        answer("Order 9 shipped, mailed to alice@example.com", 0.02),
      );

    const report = await runEvalSuite(built, TracedEvalSuite, { runs: 1 });

    const trace = report.cases[0]?.runResults[0]?.trace;
    const agent = trace?.steps.find((step) => step.component === "desk-agent");
    expect(trace?.path).toEqual(["desk-workflow-start", "desk-agent", "desk-workflow-finish"]);
    expect(agent).toMatchObject({
      kind: ComponentKind.Agent,
      nodeId: "desk-agent",
      visitNumber: 1,
      copyNumber: 1,
      validationAttempts: 0,
      guardrailDecisions: [],
      judgeVerdicts: [],
    });
    expect(agent?.inputHash).toMatch(/^\w+$/);
    expect(agent?.modelCalls.map((call) => [call.caller, call.model])).toEqual([
      ["desk-agent", "test/desk"],
      ["desk-agent", "test/desk"],
    ]);
    expect(agent?.spentUsd).toBeCloseTo(0.02, 5);
    expect(agent?.toolCalls).toEqual([
      {
        tool: "get-order-tool",
        toolLoopIteration: 1,
        status: ToolCallStatus.Succeeded,
        input: { orderId: "9" },
        output: { status: "order 9 arrived broken" },
        isResultTruncated: false,
        validationAttempts: 0,
      },
    ]);
    expect(trace).toMatchObject({ finish: "desk-workflow-finish", handledErrors: [], pauses: [] });
  });

  it("is masked like the record: what a model read and the output, never the address", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        callTool(GetOrderTool, { orderId: "9" }),
        answer("Order 9 shipped, mailed to alice@example.com"),
      );

    const report = await runEvalSuite(built, TracedEvalSuite, { runs: 1 });

    const written = JSON.stringify(report.cases[0]?.runResults[0]?.trace);
    expect(written).not.toContain("alice@example.com");
    expect(report.cases[0]?.runResults[0]?.trace?.output).toEqual({
      text: "Order 9 shipped, mailed to <email>",
    });
  });

  it("each case's expectation, as written: tools by name, partials, the checks in order", async () => {
    const { env, built } = await evalApp();
    env.mockLlm(DeskAgent).thenReturn(callTool(GetOrderTool, { orderId: "9" }), answer("Shipped."));

    const report = await runEvalSuite(built, TracedEvalSuite, { runs: 1 });

    expect(report.schemaVersion).toBe(3);
    expect(report.cases[0]?.expectation).toEqual({
      requiredTools: [{ tool: "get-order-tool", arguments: { orderId: "9" } }],
      forbiddenTools: ["delete-order-tool"],
      invariantTools: ["refund-tool"],
      checks: ["trajectory"],
    });
  });

  it("reads back as written; an unstable case names where its runs part ways", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        callTool(GetOrderTool, { orderId: "9" }),
        answer("Shipped."),
        callTool(GetOrderTool, { orderId: "8" }),
        answer("Shipped."),
      );

    const report = await runEvalSuite(built, TracedEvalSuite, { runs: 2 });

    const found = report.cases[0];
    expect(found?.isUnstable).toBe(true);
    expect(evalRunReportOf(JSON.parse(JSON.stringify(report)))).toEqual({ kind: "read", report });
    expect(found === undefined ? undefined : attemptDivergenceOf(found)).toEqual({
      nodeId: "desk-agent",
      visitNumber: 1,
      stepIndex: 1,
      reason: AttemptDivergenceReason.ToolCalls,
      runs: [1, 2],
    });
  });

  it("what the run ran on (#397 PR 3): profile, AGBoss version, models, the masking policies", async () => {
    const { env, built } = await evalApp();
    env.mockLlm(DeskAgent).thenReturn(callTool(GetOrderTool, { orderId: "9" }), answer("Shipped."));

    const report = await runEvalSuite(built, TracedEvalSuite, { runs: 1, profile: "cheaper" });

    expect(report.schemaVersion).toBe(3);
    expect(report.profile).toBe("cheaper");
    expect(report.agbossVersion).toBe(frameworkVersion());
    expect(report.models).toEqual([
      expect.objectContaining({
        component: "desk-agent",
        kind: ComponentKind.Agent,
        model: "test/desk",
      }),
    ]);
    expect(report.models?.[0]?.provider).toMatch(/-model-provider$/u);
    expect(report.piiPolicies).toEqual(["eval-email-pii-policy"]);
  });
});
