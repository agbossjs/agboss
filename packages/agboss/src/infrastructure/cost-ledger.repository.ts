import { Injectable } from "../components/decorators.js";
import { utcDay, type SpendLedger } from "../finops/ledger.js";
import type { UsageRecord } from "../finops/usage.js";
import { INFRASTRUCTURE_CLOCK } from "./clock.js";

/**
 * Infrastructure (#261, S28): where the spend of the application is counted, per key (a workflow
 * today, a budget + its scope key + period with the runtime budgets) and per UTC day. One per
 * application, listed only in `@Application({ providers })`; the built-in default is in memory.
 * Your own `extends CostLedgerRepository`.
 */
export abstract class CostLedgerRepository {
  /** The USD spent under `key` on the current UTC day (the counter resets at 00:00 UTC). */
  abstract findSpentToday(key: string): Promise<number>;

  /** Adds the cost of these model (and service) calls to `key`'s current UTC day. */
  abstract saveAll(key: string, records: readonly UsageRecord[]): Promise<void>;
}

/**
 * The built-in default: counters in memory — each application instance counts on its own and the
 * counters reset on restart. Never written to disk.
 */
@Injectable({ deps: [INFRASTRUCTURE_CLOCK] })
export class InMemoryCostLedgerRepository extends CostLedgerRepository {
  readonly #days = new Map<string, number>();

  constructor(private readonly now: () => Date) {
    super();
  }

  #keyOf(key: string): string {
    return `${key}/${utcDay(this.now())}`;
  }

  findSpentToday(key: string): Promise<number> {
    return Promise.resolve(this.#days.get(this.#keyOf(key)) ?? 0);
  }

  saveAll(key: string, records: readonly UsageRecord[]): Promise<void> {
    const day = this.#keyOf(key);
    const spent = records.reduce((sum, record) => sum + record.costUsd, 0);
    this.#days.set(day, (this.#days.get(day) ?? 0) + spent);
    return Promise.resolve();
  }
}

/** The ledger the runtime reads, over the application's repository (one per repository). */
const ledgers = new WeakMap<CostLedgerRepository, SpendLedger>();

export function spendLedgerOf(repository: CostLedgerRepository): SpendLedger {
  const existing = ledgers.get(repository);
  if (existing !== undefined) return existing;
  const ledger: SpendLedger = {
    spentToday: (key) => repository.findSpentToday(key),
    record: (key, records) => repository.saveAll(key, records),
  };
  ledgers.set(repository, ledger);
  return ledger;
}
