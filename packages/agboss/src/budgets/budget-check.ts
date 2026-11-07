import { randomUUID } from "node:crypto";
import { ledgerMarkOf, writtenLedgerIdOf } from "../finops/ledger-mark.js";
import { unrecordedOf } from "../finops/record-stream.js";
import type { UsageRecord } from "../finops/usage.js";
import { BudgetExceededError } from "../graph/limits.js";
import type {
  BudgetAccount,
  CostCounter,
  LedgerEntry,
} from "../infrastructure/cost-ledger.repository.js";
import { usd } from "../units/index.js";
import type { Class } from "../components/injection.js";
import type { Clock } from "../infrastructure/clock.js";
import type { CostLedgerRepository } from "../infrastructure/cost-ledger.repository.js";
import { budgetOf, BudgetScope, type BudgetHandler, type BudgetMeta } from "./budget.js";
import type { BudgetPeriod } from "./budget.js";
import { periodStartOf } from "./budget-period.js";
import type { ExecutionDeadline } from "./execution-deadline.js";

/** What a check of an execution's budgets needs: no I/O, the counters as last read. */
export interface BudgetCheck {
  /**
   * Throws the first exhausted budget's `BudgetExceededError`; `state` is the execution's spend as
   * its state holds it — its records (so spend an earlier pass wrote as it was made counts once,
   * #727), or their total.
   */
  readonly check: (
    state: number | readonly UsageRecord[],
    path: readonly string[],
    usage?: readonly UsageRecord[],
  ) => void;
  /**
   * Counts spend the moment it is made (#338), before it reaches the execution's state: every
   * branch of the pass sees it at its next check, and a tally that exhausts a budget aborts the
   * in-flight calls of the pass's launches. It is written to the ledger at once (#727, #732): the
   * records it returns are the ones to keep in the state — marked as in the ledger, so nothing
   * writes them again.
   */
  readonly tally: (
    records: readonly UsageRecord[],
    path?: readonly string[],
  ) => readonly UsageRecord[];
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

/** Spend kept as it is: nothing writes it. */
function unchanged(records: readonly UsageRecord[]): readonly UsageRecord[] {
  return records;
}

/** No budgets (an agent loop run on its own). */
export const NO_BUDGET_CHECK: BudgetCheck = {
  check: () => undefined,
  tally: unchanged,
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

/** `record` as an entry of the ledger under `ledgerId`, made at `madeAt`, its cost in `Usd` (#817). */
export const ledgerEntryOf = (
  record: UsageRecord,
  ledgerId: string,
  madeAt: Date,
): LedgerEntry => ({
  ...record,
  costUsd: usd(record.costUsd),
  ledgerId,
  madeAt,
});

/** A record this pass writes to the ledger; one recorded elsewhere is there already (#333 PR 3). */
export const isRecordedHere = (record: UsageRecord): boolean => ledgerMarkOf(record) === undefined;

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

/**
 * The spend a pass counts by its `ledgerId` (#727): the ids it gives what it writes as it is made,
 * what it took in, and what its state held at its start. An id is this pass's own — a random prefix
 * of the pass and a number —, never derived from where the spend was made: spend made again, by a
 * later pass running a step again after a crash or a takeover, was billed again and counts again
 * under a new id. Only a record already kept — in a state an earlier pass made durable (restored
 * into this pass, or what it spent before), or taken in from a child on another instance — carries
 * an id the ledger has, and counts once.
 */
export class LedgerIds {
  readonly #counted = new Set<string>();
  readonly #prefix = randomUUID();
  #next = 0;
  /** Spend recorded elsewhere without a `ledgerId`, taken in before it reached `record`. */
  // Stryker disable next-line ArrayDeclaration: a stray string's multiset key is all nulls, which no usage record has, so it takes nothing out
  #takenIn: UsageRecord[] = [];

  constructor(counted: readonly UsageRecord[]) {
    this.count(counted);
  }

  /** A new id of this pass, counted from now. */
  mint(): string {
    // Stryker disable next-line UpdateOperator: counting down gives every id of the pass its own number as well
    const id = `${this.#prefix}:${String(this.#next++)}`;
    this.#counted.add(id);
    return id;
  }

  /** Counts the ids of `records`. */
  count(records: readonly UsageRecord[]): void {
    for (const record of records) {
      const ledgerId = writtenLedgerIdOf(record);
      // Stryker disable next-line ConditionalExpression: an absent id kept is never asked for
      if (ledgerId !== undefined) this.#counted.add(ledgerId);
    }
  }

  /**
   * Of the spend a state holds, what an earlier pass of the tree wrote as it was made and this
   * pass has not counted (a takeover's restored writes, an agent loop continued from its
   * checkpoint): in the ledger before this pass's first read, so every read of it holds it.
   */
  writtenBefore(state: readonly UsageRecord[]): number {
    let written = 0;
    for (const record of state) {
      const ledgerId = writtenLedgerIdOf(record);
      if (ledgerId !== undefined && !this.#counted.has(ledgerId)) written += record.costUsd;
    }
    return written;
  }

  /**
   * Of spend in the ledger (recorded elsewhere), what this pass has not counted yet: a record with
   * a `ledgerId` once by its id (#727), one without by the multiset of what was taken in before
   * (#685) — `isTakingIn` takes those in now, before the state shows them.
   */
  uncounted(records: readonly UsageRecord[], isTakingIn: boolean): readonly UsageRecord[] {
    const fresh: UsageRecord[] = [];
    const ids = new Set<string>();
    const unnamed: UsageRecord[] = [];
    for (const record of records) {
      if (isRecordedHere(record)) continue;
      const ledgerId = writtenLedgerIdOf(record);
      if (ledgerId === undefined) unnamed.push(record);
      else if (!this.#counted.has(ledgerId) && !ids.has(ledgerId)) {
        ids.add(ledgerId);
        fresh.push(record);
      }
    }
    if (isTakingIn) {
      this.#takenIn.push(...unnamed);
      return [...fresh, ...unnamed];
    }
    const notTakenIn = unrecordedOf(unnamed, this.#takenIn);
    this.#takenIn = [...unrecordedOf(this.#takenIn, unnamed)];
    return [...fresh, ...notTakenIn];
  }
}
