/**
 * #262 PR 2 — limits (AC11): an application test checks its own reaction to a limit — its
 * `.onError` path and its finish — reached the real way: `mockOf(Budget).maxSpend` plus a scripted
 * cost. There is no `limits` option on `testWith` (`scripts.test-d.ts`).
 */
import { describe, expect } from "vitest";
import { replyWith, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import {
  Buyer,
  Checker,
  Done,
  Order,
  OverBudget,
  PurchaseDto,
  ShopApplication,
} from "../errors/fixtures.js";
import { TestTenantDailyBudget } from "../flow/fixtures/budgets.js";
import { execute } from "../helpers/flow.js";

const shop = testWith(ShopApplication);

describe("AC11: budget via mockOf + cost", () => {
  shop(
    "a tenant without budget left: the shop takes its own .onError path to its finish",
    async ({ app, mockLlm, mockOf }) => {
      mockOf(TestTenantDailyBudget).maxSpend.mockReturnValue(usd(0.002));
      mockLlm(Buyer).thenReturn(replyWith(PurchaseDto, { item: "a lamp" }, { cost: usd(0.005) }));

      const result = await execute(app, Order, { text: "buy a lamp" });

      expect(result).toFollowPath([Order, Buyer, Checker, OverBudget]);
      expect(result).toFinishWith(OverBudget);
      expect(mockLlm(Checker).requests).toHaveLength(0);
    },
  );

  shop("with the budget left the happy path is taken", async ({ app, mockLlm }) => {
    mockLlm(Buyer).thenReturn(replyWith(PurchaseDto, { item: "a lamp" }, { cost: usd(0.005) }));
    mockLlm(Checker).thenReturn(replyWith("checked"));

    expect(await execute(app, Order, { text: "buy a lamp" })).toFinishWith(Done);
  });
});
