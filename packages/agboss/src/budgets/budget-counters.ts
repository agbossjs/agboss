import { BudgetExceededError } from "../graph/limits.js";
import type { BudgetAccount, CostCounter } from "../infrastructure/cost-ledger.repository.js";
import type { UsageRecord } from "../finops/usage.js";
import { usd } from "../units/index.js";
import type { BudgetPeriod, BudgetScope } from "./budget.js";
import { periodStartOf } from "./budget-period.js";

/** One budget of an execution as it keeps it: plain data (checkpointed), the amount read at its start. */
export interface ExecutionBudgetRecord {
  readonly budget: { readonly name: string };
  readonly scope: BudgetScope;
  /** A tenant or application budget's period; none for an execution budget. */
  readonly period?: BudgetPeriod;
  /** The application's name, the `tenantId`, or the root execution's id. */
  readonly key: string;
  /** What `maxSpend()` gave at the start of the execution, in USD. */
  readonly maxSpend: number;
}

export const accountOf = (record: ExecutionBudgetRecord): BudgetAccount => ({
  budget: record.budget.name,
  scope: record.scope,
  key: record.key,
});

/** The counter a record's spend goes to at `moment`: its period's, or the execution's own. */
export const counterOf = (record: ExecutionBudgetRecord, moment: Date): CostCounter => ({
  ...accountOf(record),
  period: record.period === undefined ? "" : periodStartOf(record.period, moment),
});

/** The error of an exhausted budget. */
export const budgetExceededErrorOf = (
  record: ExecutionBudgetRecord,
  spent: number,
  path: readonly string[],
  executionSpent: number,
  usage: readonly UsageRecord[],
): BudgetExceededError =>
  new BudgetExceededError(
    {
      budget: record.budget,
      scope: record.scope,
      period: record.period,
      key: record.key,
      maxSpend: usd(record.maxSpend),
      spent: usd(Math.max(0, spent)),
    },
    path,
    executionSpent,
    usage,
  );
