/**
 * #1328d: a single-turn case written as `input`, the case's `expectedStatus`, the suite's and the
 * case's `tools` together, the pause scripts, and the spend split in the run artifact.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import {
  CheckStatus,
  EvalCascade,
  EvalCheckKind,
  EvalSuite,
  answerPause,
  evalCase,
  replyToPause,
  toolCall,
  turn,
} from "../../src/eval/index.js";
import { turnsOfCase } from "../../src/eval/suite/cases.js";
import { checksOf, toolsOf } from "../../src/eval/suite/checks.js";
import { evalSuiteOf } from "../../src/eval/suite/eval-suite.decorator.js";
import { runSuiteOn } from "../../src/eval/run/run-suite.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import type { BuiltApplication } from "../../src/application/create-app.js";
import {
  DeskAgent,
  DeskAnswerDto,
  DeskWorkflowStart,
  EvalDeskApplication,
  GetOrderTool,
  RefundTool,
} from "../flow/fixtures/eval-desk.fixture.js";

const TENANT = { tenantId: "eval-acme", plan: "pro" } as const;

@EvalSuite({
  name: "single-turn-eval-suite",
  description: "A case written as one input, its end stated",
  start: DeskWorkflowStart,
  tools: { forbidden: [RefundTool] },
  cases: [
    evalCase({
      name: "one-input",
      tenant: TENANT,
      execution: { userId: "eval-user-1" },
      input: { text: "Where is order 9?" },
      tools: { required: [toolCall(GetOrderTool, { orderId: "9" })] },
    }),
    evalCase({
      name: "expects-a-cancel",
      tenant: TENANT,
      execution: { userId: "eval-user-2" },
      input: { text: "Where is order 9?" },
      expectedStatus: ExecutionStatus.Cancelled,
    }),
  ],
})
class SingleTurnEvalSuite {}

let environment: TestEnvironment | undefined;

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

async function evalApp(): Promise<{ env: TestEnvironment; built: BuiltApplication }> {
  const env = await TestEnvironment.of(EvalDeskApplication);
  environment = env;
  return { env, built: await env.newApp() };
}

describe("#1328d: a case of one input", () => {
  it("is the turn `input` says, and the one turn of its pauses", () => {
    const written = evalSuiteOf(SingleTurnEvalSuite)?.cases[0] ?? evalCase({ name: "none" });
    expect(turnsOfCase(written)).toEqual([{ input: { text: "Where is order 9?" } }]);
    const withPauses = evalCase({
      name: "with-pauses",
      tenant: TENANT,
      execution: { userId: "u" },
      input: { text: "x" },
      pauses: [replyToPause(RefundTool, "ok")],
    });
    expect(turnsOfCase(withPauses)[0]?.pauses).toHaveLength(1);
    expect(
      turnsOfCase(evalCase({ ...withPauses, turns: [turn({ text: "y" })] }))[0]?.input,
    ).toEqual({
      text: "y",
    });
  });

  it("the suite's tools and the case's own are one expectation, before the judges", () => {
    const suite = { judges: [], tools: { forbidden: [RefundTool] } };
    const own = { tools: { required: [toolCall(GetOrderTool)] } };
    expect(toolsOf(suite.tools, own.tools)).toMatchObject({
      required: [{ tool: GetOrderTool }],
      forbidden: [RefundTool],
    });
    expect(checksOf(suite, own)).toEqual([{ tools: true }]);
    expect(checksOf({ judges: [] }, {})).toEqual([]);
    expect(answerPause(RefundTool, {} as never).target).toBe(RefundTool);
  });
});

describe("#1328d: how the last turn must end", () => {
  it("a finished run passes its tools check and splits its spend", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        callTool(GetOrderTool, { orderId: "9" }),
        replyWith(DeskAnswerDto, { text: "Order 9 shipped." }),
      );

    const report = await runSuiteOn(built, SingleTurnEvalSuite, { runs: 1 });
    const [run] = report.cases[0]?.runResults ?? [];

    expect(run?.passed).toBe(true);
    expect(run?.checks).toEqual([
      { check: "trajectory", kind: EvalCheckKind.Tools, status: CheckStatus.Passed },
    ]);
    expect(run?.trace?.status).toBe(ExecutionStatus.Finished);
    expect(report.spend.judgeUsd).toBe(0);
    expect(report.spend.totalUsd).toBe(report.spend.executionUsd);
    expect(report.cascade).toBe(EvalCascade.StopAtFirstFailure);
  });

  it("a run that ends otherwise than the case expects fails, saying how it ended", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        callTool(GetOrderTool, { orderId: "9" }),
        replyWith(DeskAnswerDto, { text: "Order 9 shipped." }),
        replyWith(DeskAnswerDto, { text: "Order 9 shipped." }),
      );

    const report = await runSuiteOn(built, SingleTurnEvalSuite, { runs: 1 });
    const [run] = report.cases[1]?.runResults ?? [];

    expect(run).toMatchObject({
      passed: false,
      checks: [],
      error: {
        code: "execution.status-mismatch",
        message: "the last turn ended finished, the case expects cancelled",
      },
    });
  });
});
