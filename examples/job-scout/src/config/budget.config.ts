import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "agboss";
import { usd, type Usd } from "agboss/units";

/**
 * Every budget of job-scout (#261): the whole application per day, a tenant per day, and the
 * default execution budget of every workflow. Declared here; they are checked when the runtime
 * budgets land (#261 PR 5) — until then the workflow's `settings().limits` caps the money.
 */

@Budget({
  name: "application-daily-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class ApplicationDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({
  name: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
})
export class TenantDailyBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({
  name: "execution-budget",
  scope: BudgetScope.Execution,
})
export class ExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.1);
  }
}
