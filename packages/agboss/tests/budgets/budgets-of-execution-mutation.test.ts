/**
 * #1356 (money shard) — which budgets an execution of a workflow runs under, each rule on its own: the execution
 * budget a workflow attaches is its own and no other execution budget counts beside it; one that another
 * workflow attaches is never the default of those that attach none; a tenant or application budget a workflow
 * attaches counts once, whether the application lists it or not, beside the default execution budget.
 */
import { describe, expect, it } from "vitest";
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "../../src/budgets/budget.js";
import { budgetsOfExecution } from "../../src/budgets/budget-check.js";
import type { Class } from "../../src/components/injection.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { Ttl, usd, type Usd } from "../../src/units/index.js";

@Budget({ name: "own-execution-budget", scope: BudgetScope.Execution })
class OwnExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "default-execution-budget", scope: BudgetScope.Execution })
class DefaultExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(2);
  }
}

@Budget({ name: "tier-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
class TierTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(3);
  }
}

@Budget({
  name: "shop-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
class ShopApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(4);
  }
}

const workflowOf = (name: string, budget?: Class): Class => {
  @Workflow({
    name,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [],
    ...(budget ? { budget } : {}),
  })
  class Declared {}
  return Declared;
};

const namesOf = (found: ReturnType<typeof budgetsOfExecution>): string[] =>
  found.map(({ meta }) => meta.name);

describe("#1356: the budgets of an execution", () => {
  it("a workflow with no budget of its own runs under the default execution budget, the tenant's and the application's, in the order listed", () => {
    const found = budgetsOfExecution(
      { budgets: [DefaultExecutionBudget, TierTenantBudget, ShopApplicationBudget] },
      workflowOf("plain"),
    );

    expect(namesOf(found)).toEqual([
      "default-execution-budget",
      "tier-tenant-budget",
      "shop-application-budget",
    ]);
  });

  it("an execution budget a workflow attaches replaces the default one, listed or not, and counts once", () => {
    const own = workflowOf("own", OwnExecutionBudget);

    const listed = budgetsOfExecution(
      { budgets: [OwnExecutionBudget, DefaultExecutionBudget, TierTenantBudget] },
      own,
    );
    const unlisted = budgetsOfExecution(
      { budgets: [DefaultExecutionBudget, TierTenantBudget] },
      own,
    );

    expect(namesOf(listed)).toEqual(["tier-tenant-budget", "own-execution-budget"]);
    expect(namesOf(unlisted)).toEqual(["tier-tenant-budget", "own-execution-budget"]);
  });

  it("a tenant budget a workflow attaches comes beside the default execution budget, never in its place", () => {
    const tiered = workflowOf("tiered", TierTenantBudget);

    const found = budgetsOfExecution({ budgets: [DefaultExecutionBudget] }, tiered);

    expect(namesOf(found)).toEqual(["default-execution-budget", "tier-tenant-budget"]);
  });

  it("a tenant budget a workflow attaches that the application lists as well counts once", () => {
    const tiered = workflowOf("tiered-listed", TierTenantBudget);

    const found = budgetsOfExecution(
      { budgets: [DefaultExecutionBudget, TierTenantBudget, ShopApplicationBudget] },
      tiered,
    );

    expect(namesOf(found)).toEqual([
      "default-execution-budget",
      "tier-tenant-budget",
      "shop-application-budget",
    ]);
  });

  it("an execution budget another workflow attaches is never the default of a workflow that attaches none", () => {
    const found = budgetsOfExecution(
      {
        budgets: [OwnExecutionBudget, DefaultExecutionBudget],
        attached: [OwnExecutionBudget],
      },
      workflowOf("bystander"),
    );

    expect(namesOf(found)).toEqual(["default-execution-budget"]);
  });

  it("with nothing attached by any workflow, the first execution budget with no workflow is the default", () => {
    const found = budgetsOfExecution(
      { budgets: [OwnExecutionBudget, DefaultExecutionBudget] },
      workflowOf("first"),
    );

    expect(namesOf(found)).toEqual(["own-execution-budget"]);
  });
});
