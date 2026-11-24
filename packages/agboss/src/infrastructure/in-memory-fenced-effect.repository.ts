import { storeMismatch } from "./idempotency-errors.js";
import { IdempotencyError } from "../core/error-families/effect-errors.js";
import type { StoreDescriptor } from "./execution-lease.repository.js";
import { ExecutionFencedError } from "../app/lease-lost.js";
import { Injectable } from "../components/decorators.js";
import { StoreClock, type Clock } from "./clock.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
} from "./execution-lease.repository.js";
import {
  FencedEffectRepository,
  IdempotencyRunStatus,
  type EffectKey,
  type IdempotencyRunOutcome,
  type FencedEffectWork,
} from "./fenced-effect.repository.js";
import {
  assertBusinessKey,
  assertEffectName,
  effectKeyIdentityOf,
  replayedFromOf,
  storedKeyFactsOf,
} from "./fenced-effect-key.js";
import {
  checkInMemoryCancel,
  IN_MEMORY_DATABASE,
  prunedFencedBefore,
  treeKeyOf,
  type InMemoryDatabase,
} from "./in-memory-database.js";
import { assertFingerprintDecided } from "./fenced-effect-fingerprint.js";

/** Applies a committed transaction's writes, in order (module-private: only the store commits). */
let applyWrites: (transaction: InMemoryFencedEffectTransaction) => void;

/**
 * The transaction of an in-memory fenced effect (#500): a write buffer — what `onCommit` is given
 * runs once the effect's result is stored, in order, and never when the work throws.
 */
export class InMemoryFencedEffectTransaction {
  readonly #writes: (() => void)[] = [];

  static {
    applyWrites = (transaction) => {
      for (const write of transaction.#writes) write();
    };
  }

  /** Applies `write` (a business row of the effect) when the transaction commits. */
  onCommit(write: () => void): void {
    this.#writes.push(write);
  }
}

/**
 * The built-in default (#500): marks and results in the instance's `InMemoryDatabase` beside the
 * in-memory leases it checks — the instances of one test share them. One transaction at a time per
 * lease scope; the lease and the mark are checked again at commit, so a lease taken over while an
 * asynchronous `work` ran refuses its write.
 */
@Injectable({
  deps: [StoreClock, IN_MEMORY_DATABASE, ExecutionLeaseRepository],
})
export class InMemoryFencedEffectRepository extends FencedEffectRepository<InMemoryFencedEffectTransaction> {
  static override readonly store: StoreDescriptor = { backend: "in-memory" };

  /**
   * @internal The container injects the instance's in-memory database: left out of the declarations.
   */
  constructor(
    private readonly clock: Pick<StoreClock, "now">,
    private readonly database: InMemoryDatabase,
    private readonly leases: ExecutionLeaseRepository,
  ) {
    super();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  protected runInTransaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<InMemoryFencedEffectTransaction, TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    const mismatch = inMemoryLeaseMismatch(this, this.leases);
    if (mismatch !== undefined) return Promise.reject(mismatch);
    // a business key is one row for every scope of the tenant: its transactions in turn too (#508)
    const lock = key.businessKey === undefined ? key.scopeKey : effectKeyIdentityOf(key);
    return this.#serialized(lock, () => this.#transaction(key, work));
  }

  deleteByStoredAtBefore(cutoff: Date): Promise<void> {
    prunedFencedBefore(this.database, cutoff.getTime());
    return Promise.resolve();
  }

