/**
 * #1356 — what `@Budget` records about a class: the period and the workflow only when it was given
 * one, so a budget's meta never lists a key as undefined.
 */
import { describe, expect, it } from "vitest";
import { Budget, BudgetPeriod, BudgetScope, budgetOf } from "../../src/budgets/budget.js";
import { usd } from "../../src/units/index.js";

class Reviewed {
  readonly kind = "reviewed";
}

@Budget({ name: "tenant-weekly-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Week })
class Tenant {
  maxSpend = () => usd(1);
}
@Budget({ name: "reviewed-budget", scope: BudgetScope.Execution, workflow: Reviewed })
class Own {
  maxSpend = () => usd(1);
}
@Budget({ name: "any-budget", scope: BudgetScope.Execution })
class Default {
  maxSpend = () => usd(1);
}

describe("#1356: the meta of a budget", () => {
  it("has the period of a tenant's, and no workflow", () => {
    expect(budgetOf(Tenant)).toStrictEqual({
      name: "tenant-weekly-budget",
      scope: BudgetScope.Tenant,
      deps: [],
      period: BudgetPeriod.Week,
    });
  });

  it("has the workflow of an execution budget's own, and no period", () => {
    expect(budgetOf(Own)).toStrictEqual({
      name: "reviewed-budget",
      scope: BudgetScope.Execution,
      deps: [],
      workflow: Reviewed,
    });
  });

  it("has neither for a default execution budget; a class that is no budget has none", () => {
    expect(budgetOf(Default)).toStrictEqual({
      name: "any-budget",
      scope: BudgetScope.Execution,
      deps: [],
    });
    expect(budgetOf(Reviewed)).toBeUndefined();
  });
});
