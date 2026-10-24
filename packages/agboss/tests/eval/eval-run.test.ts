/**
 * #396 PR 2 — `agboss eval run`'s runner: an `@EvalSuite` on a built application instance, its
 * models by script — history written and turns run on one thread with the case's tenant and
 * execution values, the trajectory check, judges in the frame of the case's last execution, the
 * cascade, pass@k / pass^k over k runs, and the run artifact.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EvalCaseInvalidError } from "../../src/errors.js";
import {
  CheckStatus,
  EvalCascade,
  EvalSuite,
  checkTrajectory,
  evalCase,
  judgedBy,
  pastTurn,
  toolCall,
  toolInvariant,
  turn,
} from "../../src/eval/index.js";
import { runEvalSuite } from "../../src/eval/run/run-suite.js";
import { evalSuiteWarningsOf } from "../../src/eval/suite/check-suite.js";
import { EVAL_RUN_KIND, EVAL_RUN_SCHEMA_VERSION } from "../../src/eval/run/report.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { callTool, failWith, replyWith } from "../../src/testing/index.js";
import { ModelFailure } from "../../src/models/index.js";
import { usd } from "../../src/units/index.js";
import { judgeKeyOf } from "../../src/testing/scripted-gateway.js";
import type { BuiltApplication } from "../../src/application/create-app.js";
import { ExecutionRecordStatus } from "../../src/infrastructure/execution-record.repository.js";
import {
  AnswerGroundedJudge,
  DeleteOrderTool,
  DeskAgent,
  DeskAnswerDto,
  DeskWorkflowFinish,
  DeskWorkflowStart,
  EvalDeskApplication,
  GetOrderTool,
  HandOverDto,
  RefundRecordedJudge,
  RefundTool,
  judgeReadings,
} from "../flow/fixtures/eval-desk.fixture.js";

const TENANT = { tenantId: "eval-acme", plan: "pro" } as const;

@EvalSuite({
  name: "refunds-eval-suite",
  description: "Refunds: looked up, refunded once, never deleted",
  start: DeskWorkflowStart,
  checks: [checkTrajectory(), judgedBy(RefundRecordedJudge), judgedBy(AnswerGroundedJudge)],
  cascade: EvalCascade.StopAtFirstFailure,
  cases: [
    evalCase({
      name: "refund-after-history",
      tenant: TENANT,
      execution: { userId: "eval-user-1" },
      history: [
        pastTurn(DeskWorkflowStart, { text: "Never delete my orders." }, DeskWorkflowFinish, {
          text: "Understood.",
        }),
      ],
      turns: [turn({ text: "Hi" }), turn({ text: "Refund order 7, it arrived broken" })],
      tools: {
        required: [toolCall(GetOrderTool, { orderId: "7" }), toolCall(RefundTool)],
        forbidden: [DeleteOrderTool],
        invariants: [toolInvariant(RefundTool, (input) => input.amountCents <= 10_000)],
      },
    }),
  ],
})
class RefundsEvalSuite {}

@EvalSuite({
  name: "run-all-eval-suite",
  description: "Every check runs",
  start: DeskWorkflowStart,
  checks: [checkTrajectory(), judgedBy(RefundRecordedJudge), judgedBy(AnswerGroundedJudge)],
  cascade: EvalCascade.RunAll,
  cases: [
    evalCase({
      name: "no-refund",
      tenant: TENANT,
      execution: { userId: "eval-user-2" },
      turns: [turn({ text: "Where is order 8?" })],
    }),
  ],
})
class RunAllEvalSuite {}

@EvalSuite({
  name: "flaky-eval-suite",
  description: "One case, judged by code only",
  start: DeskWorkflowStart,
  checks: [checkTrajectory()],
  cascade: EvalCascade.StopAtFirstFailure,
  cases: [
    evalCase({
      name: "looks-the-order-up",
      tenant: TENANT,
      execution: { userId: "eval-user-3" },
      turns: [turn({ text: "Where is order 9?" })],
      tools: { required: [toolCall(GetOrderTool, { orderId: "9" })] },
      judges: [judgedBy(AnswerGroundedJudge)],
    }),
  ],
})
class FlakyEvalSuite {}

@EvalSuite({
  name: "invalid-eval-suite",
  description: "A tenant the application refuses",
  start: DeskWorkflowStart,
  checks: [checkTrajectory()],
  cascade: EvalCascade.RunAll,
  cases: [
    // @ts-expect-error — "gold" is not a plan of DeskTenantContext
    evalCase({
      name: "wrong-plan",
      tenant: { tenantId: "eval-acme", plan: "gold" },
      execution: { userId: "eval-user-4" },
      turns: [turn({ text: "Hi" })],
    }),
  ],
})
class InvalidEvalSuite {}

let environment: TestEnvironment | undefined;

async function evalApp(): Promise<{ env: TestEnvironment; built: BuiltApplication }> {
  const env = await TestEnvironment.of(EvalDeskApplication);
  environment = env;
  return { env, built: await env.newApp() };
}

/** The model judge's answers, in order. */
function scriptJudge(env: TestEnvironment, ...answers: readonly string[]): void {
  const key = judgeKeyOf("answer-grounded-judge");
  env.book.name(key, AnswerGroundedJudge.name);
  env.book.scriptOf(key).thenReturn(...answers.map((answer) => replyWith(answer)));
}

