import { isDate } from "node:util/types";
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

/**
 * One call's spend as the ledger keeps it (#727, #771, #817): its usage record with its identity in
 * the ledger — `ledgerId`, an id of the pass that made it — and the date it was made, `madeAt` (the
 * `Clock`), its cost in `Usd`. What `CostLedgerRepository.saveAll` takes: a record without an id
 * does not compile.
 */
export type LedgerEntry = UsageRecord & {
  /** The entry's identity: a save of an id the ledger holds adds nothing. */
  readonly ledgerId: string;
  /** When its spend was made: what the ledger prunes by (#771). */
  readonly madeAt: Date;
  /** What the call cost. */
  readonly costUsd: Usd;
};

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
   * Adds the cost of these entries to every counter, atomically per counter (#727, #817): each
   * entry is the spend of one call under its `ledgerId`, added once — a later save of the same id,
   * on any instance and also one that races it, adds nothing — and kept, dated by its `madeAt`
   * (#771), with the counters it was added to, in one atomic write. Only a `LedgerEntry` is taken:
   * a record without an id does not compile, and a JS caller's is refused
   * (`CostLedgerEntryInvalidError`, `assertLedgerEntries`) before anything is added.
   *
   * An entry dated before the store's pruning mark (the latest cutoff of `deleteByMadeAtBefore`)
   * that the store does not hold may have been pruned after it was counted: the save rejects with
   * `CostLedgerEntryExpiredError` and adds nothing — never counted again. The mark is read with the
   * insert, atomically against a prune (#771).
   */
  abstract saveAll(
    counters: readonly CostCounter[],
    entries: readonly LedgerEntry[],
  ): Promise<void>;

  /**
   * Prunes the entries (#771): raises the store's pruning mark to `cutoff` (never lowers it) and
   * removes every entry dated (`madeAt`) before the mark, atomically against a save — from then on
   * a save of an id dated before the mark that the store does not hold rejects. The counters are
   * never touched. Called by the recovery sweep with `now − @Application({ retention: { costLedgerEntries } })`.
   */
  abstract deleteByMadeAtBefore(cutoff: Date): Promise<void>;

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

/** Why `assertLedgerEntries` refused a save (#817): the entry's place in the save and what is wrong. */
export interface CostLedgerEntryInvalidErrorOptions {
  /** The entry's index in the save. */
  readonly index: number;
  /** What it lacks: `ledgerId`, `madeAt` or `costUsd`, and why. */
  readonly reason: string;
}

/**
 * A save handed something that is no `LedgerEntry` (#817): a record without a `ledgerId`, a valid
 * `madeAt` `Date` or a finite, non-negative `costUsd` — what a JS caller (or a cast) can pass. The
 * save adds nothing: spend without an identity could be counted on every retry.
 */
export class CostLedgerEntryInvalidError extends AGBossError {
  static override readonly code: string = "cost-ledger.entry-invalid";
  override name = "CostLedgerEntryInvalidError";
  readonly index: number;
  readonly reason: string;

  constructor(options: CostLedgerEntryInvalidErrorOptions) {
    super(
      `the ledger was handed no ledger entry at index ${String(options.index)}: ${options.reason} — the save added nothing; save only LedgerEntry values (an id, a madeAt Date, a costUsd in Usd)`,
    );
    this.index = options.index;
    this.reason = options.reason;
  }
}

/** What is wrong with `entry` as a `LedgerEntry`, or `undefined` when nothing is. */
function invalidityOf(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null) return "it is not an object";
  const ledgerId: unknown = Reflect.get(entry, "ledgerId");
  const madeAt: unknown = Reflect.get(entry, "madeAt");
  const costUsd: unknown = Reflect.get(entry, "costUsd");
  if (typeof ledgerId !== "string" || ledgerId === "") return "it has no ledgerId";
  // a Date of any realm (a driver's, a test's vm), never a string or a number of ms
  if (!isDate(madeAt) || Number.isNaN(madeAt.getTime()))
    return `its madeAt is no valid Date: ${String(madeAt)}`;
  if (!Number.isFinite(costUsd) || Number(costUsd) < 0)
    return `its costUsd is no finite amount ≥ 0: ${String(costUsd)}`;
  return undefined;
}

/** The refusal of a save of `entries` (#817): of the first that is no `LedgerEntry`, if any. */
export function invalidLedgerEntryErrorOf(
  entries: readonly unknown[],
): CostLedgerEntryInvalidError | undefined {
  for (const [index, entry] of entries.entries()) {
    const reason = invalidityOf(entry);
    if (reason !== undefined) return new CostLedgerEntryInvalidError({ index, reason });
  }
  return undefined;
}

/**
 * Refuses a save of anything but `LedgerEntry` values (#817) — what a store calls first in
 * `saveAll`, before it reads or writes anything: throws `CostLedgerEntryInvalidError` for the
 * first that lacks an id, a valid `madeAt` or a valid `costUsd`. The core only saves entries; a
 * JS caller (or a cast) is the one this stops.
 */
export function assertLedgerEntries(
  entries: readonly unknown[],
): asserts entries is readonly LedgerEntry[] {
  const refused = invalidLedgerEntryErrorOf(entries);
  if (refused !== undefined) throw refused;
}

/**
 * Throws `TypeError` unless `date` is a valid `Date` (#817): a cutoff or a mark that is no date
 * compares false with every entry — nothing pruned, nothing refused — so it is never taken.
 */
export function assertValidDate(date: unknown, what: string): asserts date is Date {
  const invalid = invalidDateErrorOf(date, what);
  if (invalid !== undefined) throw invalid;
}

/**
 * A prune handed a cutoff that is no valid `Date` (#817, #869): one compares false with every entry
 * and would lower the pruning mark, so it is refused — nothing pruned, the mark where it was. What
 * a JS caller (or a cast) can pass; every store refuses it with this code (`assertLedgerCutoff`).
 */
export class CostLedgerCutoffInvalidError extends AGBossError {
  static override readonly code: string = "cost-ledger.cutoff-invalid";
  override name = "CostLedgerCutoffInvalidError";
  /** What is wrong with the cutoff: `the cutoff is no valid Date: <what it got>`. */
  readonly reason: string;

  constructor(reason: string) {
    super(
      `the ledger was handed no valid Date as its prune's cutoff: ${reason} — nothing was pruned and the pruning mark stays where it was; prune with a valid Date`,
    );
    this.reason = reason;
  }
}

/**
 * Refuses a prune's cutoff that is no valid `Date` (#869) — what a store calls first in
 * `deleteByMadeAtBefore`, before it reads or writes anything: throws
 * `CostLedgerCutoffInvalidError`.
 */
export function assertLedgerCutoff(cutoff: unknown): asserts cutoff is Date {
  const refused = invalidLedgerCutoffErrorOf(cutoff);
  if (refused !== undefined) throw refused;
}

/** The refusal of a prune's `cutoff` (#869) when it is no valid `Date`, else `undefined`. */
export function invalidLedgerCutoffErrorOf(
  cutoff: unknown,
): CostLedgerCutoffInvalidError | undefined {
  const invalid = invalidDateErrorOf(cutoff, "the cutoff");
  return invalid === undefined ? undefined : new CostLedgerCutoffInvalidError(invalid.message);
}

/** The refusal of `date` as `what` (#817) when it is no valid `Date`, else `undefined`. */
export function invalidDateErrorOf(date: unknown, what: string): TypeError | undefined {
  return isDate(date) && !Number.isNaN(date.getTime())
    ? undefined
    : new TypeError(`${what} is no valid Date: ${String(date)}`);
}

/**
 * Of `entries`, what a save adds (#727): each one whose id `isNew` keeps now — `isNew` inserts the
 * id (made at `madeAt`, #771) if absent and answers whether it did, so an id asked twice, in one
 * save too, counts once. A store asks inside the transaction that adds the cost, after
 * `assertLedgerEntries` and `expiredEntriesOf`.
 */
export const unrecordedEntriesOf = (
  entries: readonly LedgerEntry[],
  isNew: (ledgerId: string, madeAt: Date) => boolean,
): readonly LedgerEntry[] => entries.filter((entry) => isNew(entry.ledgerId, entry.madeAt));

/**
 * Of `entries`, the ids a save must refuse (#771): entries made before the store's pruning mark
 * `prunedBefore` (`undefined`: nothing pruned yet) that it does not hold (`isHeld`) — each once. A
 * store asks inside the transaction that adds the cost, after reading the mark there.
 */
export function expiredEntriesOf(
  entries: readonly LedgerEntry[],
  prunedBefore: Date | undefined,
  isHeld: (ledgerId: string) => boolean,
): readonly string[] {
  if (prunedBefore === undefined) return [];
  // a mark that is no date refuses nothing by comparison: it fails closed instead
  assertValidDate(prunedBefore, "the pruning mark");
  const expired = new Set<string>();
  for (const { ledgerId, madeAt } of entries)
    if (madeAt.getTime() < prunedBefore.getTime() && !isHeld(ledgerId)) expired.add(ledgerId);
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
  /** Each entry's `ledgerId` and when it was made, in ms (kept as a number: no caller's `Date`). */
  readonly #entries = new Map<string, number>();
  /** The pruning mark (#771), in ms: entries made before it were, or may have been, removed. */
  readonly #mark = { prunedBefore: Number.NEGATIVE_INFINITY };

  ping(): Promise<void> {
    return Promise.resolve();
  }

  findSpentByCounter(counter: CostCounter): Promise<Usd> {
    return Promise.resolve(usd(this.#spent.get(counterKeyOf(counter)) ?? 0));
  }

  saveAll(counters: readonly CostCounter[], entries: readonly LedgerEntry[]): Promise<void> {
    // a JS caller's record without an identity is refused before anything (#817)
    const invalid = invalidLedgerEntryErrorOf(entries);
    if (invalid !== undefined) return Promise.reject(invalid);
    // nothing to add it to: no entry kept, so a later save of it counts (#727)
    if (counters.length === 0) return Promise.resolve();
    // an entry it may have pruned is refused, the whole save with it (#771)
    // Stryker disable next-line ArrowFunction: in memory no entry made before the mark is held — the prune that set it removed them, and no save keeps one — so "held" is never asked true
    const isHeld = (id: string): boolean => this.#entries.has(id);
    const { prunedBefore } = this.#mark;
    const mark = Number.isFinite(prunedBefore) ? new Date(prunedBefore) : undefined;
    const expired = expiredEntriesOf(entries, mark, isHeld);
    // Stryker disable next-line ConditionalExpression: an expired entry needs a mark — `expiredEntriesOf` names none without one; the check only narrows its type
    if (expired.length > 0 && mark !== undefined)
      return Promise.reject(
        new CostLedgerEntryExpiredError({ ledgerIds: expired, prunedBefore: mark }),
      );
    const spent = totalCost(
      unrecordedEntriesOf(entries, (id, madeAt) => this.#isNewEntry(id, madeAt.getTime())),
    );
    for (const counter of counters) {
      const key = counterKeyOf(counter);
      this.#spent.set(key, (this.#spent.get(key) ?? 0) + spent);
    }
    return Promise.resolve();
  }

  /** Whether `ledgerId` is new: kept from now on, made at `madeAt` (ms). */
  #isNewEntry(ledgerId: string, madeAt: number): boolean {
    if (this.#entries.has(ledgerId)) return false;
    this.#entries.set(ledgerId, madeAt);
    return true;
  }

  deleteByMadeAtBefore(cutoff: Date): Promise<void> {
    // a cutoff that is no date would lower the mark: refused with the ledger's code (#817, #869)
    const refused = invalidLedgerCutoffErrorOf(cutoff);
    if (refused !== undefined) return Promise.reject(refused);
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
