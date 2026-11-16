import {
  InMemoryCostLedgerRepository,
  type CostCounter,
  type LedgerEntry,
} from "../../src/infrastructure/cost-ledger.repository.js";

/** #1231: the in-memory ledger, with the entries it was given and what each save charged. */
export class SeenLedger extends InMemoryCostLedgerRepository {
  readonly entries: LedgerEntry[] = [];
  /** What each save added to its budgets' counters (a save to no counter charges nothing). */
  readonly charged: number[] = [];

  override saveAll(
    counters: readonly CostCounter[],
    entries: readonly LedgerEntry[],
  ): Promise<void> {
    this.entries.push(...entries);
    if (counters.length > 0)
      this.charged.push(entries.reduce((sum, entry) => sum + entry.costUsd, 0));
    return super.saveAll(counters, entries);
  }
}
