import type { BudgetScope } from "../budgets/budget.js";
import { Injectable } from "../components/decorators.js";
import { AGBossError } from "../core/errors.js";
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
  /** What the budget limits: an execution, a tenant or the application. */
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
  /**
   * Whether the store answers (#300): resolves when it is reachable, rejects with why not. One fast
   * round trip (`SELECT 1`, a `PING`), never a scan — `app.checkReadiness()` calls it under a
   * timeout of its own.
   */
  abstract ping(): Promise<void>;
  /** What the counter holds: the spend of its account in its period, `usd(0)` for a new one. */
  abstract findSpentByCounter(counter: CostCounter): Promise<Usd>;

  /**
   * Adds the cost of these model (and service) calls to every counter, atomically per counter. A
   * record with a `ledgerId` (#727) is an entry of its own: its cost is added once — a later save
   * of the same id, on any instance and also one that races it, adds nothing — and the entry is kept,
   * dated by its `madeAt` (#771), with the counters it was added to, in one atomic write. A record
   * without one is always added.
   *
   * An entry dated before the store's pruning mark (the latest cutoff of
   * `deleteEntriesByMadeAtBefore`) that the store does not hold may have been pruned after it was
   * counted: the save rejects with `CostLedgerEntryExpiredError` and adds nothing — never counted
   * again. The mark is read with the insert, atomically against a prune (#771).
   */
  abstract saveAll(
    counters: readonly CostCounter[],
    records: readonly UsageRecord[],
  ): Promise<void>;

  /**
   * Prunes the entries (#771): raises the store's pruning mark to `cutoff` (never lowers it) and
   * removes every entry dated (`madeAt`) before the mark, atomically against a save — from then on
   * a save of an id dated before the mark that the store does not hold rejects. The counters are
   * never touched. Called by the recovery sweep with `now − @Application({ retention: { costLedgerEntries } })`.
   */
  abstract deleteEntriesByMadeAtBefore(cutoff: Date): Promise<void>;

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

/**
 * When an entry was made, in ms since the epoch (#771): its record's `madeAt`; an entry without one
 * is dated at the epoch — the oldest, refused once anything was pruned.
 */
export const entryMadeAtOf = (record: UsageRecord): number =>
  record.madeAt === undefined ? 0 : Date.parse(record.madeAt);

/**
 * Of `records`, what a save adds (#727): every record without a `ledgerId`, and each one whose id
 * `isNew` keeps now — `isNew` inserts the id (made at `madeAt`, ms, #771) if absent and answers
 * whether it did, so an id asked twice, in one save too, counts once. A store asks inside the
 * transaction that adds the cost.
 */
export const newEntriesOf = (
  records: readonly UsageRecord[],
  isNew: (ledgerId: string, madeAt: number) => boolean,
): readonly UsageRecord[] =>
  records.filter(
    (record) => record.ledgerId === undefined || isNew(record.ledgerId, entryMadeAtOf(record)),
  );

/**
 * Of `records`, the ids a save must refuse (#771): entries made before the store's pruning mark
 * `prunedBefore` (ms) that it does not hold (`isHeld`) — each once. A store asks inside the
 * transaction that adds the cost, after reading the mark there.
 */
export function expiredEntriesOf(
  records: readonly UsageRecord[],
  prunedBefore: number,
  isHeld: (ledgerId: string) => boolean,
): readonly string[] {
  const expired = new Set<string>();
  for (const record of records) {
    const { ledgerId } = record;
    if (ledgerId !== undefined && entryMadeAtOf(record) < prunedBefore && !isHeld(ledgerId))
      expired.add(ledgerId);
  }
  return [...expired];
}

/** What a save refused (#771): the entries it does not hold dated before its pruning mark. */
export interface CostLedgerEntryExpiredErrorOptions {
  /** The refused entries' `ledgerId`s. */
  readonly ledgerIds: readonly string[];
  /** The store's pruning mark when it refused them. */
  readonly prunedBefore: Date;
}

/**
 * A save of an entry the ledger may have pruned (#771): dated before the store's pruning mark and
 * not held, so it may have been counted and removed since — counting it again could count it twice.
 * The save adds nothing; the pass's reads fail with it from then on (its spend is never counted
 * twice, and never read beside spend it cannot place). Only a write retried longer after its spend
 * was made than `@Application({ retention: { costLedgerEntries } })` meets it — a pass that slept that long.
 */
export class CostLedgerEntryExpiredError extends AGBossError {
  static override readonly code: string = "cost-ledger.entry-expired";
  override name = "CostLedgerEntryExpiredError";
  readonly ledgerIds: readonly string[];
  readonly prunedBefore: Date;

  constructor(options: CostLedgerEntryExpiredErrorOptions) {
    super(
      `the ledger may have pruned the entries ${options.ledgerIds.join(", ")}: made before its pruning mark ${options.prunedBefore.toISOString()} and not held, counting them again could count them twice — the save added nothing; keep entries longer with @Application({ retention: { costLedgerEntries } })`,
    );
    this.ledgerIds = options.ledgerIds;
    this.prunedBefore = options.prunedBefore;
  }
}

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
  /** Each entry's `ledgerId` and when it was made (ms). */
  readonly #entries = new Map<string, number>();
  /** The pruning mark (#771, ms): entries made before it were, or may have been, removed. */
  readonly #mark = { prunedBefore: Number.NEGATIVE_INFINITY };

  ping(): Promise<void> {
    return Promise.resolve();
  }

  findSpentByCounter(counter: CostCounter): Promise<Usd> {
    return Promise.resolve(usd(this.#spent.get(counterKeyOf(counter)) ?? 0));
  }

  saveAll(counters: readonly CostCounter[], records: readonly UsageRecord[]): Promise<void> {
    // nothing to add it to: no entry kept, so a later save of it counts (#727)
    if (counters.length === 0) return Promise.resolve();
    // an entry it may have pruned is refused, the whole save with it (#771)
    // Stryker disable next-line ArrowFunction: in memory no entry made before the mark is held — the prune that set it removed them, and no save keeps one — so "held" is never asked true
    const isHeld = (id: string): boolean => this.#entries.has(id);
    const expired = expiredEntriesOf(records, this.#mark.prunedBefore, isHeld);
    if (expired.length > 0) {
      const prunedBefore = new Date(this.#mark.prunedBefore);
      return Promise.reject(new CostLedgerEntryExpiredError({ ledgerIds: expired, prunedBefore }));
    }
    const spent = totalCost(newEntriesOf(records, (id, madeAt) => this.#isNewEntry(id, madeAt)));
    for (const counter of counters) {
      const key = counterKeyOf(counter);
      this.#spent.set(key, (this.#spent.get(key) ?? 0) + spent);
    }
    return Promise.resolve();
  }

  /** Whether `ledgerId` is new: kept from now on, made at `madeAt`. */
  #isNewEntry(ledgerId: string, madeAt: number): boolean {
    if (this.#entries.has(ledgerId)) return false;
    this.#entries.set(ledgerId, madeAt);
    return true;
  }

  deleteEntriesByMadeAtBefore(cutoff: Date): Promise<void> {
    this.#mark.prunedBefore = Math.max(this.#mark.prunedBefore, cutoff.getTime());
    for (const [ledgerId, madeAt] of this.#entries)
      if (madeAt < this.#mark.prunedBefore) this.#entries.delete(ledgerId);
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
