import { describe, expect, it } from "vitest";
import { usd } from "@agboss/core/units";
import { CreditExecutionBudget } from "../../src/config/budget.config.js";

describe("budgets (#261): the credit desk's own execution budget, the tenant's day", () => {
  it("a budget's maxSpend() is a plain method", () => {
    expect(new CreditExecutionBudget().maxSpend()).toBe(usd(0.05));
  });
});
