/**
 * #194 AC1: `catchError(BudgetExceededError)` takes the error branch when the run budget runs out —
 * also when the failure comes after a pause, a restart (`recoverApp`) and a resume from the
 * checkpoint; matching is by the error's stable code, kept as a plain record in the flow state.
 */
import { describe, expect } from "vitest";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { BudgetExceededError, BudgetScope, LimitExceededError } from "../../src/index.js";
import { usd } from "../../src/units/index.js";
import {
  Buyer,
  Checker,
  Done,
  OverBudget,
  Order,
  Pay,
  PurchaseDto,
  ShopApplication,
  ShopCatchingLimitsApplication,
  ShopUncaughtApplication,
} from "./fixtures.js";
import { execute, answerOf } from "../helpers/flow.js";

const approve = { approved: true };
const shop = testWith(ShopApplication);
const parentCatch = testWith(ShopCatchingLimitsApplication);
const uncaught = testWith(ShopUncaughtApplication);

describe("#194 AC1: catchError(BudgetExceededError) when the run budget runs out", () => {
  shop("the run takes the error branch instead of failing", async ({ app, mockLlm }) => {
    mockLlm(Buyer).thenReturn(replyWith(PurchaseDto, { item: "bought" }, { cost: usd(0.02) }));

    const result = await execute(app, Order, { text: "buy a lamp" });

    expect(result).toFinishWith(OverBudget);
    expect(result).toFollowPath([Order, Buyer, Checker, OverBudget]);
    expect(mockLlm(Checker).requests).toHaveLength(0);
    expect(result.spend.totalUsd).toBeCloseTo(0.02, 9);
  });

  shop(
    "after a pause, a restart and a resume from the checkpoint",
    async ({ app, recoverApp, mockLlm }) => {
      mockLlm(Buyer).thenReturn(
        callTool(Pay, { item: "lamp" }),
        replyWith(PurchaseDto, { item: "paid" }, { cost: usd(0.02) }),
      );

      const paused = await execute(app, Order, { text: "buy a lamp" });
      const restarted = await recoverApp();
      const done = await restarted.resume(answerOf(paused, approve));

      expect(paused).toHavePausedAt(Buyer);
      expect(done).toFinishWith(OverBudget);
      expect(done).toFollowPath([Order, Buyer, Checker, OverBudget]);
      expect(mockLlm(Checker).requests).toHaveLength(0);
    },
  );

  parentCatch(
    "catching the parent LimitExceededError catches the budget error too",
    async ({ app, mockLlm }) => {
      mockLlm(Buyer).thenReturn(replyWith(PurchaseDto, { item: "bought" }, { cost: usd(0.02) }));

      expect(await execute(app, Order, { text: "buy a lamp" })).toFinishWith(OverBudget);
    },
  );

  shop("within budget the happy route is taken", async ({ app, mockLlm }) => {
    mockLlm(Buyer).thenReturn(replyWith(PurchaseDto, { item: "bought" }, { cost: usd(0.001) }));
    mockLlm(Checker).thenReturn(replyWith("checked"));

    const result = await execute(app, Order, { text: "buy a lamp" });

    expect(result).toFollowPath([Order, Buyer, Checker, Done]);
    expect(result).toFinishWith(Done);
  });
});

describe("#194: the budget failure is thrown typed where it happens", () => {
  uncaught("without a catch the run fails with BudgetExceededError", async ({ app, mockLlm }) => {
    mockLlm(Buyer).thenReturn(replyWith(PurchaseDto, { item: "bought" }, { cost: usd(0.02) }));

    const error: unknown = await execute(app, Order, { text: "buy a lamp" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(error).toBeInstanceOf(LimitExceededError);
    expect(error).toMatchObject({
      code: "limit.budget",
      budget: { name: "shop-execution-budget" },
      scope: BudgetScope.Execution,
    });
    expect(error).toFailWith(BudgetExceededError, { budget: { name: "shop-execution-budget" } });
  });
});