const answer = (text: string) => replyWith(DeskAnswerDto, { text });

afterEach(async () => {
  await environment?.close();
  environment = undefined;
  judgeReadings.length = 0;
});

describe("#396 PR 2: a case's history, turns and contexts", () => {
  it("writes the history, runs the turns on one thread, judges the last in its frame", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        answer("Hello."),
        callTool(GetOrderTool, { orderId: "7" }),
        callTool(RefundTool, { orderId: "7", amountCents: 5000 }),
        answer("Refunded order 7."),
      );
    scriptJudge(env, "yes");

    const report = await runEvalSuite(built, RefundsEvalSuite, { runs: 1 });

    const [run] = report.cases[0]?.runResults ?? [];
    expect(run?.passed).toBe(true);
    expect(run?.checks.map((check) => [check.check, check.status])).toEqual([
      ["trajectory", CheckStatus.Passed],
      ["refund-recorded-judge", CheckStatus.Passed],
      ["answer-grounded-judge", CheckStatus.Passed],
    ]);
    expect(judgeReadings).toEqual([
      { tenantId: "eval-acme", plan: "pro", executionId: run?.executionId, userId: "eval-user-1" },
    ]);
    expect(run?.tenantId).toBe("eval-acme"); // the case's tenant, kept on the run (#397 PR 5b)
    const terns = await built.infrastructure.records.lastTerns("eval-acme", run?.threadId ?? "", 9);
    expect(terns.map((tern) => tern.task)).toEqual([
      'start desk-workflow-start: {"text":"Never delete my orders."}',
      'start desk-workflow-start: {"text":"Hi"}',
      'start desk-workflow-start: {"text":"Refund order 7, it arrived broken"}',
    ]);
  });

  it("history turns are written (#396 S6): turns of the thread, not runs to score or save", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        answer("Hello."),
        callTool(GetOrderTool, { orderId: "7" }),
        callTool(RefundTool, { orderId: "7", amountCents: 5000 }),
        answer("Refunded order 7."),
      );
    scriptJudge(env, "yes");

    const report = await runEvalSuite(built, RefundsEvalSuite, { runs: 1 });

    const { records } = built.infrastructure;
    const threadId = report.cases[0]?.runResults[0]?.threadId ?? "";
    const terns = await records.lastTerns("eval-acme", threadId, 9);
    expect(terns.map((tern) => tern.status)).toEqual([
      ExecutionRecordStatus.Written,
      ExecutionRecordStatus.Answered,
      ExecutionRecordStatus.Answered,
    ]);
    const tasks = (found: readonly { readonly task: string }[]) => found.map((tern) => tern.task);
    const written = 'start desk-workflow-start: {"text":"Never delete my orders."}';
    expect(tasks(await records.unscored("eval-desk-workflow", undefined, 9))).not.toContain(
      written,
    );
    expect(tasks(await records.recentOriginals("eval-desk-workflow", 9))).not.toContain(written);
    expect(tasks(await records.recentOriginals("eval-desk-workflow", 9))).toHaveLength(2);
  });

  it("a turn that fails ends the run with its error, no checks", async () => {
    const { env, built } = await evalApp();
    env.mockLlm(DeskAgent).thenReturnAlways(failWith(ModelFailure.Timeout));

    const report = await runEvalSuite(built, RefundsEvalSuite, { runs: 1 });

    const [run] = report.cases[0]?.runResults ?? [];
    expect(run).toMatchObject({ passed: false, checks: [], error: { code: "step.agent" } });
    expect(run?.executionId).toBeUndefined();
  });

  it("validates the cases' values before anything runs", async () => {
    const { built } = await evalApp();

    await expect(runEvalSuite(built, InvalidEvalSuite, { runs: 1 })).rejects.toBeInstanceOf(
      EvalCaseInvalidError,
    );
  });
});

