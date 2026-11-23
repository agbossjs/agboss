/**
 * #1366: a limit error keeps its code, its key and its facts (the steps' workflow record, the budget's figures) as
 * fields a handler reads; a budget's dollars are formatted to four decimals with no trailing zeros; a budget with
 * no period states no period; a period budget's exhaustion is told from an execution budget's.
 */
import { describe, expect, it } from "vitest";
import { BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import {
  BudgetExceededError,
  dollars,
  isPeriodBudgetExhausted,
  LimitExceededError,
  StepsLimitExceededError,
} from "../../src/graph/limits.js";
import { usd } from "../../src/units/index.js";

const workflow = { name: "desk", version: "1.0.0", startedVersion: "1.0.1", configHash: "h" };

describe("#1366: limit error facts", () => {
  it("the base limit's code is limit, on the class and on its instances", () => {
    const error = new LimitExceededError({ key: "k", limit: 1, actual: 2, path: [], spentUsd: 0 });

    expect(LimitExceededError.code).toBe("limit");
    expect(error.code).toBe("limit");
  });

  it("the steps' limit is keyed maxSteps and keeps its workflow, limit and count in its details", () => {
    const error = new StepsLimitExceededError({ workflow, maxSteps: 3, path: ["f"], spentUsd: 0 });

    expect(error.key).toBe("maxSteps");
    expect(error.details).toEqual({
      key: "maxSteps",
      limit: 3,
      actual: 4,
      workflow,
      maxSteps: 3,
      steps: 4,
    });
  });

  it("dollars writes up to four decimals and no trailing zeros", () => {
    expect(dollars(40)).toBe("$40");
    expect(dollars(40.05)).toBe("$40.05");
    expect(dollars(0.0125)).toBe("$0.0125");
    expect(dollars(0)).toBe("$0");
  });

  it("a tenant budget with no period is built without a period word", () => {
    const error = new BudgetExceededError({
      budget: { name: "tb" },
      scope: BudgetScope.Tenant,
      key: "acme",
      maxSpend: usd(40),
      spent: usd(40.05),
      path: [],
      spentUsd: 40.05,
    });

    expect(error.period).toBeUndefined();
    expect(error.message).not.toContain("undefined");
    expect(error.message).toContain("$40.05");
  });

  it("a tenant budget with a period names it next to the figures", () => {
    const error = new BudgetExceededError({
      budget: { name: "tb" },
      scope: BudgetScope.Tenant,
      period: BudgetPeriod.Day,
      key: "acme",
      maxSpend: usd(40),
      spent: usd(40.05),
      path: [],
      spentUsd: 40.05,
    });

    expect(error.message).toContain("today");
  });

  it("isPeriodBudgetExhausted is true for a tenant budget", () => {
    const error = new BudgetExceededError({
      budget: { name: "tb" },
      scope: BudgetScope.Tenant,
      period: BudgetPeriod.Day,
      key: "acme",
      maxSpend: usd(1),
      spent: usd(2),
      path: [],
      spentUsd: 2,
    });

    expect(isPeriodBudgetExhausted(error)).toBe(true);
  });
});
