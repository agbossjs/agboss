/**
 * #634 — an exhausted budget holds back every step that can spend or reach out, not only agents
 * and routers: an action, a child workflow, one child per item, a level of a recursion, the
 * branches of a launch, the action of a side path the step's own error takes. It does not hold
 * back a finish, an undo, or the side path the budget's own error takes (the application's
 * reaction to it). Below the budget every one of them runs — the tests would pass vacuously else.
 */
import { beforeEach, describe, expect } from "vitest";
import { BudgetExceededError, DeadlineExceededError, type Class } from "../../src/index.js";
import { seconds } from "../../src/units/index.js";
import { until } from "../helpers/until.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { NoteOrderAction, NotifyOrderAction } from "./fixtures/paid-steps.actions.js";
import {
  PaidNestedWorkflowStart,
  PaidRefundWorkflowStart,
  RefundedWorkflowFinish,
} from "./fixtures/paid-nested.workflow.js";
import { PaidStepsApplication } from "./fixtures/paid-steps.application.js";
import { holdOrders, paidSteps, resetPaidSteps } from "./fixtures/paid-steps.dto.js";
import {
  PaidChildWorkflowStart,
  PaidHoldWorkflowStart,
  PaidItemsWorkflowStart,
  PaidLaunchWorkflowStart,
  PaidLevelWorkflowStart,
  PaidRaceWorkflowStart,
} from "./fixtures/paid-launches.workflow.js";
import {
  OverBudgetWorkflowFinish,
  PaidActionWorkflowStart,
  PaidAgentWorkflowStart,
  PaidDeclinedWorkflowStart,
  PaidFinishWorkflowStart,
  PaidLimitWorkflowStart,
  PaidOrderWorkflowFinish,
  PaidReviewAgent,
  PaidRouterWorkflowStart,
} from "./fixtures/paid-steps.workflow.js";

const test = testWith(PaidStepsApplication);

beforeEach(resetPaidSteps);

const order = { orderId: "o1" };

/** One step after the overspend: what ran past the budget, what ran below it, what started. */
interface HeldStep {
  readonly step: string;
  readonly start: Class;
  readonly input: unknown;
  readonly overBudget: readonly string[];
  readonly belowBudget: readonly string[];
  readonly startedBelow: readonly string[];
}

const HELD_STEPS: readonly HeldStep[] = [
  {
    step: "an action (the booking before it undone)",
    start: PaidActionWorkflowStart,
    input: order,
    overBudget: ["book", "charge", "refund o1"],
    belowBudget: ["book", "charge", "note"],
    startedBelow: ["paid-action-workflow"],
  },
  {
    step: "an action inside a child (the child's booking undone)",
    start: PaidNestedWorkflowStart,
    input: order,
    overBudget: ["book", "charge", "refund o1"],
    belowBudget: ["book", "charge", "note"],
    startedBelow: ["paid-nested-workflow", "paid-action-workflow"],
  },
  {
    step: "a code router",
    start: PaidRouterWorkflowStart,
    input: order,
    overBudget: ["charge"],
    belowBudget: ["charge", "note"],
    startedBelow: ["paid-router-workflow"],
  },
  {
    step: "a child workflow",
    start: PaidChildWorkflowStart,
    input: order,
    overBudget: ["charge"],
    belowBudget: ["charge", "note"],
    startedBelow: ["paid-child-workflow", "note-child-workflow"],
  },
  {
    step: "one child per item",
    start: PaidItemsWorkflowStart,
    input: [order, { orderId: "o2" }],
    overBudget: ["charge all"],
    belowBudget: ["charge all", "note", "note"],
    startedBelow: ["paid-items-workflow", "note-child-workflow", "note-child-workflow"],
  },
  {
    step: "the next level of a recursion",
    start: PaidLevelWorkflowStart,
    input: order,
    overBudget: ["level 1"],
    belowBudget: ["level 1", "level 2"],
    startedBelow: ["paid-level-workflow", "paid-level-workflow"],
  },
  {
    step: "both branches of a parallel launch",
    start: PaidLaunchWorkflowStart,
    input: order,
    overBudget: ["charge"],
    belowBudget: ["charge", "note", "memo"],
    startedBelow: ["paid-launch-workflow"],
  },
  {
    step: "a branch after the one that spent the last of the budget",
    start: PaidRaceWorkflowStart,
    input: order,
    overBudget: ["charge"],
    belowBudget: ["charge", "note"],
    startedBelow: ["paid-race-workflow"],
  },
  {
    step: "the action of the side path its own error takes",
    start: PaidDeclinedWorkflowStart,
    input: order,
    overBudget: ["decline"],
    belowBudget: ["decline", "notify"],
    startedBelow: ["paid-declined-workflow"],
  },
];

