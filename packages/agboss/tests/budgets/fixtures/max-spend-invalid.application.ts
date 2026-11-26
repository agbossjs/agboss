import { Budget, BudgetScope } from "../../../src/index.js";
import type { BudgetHandler } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { usd, type Usd } from "../../../src/units/index.js";
import {
  BriefWorkflow,
  ShopApplicationDailyBudget,
  ShopTenantContext,
  ShopTenantMonthlyBudget,
} from "./budgets.application.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #1373: an execution budget whose `maxSpend()` gives what the test says — a stored amount a database or a file
 * may hold wrong: `NaN`, a word, an object, `null`, a negative number.
 */

/** What the next `maxSpend()` gives. */
export const given: { amount: unknown } = { amount: usd(1) };

@Budget({ name: "given-budget", scope: BudgetScope.Execution, workflow: BriefWorkflow })
export class GivenBudget implements BudgetHandler {
  maxSpend(): Usd {
    return given.amount as Usd;
  }
}

@Application({
  name: "given-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [BriefWorkflow],
  tenantContext: ShopTenantContext,
  budgets: [ShopApplicationDailyBudget, ShopTenantMonthlyBudget, GivenBudget],
})
export class GivenApplication {}
