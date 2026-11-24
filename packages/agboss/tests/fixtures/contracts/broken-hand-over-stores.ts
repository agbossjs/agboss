import type { StoreDescriptor } from "../../../src/infrastructure/execution-lease.repository.js";
/**
 * A fenced-effect store whose lease check takes no lock and is not made again at its commit
 * (#695) — the way a port to a database whose transactions read without locking (MongoDB: a read
 * in a transaction locks nothing) gets it wrong. Its calls on one lease scope or business key are
 * serialized, its result is one row per key, so the zombie's race of the same key passes; only a
 * hand-over **while** its work runs — the new holder writing nothing — shows the write landing after
 * the take. Its work may wait (its rows' insert is asynchronous).
 */
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import {
  effectKeyIdentityOf,
  replayedFromOf,
  storedKeyFactsOf,
} from "../../../src/infrastructure/fenced-effect-key.js";
import {
  FencedEffectRepository,
  IdempotencyRunStatus,
  type EffectKey,
  type IdempotencyRunOutcome,
  type FencedEffectWork,
} from "../../../src/infrastructure/fenced-effect.repository.js";
import {
  checkInMemoryFence,
  raiseInMemoryMark,
} from "../../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { checkInMemoryCancel } from "../../../src/infrastructure/in-memory-database.js";
import type { FencedEffectTarget } from "../../../src/testing/contracts/index.js";
import {
  sharedInMemory,
  type InstanceSeam,
  type StoreFactory,
} from "../../infrastructure/contracts/store-kinds.js";

/** Its transaction: the business rows, applied at the commit. */
export class DeferredTransaction {
  readonly writes: (() => void)[] = [];
}

export interface Stored {
  readonly token: number;
  readonly storedAt: number;
  readonly expiresAt: number | null;
  readonly result: string;
  readonly fingerprint?: string;
  readonly origin?: unknown;
}

/** The tail of each lock's queue: one transaction at a time per scope or business key. */
const queues = new WeakMap<object, Map<string, Promise<unknown>>>();

export class UnlockedCheckEffects extends FencedEffectRepository<DeferredTransaction> {
  static override readonly store: StoreDescriptor = { backend: "in-memory" };

  constructor(
    private readonly seam: InstanceSeam,
    private readonly results: Map<string, Stored>,
  ) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  deleteExpired(now: Date): Promise<number> {
    let removed = 0;
    for (const [row, stored] of this.results)
      if (stored.expiresAt !== null && stored.expiresAt <= now.getTime()) {
        this.results.delete(row);
        removed += 1;
      }
    return Promise.resolve(removed);
  }

  protected runInTransaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<DeferredTransaction, TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    const lock = key.businessKey === undefined ? key.scopeKey : effectKeyIdentityOf(key);
    const tails = queues.get(this.results) ?? new Map<string, Promise<unknown>>();
    queues.set(this.results, tails);
    const call = Promise.allSettled([tails.get(lock)]).then(() => this.#transaction(key, work));
    tails.set(
      lock,
      call.catch(() => undefined),
    );
    return call;
  }

  async #transaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<DeferredTransaction, TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    // the lease checked once, before the work — a read that locks nothing
    checkInMemoryFence(this.seam.database, this.seam.storeClock, key);
    raiseInMemoryMark(this.seam.database, this.seam.storeClock, key);
    const row = effectKeyIdentityOf(key);
    const found = this.results.get(row);
    if (found !== undefined) {
      const replayedFrom = replayedFromOf(key, found);
      return {
        status: IdempotencyRunStatus.Replayed,
        result: JSON.parse(found.result) as TResult,
        token: found.token,
        ...(replayedFrom === undefined ? {} : { replayedFrom }),
      };
    }
    checkInMemoryCancel(this.seam.database, key); // #909: the cancel is checked as the real store does
    const transaction = new DeferredTransaction();
    const text = this.storedResultOf(key, await work(transaction));
    // the commit: the lease is not checked again (the cancel is, #909: this store breaks the lease's lock only)
    checkInMemoryCancel(this.seam.database, key);
    const storedAt = this.seam.storeClock.now().getTime();
    this.results.set(row, {
      token: key.token,
      storedAt,
      expiresAt: key.expiresAt?.getTime() ?? null,
      result: text,
      ...storedKeyFactsOf(key),
    });
    for (const write of transaction.writes) write();
    return {
      status: IdempotencyRunStatus.Ran,
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }
}

/** The business rows both instances of a case share, inserted asynchronously, applied at the commit. */
export const unlockedRowsOf = (
  seam: InstanceSeam,
): FencedEffectTarget<DeferredTransaction>["rows"] => {
  const committed = sharedInMemory(seam, "unlocked-rows", (): string[] => []);
  return {
    insert: async (transaction, row) => {
      await Promise.resolve();
      transaction.writes.push(() => committed.push(row));
    },
    committed: () => Promise.resolve([...committed]),
  };
};

/** The results both instances share, one row per key. */
export const unlockedResultsOf = (seam: InstanceSeam): Map<string, Stored> =>
  sharedInMemory<Map<string, Stored>>(seam, "unlocked-results", () => new Map());

/** The store set of one instance on the unlocked-check effects, its rows inserted asynchronously. */
export const unlockedCheckEffects: StoreFactory<FencedEffectTarget<DeferredTransaction>> = (
  seam,
) => ({
  effects: new UnlockedCheckEffects(seam, unlockedResultsOf(seam)),
  leases: new InMemoryExecutionLeaseRepository(seam.storeClock, seam.application, seam.database),
  rows: unlockedRowsOf(seam),
});
