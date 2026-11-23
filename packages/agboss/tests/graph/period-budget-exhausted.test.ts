/**
 * #1366: an eval replay or compare stops as "budget exhausted" only on a budget of a period — a tenant's or the
 * application's — and never on the one execution's own budget, nor on an error that is no budget's.
 */
import { describe, expect, it } from "vitest";
import { BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { BudgetExceededError, isPeriodBudgetExhausted } from "../../src/graph/limits.js";
import { usd } from "../../src/units/index.js";

const breachOf = (scope: BudgetScope) =>
  new BudgetExceededError({
    budget: { name: "shop-budget" },
    scope,
    period: scope === BudgetScope.Execution ? undefined : BudgetPeriod.Day,
    key: "k",
    maxSpend: usd(1),
    spent: usd(2),
    path: [],
    spentUsd: 2,
  });

describe("#1366: a period budget exhausted", () => {
  it("is a tenant's or the application's budget", () => {
    expect(isPeriodBudgetExhausted(breachOf(BudgetScope.Tenant))).toBe(true);
    expect(isPeriodBudgetExhausted(breachOf(BudgetScope.Application))).toBe(true);
  });

  it("is not one execution's own budget", () => {
    expect(isPeriodBudgetExhausted(breachOf(BudgetScope.Execution))).toBe(false);
  });

  it("is not any other error", () => {
    expect(isPeriodBudgetExhausted(new Error("budget"))).toBe(false);
    expect(isPeriodBudgetExhausted("tenant")).toBe(false);
  });
});
