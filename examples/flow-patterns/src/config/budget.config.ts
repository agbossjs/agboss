import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "agboss";
import { usd, type Usd } from "agboss/units";
import { CreditWorkflow } from "../credit/credit.workflow.js";

/**
 * Every budget of the flow patterns (#261): the whole application per day, a tenant per day, the
 * credit desk's own execution budget and the default execution budget of the other workflows.
 * Each execution is checked against its budgets before its first step (one exhausted → it is
 * rejected) and every model call is counted in all of them (the first exhausted stops it with
 * `BudgetExceededError`).
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
  name: "credit-execution-budget",
  scope: BudgetScope.Execution,
  workflow: CreditWorkflow,
})
export class CreditExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05); // one credit order: its own cap, not the default
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
