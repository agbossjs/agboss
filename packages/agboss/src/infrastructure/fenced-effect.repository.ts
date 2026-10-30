import { scopeKeyOf } from "../app/lease-lost.js";
import { AGBossError } from "../core/errors.js";
import type { Class } from "../components/injection.js";
import type { ExecutionContext } from "../flow/context/execution-context.js";
import type { FencedEffectSettings } from "./fenced-effect-settings.js";

/**
 * The fenced effect (#500): one protected write of a step, made exactly once per step on the
 * store's own database — a durable singleflight on the step's idempotency key. In one transaction
 * with the write: the lease the step runs under is checked (`ExecutionFencedError` when it is no
 * longer the current one), then the scope's high-water mark (`token < highest` refused before any
 * key is looked up, so a zombie never reads the new holder's result), then the key — found, the
 * stored result comes back and the write does not run again. Wiki → Several-instances.
 */

/** The values JSON keeps as they are. */
type JsonPrimitive = string | number | boolean | null;

/**
 * `T` as a fenced effect stores it — `JSON.stringify`, then `JSON.parse` on a replay: text,
 * numbers, booleans, `null`, arrays and objects of them (an interface, a DTO class, optional
 * fields); a function, `undefined`, a `Date` or a `Map` is `never`, so a write returning one does
 * not compile.
 */
export type JsonResult<T> = T extends JsonPrimitive
  ? T
  : T extends (...args: never[]) => unknown
    ? never
    : T extends object
      ? { readonly [K in keyof T]: JsonResult<T[K]> }
      : never;

/** The identity of one protected write: the lease scope and token it runs under, the step, a name. */
export interface FencedEffectKey {
  /** `executionContext.fence.scopeKey`: the lease scope, the key of its high-water mark. */
  readonly scopeKey: string;
  readonly tenantId: string;
  /** The execution whose lease the step runs under (`executionContext.fence.leaseExecutionId`). */
  readonly leaseExecutionId: string;
  /** The lease's epoch the step holds (`executionContext.fence.token`). */
  readonly token: number;
  /** The step's `executionContext.step.idempotencyKey`: the same when the step runs again. */
  readonly idempotencyKey: string;
  /** Which effect of the step: `"charge"`, `"notify-ledger"` — several in one step are apart. */
  readonly name: string;
}

/** How a call got its result. */
export enum FencedEffectStatus {
  /** The write ran now, and its result was stored with it. */
  Ran = "ran",
  /** The key was written before (a step run again): the stored result, the write not run. */
  Replayed = "replayed",
  /** A call on the same key of this instance was in flight: its result (or its error). */
  Joined = "joined",
}

/** What a call gives: how it got the result, the result, the token it was first written under. */
export interface FencedEffectOutcome<TResult> {
  readonly status: FencedEffectStatus;
  readonly result: TResult;
  /** The token the result was first written under (a replay on a newer lease: the older one). */
  readonly token: number;
}

/** The protected write: business rows in `transaction`, then its result (plain JSON). */
export type FencedEffectWork<TTransaction, TResult> = (
  transaction: TTransaction,
) => (TResult & JsonResult<TResult>) | Promise<TResult & JsonResult<TResult>>;

/** A key made by hand that is not one of a lease scope. */
class InvalidFencedEffectKeyError extends TypeError {
  override name = "InvalidFencedEffectKeyError";
}

/** Why a key cannot be one: its scope does not match its parts, no name, no token. */
function keyProblemOf(key: FencedEffectKey): string | undefined {
  if (key.scopeKey !== scopeKeyOf(key.tenantId, key.leaseExecutionId))
    return `its scopeKey ${JSON.stringify(key.scopeKey)} is not the scope of tenant ${key.tenantId} and execution ${key.leaseExecutionId}`;
  if (!Number.isInteger(key.token) || key.token < 1)
    return `its token ${String(key.token)} is not a lease epoch (a whole number from 1)`;
  if (key.name.length === 0 || key.idempotencyKey.length === 0)
    return "its name and idempotencyKey must not be empty";
  return undefined;
}

/** The calls in flight of each store instance, by their full key: the in-process join. */
const inFlight = new WeakMap<object, Map<string, Promise<FencedEffectOutcome<unknown>>>>();

const joinKeyOf = (key: FencedEffectKey): string =>
  [key.scopeKey, key.idempotencyKey, key.name, String(key.token)].join("\u0000");

/**
 * Infrastructure (#500): one protected write per key, inside the store's own transaction — the
 * business rows of the write live in the same database, so an application defines no fencing or
 * idempotency tables of its own. Listed only in `@Application({ providers })`; the built-in default
 * is in memory (`InMemoryFencedEffectRepository`), `SqliteFencedEffectRepository` shares the
 * application's SQLite file. A store reads the leases of the lease store on its own database, so
 * the application lists the two together.
 */
export abstract class FencedEffectRepository<TTransaction> {
  /**
   * The lease store whose leases the store checks in its transaction — the one of its database
   * (`SqliteExecutionLeaseRepository` for the SQLite store): listed beside another, the application
   * fails assembly with `[application.fenced-effect-lease-store]`. Unset: not checked.
   */
  static readonly leaseRepository: Class | undefined = undefined;

  constructor(
    /** `@Application({ fencedEffects })`: the largest result, how long rows are kept. */
    protected readonly settings: FencedEffectSettings,
  ) {}

  /** Whether the store answers (#300): one fast round trip. */
  abstract ping(): Promise<void>;

