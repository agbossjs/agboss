import type { UsageRecord } from "../finops/usage.js";
import { BudgetExceededError } from "../graph/limits.js";
import type { BudgetAccount, CostCounter } from "../infrastructure/cost-ledger.repository.js";
import { usd } from "../units/index.js";
import type { BudgetPeriod, BudgetScope } from "./budget.js";
import { periodStartOf } from "./budget-period.js";
import type { ExecutionDeadline } from "./execution-deadline.js";

/** What a check of an execution's budgets needs: no I/O, the counters as last read. */
export interface BudgetCheck {
  /** Throws the first exhausted budget's `BudgetExceededError`; `executionSpent` is the execution's total. */
  readonly check: (
    executionSpent: number,
    path: readonly string[],
    usage?: readonly UsageRecord[],
  ) => void;
  /**
   * Counts spend the moment it is made (#338), before it reaches the execution's state: every
   * branch of the pass sees it at its next check, and a tally that exhausts a budget aborts the
   * in-flight calls of the pass's launches.
   */
  readonly tally: (records: readonly UsageRecord[], path?: readonly string[]) => void;
  /** Aborted, with its `BudgetExceededError` as the reason, when a tally exhausts a budget. */
  readonly exhausted: AbortSignal;
  /**
   * What the execution may still spend, in USD — the least any of its budgets has left (#398: the
   * `budget.remaining` its mesh calls claim); `Infinity` without budgets.
   */
  readonly remaining?: () => number;
  /** The execution's deadline (#398 PR 2), when it has one: what its mesh calls claim of it. */
  readonly deadline?: ExecutionDeadline | undefined;
}

/** No budgets (an agent loop run on its own). */
export const NO_BUDGET_CHECK: BudgetCheck = {
  check: () => undefined,
  tally: () => undefined,
  exhausted: new AbortController().signal,
};

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

/**
 * The counters as one read saw them, and how much of the execution's own spend that read holds: what
 * this pass had written by then and what it took in as written elsewhere (#685). A read and a write
 * of the meter never overlap, so `recorded` is exactly the part of the pass's spend in `values`.
 */
export interface CounterSnapshot {
  readonly values: ReadonlyMap<string, number>;
  readonly recorded: number;
}

/** A record this pass writes to the ledger; one recorded elsewhere is there already (#333 PR 3). */
export const isRecordedHere = (record: UsageRecord): boolean => record.isRecordedElsewhere !== true;

/** Micro-dollars in a dollar: the unit a budget's spend is compared in (#728). */
const MICRO_USD_PER_USD = 1_000_000;

/**
 * Whether `spent` has reached `maxSpend`, compared in whole micro-dollars (#728): a float sum of
 * costs lands a hair off its decimal value (eight $0.10 make 0.7999999999999999), and a plain
 * `>=` would let one more step through a limit the spend reached exactly. No epsilon: both sides
 * are rounded to the same grid, so a spend a micro-dollar under the limit still passes.
 */
export const isSpendExhausted = (spent: number, maxSpend: number): boolean =>
  Math.round(spent * MICRO_USD_PER_USD) >= Math.round(maxSpend * MICRO_USD_PER_USD);
