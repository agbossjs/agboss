import { fencedRefusalOf } from "../app/lease-lost.js";
import { storeMismatch } from "./idempotency-errors.js";
import { IdempotencyError } from "../core/error-families/effect-errors.js";
import type { StoreDescriptor } from "./execution-lease.repository.js";
import {} from "../app/lease-lost.js";
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
  previousIdentityOf,
  replayedFromOf,
  storedKeyFactsOf,
} from "./fenced-effect-key.js";
import {
  checkInMemoryCancel,
  IN_MEMORY_DATABASE,
  laterExpiry,
  prunedFencedAt,
  treeKeyOf,
  type FencedEffectResultRow,
  type InMemoryDatabase,
} from "./in-memory-database.js";
import { assertFingerprintDecided } from "./fenced-effect-fingerprint.js";
import { appliedEffectWrites, inEffectWrites } from "./in-memory-effect-writes.js";

/**
 * The built-in default (#500): marks and results in the instance's `InMemoryDatabase` beside the
 * in-memory leases it checks — the instances of one test share them. One transaction at a time per
 * lease scope; the lease and the mark are checked again at commit, so a lease taken over while an
 * asynchronous `work` ran refuses its write.
 */
@Injectable({
  deps: [StoreClock, IN_MEMORY_DATABASE, ExecutionLeaseRepository],
})
export class InMemoryFencedEffectRepository extends FencedEffectRepository {
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
    work: FencedEffectWork<TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    const mismatch = inMemoryLeaseMismatch(this, this.leases);
    if (mismatch !== undefined) return Promise.reject(mismatch);
    // a business key is one row for every scope of the tenant: its transactions in turn too (#508)
    const lock = key.businessKey === undefined ? key.scopeKey : effectKeyIdentityOf(key);
    return this.#serialized(lock, () => this.#transaction(key, work));
  }

  deleteExpired(now: Date): Promise<number> {
    return Promise.resolve(prunedFencedAt(this.database, now.getTime()));
  }

  async #transaction<TResult>(
    key: EffectKey,
    work: FencedEffectWork<TResult>,
  ): Promise<IdempotencyRunOutcome<TResult>> {
    checkInMemoryFence(this.database, this.clock, key);
    const stored = this.#stored(key);
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
    // an in-memory effect has no transaction to hand out: the writes a test's rows buffer for it
    // (`onEffectCommit`) are applied once the result is stored, and never when the work throws
    const writes = inEffectWrites();
    const text = this.storedResultOf(key, await writes.run(work));
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
      expiresAt: key.expiresAt?.getTime() ?? null,
      result: text,
      ...storedKeyFactsOf(key),
    };
    this.database.fencedEffectResults.set(effectKeyIdentityOf(key), row);
    appliedEffectWrites(writes);
    return {
      status: IdempotencyRunStatus.Ran,
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }

  /** The result stored under the key — or, after a rotation of the idempotency secret, under its previous digest. */
  #stored(key: EffectKey): FencedEffectResultRow | undefined {
    const { fencedEffectResults: results } = this.database;
    const previous = previousIdentityOf(key);
    return (
      results.get(effectKeyIdentityOf(key)) ??
      (previous === undefined ? undefined : results.get(effectKeyIdentityOf(previous)))
    );
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
 * `ExecutionError.Fenced`, a hand-over.
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
    throw fencedRefusalOf({ scopeKey, token, observedToken: row?.lease.token });
  const highest = database.fencedEffectMarks.get(scopeKey)?.highestToken ?? 0;
  if (token < highest) throw fencedRefusalOf({ scopeKey, token, observedToken: highest });
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
  const mark = database.fencedEffectMarks.get(key.scopeKey);
  database.fencedEffectMarks.set(key.scopeKey, {
    highestToken: Math.max(mark?.highestToken ?? 0, key.token),
    storedAt: clock.now().getTime(),
    // `null` (never) wins over any date, and a later date over an earlier one
    expiresAt: laterExpiry(mark?.expiresAt, key.expiresAt?.getTime() ?? null),
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
