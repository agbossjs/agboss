import {
  Budget,
  BudgetPeriod,
  BudgetScope,
  type BudgetHandler,
} from "../../../src/budgets/budget.js";
import { usd, type Usd } from "../../../src/units/index.js";

/**
 * The budgets every test application lists (#261 S29): one per scope, generous constants — the
 * whole application per day, a tenant per day, the default execution budget. Only the tests about
 * limits and the cost ledger declare their own.
 */

@Budget({
  name: "test-application-daily-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class TestApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1000);
  }
}

@Budget({
  name: "test-tenant-daily-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
})
export class TestTenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1000);
  }
}

@Budget({
  name: "test-execution-budget",
  scope: BudgetScope.Execution,
})
export class TestExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(100);
  }
}

/** `@Application({ budgets: TEST_BUDGETS })` in every test application. */
export const TEST_BUDGETS = [
  TestApplicationDailyBudget,
  TestTenantDailyBudget,
  TestExecutionBudget,
];
