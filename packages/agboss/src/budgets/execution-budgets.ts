import type { Class } from "../components/injection.js";
import { totalCost, type UsageRecord } from "../finops/usage.js";
import { BudgetExceededError } from "../graph/limits.js";
import type {
  BudgetAccount,
  CostCounter,
  CostLedgerRepository,
} from "../infrastructure/cost-ledger.repository.js";
import { counterKeyOf } from "../infrastructure/cost-ledger.repository.js";
import { usd } from "../units/index.js";
import {
  budgetOf,
  BudgetScope,
  type BudgetHandler,
  type BudgetMeta,
  type BudgetPeriod,
} from "./budget.js";
import { periodStartOf } from "./budget-period.js";

/**
 * Budgets at run time (#261 PR 5): which budgets an execution has — its own workflow's execution
 * budget (else the default one), every tenant budget and every application budget —, their
 * `maxSpend()` read once, at its start, and kept for the whole execution (in its state, so a resume
 * or a recovery keeps them), the ledger checked before the first step (any exhausted → the
 * execution is rejected) and every model call's cost counted in all of them, the first exhausted
 * stopping the execution with `BudgetExceededError`. Nothing is reserved: parallel executions of one
 * tenant may overrun a little on a race, and a budget may be exceeded by the cost of one call.
 */

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

/** A budget class with what `@Budget` says of it. */
interface ListedBudget {
  readonly type: Class;
  readonly meta: BudgetMeta;
}

/** An application's budgets, as one workflow of it runs them. */
export interface ApplicationBudgets {
  /** Every `@Budget` the application lists. */
  readonly budgets: readonly Class[];
  /** The application's name: the key of its application budgets. */
  readonly applicationName: string;
  /** The budget instance (the container's, or a test's mock). */
  readonly resolve: (budget: Class) => BudgetHandler;
  readonly ledger: CostLedgerRepository;
  /** The framework's clock: the period a call is counted in. */
  readonly clock: () => Date;
}

const listed = (budgets: readonly Class[]): readonly ListedBudget[] =>
  budgets.flatMap((type) => {
    const meta = budgetOf(type);
    return meta === undefined ? [] : [{ type, meta }];
  });

/**
 * The budgets of an execution of `workflow` started directly: its own execution budget (else the
 * default one), every tenant budget, every application budget — in the order listed.
 */
export function budgetsOfExecution(
  budgets: readonly Class[],
  workflow: Class,
): readonly ListedBudget[] {
  const all = listed(budgets);
  const execution = all.filter((budget) => budget.meta.scope === BudgetScope.Execution);
  const own = execution.find((budget) => budget.meta.workflow === workflow);
  const chosen = own ?? execution.find((budget) => budget.meta.workflow === undefined);
  return all.filter((budget) => budget.meta.scope !== BudgetScope.Execution || budget === chosen);
}

/** Whose spend an execution's budget counts. */
export interface ExecutionKeys {
  readonly applicationName: string;
  readonly tenantId: string;
  readonly executionId: string;
}

