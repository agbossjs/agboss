/**
 * #1366: the spend of a question's model interpreter — the call that read the reply is in the usage the question's
 * step hands on, so the kept record of the execution states it, with the run's own.
 */
import { describe, expect } from "vitest";
import { Application, EmptyEnvironment, ExecutionHistoryRepository } from "../../src/index.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { hours, usd } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  BudgetOwnerReplyInterpreter,
  InboxBudgetOwnerChannel,
  InboxSpendingLimitChannel,
  OwnerPurchaseWorkflow,
  OwnerPurchaseWorkflowStart,
  PurchaseWorkflow,
  QuestionInbox,
  SpendingLimitAnswerDto,
} from "../flow/fixtures/questions.fixture.js";
import { execute } from "../helpers/flow.js";

@Application({
  name: "kept-questions-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PurchaseWorkflow, OwnerPurchaseWorkflow],
  budgets: TEST_BUDGETS,
  providers: [InboxSpendingLimitChannel, InboxBudgetOwnerChannel],
  retention: { executionRecords: hours(24) },
})
class KeptQuestionsApplication {}

const test = testWith(KeptQuestionsApplication);

describe("#1366: the kept record of a run with a model interpreter", () => {
  test("states the call that read the reply", async ({ app, mockLlm }) => {
    mockLlm(BudgetOwnerReplyInterpreter).thenReturn(
      replyWith(SpendingLimitAnswerDto, { approved: true, limitUsd: 800 }, { cost: usd(0.125) }),
    );
    const paused = await execute(app, OwnerPurchaseWorkflowStart, { text: "desk for 700" });
    const pauseId = app.resolve(QuestionInbox).ownerAsked[0]?.pauseId ?? "";

    const done = await app.resume(
      { pauseId, reply: "fine, up to eight hundred" },
      {
        actor: { id: "budget-owner-7" },
      },
    );

    const [kept] = await app
      .resolve(ExecutionHistoryRepository)
      .findAllByExecutionId(paused.executionId);
    expect(done.spend.totalUsd).toBeCloseTo(0.125, 9);
    expect(kept?.spend.totalUsd).toBeCloseTo(0.125, 9);
  });
});
