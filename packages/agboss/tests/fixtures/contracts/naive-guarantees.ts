/**
 * Naive stores behind the payment-grade guarantees (#508, #505, #483 acceptance): each breaks one
 * guarantee the way a hand-written store would, so the published suites are shown to bite —
 * `naive-guarantees.contract-fixture.ts` runs them, `guarantees-sabotage.test.ts` reads the failures.
 */
import {
  accountKeyOf,
  assertLedgerEntries,
  CostLedgerEntryExpiredError,
  CostLedgerRepository,
  counterKeyOf,
  expiredEntriesOf,
  invalidLedgerEntryErrorOf,
  unrecordedEntriesOf,
  type BudgetAccount,
  type CostCounter,
  type LedgerEntry,
} from "../../../src/infrastructure/cost-ledger.repository.js";
import { totalCost } from "../../../src/finops/usage.js";
import {
  treeKeyOf,
  type InMemoryDatabase,
} from "../../../src/infrastructure/in-memory-database.js";
import {
  InMemoryMeshRequestRepository,
  type MeshRequestRecord,
} from "../../../src/infrastructure/mesh-request.repository.js";
import { InMemoryRateLimitRepository } from "../../../src/infrastructure/rate-limit.repository.js";
import { usd, type Milliseconds, type Usd } from "../../../src/units/index.js";
import type { EffectKeyFields } from "../../../src/index.js";
import { effectKeyForTesting } from "../../../src/testing/contracts/effect-key.js";

/** A key as a naive store rewrites it before passing it on. */
export type KeyRewrite = (key: Record<string, unknown>, database: InMemoryDatabase) => object;

/** Keyed by the step only: the business identity dropped, so two executions are two rows. */
export const stepOnly: KeyRewrite = (key) => {
  const { businessKey: _key, fingerprint: _print, businessKeyHash: _hash, ...rest } = key;
  return rest;
};

/** Trusts whoever holds the lease now: the caller's token replaced by the lease's current one. */
export const currentToken: KeyRewrite = (key, database) => {
  const tenantId = String(key.tenantId);
  const row = database.executionLeases.get(treeKeyOf(tenantId, String(key.leaseExecutionId)));
  return row === undefined ? key : { ...key, token: row.lease.leaseEpoch };
};

const isKey = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && "scopeKey" in value && "token" in value;

/** `store` with every key argument of every call rewritten by `rewrite`. */
export function rewritingKeys<TStore extends object>(
  store: TStore,
  database: InMemoryDatabase,
  rewrite: KeyRewrite,
): TStore {
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown =>
        Reflect.apply(
          value,
          target,
          // the rewritten key issued as the store's own (#825): refused for what it says, never as a copy
          args.map((arg) =>
            isKey(arg) ? effectKeyForTesting(rewrite(arg, database) as EffectKeyFields) : arg,
          ),
        );
    },
  });
}

/** A rate limit store that never counts: every acquire gets a slot, whatever `maxSlots` says. */
export class UncountedRateLimitRepository extends InMemoryRateLimitRepository {
  override acquire(
    key: string,
    _maxSlots: number,
    lease: Milliseconds,
  ): ReturnType<InMemoryRateLimitRepository["acquire"]> {
    return super.acquire(key, Number.MAX_SAFE_INTEGER, lease);
  }
}

/** A mesh store that looks first, then writes: two retries at once are both admitted. */
export class LookThenWriteMeshRequestRepository extends InMemoryMeshRequestRepository {
  override async saveIfAbsent(record: MeshRequestRecord): Promise<boolean> {
    if ((await this.findByKey(record)) !== undefined) return false;
    await new Promise((resolve) => setImmediate(resolve));
    await super.saveIfAbsent(record);
    return true;
  }
}

/** A ledger that reads, waits a round trip, then writes: concurrent saves lose updates. */
export class ReadThenWriteCostLedgerRepository extends CostLedgerRepository {
  readonly #spent = new Map<string, number>();
  readonly #maxSpend = new Map<string, Usd>();

  ping(): Promise<void> {
    return Promise.resolve();
  }