describe("#396 PR 2: the trajectory check and the cascade", () => {
  it("names every broken expectation, and skips the judges after it", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        answer("Hello."),
        callTool(DeleteOrderTool, { orderId: "7" }),
        callTool(RefundTool, { orderId: "7", amountCents: 20_000 }),
        answer("Done."),
      );

    const report = await runEvalSuite(built, RefundsEvalSuite, { runs: 1 });

    const [run] = report.cases[0]?.runResults ?? [];
    expect(run?.passed).toBe(false);
    expect(run?.checks).toEqual([
      {
        check: "trajectory",
        status: CheckStatus.Failed,
        reason:
          'get-order-tool not called with {"orderId":"7"} (required; 0 call(s)); delete-order-tool called (forbidden); refund-tool: 1 call(s) break an invariant',
      },
      { check: "refund-recorded-judge", status: CheckStatus.Skipped, skippedBy: "trajectory" },
      { check: "answer-grounded-judge", status: CheckStatus.Skipped, skippedBy: "trajectory" },
    ]);
    expect(report.summary).toMatchObject({ judgeCalls: 0, skippedByCascade: 2 });
  });

  it("a failed code judge skips the model judge after it", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        answer("Hello."),
        callTool(GetOrderTool, { orderId: "7" }),
        callTool(RefundTool, { orderId: "7", amountCents: 5000 }),
        callTool(RefundTool, { orderId: "7", amountCents: 5000 }),
        answer("Refunded twice."),
      );

    const report = await runEvalSuite(built, RefundsEvalSuite, { runs: 1 });

    expect(report.cases[0]?.runResults[0]?.checks.slice(1)).toEqual([
      {
        check: "refund-recorded-judge",
        status: CheckStatus.Failed,
        reason: "2 refund call(s), 2 entries",
      },
      {
        check: "answer-grounded-judge",
        status: CheckStatus.Skipped,
        skippedBy: "refund-recorded-judge",
      },
    ]);
  });

  it("RunAll runs every check whatever the ones before decided", async () => {
    const { env, built } = await evalApp();
    env.mockLlm(DeskAgent).thenReturn(answer("Order 8 shipped."));
    scriptJudge(env, "yes");

    const report = await runEvalSuite(built, RunAllEvalSuite, { runs: 1 });

    expect(report.cases[0]?.runResults[0]?.checks.map((check) => check.status)).toEqual([
      CheckStatus.Passed,
      CheckStatus.Failed,
      CheckStatus.Passed,
    ]);
    expect(report.summary.judgeCalls).toBe(2);
  });

  it("a run that ends at a finish its judge does not judge fails that check", async () => {
    const { env, built } = await evalApp();
    env.mockLlm(DeskAgent).thenReturn(replyWith(HandOverDto, { reason: "not about an order" }));

    const report = await runEvalSuite(built, RunAllEvalSuite, { runs: 1 });

    const [run] = report.cases[0]?.runResults ?? [];
    expect(run?.finish).toBe("hand-over-workflow-finish");
    expect(run?.checks[2]).toEqual({
      check: "answer-grounded-judge",
      status: CheckStatus.Failed,
      reason:
        "the run ended at hand-over-workflow-finish, whose output answer-grounded-judge does not judge",
    });
  });
});