  async #transaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<InMemoryFencedEffectTransaction, TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    checkInMemoryFence(this.database, this.clock, key);
    const stored = this.database.fencedEffectResults.get(effectKeyIdentityOf(key));
    if (stored !== undefined) {
      const replayedFrom = replayedFromOf(key, stored);
      raiseInMemoryMark(this.database, this.clock, key);
      const result = JSON.parse(stored.result) as TResult;
      return {
        status: IdempotencyRunStatus.Replayed,
        result,
        token: stored.token,
        ...(replayedFrom === undefined ? {} : { replayedFrom }),
      };
    }
    // #909: no stored result — a new effect after a durable cancel is refused, the work not run
    checkInMemoryCancel(this.database, key);
    const transaction = new InMemoryFencedEffectTransaction();
    const text = this.storedResultOf(key, await work(transaction));
    // the lease may have moved, or the cancel arrived, while the work ran: checked again before
    // anything is applied
    checkInMemoryFence(this.database, this.clock, key);
    checkInMemoryCancel(this.database, key);
    raiseInMemoryMark(this.database, this.clock, key);
    const storedAt = this.clock.now().getTime();
    const row = {
      scopeKey: key.scopeKey,
      token: key.token,
      storedAt,
      result: text,
      ...storedKeyFactsOf(key),
    };
    this.database.fencedEffectResults.set(effectKeyIdentityOf(key), row);
    applyWrites(transaction);
    return {
      status: IdempotencyRunStatus.Ran,
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }

  /** `run` after every earlier transaction of the scope settled: one at a time per scope. */
  #serialized<TValue>(scopeKey: string, run: () => Promise<TValue>): Promise<TValue> {
    const locks = this.database.fencedEffectLocks;
    const current = (locks.get(scopeKey) ?? Promise.resolve()).then(run);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    locks.set(scopeKey, tail);
    void tail.then(() => {
      if (locks.get(scopeKey) === tail) locks.delete(scopeKey);
    });
    return current;
  }
}

/**
 * The fencing checks of the in-memory stores (#500, #505): the key's name is valid (#508), its lease
 * is held, not expired and its epoch, and no newer token wrote the scope — else
 * `ExecutionFencedError`, a hand-over.
 */
export function checkInMemoryFence(
  database: InMemoryDatabase,
  clock: Pick<Clock, "now">,
  key: EffectKey,
): void {
  assertEffectName(key.name);
  assertBusinessKey(key);
  // #825: in the transaction every store of the core runs, whatever its entry was overridden with
  assertFingerprintDecided(key);
  const { scopeKey, token } = key;
  const row = database.executionLeases.get(treeKeyOf(key.tenantId, key.leaseExecutionId));
  if (!isInMemoryLeaseHeld(database, clock, key))
    throw ExecutionFencedError.of({ scopeKey, token, observedToken: row?.lease.token });
  const highest = database.fencedEffectMarks.get(scopeKey)?.highestToken ?? 0;
  if (token < highest) throw ExecutionFencedError.of({ scopeKey, token, observedToken: highest });
}

/**
 * Whether the lease of `(tenantId, leaseExecutionId)` is held at `token` now: not released, and live
 * — `expiresAt > now`, the one boundary of every lease check (#534); at its expiry it is over.
 */
export function isInMemoryLeaseHeld(
  database: InMemoryDatabase,
  clock: Pick<Clock, "now">,
  lease: Pick<EffectKey, "tenantId" | "leaseExecutionId" | "token">,
): boolean {
  const row = database.executionLeases.get(treeKeyOf(lease.tenantId, lease.leaseExecutionId));
  return (
    row !== undefined &&
    !row.released &&
    row.lease.token === lease.token &&
    row.lease.expiresAt > clock.now()
  );
}

/** The scope's high-water mark moves up to the key's token (one mark per scope, every store's). */
export function raiseInMemoryMark(
  database: InMemoryDatabase,
  clock: Pick<Clock, "now">,
  key: EffectKey,
): void {
  const highest = database.fencedEffectMarks.get(key.scopeKey)?.highestToken ?? 0;
  database.fencedEffectMarks.set(key.scopeKey, {
    highestToken: Math.max(highest, key.token),
    storedAt: clock.now().getTime(),
  });
}

/** The store-match check of an in-memory store: its leases must be the in-memory ones. */
export function inMemoryLeaseMismatch(
  store: object,
  leases: ExecutionLeaseRepository,
): IdempotencyError.StoreMismatch | undefined {
  return leases instanceof InMemoryExecutionLeaseRepository
    ? undefined
    : storeMismatch({
        fencedEffectRepository: store.constructor.name,
        leaseRepository: leases.constructor.name,
        expectedLeaseRepository: InMemoryExecutionLeaseRepository.name,
      });
}
