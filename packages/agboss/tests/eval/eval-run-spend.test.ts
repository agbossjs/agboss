/**
 * #1366: what an eval run spent — each run's `executionUsd` is its turns' spend, `judgeUsd` its model judges', a check carries
 * the spend of its own calls (a judge's, the reworded variants' under `--metamorphic`), so the report and the
 * budget agree with the ledger on what the suite cost.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import { EvalCascade, EvalSuite, evalCase, turn } from "../../src/eval/index.js";
import { runSuiteOn } from "../../src/eval/run/run-suite.js";
import { TestEnvironment } from "../../src/testing/environment.js";
import { replyWith } from "../../src/testing/index.js";
import { judgeKeyOf } from "../../src/testing/scripted-gateway.js";
import { usd } from "../../src/units/index.js";
import type { BuiltApplication } from "../../src/application/create-app.js";
import {
  AnswerGroundedJudge,
  DeskAgent,
  DeskAnswerDto,
  DeskWorkflowStart,
  EvalDeskApplication,
} from "../flow/fixtures/eval-desk.fixture.js";

const TENANT = { tenantId: "eval-acme", plan: "pro" } as const;

@EvalSuite({
  name: "spend-eval-suite",
  description: "A case judged by a model, with a reworded variant",
  start: DeskWorkflowStart,
  cascade: EvalCascade.RunAll,
  cases: [
    evalCase({
      name: "costs-money",
      tenant: TENANT,
      execution: { userId: "eval-user-1" },
      turns: [turn({ text: "Where is order 9?" })],
      variants: [turn({ text: "Order 9, where is it?" })],
      judges: [AnswerGroundedJudge],
    }),
  ],
})
class SpendEvalSuite {}

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

describe("#1366: the spend of an eval run", () => {
  it("is the turns' and the judge's: each check carries its own, the run the sum", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(replyWith(DeskAnswerDto, { text: "Order 9 shipped." }, { cost: usd(0.25) }));
    const key = judgeKeyOf("answer-grounded-judge");
    env.book.name(key, AnswerGroundedJudge.name);
    env.book.scriptOf(key).thenReturn(replyWith("yes", { cost: usd(0.125) }));

    const report = await runSuiteOn(built, SpendEvalSuite, { runs: 1 });

    const [run] = report.cases[0]?.runResults ?? [];
    expect(run?.checks.map((check) => [check.check, check.spentUsd])).toEqual([
      ["answer-grounded-judge", 0.125],
    ]);
    expect(run?.totalUsd).toBeCloseTo(0.375);
    // #1328: the candidate's turns and the judges' calls are split, the total is their sum
    expect(run?.executionUsd).toBeCloseTo(0.25);
    expect(run?.judgeUsd).toBeCloseTo(0.125);
    expect(report.spend).toEqual({
      executionUsd: run?.executionUsd,
      judgeUsd: run?.judgeUsd,
      totalUsd: run?.totalUsd,
    });
    // the judge's call is the yardstick's: the application's budget holds the candidate's turn only (#1328)
    const spent = (
      await built.infrastructure.costLedger.findUsageByCounter({
        budget: "test-application-daily-budget",
        scope: BudgetScope.Application,
        key: "eval-desk-application",
        period: "2026-01-05",
      })
    ).spent;
    expect(spent).toBeCloseTo(0.25);
  });

  it("under --metamorphic the variants' turns are the metamorphic check's, and in the run's", async () => {
    const { env, built } = await evalApp();
    env
      .mockLlm(DeskAgent)
      .thenReturn(
        replyWith(DeskAnswerDto, { text: "Order 9 shipped." }, { cost: usd(0.25) }),
        replyWith(DeskAnswerDto, { text: "Shipped." }, { cost: usd(0.5) }),
      );
    const key = judgeKeyOf("answer-grounded-judge");
    env.book.name(key, AnswerGroundedJudge.name);
    env.book.scriptOf(key).thenReturn(replyWith("yes", { cost: usd(0.125) }));

    const report = await runSuiteOn(built, SpendEvalSuite, { runs: 1, metamorphic: true });

    const [run] = report.cases[0]?.runResults ?? [];
    expect(run?.checks.map((check) => [check.check, check.spentUsd])).toEqual([
      ["answer-grounded-judge", 0.125],
      ["metamorphic", 0.5],
    ]);
    expect(run?.totalUsd).toBeCloseTo(0.875);
    // the variants' turns are the candidate's spend, not the judges'
    expect(run?.executionUsd).toBeCloseTo(0.75);
    expect(run?.judgeUsd).toBeCloseTo(0.125);
  });
});
