import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "agboss";
import { usd, type Usd } from "agboss/units";
import { CreditWorkflow } from "../credit/credit.workflow.js";
import { TopicResearchWorkflow } from "../topic/topic-research.workflow.js";

/**
 * Every budget of the flow patterns (#261): the whole application per day, a tenant per day, the
 * credit desk's and the topic research's own execution budgets (#264: the root's pass counts every
 * recursive level) and the default execution budget of the other workflows.
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
  name: "topic-research-execution-budget",
  scope: BudgetScope.Execution,
  workflow: TopicResearchWorkflow,
})
export class TopicResearchExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(2); // the root's pass: every recursive level spends from it
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
