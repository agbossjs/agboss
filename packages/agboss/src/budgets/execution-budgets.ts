import type { Clock } from "../infrastructure/clock.js";
import type { Class } from "../components/injection.js";
import { unrecordedOf } from "../finops/record-stream.js";
import { totalCost, type UsageRecord } from "../finops/usage.js";
import { BudgetExceededError } from "../graph/limits.js";
import type {
  BudgetAccount,
  CostCounter,
  CostLedgerRepository,
} from "../infrastructure/cost-ledger.repository.js";
import { counterKeyOf } from "../infrastructure/cost-ledger.repository.js";
import { usd } from "../units/index.js";
import { checkDeadline, type ExecutionDeadline } from "./execution-deadline.js";
import type { BudgetCheck } from "./budget-check.js";

export { NO_BUDGET_CHECK, type BudgetCheck } from "./budget-check.js";
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
 * tenant may overrun a little on a race, and a budget may be exceeded by at most the calls in flight
 * when it was exhausted (#338: the pass's live tally aborts them).
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
  /** The application's `Clock` (#262): the period a call is counted in. */
  readonly clock: Clock;
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

/** The key of a budget of `scope`: the application's name, the `tenantId` or the execution's id. */
export const budgetKeyOf = (scope: BudgetScope, keys: ExecutionKeys): string =>
  scope === BudgetScope.Application
    ? keys.applicationName
    : scope === BudgetScope.Tenant
      ? keys.tenantId
      : keys.executionId;

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
 *
 * The live tally (#338): the pass's spend is also counted as it is made (`tally` — an agent's
 * model calls, guardrails and judges, a tool's or a step's service spend, an arbiter's decision),
 * before it reaches the state; what is not tallied (a router's decision) counts when its step
 * ends. A check takes the larger of the caller's view (its state's spend) and the meter's (what it
 * recorded plus the tally not in the ledger yet), so a branch of a parallel launch sees its
 * siblings' spend while they run; the ledger is still written once per superstep (`record` takes
 * the matching records out of the tally, so nothing is counted twice). A tally that exhausts a budget aborts `exhausted`
 * with that `BudgetExceededError`: every branch of the pass's launches watches it, so their
 * in-flight calls stop at once. One meter per pass and tree on this instance (the lease gives one
 * mover); other instances see the spend through the ledger only.
 */
export class BudgetMeter implements BudgetCheck {
  /** What this pass wrote to the ledger. */
  #recorded = 0;
  #snapshot: CounterSnapshot = { values: new Map(), recorded: 0 };
  /** The pass's spend tallied as it was made and not written to the ledger yet. */
  #tallied: UsageRecord[] = [];
  readonly #exhausted = new AbortController();

  /**
   * `spentBefore` is what the execution spent before this pass — already in the ledger (0 for a new
   * execution).
   */
  constructor(
    readonly records: readonly ExecutionBudgetRecord[],
    private readonly ledger: CostLedgerRepository,
    private readonly clock: Clock,
    private readonly spentBefore: number,
    /** The execution's deadline (#398 PR 2): checked with the budgets. */
    readonly deadline?: ExecutionDeadline,
  ) {}

  /** Aborted, with its `BudgetExceededError` as the reason, when a tally exhausts a budget. */
  get exhausted(): AbortSignal {
    return this.#exhausted.signal;
  }

  /** Reads every counter of the execution's budgets in their current period. */
  async refresh(): Promise<void> {
    const recorded = this.#recorded;
    const now = this.clock.now();
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

  /** The execution's total as the meter knows it: before this pass, recorded, tallied. */
  #executionSpent(): number {
    return this.spentBefore + this.#recorded + totalCost(this.#tallied);
  }

  /** The first budget exhausted at `executionSpent`, as its error. */
  #breachOf(
    executionSpent: number,
    path: readonly string[],
    usage: readonly UsageRecord[],
  ): BudgetExceededError | undefined {
    const now = this.clock.now();
    for (const record of this.records) {
      const spent = this.#spentOf(record, executionSpent, now);
      if (spent >= record.maxSpend)
        return budgetExceededErrorOf(record, spent, path, executionSpent, usage);
    }
    return undefined;
  }

  check(executionSpent: number, path: readonly string[], usage: readonly UsageRecord[] = []): void {
    const spent = Math.max(executionSpent, this.#executionSpent());
    checkDeadline(this.deadline, this.clock.now(), { path, spentUsd: spent, usage });
    const breach = this.#breachOf(spent, path, usage);
    if (breach !== undefined) throw breach;
  }

  tally(records: readonly UsageRecord[], path: readonly string[] = []): void {
    if (records.length === 0 || this.records.length === 0) return;
    this.#tallied.push(...records);
    if (this.#exhausted.signal.aborted) return;
    // the records are in the tally (and soon in the state): the error carries none of them
    const breach = this.#breachOf(this.#executionSpent(), path, []);
    if (breach !== undefined) this.#exhausted.abort(breach);
  }

  /** What the execution may still spend now: the least any of its budgets has left. */
  remaining(): number {
    const now = this.clock.now();
    const spent = this.#executionSpent();
    return Math.min(
      ...this.records.map((record) => record.maxSpend - this.#spentOf(record, spent, now)),
      Number.POSITIVE_INFINITY,
    );
  }

  /**
   * What the execution may spend in total at the last read: the least that any of its budgets has
   * left, plus what it spent before this pass (`Infinity` without budgets).
   */
  budgetUsd(): number {
    const now = this.clock.now();
    return (
      Math.min(
        ...this.records.map(
          (record) => record.maxSpend - this.#spentOf(record, this.spentBefore, now),
        ),
        Number.POSITIVE_INFINITY,
      ) + this.spentBefore
    );
  }

  /** Adds the calls' cost to every counter (their period); one recorded elsewhere only counts (#333). */
  async record(records: readonly UsageRecord[]): Promise<void> {
    if (records.length === 0 || this.records.length === 0) return;
    const now = this.clock.now();
    // counted first: a read meanwhile sees a little less, never twice the same call
    this.#recorded += totalCost(records);
    // what was tallied as it was made is in the ledger now: out of the tally (as multisets)
    this.#tallied = [...unrecordedOf(this.#tallied, records)];
    const own = records.filter((record) => record.isRecordedElsewhere !== true);
    if (own.length === 0) return;
    await this.ledger.saveAll(
      this.records.map((record) => counterOf(record, now)),
      own,
    );
  }
}

/** A pass's budgets over the records the execution keeps. */
export const meterOf = (
  application: Pick<ApplicationBudgets, "ledger" | "clock">,
  records: readonly ExecutionBudgetRecord[],
  spentBefore: number,
  deadline?: ExecutionDeadline,
): BudgetMeter =>
  new BudgetMeter(records, application.ledger, application.clock, spentBefore, deadline);
