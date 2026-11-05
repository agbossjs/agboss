/**
 * #770 — a ledger write whose answer was lost is counted once by the pass, also before it is
 * written again. The write of a branch's $60 lands and its caller hears an error; the branch then
 * pays $25 and $1, each written with a read of the counters, while its sibling works on. $86 of
 * $100: the execution finishes, its sibling is never stopped, and the ledger holds $86. Before
 * #770 the read after the lost answer held the $60 that the tally still counted: the $1's tally
 * saw $146 and stopped the launch with `BudgetExceededError`.
 */
import { describe, expect } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import { counterOf } from "../../src/budgets/execution-budgets.js";
import { CostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  LostAnswerApplication,
  LostAnswerWorkflowStart,
  lostAnswer,
  resetLostAnswer,
} from "./fixtures/lost-answer.workflow.js";

const test = testWith(LostAnswerApplication, { concurrency: TestConcurrency.Real });

describe("#770: a ledger write whose answer was lost, beside a sibling that works on", () => {
  for (const isLosing of [false, true])
    test(`${isLosing ? "the $60 write's answer lost" : "every answer heard"}: $86 of $100 — the execution finishes`, async ({
      app,
      clock,
    }) => {
      resetLostAnswer(isLosing);
      const run = execute(app, LostAnswerWorkflowStart, { orderId: "order-1" });
      run.catch(() => undefined);
      for (let i = 0; i < 5 && !lostAnswer.log.includes("paid"); i += 1) await clock.advance("1s");
      lostAnswer.release();

      await expect(run).resolves.toBeDefined();
      expect(lostAnswer.lost).toBe(isLosing ? 1 : 0);
      expect(lostAnswer.log).toEqual(["paid", "worked"]);
      const execution = {
        budget: { name: "test-execution-budget" },
        scope: BudgetScope.Execution,
        key: "execution-1",
        maxSpend: 0,
      };
      const ledger = app.resolve(CostLedgerRepository);
      expect(await ledger.findSpentByCounter(counterOf(execution, clock.now()))).toBe(86);
    });
});
