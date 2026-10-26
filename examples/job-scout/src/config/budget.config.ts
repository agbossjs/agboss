import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "@agboss/core";
import { usd, type Usd } from "@agboss/core/units";

/**
 * Every budget of job-scout (#261): the whole application per day, a tenant per day, and the
 * default execution budget of every workflow. Each execution is checked against them before its
 * first step (one exhausted → it is rejected) and every model call is counted in all of them (the
 * first exhausted stops it with `BudgetExceededError`).
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
