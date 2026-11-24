/**
 * #909 AC2: fencing stores whose cancel fence is broken the way a port to another database gets it
 * wrong — and the targets that build them. `cancel-sabotage.contract-fixture.ts` runs the contracts
 * and the explorer on each; `sabotage-cancel.test.ts` reads which cases and invariants bit.
 *
 * - no cancel check (`withoutCancelFence`): the stores of the core over a database whose lease rows
 *   read without their cancel mark (#1117) — a check that ignores the lease row's field, the fence
 *   reverted: a write after the cancel lands;
 * - a cancel read before the transaction (`CancelReadBeforeEffects`): the request is looked up
 *   first, then the work runs and the commit checks the lease again but not the request — a cancel
 *   that arrives while the write's transaction is open lands after it answered.
 */
import { effectKeyIdentityOf } from "../../../src/infrastructure/fenced-effect-key.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import {
  IdempotencyRunStatus,
  type EffectKey,
  type IdempotencyRunOutcome,
  type FencedEffectWork,
} from "../../../src/infrastructure/fenced-effect.repository.js";
import {
  InMemoryFencedEffectRepository,
  type InMemoryFencedEffectTransaction,
} from "../../../src/infrastructure/in-memory-fenced-effect.repository.js";
import {
  checkInMemoryCancel,
  type InMemoryDatabase,
} from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryOutboundCallRepository } from "../../../src/infrastructure/in-memory-outbound-call.repository.js";
import type {
  FencedEffectTarget,
  OutboundCallTarget,
} from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import type { InstanceSeam, StoreFactory } from "../../infrastructure/contracts/store-kinds.js";
import {
  BufferedTransaction,
  brokenEffects,
  CheckThenWriteEffects,
} from "./broken-fencing-stores.js";

/**
 * `database` as the fencing stores see it with no cancel mark on any lease row (#1117): a fence
 * check that ignores the lease row's mark — the fence reverted. The rows' lease state is read as
 * stored.
 */
const withoutCancels = (database: InMemoryDatabase): InMemoryDatabase =>
  new Proxy(database, {
    get: (target, property) => {
      if (property !== "executionLeases") return Reflect.get(target, property, target) as unknown;
      return new Proxy(target.executionLeases, {
        get: (leases, method) => {
          if (method === "get")
            return (key: string) => {
              const stored = leases.get(key);
              if (stored === undefined) return undefined;
              const { cancelRequestedAt: _ignored, ...read } = stored;
              return read;
            };
          const value = Reflect.get(leases, method, leases) as unknown;
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(leases)
            : value;
        },
      });
    },
  });

/** The in-memory fencing stores of the core with no cancel check: the leases write the real mark. */
export const withoutCancelFence = {
  effects: ((seam: InstanceSeam) => {
    const built = inMemoryFencedEffects(false)(seam);
    const leases = new InMemoryExecutionLeaseRepository(
      seam.storeClock,
      seam.application,
      seam.database,
    );
    return {
      ...built,
      effects: new InMemoryFencedEffectRepository(
        seam.storeClock,
        withoutCancels(seam.database),
        leases,
      ),
      leases,
    };
  }) satisfies StoreFactory<FencedEffectTarget<InMemoryFencedEffectTransaction>>,
  calls: ((seam: InstanceSeam) => {
    const leases = new InMemoryExecutionLeaseRepository(
      seam.storeClock,
      seam.application,
      seam.database,
    );
    return {
      calls: new InMemoryOutboundCallRepository(
        seam.storeClock,
        withoutCancels(seam.database),
        leases,
      ),
      leases,
    };
  }) satisfies StoreFactory<OutboundCallTarget>,
};

/**
 * A fenced-effect store that reads the cancel request before its transaction — with the lease and
 * the key, at its start — and not again at the commit: the cancel that arrives while the work runs
 * is missed, and the write lands after the cancel answered.
 */
export class CancelReadBeforeEffects extends CheckThenWriteEffects {
  protected override async runInTransaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<BufferedTransaction, TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    this.check(key);
    const found = this.results.get(effectKeyIdentityOf(key));
    if (found !== undefined) return this.replayOf(key, found);
    checkInMemoryCancel(this.seam.database, key);
    const transaction = new BufferedTransaction(false);
    const result = await work(transaction);
    this.check(key);
    const outcome = this.stored<TResult>(key, result);
    for (const write of transaction.writes) write();
    return { ...outcome, status: IdempotencyRunStatus.Ran };
  }
}

const cancelReadBeforeStores = brokenEffects(CancelReadBeforeEffects);

/** The same store with business rows that wait: the write's transaction is open across a turn. */
export const cancelReadBefore: StoreFactory<FencedEffectTarget<BufferedTransaction>> = (seam) => {
  const built = cancelReadBeforeStores(seam);
  return {
    ...built,
    rows: {
      ...built.rows,
      insert: async (transaction, row) => {
        await Promise.resolve();
        await built.rows.insert(transaction, row);
      },
    },
  };
};
