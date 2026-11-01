/**
 * #683 — a booking's undo action launched as a branch, held back by the budget, is never a refund
 * lost. The branch is a step (#656: a launch is checked), so it is held back before it runs and
 * the join fails; the execution's automatic undo then refunds the booking once, past the budget —
 * in a parallel launch, a per-item launch, a child on this instance and a child on any instance.
 * No side path can take that join's failure and finish with the booking open: a launched undo
 * action never undoes in `agboss check`'s walk, and its class is a branch only — the one guard
 * that keeps a finish from committing a booking the held branch owed (#675 handles the main path).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { BudgetExceededError, Workflow } from "../../src/index.js";
import { checkWorkflow } from "../../src/flow/analyse/analyse.js";
import type { WorkflowOptions } from "../../src/flow/decorators/workflow.js";
import { testWith } from "../../src/testing/index.js";
import { execute, start, toAction } from "../helpers/flow.js";
import {
  HeldAnyWorkflowStart,
  HeldBranchApplication,
  HeldBranchWorkflowFinish,
  HeldBranchWorkflowStart,
  HeldItemsWorkflowStart,
  HeldLocalWorkflowStart,
} from "./fixtures/held-branch.workflow.js";
import {
  CheckOrderAction,
  exemptions,
  resetExemptions,
  TellOrderAction,
} from "./fixtures/paid-exemptions.actions.js";
import {
  BookOrderAction,
  DeclineOrderAction,
  MemoOrderAction,
  RefundOrderAction,
} from "./fixtures/paid-steps.actions.js";
import {
  OrderDeclinedError,
  OrderDto,
  paidSteps,
  resetPaidSteps,
} from "./fixtures/paid-steps.dto.js";

const test = testWith(HeldBranchApplication);

beforeEach(() => {
  resetPaidSteps();
  resetExemptions();
});

const order = { orderId: "o1" };
const UNDONE = "book-order-action execution-failed compensated";

describe("#683: a refund launched as a branch and held back by the budget", () => {
  test("a parallel launch: the branch never runs, the automatic undo refunds once", async ({
    app,
  }) => {
    const run = execute(app, HeldBranchWorkflowStart, order);

    await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
    expect(paidSteps.ran).toEqual(["book", "check", "refund o1"]);
    // the one refund is the booking's undo, never the held-back branch
    expect(exemptions.undone).toEqual([
      expect.stringMatching(/:book-order-action:1:compensation$/),
    ]);
    expect(exemptions.undos).toEqual([UNDONE]);
  });

  test("a per-item launch: no part refunded as a step, the booking refunded once", async ({
    app,
  }) => {
    const run = execute(app, HeldItemsWorkflowStart, order);

    await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
    expect(paidSteps.ran).toEqual(["book", "split", "refund o1"]);
    expect(exemptions.undos).toEqual([UNDONE]);
  });

  for (const [where, child] of [
    ["on this instance", HeldLocalWorkflowStart],
    ["on any instance", HeldAnyWorkflowStart],
  ] as const)
    test(`in a child ${where}: the child refunds once, the tree fails with the budget`, async ({
      app,
    }) => {
      const run = execute(app, child, order);

      // a child on another instance fails its parent with the error as recorded: by its name
      await expect(run).rejects.toMatchObject({ name: "BudgetExceededError" });
      expect(paidSteps.ran).toEqual(["book", "check", "refund o1"]);
      expect(exemptions.undos).toEqual([UNDONE]);
    });

  test("below the budget the branch runs: the booking refunded once, by the branch", async ({
    app,
  }) => {
    paidSteps.charge = 1;

    const done = await execute(app, HeldBranchWorkflowStart, order);

    expect(done).toFinishWith(HeldBranchWorkflowFinish, order);
    expect(paidSteps.ran).toEqual(["book", "check", "refund o1", "memo"]);
    expect(exemptions.undone).toEqual([]);
  });
});

let count = 0;
/** The workflow's compensation and launch rules broken, by code. */
function brokenRules(flow: WorkflowOptions["flow"]): readonly string[] {
  count += 1;
  @Workflow({ name: `held-case-${String(count)}-workflow`, version: "1.0.0", flow })
  class HeldCaseWorkflow {}
  return checkWorkflow(HeldCaseWorkflow).errors.map((error) => error.code);
}

const launched = start(HeldBranchWorkflowStart)
  .returns(OrderDto)
  .toAction(BookOrderAction)
  .toAction(CheckOrderAction)
  .returns(OrderDto)
  .toParallelActions(RefundOrderAction, MemoOrderAction)
  .join();

describe("#683: no side path takes the held branch's failure with the booking open", () => {
  it("the join's .onJoinError owes the booking: the launched refund never undid it", () => {
    const flow = [
      launched
        .onJoinError(
          BudgetExceededError,
          toAction(TellOrderAction).toFinish(HeldBranchWorkflowFinish),
        )
        .toFinish(HeldBranchWorkflowFinish),
    ];

    expect(brokenRules(flow)).toEqual(["flow.uncompensated-action"]);
  });

  it("nor can the side path refund with the same class: it is the launch's branch", () => {
    const side = toAction(RefundOrderAction).toFinish(HeldBranchWorkflowFinish);
    const flow = [
      launched.onJoinError(BudgetExceededError, side).toFinish(HeldBranchWorkflowFinish),
    ];

    expect(brokenRules(flow)).toEqual(expect.arrayContaining(["launch.branch-continued"]));
  });

  it("a refund launched on a side path is no undo of it either", () => {
    const flow = [
      start(HeldBranchWorkflowStart)
        .returns(OrderDto)
        .toAction(BookOrderAction)
        .toAction(DeclineOrderAction)
        .onError(
          OrderDeclinedError,
          toAction(TellOrderAction)
            .toParallelActions(RefundOrderAction, MemoOrderAction)
            .join()
            .toFinish(HeldBranchWorkflowFinish),
        )
        .returns(OrderDto)
        .toFinish(HeldBranchWorkflowFinish),
    ];

    expect(brokenRules(flow)).toEqual(["flow.uncompensated-action"]);
  });
});
