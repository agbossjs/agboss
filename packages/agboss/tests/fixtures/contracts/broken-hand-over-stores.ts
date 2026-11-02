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
  fencedKeyIdentityOf,
  replayedFromOf,
  storedKeyFactsOf,
} from "../../../src/infrastructure/fenced-effect-key.js";
import { FencedEffectSettings } from "../../../src/infrastructure/fenced-effect-settings.js";
import {
  FencedEffectRepository,
  FencedEffectStatus,
  type FencedEffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
} from "../../../src/infrastructure/fenced-effect.repository.js";
import {
  checkInMemoryFence,
  raiseInMemoryMark,
} from "../../../src/infrastructure/in-memory-fenced-effect.repository.js";
import type { FencedEffectStores } from "../../../src/testing/contracts/index.js";
import {
  sharedInMemory,
  type InstanceSeam,
  type StoreFactory,
} from "../../infrastructure/contracts/store-kinds.js";

/** Its transaction: the business rows, applied at the commit. */
export class DeferredTransaction {
  readonly writes: (() => void)[] = [];
}

interface Stored {
  readonly token: number;
  readonly storedAt: number;
  readonly result: string;
  readonly fingerprint?: string;
  readonly origin?: unknown;
}

/** The tail of each lock's queue: one transaction at a time per scope or business key. */
const queues = new WeakMap<object, Map<string, Promise<unknown>>>();

export class UnlockedCheckEffects extends FencedEffectRepository<DeferredTransaction> {
  static override readonly backend: string | undefined = "in-memory";

  constructor(
    private readonly seam: InstanceSeam,
    private readonly results: Map<string, Stored>,
  ) {
    super(new FencedEffectSettings());
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  deleteByStoredAtBefore(cutoff: Date): Promise<void> {
    for (const [row, stored] of this.results)
      if (stored.storedAt < cutoff.getTime()) this.results.delete(row);
    return Promise.resolve();
  }

  protected runInTransaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<DeferredTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    const lock = key.businessKey === undefined ? key.scopeKey : fencedKeyIdentityOf(key);
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
    key: FencedEffectKey,
    work: FencedEffectWork<DeferredTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    // the lease checked once, before the work — a read that locks nothing
    checkInMemoryFence(this.seam.database, this.seam.storeClock, key);
    raiseInMemoryMark(this.seam.database, this.seam.storeClock, key);
    const row = fencedKeyIdentityOf(key);
    const found = this.results.get(row);
    if (found !== undefined) {
      const replayedFrom = replayedFromOf(key, found);
      return {
        status: FencedEffectStatus.Replayed,
        result: JSON.parse(found.result) as TResult,
        token: found.token,
        ...(replayedFrom === undefined ? {} : { replayedFrom }),
      };
    }
    const transaction = new DeferredTransaction();
    const text = this.storedResultOf(key, await work(transaction));
    // the commit: nothing checked again
    const storedAt = this.seam.storeClock.now().getTime();
    this.results.set(row, { token: key.token, storedAt, result: text, ...storedKeyFactsOf(key) });
    for (const write of transaction.writes) write();
    return {
      status: FencedEffectStatus.Ran,
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }
}

/** The store set of one instance on the unlocked-check effects, its rows inserted asynchronously. */
export const unlockedCheckEffects: StoreFactory<FencedEffectStores<DeferredTransaction>> = (
  seam,
) => {
  const committed = sharedInMemory(seam, "unlocked-rows", (): string[] => []);
  return {
    effects: new UnlockedCheckEffects(
      seam,
      sharedInMemory(seam, "unlocked-results", () => new Map()),
    ),
    leases: new InMemoryExecutionLeaseRepository(seam.storeClock, seam.application, seam.database),
    rows: {
      insert: async (transaction, row) => {
        await Promise.resolve();
        transaction.writes.push(() => committed.push(row));
      },
      committed: () => Promise.resolve([...committed]),
    },
  };
};