const keyOf = (scope: BudgetScope, keys: ExecutionKeys): string => {
  switch (scope) {
    case BudgetScope.Application:
      return keys.applicationName;
    case BudgetScope.Tenant:
      return keys.tenantId;
    case BudgetScope.Execution:
      return keys.executionId;
  }
};

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
const exhausted = (
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
 * Opens the budgets of a new execution: `maxSpend()` of each read once (in `inFrame`, where the
 * execution's `ExecutionContext` can be read) and kept in the ledger as the last known limit, then
 * every counter read — one exhausted rejects the execution before its first step.
 */
export async function openBudgets(
  application: ApplicationBudgets,
  workflow: Class,
  keys: ExecutionKeys,
  inFrame: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<readonly ExecutionBudgetRecord[]> {
  const records: ExecutionBudgetRecord[] = [];
  for (const { type, meta } of budgetsOfExecution(application.budgets, workflow)) {
    const handler = application.resolve(type);
    const maxSpend = await inFrame(() => Promise.resolve(handler.maxSpend()));
    const record: ExecutionBudgetRecord = {
      budget: { name: meta.name },
      scope: meta.scope,
      ...(meta.period === undefined ? {} : { period: meta.period }),
      key: keyOf(meta.scope, keys),
      maxSpend,
    };
    records.push(record);
  }
  const now = application.clock();
  for (const record of records) {
    const spent = await application.ledger.findSpentByCounter(counterOf(record, now));
    if (spent >= record.maxSpend) throw exhausted(record, spent, [], 0, []);
  }
  // kept only once the execution is admitted: a refused request leaves no trace
  for (const record of records)
    await application.ledger.saveMaxSpend(accountOf(record), usd(record.maxSpend));
  return records;
}

/** What a check of an execution's budgets needs: no I/O, the counters as last read. */
export interface BudgetCheck {
  /** Throws the first exhausted budget's `BudgetExceededError`; `executionSpent` is the execution's total. */
  readonly check: (
    executionSpent: number,
    path: readonly string[],
    usage?: readonly UsageRecord[],
  ) => void;
}

/** No budgets (an agent loop run on its own). */
export const NO_BUDGET_CHECK: BudgetCheck = { check: () => undefined };

/** The counters as one read saw them, and what this pass had written to the ledger by then. */
interface CounterSnapshot {
  readonly values: ReadonlyMap<string, number>;
  readonly recorded: number;
}

/**
 * The budgets of one pass of an execution (its run, a resume, a recovery): their counters read
 * before each working step (`refresh`, so the spend of the tenant's other executions counts),
 * checked before each step and model call (`check`), each call's cost added to every one of them
 * (`record`). A counter's value now = what it held at the last read + what the execution spent
 * since that is not in the ledger yet.
 */
export class BudgetMeter implements BudgetCheck {
  /** What this pass wrote to the ledger. */
  #recorded = 0;
  #snapshot: CounterSnapshot = { values: new Map(), recorded: 0 };

  /**
   * `spentBefore` is what the execution spent before this pass — already in the ledger (0 for a new
   * execution).
   */
  constructor(
    readonly records: readonly ExecutionBudgetRecord[],
    private readonly ledger: CostLedgerRepository,
    private readonly clock: () => Date,
    private readonly spentBefore: number,
  ) {}

  /** Reads every counter of the execution's budgets in their current period. */
  async refresh(): Promise<void> {
    const recorded = this.#recorded;
    const now = this.clock();
    const values = new Map<string, number>();
    for (const record of this.records) {
      const counter = counterOf(record, now);
      values.set(counterKeyOf(counter), await this.ledger.findSpentByCounter(counter));
    }
    this.#snapshot = { values, recorded };
  }

  /** A budget's spend now, from the last read and the execution's total `executionSpent`. */
  #spentOf(record: ExecutionBudgetRecord, executionSpent: number, now: Date): number {
    const counted = this.#snapshot.values.get(counterKeyOf(counterOf(record, now))) ?? 0;
    return counted + (executionSpent - this.spentBefore - this.#snapshot.recorded);
  }

  check(executionSpent: number, path: readonly string[], usage: readonly UsageRecord[] = []): void {
    const now = this.clock();
    for (const record of this.records) {
      const spent = this.#spentOf(record, executionSpent, now);
      if (spent >= record.maxSpend) throw exhausted(record, spent, path, executionSpent, usage);
    }
  }

  /**
   * What the execution may spend in total at the last read: the least that any of its budgets has
   * left, plus what it spent before this pass (`Infinity` without budgets).
   */
  budgetUsd(): number {
    const now = this.clock();
    return (
      Math.min(
        ...this.records.map(
          (record) => record.maxSpend - this.#spentOf(record, this.spentBefore, now),
        ),
        Number.POSITIVE_INFINITY,
      ) + this.spentBefore
    );
  }

  /** Adds the calls' cost to every counter of the execution's budgets (their current period). */
  async record(records: readonly UsageRecord[]): Promise<void> {
    if (records.length === 0 || this.records.length === 0) return;
    const now = this.clock();
    // counted first: a read meanwhile sees a little less, never twice the same call
    this.#recorded += totalCost(records);
    await this.ledger.saveAll(
      this.records.map((record) => counterOf(record, now)),
      records,
    );
  }
}

/** A pass's budgets over the records the execution keeps. */
export const meterOf = (
  application: Pick<ApplicationBudgets, "ledger" | "clock">,
  records: readonly ExecutionBudgetRecord[],
  spentBefore: number,
): BudgetMeter => new BudgetMeter(records, application.ledger, application.clock, spentBefore);
