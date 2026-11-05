import { BudgetScope } from "../../budgets/budget.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { CostCounter } from "../../infrastructure/cost-ledger.repository.js";

/** The cost ledger contract's data: a call and the counters its cases save to. */

/** A model call that cost `costUsd` (only the cost is counted). */
export const call = (costUsd: number): UsageRecord => ({
  caller: "clerk-agent",
  model: "test/clerk",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
  costSource: "api",
});

export const tenantDay: CostCounter = {
  budget: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  key: "acme",
  period: "2026-10-18",
};
export const applicationMonth: CostCounter = {
  budget: "application-monthly-budget",
  scope: BudgetScope.Application,
  key: "desk-application",
  period: "2026-10-01",
};
