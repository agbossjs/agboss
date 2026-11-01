/**
 * #656 — the budget's two exemptions hold only where they are meant to. The action of the side path
 * that took the budget's limit runs past it, and so does what that side path leads to step by step;
 * a launch ends it: the branches it launches are held back (AC1). An undo action runs past the
 * budget only as an undo — on a side path entered with the step it undoes open —, never as a step
 * of the main path that happens to be some entry's undo (AC2). Every exemption still holds (AC3).
 */
import { beforeEach, describe, expect } from "vitest";
import { BudgetExceededError, CompensationReason, CompensationStatus } from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { PaidExemptionsApplication } from "./fixtures/paid-exemptions.application.js";
import {
  exemptions,
  resetExemptions,
  TellOrderAction,
} from "./fixtures/paid-exemptions.actions.js";
import {
  HeldLimitWorkflowStart,
  JoinLimitWorkflowStart,
  LimitLaunchWorkflowStart,
  LimitNotedWorkflowFinish,
  NestedLimitWorkflowFinish,
  NestedLimitWorkflowStart,
  RebookWorkflowStart,
  RefundHandledWorkflowStart,
  RefundStepWorkflowFinish,
  RefundToldWorkflowFinish,
  RefundStepWorkflowStart,
} from "./fixtures/paid-exemptions.workflow.js";
import { paidSteps, resetPaidSteps } from "./fixtures/paid-steps.dto.js";
import {
  HoldOrderAction,
  NoteOrderAction,
  RefundOrderAction,
} from "./fixtures/paid-steps.actions.js";

const test = testWith(PaidExemptionsApplication);

beforeEach(() => {
  resetPaidSteps();
  resetExemptions();
});

const order = { orderId: "o1" };

describe("#656 AC1: a launch ends the side path that took the budget's limit", () => {
  test("its own action tells the team; the branches it launches are held back", async ({ app }) => {
    const run = execute(app, LimitLaunchWorkflowStart, order);

    await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
    expect(paidSteps.ran).toEqual(["charge", "tell"]);
    expect(exemptions.ended).toEqual(["BudgetExceededError"]);
  });

  test("the side path of a failed join: its action runs, its launch's branches do not", async ({
    app,
  }) => {
    const run = execute(app, JoinLimitWorkflowStart, order);

    await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
    expect(paidSteps.ran).toEqual(["charge", "tell"]);
  });

  test("below the budget the side path is not taken: the note runs", async ({ app }) => {
    paidSteps.charge = 1;

    const done = await execute(app, LimitLaunchWorkflowStart, order);

    expect(done).toFinishWith(LimitNotedWorkflowFinish, { note: "note" });
    expect(paidSteps.ran).toEqual(["charge", "note"]);
  });
});

describe("#656 AC2: an undo action is exempt only as an undo", () => {
  test("a step of the main path that is also the booking's undo is held back", async ({ app }) => {
    const run = execute(app, RefundStepWorkflowStart, order);

    await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
    // refunded once: by the execution's automatic undo, never by the step held back
    expect(paidSteps.ran).toEqual(["book", "check", "refund o1"]);
    expect(exemptions.ended).toEqual(["BudgetExceededError"]);
  });

  test("the same action as the side path's undo runs past the budget", async ({ app }) => {
    exemptions.declines = true;

    const done = await execute(app, RefundStepWorkflowStart, order);

    expect(done).toFinishWith(RefundStepWorkflowFinish, order);
    expect(paidSteps.ran).toEqual(["book", "check", "refund o1"]);
    expect(done.compensations).toMatchObject([
      { reason: CompensationReason.SidePath, status: CompensationStatus.Compensated },
    ]);
    expect(done.spend.totalUsd).toBe(150);
  });

  test("#675: held back as a step with its own side path: the booking is still refunded once, as its undo", async ({
    app,
  }) => {
    const done = await execute(app, RefundHandledWorkflowStart, order);

    // the forward visit stays stopped; the booking's undo runs past the budget, then the side path
    expect(done).toFinishWith(RefundToldWorkflowFinish, order);
    expect(paidSteps.ran).toEqual(["book", "check", "refund o1", "tell"]);
    expect(exemptions.undone).toEqual([
      expect.stringMatching(/:book-order-action:1:compensation$/),
    ]);
    expect(done.compensations).toMatchObject([
      { reason: CompensationReason.SidePath, status: CompensationStatus.Compensated },
    ]);
    expect(done).toHaveHandledError(BudgetExceededError, {
      at: RefundOrderAction,
      by: TellOrderAction,
    });
  });

  test("a refund of a booking made on the side path itself is a step: held back", async ({
    app,
  }) => {
    const run = execute(app, RebookWorkflowStart, order);

    await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
    expect(paidSteps.ran).toEqual(["reject", "book", "charge", "refund o1"]);
  });
});

describe("#656 AC3: what the budget's side path leads to step by step still runs", () => {
  test("a held order, then the team told: both past the budget", async ({ app }) => {
    const done = await execute(app, HeldLimitWorkflowStart, order);

    expect(done).toFinishWith(LimitNotedWorkflowFinish, { note: "notify" });
    expect(paidSteps.ran).toEqual(["charge", "hold", "notify"]);
    expect(done).toHaveHandledError(BudgetExceededError, {
      at: NoteOrderAction,
      by: HoldOrderAction,
    });
  });

  test("the side path of its own action's failure leads on from it: its action runs too", async ({
    app,
  }) => {
    const done = await execute(app, NestedLimitWorkflowStart, order);

    expect(done).toFinishWith(NestedLimitWorkflowFinish, { note: "notify" });
    expect(paidSteps.ran).toEqual(["charge", "reject", "notify"]);
  });
});