  /**
   * The write and its result in one transaction with the fencing checks; the stored result on a
   * repeat. A refused lease or a lower token → `ExecutionFencedError` (a hand-over: nothing
   * written, no result); `work` throws → everything rolled back and the error rethrown as it is —
   * the next call runs it again. Concurrent calls on one key of this instance share the first's
   * outcome (`Joined`); across instances the transaction serializes them (`Replayed`).
   */
  saveResultIfAbsent<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<TTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    const problem = keyProblemOf(key);
    if (problem !== undefined)
      return Promise.reject(new InvalidFencedEffectKeyError(`not a fenced effect key: ${problem}`));
    const calls = inFlight.get(this) ?? new Map<string, Promise<FencedEffectOutcome<unknown>>>();
    inFlight.set(this, calls);
    const joinKey = joinKeyOf(key);
    const leader = calls.get(joinKey);
    // a follower's result is the leader's, of the same key and so of the same work's type
    if (leader !== undefined)
      return leader.then(joinedOutcome) as Promise<FencedEffectOutcome<TResult>>;
    const call = this.runInTransaction(key, work).finally(() => {
      calls.delete(joinKey);
    });
    calls.set(joinKey, call);
    return call;
  }

  /**
   * One transaction, in this order: the lease (`leaseEpoch !== token`, released, expired →
   * fenced), the mark (`token < highest` → fenced, else `highest = max(highest, token)`), the key
   * (found → `Replayed`, `work` not called), the write (`work`, then the result stored with its
   * token and the `Clock`'s time → `Ran`). Rolled back as a whole when anything throws.
   */
  protected abstract runInTransaction<TResult>(
    key: FencedEffectKey,
    work: FencedEffectWork<TTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>>;

  /** Removes the results and marks stored before `cutoff` (the recovery sweep, `now - retention`). */
  abstract deleteByStoredAtBefore(cutoff: Date): Promise<void>;

  /**
   * The result as stored: its JSON, within `maxResultSize` (UTF-8 bytes) — else
   * `FencedEffectResultTooLargeError`, thrown inside the transaction so it rolls back.
   */
  protected storedResultOf(key: FencedEffectKey, result: unknown): string {
    const text = JSON.stringify(result);
    const size = Buffer.byteLength(text, "utf8");
    if (size > this.settings.maxResultSize)
      throw new FencedEffectResultTooLargeError({
        effect: key.name,
        size,
        maxResultSize: this.settings.maxResultSize,
      });
    return text;
  }
}

/** A follower's outcome: the leader's, a copy of its result. */
const joinedOutcome = (outcome: FencedEffectOutcome<unknown>): FencedEffectOutcome<unknown> => ({
  status: FencedEffectStatus.Joined,
  result: structuredClone(outcome.result),
  token: outcome.token,
});

/**
 * The key of the current step's effect `name` (#500): the lease the step runs under
 * (`executionContext.fence`) and its idempotency key (`executionContext.step`) — the same when the
 * step runs again after a crash, a newer token once another instance took the lease over. Where no
 * lease is held (a reply interpreter, `maxSpend()`, a yielded lease, an ancestor's context) it
 * throws `ExecutionContextUnavailableError`, as `fence` does.
 */
export function fencedEffectKeyOf(
  executionContext: ExecutionContext,
  name: string,
): FencedEffectKey {
  const { fence, step } = executionContext;
  return Object.freeze({
    scopeKey: fence.scopeKey,
    tenantId: fence.tenantId,
    leaseExecutionId: fence.leaseExecutionId,
    token: fence.token,
    idempotencyKey: step.idempotencyKey,
    name,
  });
}

/** What a result too large to store knows: the effect, its size and the limit (UTF-8 bytes). */
export interface FencedEffectResultTooLargeErrorOptions {
  /** The effect's `name` (`fencedEffectKeyOf(executionContext, name)`). */
  readonly effect: string;
  readonly size: number;
  readonly maxResultSize: number;
}

/**
 * A fenced effect's result is larger than `@Application({ fencedEffects: { maxResultSize } })`
 * (#500, default 64 KB): its transaction is rolled back — the business rows too — and the step
 * fails with it. Store a reference (an id, a receipt number), not the document.
 */
export class FencedEffectResultTooLargeError extends AGBossError {
  static override readonly code: string = "fenced-effect.result-too-large";
  override name = "FencedEffectResultTooLargeError";
  readonly effect: string;
  readonly size: number;
  readonly maxResultSize: number;

  constructor(options: FencedEffectResultTooLargeErrorOptions) {
    super(
      `the result of fenced effect "${options.effect}" is ${String(options.size)} bytes, above its maxResultSize of ${String(options.maxResultSize)} bytes: nothing was written — store a reference to it, or raise @Application({ fencedEffects: { maxResultSize } })`,
    );
    this.effect = options.effect;
    this.size = options.size;
    this.maxResultSize = options.maxResultSize;
  }
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

/**
 * A fenced effect on SQLite returned a promise (#500): its transaction is one synchronous group of
 * statements on the instance's connection, so it is rolled back — nothing written, the result not
 * stored. Do the step's I/O before the call (its input) or after it (with its result), and write
 * the rows with the given `DatabaseSync` only.
 */
export class FencedEffectAsyncWorkError extends AGBossError {
  static override readonly code: string = "fenced-effect.async-work";
  override name = "FencedEffectAsyncWorkError";
  readonly effect: string;

  constructor(effect: string) {
    super(
      `fenced effect "${effect}" returned a promise: a SQLite fenced effect runs its work synchronously in one transaction — nothing was written; do the I/O before or after the call`,
    );
    this.effect = effect;
  }
}
