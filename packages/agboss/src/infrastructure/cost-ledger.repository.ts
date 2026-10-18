import type { BudgetScope } from "../budgets/budget.js";
import { Injectable } from "../components/decorators.js";
import { totalCost, type UsageRecord } from "../finops/usage.js";
import { usd, type Usd } from "../units/index.js";

/**
 * Infrastructure (#261, S28): where the spend of the application is counted for its budgets. One
 * per application, listed only in `@Application({ providers })`; the built-in default is in memory.
 * Your own `extends CostLedgerRepository`.
 */

/** Whose spend one budget counts: the budget, its scope and the scope's key. */
export interface BudgetAccount {
  /** The budget's `name` (`tenant-daily-budget`). */
  readonly budget: string;
  readonly scope: BudgetScope;
  /** The application's name, the `tenantId`, or the root execution's id. */
  readonly key: string;
}

/** One counter: an account's spend in one period. */
export interface CostCounter extends BudgetAccount {
  /**
   * The first UTC day of the period (`2026-10-12` for a week that starts on Monday the 12th);
   * empty for an execution budget, which has no period.
   */
  readonly period: string;
}

export abstract class CostLedgerRepository {
  /** What the counter holds: the spend of its account in its period, `usd(0)` for a new one. */
  abstract findSpentByCounter(counter: CostCounter): Promise<Usd>;

  /** Adds the cost of these model (and service) calls to every counter, atomically per counter. */
  abstract saveAll(counters: readonly CostCounter[], records: readonly UsageRecord[]): Promise<void>;

  /**
   * The `maxSpend()` an execution last read for the account — the last known limit, for a report
   * outside an execution (the framework never calls `maxSpend()` there); `undefined` when none did.
   */
  abstract findMaxSpendByAccount(account: BudgetAccount): Promise<Usd | undefined>;

  /** Keeps the `maxSpend()` an execution read for the account (the last one wins). */
  abstract saveMaxSpend(account: BudgetAccount, maxSpend: Usd): Promise<void>;
}

/** The row key of an account (`\u0000` never occurs in a name or an id). */
export const accountKeyOf = (account: BudgetAccount): string =>
  [account.budget, account.scope, account.key].join("\u0000");

/** The row key of a counter. */
export const counterKeyOf = (counter: CostCounter): string =>
  `${accountKeyOf(counter)}\u0000${counter.period}`;

/**
 * The built-in default: counters in memory — each application instance counts on its own and the
 * counters reset on restart. Never written to disk.
 */
@Injectable()
export class InMemoryCostLedgerRepository extends CostLedgerRepository {
  readonly #spent = new Map<string, number>();
  readonly #maxSpend = new Map<string, Usd>();

  findSpentByCounter(counter: CostCounter): Promise<Usd> {
    return Promise.resolve(usd(this.#spent.get(counterKeyOf(counter)) ?? 0));
  }

  saveAll(counters: readonly CostCounter[], records: readonly UsageRecord[]): Promise<void> {
    const spent = totalCost(records);
    for (const counter of counters) {
      const key = counterKeyOf(counter);
      this.#spent.set(key, (this.#spent.get(key) ?? 0) + spent);
    }
    return Promise.resolve();
  }

  findMaxSpendByAccount(account: BudgetAccount): Promise<Usd | undefined> {
    return Promise.resolve(this.#maxSpend.get(accountKeyOf(account)));
  }

  saveMaxSpend(account: BudgetAccount, maxSpend: Usd): Promise<void> {
    this.#maxSpend.set(accountKeyOf(account), maxSpend);
    return Promise.resolve();
  }
}