describe("#634: an exhausted budget holds back every step that can spend", () => {
  describe.each(HELD_STEPS)("$step", ({ start, input, overBudget, belowBudget, startedBelow }) => {
    test("past the budget it never runs: the execution fails, its undo runs", async ({ app }) => {
      const run = execute(app, start, input);

      await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
      await expect(run).rejects.toMatchObject({
        budget: { name: "test-execution-budget" },
        maxSpend: 100,
        spent: 150,
      });
      expect(paidSteps.ran).toEqual(overBudget);
      // nothing launched past the budget: no child, no level started
      expect(paidSteps.started).toEqual(
        startedBelow.slice(0, start === PaidNestedWorkflowStart ? 2 : 1),
      );
    });

    test("below the budget it runs", async ({ app }) => {
      paidSteps.charge = 1;

      await execute(app, start, input);

      expect([...paidSteps.ran].sort()).toEqual([...belowBudget].sort());
      expect(paidSteps.started).toEqual(startedBelow);
    });
  });

  test("an agent: no model call past the budget", async ({ app, mockLlm }) => {
    await expect(execute(app, PaidAgentWorkflowStart, order)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );

    expect(mockLlm(PaidReviewAgent).requests).toHaveLength(0);
    expect(paidSteps.ran).toEqual(["charge"]);
  });
});

describe("#634: the execution's deadline holds an action back too", () => {
  test("past its deadline the held order's next action never runs", async ({ app, clock }) => {
    const release = holdOrders();
    const held = execute(app, PaidHoldWorkflowStart, order, { deadline: seconds(5) });
    held.catch(() => undefined);
    await until(() => paidSteps.ran.includes("hold"), "the order held");

    await clock.advance(seconds(6));
    release();

    await expect(held).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(paidSteps.ran).toEqual(["hold"]);
  });
});

describe("#634: what an exhausted budget never holds back", () => {
  test("the undo action of a side path: it gives the money back", async ({ app }) => {
    const done = await execute(app, PaidRefundWorkflowStart, order);

    expect(done).toFinishWith(RefundedWorkflowFinish, order);
    expect(paidSteps.ran).toEqual(["book", "decline", "refund o1"]);
    expect(done.spend.totalUsd).toBe(150);
  });

  test("a finish: it spends nothing, the execution ends with what it spent", async ({ app }) => {
    const done = await execute(app, PaidFinishWorkflowStart, order);

    expect(done).toFinishWith(PaidOrderWorkflowFinish, order);
    expect(done.spend.totalUsd).toBe(150);
  });

  test("the side path the budget's own error takes: its action tells the team", async ({ app }) => {
    const done = await execute(app, PaidLimitWorkflowStart, order);

    expect(done).toFinishWith(OverBudgetWorkflowFinish, { note: "notify" });
    expect(paidSteps.ran).toEqual(["charge", "notify"]);
    expect(done).toHaveHandledError(BudgetExceededError, {
      at: NoteOrderAction,
      by: NotifyOrderAction,
    });
  });
});
