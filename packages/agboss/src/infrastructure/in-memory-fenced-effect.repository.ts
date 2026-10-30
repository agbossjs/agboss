import { ExecutionFencedError } from "../app/lease-lost.js";
import { Injectable } from "../components/decorators.js";
import type { Class, Provider } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { Clock } from "./clock.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
} from "./execution-lease.repository.js";
import { FencedEffectSettings } from "./fenced-effect-settings.js";
import {
  FencedEffectRepository,
  FencedEffectStoreMismatchError,
  FencedEffectStatus,
  type FencedEffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
} from "./fenced-effect.repository.js";
import { IN_MEMORY_DATABASE } from "./instance-tokens.js";
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

const resultKeyOf = (key: FencedEffectKey): string =>
  [key.scopeKey, key.idempotencyKey, key.name].join("\u0000");

/**
 * The built-in default (#500): marks and results in the instance's `InMemoryDatabase` beside the
 * in-memory leases it checks — the instances of one test share them. One transaction at a time per
 * lease scope; the lease and the mark are checked again at commit, so a lease taken over while an
 * asynchronous `work` ran refuses its write.
 */
@Injectable({ deps: [Clock, IN_MEMORY_DATABASE, FencedEffectSettings, ExecutionLeaseRepository] })
export class InMemoryFencedEffectRepository extends FencedEffectRepository<InMemoryFencedEffectTransaction> {
  static override readonly leaseRepository: Class | undefined = InMemoryExecutionLeaseRepository;

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
    if (!(this.leases instanceof InMemoryExecutionLeaseRepository))
      return Promise.reject(
        new FencedEffectStoreMismatchError({
          fencedEffectRepository: this.constructor.name,
          leaseRepository: this.leases.constructor.name,
          expectedLeaseRepository: InMemoryExecutionLeaseRepository.name,
        }),
      );
    return this.#serialized(key.scopeKey, () => this.#transaction(key, work));
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
    this.#checkFence(key);
    const stored = this.database.fencedEffectResults.get(resultKeyOf(key));
    if (stored !== undefined) {
      this.#raiseMark(key);
      const result = JSON.parse(stored.result) as TResult;
      return { status: FencedEffectStatus.Replayed, result, token: stored.token };
    }
    const transaction = new InMemoryFencedEffectTransaction();
    const text = this.storedResultOf(key, await work(transaction));
    // the lease may have moved while the work ran: checked again before anything is applied
    this.#checkFence(key);
    this.#raiseMark(key);
    const storedAt = this.clock.now().getTime();
    const row = { scopeKey: key.scopeKey, token: key.token, storedAt, result: text };
    this.database.fencedEffectResults.set(resultKeyOf(key), row);
    applyWrites(transaction);
    return {
      status: FencedEffectStatus.Ran,
      result: JSON.parse(text) as TResult,
      token: key.token,
    };
  }

  /** The lease is the key's (held, not expired, its epoch) and no newer token wrote the scope. */
  #checkFence(key: FencedEffectKey): void {
    const { scopeKey, token } = key;
    const row = this.database.executionLeases.get(treeKeyOf(key.tenantId, key.leaseExecutionId));
    const isHeld =
      row !== undefined &&
      !row.released &&
      row.lease.leaseEpoch === token &&
      row.lease.expiresAt > this.clock.now();
    if (!isHeld)
      throw new ExecutionFencedError({ scopeKey, token, observedToken: row?.lease.leaseEpoch });
    const highest = this.database.fencedEffectMarks.get(scopeKey)?.highestToken ?? 0;
    if (token < highest)
      throw new ExecutionFencedError({ scopeKey, token, observedToken: highest });
  }

  #raiseMark(key: FencedEffectKey): void {
    const highest = this.database.fencedEffectMarks.get(key.scopeKey)?.highestToken ?? 0;
    this.database.fencedEffectMarks.set(key.scopeKey, {
      highestToken: Math.max(highest, key.token),
      storedAt: this.clock.now().getTime(),
    });
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

const isClass = (provider: Provider): provider is Class => !("provide" in provider);

/** Whether `cls` is `base` or extends it. */
const isOrExtends = (cls: Class, base: Class): boolean =>
  cls === base || Object.prototype.isPrototypeOf.call(base.prototype, cls.prototype);

/**
 * The fenced-effect store and the lease store are of one database (#500): a listed store reads the
 * leases of the lease store it declares (`static leaseRepository`) in its own transaction, so the
 * application's lease store — listed, else the in-memory default — must be that one (or extend it).
 */
export function fencedEffectStoreViolations(
  application: string,
  providers: readonly Provider[],
): RuleViolation[] {
  const classes = providers.filter(isClass);
  const store = classes.find((cls) => isOrExtends(cls, FencedEffectRepository));
  const expected: unknown = store === undefined ? undefined : Reflect.get(store, "leaseRepository");
  if (store === undefined || typeof expected !== "function") return [];
  const leases =
    classes.find((cls) => isOrExtends(cls, ExecutionLeaseRepository)) ??
    InMemoryExecutionLeaseRepository;
  if (
    leases === expected ||
    Object.prototype.isPrototypeOf.call(expected.prototype, leases.prototype)
  )
    return [];
  return [
    violation(
      "application.fenced-effect-lease-store",
      `${store.name} checks the leases of ${expected.name}, but the application's leases are in ${leases.name} — list the two stores of one database together (SqliteFencedEffectRepository with SqliteExecutionLeaseRepository)`,
      [application],
    ),
  ];
}
