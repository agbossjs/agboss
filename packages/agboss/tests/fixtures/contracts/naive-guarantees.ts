/**
 * Naive stores behind the payment-grade guarantees (#508, #505, #483 acceptance): each breaks one
 * guarantee the way a hand-written store would, so the published suites are shown to bite —
 * `naive-guarantees.contract-fixture.ts` runs them, `guarantees-bite.test.ts` reads the failures.
 */
import {
  accountKeyOf,
  CostLedgerRepository,
  counterKeyOf,
  type BudgetAccount,
  type CostCounter,
} from "../../../src/infrastructure/cost-ledger.repository.js";
import { totalCost, type UsageRecord } from "../../../src/finops/usage.js";
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
          args.map((arg) => (isKey(arg) ? rewrite(arg, database) : arg)),
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

  async saveAll(counters: readonly CostCounter[], records: readonly UsageRecord[]): Promise<void> {
    for (const counter of counters) {
      const key = counterKeyOf(counter);
      const before = this.#spent.get(key) ?? 0;
      await new Promise((resolve) => setImmediate(resolve));
      this.#spent.set(key, before + totalCost(records));
    }
  }

  findMaxSpendByAccount(account: BudgetAccount): Promise<Usd | undefined> {
    return Promise.resolve(this.#maxSpend.get(accountKeyOf(account)));
  }

  saveMaxSpend(account: BudgetAccount, maxSpend: Usd): Promise<void> {
    this.#maxSpend.set(accountKeyOf(account), maxSpend);
    return Promise.resolve();
  }
}