describe("#396 PR 2: pass@k and pass^k over k runs", () => {
  it("k = 3 with one failed run: pass@3, not pass^3 — unstable", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        callTool(GetOrderTool, { orderId: "9" }),
        answer("Order 9 shipped."),
        answer("I don't know."),
        callTool(GetOrderTool, { orderId: "9" }),
        answer("Order 9 shipped."),
      );
    scriptJudge(env, "yes", "yes");

    const report = await runEvalSuite(built, FlakyEvalSuite, { runs: 3 });

    expect(report.cases[0]).toMatchObject({
      name: "looks-the-order-up",
      passed: 2,
      runs: 3,
      passAtK: true,
      passHatK: false,
      isUnstable: true,
    });
    expect(report.cases[0]?.runResults.map((run) => run.passed)).toEqual([true, false, true]);
    expect(report.summary).toEqual({
      cases: 1,
      passAtK: 1,
      passHatK: 0,
      unstable: 1,
      judgeCalls: 2,
      skippedByCascade: 1,
    });
  });

  it("the artifact says what it is, its schema, the suite and the workflow it ran on", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        callTool(GetOrderTool, { orderId: "9" }),
        replyWith(DeskAnswerDto, { text: "Order 9 shipped." }, { cost: usd(0.25) }),
      );
    scriptJudge(env, "yes");

    const report = await runEvalSuite(built, FlakyEvalSuite, { runs: 1 });

    expect(report).toMatchObject({
      kind: EVAL_RUN_KIND,
      schemaVersion: EVAL_RUN_SCHEMA_VERSION,
      suite: "flaky-eval-suite",
      application: { name: "eval-desk-application", version: "1.0.0" },
      workflow: { name: "eval-desk-workflow", version: "1.0.0" },
      start: "desk-workflow-start",
      environment: "test",
      runs: 1,
      cascade: EvalCascade.StopAtFirstFailure,
      startedAt: "2026-01-05T09:00:00.000Z",
    });
    expect(report.kind).toBe("agboss.eval-run");
    expect(report.configHash).toMatch(/^\w+/);
    expect(report.cases[0]?.caseHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(report.spend.totalUsd).toBeCloseTo(0.25);
    expect(report.cases[0]?.runResults[0]?.spentUsd).toBeCloseTo(0.25);
  });

  it("refuses k below 1", async () => {
    const { built } = await evalApp();

    await expect(runEvalSuite(built, FlakyEvalSuite, { runs: 0 })).rejects.toThrow(
      "runs: a whole number from 1, got 0",
    );
  });
});

describe("#396 PR 5: [judge.same-model-family] for a suite's judges", () => {
  it("a model judge of the family of an agent of the start's workflow warns; a code judge does not", () => {
    expect(evalSuiteWarningsOf(EvalDeskApplication, RefundsEvalSuite)).toEqual([
      {
        code: "judge.same-model-family",
        message:
          "refunds-eval-suite: answer-grounded-judge (test/judge) judges desk-agent, whose model " +
          "test/desk is of the same family (test) — a judge grades its own family's answers too " +
          "kindly: give the judge a model of another vendor",
        nodes: ["answer-grounded-judge", "desk-agent"],
      },
    ]);
  });
});