  findSpentByCounter(counter: CostCounter): Promise<Usd> {
    return Promise.resolve(usd(this.#spent.get(counterKeyOf(counter)) ?? 0));
  }

  async saveAll(counters: readonly CostCounter[], records: readonly LedgerEntry[]): Promise<void> {
    assertLedgerEntries(records);
    for (const counter of counters) {
      const key = counterKeyOf(counter);
      const before = this.#spent.get(key) ?? 0;
      await new Promise((resolve) => setImmediate(resolve));
      this.#spent.set(key, before + totalCost(records));
    }
  }

  deleteByMadeAtBefore(): Promise<void> {
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

/**
 * A ledger that prunes its entries without a mark (#771): a save of an entry it removed counts it
 * again — a lost answer retried after the prune is counted twice.
 */
export class PrunedWithoutMarkCostLedgerRepository extends CostLedgerRepository {
  readonly #spent = new Map<string, number>();
  readonly #entries = new Map<string, Date>();

  ping(): Promise<void> {
    return Promise.resolve();
  }

  findSpentByCounter(counter: CostCounter): Promise<Usd> {
    return Promise.resolve(usd(this.#spent.get(counterKeyOf(counter)) ?? 0));
  }

  saveAll(counters: readonly CostCounter[], records: readonly LedgerEntry[]): Promise<void> {
    const invalid = invalidLedgerEntryErrorOf(records);
    if (invalid !== undefined) return Promise.reject(invalid);
    if (counters.length === 0) return Promise.resolve();
    const added = unrecordedEntriesOf(records, (id, madeAt) => {
      if (this.#entries.has(id)) return false;
      this.#entries.set(id, madeAt);
      return true;
    });
    for (const counter of counters) {
      const key = counterKeyOf(counter);
      this.#spent.set(key, (this.#spent.get(key) ?? 0) + totalCost(added));
    }
    return Promise.resolve();
  }

  deleteByMadeAtBefore(cutoff: Date): Promise<void> {
    for (const [id, madeAt] of this.#entries)
      if (madeAt.getTime() < cutoff.getTime()) this.#entries.delete(id);
    return Promise.resolve();
  }

  findMaxSpendByAccount(): Promise<Usd | undefined> {
    return Promise.resolve(undefined);
  }

  saveMaxSpend(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * An in-memory ledger with a mark, built to be broken one way (#817): `isChecked` whether it refuses
 * what is no ledger entry, `markOf` what it keeps as its mark for a cutoff (it prunes by the cutoff).
 */
abstract class BreakableCostLedger extends CostLedgerRepository {
  readonly #spent = new Map<string, number>();
  readonly #entries = new Map<string, Date>();
  readonly #maxSpend = new Map<string, Usd>();
  #prunedBefore: Date | undefined;
  protected abstract readonly isChecked: boolean;
  /** Whether it refuses a cutoff that is no date. */
  protected readonly isCutoffChecked: boolean = true;

  protected markOf(cutoff: Date): Date {
    return cutoff;
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  findSpentByCounter(counter: CostCounter): Promise<Usd> {
    return Promise.resolve(usd(this.#spent.get(counterKeyOf(counter)) ?? 0));
  }

  saveAll(counters: readonly CostCounter[], records: readonly LedgerEntry[]): Promise<void> {
    const invalid = this.isChecked ? invalidLedgerEntryErrorOf(records) : undefined;
    if (invalid !== undefined) return Promise.reject(invalid);
    if (counters.length === 0) return Promise.resolve();
    // without the check: a record without an id is added on every save, the contract of before
    const named = records.filter((record) => typeof record.ledgerId === "string");
    const expired = expiredEntriesOf(named, this.#prunedBefore, (id) => this.#entries.has(id));
    if (expired.length > 0 && this.#prunedBefore !== undefined)
      return Promise.reject(
        new CostLedgerEntryExpiredError({ ledgerIds: expired, prunedBefore: this.#prunedBefore }),
      );
    const spent = this.#addedOf(records);
    for (const counter of counters) {
      const key = counterKeyOf(counter);
      this.#spent.set(key, (this.#spent.get(key) ?? 0) + spent);
    }
    return Promise.resolve();
  }

  /** What a save adds: a record without an id every time, an entry once. */
  #addedOf(records: readonly LedgerEntry[]): number {
    let spent = 0;
    for (const record of records) {
      const { ledgerId } = record;
      if (typeof ledgerId !== "string") spent += record.costUsd;
      else if (!this.#entries.has(ledgerId)) {
        this.#entries.set(ledgerId, record.madeAt);
        spent += record.costUsd;
      }
    }
    return spent;
  }

  deleteByMadeAtBefore(cutoff: Date): Promise<void> {
    if (this.isCutoffChecked && Number.isNaN(new Date(cutoff).getTime()))
      return Promise.reject(new TypeError("the cutoff is no valid Date"));
    if (this.isCutoffChecked && !(cutoff instanceof Date))
      return Promise.reject(new TypeError("the cutoff is no Date"));
    const mark = this.markOf(cutoff);
    const kept = this.#prunedBefore;
    this.#prunedBefore = kept !== undefined && kept.getTime() > mark.getTime() ? kept : mark;
    for (const [id, madeAt] of this.#entries)
      if (madeAt.getTime() < cutoff.getTime()) this.#entries.delete(id);
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

/**
 * A ledger that takes whatever it is handed (#817): a record without a `ledgerId` is added on every
 * save — the contract of before, fail-open for a JS caller.
 */
export class UncheckedCostLedgerRepository extends BreakableCostLedger {
  protected readonly isChecked = false;
}

/**
 * A ledger that keeps its pruning mark in whole seconds (a `timestamp(0)` column) while it prunes
 * by the cutoff itself (#817): an entry made in the cutoff's last second is pruned, yet no longer
 * before the mark — a retry of it counts again.
 */
export class SecondsMarkCostLedgerRepository extends BreakableCostLedger {
  protected readonly isChecked = true;

  protected override markOf(cutoff: Date): Date {
    return new Date(Math.floor(cutoff.getTime() / 1000) * 1000);
  }
}

/**
 * A ledger that takes any cutoff (#817): one that is no date compares false with every entry — the
 * mark goes to it, nothing is refused from then on, and a retry of a pruned entry counts again.
 */
export class AnyCutoffCostLedgerRepository extends BreakableCostLedger {
  protected readonly isChecked = true;
  protected override readonly isCutoffChecked = false;
}
