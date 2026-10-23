/**
 * #396 PR 7 (S2 Q12a) — `--metamorphic`: each variant of a case (its last turn reworded) runs on a
 * thread of its own and must call the same set of tool classes as the case's own last turn, with
 * the case's `tools.required` met again; the check `metamorphic` runs last, under the cascade.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  CheckStatus,
  EvalCascade,
  EvalSuite,
  checkTrajectory,
  evalCase,
  toolCall,
  turn,
} from "../../src/eval/index.js";
import { runEvalSuite } from "../../src/eval/run/run-suite.js";
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

const refundCase = {
  name: "refund-reworded",
  tenant: TENANT,
  execution: { userId: "eval-user-1" },
  turns: [turn({ text: "Refund order 7, it arrived broken" })],
  variants: [turn({ text: "Order 7 came broken. I want my money back." })],
  tools: { required: [toolCall(GetOrderTool, { orderId: "7" }), toolCall(RefundTool)] },
} as const;

@EvalSuite({
  name: "reworded-eval-suite",
  description: "A reworded request calls the same tools",
  start: DeskWorkflowStart,
  checks: [checkTrajectory()],
  cascade: EvalCascade.RunAll,
  cases: [evalCase(refundCase)],
})
class RewordedEvalSuite {}

@EvalSuite({
  name: "stopping-reworded-eval-suite",
  description: "The cascade stops before the variants",
  start: DeskWorkflowStart,
  checks: [checkTrajectory()],
  cascade: EvalCascade.StopAtFirstFailure,
  cases: [evalCase(refundCase)],
})
class StoppingRewordedEvalSuite {}

let environment: TestEnvironment | undefined;

async function evalApp(): Promise<{ env: TestEnvironment; built: BuiltApplication }> {
  const env = await TestEnvironment.of(EvalDeskApplication);
  environment = env;
  return { env, built: await env.newApp() };
}

afterEach(async () => {
  await environment?.close();
  environment = undefined;
});

const answer = (text: string) => replyWith(DeskAnswerDto, { text });
const lookUp = callTool(GetOrderTool, { orderId: "7" });
const refund = callTool(RefundTool, { orderId: "7", amountCents: 5000 });

describe("#396 PR 7: agboss eval run --metamorphic", () => {
  it("a variant that calls the same tools with the required calls holds", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(lookUp, refund, answer("Refunded."), lookUp, refund, answer("Money back."));

    const report = await runEvalSuite(built, RewordedEvalSuite, { runs: 1, metamorphic: true });

    const [run] = report.cases[0]?.runResults ?? [];
    expect(run?.checks).toEqual([
      { check: "trajectory", status: CheckStatus.Passed },
      expect.objectContaining({
        check: "metamorphic",
        status: CheckStatus.Passed,
        metrics: { variants: 1 },
      }),
    ]);
    expect(run?.passed).toBe(true);
    expect(report.metamorphic).toBe(true);
    expect(report.cases[0]?.expectation?.checks).toEqual(["trajectory", "metamorphic"]);
  });

  it("a variant that calls other tools, or misses a required call, fails the run", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(lookUp, refund, answer("Refunded."), lookUp, answer("I looked it up."));

    const report = await runEvalSuite(built, RewordedEvalSuite, { runs: 1, metamorphic: true });

    const [run] = report.cases[0]?.runResults ?? [];
    expect(run?.passed).toBe(false);
    expect(run?.checks[1]).toMatchObject({
      check: "metamorphic",
      status: CheckStatus.Failed,
      reason:
        "variant 1 calls get-order-tool, not get-order-tool, refund-tool; " +
        "variant 1: refund-tool not called (required)",
    });
  });

  it("without --metamorphic the variants do not run, and the case's hash is another", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        lookUp,
        refund,
        answer("Refunded."),
        lookUp,
        refund,
        answer("Refunded."),
        lookUp,
        refund,
        answer("Money back."),
      );

    const plain = await runEvalSuite(built, RewordedEvalSuite, { runs: 1 });
    const metamorphic = await runEvalSuite(built, RewordedEvalSuite, {
      runs: 1,
      metamorphic: true,
    });

    expect(plain.cases[0]?.runResults[0]?.checks.map((check) => check.check)).toEqual([
      "trajectory",
    ]);
    expect(plain.metamorphic).toBeUndefined();
    expect(plain.cases[0]?.caseHash).not.toBe(metamorphic.cases[0]?.caseHash);
  });

  it("the cascade that stopped skips the variants: nothing more is spent", async () => {
    const { env, built } = await evalApp();
    env.mockLlm(DeskAgent).thenReturn(lookUp, answer("Looked it up."));

    const report = await runEvalSuite(built, StoppingRewordedEvalSuite, {
      runs: 1,
      metamorphic: true,
    });

    expect(report.cases[0]?.runResults[0]?.checks[1]).toEqual({
      check: "metamorphic",
      status: CheckStatus.Skipped,
      skippedBy: "trajectory",
    });
  });
});
