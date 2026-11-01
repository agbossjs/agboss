/**
 * #675 — the money goes back. A main-path refund that is also the booking's undo, held back by the
 * exhausted budget, with its own `.onError(BudgetExceededError, …)`: the forward visit stays stopped
 * (#656), and the booking it would have closed is undone at once as an undo — its own key, past the
 * budget — before the side path goes on. Its record is `Failed` only when the undo itself fails,
 * never because the budget is exhausted.
 */
import { beforeEach, describe, expect } from "vitest";
import { BudgetExceededError, CompensationReason, CompensationStatus } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { PaidExemptionsApplication } from "./fixtures/paid-exemptions.application.js";
import { exemptions, resetExemptions } from "./fixtures/paid-exemptions.actions.js";
import {
  RefundHandledWorkflowStart,
  RefundStepWorkflowFinish,
  RefundToldWorkflowFinish,
} from "./fixtures/paid-exemptions.workflow.js";
import { paidSteps, resetPaidSteps } from "./fixtures/paid-steps.dto.js";

const test = testWith(PaidExemptionsApplication);

beforeEach(() => {
  resetPaidSteps();
  resetExemptions();
});

const order = { orderId: "o1" };

describe("#675: a held-back refund's booking is undone as an undo", () => {
  test("AC3: the undo itself fails — Failed with the undo's own error, never the budget's; the side path goes on", async ({
    app,
  }) => {
    paidSteps.refundFails = true;

    const done = await execute(app, RefundHandledWorkflowStart, order);

    expect(done).toFinishWith(RefundToldWorkflowFinish, order);
    expect(paidSteps.ran).toEqual(["book", "check", "refund o1", "tell"]);
    expect(done.compensations).toMatchObject([
      {
        reason: CompensationReason.SidePath,
        status: CompensationStatus.Failed,
        error: { message: "the gateway refused the refund" },
      },
    ]);
    expect(done.compensations[0]?.error?.name).not.toBe(BudgetExceededError.name);
  });

  test("its undo's spend is the execution's: counted once, with the paid check's", async ({
    app,
  }) => {
    const done = await execute(app, RefundHandledWorkflowStart, order);

    expect(done.spend.totalUsd).toBe(paidSteps.charge);
    expect(exemptions.undone).toHaveLength(1);
  });

  test("below the budget nothing is held back: the refund runs as the step, once", async ({
    app,
  }) => {
    paidSteps.charge = 0;

    const done = await execute(app, RefundHandledWorkflowStart, order);

    expect(done).toFinishWith(RefundStepWorkflowFinish, order);
    expect(paidSteps.ran).toEqual(["book", "check", "refund o1"]);
    expect(exemptions.undone).toEqual([]);
    expect(done.compensations).toMatchObject([
      { reason: CompensationReason.SidePath, status: CompensationStatus.Compensated },
    ]);
  });
});
