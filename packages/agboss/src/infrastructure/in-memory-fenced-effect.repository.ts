import { ExecutionFencedError } from "../app/lease-lost.js";
import { Injectable } from "../components/decorators.js";
import type { Class } from "../components/injection.js";
import { AGBossError } from "../core/errors.js";
import { Clock } from "./clock.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
} from "./execution-lease.repository.js";
import { FencedEffectSettings } from "./fenced-effect-settings.js";
import {
  FencedEffectRepository,
  FencedEffectStatus,
  type FencedEffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
} from "./fenced-effect.repository.js";
import {
  checkedEffectName,
  fencedKeyIdentityOf,
  replayedFromOf,
  storedKeyFactsOf,
} from "./fenced-effect-key.js";
import { IN_MEMORY_DATABASE } from "./in-memory-database.js";
import { treeKeyOf, type InMemoryDatabase } from "./in-memory-database.js";

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
@Injectable({ deps: [Clock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository] })
export class InMemoryFencedEffectRepository extends FencedEffectRepository<InMemoryFencedEffectTransaction> {
  static override readonly leaseRepository: Class | undefined = InMemoryExecutionLeaseRepository;
  static override readonly backend: string | undefined = "in-memory";

  constructor(
    private readonly clock: Clock,
    private readonly database: InMemoryDatabase,
    settings: FencedEffectSettings,
    private readonly leases: ExecutionLeaseRepository,
  ) {
    super(settings);
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  protected runInTransaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<InMemoryFencedEffectTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    const mismatch = inMemoryLeaseMismatch(this, this.leases);
    if (mismatch !== undefined) return Promise.reject(mismatch);
    // a business key is one row for every scope of the tenant: its transactions in turn too (#508)
    const lock = key.businessKey === undefined ? key.scopeKey : fencedKeyIdentityOf(key);
    return this.#serialized(lock, () => this.#transaction(key, work));
  }

  deleteByStoredAtBefore(cutoff: Date): Promise<void> {
    const before = cutoff.getTime();
    const { fencedEffectMarks: marks, fencedEffectResults: results } = this.database;
    for (const [row, stored] of results) if (stored.storedAt < before) results.delete(row);
    for (const [scope, mark] of marks) if (mark.storedAt < before) marks.delete(scope);
    return Promise.resolve();
  }

  async #transaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<InMemoryFencedEffectTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    checkInMemoryFence(this.database, this.clock, key);
    const stored = this.database.fencedEffectResults.get(fencedKeyIdentityOf(key));
    if (stored !== undefined) {
      const replayedFrom = replayedFromOf(key, stored);
      raiseInMemoryMark(this.database, this.clock, key);
      const result = JSON.parse(stored.result) as TResult;
      return {
        status: FencedEffectStatus.Replayed,
        result,
        token: stored.token,
        ...(replayedFrom === undefined ? {} : { replayedFrom }),
      };
    }
    const transaction = new InMemoryFencedEffectTransaction();
    const text = this.storedResultOf(key, await work(transaction));
    // the lease may have moved while the work ran: checked again before anything is applied
    checkInMemoryFence(this.database, this.clock, key);
    raiseInMemoryMark(this.database, this.clock, key);
    const storedAt = this.clock.now().getTime();
    const row = {
      scopeKey: key.scopeKey,
      token: key.token,
      storedAt,
      result: text,
      ...storedKeyFactsOf(key),
    };
    this.database.fencedEffectResults.set(fencedKeyIdentityOf(key), row);
    applyWrites(transaction);
    return {
      status: FencedEffectStatus.Ran,
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
  clock: Clock,
  key: FencedEffectKey,
): void {
  checkedEffectName(key.name);
  const { scopeKey, token } = key;
  const row = database.executionLeases.get(treeKeyOf(key.tenantId, key.leaseExecutionId));
  if (!isInMemoryLeaseHeld(database, clock, key))
    throw new ExecutionFencedError({ scopeKey, token, observedToken: row?.lease.leaseEpoch });
  const highest = database.fencedEffectMarks.get(scopeKey)?.highestToken ?? 0;
  if (token < highest) throw new ExecutionFencedError({ scopeKey, token, observedToken: highest });
}

/**
 * Whether the lease of `(tenantId, leaseExecutionId)` is held at `token` now: not released, and live
 * — `expiresAt > now`, the one boundary of every lease check (#534); at its expiry it is over.
 */
export function isInMemoryLeaseHeld(
  database: InMemoryDatabase,
  clock: Clock,
  lease: Pick<FencedEffectKey, "tenantId" | "leaseExecutionId" | "token">,
): boolean {
  const row = database.executionLeases.get(treeKeyOf(lease.tenantId, lease.leaseExecutionId));
  return (
    row !== undefined &&
    !row.released &&
    row.lease.leaseEpoch === lease.token &&
    row.lease.expiresAt > clock.now()
  );
}

/** The scope's high-water mark moves up to the key's token (one mark per scope, every store's). */
export function raiseInMemoryMark(
  database: InMemoryDatabase,
  clock: Clock,
  key: FencedEffectKey,
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
): FencedEffectStoreMismatchError | undefined {
  return leases instanceof InMemoryExecutionLeaseRepository
    ? undefined
    : new FencedEffectStoreMismatchError({
        fencedEffectRepository: store.constructor.name,
        leaseRepository: leases.constructor.name,
        expectedLeaseRepository: InMemoryExecutionLeaseRepository.name,
      });
}

/** Which stores do not match: the fenced-effect store and the lease store the application uses. */
export interface FencedEffectStoreMismatchErrorOptions {
  readonly fencedEffectRepository: string;
  readonly leaseRepository: string;
  /** The lease store the fenced-effect store reads its leases from. */
  readonly expectedLeaseRepository: string;
}

/**
 * The fenced-effect store reads the leases of another store than the application's (#500): the
 * built-in in-memory one used beside a listed `SqliteExecutionLeaseRepository`, say. It would
 * refuse every write, so the first call fails with this instead — list the fenced-effect store of
 * the lease store's database (`SqliteFencedEffectRepository` beside `SqliteExecutionLeaseRepository`).
 */
export class FencedEffectStoreMismatchError extends AGBossError {
  static override readonly code: string = "fenced-effect.store-mismatch";
  override name = "FencedEffectStoreMismatchError";
  readonly fencedEffectRepository: string;
  readonly leaseRepository: string;

  constructor(options: FencedEffectStoreMismatchErrorOptions) {
    super(
      `${options.fencedEffectRepository} checks the leases of ${options.expectedLeaseRepository}, but the application's leases are in ${options.leaseRepository}: list the fenced-effect store of that lease store's database in @Application({ providers })`,
    );
    this.fencedEffectRepository = options.fencedEffectRepository;
    this.leaseRepository = options.leaseRepository;
  }
}
